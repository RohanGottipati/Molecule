// Read-only by default. --execute is restricted to one explicitly selected
// development store and a disposable local receipt database. Never pays,
// completes, publishes, reserves inventory, sends mail, or deletes resources.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  ProductionPlanSchema,
  SolverInputSchema,
} from "../packages/contracts/dist/index.js";
import {
  RealShopifyClient,
  ShopifyError,
  ShopifyTransport,
  actionTag,
  matchesActionTag,
  connectShopifyRepository,
  shopDomain,
} from "../packages/shopify/dist/index.js";

const { z } = createRequire(
  new URL("../packages/shopify/package.json", import.meta.url),
)("zod");
const requiredScopes = ["write_products", "write_draft_orders"];
const smokeMerchant = "molecule-smoke-supplier";

export function smokeConfig(argv, env) {
  const args = {};
  for (const arg of argv) {
    const match = /^--(store|run-id)=(.+)$/.exec(arg);
    if (match) args[match[1]] = match[2];
    else if (arg === "--execute") args.execute = true;
    else throw new ShopifyError("SMOKE_INVALID_ARGUMENT");
  }
  const stores = (env.SHOPIFY_STORES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) =>
      shopDomain(value.includes(".") ? value : `${value}.myshopify.com`),
    );
  if (!stores.length) throw new ShopifyError("SMOKE_NO_CONFIGURED_STORES");
  const selected = args.store
    ? shopDomain(
        args.store.includes(".") ? args.store : `${args.store}.myshopify.com`,
      )
    : undefined;
  if (selected && !stores.includes(selected))
    throw new ShopifyError("SMOKE_STORE_NOT_CONFIGURED");
  const auth =
    env.SHOPIFY_CLIENT_ID && env.SHOPIFY_API_SECRET
      ? {
          clientId: env.SHOPIFY_CLIENT_ID,
          clientSecret: env.SHOPIFY_API_SECRET,
        }
      : { accessToken: env.SHOPIFY_ACCESS_TOKEN ?? "" };
  if (args.execute) {
    if (
      !selected ||
      !/^molecule-smoke-[a-z0-9-]{8,64}$/.test(args["run-id"] ?? "")
    )
      throw new ShopifyError("SMOKE_EXPLICIT_STORE_AND_RUN_ID_REQUIRED");
    let database;
    let solver;
    try {
      database = new URL(env.SHOPIFY_SMOKE_DATABASE_URL);
      solver = new URL(env.SHOPIFY_SMOKE_SOLVER_URL ?? "http://127.0.0.1:8000");
    } catch {
      throw new ShopifyError("SMOKE_LOCAL_DATABASE_AND_SOLVER_REQUIRED");
    }
    if (
      !["postgres:", "postgresql:"].includes(database.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
      !/^\/molecule_shopify_smoke_[a-z0-9_]+$/.test(database.pathname) ||
      database.search ||
      database.hash ||
      solver.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(solver.hostname) ||
      solver.username ||
      solver.password ||
      solver.search ||
      solver.hash ||
      solver.pathname !== "/"
    )
      throw new ShopifyError("SMOKE_LOCAL_DATABASE_AND_SOLVER_REQUIRED");
  }
  return {
    stores: selected ? [selected] : stores,
    auth,
    execute: args.execute === true,
    runId: args["run-id"],
    databaseUrl: env.SHOPIFY_SMOKE_DATABASE_URL,
    solverUrl: env.SHOPIFY_SMOKE_SOLVER_URL ?? "http://127.0.0.1:8000",
  };
}

export async function preflight(transport) {
  const result = await transport.graphql(
    `query SmokePreflight { shop { myshopifyDomain currencyCode plan { partnerDevelopment } }
      currentAppInstallation { accessScopes { handle } } }`,
    {},
    z.object({
      shop: z.object({
        myshopifyDomain: z.string(),
        currencyCode: z.string(),
        plan: z.object({ partnerDevelopment: z.boolean() }),
      }),
      currentAppInstallation: z.object({
        accessScopes: z.array(z.object({ handle: z.string() })),
      }),
    }),
  );
  if (result.shop.myshopifyDomain !== transport.domain)
    throw new ShopifyError("SMOKE_STORE_IDENTITY_MISMATCH");
  const scopes = result.currentAppInstallation.accessScopes.map(
    ({ handle }) => handle,
  );
  return {
    developmentStore: result.shop.plan.partnerDevelopment,
    currency: result.shop.currencyCode,
    requiredScopesPresent: requiredScopes.every((scope) =>
      scopes.includes(scope),
    ),
    missingScopes: requiredScopes.filter((scope) => !scopes.includes(scope)),
  };
}

export function assertMutationPreflight(result) {
  if (!result.developmentStore)
    throw new ShopifyError("SMOKE_REQUIRES_DEVELOPMENT_STORE");
  if (!result.requiredScopesPresent)
    throw new ShopifyError("SMOKE_MISSING_WRITE_SCOPES");
  if (result.currency !== "CAD")
    throw new ShopifyError("SMOKE_REQUIRES_CAD_STORE");
}

