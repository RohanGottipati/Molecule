import {
  CandidateCapabilitySchema,
  CanonicalClaimSchema,
  ChaosRequestSchema,
  MerchantCapabilitySchema,
  MerchantTwinSummarySchema,
  ProductIntentSchema,
  type CandidateCapability,
  type ChaosRequest,
  type MerchantCapability,
  type MerchantTwinSummary,
  type ProductIntent,
} from "@molecule/contracts";
import {
  effectId,
  getDatabaseFeatures,
  getMerchantRisks,
  getPool,
  listClaimsForMerchants,
  listMerchantClaims,
  persistEvent,
  readTransaction,
  resetDemoData,
  transaction,
  type DbClient,
} from "@molecule/db";

import { catalogCandidates } from "./catalog.js";
import { applyCapacityLimit } from "./capacity.js";

import {
  ingestClaim,
  resolveMerchant,
  resolveMerchantClaims,
  type ResolvedFact,
} from "./repository.js";

export interface RealityService {
  searchCandidates(
    intent: ProductIntent,
    excludedMerchantIds?: string[],
  ): Promise<CandidateCapability[]>;
  listMerchants(): Promise<MerchantTwinSummary[]>;
  applyChaos(request: ChaosRequest, traceId: string): Promise<void>;
  resetDemo(): Promise<void>;
}

interface MerchantRow {
  merchant_id: string;
  name: string;
  status: string;
  backboard_assistant_id: string | null;
}

interface CapabilityRow {
  merchant_id: string;
  capability_json: unknown;
}

interface ReservationRow {
  capability_id: string;
  quantity: string;
}

function hours(capability: MerchantCapability): number {
  const multiplier = { minutes: 1 / 60, hours: 1, business_hours: 3, days: 24 };
  return capability.leadTime.max * multiplier[capability.leadTime.unit];
}

// Sustained run length at the quoted production rate; mirrors the solver's
// duration model for periodic non-supply capacity.
function productionHours(
  capability: MerchantCapability,
  quantity: number,
): number {
  const { available, period } = capability.capacity;
  if (capability.kind === "SUPPLY" || period === undefined || !available)
    return 0;
  const periodHours = { hour: 1, day: 24, week: 168 }[period];
  return (quantity / available) * periodHours;
}

function applyFacts(
  capability: MerchantCapability,
  facts: ResolvedFact[],
  blocked: string[],
) {
  let unknownPrice = false;
  let unknownCapacity = false;
  for (const fact of facts) {
    const prefix = `${capability.capabilityId}.`;
    const inventory = fact.field === `inventory.${capability.capabilityId}`;
    const resource = /^resource\.(.+)\.(inventory|capacity)$/.exec(fact.field);
    const scopedResource = resource?.[1] === capability.capabilityId;
    if (
      fact.field.includes(".") &&
      !fact.field.startsWith(prefix) &&
      !inventory &&
      !scopedResource
    )
      continue;
    const field = inventory
      ? "inventory"
      : scopedResource
        ? resource[2]!
        : fact.field.startsWith(prefix)
          ? fact.field.slice(prefix.length)
          : fact.field;
    if (
      ![
        "price",
        "unitPrice",
        "setup_fee",
        "capacity",
        "capacity_per_day",
        "inventory",
        "lead_time_hours",
        "material",
        "color",
        "diet",
        "status",
      ].includes(field)
    )
      continue;
    if (fact.status !== "resolved") {
      blocked.push(`${fact.field} is ${fact.status}`);
      if (field === "price" || field === "unitPrice") unknownPrice = true;
      if (["capacity", "capacity_per_day", "inventory"].includes(field))
        unknownCapacity = true;
      continue;
    }
    if (fact.winningClaimId)
      capability.sourceClaimIds.push(fact.winningClaimId);
    const numericField = [
      "price",
      "unitPrice",
      "setup_fee",
      "capacity",
      "capacity_per_day",
      "inventory",
      "lead_time_hours",
    ].includes(field);
    if (
      numericField &&
      (typeof fact.value !== "number" ||
        !Number.isFinite(fact.value) ||
        fact.value < 0)
    ) {
      blocked.push(`${fact.field} has an invalid resolved numeric value`);
      if (field === "price" || field === "unitPrice") unknownPrice = true;
      if (["capacity", "capacity_per_day", "inventory"].includes(field))
        unknownCapacity = true;
      continue;
    }
    if (
      ["material", "color", "diet"].includes(field) &&
      (typeof fact.value !== "string" || !fact.value.trim())
    ) {
      blocked.push(`${fact.field} has an invalid resolved attribute`);
      continue;
    }
    if (
      typeof fact.value === "number" &&
      Number.isFinite(fact.value) &&
      fact.value >= 0
    ) {
      if (field === "price" || field === "unitPrice")
        capability.pricing.unitPrice = fact.value;
      if (field === "setup_fee") capability.pricing.setupFee = fact.value;
      if (["capacity", "capacity_per_day", "inventory"].includes(field)) {
        const result = applyCapacityLimit(
          capability.capacity,
          capability.quantity.unit,
          field as "capacity" | "capacity_per_day" | "inventory",
          fact.value,
          fact.normalizedUnit,
        );
        if (result.ok) capability.capacity = result.capacity;
        else {
          blocked.push(`${fact.field}: ${result.reason}`);
          unknownCapacity = true;
        }
      }
      if (field === "lead_time_hours")
        capability.leadTime = {
          min: fact.value,
          max: fact.value,
          unit: "hours",
        };
    } else if (
      ["material", "color", "diet"].includes(field) &&
      typeof fact.value === "string"
    ) {
      for (const port of capability.produces)
        port.attributes[field] = fact.value;
    } else if (field === "status" && fact.value !== "online")
      blocked.push("Merchant is offline");
  }
  if (unknownPrice) delete capability.pricing.unitPrice;
  if (unknownCapacity) delete capability.capacity.available;
  capability.sourceClaimIds = [...new Set(capability.sourceClaimIds)].sort();
}

