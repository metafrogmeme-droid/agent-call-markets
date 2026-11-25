import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  bytes32,
  compareFixed,
  CoreError,
  decideOutcome,
  Direction,
  ErrorCode,
  Outcome,
  SEAL_VERSION_V1,
  validateCall,
  type CallV1,
} from "../src/index.ts";
import { AGENT, FEED, makeCall, makeObs, OTHER_FEED, PARAMS, SALT } from "./fixtures.ts";

describe("compareFixed", () => {
  it("agrees with exact rational comparison (property)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }),
        fc.integer({ min: -30, max: 30 }),
        fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }),
        fc.integer({ min: -30, max: 30 }),
        (am, ae, bm, be) => {
          // a = am * 10^ae, b = bm * 10^be; compare am*10^(ae-m) vs bm*10^(be-m) with m = min.
          const m = Math.min(ae, be);
          const l = am * 10n ** BigInt(ae - m);
          const r = bm * 10n ** BigInt(be - m);
          const expected = l < r ? -1 : l > r ? 1 : 0;
          expect(compareFixed({ mantissa: am, expo: ae }, { mantissa: bm, expo: be })).toBe(
            expected,
          );
        },
      ),
    );
  });

  it("treats equal values with different exponents as equal", () => {
    expect(compareFixed({ mantissa: 100n, expo: -2 }, { mantissa: 1n, expo: 0 })).toBe(0);
  });

  it("rejects out-of-range exponents", () => {
    expect(() => compareFixed({ mantissa: 1n, expo: 31 }, { mantissa: 1n, expo: 0 })).toThrow(
      CoreError,
    );
    expect(() => compareFixed({ mantissa: 1n, expo: 0 }, { mantissa: 1n, expo: 0.5 })).toThrow(
      CoreError,
    );
  });
});

