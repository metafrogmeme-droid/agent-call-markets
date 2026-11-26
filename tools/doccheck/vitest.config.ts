import { defineConfig } from "vitest/config";

// Doc checks only read files in the repository; there is no source to cover.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