export function syntheticSolverInput(runId, traceId, now = new Date()) {
  const capabilityId = `${runId}-synthetic-item`;
  return SolverInputSchema.parse({
    orderId: runId,
    traceId,
    generation: 1,
    now: now.toISOString(),
    intent: {
      intentId: randomUUID(),
      version: 1,
      quantity: 1,
      currency: "CAD",
      budgetMax: 1,
      deadline: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
      desiredOutputs: [
        { outputId: "smoke-output", name: "Smoke test item", attributes: {} },
      ],
      transformations: [],
      hardConstraints: [],
      softPreferences: [],
      assets: [],
      ambiguityFlags: [],
    },
    candidates: [
      {
        capabilityId,
        merchantId: smokeMerchant,
        score: 1,
        capability: {
          capabilityId,
          merchantId: smokeMerchant,
          kind: "SUPPLY",
          name: "Smoke test item",
          description:
            "Synthetic API verification only; not an operational merchant claim.",
          accepts: [],
          produces: [
            { kind: "product", name: "Smoke test item", attributes: {} },
          ],
          quantity: { min: 1, max: 1, unit: "units" },
          pricing: { currency: "CAD", unitPrice: 1, setupFee: 0 },
          leadTime: { min: 1, max: 1, unit: "hours" },
          capacity: { available: 1, maximum: 1, period: "day" },
          hardRules: [],
          softRules: [],
          sourceClaimIds: ["synthetic-smoke-fixture"],
        },
        risk: { p50Hours: 1, p95Hours: 1, sampleCount: 1, confidence: "low" },
        blockedReasons: [],
      },
    ],
    quotes: [
      {
        merchantId: smokeMerchant,
        capabilityId,
        status: "CAN_ACCEPT",
        unitPrice: 1,
        setupFee: 0,
        currency: "CAD",
        requiredChanges: [],
        confidence: 1,
        explanation:
          "Synthetic API verification fixture, not a merchant promise.",
      },
    ],
    changePenaltyNodeIds: [],
  });
}

export function assertBoundedPlan(plan, runId) {
  if (
    plan.orderId !== runId ||
    plan.status !== "VALID" ||
    plan.currency !== "CAD" ||
    plan.totalCost !== 1 ||
    plan.nodes.length !== 1 ||
    plan.nodes[0].merchantId !== smokeMerchant ||
    plan.nodes[0].quantity !== 1 ||
    plan.nodes[0].totalCost !== 1 ||
    plan.nodes[0].selectedItem ||
    plan.constraintResults.some((result) => !result.satisfied)
  )
    throw new ShopifyError("SMOKE_PLAN_OUTSIDE_APPROVED_BOUNDS");
}

