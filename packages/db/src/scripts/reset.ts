import { closePool, resetDemoData } from "../index.js";

try {
  await resetDemoData();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Demo reset failed");
  process.exitCode = 1;
} finally {
  await closePool();
}
