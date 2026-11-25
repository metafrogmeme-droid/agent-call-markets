import { bytesEqual, isZero, type Bytes32 } from "./bytes.ts";
import {
  addStake,
  EMPTY_POOL,
  payout,
  quote,
  Resolution,
  resolutionFor,
  type Pool,
  type Side,
} from "./parimutuel.ts";
import type { ProtocolParams } from "./params.ts";
import { err, ErrorCode, ok, type Result } from "./result.ts";
import { verifyReveal } from "./seal/commit.ts";
import type { CallV1 } from "./seal/schema.ts";
import { validateCall } from "./seal/validate.ts";
import { decideOutcome, Outcome, sameObservation, type OracleObservation } from "./settlement.ts";

/**
 * Lifecycle of one sealed call and its (optional) market. Pure functions: each transition takes
 * the current state and returns a new one or an error; nothing is mutated.
 *
 *   SEALED --reveal--> REVEALED --settle--> SETTLED (HIT | MISS)
 *                          \-------void----> VOID (refunds)
 *   SEALED past its reveal deadline stays SEALED and counts as a MISS in the record (Q5).
 */
export const CallStatus = {
  Sealed: "SEALED",
  Revealed: "REVEALED",
  Settled: "SETTLED",
  Void: "VOID",
} as const;
export type CallStatus = (typeof CallStatus)[keyof typeof CallStatus];

export interface Position {
  readonly owner: Bytes32;
  readonly side: Side;
  readonly amount: bigint;
  readonly redeemed: boolean;
}

export interface MarketState {
  readonly openedTs: bigint;
  readonly pool: Pool;
  /** One entry per (owner, side); stakes accumulate. */
  readonly positions: readonly Position[];
}

export interface CallState {
  readonly agent: Bytes32;
  readonly commitment: Bytes32;
  readonly sealTs: bigint;
  readonly expiryTs: bigint;
  readonly revealDeadlineTs: bigint;
  readonly status: CallStatus;
  readonly call: CallV1 | null;
  /** Public after reveal so anyone can re-check the commitment. */
  readonly salt: Bytes32 | null;
  readonly revealTs: bigint | null;
  readonly market: MarketState | null;
  readonly outcome: Outcome | null;
  readonly observation: OracleObservation | null;
  readonly settledTs: bigint | null;
}

export function sealCall(
  input: { readonly agent: Bytes32; readonly commitment: Bytes32; readonly expiryTs: bigint },
  now: bigint,
  params: ProtocolParams,
): Result<CallState> {
  if (input.agent.length !== 32 || isZero(input.agent)) {
    return err(ErrorCode.ZeroAgent, "agent must be a non-zero 32-byte key");
  }
  if (input.commitment.length !== 32 || isZero(input.commitment)) {
    return err(ErrorCode.ZeroCommitment, "commitment must be a non-zero 32-byte hash");
  }
  const lead = input.expiryTs - now;
  if (lead < params.minLeadSecs) {
    return err(
      ErrorCode.ExpiryTooSoon,
      `expiry must be at least ${params.minLeadSecs}s after seal`,
    );
  }
  if (lead > params.maxHorizonSecs) {
    return err(
      ErrorCode.ExpiryTooFar,
      `expiry must be at most ${params.maxHorizonSecs}s after seal`,
    );
  }
  return ok({
    agent: input.agent,
    commitment: input.commitment,
    sealTs: now,
    expiryTs: input.expiryTs,
    revealDeadlineTs: now + params.revealWindowSecs,
    status: CallStatus.Sealed,
    call: null,
    salt: null,
    revealTs: null,
    market: null,
    outcome: null,
    observation: null,
    settledTs: null,
  });
}

