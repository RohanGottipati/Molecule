import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These suites share one explicitly disposable database and its active catalog.
    fileParallelism: !process.env.TEST_DATABASE_URL,
    include: ["src/**/*.test.ts"],
    // Integration files share the active catalog and reset demo state.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
