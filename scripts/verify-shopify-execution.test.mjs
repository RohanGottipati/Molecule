import assert from "node:assert/strict";
import { test } from "node:test";
import { ShopifyTransport, actionTag } from "../packages/shopify/dist/index.js";
import {
  assertBoundedPlan,
  assertMutationPreflight,
  preflight,
  smokeConfig,
  syntheticSolverInput,
  verifyCreatedResources,
} from "./verify-shopify-execution.mjs";

const env = {
  SHOPIFY_STORES: "molecule-test, supplier-test.myshopify.com",
  SHOPIFY_CLIENT_ID: "synthetic-client",
  SHOPIFY_API_SECRET: "synthetic-secret",
  SHOPIFY_SMOKE_DATABASE_URL:
    "postgresql://test:test@127.0.0.1:5432/molecule_shopify_smoke_test",
};
const args = [
  "--execute",
  "--store=molecule-test",
  "--run-id=molecule-smoke-unit-test",
];
const approved = {
  developmentStore: true,
  currency: "CAD",
  requiredScopesPresent: true,
};

test("defaults to read-only verification and prefers renewable client credentials", () => {
  const config = smokeConfig([], { ...env, SHOPIFY_ACCESS_TOKEN: "old-token" });
  assert.equal(config.execute, false);
  assert.equal(config.stores.length, 2);
  assert.deepEqual(config.auth, {
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret",
  });
});

for (const denied of [
  ["--execute"],
  ["--execute", "--store=molecule-test"],
  ["--execute", "--store=molecule-test", "--run-id=ordinary-order"],
  [
    "--execute",
    "--store=unconfigured-test",
    "--run-id=molecule-smoke-unit-test",
  ],
  ["--pay"],
])
  test(`rejects unsafe execution arguments: ${denied.join(" ")}`, () => {
    assert.throws(() => smokeConfig(denied, env));
  });

for (const url of [
  "postgresql://test:test@remote.example/molecule_shopify_smoke_test",
  "postgresql://test:test@127.0.0.1/production",
  "postgresql://test:test@127.0.0.1/molecule_shopify_smoke_test?host=remote.example",
])
  test("rejects non-isolated database destinations", () => {
    assert.throws(() =>
      smokeConfig(args, { ...env, SHOPIFY_SMOKE_DATABASE_URL: url }),
    );
  });

test("requires a local solver and permits the exact development-store scope", () => {
  assert.throws(() =>
    smokeConfig(args, {
      ...env,
      SHOPIFY_SMOKE_SOLVER_URL: "https://solver.example",
    }),
  );
  assert.equal(smokeConfig(args, env).execute, true);
  assert.deepEqual(smokeConfig(args, env).stores, [
    "molecule-test.myshopify.com",
  ]);
});

test("fails closed for ordinary stores, missing write scopes, and unsupported currency", () => {
  for (const change of [
    { developmentStore: false },
    { requiredScopesPresent: false },
    { currency: "USD" },
  ])
    assert.throws(() => assertMutationPreflight({ ...approved, ...change }));
  assert.doesNotThrow(() => assertMutationPreflight(approved));
});

test("preflight reads provider development status and scopes without accepting missing facts", async () => {
  let query;
  const transport = new ShopifyTransport({
    domain: "molecule-test.myshopify.com",
    auth: { accessToken: "synthetic-token" },
    fetch: async (_url, init) => {
      query = JSON.parse(init.body).query;
      return Response.json({
        data: {
          shop: {
            myshopifyDomain: "molecule-test.myshopify.com",
            currencyCode: "CAD",
            plan: { partnerDevelopment: false },
          },
          currentAppInstallation: {
            accessScopes: [{ handle: "write_products" }],
          },
        },
      });
    },
  });
  const result = await preflight(transport);
  assert.match(query, /^query SmokePreflight/);
  assert.equal(result.developmentStore, false);
  assert.deepEqual(result.missingScopes, ["write_draft_orders"]);
  assert.throws(() => assertMutationPreflight(result));
});

test("the synthetic solver fixture is bounded and cannot promote itself to a valid plan", () => {
  const input = syntheticSolverInput(
    "molecule-smoke-unit-test",
    "trace",
    new Date("2026-09-19T12:00:00Z"),
  );
  assert.equal(input.intent.quantity, 1);
  assert.equal(input.intent.budgetMax, 1);
  assert.equal(input.candidates.length, 1);
  assert.equal(
    input.candidates[0].capability.sourceClaimIds[0],
    "synthetic-smoke-fixture",
  );
  assert.throws(() =>
    assertBoundedPlan({ ...input, status: "UNSAT" }, input.orderId),
  );
});

test("readback requires one draft/untracked product and two open unmailed unreserved drafts with matching durable tags", async () => {
  const orderId = "molecule-smoke-unit-test";
  const actions = ["product", "draft", "draft"].map((operation, index) => ({
    receipt: { actionKey: `action-${index}`, status: "SUCCEEDED" },
    effect: { operation, traceId: "trace" },
    resource: { id: `resource-${index}`, variantId: "variant" },
  }));
  const state = {
    orderId,
    actions: Object.fromEntries(
      actions.map((action, index) => [index, action]),
    ),
  };
  let change = {};
  const transport = {
    graphql: async (query, variables, schema) => {
      const index = Number(variables.id.split("-")[1]);
      const action = actions[index];
      const tags = [actionTag(action.receipt.actionKey)];
      return schema.parse(
        query.includes("SmokeProduct")
          ? {
              product: {
                id: action.resource.id,
                status: "DRAFT",
                tags,
                variants: {
                  nodes: [{ id: "variant", inventoryItem: { tracked: false } }],
                  pageInfo: { hasNextPage: false },
                },
              },
            }
          : {
              draftOrder: {
                id: action.resource.id,
                status: "OPEN",
                tags,
                completedAt: null,
                invoiceSentAt: null,
                reserveInventoryUntil: null,
                customAttributes: [
                  {
                    key: "molecule_action_key",
                    value: action.receipt.actionKey,
                  },
                  { key: "molecule_trace_id", value: "trace" },
                  { key: "molecule_order_id", value: orderId },
                ],
                totalQuantityOfLineItems: 1,
                totalPriceSet: {
                  presentmentMoney: { amount: "1.00", currencyCode: "CAD" },
                },
                ...change,
              },
            },
      );
    },
  };
  await verifyCreatedResources(transport, state);
  for (const invalid of [
    { status: "COMPLETED" },
    { invoiceSentAt: "2026-09-19T12:00:00Z" },
    { reserveInventoryUntil: "2026-09-19T12:00:00Z" },
    { tags: [] },
  ]) {
    change = invalid;
    await assert.rejects(verifyCreatedResources(transport, state));
  }
});
