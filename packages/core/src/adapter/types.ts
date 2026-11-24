import type { Bytes32 } from "../bytes.ts";
import type { Quote, Side } from "../parimutuel.ts";
import type { CallV1 } from "../seal/schema.ts";
import type { OracleObservation, Outcome } from "../settlement.ts";
import type { CallState } from "../state.ts";

/** e.g. "solana:devnet", "memory:test". */
export type ChainId = string;

export interface CallRef {
  readonly chainId: ChainId;
  /** Adapter-specific id (e.g. a PDA address on Solana). */
  readonly id: string;
}

export interface MarketRef {
  readonly chainId: ChainId;
  readonly id: string;
}

export interface Tx<T = undefined> {
  readonly txId: string;
  readonly value: T;
}

/**
 * Where settle() gets its price.
 * - "inline": the observation itself. Mocks and tests only; a real chain adapter must reject it.
 * - "account": an on-chain oracle account (e.g. a Pyth PriceUpdateV2 address).
 */
export type OracleRef =
  | { readonly kind: "inline"; readonly observation: OracleObservation }
  | { readonly kind: "account"; readonly address: string };

export interface CallRecord {
  readonly ref: CallRef;
  readonly market: MarketRef | null;
  readonly state: CallState;
}

/**
 * The only surface between the chain-agnostic core and a chain. Adapters move data; the core
 * decides outcomes (an on-chain program mirrors the core rule and is checked against shared
 * vectors). Write methods need a signer; read-only instances reject them with READ_ONLY.
 * Failures reject with a CoreError carrying an ErrorCode.
 *
 * Differences from the brief's list, all additive: `redeem` (M3 needs it), `voidUnsettled`
 * (refund path), and settle/void take a CallRef so a call without a market can still be decided.
 */
export interface ChainAdapter {
  readonly chainId: ChainId;
  sealCall(c: { readonly commitment: Bytes32; readonly expiryTs: bigint }): Promise<Tx<CallRef>>;
  revealCall(ref: CallRef, call: CallV1, salt: Bytes32): Promise<Tx>;
  openMarket(ref: CallRef): Promise<Tx<MarketRef>>;
  quote(market: MarketRef, side: Side, amount: bigint): Promise<Quote>;
  trade(market: MarketRef, side: Side, amount: bigint, minProjectedPayout: bigint): Promise<Tx>;
  redeem(market: MarketRef): Promise<Tx<bigint>>;
  settle(ref: CallRef, oracle: OracleRef): Promise<Tx<Outcome>>;
  voidUnsettled(ref: CallRef): Promise<Tx>;
  getCall(ref: CallRef): Promise<CallRecord | null>;
  listCalls(agent: Bytes32): Promise<CallRecord[]>;
}