function normalized(value: unknown): string {
  return String(value).trim().toLowerCase();
}

function matches(
  value: unknown,
  operator: ProductIntent["hardConstraints"][number]["operator"],
  wanted: unknown,
): boolean {
  if (value === undefined || value === null) return false;
  const actual = normalized(value);
  const expected = normalized(wanted);
  switch (operator) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "contains":
      return actual.includes(expected);
    case "not_contains":
      return !actual.includes(expected);
    case "in":
      return (
        Array.isArray(wanted) &&
        wanted.some((entry) => normalized(entry) === actual)
      );
    case "lt":
      return (
        typeof value === "number" &&
        typeof wanted === "number" &&
        value < wanted
      );
    case "lte":
      return (
        typeof value === "number" &&
        typeof wanted === "number" &&
        value <= wanted
      );
    case "gt":
      return (
        typeof value === "number" &&
        typeof wanted === "number" &&
        value > wanted
      );
    case "gte":
      return (
        typeof value === "number" &&
        typeof wanted === "number" &&
        value >= wanted
      );
  }
}

function relevance(
  capability: MerchantCapability,
  intent: ProductIntent,
): number {
  if (capability.kind === "SUPPLY") {
    return intent.desiredOutputs.some((output) =>
      capability.produces.some(
        (port) =>
          normalized(port.attributes.product ?? port.name) ===
            normalized(output.attributes.product ?? output.outputId) ||
          output.name.toLowerCase().includes(port.name.toLowerCase()),
      ),
    )
      ? 1
      : 0;
  }
  const text =
    `${capability.name} ${capability.description} ${capability.produces.map((port) => `${port.name} ${Object.values(port.attributes).join(" ")}`).join(" ")}`.toLowerCase();
  return intent.transformations.some((need) => {
    if (capability.kind === "ASSEMBLE")
      return /assembl|packag/i.test(need.kind);
    if (capability.kind === "FULFILL")
      return /fulfill|ship|deliver/i.test(need.kind);
    return text.includes(need.kind.toLowerCase());
  })
    ? 1
    : 0;
}

