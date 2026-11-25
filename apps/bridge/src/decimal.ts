import type { FixedPoint } from "@agent-call-markets/core";

/**
 * Exact positive decimal -> fixed point: "185.25" -> { mantissa: 18525n, expo: -2 }.
 * Returns null for anything that is not a plain positive decimal (no sign, exponent or spaces).
 * Range limits (mantissa <= i64, exponent window) are the core's rules, applied by the planner.
 */
export function parseDecimal(text: string): FixedPoint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (m === null) return null;
  const frac = m[2] ?? "";
  const mantissa = BigInt(`${m[1] ?? ""}${frac}`);
  if (mantissa <= 0n) return null;
  return { mantissa, expo: frac.length === 0 ? 0 : -frac.length };
}
