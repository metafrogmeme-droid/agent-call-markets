// Golden settlement vectors: inputs to decideOutcome and the core's result (HIT, MISS or an error
// code). The on-chain program (M2) must produce the same result for every case. All feed ids are
// synthetic test patterns, not real Pyth ids.
import {
  bytes32,
  bytesToHex,
  decideOutcome,
  DEFAULT_PARAMS,
  Direction,
  I64_MAX,
  SEAL_VERSION_V1,
  type CallV1,
  type OracleObservation,
  type ProtocolParams,
} from "../src/index.ts";

const FEED = bytes32("f1".repeat(32));
const OTHER_FEED = bytes32("f2".repeat(32));
const AGENT = bytes32("11".repeat(32));
const E = 1_800_003_600n;
export const SETTLEMENT_PARAMS: ProtocolParams = { ...DEFAULT_PARAMS, allowedFeedIds: [FEED] };

interface Case {
  readonly name: string;
  readonly direction: Direction;
  readonly level: readonly [bigint, number];
  readonly expiryTs?: bigint;
  readonly obs: Partial<OracleObservation>;
  /** Set when the case cannot be expressed on-chain (Pyth conf is u64). */
  readonly rustSkip?: string;
}

const A = Direction.Above;
const B = Direction.Below;
const L100: readonly [bigint, number] = [100_000_000n, -6];

const CASES: readonly Case[] = [
  { name: "above_hit", direction: A, level: L100, obs: { price: 101_000_000n } },
  { name: "above_equal_is_miss", direction: A, level: L100, obs: { price: 100_000_000n } },
  { name: "above_below_level_miss", direction: A, level: L100, obs: { price: 99_999_999n } },
  {
    name: "above_conf_touches_level_miss",
    direction: A,
    level: L100,
    obs: { price: 100_100_000n, conf: 100_000n },
  },
  {
    name: "above_conf_clears_level_hit",
    direction: A,
    level: L100,
    obs: { price: 100_200_000n, conf: 199_999n },
  },
  { name: "below_hit", direction: B, level: L100, obs: { price: 99_999_999n } },
  { name: "below_equal_is_miss", direction: B, level: L100, obs: { price: 100_000_000n } },
  {
    name: "below_conf_touches_level_miss",
    direction: B,
    level: L100,
    obs: { price: 99_900_000n, conf: 100_000n },
  },
  {
    name: "below_conf_clears_level_hit",
    direction: B,
    level: L100,
    obs: { price: 99_800_000n, conf: 199_999n },
  },
  { name: "expo_diff_hit", direction: A, level: L100, obs: { price: 10_000_000_001n, expo: -8 } },
  {
    name: "expo_diff_equal_miss",
    direction: A,
    level: L100,
    obs: { price: 10_000_000_000n, expo: -8 },
  },
  { name: "obs_expo_zero_hit", direction: A, level: L100, obs: { price: 101n, expo: 0 } },
  { name: "obs_expo_positive_equal_miss", direction: A, level: L100, obs: { price: 1n, expo: 2 } },
  { name: "obs_expo_positive_hit", direction: A, level: L100, obs: { price: 2n, expo: 2 } },
  {
    name: "level_min_expo_large_diff_hit",
    direction: A,
    level: [I64_MAX, -18],
    obs: { price: 9n, expo: 1 },
  },
  {
    name: "extreme_diff_obs_expo_30_hit",
    direction: A,
    level: [1n, -18],
    obs: { price: 1n, expo: 30 },
  },
  {
    name: "extreme_diff_obs_expo_minus_30_below_hit",
    direction: B,
    level: [1n, 0],
    obs: { price: I64_MAX, expo: -30 },
  },
  {
    name: "max_price_equal_level_miss",
    direction: A,
    level: [I64_MAX, -8],
    obs: { price: I64_MAX, expo: -8 },
  },
  {
    name: "max_price_large_conf_below_miss",
    direction: B,
    level: [I64_MAX, -8],
    obs: { price: I64_MAX, conf: 46_116_860_184_273_879n, expo: -8 },
  },
  {
    name: "conf_exactly_50bps_accepted",
    direction: A,
    level: L100,
    obs: { price: 100_000_000n, conf: 500_000n },
  },
  {
    name: "conf_over_50bps_rejected",
    direction: A,
    level: L100,
    obs: { price: 100_000_000n, conf: 500_001n },
  },
  { name: "window_end_accepted", direction: A, level: L100, obs: { publishTime: E + 10n } },
  {
    name: "before_expiry_rejected",
    direction: A,
    level: L100,
    obs: { publishTime: E - 1n, prevPublishTime: E - 2n },
  },
  { name: "after_window_rejected", direction: A, level: L100, obs: { publishTime: E + 11n } },
  {
    name: "not_unique_prev_equals_expiry",
    direction: A,
    level: L100,
    obs: { publishTime: E + 5n, prevPublishTime: E },
  },
  {
    name: "not_unique_prev_after_expiry",
    direction: A,
    level: L100,
    obs: { publishTime: E + 5n, prevPublishTime: E + 3n },
  },
  { name: "feed_mismatch", direction: A, level: L100, obs: { feedId: OTHER_FEED } },
  {
    name: "feed_mismatch_checked_before_window",
    direction: A,
    level: L100,
    obs: { feedId: OTHER_FEED, publishTime: E + 99n },
  },
  { name: "zero_price", direction: A, level: L100, obs: { price: 0n } },
  { name: "negative_price", direction: A, level: L100, obs: { price: -5n } },
  {
    name: "negative_conf",
    direction: A,
    level: L100,
    obs: { conf: -1n },
    rustSkip: "Pyth conf is u64 on-chain",
  },
  { name: "expo_below_range", direction: A, level: L100, obs: { expo: -31 } },
  { name: "expo_above_range", direction: A, level: L100, obs: { expo: 31 } },
  {
    name: "expiry_near_i64_max_window_saturates",
    direction: A,
    level: L100,
    expiryTs: I64_MAX - 5n,
    obs: { publishTime: I64_MAX, prevPublishTime: I64_MAX - 6n },
  },
];

