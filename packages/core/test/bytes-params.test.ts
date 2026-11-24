import { describe, expect, it } from "vitest";
import {
  bytes32,
  bytesEqual,
  bytesToHex,
  concatBytes,
  CoreError,
  DEFAULT_PARAMS,
  ErrorCode,
  hexToBytes,
  isZero,
  unwrap,
  validateParams,
  type ProtocolParams,
} from "../src/index.ts";
import { FEED } from "./fixtures.ts";

describe("bytes helpers", () => {
  it("round-trips hex with or without 0x", () => {
    expect(bytesToHex(hexToBytes("0x00ff10"))).toBe("00ff10");
    expect(bytesToHex(hexToBytes("0XAB"))).toBe("ab");
    expect(hexToBytes("")).toEqual(new Uint8Array());
  });

  it("rejects odd-length or non-hex strings", () => {
    expect(() => hexToBytes("abc")).toThrow(CoreError);
    expect(() => hexToBytes("zz")).toThrow(CoreError);
  });

  it("bytes32 checks length and copies its input", () => {
    expect(() => bytes32(new Uint8Array(31))).toThrow(/INVALID_LENGTH/);
    const src = new Uint8Array(32).fill(1);
    const b = bytes32(src);
    src[0] = 9;
    expect(b[0]).toBe(1);
  });

  it("compares, detects zero and concatenates", () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false);
    expect(isZero(new Uint8Array(4))).toBe(true);
    expect(isZero(new Uint8Array([0, 0, 1]))).toBe(false);
    expect(concatBytes(new Uint8Array([1]), new Uint8Array([2, 3]))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("unwrap throws the CoreError of a failed result", () => {
    const bad = validateParams({ ...DEFAULT_PARAMS, maxConfBps: 0n });
    expect(() => unwrap(bad)).toThrow(CoreError);
  });
});

describe("protocol params", () => {
  it("the conservative defaults are valid and have no feeds", () => {
    expect(validateParams(DEFAULT_PARAMS).ok).toBe(true);
    expect(DEFAULT_PARAMS.allowedFeedIds).toHaveLength(0);
    expect(Object.isFrozen(DEFAULT_PARAMS)).toBe(true);
  });

  const bad: [string, Partial<ProtocolParams>][] = [
    ["zero reveal window", { revealWindowSecs: 0n }],
    ["negative cutoff", { tradeCutoffSecs: -1n }],
    ["non-bigint", { settleWindowSecs: 10 as unknown as bigint }],
    ["lead too short", { minLeadSecs: 1_500n }],
    ["horizon below lead", { maxHorizonSecs: 3_000n, minLeadSecs: 3_600n }],
    ["conf > 100%", { maxConfBps: 10_001n }],
    ["void before window", { voidAfterSecs: 10n }],
    ["expo range inverted", { minLevelExpo: 1, maxLevelExpo: 0 }],
    ["expo range too wide", { minLevelExpo: -31 }],
    ["expo not integer", { maxLevelExpo: 0.5 }],
    ["short feed id", { allowedFeedIds: [new Uint8Array(31) as never] }],
    ["duplicate feed id", { allowedFeedIds: [FEED, bytes32(FEED)] }],
  ];
  it.each(bad)("rejects %s", (_, patch) => {
    const r = validateParams({ ...DEFAULT_PARAMS, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(ErrorCode.InvalidParams);
  });
});
