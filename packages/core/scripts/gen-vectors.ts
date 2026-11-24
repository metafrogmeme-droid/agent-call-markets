// Regenerates test-vectors/seal-v1.json. Run: pnpm --filter @agent-call-markets/core gen-vectors
// A test fails if the committed file differs from what this produces.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { vectorsJson } from "./vectors.ts";

const target = fileURLToPath(new URL("../test-vectors/seal-v1.json", import.meta.url));
writeFileSync(target, vectorsJson());
console.log(`wrote ${target}`);