export function buildSettlementVectors(): unknown {
  const cases = CASES.map((c) => {
    const expiryTs = c.expiryTs ?? E;
    const call: CallV1 = {
      version: SEAL_VERSION_V1,
      agent: AGENT,
      feedId: FEED,
      direction: c.direction,
      level: { mantissa: c.level[0], expo: c.level[1] },
      expiryTs,
    };
    const obs: OracleObservation = {
      feedId: FEED,
      price: 101_000_000n,
      conf: 0n,
      expo: -6,
      publishTime: expiryTs,
      prevPublishTime: expiryTs - 1n,
      ...c.obs,
    };
    const r = decideOutcome(call, obs, SETTLEMENT_PARAMS);
    return {
      name: c.name,
      ...(c.rustSkip === undefined ? {} : { rustSkip: c.rustSkip }),
      call: {
        feedId: bytesToHex(call.feedId),
        direction: call.direction,
        levelMantissa: call.level.mantissa.toString(),
        levelExpo: call.level.expo,
        expiryTs: call.expiryTs.toString(),
      },
      observation: {
        feedId: bytesToHex(obs.feedId),
        price: obs.price.toString(),
        conf: obs.conf.toString(),
        expo: obs.expo,
        publishTime: obs.publishTime.toString(),
        prevPublishTime: obs.prevPublishTime.toString(),
      },
      expected: r.ok ? r.value : r.error.code,
    };
  });
  return {
    format: "ACM-SETTLEMENT-V1",
    provisional: true,
    note:
      "Reference results of the core settlement rule (decideOutcome) under the conservative default " +
      "params (Q9). The on-chain program must match every case. Synthetic feed ids only.",
    params: {
      settleWindowSecs: SETTLEMENT_PARAMS.settleWindowSecs.toString(),
      maxConfBps: SETTLEMENT_PARAMS.maxConfBps.toString(),
      allowedFeedIds: SETTLEMENT_PARAMS.allowedFeedIds.map(bytesToHex),
    },
    cases,
  };
}

export function settlementVectorsJson(): string {
  return JSON.stringify(buildSettlementVectors(), null, 2) + "\n";
}
