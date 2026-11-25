import { address, type Address } from "@solana/kit";

/**
 * Placeholder program id from `declare_id!` in programs/call_markets/src/lib.rs:
 * sha256("agent-call-markets/call_markets/placeholder-program-id/v1"), not a key anyone holds.
 * A devnet deploy needs its own id (`--program-id`, see docs/DEVNET.md).
 */
export const PLACEHOLDER_PROGRAM_ID: Address = address(
  "4SG3dvvHerGBWpbCTTEfcSXRLCiPqBtgF9za8CTnFgVq",
);

/**
 * The only accepted owner of price accounts: the original Pyth Core Solana receiver program.
 * Must equal `PYTH_RECEIVER_PROGRAM_ID` in programs/call_markets/src/state.rs (checked by a test).
 * The program enforces it on-chain; the adapter never substitutes another receiver.
 */
export const PYTH_RECEIVER_PROGRAM_ID: Address = address(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
);

export const SEEDS = Object.freeze({
  config: "config",
  call: "call",
  vault: "vault",
  position: "position",
});

/**
 * Genesis hashes of the public clusters, as in Anza's `solana-cluster-type` crate
 * (`ClusterType::get_genesis_hash`, v3.2.1). Used by the cluster guard (src/guard.ts).
 */
export const GENESIS_HASH = Object.freeze({
  mainnetBeta: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
});

/** The only clusters this adapter and CLI will talk to. There is deliberately no mainnet entry. */
export type Cluster = "devnet" | "localnet";
export const CLUSTERS: readonly Cluster[] = Object.freeze(["devnet", "localnet"]);

export const DEFAULT_RPC_URL: Readonly<Record<Cluster, string>> = Object.freeze({
  devnet: "https://api.devnet.solana.com",
  localnet: "http://127.0.0.1:8899",
});

/** Core CallStatus / Side / Outcome as stored on-chain (programs/call_markets/src/state.rs). */
export const STATUS = Object.freeze({ sealed: 1, revealed: 2, settled: 3, void: 4 });
export const OUTCOME = Object.freeze({ none: 0, hit: 1, miss: 2 });
export const SIDE = Object.freeze({ yes: 1, no: 2 });

export const MAX_FEEDS = 8;

/** Verbatim, from CLAUDE_BRIEF.md §8. */
export const DISCLAIMER =
  "Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.";
export const NO_US_USERS = "No US users.";
