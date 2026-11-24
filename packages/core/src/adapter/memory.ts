import { bytesEqual, bytesToHex, U64_MAX, type Bytes32 } from "../bytes.ts";
import { quote as quotePool, type Quote, type Side } from "../parimutuel.ts";
import { validateParams, type ProtocolParams } from "../params.ts";
import { CoreError, ErrorCode, unwrap } from "../result.ts";
import type { CallV1 } from "../seal/schema.ts";
import type { Outcome } from "../settlement.ts";
import {
  openMarket,
  placeTrade,
  redeem,
  revealCall,
  sealCall,
  settleCall,
  voidCall,
  type CallState,
} from "../state.ts";
import type { CallRecord, CallRef, ChainAdapter, MarketRef, OracleRef, Tx } from "./types.ts";

export const MEMORY_CHAIN_ID = "memory:test";

/**
 * Shared in-memory "chain" for tests and mocks: call states, a test-token ledger and a clock.
 * No I/O, no keys: identities are plain 32-byte ids. Nothing here touches a real network.
 */
export class MemoryWorld {
  readonly params: ProtocolParams;
  now: bigint;
  private readonly calls = new Map<string, CallState>();
  private readonly balances = new Map<string, bigint>();
  private txCounter = 0;

  constructor(params: ProtocolParams, now: bigint) {
    this.params = unwrap(validateParams(params));
    this.now = now;
  }

  /** Test helper: credit mock test tokens. Not part of ChainAdapter. */
  fund(owner: Bytes32, amount: bigint): void {
    if (amount <= 0n) throw new CoreError(ErrorCode.InvalidAmount, "fund amount must be positive");
    const next = this.balanceOf(owner) + amount;
    if (next > U64_MAX) throw new CoreError(ErrorCode.InvalidAmount, "balance would exceed u64");
    this.balances.set(bytesToHex(owner), next);
  }

  balanceOf(owner: Bytes32): bigint {
    return this.balances.get(bytesToHex(owner)) ?? 0n;
  }

  /** @internal */
  debit(owner: Bytes32, amount: bigint): void {
    const balance = this.balanceOf(owner);
    if (balance < amount)
      throw new CoreError(ErrorCode.InsufficientBalance, "insufficient test-token balance");
    this.balances.set(bytesToHex(owner), balance - amount);
  }

  /** @internal */
  credit(owner: Bytes32, amount: bigint): void {
    if (amount > 0n) this.balances.set(bytesToHex(owner), this.balanceOf(owner) + amount);
  }

  /** @internal */
  nextTxId(): string {
    this.txCounter++;
    return `mem-tx-${this.txCounter}`;
  }

  /** @internal */
  get(id: string): CallState | undefined {
    return this.calls.get(id);
  }

  /** @internal */
  put(id: string, state: CallState): void {
    this.calls.set(id, state);
  }

  /** @internal */
  entries(): [string, CallState][] {
    return [...this.calls.entries()];
  }
}

export function memoryCallId(agent: Bytes32, commitment: Bytes32): string {
  return `${bytesToHex(agent)}:${bytesToHex(commitment)}`;
}

/** ChainAdapter over a MemoryWorld, acting as one signer (or read-only when signer is null). */
export class MemoryAdapter implements ChainAdapter {
  readonly chainId = MEMORY_CHAIN_ID;
  readonly world: MemoryWorld;
  readonly signer: Bytes32 | null;

  constructor(world: MemoryWorld, signer: Bytes32 | null) {
    this.world = world;
    this.signer = signer;
  }

  /** Same world, different signer. */
  as(signer: Bytes32 | null): MemoryAdapter {
    return new MemoryAdapter(this.world, signer);
  }

  sealCall(c: { readonly commitment: Bytes32; readonly expiryTs: bigint }): Promise<Tx<CallRef>> {
    return this.run(() => {
      const agent = this.requireSigner();
      const id = memoryCallId(agent, c.commitment);
      if (this.world.get(id) !== undefined) {
        throw new CoreError(ErrorCode.DuplicateCall, "this agent already sealed this commitment");
      }
      const state = unwrap(
        sealCall(
          { agent, commitment: c.commitment, expiryTs: c.expiryTs },
          this.world.now,
          this.world.params,
        ),
      );
      this.world.put(id, state);
      return { chainId: this.chainId, id };
    });
  }

