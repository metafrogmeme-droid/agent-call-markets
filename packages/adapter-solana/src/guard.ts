import { CoreError, ErrorCode } from "@agent-call-markets/core";
import { GENESIS_HASH, type Cluster } from "./constants.ts";

/**
 * Mainnet guard (docs/THREAT_MODEL.md, item 12). Fail closed; there is no override.
 *
 * - Mainnet-beta and testnet genesis hashes are always refused.
 * - "devnet" requires exactly the devnet genesis hash.
 * - "localnet" requires a loopback RPC host AND a genesis hash that is not a public cluster's,
 *   so a loopback tunnel or proxy to mainnet is still refused.
 * - "in-process" endpoints (LiteSVM in tests) have no network at all and count as localnet.
 *
 * The adapter checks this when it connects and again right before every transaction it sends.
 */
export type Endpoint =
  | { readonly kind: "rpc"; readonly url: string }
  | { readonly kind: "in-process"; readonly name: string };

export interface ClusterIdentity {
  readonly endpoint: Endpoint;
  readonly genesisHash: string;
}

const REFUSED: Readonly<Record<string, string>> = Object.freeze({
  [GENESIS_HASH.mainnetBeta]: "mainnet-beta",
  [GENESIS_HASH.testnet]: "testnet",
});

const PUBLIC: ReadonlySet<string> = new Set(Object.values(GENESIS_HASH));

/** True for localhost, ::1 and 127.0.0.0/8 (IPv4 loopback). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m?.slice(1).every((part) => Number(part) <= 255) ?? false;
}

function refuse(message: string): never {
  throw new CoreError(ErrorCode.ClusterNotAllowed, message);
}

/** Throws CLUSTER_NOT_ALLOWED unless `identity` is the expected devnet or localnet cluster. */
export function assertClusterAllowed(expected: Cluster, identity: ClusterIdentity): void {
  const { endpoint, genesisHash } = identity;
  const refused = REFUSED[genesisHash];
  if (refused !== undefined) {
    refuse(`refusing ${refused}: this tool only talks to devnet or localnet`);
  }
  if (expected === "devnet") {
    if (genesisHash !== GENESIS_HASH.devnet) {
      refuse(`expected the devnet genesis hash, got ${genesisHash}`);
    }
    return;
  }
  // localnet: never a public cluster's genesis, whatever the endpoint.
  if (PUBLIC.has(genesisHash)) {
    refuse(`localnet reports a public cluster's genesis hash (${genesisHash})`);
  }
  if (endpoint.kind === "in-process") return;
  let host: string;
  try {
    host = new URL(endpoint.url).hostname;
  } catch {
    return refuse(`invalid RPC URL ${endpoint.url}`);
  }
  if (!isLoopbackHost(host)) {
    refuse(`localnet must be a loopback RPC host (127.0.0.1, localhost, ::1), got ${host}`);
  }
}

/** Parses a user-supplied cluster name; anything but devnet/localnet is refused. */
export function parseCluster(value: string): Cluster {
  if (value === "devnet" || value === "localnet") return value;
  return refuse(`cluster "${value}" is not allowed: use devnet or localnet`);
}
