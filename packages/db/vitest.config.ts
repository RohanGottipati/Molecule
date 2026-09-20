import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These suites share one explicitly disposable database and its active catalog.
    fileParallelism: !process.env.TEST_DATABASE_URL,
    include: ["src/**/*.test.ts"],
    // Catalog suites replace the singleton active version in the same database.
    // Keep intentional concurrent reservation calls inside each test intact.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