export function revealCall(
  state: CallState,
  input: { readonly signer: Bytes32; readonly call: CallV1; readonly salt: Bytes32 },
  now: bigint,
  params: ProtocolParams,
): Result<CallState> {
  if (state.status !== CallStatus.Sealed) {
    return err(ErrorCode.WrongStatus, `cannot reveal a call in status ${state.status}`);
  }
  if (!bytesEqual(input.signer, state.agent)) {
    return err(ErrorCode.WrongSigner, "only the sealing agent can reveal");
  }
  if (now <= state.sealTs) {
    return err(ErrorCode.RevealTooEarly, "reveal must come strictly after the seal");
  }
  if (now > state.revealDeadlineTs) {
    return err(
      ErrorCode.RevealDeadlinePassed,
      "reveal deadline has passed; the call counts as a miss",
    );
  }
  if (!bytesEqual(input.call.agent, state.agent)) {
    return err(ErrorCode.AgentMismatch, "revealed agent differs from the sealing agent");
  }
  if (input.call.expiryTs !== state.expiryTs) {
    return err(ErrorCode.ExpiryMismatch, "revealed expiry differs from the sealed expiry");
  }
  if (!verifyReveal(state.commitment, input.call, input.salt)) {
    return err(ErrorCode.CommitmentMismatch, "call and salt do not open the commitment");
  }
  const valid = validateCall(input.call, input.salt, params);
  if (!valid.ok) return valid;
  return ok({
    ...state,
    status: CallStatus.Revealed,
    call: input.call,
    salt: input.salt,
    revealTs: now,
  });
}

function tradingOpen(state: CallState, now: bigint, params: ProtocolParams): boolean {
  return now < state.expiryTs - params.tradeCutoffSecs;
}

export function openMarket(
  state: CallState,
  now: bigint,
  params: ProtocolParams,
): Result<CallState> {
  if (state.status !== CallStatus.Revealed) {
    return err(ErrorCode.WrongStatus, "a market opens only on a revealed, unsettled call");
  }
  if (state.market !== null) return err(ErrorCode.MarketAlreadyOpen, "market already open");
  if (!tradingOpen(state, now, params)) {
    return err(ErrorCode.TradingClosed, "too close to expiry to open a market");
  }
  return ok({ ...state, market: { openedTs: now, pool: EMPTY_POOL, positions: [] } });
}

export function placeTrade(
  state: CallState,
  input: {
    readonly owner: Bytes32;
    readonly side: Side;
    readonly amount: bigint;
    /** Reject if the projected payout (no later trades) is below this. 0n disables. */
    readonly minProjectedPayout: bigint;
  },
  now: bigint,
  params: ProtocolParams,
): Result<CallState> {
  const market = state.market;
  if (market === null) return err(ErrorCode.MarketNotOpen, "market is not open");
  if (state.status !== CallStatus.Revealed || !tradingOpen(state, now, params)) {
    return err(ErrorCode.TradingClosed, "trading is closed");
  }
  if (input.owner.length !== 32 || isZero(input.owner)) {
    return err(ErrorCode.WrongSigner, "trader must be a non-zero 32-byte key");
  }
  const q = quote(market.pool, input.side, input.amount);
  if (!q.ok) return q;
  if (q.value.projectedPayout < input.minProjectedPayout) {
    return err(ErrorCode.LimitNotMet, "projected payout is below the limit");
  }
  const pool = addStake(market.pool, input.side, input.amount);
  if (!pool.ok) return pool;

  const idx = market.positions.findIndex(
    (p) => p.side === input.side && bytesEqual(p.owner, input.owner),
  );
  const positions =
    idx === -1
      ? [
          ...market.positions,
          { owner: input.owner, side: input.side, amount: input.amount, redeemed: false },
        ]
      : market.positions.map((p, i) => (i === idx ? { ...p, amount: p.amount + input.amount } : p));
  return ok({ ...state, market: { ...market, pool: pool.value, positions } });
}

