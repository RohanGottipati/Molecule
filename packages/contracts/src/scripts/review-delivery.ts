/// <reference types="node" />
import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import {
  reviewCatalogDelivery,
  type DeliveryReviewProfile,
} from "../delivery-review.js";

const usage =
  "Usage: node --import tsx packages/contracts/src/scripts/review-delivery.ts INPUT.jsonl [--profile sample|recipe-set] [--output NEW_REPORT.json]";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return 0;
  }
  const input = args.shift();
  if (!input || input.startsWith("--")) throw new Error(usage);
  let profile: DeliveryReviewProfile = "sample";
  let output: string | undefined;
  const seen = new Set<string>();
  while (args.length) {
    const flag = args.shift()!;
    const value = args.shift();
    if (!value || value.startsWith("--") || seen.has(flag))
      throw new Error(usage);
    seen.add(flag);
    if (flag === "--profile" && (value === "sample" || value === "recipe-set"))
      profile = value;
    else if (flag === "--output") output = value;
    else throw new Error(usage);
  }
  const file = await open(input, "r");
  let jsonl: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 256 * 1024 * 1024) {
      throw new Error(
        "Expected a regular JSONL file of at most 256 MiB; use a self-contained sample with all referenced records.",
      );
    }
    jsonl = await file.readFile("utf8");
  } finally {
    await file.close();
  }
  const report = reviewCatalogDelivery(jsonl, profile);
  const encoded = `${JSON.stringify({ ...report, inputSha256: createHash("sha256").update(jsonl).digest("hex") }, null, 2)}\n`;
  // Exclusive creation prevents accidental replacement of the delivery or an earlier report.
  if (output) await writeFile(output, encoded, { flag: "wx" });
  else process.stdout.write(encoded);
  console.error(
    `${report.status}: ${report.recordCounts.recipe ?? 0} recipes; ${report.errors.length} structural errors; ${report.exclusions.length} excluded bindings. Solver certification remains pending.`,
  );
  return report.status === "READY_FOR_INTEGRATION_REVIEW" ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined;
  console.error(
    code
      ? `Delivery review could not complete (${code}). No database or provider calls were made.`
      : error instanceof Error
        ? error.message
        : "Delivery review failed",
  );
  process.exitCode = 2;
}
