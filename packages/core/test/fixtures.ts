// Synthetic test identities and helpers. None of these are real keys, agents or Pyth feed ids.
import {
  bytes32,
  DEFAULT_PARAMS,
  Direction,
  SEAL_VERSION_V1,
  type Bytes32,
  type CallV1,
  type ProtocolParams,
} from "../src/index.ts";

export const AGENT = bytes32("a1".repeat(32));
export const OTHER = bytes32("b2".repeat(32));
export const FEED = bytes32("f1".repeat(32));
export const OTHER_FEED = bytes32("f2".repeat(32));
export const SALT = bytes32("5a".repeat(32));
export const T0 = 1_800_000_000n;

export const PARAMS: ProtocolParams = { ...DEFAULT_PARAMS, allowedFeedIds: [FEED] };

export function makeCall(overrides: Partial<CallV1> = {}): CallV1 {
  return {
    version: SEAL_VERSION_V1,
    agent: AGENT,
    feedId: FEED,
    direction: Direction.Above,
    level: { mantissa: 100_000_000n, expo: -6 },
    expiryTs: T0 + PARAMS.minLeadSecs,
    ...overrides,
  };
}

export function withByte(b: Bytes32, index: number, value: number): Bytes32 {
  const copy = Uint8Array.from(b);
  copy[index] = value;
  return bytes32(copy);
}
