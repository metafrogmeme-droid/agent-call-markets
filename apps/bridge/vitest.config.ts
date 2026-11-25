import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The process entry point only wires argv/stdout to runBridgeCli (tested directly).
      exclude: ["src/cli/main.ts"],
      reporter: ["text", "lcov", "json-summary", "html"],
      reportsDirectory: "coverage",
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
