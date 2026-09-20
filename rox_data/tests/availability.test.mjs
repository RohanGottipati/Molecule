import assert from "node:assert/strict";
import test from "node:test";
import { decideAvailability } from "../pipeline/availability.mjs";

const now = new Date("2026-09-19T12:00:00Z");
const subject = { merchantId: "stitch-works", capabilityId: "cap-embroidery" };
const job = { units: 200, windowHours: 72 };
const good = {
  status: "resolved",
  value: 80,
  unit: "units/day",
  observedAt: "2026-09-18T09:00:00Z",
  claimId: "claim-1",
};
const decide = (resolution, extra = {}) =>
  decideAvailability({ subject, job, resolution, now, ...extra });

test("enough capacity for the window is eligible and needs no action", () => {
  const r = decide(good); // 80 * 3 = 240 >= 200
  assert.equal(r.decision, "eligible");
  assert.equal(r.action, "none");
});

test("exactly enough is eligible; one unit short is excluded", () => {
  assert.equal(
    decide({ ...good, value: 200 / 3 + 0.001 }).decision,
    "eligible",
  );
  assert.equal(decide({ ...good, value: 66 }).decision, "excluded"); // 198
});

test("a resolved shortfall excludes and asks for a replan", () => {
  const r = decide({ ...good, value: 40 });
  assert.equal(r.decision, "excluded");
  assert.equal(r.action, "request_replan");
  assert.equal(r.code, "insufficient");
});

test("resolved zero is a real answer: excluded, not blocked", () => {
  const r = decide({ ...good, value: 0 });
  assert.equal(r.decision, "excluded");
  assert.equal(r.code, "zero_capacity");
});

test("unknown, missing and conflicted facts block instead of excluding", () => {
  for (const res of [
    null,
    { status: "unknown" },
    { ...good, status: "conflicted" },
  ]) {
    const r = decide(res);
    assert.equal(r.decision, "blocked");
    assert.equal(r.action, "ask_supplier_to_confirm");
  }
});

test("a stale resolved value blocks", () => {
  const r = decide({ ...good, observedAt: "2026-08-01T00:00:00Z" });
  assert.equal(r.decision, "blocked");
  assert.equal(r.code, "stale");
});

test("staleness limit is configurable", () => {
  const old = { ...good, observedAt: "2026-09-10T12:00:00Z" };
  assert.equal(decide(old).decision, "eligible");
  assert.equal(decide(old, { staleAfterDays: 5 }).code, "stale");
});

test("no source date blocks", () => {
  assert.equal(decide({ ...good, observedAt: undefined }).code, "no_timestamp");
});

test("a value that is not a units/day rate blocks", () => {
  assert.equal(decide({ ...good, unit: "units" }).code, "not_comparable");
  assert.equal(decide({ ...good, value: "about 80" }).code, "not_comparable");
  assert.equal(decide({ ...good, value: -5 }).code, "not_comparable");
});

test("capacity that expires inside the job window blocks", () => {
  const r = decide({ ...good, effectiveUntil: "2026-09-20T00:00:00Z" });
  assert.equal(r.code, "window_ends_early");
  assert.equal(
    decide({ ...good, effectiveUntil: "2026-12-01T00:00:00Z" }).decision,
    "eligible",
  );
});

test("the action key is deterministic and tied to the evidence", () => {
  const a = decide({ ...good, value: 40 });
  const b = decide({ ...good, value: 40 });
  assert.equal(a.actionKey, b.actionKey);
  assert.notEqual(
    a.actionKey,
    decide({ ...good, value: 40, claimId: "claim-2" }).actionKey,
  );
  assert.notEqual(a.actionKey, decide(good).actionKey);
  assert.notEqual(
    a.actionKey,
    decideAvailability({
      subject,
      job: { units: 300, windowHours: 72 },
      resolution: { ...good, value: 40 },
      now,
    }).actionKey,
  );
});

test("invalid jobs and clocks are refused rather than guessed", () => {
  assert.throws(() =>
    decideAvailability({
      subject,
      job: { units: 0, windowHours: 72 },
      resolution: good,
      now,
    }),
  );
  assert.throws(() =>
    decideAvailability({ subject, job, resolution: good, now: "today" }),
  );
});

test("the calendar-day assumption is recorded on the result", () => {
  assert.equal(decide(good).evidence.assumes, "calendar days");
});