  revealCall(ref: CallRef, call: CallV1, salt: Bytes32): Promise<Tx> {
    return this.run(() => {
      const signer = this.requireSigner();
      const state = this.load(ref.id);
      this.world.put(
        ref.id,
        unwrap(revealCall(state, { signer, call, salt }, this.world.now, this.world.params)),
      );
      return undefined;
    });
  }

  openMarket(ref: CallRef): Promise<Tx<MarketRef>> {
    return this.run(() => {
      this.requireSigner();
      const state = this.load(ref.id);
      this.world.put(ref.id, unwrap(openMarket(state, this.world.now, this.world.params)));
      return { chainId: this.chainId, id: ref.id };
    });
  }

  quote(market: MarketRef, side: Side, amount: bigint): Promise<Quote> {
    return Promise.resolve().then(() => {
      const state = this.load(market.id);
      if (state.market === null) throw new CoreError(ErrorCode.MarketNotOpen, "market is not open");
      return unwrap(quotePool(state.market.pool, side, amount));
    });
  }

  trade(market: MarketRef, side: Side, amount: bigint, minProjectedPayout: bigint): Promise<Tx> {
    return this.run(() => {
      const owner = this.requireSigner();
      const state = this.load(market.id);
      const next = unwrap(
        placeTrade(
          state,
          { owner, side, amount, minProjectedPayout },
          this.world.now,
          this.world.params,
        ),
      );
      this.world.debit(owner, amount);
      this.world.put(market.id, next);
      return undefined;
    });
  }

  redeem(market: MarketRef): Promise<Tx<bigint>> {
    return this.run(() => {
      const owner = this.requireSigner();
      const result = unwrap(redeem(this.load(market.id), owner));
      this.world.put(market.id, result.state);
      this.world.credit(owner, result.amount);
      return result.amount;
    });
  }

  settle(ref: CallRef, oracle: OracleRef): Promise<Tx<Outcome>> {
    return this.run(() => {
      // Settlement is permissionless, but this adapter still needs some signer to "send".
      this.requireSigner();
      if (oracle.kind !== "inline") {
        throw new CoreError(
          ErrorCode.UnsupportedOracleRef,
          "the memory adapter only takes inline observations",
        );
      }
      const next = unwrap(
        settleCall(this.load(ref.id), oracle.observation, this.world.now, this.world.params),
      );
      this.world.put(ref.id, next);
      if (next.outcome === null)
        throw new CoreError(ErrorCode.WrongStatus, "settled without outcome");
      return next.outcome;
    });
  }

  voidUnsettled(ref: CallRef): Promise<Tx> {
    return this.run(() => {
      this.requireSigner();
      this.world.put(
        ref.id,
        unwrap(voidCall(this.load(ref.id), this.world.now, this.world.params)),
      );
      return undefined;
    });
  }

  getCall(ref: CallRef): Promise<CallRecord | null> {
    const state = this.world.get(ref.id);
    return Promise.resolve(state === undefined ? null : this.toRecord(ref.id, state));
  }

  listCalls(agent: Bytes32): Promise<CallRecord[]> {
    return Promise.resolve(
      this.world
        .entries()
        .filter(([, s]) => bytesEqual(s.agent, agent))
        .map(([id, s]) => this.toRecord(id, s)),
    );
  }

  private toRecord(id: string, state: CallState): CallRecord {
    return {
      ref: { chainId: this.chainId, id },
      market: state.market === null ? null : { chainId: this.chainId, id },
      state,
    };
  }

  private load(id: string): CallState {
    const state = this.world.get(id);
    if (state === undefined) throw new CoreError(ErrorCode.UnknownCall, `unknown call ${id}`);
    return state;
  }

  private requireSigner(): Bytes32 {
    if (this.signer === null)
      throw new CoreError(ErrorCode.ReadOnly, "read-only adapter cannot send");
    return this.signer;
  }

  private run<T>(fn: () => T): Promise<Tx<T>> {
    return Promise.resolve().then(() => {
      const value = fn();
      return { txId: this.world.nextTxId(), value };
    });
  }
}
