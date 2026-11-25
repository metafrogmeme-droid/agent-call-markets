// Regenerates the golden vectors. Run: pnpm --filter @agent-call-markets/core gen-vectors
// Tests fail if a committed file differs from what this produces.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { poolVectorsJson } from "./pool-vectors.ts";
import { settlementVectorsJson } from "./settlement-vectors.ts";
import { vectorsJson } from "./vectors.ts";

const files: [string, string][] = [
  ["../test-vectors/seal-v1.json", vectorsJson()],
  ["../test-vectors/settlement-v1.json", settlementVectorsJson()],
  ["../test-vectors/pool-v1.json", poolVectorsJson()],
];
for (const [rel, content] of files) {
  const target = fileURLToPath(new URL(rel, import.meta.url));
  writeFileSync(target, content);
  console.log(`wrote ${target}`);
}
