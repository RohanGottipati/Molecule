import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProductionPlanSchema, type ProductionPlan } from "@molecule/contracts";
import {
  activateCatalog,
  closePool,
  getPool,
  importCatalog,
  migrate,
  persistEvent,
  reserveCatalogPlan,
  releaseCatalogPlan,
  transaction,
} from "@molecule/db";
import {
  catalogCandidates,
  ingestClaim,
  quoteCatalog,
  resolveMerchant,
} from "@molecule/service-reality";
import {
  MockShopifyClient,
  PostgresShopifyActionRepository,
} from "@molecule/shopify";
import {
  broadCatalogFixture,
  BROAD_CATALOG_CLOCK,
  BROAD_CATALOG_MERCHANTS,
} from "../../../packages/test-fixtures/src/broadCatalog.js";

const database = process.env.TEST_DATABASE_URL;
const root = resolve(import.meta.dirname, "../../..");
const fixture = broadCatalogFixture(
  `broad-test-${randomUUID()}`,
  Number(process.env.BROAD_RECIPE_LIMIT ?? 100),
);
const version = JSON.parse(fixture.jsonl.split("\n")[0]!)
  .catalogVersion as string;
const results: {
  recipe: string;
  category: string;
  planId: string;
  suppliers: number;
  cost: number;
  jobs: number;
  catalogVersion: string;
}[] = [];
const repository = () =>
  new PostgresShopifyActionRepository(getPool(), `broad:${version}`);
const run = promisify(execFile);
async function solve(input: unknown): Promise<ProductionPlan> {
  const { stdout } = await run(
    resolve(root, "services/solver/.venv/bin/python"),
    [
      "-c",
      "import json,sys; from app.models import SolverInput; from app.cpsat import solve; print(solve(SolverInput.model_validate_json(sys.argv[1])).model_dump_json(by_alias=True,exclude_none=True))",
      JSON.stringify(input),
    ],
    {
      cwd: resolve(root, "services/solver"),
      maxBuffer: 4_000_000,
      timeout: 20_000,
    },
  );
  return ProductionPlanSchema.parse(JSON.parse(stdout));
}

