import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov", "json-summary", "html"],
      reportsDirectory: "coverage",
      // Enforced: CI fails below these (brief: >= 90% line coverage on core).
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