function satisfiesAttributes(
  capability: MerchantCapability,
  intent: ProductIntent,
): boolean {
  const ports = capability.produces;
  for (const constraint of intent.hardConstraints) {
    const parts = constraint.field.split(".");
    const field = parts.at(-1) ?? "";
    if (!["material", "color", "diet", "quality", "packaging"].includes(field))
      continue;
    const scope = parts.length > 1 ? parts[0] : undefined;
    const relevant = ports.filter((port) =>
      scope
        ? normalized(port.attributes.product ?? port.name) === scope
        : field === "diet"
          ? port.kind === "food"
          : field === "packaging"
            ? port.kind === "package"
            : true,
    );
    if (
      relevant.some(
        (port) =>
          !matches(
            port.attributes[field],
            constraint.operator,
            constraint.value,
          ),
      )
    )
      return false;
  }
  if (capability.kind === "SUPPLY") {
    for (const output of intent.desiredOutputs) {
      const port = ports.find(
        (entry) =>
          normalized(entry.attributes.product ?? entry.name) ===
          normalized(output.attributes.product ?? output.outputId),
      );
      if (!port) continue;
      for (const [field, value] of Object.entries(output.attributes)) {
        if (
          ["material", "color", "diet", "quality"].includes(field) &&
          !matches(port.attributes[field], "eq", value)
        )
          return false;
      }
    }
  }
  return true;
}

