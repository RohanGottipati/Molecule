// Order 5, step 1: turn a resolved capacity fact into a decision about a job.
//
// Pure. No database, no clock (the caller passes `now`), no network. The
// pipeline's act stage and any bridge to the orchestrator call this same
// function, so the demo and the tests exercise one rule.
//
// The rule is the Order 2 table:
//
//   resolved, enough for the job   -> eligible  (nothing to do)
//   resolved, not enough / zero    -> excluded  (propose a replan without it)
//   unknown, conflicted, stale,    -> blocked   (do NOT exclude on a guess;
//   or not comparable to the job      ask the supplier / a human)
//
// "Excluded" is deliberately reserved for facts we are sure of. Dropping a
// supplier on a conflicted number would turn a data-quality problem into a
// wrong business decision, which is worse than asking.

import { createHash } from "node:crypto";

export const DEFAULT_STALE_AFTER_DAYS = 14;

/**
 * @param {object} input
 * @param {{merchantId:string, capabilityId:string}} input.subject
 * @param {{units:number, windowHours:number}} input.job  e.g. 200 units in 72 h
 * @param {{status:string, value:unknown, unit?:string, observedAt?:string,
 *          effectiveUntil?:string, claimId?:string}|null} input.resolution
 * @param {Date} input.now
 * @param {number} [input.staleAfterDays]
 */
export function decideAvailability({
  subject,
  job,
  resolution,
  now,
  staleAfterDays = DEFAULT_STALE_AFTER_DAYS,
}) {
  if (!(job?.units > 0) || !(job?.windowHours > 0))
    throw new Error("job needs positive units and windowHours");
  if (!(now instanceof Date) || Number.isNaN(now.getTime()))
    throw new Error("now must be a valid Date");

  const base = {
    merchantId: subject.merchantId,
    capabilityId: subject.capabilityId,
    job,
    claimId: resolution?.claimId ?? null,
  };
  const blocked = (code, reason) =>
    finish({
      ...base,
      decision: "blocked",
      action: "ask_supplier_to_confirm",
      code,
      reason,
    });

  if (!resolution || resolution.status === "unknown")
    return blocked("unknown", "No resolved capacity is on record.");
  if (resolution.status === "conflicted")
    return blocked(
      "conflicted",
      "Sources disagree and none wins by a clear margin.",
    );
  if (resolution.status !== "resolved")
    return blocked("bad_status", `Unrecognised status ${resolution.status}.`);

  // A resolved value we cannot compare to the job is not a resolved answer.
  const unit = resolution.unit ?? "units/day";
  const value = Number(resolution.value);
  if (unit !== "units/day" || !Number.isFinite(value) || value < 0)
    return blocked(
      "not_comparable",
      `Resolved value ${JSON.stringify(resolution.value)} ${unit} is not a units/day rate.`,
    );

  const observed = resolution.observedAt
    ? new Date(resolution.observedAt)
    : null;
  if (!observed || Number.isNaN(observed.getTime()))
    return blocked("no_timestamp", "The resolved value has no source date.");
  const ageDays = (now.getTime() - observed.getTime()) / 86_400_000;
  if (ageDays > staleAfterDays)
    return blocked(
      "stale",
      `The resolved value is ${Math.floor(ageDays)} days old (limit ${staleAfterDays}).`,
    );

  if (resolution.effectiveUntil) {
    const until = new Date(resolution.effectiveUntil);
    const jobEnd = new Date(now.getTime() + job.windowHours * 3_600_000);
    if (!Number.isNaN(until.getTime()) && until < jobEnd)
      return blocked(
        "window_ends_early",
        "The stated capacity stops applying before the job window ends.",
      );
  }

  // Calendar days: the source says "per day" and does not say working days.
  // That assumption is recorded on the result rather than hidden.
  const inWindow = value * (job.windowHours / 24);
  const evidence = {
    ratePerDay: value,
    unitsInWindow: inWindow,
    assumes: "calendar days",
  };
  if (inWindow >= job.units)
    return finish({
      ...base,
      decision: "eligible",
      action: "none",
      code: "sufficient",
      reason: `${value}/day covers ${job.units} in ${job.windowHours}h (${inWindow} available).`,
      evidence,
    });
  return finish({
    ...base,
    decision: "excluded",
    action: "request_replan",
    code: value === 0 ? "zero_capacity" : "insufficient",
    reason: `${value}/day gives ${inWindow} in ${job.windowHours}h; the job needs ${job.units}.`,
    evidence,
  });
}

/**
 * The key identifies the decision, not the moment it was made: the same
 * supplier, capability, job and winning claim always produce the same key, so
 * re-running the pipeline cannot queue (or later execute) the action twice.
 */
function finish(result) {
  const key = createHash("sha256")
    .update(
      [
        result.merchantId,
        result.capabilityId,
        result.job.units,
        result.job.windowHours,
        result.claimId ?? "none",
        result.decision,
        result.code,
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 24);
  return { ...result, actionKey: `availability:${key}` };
}
