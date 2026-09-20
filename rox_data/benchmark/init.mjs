#!/usr/bin/env node
// Builds manifest.json from the private raw directory plus a human-written
// authorization sheet. Computes checksums and sizes so nobody types a hash.
// It cannot decide whether authorization is TRUE - the sheet is the human's
// statement, and every document needs one.
//
//   node rox_data/benchmark/init.mjs --raw=.molecule-data/order3/raw \
//     --sheet=.molecule-data/order3/authorization.json \
//     --output=.molecule-data/order3/manifest.json
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { BENCHMARK_VERSION, SCENARIO_ID, validateManifest } from "./schema.mjs";
import { assertPrivatePath, parseArgs, readJson, writeNew } from "./cli.mjs";

const MEDIA = {
  ".eml": "message/rfc822",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

export async function buildManifest({ raw, sheet, now = new Date() }) {
  if (!sheet?.supplierKey || !sheet?.capabilityKey)
    throw new Error(
      "sheet needs supplierKey and capabilityKey (de-identified stable keys)",
    );
  if (!Array.isArray(sheet.documents) || !sheet.documents.length)
    throw new Error("sheet.documents must list every authorized document");
  const onDisk = new Set();
  for await (const file of walk(raw)) onDisk.add(relative(raw, file));
  const listed = new Set(sheet.documents.map((d) => d.file));
  for (const file of onDisk)
    if (!listed.has(file))
      throw new Error(
        `${file}: present in raw/ but not authorized in the sheet`,
      );
  for (const file of listed)
    if (!onDisk.has(file))
      throw new Error(`${file}: listed in the sheet but missing from raw/`);

  const documents = [];
  for (const [index, entry] of sheet.documents.entries()) {
    const path = join(raw, entry.file);
    const bytes = await readFile(path);
    const mediaType = MEDIA[extname(entry.file).toLowerCase()];
    if (!mediaType) throw new Error(`${entry.file}: unsupported file type`);
    documents.push({
      documentId:
        entry.documentId ?? `doc-${String(index + 1).padStart(3, "0")}`,
      path: entry.file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: (await stat(path)).size,
      mediaType,
      sourceKind: entry.sourceKind,
      chainId: entry.chainId,
      authorization: entry.authorization,
      deidentification: entry.deidentification,
    });
  }
  return validateManifest({
    version: BENCHMARK_VERSION,
    scenarioId: SCENARIO_ID,
    classification: "real_authorized",
    createdAt: now.toISOString(),
    supplierKey: sheet.supplierKey,
    capabilityKey: sheet.capabilityKey,
    documents,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(
    process.argv.slice(2),
    ["raw", "sheet", "output"],
    ["raw", "sheet", "output"],
  );
  assertPrivatePath(args.output);
  const manifest = await buildManifest({
    raw: args.raw,
    sheet: await readJson(args.sheet),
  });
  await writeNew(args.output, manifest);
  console.log(
    JSON.stringify({
      written: args.output,
      documents: manifest.documents.length,
    }),
  );
}
