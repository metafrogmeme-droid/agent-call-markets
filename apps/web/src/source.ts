import type { Bytes32, CallState, ChainAdapter, ProtocolParams } from "@agent-call-markets/core";

export interface AgentEntry {
  /** Display label from the agents map (public). */
  readonly label: string;
  /** The agent's public key / 32-byte id. */
  readonly id: Bytes32;
}

export interface RecordCall {
  /** Adapter-specific call id (the call account address on Solana). */
  readonly id: string;
  readonly state: CallState;
}

/** Everything the page is built from: chain data only, plus the listed agents' labels. */
export interface RecordData {
  /** Where the data came from, e.g. "solana:localnet" or "memory:test". */
  readonly source: string;
  /** True for fixtures and tests: the page then carries a "synthetic data" banner. */
  readonly synthetic: boolean;
  /** Chain clock (unix seconds) when the data was read; record statuses are computed at it. */
  readonly takenAt: bigint;
  /** The parameters the chain enforces (on Solana: the immutable on-chain Config). */
  readonly params: ProtocolParams;
  readonly agents: readonly AgentEntry[];
  readonly calls: readonly RecordCall[];
}

export interface CollectOptions {
  readonly agents: readonly AgentEntry[];
  readonly now: bigint;
  readonly params: ProtocolParams;
  readonly source: string;
  readonly synthetic: boolean;
}

/**
 * Reads every call of each listed agent through a ChainAdapter's read methods only (listCalls).
 * Use a read-only adapter (no signer): nothing is ever sent.
 */
export async function collectFromAdapter(
  adapter: ChainAdapter,
  opts: CollectOptions,
): Promise<RecordData> {
  const calls: RecordCall[] = [];
  for (const agent of opts.agents) {
    for (const rec of await adapter.listCalls(agent.id)) {
      calls.push({ id: rec.ref.id, state: rec.state });
    }
  }
  return {
    source: opts.source,
    synthetic: opts.synthetic,
    takenAt: opts.now,
    params: opts.params,
    agents: opts.agents,
    calls,
  };
}