export function createRealityService(
  options: { now?: () => Date } = {},
): RealityService {
  const now = options.now ?? (() => new Date());

  async function readCatalog(
    client: DbClient,
    merchants: MerchantRow[],
  ): Promise<{
    candidatesByMerchant: Map<string, CandidateCapability[]>;
    claimsByMerchant: Map<
      string,
      Awaited<ReturnType<typeof listClaimsForMerchants>>
    >;
  }> {
    const merchantIds = merchants.map((merchant) => merchant.merchant_id);
    if (!merchantIds.length)
      return {
        candidatesByMerchant: new Map(),
        claimsByMerchant: new Map(),
      };
    const claims = await listClaimsForMerchants(merchantIds, client);
    const capabilityRows = await client.query<CapabilityRow>(
      `select merchant_id,capability_json from capabilities
       where merchant_id=any($1::text[]) order by merchant_id,capability_id`,
      [merchantIds],
    );
    const capabilities = capabilityRows.rows.map((row) => ({
      merchantId: row.merchant_id,
      capability: MerchantCapabilitySchema.parse(row.capability_json),
    }));
    const capabilityIds = capabilities.map(
      ({ capability }) => capability.capabilityId,
    );
    const reservations = capabilityIds.length
      ? await client.query<ReservationRow>(
          `select capability_id,coalesce(sum(quantity),0) as quantity
           from reservations
           where capability_id=any($1::text[]) and status='active' and expires_at>now()
           group by capability_id`,
          [capabilityIds],
        )
      : { rows: [] };
    const risks = await getMerchantRisks(
      capabilities.map(({ merchantId, capability }) => ({
        merchantId,
        capabilityId: capability.capabilityId,
      })),
      client,
    );
    const claimsByMerchant = new Map<
      string,
      Awaited<ReturnType<typeof listClaimsForMerchants>>
    >();
    for (const claim of claims) {
      const entries = claimsByMerchant.get(claim.merchantId) ?? [];
      entries.push(claim);
      claimsByMerchant.set(claim.merchantId, entries);
    }
    const factsByMerchant = new Map<string, ResolvedFact[]>();
    for (const merchantId of merchantIds) {
      const merchantClaims = claimsByMerchant.get(merchantId) ?? [];
      const resolutions = resolveMerchantClaims(merchantClaims, now());
      factsByMerchant.set(
        merchantId,
        resolutions.map(({ fact }) => fact),
      );
      // Evidence shown with a read-only snapshot must agree with that
      // snapshot's resolution, including sources that have lost freshness.
      for (const { fieldClaims, result, winner } of resolutions) {
        const eligible = new Set(
          result.status === "unknown"
            ? []
            : result.allScored.map(({ claim }) => claim.claimId),
        );
        for (const claim of fieldClaims) {
          if (
            claim.resolutionStatus === "quarantined" ||
            claim.resolutionStatus === "unknown"
          )
            continue;
          claim.resolutionStatus = !eligible.has(claim.claimId)
            ? "superseded"
            : result.status === "conflicted"
              ? "conflicted"
              : claim.claimId === winner?.claimId
                ? "active"
                : "superseded";
        }
      }
    }
    for (const merchant of merchants) {
      const status = factsByMerchant
        .get(merchant.merchant_id)
        ?.find((fact) => fact.field === "status");
      if (status)
        merchant.status =
          status.status === "resolved" &&
          (status.value === "online" || status.value === "offline")
            ? status.value
            : "unknown";
    }
    const reservedByCapability = new Map(
      reservations.rows.map((row) => [row.capability_id, Number(row.quantity)]),
    );
    const merchantsById = new Map(
      merchants.map((merchant) => [merchant.merchant_id, merchant]),
    );
    const candidatesByMerchant = new Map<string, CandidateCapability[]>();
    for (const { merchantId, capability } of capabilities) {
      const merchant = merchantsById.get(merchantId);
      if (!merchant) continue;
      const activeClaimIds = new Set(
        (claimsByMerchant.get(merchantId) ?? [])
          .filter((claim) => claim.resolutionStatus === "active")
          .map((claim) => claim.claimId),
      );
      capability.sourceClaimIds = capability.sourceClaimIds.filter((claimId) =>
        activeClaimIds.has(claimId),
      );
      const blocked =
        merchant.status === "online"
          ? []
          : [`Merchant status is ${merchant.status}`];
      applyFacts(
        capability,
        factsByMerchant.get(merchant.merchant_id) ?? [],
        blocked,
      );
      if (capability.pricing.unitPrice === undefined)
        blocked.push("Price is unknown");
      if (capability.capacity.available === undefined)
        blocked.push("Capacity is unknown");
      // Periodic capacity is a production rate, not a one-time stock balance.
      // Existing unscheduled holds cannot be subtracted from every future
      // period here; the solver certifies whether the dated work fits. For
      // non-periodic inventory, active holds do reduce what can be offered.
      if (
        capability.capacity.available !== undefined &&
        capability.capacity.period === undefined
      )
        capability.capacity.available = Math.max(
          0,
          capability.capacity.available -
            (reservedByCapability.get(capability.capabilityId) ?? 0),
        );
      const risk = risks.get(capability.capabilityId)!;
      const candidates = candidatesByMerchant.get(merchant.merchant_id) ?? [];
      candidates.push(
        CandidateCapabilitySchema.parse({
          capabilityId: capability.capabilityId,
          merchantId: merchant.merchant_id,
          capability,
          risk,
          blockedReasons: blocked,
          score: Number(
            (
              100 -
              (capability.pricing.unitPrice ?? 0) -
              (risk.p95Hours ?? hours(capability)) / 10
            ).toFixed(6),
          ),
        }),
      );
      candidatesByMerchant.set(merchant.merchant_id, candidates);
    }
    return { candidatesByMerchant, claimsByMerchant };
  }

  return {
    async searchCandidates(input, excludedMerchantIds = []) {
      const intent = ProductIntentSchema.parse(input);
      excludedMerchantIds = CanonicalClaimSchema.shape.merchantId
        .array()
        .parse(excludedMerchantIds);
      return readTransaction(async (client) => {
        const merchants = await client.query<MerchantRow>(
          "select * from merchants where not is_placeholder and not(merchant_id=any($1::text[])) order by merchant_id",
          [excludedMerchantIds],
        );
        const externalCatalog = await catalogCandidates(
          client,
          intent,
          excludedMerchantIds,
        );
        const catalog = await readCatalog(client, merchants.rows);
        const candidates: CandidateCapability[] = [
          ...externalCatalog.candidates,
        ];
        const remainingHours =
          (Date.parse(intent.deadline) - now().getTime()) / 3600000;
        for (const merchant of merchants.rows) {
          for (const candidate of catalog.candidatesByMerchant.get(
            merchant.merchant_id,
          ) ?? []) {
            const cap = candidate.capability;
            const quantity =
              cap.kind === "SUPPLY"
                ? Math.max(
                    ...intent.desiredOutputs
                      .filter((output) =>
                        cap.produces.some(
                          (port) =>
                            normalized(port.attributes.product ?? port.name) ===
                            normalized(
                              output.attributes.product ?? output.outputId,
                            ),
                        ),
                      )
                      .map((output) => output.quantity ?? intent.quantity),
                    intent.quantity,
                  )
                : intent.quantity;
            if (
              candidate.blockedReasons.length ||
              !relevance(cap, intent) ||
              !satisfiesAttributes(cap, intent) ||
              cap.pricing.currency !== intent.currency ||
              cap.capacity.available === undefined ||
              cap.capacity.available <= 0 ||
              ((cap.kind === "SUPPLY" || cap.capacity.period === undefined) &&
                cap.capacity.available < quantity) ||
              quantity < cap.quantity.min ||
              quantity > cap.quantity.max ||
              Math.max(
                hours(cap),
                candidate.risk?.p95Hours ?? 0,
                productionHours(cap, quantity),
              ) > remainingHours
            )
              continue;
            candidates.push(candidate);
          }
        }
        return candidates.sort(
          (a, b) =>
            b.score - a.score || a.capabilityId.localeCompare(b.capabilityId),
        );
      });
    },
    async listMerchants() {
      return readTransaction(async (client) => {
        const rows = await client.query<MerchantRow>(
          "select * from merchants where not is_placeholder order by merchant_id",
        );
        const merchantIds = rows.rows.map((merchant) => merchant.merchant_id);
        const catalog = await readCatalog(client, rows.rows);
        const policies = await client.query<{
          merchant_id: string;
          policy_text: string;
        }>(
          `select merchant_id,policy_text from merchant_policies
           where merchant_id=any($1::text[]) order by merchant_id,policy_id`,
          [merchantIds],
        );
        const documents = await client.query<{
          merchant_id: string;
          document_id: string;
          name: string;
          status: string;
        }>(
          `select merchant_id,document_id,coalesce(name,kind) as name,status
           from merchant_documents where merchant_id=any($1::text[])
           order by merchant_id,document_id`,
          [merchantIds],
        );
        const policiesByMerchant = new Map<string, string[]>();
        for (const policy of policies.rows) {
          const entries = policiesByMerchant.get(policy.merchant_id) ?? [];
          entries.push(policy.policy_text);
          policiesByMerchant.set(policy.merchant_id, entries);
        }
        const documentsByMerchant = new Map<
          string,
          { documentId: string; name: string; status: string }[]
        >();
        for (const document of documents.rows) {
          const entries = documentsByMerchant.get(document.merchant_id) ?? [];
          entries.push({
            documentId: document.document_id,
            name: document.name,
            status: document.status,
          });
          documentsByMerchant.set(document.merchant_id, entries);
        }
        const summaries: MerchantTwinSummary[] = [];
        for (const merchant of rows.rows) {
          summaries.push(
            MerchantTwinSummarySchema.parse({
              merchantId: merchant.merchant_id,
              name: merchant.name,
              status: merchant.status,
              capabilities:
                catalog.candidatesByMerchant.get(merchant.merchant_id) ?? [],
              claims: catalog.claimsByMerchant.get(merchant.merchant_id) ?? [],
              memories: [],
              policies: policiesByMerchant.get(merchant.merchant_id) ?? [],
              documents: documentsByMerchant.get(merchant.merchant_id) ?? [],
              assistantId: merchant.backboard_assistant_id ?? undefined,
            }),
          );
        }
        return summaries;
      });
    },
    async applyChaos(input, traceId) {
      if (process.env.DEMO_MODE !== "true")
        throw new Error("Chaos requires DEMO_MODE=true");
      if (!traceId?.trim()) throw new Error("traceId is required");
      const request = ChaosRequestSchema.parse(input);
      const merchantId =
        request.merchantId ??
        (request.scenario === "inventory_zero" ? "base-goods" : "thread-forge");
      const actionKey = `chaos:${traceId}:${request.scenario}:${merchantId}:${request.orderId ?? ""}`;
      await transaction(async (client) => {
        await client.query("select pg_advisory_xact_lock(73481202)");
        const merchant = await client.query(
          "select merchant_id from merchants where merchant_id=$1 and demo_tag='MOLECULE_DEMO' for update",
          [merchantId],
        );
        if (!merchant.rowCount)
          throw new Error("Chaos target is not a demo merchant");
        const action = await client.query(
          `insert into demo_chaos_actions(action_key,merchant_id,scenario,trace_id,request_json)
          values($1,$2,$3,$4,$5) on conflict(action_key) do nothing returning action_key`,
          [
            actionKey,
            merchantId,
            request.scenario,
            traceId,
            JSON.stringify(request),
          ],
        );
        if (!action.rowCount) return;
        const facts = await resolveMerchant(merchantId, traceId, client, now());
        const rows = await client.query<{ capability_json: unknown }>(
          "select capability_json from capabilities where merchant_id=$1 order by capability_id for update",
          [merchantId],
        );
        if (request.scenario !== "supplier_offline" && !rows.rows.length)
          throw new Error("No capabilities for chaos scenario");
        if (
          request.scenario === "inventory_zero" &&
          !rows.rows.some(
            (row) =>
              MerchantCapabilitySchema.parse(row.capability_json).kind ===
              "SUPPLY",
          )
        ) {
          throw new Error("Inventory chaos requires a supply merchant");
        }
        if (request.scenario === "supplier_offline") {
          await client.query(
            "update merchants set status='offline',updated_at=now() where merchant_id=$1",
            [merchantId],
          );
          await ingestClaim(
            {
              merchantId,
              field: "status",
              rawValue: "offline",
              sourceKind: "manual",
              sourceReference: `demo:chaos:${actionKey}`,
              observedAt: now().toISOString(),
              sourceAuthority: 1,
              extractionConfidence: 1,
              evidenceText: "Synthetic supplier offline scenario",
            },
            traceId,
            client,
          );
        } else {
          for (const row of rows.rows) {
            const cap = MerchantCapabilitySchema.parse(row.capability_json);
            if (request.scenario === "inventory_zero" && cap.kind !== "SUPPLY")
              continue;
            const field = `${cap.capabilityId}.${
              request.scenario === "inventory_zero"
                ? "inventory"
                : request.scenario === "lead_time_delay"
                  ? "lead_time_hours"
                  : "price"
            }`;
            const existing = facts.find((fact) => fact.field === field);
            if (
              ["price_spike", "conflicting_document"].includes(
                request.scenario,
              ) &&
              existing?.status !== "resolved"
            ) {
              throw new Error("Cannot perturb unresolved price");
            }
            const price =
              existing?.status === "resolved" &&
              typeof existing.value === "number"
                ? existing.value
                : cap.pricing.unitPrice;
            const value =
              request.scenario === "inventory_zero"
                ? 0
                : request.scenario === "lead_time_delay"
                  ? 240
                  : price === undefined
                    ? undefined
                    : price * 3;
            if (value === undefined)
              throw new Error("Cannot perturb unknown price");
            if (request.scenario === "conflicting_document") {
              for (const [index, amount] of [price, value].entries()) {
                await ingestClaim(
                  {
                    merchantId,
                    field,
                    rawValue: amount,
                    sourceKind: "document",
                    sourceReference: `demo:chaos:${actionKey}:${index}`,
                    observedAt: now().toISOString(),
                    sourceAuthority: 1,
                    extractionConfidence: 1,
                    evidenceText:
                      "Synthetic equally authoritative contradictory pricing sheet",
                  },
                  traceId,
                  client,
                );
              }
            } else {
              await ingestClaim(
                {
                  merchantId,
                  field,
                  rawValue: value,
                  sourceKind: "manual",
                  sourceReference: `demo:chaos:${actionKey}`,
                  observedAt: now().toISOString(),
                  sourceAuthority: 1,
                  extractionConfidence: 1,
                  evidenceText: `Synthetic ${request.scenario} operational override`,
                },
                traceId,
                client,
              );
            }
          }
        }
        await persistEvent(
          {
            eventId: effectId(actionKey),
            traceId,
            merchantId,
            orderId: request.orderId,
            eventType: "reality.chaos.applied",
            ts: now().toISOString(),
            severity: "WARN",
            source: "rox",
            payload: {
              actionKey,
              scenario: request.scenario,
              reversible: true,
              synthetic: true,
            },
          },
          client,
        );
      });
    },
    async resetDemo() {
      await resetDemoData();
    },
  };
}

export async function realityHealth() {
  await getPool().query("select 1");
  return { status: "ok", service: "reality", ...(await getDatabaseFeatures()) };
}