export async function verifyCreatedResources(transport, state) {
  const actions = Object.values(state.actions);
  assert.equal(actions.length, 3);
  for (const action of actions) {
    assert.equal(action.receipt.status, "SUCCEEDED");
    const tag = actionTag(action.receipt.actionKey);
    if (action.effect.operation === "product") {
      const { product } = await transport.graphql(
        `query SmokeProduct($id: ID!) { product(id: $id) { id status tags variants(first: 2) {
          nodes { id inventoryItem { tracked } } pageInfo { hasNextPage } } } }`,
        { id: action.resource.id },
        z.object({
          product: z.object({
            id: z.string(),
            status: z.literal("DRAFT"),
            tags: z.array(z.string()),
            variants: z.object({
              nodes: z
                .array(
                  z.object({
                    id: z.string(),
                    inventoryItem: z.object({ tracked: z.literal(false) }),
                  }),
                )
                .length(1),
              pageInfo: z.object({ hasNextPage: z.literal(false) }),
            }),
          }),
        }),
      );
      assert.equal(product.id, action.resource.id);
      assert.equal(product.variants.nodes[0].id, action.resource.variantId);
      assert.ok(matchesActionTag(product.tags, action.receipt.actionKey));
    } else {
      const { draftOrder } = await transport.graphql(
        `query SmokeDraft($id: ID!) { draftOrder(id: $id) { id status tags completedAt invoiceSentAt reserveInventoryUntil
          customAttributes { key value } totalQuantityOfLineItems totalPriceSet { presentmentMoney { amount currencyCode } } } }`,
        { id: action.resource.id },
        z.object({
          draftOrder: z.object({
            id: z.string(),
            status: z.literal("OPEN"),
            tags: z.array(z.string()),
            completedAt: z.null(),
            invoiceSentAt: z.null(),
            reserveInventoryUntil: z.null(),
            customAttributes: z.array(
              z.object({ key: z.string(), value: z.string() }),
            ),
            totalQuantityOfLineItems: z.literal(1),
            totalPriceSet: z.object({
              presentmentMoney: z.object({
                amount: z.string(),
                currencyCode: z.literal("CAD"),
              }),
            }),
          }),
        }),
      );
      assert.equal(draftOrder.id, action.resource.id);
      assert.equal(Number(draftOrder.totalPriceSet.presentmentMoney.amount), 1);
      assert.ok(draftOrder.tags.includes(tag));
      const attributes = Object.fromEntries(
        draftOrder.customAttributes.map(({ key, value }) => [key, value]),
      );
      assert.equal(attributes.molecule_action_key, action.receipt.actionKey);
      assert.equal(attributes.molecule_trace_id, action.effect.traceId);
      assert.equal(attributes.molecule_order_id, state.orderId);
    }
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const config = smokeConfig(argv, env);
  for (const [index, domain] of config.stores.entries()) {
    const result = await preflight(
      new ShopifyTransport({ domain, auth: config.auth }),
    );
    console.log(
      JSON.stringify({
        mode: "preflight",
        storeIndex: index + 1,
        auth: "clientId" in config.auth ? "client_credentials" : "access_token",
        ...result,
      }),
    );
    if (!config.execute) continue;
    assertMutationPreflight(result);
    const { repository, close } = connectShopifyRepository(
      config.databaseUrl,
      "shopify-smoke",
    );
    try {
      const existing = await repository.inspect(config.runId);
      const traceId = `${config.runId}-trace`;
      let plan = existing?.targetPlanId
        ? Object.values(existing.plans).find(
            (entry) => entry.plan.planId === existing.targetPlanId,
          )?.plan
        : undefined;
      if (!plan) {
        const response = await fetch(new URL("/solve", config.solverUrl), {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: { "content-type": "application/json" },
          body: JSON.stringify(syntheticSolverInput(config.runId, traceId)),
        });
        if (!response.ok) throw new ShopifyError("SMOKE_SOLVER_FAILED");
        plan = ProductionPlanSchema.parse(await response.json());
      }
      assertBoundedPlan(plan, config.runId);
      let mutationCalls = 0;
      const boundedFetch = async (url, init) => {
        if (String(url).endsWith("/graphql.json")) {
          const body = JSON.parse(String(init?.body));
          if (/^mutation\b/.test(body.query)) {
            if (
              !/^mutation (Composite|CreateDraft)\(/.test(body.query) ||
              ++mutationCalls > 3
            )
              throw new ShopifyError("SMOKE_MUTATION_LIMIT");
            const input = body.variables.input;
            if (body.query.startsWith("mutation Composite")) {
              assert.equal(input.status, "DRAFT");
              assert.equal(input.variants.length, 1);
              assert.equal(input.variants[0].inventoryItem.tracked, false);
            } else {
              assert.equal(input.lineItems.length, 1);
              assert.equal(input.lineItems[0].quantity, 1);
              for (const field of [
                "customerId",
                "email",
                "reserveInventoryUntil",
                "shippingAddress",
                "billingAddress",
              ])
                assert.equal(input[field], undefined);
            }
          }
        }
        return globalThis.fetch(url, init);
      };
      const store = {
        domain,
        auth: config.auth,
        fetch: boundedFetch,
        maxThrottleRetries: 0,
      };
      const options = {
        repository,
        centralStore: store,
        supplierStores: { [smokeMerchant]: store },
        executionEnabled: true,
      };
      const receipt = await new RealShopifyClient(options).commit(
        plan,
        traceId,
      );
      if (
        receipt.actions.length !== 3 ||
        receipt.actions.some((action) => action.status !== "SUCCEEDED")
      )
        throw new ShopifyError(
          `SMOKE_EXECUTION_${receipt.actions.find((action) => action.status !== "SUCCEEDED")?.errorCode ?? "INCOMPLETE"}`,
        );
      const beforeReplay = mutationCalls;
      const replay = await new RealShopifyClient(options).commit(plan, traceId);
      assert.deepEqual(replay, receipt);
      assert.equal(mutationCalls, beforeReplay);
      const persisted = await repository.inspect(config.runId);
      assert.equal(Object.values(persisted.actions).length, 3);
      await verifyCreatedResources(new ShopifyTransport(store), persisted);
      assert.ok(
        (await repository.events(config.runId)).every((event) => event.traceId),
      );
      console.log(
        JSON.stringify({
          mode: "executed",
          runId: config.runId,
          developmentStore: true,
          solver: "real CP-SAT",
          fixture: "synthetic; no operational merchant claims",
          productStatus: "DRAFT",
          draftCount: 2,
          verifiedDraftStatus: "OPEN",
          providerReadbackPassed: true,
          mutationCalls,
          replayMutationCalls: 0,
          durableActionReceipts: 3,
          productId: receipt.compositeProduct.productGid,
          draftIds: [
            receipt.supplierJobs[0].draftOrderGid,
            receipt.customerOrder.draftOrderGid,
          ],
          cleanup:
            "retained; no deletion, completion, payment, email, publication, or inventory reservation",
        }),
      );
    } finally {
      await close();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(
      JSON.stringify({
        status: "FAIL",
        code:
          error instanceof ShopifyError
            ? error.code
            : "SMOKE_VERIFICATION_FAILED",
      }),
    );
    process.exitCode = 1;
  });