export function settleCall(
  state: CallState,
  observation: OracleObservation,
  now: bigint,
  params: ProtocolParams,
): Result<CallState> {
  // Exactly one accepted price update per market: once settled, presenting the same update again
  // is a duplicate and any other update is rejected; the outcome never changes.
  if (state.status === CallStatus.Settled) {
    if (state.observation !== null && sameObservation(state.observation, observation)) {
      return err(ErrorCode.DuplicatePriceUpdate, "this price update was already accepted");
    }
    return err(ErrorCode.AlreadySettled, "already settled with another price update");
  }
  if (state.status === CallStatus.Void) return err(ErrorCode.AlreadyVoid, "already void");
  if (state.status !== CallStatus.Revealed || state.call === null) {
    return err(ErrorCode.WrongStatus, "only a revealed call can be settled");
  }
  if (now < state.expiryTs) return err(ErrorCode.NotExpired, "call has not expired yet");
  if (now >= state.expiryTs + params.voidAfterSecs) {
    return err(
      ErrorCode.SettlementWindowClosed,
      "settlement window closed; the call can only be voided",
    );
  }
  if (observation.publishTime > now) {
    return err(ErrorCode.ObservationOutsideWindow, "observation is from the future");
  }
  const outcome = decideOutcome(state.call, observation, params);
  if (!outcome.ok) return outcome;
  return ok({
    ...state,
    status: CallStatus.Settled,
    outcome: outcome.value,
    observation,
    settledTs: now,
  });
}

export function voidCall(state: CallState, now: bigint, params: ProtocolParams): Result<CallState> {
  if (state.status === CallStatus.Settled) return err(ErrorCode.AlreadySettled, "already settled");
  if (state.status === CallStatus.Void) return err(ErrorCode.AlreadyVoid, "already void");
  if (state.status !== CallStatus.Revealed) {
    return err(ErrorCode.WrongStatus, "only a revealed call can be voided");
  }
  if (now < state.expiryTs + params.voidAfterSecs) {
    return err(ErrorCode.VoidTooEarly, "void is only possible after expiry + voidAfterSecs");
  }
  return ok({ ...state, status: CallStatus.Void, settledTs: now });
}

/** Pays out every unredeemed position of `owner`. Each position can be redeemed once. */
export function redeem(
  state: CallState,
  owner: Bytes32,
): Result<{ state: CallState; amount: bigint }> {
  const market = state.market;
  if (market === null) return err(ErrorCode.NotRedeemable, "no market on this call");
  let resolution: Resolution;
  if (state.status === CallStatus.Void) {
    resolution = Resolution.Void;
  } else if (state.status === CallStatus.Settled && state.outcome !== null) {
    resolution = resolutionFor(state.outcome);
  } else {
    return err(ErrorCode.NotRedeemable, "market is not settled or void");
  }
  let amount = 0n;
  let found = 0;
  const positions: Position[] = [];
  for (const p of market.positions) {
    if (p.redeemed || !bytesEqual(p.owner, owner)) {
      positions.push(p);
      continue;
    }
    found++;
    amount += payout(p.side, p.amount, market.pool, resolution);
    positions.push({ ...p, redeemed: true });
  }
  if (found === 0) return err(ErrorCode.NothingToRedeem, "no unredeemed position for this owner");
  return ok({ state: { ...state, market: { ...market, positions } }, amount });
}

/** How a call counts in the public record at time `now`. */
export const RecordStatus = {
  PendingReveal: "PENDING_REVEAL",
  UnrevealedMiss: "UNREVEALED_MISS",
  PendingOutcome: "PENDING_OUTCOME",
  Hit: "HIT",
  Miss: "MISS",
  Void: "VOID",
} as const;
export type RecordStatus = (typeof RecordStatus)[keyof typeof RecordStatus];

export function recordStatus(state: CallState, now: bigint): RecordStatus {
  switch (state.status) {
    case CallStatus.Sealed:
      return now > state.revealDeadlineTs
        ? RecordStatus.UnrevealedMiss
        : RecordStatus.PendingReveal;
    case CallStatus.Revealed:
      return RecordStatus.PendingOutcome;
    case CallStatus.Settled:
      return state.outcome === Outcome.Hit ? RecordStatus.Hit : RecordStatus.Miss;
    case CallStatus.Void:
      return RecordStatus.Void;
  }
}
