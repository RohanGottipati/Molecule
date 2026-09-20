import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BENCHMARK_VERSION,
  SCENARIO_ID,
  validateBundle,
  validateLabelSet,
  verifyRawFiles,
} from "../benchmark/schema.mjs";

const source = "StitchWorks can take 200 pieces per day.";
const checksum = createHash("sha256").update(source).digest("hex");

function manifest() {
  return {
    version: BENCHMARK_VERSION,
    scenarioId: SCENARIO_ID,
    classification: "real_authorized",
    createdAt: "2026-09-20T00:00:00.000Z",
    supplierKey: "supplier-001",
    capabilityKey: "capability-embroidery",
    documents: [
      {
        documentId: "doc-001",
        path: "doc-001.txt",
        sha256: checksum,
        byteLength: Buffer.byteLength(source),
        mediaType: "text/plain",
        sourceKind: "message",
        chainId: "chain-001",
        authorization: {
          authorized: true,
          basis: "Owner confirmed use for this private evaluation",
          confirmedBy: "data-owner",
          confirmedAt: "2026-09-20T00:00:00.000Z",
        },
        deidentification: { status: "complete", checkedBy: "data-owner" },
      },
    ],
  };
}

function labelSet(reviewerId, value = 200) {
  return {
    version: BENCHMARK_VERSION,
    scenarioId: SCENARIO_ID,
    reviewerId,
    completedAt: "2026-09-20T00:00:00.000Z",
    labels: [
      {
        documentId: "doc-001",
        relevant: true,
        supplier: { status: "known", key: "supplier-001" },
        capability: { status: "known", key: "capability-embroidery" },
        availability: "available",
        capacity: {
          status: "exact",
          value,
          minimum: null,
          maximum: null,
          unit: "pieces",
          qualifier: null,
        },
        period: "day",
        effectiveWindow: { status: "unknown", start: null, end: null },
        observedAt: null,
        evidence: [
          { text: `${value} pieces per day`, locator: "message body" },
        ],
        expectedHandling: "claim",
        notes: null,
        adjudication: null,
      },
    ],
  };
}

function adjudicated(reviewers, notes = null) {
  const final = labelSet("adjudicator");
  final.labels[0].adjudication = { reviewers, notes };
  return final;
}

test("accepts a complete authorized and independently reviewed bundle", () => {
  const result = validateBundle({
    manifest: manifest(),
    reviewers: [labelSet("reviewer-a"), labelSet("reviewer-b")],
    adjudicated: adjudicated(["reviewer-a", "reviewer-b"]),
  });
  assert.deepEqual(result, {
    documents: 1,
    reviewers: ["reviewer-a", "reviewer-b"],
    disagreements: 0,
  });
});

test("requires disagreement notes and two distinct reviewers", () => {
  assert.throws(
    () =>
      validateBundle({
        manifest: manifest(),
        reviewers: [labelSet("reviewer-a"), labelSet("reviewer-b", 100)],
        adjudicated: adjudicated(["reviewer-a", "reviewer-b"]),
      }),
    /disagreement requires adjudication notes/,
  );
  assert.throws(
    () =>
      validateBundle({
        manifest: manifest(),
        reviewers: [labelSet("same"), labelSet("same")],
        adjudicated: adjudicated(["same", "same"]),
      }),
    /reviewer IDs must be distinct|reviewers must be distinct/,
  );
});

test("does not allow missing periods to become claims", () => {
  const labels = labelSet("reviewer-a");
  labels.labels[0].period = "unknown";
  assert.throws(
    () => validateLabelSet(labels),
    /must not be promoted as a claim/,
  );
});

test("irrelevant documents remain explicit empty labels", () => {
  const labels = labelSet("reviewer-a");
  labels.labels[0] = {
    documentId: "doc-001",
    relevant: false,
    supplier: { status: "unknown", key: null },
    capability: { status: "unknown", key: null },
    availability: "unknown",
    capacity: {
      status: "unknown",
      value: null,
      minimum: null,
      maximum: null,
      unit: null,
      qualifier: null,
    },
    period: "unknown",
    effectiveWindow: { status: "unknown", start: null, end: null },
    observedAt: null,
    evidence: [],
    expectedHandling: "no_relevant_fact",
    notes: null,
    adjudication: null,
  };
  assert.doesNotThrow(() => validateLabelSet(labels));
});

test("verifies immutable raw files and rejects changed bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rox-order3-"));
  const raw = join(directory, "raw");
  await mkdir(raw);
  try {
    await writeFile(join(raw, "doc-001.txt"), source);
    assert.deepEqual(await verifyRawFiles(manifest(), raw), { verified: 1 });
    await writeFile(join(raw, "doc-001.txt"), `${source} changed`);
    await assert.rejects(
      () => verifyRawFiles(manifest(), raw),
      /byte length does not match|checksum does not match/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects path traversal before reading a raw file", async () => {
  const bad = manifest();
  bad.documents[0].path = "../doc-001.txt";
  await assert.rejects(
    () => verifyRawFiles(bad, "/private/tmp"),
    /relative path/,
  );
});

test("rejects an intermediate directory link that escapes the raw directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rox-order3-link-"));
  const raw = join(directory, "raw");
  const outside = join(directory, "outside");
  await mkdir(raw);
  await mkdir(outside);
  try {
    await writeFile(join(outside, "doc-001.txt"), source);
    await symlink(outside, join(raw, "linked"));
    const bad = manifest();
    bad.documents[0].path = "linked/doc-001.txt";
    await assert.rejects(
      () => verifyRawFiles(bad, raw),
      /escapes the private raw directory/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
