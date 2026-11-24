import type { FixedPoint } from "./seal/schema.ts";
import { CoreError, ErrorCode } from "./result.ts";

/** Exponents beyond this are rejected so scaling stays small and exact. */
export const MAX_ABS_EXPO = 30;

/**
 * Exact comparison of mantissa * 10^expo values with bigint arithmetic (no floats).
 * Returns -1, 0 or 1.
 */
export function compareFixed(a: FixedPoint, b: FixedPoint): -1 | 0 | 1 {
  assertExpo(a.expo);
  assertExpo(b.expo);
  const minExpo = Math.min(a.expo, b.expo);
  const av = a.mantissa * 10n ** BigInt(a.expo - minExpo);
  const bv = b.mantissa * 10n ** BigInt(b.expo - minExpo);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function assertExpo(expo: number): void {
  if (!Number.isInteger(expo) || Math.abs(expo) > MAX_ABS_EXPO) {
    throw new CoreError(
      ErrorCode.InvalidExponent,
      `exponent must be an integer within ±${MAX_ABS_EXPO}`,
    );
  }
}
