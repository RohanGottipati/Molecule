import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../services/reality/package.json", import.meta.url),
);
const { validateCatalogJsonl } = await import(
  require.resolve("@molecule/contracts")
);
const { importCatalog, activateCatalog, closePool } = await import(
  require.resolve("@molecule/db")
);
const [command, path, output] = process.argv.slice(2);
if (!["validate", "import", "activate"].includes(command) || !path) {
  console.error(
    "Usage: node scripts/catalog-handoff.mjs validate|import FILE [REPORT.json] | activate VERSION ACTION_KEY",
  );
  process.exitCode = 1;
} else {
  try {
    if (command === "activate") {
      if (!output)
        throw new Error("Activation requires a deterministic action key");
      await activateCatalog(path, process.env.TRACE_ID ?? output, output);
      console.log(JSON.stringify({ catalogVersion: path, activated: true }));
    } else {
      const jsonl = await readFile(path, "utf8");
      const report =
        command === "import"
          ? await importCatalog(
              jsonl,
              process.env.TRACE_ID ?? `catalog-import:${path}`,
            )
          : validateCatalogJsonl(jsonl);
      const { records, ...summary } = report;
      const rendered = JSON.stringify(
        { ...summary, recordCount: records.length, certified: false },
        null,
        2,
      );
      if (output) await writeFile(output, rendered + "\n");
      else console.log(rendered);
      if (report.errors.length) process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      error?.report
        ? JSON.stringify(error.report.errors)
        : error instanceof Error
          ? error.message
          : "Catalog handoff failed",
    );
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
