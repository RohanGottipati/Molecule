import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { closePool, getPool } from "@molecule/db";
import {
  CanonicalClaimSchema,
  MerchantCapabilitySchema,
  QuoteRequestSchema,
  type MerchantCapability,
} from "@molecule/contracts";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { InMemoryCanonicalDataClient } from "./canonicalDataClient.js";
import {
  DatabaseCapacityStore,
  DatabaseJobDecisionStore,
} from "./databaseStores.js";
import { createMerchantRuntime, type MerchantRuntime } from "./runtime.js";

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.DATABASE_URL;
const schema = `backboard_test_${randomUUID().replaceAll("-", "")}`;
const now = new Date("2026-09-21T12:00:00.000Z");
let runtime: MerchantRuntime;
let canonicalData: InMemoryCanonicalDataClient;
let capability: MerchantCapability;
let merchantId: string;

function request(orderId = "order-a", overrides: Record<string, unknown> = {}) {
  return QuoteRequestSchema.parse({
    merchantId,
    orderId,
    capabilityId: capability.capabilityId,
    traceId: "trace-test",
    quantity: 200,
    currency: "CAD",
    deadline: "2026-09-25T12:00:00.000Z",
    ...overrides,
  });
}

describe.skipIf(!databaseUrl)(
  "durable merchant runtime (real PostgreSQL)",
  () => {
    beforeAll(async () => {
      await getPool().query(`create schema ${schema}`);
      await closePool();
      const scoped = new URL(databaseUrl!);
      scoped.searchParams.set("options", `-c search_path=${schema},public`);
      process.env.DATABASE_URL = scoped.toString();
      await getPool().query(
        await readFile(
          new URL("../../../sql/001_core.sql", import.meta.url),
          "utf8",
        ),
      );
      await getPool().query(
        await readFile(
          new URL("../../../sql/006_backboard.sql", import.meta.url),
          "utf8",
        ),
      );
    });
    afterAll(async () => {
      await closePool();
      process.env.DATABASE_URL = databaseUrl;
      await getPool().query(`drop schema ${schema} cascade`);
      await closePool();
    });
    beforeEach(async () => {
      merchantId = `test-${randomUUID()}`;
      canonicalData = new InMemoryCanonicalDataClient();
      capability = MerchantCapabilitySchema.parse({
        merchantId,
        capabilityId: `hoodie-${merchantId}`,
        name: "Cotton hoodie",
        description: "Synthetic fixture",
        kind: "SUPPLY",
        accepts: [],
        produces: [
          {
            kind: "hoodie",
            name: "hoodie",
            attributes: {
              material: "cotton",
              color: "black",
              product: "hoodie",
              sku: "hoodie",
            },
          },
        ],
        quantity: { min: 1, max: 1000, unit: "units" },
        pricing: { currency: "CAD", unitPrice: 12, setupFee: 10 },
        capacity: { available: 300, maximum: 1000, period: "day" },
        leadTime: { min: 12, max: 24, unit: "hours" },
        hardRules: [],
        softRules: [],
        sourceClaimIds: [],
      });
      canonicalData.seedCapability(capability);
      canonicalData.seedInventory({
        merchantId,
        sku: "hoodie",
        available: 300,
        asOf: now.toISOString(),
      });
      runtime = createMerchantRuntime({ canonicalData, now: () => now });
      await runtime.initialize({
        identity: {
          merchantId,
          displayName: merchantId,
          specialty: "Hoodies",
          boundaries: [],
        },
        traceId: "init",
      });
      await getPool().query(
        "insert into capabilities(capability_id,merchant_id,kind,name,capability_json) values($1,$2,$3,$4,$5)",
        [
          capability.capabilityId,
          merchantId,
          capability.kind,
          capability.name,
          capability,
        ],
      );
    });
    afterEach(async () => {
      await runtime.close();
    });

    it("persists memory across orders, new runtime, new database pool and a separate process", async () => {
      const entry = await runtime.recordMemory({
        merchantId,
        orderId: "order-a",
        traceId: "remember",
        note: "Confirm artwork with this merchant before execution.",
      });
      await runtime.quote(request());
      const assistant = await runtime.repository.getAssistant(merchantId);
      await runtime.close();
      await closePool();
      runtime = createMerchantRuntime({ canonicalData, now: () => now });
      expect(await runtime.listMemory(merchantId)).toEqual([entry]);
      expect(
        await runtime.initialize({
          identity: {
            merchantId,
            displayName: merchantId,
            specialty: "Hoodies",
            boundaries: [],
          },
          traceId: "again",
        }),
      ).toEqual(assistant);
      await runtime.quote(request("order-b"));
      const rows = await getPool().query<{ payload: { memoryIds: string[] } }>(
        "select payload from molecule_events where merchant_id=$1 and event_type='merchant.quote.completed' and order_id='order-b'",
        [merchantId],
      );
      expect(rows.rows[0]?.payload.memoryIds).toContain(entry.memoryId);
      const moduleUrl = new URL("./runtime.ts", import.meta.url).href;
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import { createMerchantRuntime } from ${JSON.stringify(moduleUrl)};
       import { closePool } from '@molecule/db';
       const runtime=createMerchantRuntime({canonicalData:{
         getInventory:async()=>undefined,getCapability:async()=>undefined,getCanonicalClaims:async()=>[]
       }});
       console.log(JSON.stringify(await runtime.listMemory(${JSON.stringify(merchantId)})));
       await runtime.close(); await closePool();`,
        ],
        { cwd: fileURLToPath(new URL("..", import.meta.url)) },
      );
      expect(JSON.parse(stdout)).toEqual([entry]);
    });

    it("serializes identity creation, reuses same-order threads and isolates concurrent orders", async () => {
      const inputs = { merchantId, orderId: "same", traceId: "concurrent" };
      const repeated = await Promise.all(
        Array.from({ length: 8 }, () => runtime.ensureOrderThread(inputs)),
      );
      expect(new Set(repeated.map((thread) => thread.threadId)).size).toBe(1);
      const quotes = await Promise.all([
        runtime.quote(request("one")),
        runtime.quote(request("two")),
      ]);
      expect(quotes.map((quote) => quote.status)).toEqual([
        "CAN_ACCEPT",
        "CAN_ACCEPT",
      ]);
      expect(
        (await runtime.repository.getThread(merchantId, "one"))?.threadId,
      ).not.toBe(
        (await runtime.repository.getThread(merchantId, "two"))?.threadId,
      );
    });

    it("reads all canonical tools, merges constraints, preserves intentVersion and never reserves even with hold=true", async () => {
      const quote = await runtime.quote(
        request("held", {
          hold: true,
          intentVersion: 3,
          hardConstraints: [
            {
              constraintId: "material",
              field: "hoodie.material",
              operator: "not_contains",
              value: "polyester",
            },
          ],
          constraints: [
            {
              constraintId: "color",
              field: "hoodie.color",
              operator: "eq",
              value: "black",
            },
          ],
        }),
      );
      expect(quote).toMatchObject({
        status: "CAN_ACCEPT",
        unitPrice: 12,
        setupFee: 10,
      });
      expect(quote.reservationId).toBeUndefined();
      expect(
        await runtime.capacity.getAvailableCapacity(
          merchantId,
          capability.capabilityId,
        ),
      ).toBe(300);
      const events = await getPool().query<{
        payload: {
          intentVersion: number;
          canonicalTools: string[];
          mode: string;
        };
      }>(
        "select payload from molecule_events where merchant_id=$1 and event_type='merchant.quote.completed'",
        [merchantId],
      );
      expect(events.rows[0]?.payload).toMatchObject({
        intentVersion: 3,
        mode: "demo",
        canonicalTools: expect.arrayContaining([
          "get_capability_policy",
          "get_canonical_claims",
          "calculate_quote",
          "get_capacity",
          "get_inventory",
        ]),
      });
    });

    it("declines unknown prices, material violations, inventory shortages and deadlines", async () => {
      capability.pricing.unitPrice = undefined;
      expect((await runtime.quote(request())).status).toBe("DECLINE");
      capability.pricing.unitPrice = 12;
      expect(
        (
          await runtime.quote(
            request("material", {
              hardConstraints: [
                {
                  constraintId: "material",
                  field: "hoodie.material",
                  operator: "eq",
                  value: "polyester",
                },
              ],
            }),
          )
        ).status,
      ).toBe("DECLINE");
      expect(
        (
          await runtime.quote(
            request("deadline", { deadline: now.toISOString() }),
          )
        ).status,
      ).toBe("DECLINE");
      canonicalData.seedInventory({
        merchantId,
        sku: "hoodie",
        available: 2,
        asOf: now.toISOString(),
      });
      expect((await runtime.quote(request("inventory"))).status).toBe(
        "DECLINE",
      );
    });

    it("declines canonical conflicts despite a remembered capacity claim", async () => {
      await runtime.recordMemory({
        merchantId,
        orderId: "old",
        traceId: "remember",
        note: "Historical website says capacity 1000/day.",
      });
      canonicalData.seedClaims(merchantId, [
        CanonicalClaimSchema.parse({
          claimId: "conflict",
          merchantId,
          field: "capacity",
          normalizedValue: 1000,
          source: { kind: "document", reference: "synthetic-conflict" },
          ingestedAt: now.toISOString(),
          sourceAuthority: 0.8,
          extractionConfidence: 1,
          resolutionStatus: "conflicted",
        }),
      ]);
      expect((await runtime.quote(request())).status).toBe("DECLINE");
    });

    it("does not let stale capability attributes override active scoped evidence", async () => {
      canonicalData.seedClaims(merchantId, [
        CanonicalClaimSchema.parse({
          claimId: "polyester",
          merchantId,
          field: "hoodie.material",
          normalizedValue: "polyester",
          source: { kind: "document", reference: "synthetic-material-update" },
          ingestedAt: now.toISOString(),
          sourceAuthority: 1,
          extractionConfidence: 1,
          resolutionStatus: "active",
        }),
      ]);
      const quote = await runtime.quote(
        request("material-update", {
          constraints: [
            {
              field: "hoodie.material",
              constraintId: "no-polyester",
              operator: "neq",
              value: "polyester",
              severity: "hard",
              origin: "test",
            },
          ],
        }),
      );
      expect(quote.status).toBe("DECLINE");
    });

    it("keeps document provenance, stale flags and content across restart", async () => {
      await runtime.initialize({
        identity: {
          merchantId,
          displayName: merchantId,
          specialty: "Hoodies",
          boundaries: [],
        },
        traceId: "docs",
        documents: [
          {
            category: "equipment_constraints",
            version: 1,
            fileName: "historical.txt",
            mimeType: "text/plain",
            content: "Historical capacity 100/day.",
            sourceTimestamp: "2025-01-01T00:00:00.000Z",
            stale: true,
          },
        ],
      });
      await runtime.close();
      runtime = createMerchantRuntime({ canonicalData });
      expect(await runtime.retrieveDocuments(merchantId, "capacity")).toEqual([
        expect.objectContaining({
          fileName: "historical.txt",
          sourceTimestamp: "2025-01-01T00:00:00.000Z",
          stale: true,
          version: 1,
          snippet: "Historical capacity 100/day.",
        }),
      ]);
    });

    it("bounds timeout/cancellation and does not persist a completed quote after timeout", async () => {
      await runtime.close();
      canonicalData.getCapability = vi.fn(() => new Promise(() => {}));
      runtime = createMerchantRuntime({ canonicalData, quoteTimeoutMs: 30 });
      await expect(runtime.quote(request())).rejects.toMatchObject({
        reason: "TIMEOUT",
      });
      const controller = new AbortController();
      controller.abort();
      await expect(
        runtime.quote(request("cancelled"), controller.signal),
      ).rejects.toMatchObject({ reason: "TIMEOUT" });
      const rows = await getPool().query(
        "select * from merchant_twin_quotes where merchant_id=$1",
        [merchantId],
      );
      expect(rows.rowCount).toBe(0);
    });

    it("persists idempotent reservations and serializes competing capacity", async () => {
      const store = new DatabaseCapacityStore();
      const input = {
        merchantId,
        capabilityId: capability.capabilityId,
        orderId: "approved",
        quantity: 200,
        actionKey: `reserve:${merchantId}`,
        traceId: "approved",
      };
      const holds = await Promise.all([
        store.reserve(input),
        store.reserve(input),
      ]);
      expect(holds[0]).toEqual(holds[1]);
      await expect(store.reserve({ ...input, quantity: 100 })).rejects.toThrow(
        "Idempotency",
      );
      const competing = await Promise.allSettled([
        store.reserve({
          ...input,
          orderId: "other",
          quantity: 80,
          actionKey: `other:${merchantId}`,
        }),
        store.reserve({
          ...input,
          orderId: "another",
          quantity: 80,
          actionKey: `another:${merchantId}`,
        }),
      ]);
      expect(
        competing.filter((item) => item.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        await new DatabaseCapacityStore().getAvailableCapacity(
          merchantId,
          capability.capabilityId,
        ),
      ).toBe(20);
      const released = await store.release({
        merchantId,
        capabilityId: capability.capabilityId,
        reservationId: holds[0]!.reservationId,
        actionKey: `release:${merchantId}`,
        traceId: "release",
      });
      expect(released.status).toBe("released");
    });

    it("persists jobs, rejects changed idempotency inputs and enforces ETA acceptance", async () => {
      const store = new DatabaseJobDecisionStore();
      const input = {
        merchantId,
        orderId: "approved",
        nodeId: "hoodie",
        actionKey: `job:${merchantId}`,
        traceId: "approved",
      };
      const [first, repeated] = await Promise.all([
        store.acceptJob(input),
        store.acceptJob(input),
      ]);
      expect(repeated).toEqual(first);
      expect(
        await store.acceptJob({
          actionKey: input.actionKey,
          nodeId: input.nodeId,
          orderId: input.orderId,
          merchantId,
          traceId: "retried-with-new-trace",
        }),
      ).toEqual(first);
      expect(
        await new DatabaseJobDecisionStore().getDecision(
          merchantId,
          input.orderId,
          input.nodeId,
        ),
      ).toEqual(first);
      await expect(
        store.acceptJob({ ...input, nodeId: "other" }),
      ).rejects.toThrow("Idempotency");
      await expect(
        store.updateEta({
          ...input,
          nodeId: "missing",
          actionKey: `eta:${merchantId}`,
          eta: now.toISOString(),
        }),
      ).rejects.toMatchObject({ name: "JobNotAcceptedError" });
    });

    it("keeps live failure visible and never invokes synthetic quote fallback", async () => {
      await runtime.close();
      let requests = 0;
      const fetchImpl: typeof fetch = async (_url, init) => {
        requests++;
        if (requests === 1)
          return Response.json({
            assistant_id: "live-assistant",
            created_at: now.toISOString(),
          });
        if (requests === 2)
          return Response.json({
            thread_id: "live-thread",
            created_at: now.toISOString(),
          });
        return new Response("provider secret must not appear", { status: 503 });
      };
      runtime = createMerchantRuntime({
        canonicalData,
        mode: "live",
        backboard: { apiKey: "fake-test-key", fetchImpl },
      });
      await runtime.initialize({
        identity: {
          merchantId,
          displayName: merchantId,
          specialty: "Hoodies",
          boundaries: [],
        },
        traceId: "live-init",
      });
      await expect(runtime.quote(request())).rejects.toMatchObject({
        reason: "PROVIDER_ERROR",
      });
      expect(runtime.mode).toBe("live");
      expect(
        (await runtime.repository.getAssistant(merchantId))?.assistantId,
      ).toBe("live-assistant");
    });

    it.each(["reserve_capacity", "switch_capability"])(
      "rejects live model advisory tool abuse: %s",
      async (attack) => {
        await runtime.close();
        const fetchImpl: typeof fetch = async (url) => {
          const path = new URL(String(url)).pathname;
          if (path.endsWith("/assistants"))
            return Response.json({
              assistant_id: "live",
              created_at: now.toISOString(),
            });
          if (path.endsWith("/threads"))
            return Response.json({
              thread_id: "live-thread",
              created_at: now.toISOString(),
            });
          if (path.endsWith("/models"))
            return Response.json({
              models: [
                {
                  name: "test-model",
                  provider: "test",
                  context_limit: 128000,
                  supports_tools: true,
                  supports_thinking: true,
                  supports_json_output: true,
                },
              ],
            });
          return Response.json({
            thread_id: "live-thread",
            status: "REQUIRES_ACTION",
            tool_calls: [
              {
                id: "attack",
                function: {
                  name:
                    attack === "switch_capability" ? "calculate_quote" : attack,
                  arguments: JSON.stringify({
                    capabilityId:
                      attack === "switch_capability"
                        ? "someone-else"
                        : capability.capabilityId,
                    quantity: 200,
                  }),
                },
              },
            ],
          });
        };
        runtime = createMerchantRuntime({
          canonicalData,
          mode: "live",
          backboard: { apiKey: "test", fetchImpl },
          now: () => now,
        });
        await runtime.initialize({
          identity: {
            merchantId,
            displayName: merchantId,
            specialty: "Hoodies",
            boundaries: [],
          },
          traceId: "live-init",
        });
        await expect(runtime.quote(request())).rejects.toThrow();
        expect(
          await runtime.capacity.getAvailableCapacity(
            merchantId,
            capability.capabilityId,
          ),
        ).toBe(300);
        expect(
          (
            await getPool().query(
              "select * from merchant_twin_jobs where merchant_id=$1",
              [merchantId],
            )
          ).rowCount,
        ).toBe(0);
      },
    );

    it("uses canonical prices for validated live output and persists the model lane", async () => {
      await runtime.close();
      const fetchImpl: typeof fetch = async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/assistants"))
          return Response.json({
            assistant_id: "live",
            created_at: now.toISOString(),
          });
        if (path.endsWith("/threads"))
          return Response.json({
            thread_id: "live-thread",
            created_at: now.toISOString(),
          });
        if (path.endsWith("/models"))
          return Response.json({
            models: [
              {
                name: "test-model",
                provider: "test",
                context_limit: 128000,
                supports_tools: true,
                supports_thinking: true,
                supports_json_output: true,
              },
            ],
          });
        return Response.json({
          thread_id: "live-thread",
          status: "COMPLETED",
          content: JSON.stringify({
            merchantId,
            capabilityId: capability.capabilityId,
            status: "CAN_ACCEPT",
            currency: "CAD",
            unitPrice: 0,
            setupFee: 0,
            confidence: 1,
            explanation: "Provider output.",
          }),
        });
      };
      runtime = createMerchantRuntime({
        canonicalData,
        mode: "live",
        backboard: { apiKey: "test", fetchImpl },
        now: () => now,
      });
      await runtime.initialize({
        identity: {
          merchantId,
          displayName: merchantId,
          specialty: "Hoodies",
          boundaries: [],
        },
        traceId: "live-init",
      });
      expect(await runtime.quote(request())).toMatchObject({
        status: "CAN_ACCEPT",
        unitPrice: 12,
        setupFee: 10,
      });
      const selection = await getPool().query<{ payload: { lane: string } }>(
        "select payload from molecule_events where merchant_id=$1 and event_type='agent.model.selected'",
        [merchantId],
      );
      expect(selection.rows[0]?.payload.lane).toBe("HIGH_REASONING");
    });

    it("retains historical 100/50/20 evidence and declines the limited merchant while a verified backup quotes", async () => {
      canonicalData.seedClaims(
        merchantId,
        [100, 50, 20].map((value, index) =>
          CanonicalClaimSchema.parse({
            claimId: `history-${index}`,
            merchantId,
            field: "capacity",
            normalizedValue: value,
            source: {
              kind: index === 0 ? "api" : index === 1 ? "document" : "note",
              reference: `synthetic-${index}`,
            },
            ingestedAt: now.toISOString(),
            sourceAuthority: 1,
            extractionConfidence: 1,
            resolutionStatus: index === 2 ? "active" : "superseded",
          }),
        ),
      );
      expect((await runtime.quote(request())).status).toBe("DECLINE");
      const backupId = `backup-${merchantId}`;
      const backupCapability = {
        ...capability,
        merchantId: backupId,
        capabilityId: `cap-${backupId}`,
      };
      canonicalData.seedCapability(backupCapability);
      canonicalData.seedInventory({
        merchantId: backupId,
        sku: "hoodie",
        available: 300,
        asOf: now.toISOString(),
      });
      await runtime.initialize({
        identity: {
          merchantId: backupId,
          displayName: backupId,
          specialty: "Backup",
          boundaries: [],
        },
        traceId: "backup",
      });
      await getPool().query(
        "insert into capabilities(capability_id,merchant_id,kind,name,capability_json) values($1,$2,$3,$4,$5)",
        [
          backupCapability.capabilityId,
          backupId,
          backupCapability.kind,
          backupCapability.name,
          backupCapability,
        ],
      );
      expect(
        (
          await runtime.quote(
            request("backup-order", {
              merchantId: backupId,
              capabilityId: backupCapability.capabilityId,
            }),
          )
        ).status,
      ).toBe("CAN_ACCEPT");
      expect(
        await canonicalData.getCanonicalClaims(merchantId, ["capacity"]),
      ).toHaveLength(3);
    });
  },
);
