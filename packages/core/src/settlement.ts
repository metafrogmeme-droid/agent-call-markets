import { bytesEqual, type Bytes32 } from "./bytes.ts";
import { compareFixed, MAX_ABS_EXPO } from "./fixedpoint.ts";
import type { ProtocolParams } from "./params.ts";
import { err, ErrorCode, ok, type Result } from "./result.ts";
import { Direction, type CallV1 } from "./seal/schema.ts";

/**
 * One oracle price, oracle-agnostic. For Pyth: price, conf and expo of a price update, and its
 * publish time (unix seconds). `conf` uses the same exponent as `price`.
 */
export interface OracleObservation {
  readonly feedId: Bytes32;
  readonly price: bigint;
  readonly conf: bigint;
  readonly expo: number;
  readonly publishTime: bigint;
}

export const Outcome = { Hit: "HIT", Miss: "MISS" } as const;
export type Outcome = (typeof Outcome)[keyof typeof Outcome];

/**
 * The settlement rule. Core is the reference spec; the on-chain program mirrors it (M2).
 *
 * Rejections (fail closed, nothing is decided):
 * - observation feed differs from the committed feed
 * - publishTime outside [expiry, expiry + settleWindowSecs]
 * - exponent out of range, price <= 0, conf < 0
 * - conf / price > maxConfBps / 10000
 *
 * Decision (conservative, Q9): a HIT needs the whole confidence interval on the right side.
 * - ABOVE hits iff price - conf > level
 * - BELOW hits iff price + conf < level
 * Anything else, including equality, is a MISS.
 */
export function decideOutcome(
  call: CallV1,
  obs: OracleObservation,
  params: ProtocolParams,
): Result<Outcome> {
  if (!bytesEqual(obs.feedId, call.feedId)) {
    return err(ErrorCode.FeedMismatch, "observation feed does not match the committed feed");
  }
  if (
    obs.publishTime < call.expiryTs ||
    obs.publishTime > call.expiryTs + params.settleWindowSecs
  ) {
    return err(
      ErrorCode.ObservationOutsideWindow,
      "observation publishTime must be within [expiry, expiry + settleWindowSecs]",
    );
  }
  if (!Number.isInteger(obs.expo) || Math.abs(obs.expo) > MAX_ABS_EXPO) {
    return err(ErrorCode.InvalidExponent, "observation exponent out of range");
  }
  if (obs.price <= 0n) {
    return err(ErrorCode.NonPositivePrice, "observation price must be positive");
  }
  if (obs.conf < 0n) {
    return err(ErrorCode.NegativeConfidence, "observation confidence must not be negative");
  }
  if (obs.conf * 10_000n > params.maxConfBps * obs.price) {
    return err(ErrorCode.ConfidenceTooWide, "observation confidence interval is too wide");
  }

  const hit =
    call.direction === Direction.Above
      ? compareFixed({ mantissa: obs.price - obs.conf, expo: obs.expo }, call.level) > 0
      : compareFixed({ mantissa: obs.price + obs.conf, expo: obs.expo }, call.level) < 0;
  return ok(hit ? Outcome.Hit : Outcome.Miss);
}
