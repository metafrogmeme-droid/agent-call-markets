import type { Fields } from "./layout.ts";

/**
 * Layouts of the call_markets program, mirroring programs/call_markets/src (instruction account
 * structs, #[account] structs, #[event] structs, #[error_code]). Names and order follow the
 * generated IDL; test/unit/idl.test.ts fails if they drift apart.
 */

/** Instruction account flags: w = writable, s = signer. */
export interface IxAccount {
  readonly name: string;
  readonly w: boolean;
  readonly s: boolean;
}

export interface IxLayout {
  readonly name: string;
  readonly accounts: readonly IxAccount[];
  readonly args: Fields;
}

const acc = (name: string, flags = ""): IxAccount => ({
  name,
  w: flags.includes("w"),
  s: flags.includes("s"),
});

export const DEFINED_TYPES = {
  ConfigArgs: [
    ["reveal_window_secs", "i64"],
    ["min_lead_secs", "i64"],
    ["max_horizon_secs", "i64"],
    ["trade_cutoff_secs", "i64"],
    ["settle_window_secs", "i64"],
    ["max_conf_bps", "u16"],
    ["void_after_secs", "i64"],
    ["min_level_expo", "i32"],
    ["max_level_expo", "i32"],
    ["allowed_feed_ids", { vec: { array: ["u8", 32] } }],
  ],
  RevealArgs: [
    ["feed_id", { array: ["u8", 32] }],
    ["direction", "u8"],
    ["level_mantissa", "i64"],
    ["level_expo", "i32"],
    ["salt", { array: ["u8", 32] }],
  ],
} as const satisfies Record<string, Fields>;

export const INSTRUCTIONS = {
  initializeConfig: {
    name: "initialize_config",
    accounts: [
      acc("authority", "ws"),
      acc("config", "w"),
      acc("program_data"),
      acc("collateral_mint"),
      acc("system_program"),
    ],
    args: DEFINED_TYPES.ConfigArgs,
  },
  sealCall: {
    name: "seal_call",
    accounts: [acc("agent", "ws"), acc("config"), acc("call", "w"), acc("system_program")],
    args: [
      ["commitment", { array: ["u8", 32] }],
      ["expiry_ts", "i64"],
    ],
  },
  revealCall: {
    name: "reveal_call",
    accounts: [acc("agent", "s"), acc("config"), acc("call", "w")],
    args: DEFINED_TYPES.RevealArgs,
  },
  openMarket: {
    name: "open_market",
    accounts: [
      acc("opener", "ws"),
      acc("config"),
      acc("call", "w"),
      acc("collateral_mint"),
      acc("vault", "w"),
      acc("token_program"),
      acc("system_program"),
    ],
    args: [],
  },
  openPosition: {
    name: "open_position",
    accounts: [acc("owner", "ws"), acc("call"), acc("position", "w"), acc("system_program")],
    args: [["side", "u8"]],
  },
  buy: {
    name: "buy",
    accounts: [
      acc("buyer", "s"),
      acc("config"),
      acc("call", "w"),
      acc("collateral_mint"),
      acc("vault", "w"),
      acc("buyer_token", "w"),
      acc("position", "w"),
      acc("token_program"),
    ],
    args: [
      ["amount", "u64"],
      ["min_projected_payout", "u64"],
    ],
  },
  redeem: {
    name: "redeem",
    accounts: [
      acc("owner", "s"),
      acc("config"),
      acc("call"),
      acc("collateral_mint"),
      acc("vault", "w"),
      acc("owner_token", "w"),
      acc("position", "w"),
      acc("token_program"),
    ],
    args: [],
  },
  settle: {
    name: "settle",
    accounts: [acc("settler", "s"), acc("config"), acc("call", "w"), acc("price_update")],
    args: [],
  },
  voidUnsettled: {
    name: "void_unsettled",
    accounts: [acc("caller", "s"), acc("config"), acc("call", "w")],
    args: [],
  },
} as const satisfies Record<string, IxLayout>;

