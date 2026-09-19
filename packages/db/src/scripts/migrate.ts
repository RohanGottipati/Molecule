// Runs every sql/*.sql file at the repo root, in filename order.
//   pnpm db:migrate   -> runs 001_core.sql .. 003_aggregates.sql (schema only)
//   pnpm db:seed      -> runs 004_seed.sql (demo data), assumes migrate ran first
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

async function main() {
  const seedOnly = process.argv.includes("--seed-only");
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/db/src/scripts -> repo root is four levels up
  const sqlDir = path.join(here, "..", "..", "..", "..", "sql");

  const files = readdirSync(sqlDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    for (const file of files) {
      const isSeed = file.includes("seed");
      if (seedOnly && !isSeed) continue;
      if (!seedOnly && isSeed) continue;

      process.stdout.write(`Applying ${file}...\n`);
      const sql = readFileSync(path.join(sqlDir, file), "utf-8");
      await client.query(sql);
    }
    process.stdout.write("Done.\n");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
