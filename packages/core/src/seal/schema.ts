import type { Bytes32 } from "../bytes.ts";

/**
 * Seal format ACM-SEAL-V1 (provisional, see docs/DECISIONS.md, Q6).
 * This is our own format. It is NOT claimed to be compatible with HashKey Seal / Proof of Call.
 * The version byte and domain tag let a later version map to that spec.
 */
export const SEAL_VERSION_V1 = 1;
export const SEAL_DOMAIN_TAG = "ACM-SEAL-V1";

/** Byte layout of the v1 preimage (fixed width, big-endian). */
export const SEAL_V1_LAYOUT = Object.freeze({
  version: { offset: 0, size: 1 },
  agent: { offset: 1, size: 32 },
  feedId: { offset: 33, size: 32 },
  direction: { offset: 65, size: 1 },
  levelMantissa: { offset: 66, size: 8 },
  levelExpo: { offset: 74, size: 4 },
  expiryTs: { offset: 78, size: 8 },
  salt: { offset: 86, size: 32 },
});
export const SEAL_V1_PREIMAGE_LENGTH = 118;

export const Direction = {
  /** Hit if the settlement price is strictly above the level. */
  Above: 1,
  /** Hit if the settlement price is strictly below the level. */
  Below: 2,
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

export function isDirection(value: number): value is Direction {
  return value === Direction.Above || value === Direction.Below;
}

/** A decimal number as mantissa * 10^expo (the same form Pyth prices use). */
export interface FixedPoint {
  readonly mantissa: bigint;
  readonly expo: number;
}

/** The public content of a call. The salt is kept separately until reveal. */
export interface CallV1 {
  readonly version: typeof SEAL_VERSION_V1;
  /** Chain-native agent key (Solana pubkey; EVM address left-padded to 32 bytes). */
  readonly agent: Bytes32;
  /** Oracle price feed id (Pyth feed ids are 32 bytes). */
  readonly feedId: Bytes32;
  readonly direction: Direction;
  readonly level: FixedPoint;
  /** Unix seconds. */
  readonly expiryTs: bigint;
}
