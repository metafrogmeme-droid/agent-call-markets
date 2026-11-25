import { describe, expect, it } from "vitest";
import { CoreError, ErrorCode } from "@agent-call-markets/core";
import { parseDecimal } from "../src/decimal.ts";
import { parseIdMap } from "../src/maps.ts";
import { AGENT_1, AGENTS_JSON, FEED_BTC, FEEDS_JSON } from "./helpers.ts";

describe("decimal levels", () => {
  it("parses positive decimals exactly", () => {
    expect(parseDecimal("185.25")).toEqual({ mantissa: 18525n, expo: -2 });
    expect(parseDecimal("90000")).toEqual({ mantissa: 90000n, expo: 0 });
    expect(parseDecimal("0.000001")).toEqual({ mantissa: 1n, expo: -6 });
    expect(parseDecimal("007.50")).toEqual({ mantissa: 750n, expo: -2 });
  });

  it("returns null for anything else", () => {
    for (const bad of ["", "0", "0.000", "-1", "+1", "1e3", "1.", ".5", " 1", "1,5", "NaN"]) {
      expect(parseDecimal(bad), bad).toBeNull();
    }
  });
});

describe("agent and feed maps", () => {
  it("maps labels to 32-byte public ids", () => {
    const agents = parseIdMap(AGENTS_JSON, "agents");
    expect(agents.get("FAKE-AGENT-1")).toEqual(AGENT_1);
    expect(parseIdMap(FEEDS_JSON, "feeds").get("FAKE-BTC/USD")).toEqual(FEED_BTC);
    expect(parseIdMap('{"X": "0x' + "c3".repeat(32) + '"}', "agents").size).toBe(1);
  });

  it("refuses ambiguous or invalid maps", () => {
    const bad = [
      "not json",
      "[]",
      '{"A": 1}',
      '{"A": "abc"}',
      `{"A": "${"00".repeat(32)}"}`,
      `{"A": "${"a1".repeat(32)}", "B": "${"a1".repeat(32)}"}`,
      `{"": "${"a1".repeat(32)}"}`,
    ];
    for (const text of bad) {
      expect(() => parseIdMap(text, "agents"), text).toThrow(CoreError);
      try {
        parseIdMap(text, "agents");
      } catch (e) {
        expect((e as CoreError).code).toBe(ErrorCode.InvalidParams);
      }
    }
  });
});