describe.skipIf(!database)(
  "broad catalog: actual Python solver, PostgreSQL, deterministic commerce",
  () => {
    beforeAll(async () => {
      process.env.DATABASE_URL = database;
      await migrate();
      await importCatalog(fixture.jsonl, "broad-import");
      await activateCatalog(version, "broad-activate", `activate:${version}`);
      // Explicit synthetic merchant evidence goes through existing claim resolution.
      for (const [merchantId] of BROAD_CATALOG_MERCHANTS) {
        await ingestClaim(
          {
            merchantId,
            field: "status",
            rawValue: "online",
            sourceKind: "manual",
            sourceReference: `demo:chaos:fixture:${version}`,
            observedAt: BROAD_CATALOG_CLOCK,
            sourceAuthority: 1,
            extractionConfidence: 1,
            evidenceText: "Synthetic catalog test merchant availability",
          },
          "broad-fixture",
        );
        await transaction((client) =>
          resolveMerchant(
            merchantId,
            "broad-fixture",
            client,
            new Date(BROAD_CATALOG_CLOCK),
          ),
        );
      }
    }, 30_000);
    afterAll(async () => {
      if (database) {
        const output = resolve(
          root,
          process.env.BROAD_CATALOG_EVIDENCE_PATH ??
            ".molecule-data/broad-catalog-verification.json",
        );
        await mkdir(resolve(root, ".molecule-data"), { recursive: true });
        await writeFile(
          output,
          JSON.stringify(
            {
              synthetic: true,
              live: false,
              catalogVersion: version,
              tested: results.length,
              results,
            },
            null,
            2,
          ),
        );
        await getPool().query(
          "delete from catalog_active_version where catalog_version=$1",
          [version],
        );
      }
      await closePool();
    });
    it.each(fixture.recipes)(
      "certifies and persists $id",
      async (recipe) => {
        const report = await transaction((client) =>
          catalogCandidates(client, recipe.intent),
        );
        const candidates = report.candidates;
        const quotes = await Promise.all(
          candidates.map((candidate) =>
            quoteCatalog({
              orderId: recipe.id,
              traceId: recipe.id,
              merchantId: candidate.merchantId,
              capabilityId: candidate.capabilityId,
              intentVersion: 1,
              quantity: 10,
              currency: "CAD",
              hold: false,
              hardConstraints: [],
              softPreferences: [],
              relevantClaimFields: [],
              constraints: [],
              catalogVersion: candidate.catalogVersion,
              selectedItem: candidate.selectedItem,
            }),
          ),
        );
        const input = {
          orderId: `${version}:${recipe.id}`,
          traceId: recipe.id,
          generation: 1,
          now: BROAD_CATALOG_CLOCK,
          intent: recipe.intent,
          candidates,
          quotes,
          changePenaltyNodeIds: [],
        };
        const plan = await solve(input);
        expect(plan.status, JSON.stringify(plan.constraintResults)).toBe(
          "VALID",
        );
        expect(plan.nodes).toHaveLength(
          recipe.intent.desiredOutputs.length +
            recipe.intent.transformations.length,
        );
        expect(
          new Set(plan.nodes.map((n) => n.merchantId)).size,
        ).toBeGreaterThanOrEqual(recipe.expected.minimumDistinctSuppliers);
        expect(
          plan.nodes.every(
            (n) =>
              n.quantity === 10 &&
              n.catalogVersion === version &&
              n.selectedItem,
          ),
        ).toBe(true);
        expect(plan.totalCost).toBe(
          plan.nodes.reduce((sum, n) => sum + n.totalCost, 0),
        );
        expect(plan.nodes.some((n) => n.kind === "ASSEMBLE")).toBe(
          recipe.expected.outputKind === "bundle",
        );
        await persistEvent({
          eventId: randomUUID(),
          traceId: recipe.id,
          orderId: plan.orderId,
          planId: plan.planId,
          eventType: "plan.validated",
          severity: "INFO",
          source: "solver",
          ts: BROAD_CATALOG_CLOCK,
          payload: { plan, recipeId: recipe.id, synthetic: true },
        });
        await reserveCatalogPlan(plan, recipe.id, `reserve:${plan.planId}`);
        const commerce = new MockShopifyClient({ repository: repository() });
        const receipt = await commerce.commit(plan, recipe.id);
        expect(receipt.supplierJobs).toHaveLength(plan.nodes.length);
        expect(receipt.compositeProduct?.productGid).toBeTruthy();
        expect(receipt.actions.every((a) => a.status === "SUCCEEDED")).toBe(
          true,
        );
        expect(await commerce.commit(plan, recipe.id)).toEqual(receipt);
        expect(
          (await repository().events(plan.orderId)).length,
        ).toBeGreaterThan(0);
        await persistEvent({
          eventId: randomUUID(),
          traceId: recipe.id,
          orderId: plan.orderId,
          planId: plan.planId,
          eventType: "catalog.recipe.verified",
          severity: "INFO",
          source: "orchestrator",
          ts: new Date().toISOString(),
          payload: {
            recipeId: recipe.id,
            catalogVersion: version,
            mode: "mock",
            synthetic: true,
            productGid: receipt.compositeProduct?.productGid,
            jobs: receipt.supplierJobs.length,
          },
        });
        results.push({
          recipe: recipe.id,
          category: recipe.category,
          planId: plan.planId,
          suppliers: new Set(plan.nodes.map((n) => n.merchantId)).size,
          cost: plan.totalCost,
          jobs: receipt.supplierJobs.length,
          catalogVersion: version,
        });
        // Each recipe is an independent scenario; reconcile jobs before freeing fixtures.
        await commerce.supersede(plan.orderId, plan.planId, recipe.id);
        await releaseCatalogPlan(
          plan.planId,
          recipe.id,
          `release:${plan.planId}`,
        );
      },
      30_000,
    );
  },
);
