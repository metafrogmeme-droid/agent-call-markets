import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addStake,
  EMPTY_POOL,
  ErrorCode,
  Outcome,
  payout,
  poolTotal,
  quote,
  Resolution,
  resolutionFor,
  Side,
  U64_MAX,
  type Pool,
} from "../src/index.ts";

const arbSide = fc.constantFrom(Side.Yes, Side.No);
const arbStakes = fc.array(
  fc.record({ side: arbSide, amount: fc.bigInt({ min: 1n, max: 10n ** 12n }) }),
  {
    minLength: 1,
    maxLength: 40,
  },
);

function poolOf(stakes: readonly { side: Side; amount: bigint }[]): Pool {
  let pool = EMPTY_POOL;
  for (const s of stakes) {
    const r = addStake(pool, s.side, s.amount);
    if (!r.ok) throw r.error;
    pool = r.value;
  }
  return pool;
}

describe("parimutuel invariants (property)", () => {
  it("payouts never exceed the pool; dust is less than the number of winners", () => {
    fc.assert(
      fc.property(
        arbStakes,
        fc.constantFrom(Resolution.Yes, Resolution.No),
        (stakes, resolution) => {
          const pool = poolOf(stakes);
          const paid = stakes.reduce(
            (sum, s) => sum + payout(s.side, s.amount, pool, resolution),
            0n,
          );
          expect(paid <= poolTotal(pool)).toBe(true);
          const winner = resolution === Resolution.Yes ? Side.Yes : Side.No;
          const winners = stakes.filter((s) => s.side === winner).length;
          if (winners === 0) {
            expect(paid).toBe(poolTotal(pool)); // nobody won: full refund
          } else {
            expect(poolTotal(pool) - paid < BigInt(winners)).toBe(true);
          }
        },
      ),
    );
  });

  it("losers get nothing and every winner gets at least their stake back", () => {
    fc.assert(
      fc.property(arbStakes, (stakes) => {
        const pool = poolOf(stakes);
        if (pool.yes === 0n) return;
        for (const s of stakes) {
          const p = payout(s.side, s.amount, pool, Resolution.Yes);
          if (s.side === Side.No) expect(p).toBe(0n);
          else expect(p >= s.amount).toBe(true);
        }
      }),
    );
  });

  it("VOID refunds every stake exactly", () => {
    fc.assert(
      fc.property(arbStakes, (stakes) => {
        const pool = poolOf(stakes);
        const paid = stakes.reduce(
          (sum, s) => sum + payout(s.side, s.amount, pool, Resolution.Void),
          0n,
        );
        expect(paid).toBe(poolTotal(pool));
      }),
    );
  });
});

describe("parimutuel details", () => {
  it("maps outcomes to resolutions", () => {
    expect(resolutionFor(Outcome.Hit)).toBe(Resolution.Yes);
    expect(resolutionFor(Outcome.Miss)).toBe(Resolution.No);
  });

  it("rejects non-positive stakes and totals above u64", () => {
    const zero = addStake(EMPTY_POOL, Side.Yes, 0n);
    expect(!zero.ok && zero.error.code).toBe(ErrorCode.InvalidAmount);
    const big = addStake({ yes: U64_MAX, no: 0n }, Side.No, 1n);
    expect(!big.ok && big.error.code).toBe(ErrorCode.InvalidAmount);
    expect(addStake({ yes: U64_MAX - 1n, no: 0n }, Side.No, 1n).ok).toBe(true);
  });

  it("pays a zero or negative stake nothing", () => {
    expect(payout(Side.Yes, 0n, { yes: 10n, no: 10n }, Resolution.Yes)).toBe(0n);
  });

  it("floors winner payouts", () => {
    // pool 3 YES (1 + 2) vs 1 NO: total 4. YES wins: 1*4/3 = 1 (floor), 2*4/3 = 2 (floor). Dust 1.
    const pool = { yes: 3n, no: 1n };
    expect(payout(Side.Yes, 1n, pool, Resolution.Yes)).toBe(1n);
    expect(payout(Side.Yes, 2n, pool, Resolution.Yes)).toBe(2n);
  });

  it("quotes the projected payout and the YES share without claiming a probability", () => {
    const empty = quote(EMPTY_POOL, Side.Yes, 10n);
    expect(empty.ok && empty.value.yesShare).toBeNull();
    expect(empty.ok && empty.value.projectedPayout).toBe(10n);
    const q = quote({ yes: 100n, no: 300n }, Side.Yes, 100n);
    expect(q.ok && q.value.yesShare).toEqual({ num: 100n, den: 400n });
    expect(q.ok && q.value.projectedPayout).toBe(250n); // 100 * 500 / 200
    const bad = quote(EMPTY_POOL, Side.No, -1n);
    expect(!bad.ok && bad.error.code).toBe(ErrorCode.InvalidAmount);
  });
});
