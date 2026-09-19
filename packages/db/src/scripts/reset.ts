// DESTRUCTIVE: drops and recreates the public schema, then reruns
// migrate + seed. Only ever run this against your local/dev Tiger instance.
import { execSync } from "node:child_process";

import pg from "pg";

const { Client } = pg;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }

  const client = new Client({ connectionString });
  await client.connect();
  process.stdout.write("Dropping and recreating public schema...\n");
  await client.query("drop schema public cascade; create schema public;");
  await client.end();

  execSync("pnpm --filter @molecule/db migrate", { stdio: "inherit" });
  execSync("pnpm --filter @molecule/db seed", { stdio: "inherit" });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
