import test from "node:test";
import assert from "node:assert/strict";
import { baseline } from "../pipeline/baseline.mjs";
import { extract } from "../pipeline/extract.mjs";

function mockDatabase() {
  const calls = [];
  const db = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes("as type, count"))
        return { rows: [{ type: "tickets", n: 1 }] };
      if (sql.includes("returning cost_usd"))
        return { rows: [{ cost_usd: 0, budget_usd: 50 }] };
      if (sql.includes("select artifact_id, source_path"))
        return {
          rows: [
            {
              artifact_id: "empty",
              source_path: "tickets/a",
              content_text: "Thanks for your help.",
              chaos_profile: {},
            },
          ],
        };
      return { rows: [] };
    },
  };
  return { db, calls };
}
test("regex baseline records empty documents and declares population first", async () => {
  const { db, calls } = mockDatabase();
  const r = await baseline(db, { runId: "r", batchId: "b", traceId: "trace" });
  assert.equal(r.candidates, 0);
  const population = calls.find(
    (c) =>
      c.sql.includes("insert into molecule_events") &&
      c.params.includes("rox.evaluation.population"),
  );
  assert.deepEqual(population.params.at(-1).artifactIds, ["empty"]);
  const attempt = calls.find((c) =>
    c.sql.includes("insert into rox_artifact_attempts"),
  );
  assert.deepEqual(attempt.params, [
    "r",
    "empty",
    0,
    false,
    "regex-baseline-v1",
  ]);
});
test("failed provider call is included in durable selection before extraction", async () => {
  const { db, calls } = mockDatabase();
  let providerCalled = false;
  const provider = {
    responses: {
      create: async () => {
        assert(
          calls.some((c) => c.params.includes("rox.evaluation.population")),
        );
        providerCalled = true;
        throw new Error("synthetic provider failure");
      },
    },
  };
  const r = await extract(db, {
    runId: "r",
    batchId: "b",
    traceId: "trace",
    client: provider,
  });
  assert(providerCalled);
  assert.equal(r.errors, 1);
  assert(
    !calls.some((c) => c.sql.includes("insert into rox_artifact_attempts")),
  );
  assert(calls.some((c) => c.params.includes("rox.evaluation.population")));
});

test("prompt migration selects old artifacts and records a current-version attempt", async () => {
  const { db, calls } = mockDatabase();
  const provider = {
    responses: {
      create: async () => ({
        output_text: JSON.stringify({
          merchantHint: "",
          documentDate: "",
          injectionDetected: false,
          injectionNote: "",
          candidates: [],
        }),
        usage: {},
      }),
    },
  };
  await extract(db, {
    runId: "r",
    batchId: "b",
    traceId: "trace",
    sourcePromptVersion: "rox-extract-v3",
    client: provider,
  });
  const selection = calls.find((c) => c.sql.includes("as type, count"));
  assert.match(selection.sql, /old\.prompt_version = \$3/);
  assert.match(selection.sql, /current\.prompt_version = \$4/);
  assert.deepEqual(selection.params, [
    "b",
    "r",
    "rox-extract-v3",
    "rox-extract-v4",
  ]);
  const attempt = calls.find((c) =>
    c.sql.includes("insert into rox_artifact_attempts"),
  );
  assert.deepEqual(attempt.params, ["r", "empty", 0, false, "rox-extract-v4"]);
});
