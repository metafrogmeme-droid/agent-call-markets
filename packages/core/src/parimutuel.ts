import { U64_MAX } from "./bytes.ts";
import { err, ErrorCode, ok, type Result } from "./result.ts";
import { Outcome } from "./settlement.ts";

/**
 * Parimutuel pool maths (Q2 conservative default: no third-party AMM, no fees).
 * All amounts are token base units; totals stay <= u64 max so the on-chain mirror can use
 * u128 intermediates.
 */
export const Side = { Yes: "YES", No: "NO" } as const;
export type Side = (typeof Side)[keyof typeof Side];

/** YES = "the call hits", NO = "the call misses". VOID refunds everyone. */
export const Resolution = { Yes: "YES", No: "NO", Void: "VOID" } as const;
export type Resolution = (typeof Resolution)[keyof typeof Resolution];

export interface Pool {
  readonly yes: bigint;
  readonly no: bigint;
}

export interface Ratio {
  readonly num: bigint;
  readonly den: bigint;
}

export const EMPTY_POOL: Pool = Object.freeze({ yes: 0n, no: 0n });

export function resolutionFor(outcome: Outcome): Resolution {
  return outcome === Outcome.Hit ? Resolution.Yes : Resolution.No;
}

export function poolTotal(pool: Pool): bigint {
  return pool.yes + pool.no;
}

export function sideTotal(pool: Pool, side: Side): bigint {
  return side === Side.Yes ? pool.yes : pool.no;
}

export function addStake(pool: Pool, side: Side, amount: bigint): Result<Pool> {
  if (amount <= 0n) return err(ErrorCode.InvalidAmount, "stake must be positive");
  const next =
    side === Side.Yes ? { ...pool, yes: pool.yes + amount } : { ...pool, no: pool.no + amount };
  if (poolTotal(next) > U64_MAX) return err(ErrorCode.InvalidAmount, "pool total would exceed u64");
  return ok(next);
}

/**
 * Payout for a stake of `amount` on `side` once the market resolves.
 * - VOID, or nobody on the winning side: the stake is refunded.
 * - Losing side: 0.
 * - Winning side: floor(amount * total / winningTotal). Rounding dust stays in the vault.
 */
export function payout(side: Side, amount: bigint, pool: Pool, resolution: Resolution): bigint {
  if (amount <= 0n) return 0n;
  if (resolution === Resolution.Void) return amount;
  const winner: Side = resolution === Resolution.Yes ? Side.Yes : Side.No;
  const winningTotal = sideTotal(pool, winner);
  if (winningTotal === 0n) return amount;
  if (side !== winner) return 0n;
  return (amount * poolTotal(pool)) / winningTotal;
}

export interface Quote {
  readonly side: Side;
  readonly amount: bigint;
  readonly pool: Pool;
  /** Share of the pool on YES before this trade; null for an empty pool. Not a probability claim. */
  readonly yesShare: Ratio | null;
  /**
   * Payout if `side` wins and nobody else trades after this stake. Later trades change it:
   * this is parimutuel, so the final payout is only known at settlement.
   */
  readonly projectedPayout: bigint;
}

export function quote(pool: Pool, side: Side, amount: bigint): Result<Quote> {
  const after = addStake(pool, side, amount);
  if (!after.ok) return after;
  const total = poolTotal(pool);
  return ok({
    side,
    amount,
    pool,
    yesShare: total === 0n ? null : { num: pool.yes, den: total },
    projectedPayout: payout(
      side,
      amount,
      after.value,
      side === Side.Yes ? Resolution.Yes : Resolution.No,
    ),
  });
}
