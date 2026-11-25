// Golden parimutuel vectors: payouts and quotes from the core pool maths. The on-chain program
// (M3) must produce the same numbers. Amounts are token base units.
import {
  addStake,
  EMPTY_POOL,
  payout,
  quote,
  Resolution,
  Side,
  U64_MAX,
  type Pool,
} from "../src/index.ts";

interface Stake {
  readonly side: Side;
  readonly amount: bigint;
}

interface PayoutCase {
  readonly name: string;
  readonly stakes: readonly Stake[];
  readonly resolution: Resolution;
}

interface QuoteCase {
  readonly name: string;
  readonly pool: Pool;
  readonly side: Side;
  readonly amount: bigint;
}

const Y = Side.Yes;
const N = Side.No;
const HALF = U64_MAX / 2n;

const PAYOUT_CASES: readonly PayoutCase[] = [
  {
    name: "no_wins",
    stakes: [
      { side: Y, amount: 100n },
      { side: N, amount: 300n },
    ],
    resolution: Resolution.No,
  },
  {
    name: "yes_wins",
    stakes: [
      { side: Y, amount: 100n },
      { side: N, amount: 300n },
    ],
    resolution: Resolution.Yes,
  },
  {
    name: "void_refunds",
    stakes: [
      { side: Y, amount: 100n },
      { side: N, amount: 300n },
    ],
    resolution: Resolution.Void,
  },
  {
    name: "floor_rounding_leaves_dust",
    stakes: [
      { side: Y, amount: 1n },
      { side: Y, amount: 2n },
      { side: N, amount: 1n },
    ],
    resolution: Resolution.Yes,
  },
  {
    name: "no_winners_refund",
    stakes: [
      { side: N, amount: 7n },
      { side: N, amount: 5n },
    ],
    resolution: Resolution.Yes,
  },
  {
    name: "many_small_winners",
    stakes: [
      { side: Y, amount: 3n },
      { side: Y, amount: 3n },
      { side: Y, amount: 3n },
      { side: N, amount: 10n },
    ],
    resolution: Resolution.Yes,
  },
  {
    name: "near_u64_max_total",
    stakes: [
      { side: Y, amount: HALF },
      { side: N, amount: HALF },
    ],
    resolution: Resolution.Yes,
  },
  {
    name: "near_u64_max_uneven",
    stakes: [
      { side: Y, amount: 1n },
      { side: Y, amount: 2n },
      { side: N, amount: U64_MAX - 3n },
    ],
    resolution: Resolution.Yes,
  },
];

const QUOTE_CASES: readonly QuoteCase[] = [
  { name: "empty_pool", pool: EMPTY_POOL, side: Y, amount: 10n },
  { name: "existing_pool_yes", pool: { yes: 100n, no: 300n }, side: Y, amount: 100n },
  { name: "existing_pool_no", pool: { yes: 100n, no: 300n }, side: N, amount: 50n },
  { name: "zero_amount", pool: { yes: 100n, no: 300n }, side: Y, amount: 0n },
  { name: "total_would_exceed_u64", pool: { yes: U64_MAX - 5n, no: 5n }, side: N, amount: 1n },
  { name: "total_exactly_u64", pool: { yes: U64_MAX - 6n, no: 5n }, side: N, amount: 1n },
];

function poolOf(stakes: readonly Stake[]): Pool {
  let pool = EMPTY_POOL;
  for (const s of stakes) {
    const r = addStake(pool, s.side, s.amount);
    if (!r.ok) throw r.error;
    pool = r.value;
  }
  return pool;
}

export function buildPoolVectors(): unknown {
  return {
    format: "ACM-POOL-V1",
    provisional: true,
    note:
      "Reference results of the core parimutuel maths (no fees; floor rounding; refund on VOID or " +
      "when nobody is on the winning side). Amounts are base units, as decimal strings.",
    payoutCases: PAYOUT_CASES.map((c) => {
      const pool = poolOf(c.stakes);
      return {
        name: c.name,
        resolution: c.resolution,
        pool: { yes: pool.yes.toString(), no: pool.no.toString() },
        positions: c.stakes.map((s) => ({
          side: s.side,
          amount: s.amount.toString(),
          payout: payout(s.side, s.amount, pool, c.resolution).toString(),
        })),
      };
    }),
    quoteCases: QUOTE_CASES.map((c) => {
      const r = quote(c.pool, c.side, c.amount);
      return {
        name: c.name,
        pool: { yes: c.pool.yes.toString(), no: c.pool.no.toString() },
        side: c.side,
        amount: c.amount.toString(),
        expected: r.ok
          ? { projectedPayout: r.value.projectedPayout.toString() }
          : { error: r.error.code },
      };
    }),
  };
}

export function poolVectorsJson(): string {
  return JSON.stringify(buildPoolVectors(), null, 2) + "\n";
}
