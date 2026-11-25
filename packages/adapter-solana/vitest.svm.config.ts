import { defineConfig } from "vitest/config";

// The full adapter suite: unit tests plus the LiteSVM tests against the compiled SBF binary
// (CALL_MARKETS_SO, default target/deploy/call_markets.so). Fails if the binary is missing.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/svm/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The process entry point only wires argv/stdout to runCli (tested directly).
      exclude: ["src/cli/main.ts"],
      reporter: ["text", "lcov", "json-summary", "html"],
      reportsDirectory: "coverage/svm",
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 85,
        branches: 75,
      },
    },
  },
});