describe("validateCall", () => {
  const cases: [string, CallV1, Uint8Array, string][] = [
    ["version", { ...makeCall(), version: 3 as unknown as 1 }, SALT, ErrorCode.InvalidVersion],
    ["direction", { ...makeCall(), direction: 0 as Direction }, SALT, ErrorCode.InvalidDirection],
    ["zero agent", makeCall({ agent: bytes32(new Uint8Array(32)) }), SALT, ErrorCode.ZeroAgent],
    ["zero feed", makeCall({ feedId: bytes32(new Uint8Array(32)) }), SALT, ErrorCode.ZeroFeed],
    ["zero salt", makeCall(), new Uint8Array(32), ErrorCode.ZeroSalt],
    ["level zero", makeCall({ level: { mantissa: 0n, expo: -6 } }), SALT, ErrorCode.InvalidLevel],
    [
      "level negative",
      makeCall({ level: { mantissa: -5n, expo: -6 } }),
      SALT,
      ErrorCode.InvalidLevel,
    ],
    [
      "expo above range",
      makeCall({ level: { mantissa: 1n, expo: 1 } }),
      SALT,
      ErrorCode.InvalidExponent,
    ],
    [
      "expo below range",
      makeCall({ level: { mantissa: 1n, expo: -19 } }),
      SALT,
      ErrorCode.InvalidExponent,
    ],
    ["feed not allowed", makeCall({ feedId: OTHER_FEED }), SALT, ErrorCode.FeedNotAllowed],
  ];
  it.each(cases)("rejects %s", (_, call, salt, code) => {
    const r = validateCall(call, salt as never, PARAMS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });

  it("accepts a well-formed call on an allowed feed", () => {
    expect(validateCall(makeCall(), SALT, PARAMS).ok).toBe(true);
  });
});

describe("decideOutcome", () => {
  const call = makeCall(); // ABOVE 100.000000 (expo -6)
  const below = makeCall({ direction: Direction.Below });

  function outcome(c: CallV1, price: bigint, conf = 0n, expo = -6) {
    const r = decideOutcome(c, makeObs({ price, conf, expo, publishTime: c.expiryTs }), PARAMS);
    if (!r.ok) throw r.error;
    return r.value;
  }

  it("ABOVE: strictly above is a HIT, equal is a MISS", () => {
    expect(outcome(call, 100_000_001n)).toBe(Outcome.Hit);
    expect(outcome(call, 100_000_000n)).toBe(Outcome.Miss);
    expect(outcome(call, 99_999_999n)).toBe(Outcome.Miss);
  });

  it("BELOW: strictly below is a HIT, equal is a MISS", () => {
    expect(outcome(below, 99_999_999n)).toBe(Outcome.Hit);
    expect(outcome(below, 100_000_000n)).toBe(Outcome.Miss);
    expect(outcome(below, 100_000_001n)).toBe(Outcome.Miss);
  });

  it("a HIT needs the whole confidence interval clear of the level", () => {
    expect(outcome(call, 100_200_000n, 199_999n)).toBe(Outcome.Hit);
    expect(outcome(call, 100_200_000n, 200_000n)).toBe(Outcome.Miss);
    expect(outcome(below, 99_800_000n, 199_999n)).toBe(Outcome.Hit);
    expect(outcome(below, 99_800_000n, 200_000n)).toBe(Outcome.Miss);
  });

  it("compares across different exponents exactly", () => {
    expect(outcome(call, 10_000_000_001n, 0n, -8)).toBe(Outcome.Hit); // 100.00000001
    expect(outcome(call, 10_000_000_000n, 0n, -8)).toBe(Outcome.Miss); // 100.00000000
    expect(outcome(call, 101n, 0n, 0)).toBe(Outcome.Hit);
  });

  const rejections: [string, Parameters<typeof makeObs>[0], string][] = [
    ["feed mismatch", { feedId: OTHER_FEED }, ErrorCode.FeedMismatch],
    ["before expiry", { publishTime: call.expiryTs - 1n }, ErrorCode.ObservationOutsideWindow],
    [
      "after window",
      { publishTime: call.expiryTs + PARAMS.settleWindowSecs + 1n },
      ErrorCode.ObservationOutsideWindow,
    ],
    [
      "not the unique update (prev = expiry)",
      { publishTime: call.expiryTs + 5n, prevPublishTime: call.expiryTs },
      ErrorCode.ObservationNotUnique,
    ],
    [
      "not the unique update (prev after expiry)",
      { publishTime: call.expiryTs + 5n, prevPublishTime: call.expiryTs + 3n },
      ErrorCode.ObservationNotUnique,
    ],
    ["exponent out of range", { expo: -31 }, ErrorCode.InvalidExponent],
    ["exponent not integer", { expo: -6.5 }, ErrorCode.InvalidExponent],
    ["zero price", { price: 0n }, ErrorCode.NonPositivePrice],
    ["negative price", { price: -1n }, ErrorCode.NonPositivePrice],
    ["negative conf", { conf: -1n }, ErrorCode.NegativeConfidence],
    ["conf just over 50 bps", { price: 100_000_000n, conf: 500_001n }, ErrorCode.ConfidenceTooWide],
  ];
  it.each(rejections)("fails closed on %s", (_, patch, code) => {
    const r = decideOutcome(call, makeObs({ publishTime: call.expiryTs, ...patch }), PARAMS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });

  it("accepts the window edges and exactly 50 bps", () => {
    for (const publishTime of [call.expiryTs, call.expiryTs + PARAMS.settleWindowSecs]) {
      expect(decideOutcome(call, makeObs({ publishTime }), PARAMS).ok).toBe(true);
    }
    expect(
      decideOutcome(
        call,
        makeObs({ price: 100_000_000n, conf: 500_000n, publishTime: call.expiryTs }),
        PARAMS,
      ).ok,
    ).toBe(true);
  });

  it("the rule is the same for any agent", () => {
    const other: CallV1 = { ...call, version: SEAL_VERSION_V1, agent: bytes32("c3".repeat(32)) };
    expect(outcome(other, 100_000_001n)).toBe(outcome(call, 100_000_001n));
    expect(AGENT).not.toEqual(other.agent);
    expect(FEED).toEqual(other.feedId);
  });
});
