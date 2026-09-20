import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { broadCatalogFixture } from "../../test-fixtures/src/broadCatalog.js";
import { reviewCatalogDelivery } from "./delivery-review.js";

const fixture = broadCatalogFixture();
function changedDelivery(
  change: (records: Record<string, any>[]) => void,
): string {
  const records = fixture.jsonl.split("\n").map((line) => JSON.parse(line));
  change(records);
  return records.map((record) => JSON.stringify(record)).join("\n");
}

describe("catalog delivery intake report", () => {
  it("reports the 100-recipe fixture reproducibly without certifying or importing it", () => {
    const report = reviewCatalogDelivery(fixture.jsonl, "recipe-set");
    expect(report).toEqual(reviewCatalogDelivery(fixture.jsonl, "recipe-set"));
    expect(report).toMatchObject({
      status: "READY_FOR_INTEGRATION_REVIEW",
      structurallyValid: true,
      solverCertified: false,
      databaseImported: false,
      liveExecutionVerified: false,
      recordCounts: { recipe: 100 },
      taxonomy: { additionalLabelsNeeded: 20 },
      possibleDuplicateRecipes: [],
    });
    expect(report.coverage).toHaveLength(12);
    expect(report.coverage.every((row) => row.individualRecipes === 8)).toBe(
      true,
    );
    expect(report.evidence.nonSyntheticRecords).toBe(0);
    expect(report).not.toHaveProperty("records");
  });

  it("requires a representative sample, not simply the first 20 recipes", () => {
    const report = reviewCatalogDelivery(
      changedDelivery((records) => {
        let count = 0;
        for (let i = 0; i < records.length; i++) {
          if (records[i]?.recordType === "recipe" && ++count > 20) {
            records.splice(i--, 1);
          }
        }
        records[0]!.recordCounts.recipe = 20;
      }),
    );
    expect(report.structurallyValid).toBe(true);
    expect(report.status).toBe("INCOMPLETE_SAMPLE_DEFINITIONS");
    expect(report.definitionErrors.join("\n")).toContain(
      "CATEGORY_RECIPE_GAP Gaming",
    );
  });

  it("accepts 20 recipes distributed over all 12 initial categories for integration review", () => {
    const jsonl = changedDelivery((records) => {
      const seen = new Set<string>();
      let kept = 0;
      const ids = new Set<string>();
      for (const record of records) {
        if (record.recordType === "recipe" && !seen.has(record.category)) {
          seen.add(record.category);
          ids.add(record.id);
          kept++;
        }
      }
      for (const record of records) {
        if (
          kept < 20 &&
          record.recordType === "recipe" &&
          !ids.has(record.id)
        ) {
          ids.add(record.id);
          kept++;
        }
      }
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i]?.recordType === "recipe" && !ids.has(records[i]!.id))
          records.splice(i, 1);
      }
      records[0]!.recordCounts.recipe = 20;
    });
    expect(reviewCatalogDelivery(jsonl)).toMatchObject({
      status: "READY_FOR_INTEGRATION_REVIEW",
      recordCounts: { recipe: 20 },
    });
  });

  it("keeps unknown timing visible and identifies the affected binding", () => {
    let factId = "";
    const jsonl = changedDelivery((records) => {
      const fact = records.find(
        (record) => record.recordType === "fact" && record.field === "timing",
      )!;
      factId = fact.id;
      fact.assertion = {
        status: "unknown",
        reason: "Working calendar not supplied",
      };
    });
    const report = reviewCatalogDelivery(jsonl);
    expect(report.status).toBe("REVIEW_REQUIRED");
    expect(report.evidence.unresolvedFacts).toContainEqual({
      recordId: factId,
      field: "timing",
      status: "unknown",
    });
    expect(
      report.exclusions.some((entry) =>
        entry.reasons.includes("timing:unknown"),
      ),
    ).toBe(true);
  });

  it("does not show resolved bindings as ready when record references are invalid", () => {
    const jsonl = changedDelivery((records) => {
      records.find((record) => record.recordType === "variant")!.productId =
        "missing-product";
    });
    const report = reviewCatalogDelivery(jsonl);
    expect(report.status).toBe("INVALID_DELIVERY");
    expect(
      report.coverage.every((row) => row.bindingsWithResolvedEvidence === 0),
    ).toBe(true);
    expect(report.errors.join("\n")).toContain("UNKNOWN_REFERENCE");
  });

  it("flags color-only duplicate recipes while ignoring changed local IDs and prompts", () => {
    const jsonl = changedDelivery((records) => {
      const source = records.find((record) => record.recordType === "recipe")!;
      const duplicate = structuredClone(source);
      duplicate.id = "recipe:color-only-padding";
      duplicate.prompt = "A differently worded request for a blue hoodie";
      duplicate.intent.desiredOutputs[0].attributes.color = "blue";
      duplicate.intent.desiredOutputs[0].quantity = 20;
      duplicate.intent.intentId = "f0000000-0000-4000-8000-000000000001";
      const oldRef = duplicate.intent.desiredOutputs[0].outputId;
      duplicate.intent.desiredOutputs[0].outputId = "different-local-id";
      for (const stage of duplicate.intent.transformations) {
        stage.inputRefs = stage.inputRefs.map((ref: string) =>
          ref === oldRef ? "different-local-id" : ref,
        );
      }
      records.push(duplicate);
      records[0]!.recordCounts.recipe++;
    });
    const report = reviewCatalogDelivery(jsonl);
    expect(report.status).toBe("REVIEW_REQUIRED");
    expect(report.possibleDuplicateRecipes.flat()).toContain(
      "recipe:color-only-padding",
    );
  });

  it("reports operation outages as evidence exclusions", () => {
    const jsonl = changedDelivery((records) => {
      records.find(
        (record) =>
          record.recordType === "resource" && record.kind === "processing",
      )!.availability = { status: "known", value: 0 };
    });
    const report = reviewCatalogDelivery(jsonl);
    expect(report.status).toBe("REVIEW_REQUIRED");
    expect(
      report.exclusions.some((entry) =>
        entry.reasons.some((reason) => reason.endsWith(":unavailable")),
      ),
    ).toBe(true);
  });
});

describe("offline delivery review command", () => {
  const cli = fileURLToPath(
    new URL("./scripts/review-delivery.ts", import.meta.url),
  );
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
      encoding: "utf8",
    });

  it("documents invocation and rejects invalid options", () => {
    expect(
      execFileSync(process.execPath, ["--import", "tsx", cli, "--help"], {
        encoding: "utf8",
      }),
    ).toContain("--profile sample|recipe-set");
    expect(run(["unused.jsonl", "--profile", "unknown"]).status).toBe(2);
  });

  it("writes an actionable report for bad input and never overwrites the source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "catalog-delivery-review-"));
    try {
      const source = join(directory, "delivery.jsonl");
      const output = join(directory, "report.json");
      await writeFile(source, "invalid JSON\n");
      expect(run([source, "--output", output]).status).toBe(1);
      expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
        status: "INVALID_DELIVERY",
        solverCertified: false,
      });
      expect(run([source, "--output", source]).status).toBe(2);
      expect(await readFile(source, "utf8")).toBe("invalid JSON\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
