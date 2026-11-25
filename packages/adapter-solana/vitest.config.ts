import { defineConfig } from "vitest/config";

// Unit tests only (no program binary needed); run in the CI `ts` job. The LiteSVM suite against
// the compiled program is vitest.svm.config.ts (CI `adapter` job).
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // The pure modules; the adapter and transports are covered by the LiteSVM suite.
      include: [
        "src/codec/**/*.ts",
        "src/guard.ts",
        "src/pyth.ts",
        "src/constants.ts",
        "src/outcome.ts",
      ],
      reporter: ["text", "lcov", "json-summary", "html"],
      reportsDirectory: "coverage/unit",
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
