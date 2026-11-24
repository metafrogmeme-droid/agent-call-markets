import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  bytes32,
  bytesEqual,
  commitmentOf,
  CoreError,
  Direction,
  ErrorCode,
  randomSalt,
  verifyReveal,
  type RandomSource,
} from "../src/index.ts";
import { makeCall, OTHER, OTHER_FEED, SALT, withByte } from "./fixtures.ts";

describe("commit / reveal", () => {
  it("verifies the matching call and salt", () => {
    const call = makeCall();
    expect(verifyReveal(commitmentOf(call, SALT), call, SALT)).toBe(true);
  });

  it("rejects a different salt or a malformed call without throwing", () => {
    const call = makeCall();
    const c = commitmentOf(call, SALT);
    expect(verifyReveal(c, call, withByte(SALT, 31, 0))).toBe(false);
    expect(verifyReveal(c, { ...call, direction: 7 as Direction }, SALT)).toBe(false);
  });

  it("changing any single field changes the commitment", () => {
    const base = makeCall();
    const c = commitmentOf(base, SALT);
    const variants = [
      { ...base, agent: OTHER },
      { ...base, feedId: OTHER_FEED },
      { ...base, direction: Direction.Below },
      { ...base, level: { ...base.level, mantissa: base.level.mantissa + 1n } },
      { ...base, level: { ...base.level, expo: base.level.expo - 1 } },
      { ...base, expiryTs: base.expiryTs + 1n },
    ];
    for (const v of variants) expect(bytesEqual(commitmentOf(v, SALT), c)).toBe(false);
  });

  it("a one-byte salt change changes the commitment (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 31 }), fc.integer({ min: 0, max: 255 }), (i, b) => {
        fc.pre(SALT[i] !== b);
        expect(
          bytesEqual(
            commitmentOf(makeCall(), withByte(SALT, i, b)),
            commitmentOf(makeCall(), SALT),
          ),
        ).toBe(false);
      }),
    );
  });
});

describe("randomSalt", () => {
  it("returns 32 non-zero bytes from the platform CSPRNG", () => {
    const a = randomSalt();
    const b = randomSalt();
    expect(a.length).toBe(32);
    expect(bytesEqual(a, b)).toBe(false);
  });

  it("redraws when the source returns all zeros, and fails closed if it keeps doing so", () => {
    let calls = 0;
    const flaky: RandomSource = {
      getRandomValues<T extends Uint8Array>(a: T): T {
        calls++;
        if (calls > 1) a.fill(7);
        return a;
      },
    };
    expect(bytesEqual(randomSalt(flaky), bytes32("07".repeat(32)))).toBe(true);
    const broken: RandomSource = { getRandomValues: <T extends Uint8Array>(a: T): T => a };
    expect(() => randomSalt(broken)).toThrow(CoreError);
    try {
      randomSalt(broken);
    } catch (e) {
      expect((e as CoreError).code).toBe(ErrorCode.ZeroSalt);
    }
  });
});
