import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BackboardVerifyError,
  SMOKE_FIXTURE,
  assertCanonicalQuote,
  classifyBackboardCall,
  JSON_PROBE_MESSAGE,
  smokeConfig,
  syntheticCapability,
  syntheticQuoteRequest,
} from "./verify-backboard.ts";

const env = {
  BACKBOARD_API_KEY: "synthetic-key",
  BACKBOARD_SMOKE_DATABASE_URL:
    "postgresql://test:test@127.0.0.1:5432/molecule_backboard_smoke_test",
};
const args = ["--execute", "--run-id=molecule-smoke-backboard-unit-test"];

test("defaults to read-only catalog inspection", () => {
  const config = smokeConfig([], env);
  assert.equal(config.execute, false);
  assert.equal(config.apiKey, "synthetic-key");
});

for (const denied of [
  ["--execute"],
  ["--execute", "--run-id=ordinary-order"],
  ["--execute", "--run-id=molecule-smoke-unit-test"],
  ["--pay"],
])
  test(`rejects unsafe execution arguments: ${denied.join(" ")}`, () => {
    assert.throws(
      () => smokeConfig(denied, env),
      (error: unknown) => error instanceof BackboardVerifyError,
    );
  });

for (const url of [
  "postgresql://test:test@remote.example/molecule_backboard_smoke_test",
  "postgresql://test:test@127.0.0.1/production",
  "postgresql://test:test@127.0.0.1/molecule_backboard_smoke_test?host=remote.example",
])
  test(`rejects non-isolated database destinations: ${url}`, () => {
    assert.throws(
      () => smokeConfig(args, { ...env, BACKBOARD_SMOKE_DATABASE_URL: url }),
      (error: unknown) =>
        error instanceof BackboardVerifyError &&
        error.code === "SMOKE_LOCAL_DATABASE_REQUIRED",
    );
  });

test("permits the exact isolated execute destination", () => {
  const config = smokeConfig(args, env);
  assert.equal(config.execute, true);
  assert.equal(config.runId, "molecule-smoke-backboard-unit-test");
});

test("classifies documented provider paths without treating reads as mutations", () => {
  assert.equal(
    classifyBackboardCall(
      "GET",
      "https://app.backboard.io/api/models?limit=200",
    ),
    "models",
  );
  assert.equal(
    classifyBackboardCall("POST", "https://app.backboard.io/api/assistants"),
    "createAssistant",
  );
  assert.equal(
    classifyBackboardCall(
      "POST",
      "https://app.backboard.io/api/assistants/abc/documents",
    ),
    "uploadDocument",
  );
  assert.equal(
    classifyBackboardCall(
      "POST",
      "https://app.backboard.io/api/assistants/abc/threads",
    ),
    "createThread",
  );
  assert.equal(
    classifyBackboardCall(
      "POST",
      "https://app.backboard.io/api/assistants/abc/memories",
    ),
    "addMemory",
  );
  assert.equal(
    classifyBackboardCall(
      "GET",
      "https://app.backboard.io/api/assistants/abc/memories?page_size=100",
    ),
    "listMemory",
  );
  assert.equal(
    classifyBackboardCall(
      "POST",
      "https://app.backboard.io/api/threads/messages",
    ),
    "sendMessage",
  );
  assert.equal(
    classifyBackboardCall(
      "POST",
      "https://app.backboard.io/api/threads/tool-outputs",
    ),
    "submitToolOutputs",
  );
});

test("JSON protocol probe stays on a document-free synthetic assistant", () => {
  assert.match(JSON_PROBE_MESSAGE, /\{"ok":true\}/);
  assert.equal(
    `${smokeConfig(args, env).runId}-json`,
    "molecule-smoke-backboard-unit-test-json",
  );
});

test("the synthetic fixture cannot promote remembered prices into a canonical accept", () => {
  const merchantId = "molecule-smoke-backboard-unit-test";
  const capability = syntheticCapability(merchantId);
  const request = syntheticQuoteRequest(merchantId, capability.capabilityId);
  assert.deepEqual(capability.sourceClaimIds, []);
  assert.equal(capability.capacity.available, 300);
  assert.equal(request.hold, false);
  assert.equal(request.quantity, 1);
  assert.match(SMOKE_FIXTURE.STALE_DOCUMENT, /CAD 0\.01/);
  assert.match(SMOKE_FIXTURE.STALE_NOTE, /CAD 0\.01/);
  assert.equal(capability.pricing.unitPrice, 12);
  assert.throws(() =>
    assertCanonicalQuote(
      {
        merchantId,
        capabilityId: capability.capabilityId,
        status: "CAN_ACCEPT",
        currency: "CAD",
        unitPrice: 0.01,
        setupFee: 0,
        confidence: 1,
        explanation: "Remembered price",
      },
      request,
    ),
  );
});
