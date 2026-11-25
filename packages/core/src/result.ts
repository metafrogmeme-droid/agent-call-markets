/** Every failure the core can report. Adapters map their chain errors onto these codes. */
export const ErrorCode = {
  InvalidLength: "INVALID_LENGTH",
  InvalidHex: "INVALID_HEX",
  InvalidVersion: "INVALID_VERSION",
  InvalidDirection: "INVALID_DIRECTION",
  InvalidLevel: "INVALID_LEVEL",
  InvalidExponent: "INVALID_EXPONENT",
  ZeroAgent: "ZERO_AGENT",
  ZeroFeed: "ZERO_FEED",
  ZeroSalt: "ZERO_SALT",
  ZeroCommitment: "ZERO_COMMITMENT",
  FeedNotAllowed: "FEED_NOT_ALLOWED",
  InvalidParams: "INVALID_PARAMS",
  ExpiryTooSoon: "EXPIRY_TOO_SOON",
  ExpiryTooFar: "EXPIRY_TOO_FAR",
  OutOfRange: "OUT_OF_RANGE",
  WrongSigner: "WRONG_SIGNER",
  WrongStatus: "WRONG_STATUS",
  CommitmentMismatch: "COMMITMENT_MISMATCH",
  ExpiryMismatch: "EXPIRY_MISMATCH",
  AgentMismatch: "AGENT_MISMATCH",
  RevealTooEarly: "REVEAL_TOO_EARLY",
  RevealDeadlinePassed: "REVEAL_DEADLINE_PASSED",
  MarketAlreadyOpen: "MARKET_ALREADY_OPEN",
  MarketNotOpen: "MARKET_NOT_OPEN",
  TradingClosed: "TRADING_CLOSED",
  InvalidAmount: "INVALID_AMOUNT",
  LimitNotMet: "LIMIT_NOT_MET",
  InsufficientBalance: "INSUFFICIENT_BALANCE",
  NotExpired: "NOT_EXPIRED",
  SettlementWindowClosed: "SETTLEMENT_WINDOW_CLOSED",
  AlreadySettled: "ALREADY_SETTLED",
  AlreadyVoid: "ALREADY_VOID",
  VoidTooEarly: "VOID_TOO_EARLY",
  FeedMismatch: "FEED_MISMATCH",
  ObservationOutsideWindow: "OBSERVATION_OUTSIDE_WINDOW",
  ObservationNotUnique: "OBSERVATION_NOT_UNIQUE",
  NonPositivePrice: "NON_POSITIVE_PRICE",
  NegativeConfidence: "NEGATIVE_CONFIDENCE",
  ConfidenceTooWide: "CONFIDENCE_TOO_WIDE",
  NotRedeemable: "NOT_REDEEMABLE",
  NothingToRedeem: "NOTHING_TO_REDEEM",
  UnknownCall: "UNKNOWN_CALL",
  UnknownMarket: "UNKNOWN_MARKET",
  DuplicateCall: "DUPLICATE_CALL",
  ReadOnly: "READ_ONLY",
  UnsupportedOracleRef: "UNSUPPORTED_ORACLE_REF",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class CoreError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CoreError";
    this.code = code;
  }
}

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: CoreError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(code: ErrorCode, message: string): Result<T> {
  return { ok: false, error: new CoreError(code, message) };
}

/** Returns the value or throws the CoreError. For callers that prefer exceptions (adapters). */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw result.error;
}