export const ACCOUNTS = {
  Config: [
    ["bump", "u8"],
    ["reveal_window_secs", "i64"],
    ["min_lead_secs", "i64"],
    ["max_horizon_secs", "i64"],
    ["trade_cutoff_secs", "i64"],
    ["settle_window_secs", "i64"],
    ["max_conf_bps", "u16"],
    ["void_after_secs", "i64"],
    ["min_level_expo", "i32"],
    ["max_level_expo", "i32"],
    ["feed_count", "u8"],
    ["allowed_feed_ids", { array: [{ array: ["u8", 32] }, 8] }],
    ["collateral_mint", "pubkey"],
    ["collateral_decimals", "u8"],
  ],
  Call: [
    ["bump", "u8"],
    ["status", "u8"],
    ["agent", "pubkey"],
    ["commitment", { array: ["u8", 32] }],
    ["seal_slot", "u64"],
    ["seal_ts", "i64"],
    ["expiry_ts", "i64"],
    ["reveal_deadline_ts", "i64"],
    ["feed_id", { array: ["u8", 32] }],
    ["direction", "u8"],
    ["level_mantissa", "i64"],
    ["level_expo", "i32"],
    ["salt", { array: ["u8", 32] }],
    ["reveal_slot", "u64"],
    ["reveal_ts", "i64"],
    ["market_open", "bool"],
    ["market_opened_ts", "i64"],
    ["pool_yes", "u64"],
    ["pool_no", "u64"],
    ["outcome", "u8"],
    ["accepted_update", "pubkey"],
    ["obs_price", "i64"],
    ["obs_conf", "u64"],
    ["obs_expo", "i32"],
    ["obs_publish_time", "i64"],
    ["obs_prev_publish_time", "i64"],
    ["settled_ts", "i64"],
    ["settler", "pubkey"],
  ],
  Position: [
    ["bump", "u8"],
    ["call", "pubkey"],
    ["owner", "pubkey"],
    ["side", "u8"],
    ["amount", "u64"],
    ["redeemed", "bool"],
  ],
} as const satisfies Record<string, Fields>;

/** Byte offsets used in getProgramAccounts memcmp filters (after the 8-byte discriminator). */
export const OFFSETS = Object.freeze({
  callAgent: 8 + 1 + 1,
  positionCall: 8 + 1,
  positionOwner: 8 + 1 + 32,
});

export const EVENTS = {
  ConfigInitialized: [
    ["authority", "pubkey"],
    ["feed_count", "u8"],
  ],
  CallSealed: [
    ["call", "pubkey"],
    ["agent", "pubkey"],
    ["commitment", { array: ["u8", 32] }],
    ["expiry_ts", "i64"],
    ["reveal_deadline_ts", "i64"],
  ],
  CallRevealed: [
    ["call", "pubkey"],
    ["agent", "pubkey"],
  ],
  MarketOpened: [
    ["call", "pubkey"],
    ["opened_ts", "i64"],
  ],
  CallSettled: [
    ["call", "pubkey"],
    ["outcome", "u8"],
    ["settler", "pubkey"],
  ],
  CallVoided: [["call", "pubkey"]],
  PositionOpened: [
    ["call", "pubkey"],
    ["owner", "pubkey"],
    ["side", "u8"],
  ],
  Bought: [
    ["call", "pubkey"],
    ["owner", "pubkey"],
    ["side", "u8"],
    ["amount", "u64"],
  ],
  Redeemed: [
    ["call", "pubkey"],
    ["owner", "pubkey"],
    ["side", "u8"],
    ["payout", "u64"],
  ],
} as const satisfies Record<string, Fields>;

/** `CallMarketsError` variants in declaration order; Anchor numbers them from 6000. */
export const PROGRAM_ERRORS = [
  "InvalidParams",
  "InvalidFeedList",
  "Unauthorized",
  "ZeroCommitment",
  "ExpiryTooSoon",
  "ExpiryTooFar",
  "WrongSigner",
  "WrongStatus",
  "RevealTooEarly",
  "RevealDeadlinePassed",
  "CommitmentMismatch",
  "InvalidDirection",
  "ZeroFeed",
  "ZeroSalt",
  "InvalidLevel",
  "InvalidExponent",
  "FeedNotAllowed",
  "MarketAlreadyOpen",
  "TradingClosed",
  "NotExpired",
  "SettlementWindowClosed",
  "AlreadySettled",
  "AlreadyVoid",
  "VoidTooEarly",
  "OracleNotFullyVerified",
  "FeedMismatch",
  "ObservationOutsideWindow",
  "ObservationNotUnique",
  "NonPositivePrice",
  "ConfidenceTooWide",
  "OracleOwnerMismatch",
  "DuplicatePriceUpdate",
  "WrongMint",
  "MarketNotOpen",
  "InvalidAmount",
  "InvalidSide",
  "LimitNotMet",
  "NotRedeemable",
  "NothingToRedeem",
] as const;
export type ProgramErrorName = (typeof PROGRAM_ERRORS)[number];
export const PROGRAM_ERROR_OFFSET = 6000;
