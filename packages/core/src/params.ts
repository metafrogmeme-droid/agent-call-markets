import { bytesToHex, type Bytes32 } from "./bytes.ts";
import { err, ErrorCode, ok, type Result } from "./result.ts";

/**
 * Protocol parameters. Immutable values passed in by the caller; there is no setter.
 * All durations are seconds. On-chain, the same values are fixed at program init (M2).
 */
export interface ProtocolParams {
  /** Seal -> reveal deadline. A call not revealed by then counts as a MISS. */
  readonly revealWindowSecs: bigint;
  /** Minimum time between seal and expiry. */
  readonly minLeadSecs: bigint;
  /** Maximum time between seal and expiry. */
  readonly maxHorizonSecs: bigint;
  /** No trading in the last `tradeCutoffSecs` before expiry. */
  readonly tradeCutoffSecs: bigint;
  /** Settlement observation must have publishTime in [expiry, expiry + settleWindowSecs]. */
  readonly settleWindowSecs: bigint;
  /** Reject an observation whose conf / price exceeds this many basis points. */
  readonly maxConfBps: bigint;
  /** After expiry + voidAfterSecs an unsettled call can only be voided (refunds). */
  readonly voidAfterSecs: bigint;
  /** Allowed level exponent range (inclusive). */
  readonly minLevelExpo: number;
  readonly maxLevelExpo: number;
  /** Price feeds a call may reference. Empty means no call can be revealed. */
  readonly allowedFeedIds: readonly Bytes32[];
}

/**
 * Conservative defaults, provisional until open question Q9 is answered (see docs/DECISIONS.md).
 * `allowedFeedIds` is deliberately empty: callers must list feeds explicitly (Q4).
 */
export const DEFAULT_PARAMS: ProtocolParams = Object.freeze({
  revealWindowSecs: 900n,
  minLeadSecs: 3_600n,
  maxHorizonSecs: 2_592_000n,
  tradeCutoffSecs: 600n,
  settleWindowSecs: 10n,
  maxConfBps: 50n,
  voidAfterSecs: 259_200n,
  minLevelExpo: -18,
  maxLevelExpo: 0,
  allowedFeedIds: Object.freeze([]),
});

export function validateParams(p: ProtocolParams): Result<ProtocolParams> {
  const positive: (keyof ProtocolParams)[] = [
    "revealWindowSecs",
    "minLeadSecs",
    "maxHorizonSecs",
    "tradeCutoffSecs",
    "settleWindowSecs",
    "maxConfBps",
    "voidAfterSecs",
  ];
  for (const key of positive) {
    const value = p[key];
    if (typeof value !== "bigint" || value <= 0n) {
      return err(ErrorCode.InvalidParams, `${key} must be a positive bigint`);
    }
  }
  if (p.minLeadSecs <= p.revealWindowSecs + p.tradeCutoffSecs) {
    return err(
      ErrorCode.InvalidParams,
      "minLeadSecs must exceed revealWindowSecs + tradeCutoffSecs",
    );
  }
  if (p.maxHorizonSecs < p.minLeadSecs) {
    return err(ErrorCode.InvalidParams, "maxHorizonSecs must be >= minLeadSecs");
  }
  if (p.maxConfBps > 10_000n) {
    return err(ErrorCode.InvalidParams, "maxConfBps must be <= 10000");
  }
  if (p.voidAfterSecs <= p.settleWindowSecs) {
    return err(ErrorCode.InvalidParams, "voidAfterSecs must exceed settleWindowSecs");
  }
  if (
    !Number.isInteger(p.minLevelExpo) ||
    !Number.isInteger(p.maxLevelExpo) ||
    p.minLevelExpo > p.maxLevelExpo ||
    p.minLevelExpo < -30 ||
    p.maxLevelExpo > 30
  ) {
    return err(ErrorCode.InvalidParams, "level exponent range must be integers within [-30, 30]");
  }
  const seen = new Set<string>();
  for (const feed of p.allowedFeedIds) {
    if (feed.length !== 32)
      return err(ErrorCode.InvalidParams, "allowed feed ids must be 32 bytes");
    const hex = bytesToHex(feed);
    if (seen.has(hex)) return err(ErrorCode.InvalidParams, "duplicate allowed feed id");
    seen.add(hex);
  }
  return ok(p);
}
