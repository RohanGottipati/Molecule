import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Integration files share the active catalog and reset demo state.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
