import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../pipeline/score.mjs", import.meta.url));
test("offline report replay verifies hash and refuses overwrite or cosmetic variant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rox-replay-test-"));
  try {
    const snapshot = {
      scope: "recorded_selection",
      artifacts: [],
      truth: [],
      extractions: [],
      quarantined: [],
      attempts: [],
      config: { businessDayHours: 8, fxToCad: { CAD: 1 } },
    };
    const input = join(dir, "input.json"),
      output = join(dir, "output.json"),
      replay = join(dir, "replay.json");
    await writeFile(
      input,
      JSON.stringify({
        snapshot,
        snapshotHash: createHash("sha256")
          .update(JSON.stringify(snapshot))
          .digest("hex"),
      }),
    );
    const run = (extra = []) =>
      execFileSync(
        process.execPath,
        [cli, `--snapshot=${input}`, `--output=${output}`, ...extra],
        { stdio: "pipe" },
      );
    run();
    assert.equal(
      JSON.parse(await readFile(output, "utf8")).result.metrics
        .artifacts_scored,
      0,
    );
    execFileSync(
      process.execPath,
      [cli, `--snapshot=${output}`, `--output=${replay}`],
      { stdio: "pipe" },
    );
    assert.deepEqual(
      JSON.parse(await readFile(replay, "utf8")).result,
      JSON.parse(await readFile(output, "utf8")).result,
    );
    assert.throws(
      () => run(),
      (e) => String(e.stderr).includes("EEXIST"),
    );
    assert.throws(
      () => run(["--variant=agent"]),
      (e) => String(e.stderr).includes("Unknown argument"),
    );
    await writeFile(input, JSON.stringify({ snapshot, snapshotHash: "wrong" }));
    assert.throws(
      () => run(),
      (e) => String(e.stderr).includes("checksum mismatch"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
