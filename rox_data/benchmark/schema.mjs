import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export const BENCHMARK_VERSION = "apparel-capacity-benchmark-v1";
export const SCENARIO_ID = "stitchworks-embroidery-200-in-72h";

const SOURCE_KINDS = new Set([
  "email",
  "message",
  "spreadsheet",
  "portal",
  "api",
]);
const MEDIA_TYPES = new Set([
  "message/rfc822",
  "text/plain",
  "text/csv",
  "application/json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const STATUSES = new Set(["known", "unknown"]);
const AVAILABILITY = new Set(["available", "unavailable", "unknown"]);
const CAPACITY_STATUSES = new Set(["exact", "range", "qualified", "unknown"]);
const PERIODS = new Set(["hour", "day", "week", "absolute", "unknown"]);
const HANDLING = new Set([
  "claim",
  "quarantine",
  "needs_review",
  "no_relevant_fact",
]);

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(path, "expected an object");
  return value;
}

function exactKeys(value, keys, path) {
  object(value, path);
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(
      path,
      `expected keys ${expected.join(", ")}; received ${actual.join(", ")}`,
    );
}

function text(value, path) {
  if (typeof value !== "string" || !value.trim())
    fail(path, "expected non-empty text");
}

function nullableText(value, path) {
  if (value !== null) text(value, path);
}

function iso(value, path) {
  text(value, path);
  if (!Number.isFinite(Date.parse(value)))
    fail(path, "expected an ISO date-time");
}

function nullableIso(value, path) {
  if (value !== null) iso(value, path);
}

function finitePositive(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    fail(path, "expected a positive finite number");
}

function nullablePositive(value, path) {
  if (value !== null) finitePositive(value, path);
}

function enumValue(value, allowed, path) {
  if (!allowed.has(value))
    fail(path, `expected one of ${[...allowed].join(", ")}`);
}

function identity(value, path) {
  exactKeys(value, ["status", "key"], path);
  enumValue(value.status, STATUSES, `${path}.status`);
  if (value.status === "known") text(value.key, `${path}.key`);
  else if (value.key !== null)
    fail(`${path}.key`, "must be null when status is unknown");
}

function capacity(value, path) {
  exactKeys(
    value,
    ["status", "value", "minimum", "maximum", "unit", "qualifier"],
    path,
  );
  enumValue(value.status, CAPACITY_STATUSES, `${path}.status`);
  nullablePositive(value.value, `${path}.value`);
  nullablePositive(value.minimum, `${path}.minimum`);
  nullablePositive(value.maximum, `${path}.maximum`);
  nullableText(value.unit, `${path}.unit`);
  nullableText(value.qualifier, `${path}.qualifier`);
  if (value.status === "unknown") {
    if (
      [
        value.value,
        value.minimum,
        value.maximum,
        value.unit,
        value.qualifier,
      ].some((v) => v !== null)
    )
      fail(path, "unknown capacity cannot contain inferred values or units");
  } else if (value.status === "range") {
    finitePositive(value.minimum, `${path}.minimum`);
    finitePositive(value.maximum, `${path}.maximum`);
    if (value.maximum < value.minimum)
      fail(path, "maximum must be at least minimum");
    if (value.value !== null)
      fail(`${path}.value`, "range labels use minimum and maximum");
    text(value.unit, `${path}.unit`);
  } else {
    finitePositive(value.value, `${path}.value`);
    if (value.minimum !== null || value.maximum !== null)
      fail(path, "exact and qualified labels use value, not minimum/maximum");
    text(value.unit, `${path}.unit`);
    if (value.status === "qualified")
      text(value.qualifier, `${path}.qualifier`);
    if (value.status === "exact" && value.qualifier !== null)
      fail(`${path}.qualifier`, "exact capacity cannot have a qualifier");
  }
}

function window(value, path) {
  exactKeys(value, ["status", "start", "end"], path);
  enumValue(value.status, STATUSES, `${path}.status`);
  nullableIso(value.start, `${path}.start`);
  nullableIso(value.end, `${path}.end`);
  if (
    value.status === "unknown" &&
    (value.start !== null || value.end !== null)
  )
    fail(path, "unknown effective window cannot contain inferred dates");
  if (value.status === "known" && value.start === null && value.end === null)
    fail(path, "known effective window needs a start or end");
  if (
    value.start &&
    value.end &&
    Date.parse(value.end) < Date.parse(value.start)
  )
    fail(path, "end precedes start");
}

function label(value, path, adjudicated) {
  exactKeys(
    value,
    [
      "documentId",
      "relevant",
      "supplier",
      "capability",
      "availability",
      "capacity",
      "period",
      "effectiveWindow",
      "observedAt",
      "evidence",
      "expectedHandling",
      "notes",
      "adjudication",
    ],
    path,
  );
  text(value.documentId, `${path}.documentId`);
  if (typeof value.relevant !== "boolean")
    fail(`${path}.relevant`, "expected boolean");
  identity(value.supplier, `${path}.supplier`);
  identity(value.capability, `${path}.capability`);
  enumValue(value.availability, AVAILABILITY, `${path}.availability`);
  capacity(value.capacity, `${path}.capacity`);
  enumValue(value.period, PERIODS, `${path}.period`);
  window(value.effectiveWindow, `${path}.effectiveWindow`);
  nullableIso(value.observedAt, `${path}.observedAt`);
  if (!Array.isArray(value.evidence))
    fail(`${path}.evidence`, "expected an array");
  value.evidence.forEach((entry, index) => {
    const evidencePath = `${path}.evidence[${index}]`;
    exactKeys(entry, ["text", "locator"], evidencePath);
    text(entry.text, `${evidencePath}.text`);
    text(entry.locator, `${evidencePath}.locator`);
  });
  enumValue(value.expectedHandling, HANDLING, `${path}.expectedHandling`);
  nullableText(value.notes, `${path}.notes`);

  if (!value.relevant) {
    if (value.expectedHandling !== "no_relevant_fact")
      fail(path, "irrelevant documents must use no_relevant_fact");
    if (
      value.supplier.status !== "unknown" ||
      value.capability.status !== "unknown" ||
      value.availability !== "unknown" ||
      value.capacity.status !== "unknown" ||
      value.period !== "unknown" ||
      value.effectiveWindow.status !== "unknown" ||
      value.observedAt !== null ||
      value.evidence.length
    )
      fail(path, "irrelevant documents cannot contain inferred facts");
  }
  if (value.expectedHandling === "claim") {
    if (
      value.supplier.status !== "known" ||
      value.capability.status !== "known"
    )
      fail(path, "a claim requires known supplier and capability identities");
    if (!value.evidence.length)
      fail(path, "a claim requires supporting evidence");
    if (value.availability === "unknown" && value.capacity.status === "unknown")
      fail(
        path,
        "a claim requires an explicit availability or capacity statement",
      );
  }
  if (
    value.capacity.status !== "unknown" &&
    value.period === "unknown" &&
    value.expectedHandling === "claim"
  )
    fail(
      path,
      "capacity without a stated period must not be promoted as a claim",
    );

  if (adjudicated) {
    exactKeys(
      value.adjudication,
      ["reviewers", "notes"],
      `${path}.adjudication`,
    );
    if (
      !Array.isArray(value.adjudication.reviewers) ||
      value.adjudication.reviewers.length !== 2
    )
      fail(
        `${path}.adjudication.reviewers`,
        "expected exactly two reviewer IDs",
      );
    value.adjudication.reviewers.forEach((reviewer, index) =>
      text(reviewer, `${path}.adjudication.reviewers[${index}]`),
    );
    if (new Set(value.adjudication.reviewers).size !== 2)
      fail(`${path}.adjudication.reviewers`, "reviewers must be distinct");
    nullableText(value.adjudication.notes, `${path}.adjudication.notes`);
  } else if (value.adjudication !== null) {
    fail(
      `${path}.adjudication`,
      "reviewer labels must be independent, not adjudicated",
    );
  }
}

export function validateManifest(manifest) {
  exactKeys(
    manifest,
    [
      "version",
      "scenarioId",
      "classification",
      "createdAt",
      "supplierKey",
      "capabilityKey",
      "documents",
    ],
    "manifest",
  );
  if (manifest.version !== BENCHMARK_VERSION)
    fail("manifest.version", `expected ${BENCHMARK_VERSION}`);
  if (manifest.scenarioId !== SCENARIO_ID)
    fail("manifest.scenarioId", `expected ${SCENARIO_ID}`);
  if (manifest.classification !== "real_authorized")
    fail(
      "manifest.classification",
      "expected real_authorized; synthetic data belongs in a separate benchmark",
    );
  iso(manifest.createdAt, "manifest.createdAt");
  text(manifest.supplierKey, "manifest.supplierKey");
  text(manifest.capabilityKey, "manifest.capabilityKey");
  if (!Array.isArray(manifest.documents) || !manifest.documents.length)
    fail(
      "manifest.documents",
      "expected at least one authorized real document",
    );
  const ids = new Set();
  const checksums = new Set();
  manifest.documents.forEach((document, index) => {
    const path = `manifest.documents[${index}]`;
    exactKeys(
      document,
      [
        "documentId",
        "path",
        "sha256",
        "byteLength",
        "mediaType",
        "sourceKind",
        "chainId",
        "authorization",
        "deidentification",
      ],
      path,
    );
    text(document.documentId, `${path}.documentId`);
    if (ids.has(document.documentId))
      fail(`${path}.documentId`, "duplicate document ID");
    ids.add(document.documentId);
    text(document.path, `${path}.path`);
    if (
      isAbsolute(document.path) ||
      document.path.split(/[\\/]/).includes("..")
    )
      fail(
        `${path}.path`,
        "must be a relative path contained by the private raw directory",
      );
    if (!/^[a-f0-9]{64}$/.test(document.sha256))
      fail(`${path}.sha256`, "expected lowercase SHA-256");
    if (checksums.has(document.sha256))
      fail(`${path}.sha256`, "duplicate content; keep one immutable document");
    checksums.add(document.sha256);
    if (!Number.isSafeInteger(document.byteLength) || document.byteLength <= 0)
      fail(`${path}.byteLength`, "expected a positive integer");
    enumValue(document.mediaType, MEDIA_TYPES, `${path}.mediaType`);
    enumValue(document.sourceKind, SOURCE_KINDS, `${path}.sourceKind`);
    text(document.chainId, `${path}.chainId`);
    exactKeys(
      document.authorization,
      ["authorized", "basis", "confirmedBy", "confirmedAt"],
      `${path}.authorization`,
    );
    if (document.authorization.authorized !== true)
      fail(`${path}.authorization.authorized`, "must be explicitly true");
    text(document.authorization.basis, `${path}.authorization.basis`);
    text(
      document.authorization.confirmedBy,
      `${path}.authorization.confirmedBy`,
    );
    iso(
      document.authorization.confirmedAt,
      `${path}.authorization.confirmedAt`,
    );
    exactKeys(
      document.deidentification,
      ["status", "checkedBy"],
      `${path}.deidentification`,
    );
    if (
      !new Set(["complete", "not_required"]).has(
        document.deidentification.status,
      )
    )
      fail(
        `${path}.deidentification.status`,
        "expected complete or not_required",
      );
    text(
      document.deidentification.checkedBy,
      `${path}.deidentification.checkedBy`,
    );
  });
  return manifest;
}

export function validateLabelSet(labelSet, { adjudicated = false } = {}) {
  exactKeys(
    labelSet,
    ["version", "scenarioId", "reviewerId", "completedAt", "labels"],
    "labelSet",
  );
  if (labelSet.version !== BENCHMARK_VERSION)
    fail("labelSet.version", `expected ${BENCHMARK_VERSION}`);
  if (labelSet.scenarioId !== SCENARIO_ID)
    fail("labelSet.scenarioId", `expected ${SCENARIO_ID}`);
  text(labelSet.reviewerId, "labelSet.reviewerId");
  iso(labelSet.completedAt, "labelSet.completedAt");
  if (!Array.isArray(labelSet.labels))
    fail("labelSet.labels", "expected an array");
  const ids = new Set();
  labelSet.labels.forEach((entry, index) => {
    label(entry, `labelSet.labels[${index}]`, adjudicated);
    if (ids.has(entry.documentId))
      fail(`labelSet.labels[${index}].documentId`, "duplicate document ID");
    ids.add(entry.documentId);
  });
  return labelSet;
}

function stableLabel(labelValue) {
  const { notes: _notes, adjudication: _adjudication, ...scored } = labelValue;
  return JSON.stringify(scored);
}

export function validateBundle({ manifest, reviewers, adjudicated }) {
  validateManifest(manifest);
  if (!Array.isArray(reviewers) || reviewers.length !== 2)
    fail("reviewers", "expected exactly two independent label sets");
  reviewers.forEach((reviewer) => validateLabelSet(reviewer));
  validateLabelSet(adjudicated, { adjudicated: true });
  const reviewerIds = reviewers.map((reviewer) => reviewer.reviewerId);
  if (new Set(reviewerIds).size !== 2)
    fail("reviewers", "reviewer IDs must be distinct");
  if (reviewerIds.includes(adjudicated.reviewerId))
    fail(
      "adjudicated.reviewerId",
      "adjudication must have its own reviewer ID",
    );
  const expectedIds = [
    ...manifest.documents.map((document) => document.documentId),
  ].sort();
  for (const [name, labelSet] of [
    ...reviewers.map((value, index) => [`reviewer-${index + 1}`, value]),
    ["adjudicated", adjudicated],
  ]) {
    const actualIds = [
      ...labelSet.labels.map((labelValue) => labelValue.documentId),
    ].sort();
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds))
      fail(name, "must label every selected document exactly once");
  }
  const byReviewer = reviewers.map(
    (reviewer) =>
      new Map(reviewer.labels.map((entry) => [entry.documentId, entry])),
  );
  let disagreements = 0;
  for (const finalLabel of adjudicated.labels) {
    const first = byReviewer[0].get(finalLabel.documentId);
    const second = byReviewer[1].get(finalLabel.documentId);
    const disagreed = stableLabel(first) !== stableLabel(second);
    if (disagreed) disagreements += 1;
    const declared = [...finalLabel.adjudication.reviewers].sort();
    if (JSON.stringify(declared) !== JSON.stringify([...reviewerIds].sort()))
      fail(
        `adjudicated.${finalLabel.documentId}`,
        "adjudication reviewer IDs do not match the independent reviewers",
      );
    if (disagreed && !finalLabel.adjudication.notes)
      fail(
        `adjudicated.${finalLabel.documentId}`,
        "reviewer disagreement requires adjudication notes",
      );
  }
  return {
    documents: expectedIds.length,
    reviewers: reviewerIds,
    disagreements,
  };
}

export async function verifyRawFiles(manifest, rawDirectory) {
  validateManifest(manifest);
  const root = resolve(rawDirectory);
  const canonicalRoot = await realpath(root);
  for (const document of manifest.documents) {
    const target = resolve(root, document.path);
    const canonicalTarget = await realpath(target);
    const contained = relative(canonicalRoot, canonicalTarget);
    if (!contained || contained.startsWith("..") || isAbsolute(contained))
      fail(
        `document ${document.documentId}`,
        "path escapes the private raw directory",
      );
    const stats = await lstat(target);
    if (!stats.isFile() || stats.isSymbolicLink())
      fail(
        `document ${document.documentId}`,
        "expected a regular file, not a link",
      );
    if (stats.size !== document.byteLength)
      fail(
        `document ${document.documentId}`,
        "byte length does not match the manifest",
      );
    const checksum = createHash("sha256")
      .update(await readFile(target))
      .digest("hex");
    if (checksum !== document.sha256)
      fail(
        `document ${document.documentId}`,
        "checksum does not match the immutable source",
      );
  }
  return { verified: manifest.documents.length };
}
