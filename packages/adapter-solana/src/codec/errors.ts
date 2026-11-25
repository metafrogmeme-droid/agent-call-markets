import { isSolanaError, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM } from "@solana/kit";
import { CoreError, ErrorCode } from "@agent-call-markets/core";
import { PROGRAM_ERROR_OFFSET, PROGRAM_ERRORS, type ProgramErrorName } from "./program.ts";

/**
 * Program error → core ErrorCode. Names match the core's codes wherever the rule is shared
 * (programs/call_markets/src/error.rs); the rest map to the adapter codes added in M4.
 */
export const PROGRAM_ERROR_TO_CORE: Readonly<Record<ProgramErrorName, ErrorCode>> = Object.freeze({
  InvalidParams: ErrorCode.InvalidParams,
  InvalidFeedList: ErrorCode.InvalidFeedList,
  Unauthorized: ErrorCode.Unauthorized,
  ZeroCommitment: ErrorCode.ZeroCommitment,
  ExpiryTooSoon: ErrorCode.ExpiryTooSoon,
  ExpiryTooFar: ErrorCode.ExpiryTooFar,
  WrongSigner: ErrorCode.WrongSigner,
  WrongStatus: ErrorCode.WrongStatus,
  RevealTooEarly: ErrorCode.RevealTooEarly,
  RevealDeadlinePassed: ErrorCode.RevealDeadlinePassed,
  CommitmentMismatch: ErrorCode.CommitmentMismatch,
  InvalidDirection: ErrorCode.InvalidDirection,
  ZeroFeed: ErrorCode.ZeroFeed,
  ZeroSalt: ErrorCode.ZeroSalt,
  InvalidLevel: ErrorCode.InvalidLevel,
  InvalidExponent: ErrorCode.InvalidExponent,
  FeedNotAllowed: ErrorCode.FeedNotAllowed,
  MarketAlreadyOpen: ErrorCode.MarketAlreadyOpen,
  TradingClosed: ErrorCode.TradingClosed,
  NotExpired: ErrorCode.NotExpired,
  SettlementWindowClosed: ErrorCode.SettlementWindowClosed,
  AlreadySettled: ErrorCode.AlreadySettled,
  AlreadyVoid: ErrorCode.AlreadyVoid,
  VoidTooEarly: ErrorCode.VoidTooEarly,
  OracleNotFullyVerified: ErrorCode.OracleNotVerified,
  FeedMismatch: ErrorCode.FeedMismatch,
  ObservationOutsideWindow: ErrorCode.ObservationOutsideWindow,
  ObservationNotUnique: ErrorCode.ObservationNotUnique,
  NonPositivePrice: ErrorCode.NonPositivePrice,
  ConfidenceTooWide: ErrorCode.ConfidenceTooWide,
  OracleOwnerMismatch: ErrorCode.OracleOwnerMismatch,
  DuplicatePriceUpdate: ErrorCode.DuplicatePriceUpdate,
  WrongMint: ErrorCode.WrongMint,
  MarketNotOpen: ErrorCode.MarketNotOpen,
  InvalidAmount: ErrorCode.InvalidAmount,
  InvalidSide: ErrorCode.InvalidSide,
  LimitNotMet: ErrorCode.LimitNotMet,
  NotRedeemable: ErrorCode.NotRedeemable,
  NothingToRedeem: ErrorCode.NothingToRedeem,
});

/** SPL Token's `TokenError::InsufficientFunds`, surfaced through the program's CPI in `buy`. */
export const SPL_TOKEN_INSUFFICIENT_FUNDS = 1;

/**
 * A failed transaction, normalised by the transport: which instruction failed and, for custom
 * program errors, the code. `detail` keeps the raw error text for CHAIN_ERROR messages.
 */
export interface TxFailure {
  readonly instructionIndex: number | null;
  readonly customCode: number | null;
  readonly detail: string;
}

export function programErrorName(code: number): ProgramErrorName | null {
  const i = code - PROGRAM_ERROR_OFFSET;
  return i >= 0 && i < PROGRAM_ERRORS.length ? (PROGRAM_ERRORS[i] ?? null) : null;
}

/**
 * Maps a failure to a CoreError. `programIxIndices` are the indices of call_markets instructions
 * in the transaction (custom codes elsewhere belong to other programs); `buyIxIndices` mark `buy`
 * instructions, where SPL Token's code 1 means the buyer lacks test tokens.
 */
export function toCoreError(
  failure: TxFailure,
  programIxIndices: readonly number[],
  buyIxIndices: readonly number[] = [],
): CoreError {
  const { instructionIndex: ix, customCode: code } = failure;
  if (ix !== null && code !== null) {
    if (programIxIndices.includes(ix)) {
      const name = programErrorName(code);
      if (name !== null) return new CoreError(PROGRAM_ERROR_TO_CORE[name], `program error ${name}`);
      if (buyIxIndices.includes(ix) && code === SPL_TOKEN_INSUFFICIENT_FUNDS) {
        return new CoreError(ErrorCode.InsufficientBalance, "insufficient test-token balance");
      }
    }
  }
  return new CoreError(ErrorCode.ChainError, `transaction failed: ${failure.detail}`);
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(value);
  }
}

/** Normalises a raw RPC TransactionError (e.g. `{ InstructionError: [1, { Custom: 6021 }] }`). */
export function failureFromRawError(err: unknown): TxFailure {
  const detail = stringify(err);
  if (typeof err === "object" && err !== null && "InstructionError" in err) {
    const ie: unknown = err.InstructionError;
    if (Array.isArray(ie) && ie.length === 2) {
      const index = Number(ie[0]);
      const inner: unknown = ie[1];
      if (typeof inner === "object" && inner !== null && "Custom" in inner) {
        return {
          instructionIndex: index,
          customCode: Number(inner.Custom),
          detail,
        };
      }
      return { instructionIndex: index, customCode: null, detail };
    }
  }
  return { instructionIndex: null, customCode: null, detail };
}

/** Normalises a kit SolanaError (e.g. a preflight failure whose cause is the instruction error). */
export function failureFromSolanaError(e: unknown): TxFailure | null {
  let cur: unknown = e;
  let top: string | null = null;
  for (let depth = 0; depth < 6 && cur !== undefined && cur !== null; depth++) {
    if (isSolanaError(cur)) {
      top ??= cur.message;
      if (isSolanaError(cur, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) {
        return {
          instructionIndex: cur.context.index,
          customCode: cur.context.code,
          detail: `${top} (${cur.message})`,
        };
      }
      const ctx = cur.context as Record<string, unknown>;
      const next: unknown = cur.cause ?? ctx["cause"];
      if (next === undefined && typeof ctx["index"] === "number") {
        return {
          instructionIndex: ctx["index"],
          customCode: null,
          detail: `${top} (${cur.message})`,
        };
      }
      cur = next;
    } else {
      break;
    }
  }
  return top === null ? null : { instructionIndex: null, customCode: null, detail: top };
}
