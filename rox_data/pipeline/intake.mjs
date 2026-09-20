// Stage 1-2: intake and parse. Deterministic, no model involved.
//
// Rules: the bytes are never mutated, the same bytes from the same place are one
// artifact, and a file we cannot decode or parse is marked failed rather than
// half-read. Nothing here guesses who sent the file - merchant attribution is
// entity resolution's job, so every artifact lands on the `m-unresolved`
// sentinel until it is linked.

import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { MEDIA_TYPES, TYPE_TO_SOURCE_KIND } from "./config.mjs";
import { sha256, shortId, bumpStage, emitEvent } from "./db.mjs";

/** Windows-1252-as-UTF-8 damage is detectable and reversible - repair it and say so. */
const MOJIBAKE = [
  ["\u00e2\u20ac\u2122", "'"],
  ["\u00e2\u20ac\u201c", "-"],
  ["\u00e2\u20ac\u201d", "\u2014"],
  ["\u00e2\u20ac\u0153", '"'],
  ["\u00c3\u00a9", "\u00e9"],
  ["\u00c3\u00a8", "\u00e8"],
  ["\u00c3\u00a0", "\u00e0"],
];

export function decode(buffer) {
  let text = buffer.toString("utf8");
  const notes = {};
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
    notes.bom = true;
  }
  if (text.includes("\r\n")) {
    text = text.replaceAll("\r\n", "\n");
    notes.crlf = true;
  }
  let repaired = false;
  for (const [bad, good] of MOJIBAKE) {
    if (text.includes(bad)) {
      text = text.replaceAll(bad, good);
      repaired = true;
    }
  }
  if (repaired) notes.mojibake_repaired = true;
  if (text.includes("\ufffd")) notes.replacement_chars = true;
  return { text, notes };
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * Reads one file into the shape raw_artifacts wants. `parse_status` is the
 * honest answer about whether we understood the container, not the content:
 * malformed JSON is `failed`, everything decodable is `parsed`.
 */
export async function readArtifact(root, path, batchId) {
  const rel = relative(root, path).split("\\").join("/");
  const type = rel.split("/")[0];
  const buffer = await readFile(path);
  const { text, notes } = decode(buffer);
  const ext = extname(path);

  let parseStatus = "parsed";
  let parseError = null;
  if (ext === ".json") {
    try {
      JSON.parse(text);
    } catch (error) {
      parseStatus = "failed";
      parseError = `Malformed JSON: ${error.message.slice(0, 200)}`;
    }
  }
  if (!text.trim()) {
    parseStatus = "failed";
    parseError = "Empty after decode";
  }

  const sourceReference = `corpus:${batchId}:${rel}`;
  return {
    artifactId: shortId("artifact", sourceReference),
    sourceKind: TYPE_TO_SOURCE_KIND[type] ?? "document",
    sourceReference,
    checksum: sha256(buffer),
    mediaType: MEDIA_TYPES[ext] ?? "application/octet-stream",
    contentText: text,
    parseStatus,
    parseError,
    batchId,
    sourcePath: rel,
    byteSize: buffer.byteLength,
    chaos: notes,
  };
}

export async function intake(
  db,
  { runId, root, batchId, traceId, limit = null },
) {
  const counts = { seen: 0, inserted: 0, duplicate: 0, failed: 0, repaired: 0 };
  const paths = [];
  for await (const p of walk(root)) paths.push(p);
  paths.sort();

  for (const path of limit ? paths.slice(0, limit) : paths) {
    const a = await readArtifact(root, path, batchId);
    counts.seen += 1;
    if (a.parseStatus === "failed") counts.failed += 1;
    if (a.chaos.mojibake_repaired) counts.repaired += 1;

    const { rowCount } = await db.query(
      `insert into raw_artifacts
         (artifact_id, merchant_id, source_kind, source_reference, checksum, raw_content,
          media_type, content_text, parse_status, parse_error, batch_id, source_path, byte_size, chaos_profile)
       values ($1, 'm-unresolved', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (checksum, source_reference) do nothing`,
      [
        a.artifactId,
        a.sourceKind,
        a.sourceReference,
        a.checksum,
        { bytes: a.byteSize, encoding: "utf-8", notes: a.chaos },
        a.mediaType,
        a.contentText,
        a.parseStatus,
        a.parseError,
        a.batchId,
        a.sourcePath,
        a.byteSize,
        a.chaos,
      ],
    );
    if (rowCount === 1) counts.inserted += 1;
    else counts.duplicate += 1;
  }

  await bumpStage(db, runId, "intake", counts);
  await emitEvent(db, {
    traceId,
    type: "rox.intake.completed",
    payload: counts,
  });
  return counts;
}
