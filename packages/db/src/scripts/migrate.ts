import { closePool, migrate, seedDemo } from "../index.js";

try {
  if (process.argv.includes("--seed-only")) await seedDemo();
  else await migrate();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Migration failed");
  process.exitCode = 1;
} finally {
  await closePool();
}
