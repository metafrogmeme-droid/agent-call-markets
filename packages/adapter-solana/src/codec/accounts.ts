import { getAddressEncoder, type Address } from "@solana/kit";
import {
  bytes32,
  CallStatus,
  CoreError,
  Direction,
  ErrorCode,
  Outcome,
  SEAL_VERSION_V1,
  Side,
  type Bytes32,
  type CallState,
  type CallV1,
  type MarketState,
  type Position as CorePosition,
  type ProtocolParams,
} from "@agent-call-markets/core";
import { OUTCOME, SIDE, STATUS } from "../constants.ts";
import { discriminator, startsWith } from "./discriminator.ts";
import { fixedSizeOf, structCodec, type StructOf } from "./layout.ts";
import { ACCOUNTS } from "./program.ts";

export type ConfigAccount = StructOf<typeof ACCOUNTS.Config>;
export type CallAccount = StructOf<typeof ACCOUNTS.Call>;
export type PositionAccount = StructOf<typeof ACCOUNTS.Position>;

export const ACCOUNT_DISCRIMINATOR = Object.freeze({
  Config: discriminator("account", "Config"),
  Call: discriminator("account", "Call"),
  Position: discriminator("account", "Position"),
});

/** Total on-chain sizes (8-byte discriminator + Borsh body), as `8 + T::INIT_SPACE` in Rust. */
export const ACCOUNT_SIZE = Object.freeze({
  Config: 8 + fixedSizeOf(ACCOUNTS.Config),
  Call: 8 + fixedSizeOf(ACCOUNTS.Call),
  Position: 8 + fixedSizeOf(ACCOUNTS.Position),
});

function decode<K extends keyof typeof ACCOUNTS>(
  kind: K,
  data: Uint8Array,
): StructOf<(typeof ACCOUNTS)[K]> {
  if (!startsWith(data, ACCOUNT_DISCRIMINATOR[kind]) || data.length < ACCOUNT_SIZE[kind]) {
    throw new CoreError(ErrorCode.ChainError, `account data is not a call_markets ${kind}`);
  }
  return structCodec(ACCOUNTS[kind]).decode(data, 8);
}

export const decodeConfig = (data: Uint8Array): ConfigAccount => decode("Config", data);
export const decodeCall = (data: Uint8Array): CallAccount => decode("Call", data);
export const decodePosition = (data: Uint8Array): PositionAccount => decode("Position", data);

export function addressToBytes32(a: Address): Bytes32 {
  return bytes32(Uint8Array.from(getAddressEncoder().encode(a)));
}

const b32 = (bytes: ArrayLike<number>): Bytes32 => bytes32(Uint8Array.from(bytes));

/** The on-chain Config as core ProtocolParams (the same values the program enforces). */
export function configToParams(c: ConfigAccount): ProtocolParams {
  const count = Math.min(c.feed_count, c.allowed_feed_ids.length);
  return {
    revealWindowSecs: c.reveal_window_secs,
    minLeadSecs: c.min_lead_secs,
    maxHorizonSecs: c.max_horizon_secs,
    tradeCutoffSecs: c.trade_cutoff_secs,
    settleWindowSecs: c.settle_window_secs,
    maxConfBps: BigInt(c.max_conf_bps),
    voidAfterSecs: c.void_after_secs,
    minLevelExpo: c.min_level_expo,
    maxLevelExpo: c.max_level_expo,
    allowedFeedIds: c.allowed_feed_ids.slice(0, count).map(b32),
  };
}

export function sideFromByte(side: number): Side {
  if (side === SIDE.yes) return Side.Yes;
  if (side === SIDE.no) return Side.No;
  throw new CoreError(ErrorCode.ChainError, `unexpected side byte ${side}`);
}

export function sideToByte(side: Side): number {
  return side === Side.Yes ? SIDE.yes : SIDE.no;
}

function statusFromByte(status: number): CallStatus {
  switch (status) {
    case STATUS.sealed:
      return CallStatus.Sealed;
    case STATUS.revealed:
      return CallStatus.Revealed;
    case STATUS.settled:
      return CallStatus.Settled;
    case STATUS.void:
      return CallStatus.Void;
    default:
      throw new CoreError(ErrorCode.ChainError, `unexpected call status byte ${status}`);
  }
}

function directionFromByte(direction: number): Direction {
  if (direction === Direction.Above || direction === Direction.Below) return direction;
  throw new CoreError(ErrorCode.ChainError, `unexpected direction byte ${direction}`);
}

export function positionToCore(p: PositionAccount): CorePosition {
  return {
    owner: addressToBytes32(p.owner),
    side: sideFromByte(p.side),
    amount: p.amount,
    redeemed: p.redeemed,
  };
}

/**
 * Maps a Call account (plus its positions) to the core CallState, so the core can recompute the
 * record and re-derive outcomes from chain data only.
 */
export function callToState(c: CallAccount, positions: readonly PositionAccount[]): CallState {
  const status = statusFromByte(c.status);
  const agent = addressToBytes32(c.agent);
  const revealed = status !== CallStatus.Sealed;
  const decided = status === CallStatus.Settled || status === CallStatus.Void;
  const call: CallV1 | null = revealed
    ? {
        version: SEAL_VERSION_V1,
        agent,
        feedId: b32(c.feed_id),
        direction: directionFromByte(c.direction),
        level: { mantissa: c.level_mantissa, expo: c.level_expo },
        expiryTs: c.expiry_ts,
      }
    : null;
  const market: MarketState | null = c.market_open
    ? {
        openedTs: c.market_opened_ts,
        pool: { yes: c.pool_yes, no: c.pool_no },
        positions: positions.map(positionToCore),
      }
    : null;
  let outcome: Outcome | null = null;
  if (status === CallStatus.Settled) {
    if (c.outcome === OUTCOME.hit) outcome = Outcome.Hit;
    else if (c.outcome === OUTCOME.miss) outcome = Outcome.Miss;
    else throw new CoreError(ErrorCode.ChainError, `settled call without outcome (${c.outcome})`);
  }
  return {
    agent,
    commitment: b32(c.commitment),
    sealTs: c.seal_ts,
    expiryTs: c.expiry_ts,
    revealDeadlineTs: c.reveal_deadline_ts,
    status,
    call,
    salt: revealed ? b32(c.salt) : null,
    revealTs: revealed ? c.reveal_ts : null,
    market,
    outcome,
    observation:
      status === CallStatus.Settled
        ? {
            feedId: b32(c.feed_id),
            price: c.obs_price,
            conf: c.obs_conf,
            expo: c.obs_expo,
            publishTime: c.obs_publish_time,
            prevPublishTime: c.obs_prev_publish_time,
          }
        : null,
    settledTs: decided ? c.settled_ts : null,
  };
}
