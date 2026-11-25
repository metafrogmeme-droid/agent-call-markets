import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { settlementVectorsJson } from "../scripts/settlement-vectors.ts";

describe("settlement golden vectors", () => {
  it("the committed file is exactly what the generator produces from decideOutcome", () => {
    const committed = readFileSync(
      new URL("../test-vectors/settlement-v1.json", import.meta.url),
      "utf8",
    );
    expect(committed).toBe(settlementVectorsJson());
  });

  it("covers hits, misses and every rejection the program can see", () => {
    const parsed = JSON.parse(settlementVectorsJson()) as { cases: { expected: string }[] };
    const results = new Set(parsed.cases.map((c) => c.expected));
    for (const r of [
      "HIT",
      "MISS",
      "FEED_MISMATCH",
      "OBSERVATION_OUTSIDE_WINDOW",
      "OBSERVATION_NOT_UNIQUE",
      "NON_POSITIVE_PRICE",
      "INVALID_EXPONENT",
      "CONFIDENCE_TOO_WIDE",
    ]) {
      expect(results).toContain(r);
    }
  });
});
