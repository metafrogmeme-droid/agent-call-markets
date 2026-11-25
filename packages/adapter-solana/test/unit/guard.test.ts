import { describe, expect, it } from "vitest";
import { CoreError, ErrorCode } from "@agent-call-markets/core";
import { GENESIS_HASH } from "../../src/constants.ts";
import {
  assertClusterAllowed,
  isLoopbackHost,
  parseCluster,
  type ClusterIdentity,
} from "../../src/guard.ts";

const LOCAL_GENESIS = "8vRtUZsUnTLgbCdjBdXKNqLRaJ8BpcDLsDXPoPtNiyNk"; // any non-public hash
const rpc = (url: string, genesisHash: string): ClusterIdentity => ({
  endpoint: { kind: "rpc", url },
  genesisHash,
});

function refused(fn: () => void): void {
  expect(fn).toThrow(CoreError);
  try {
    fn();
  } catch (e) {
    expect((e as CoreError).code).toBe(ErrorCode.ClusterNotAllowed);
  }
}

describe("mainnet guard", () => {
  it("always refuses mainnet-beta and testnet, whatever the URL or expected cluster", () => {
    for (const hash of [GENESIS_HASH.mainnetBeta, GENESIS_HASH.testnet]) {
      for (const url of [
        "https://api.mainnet-beta.solana.com",
        "https://api.devnet.solana.com",
        "http://127.0.0.1:8899", // e.g. a tunnel or proxy to mainnet
        "http://localhost:8899",
      ]) {
        refused(() => {
          assertClusterAllowed("devnet", rpc(url, hash));
        });
        refused(() => {
          assertClusterAllowed("localnet", rpc(url, hash));
        });
      }
      refused(() => {
        assertClusterAllowed("localnet", {
          endpoint: { kind: "in-process", name: "x" },
          genesisHash: hash,
        });
      });
    }
  });

  it("devnet needs exactly the devnet genesis hash", () => {
    expect(() => {
      assertClusterAllowed("devnet", rpc("https://api.devnet.solana.com", GENESIS_HASH.devnet));
    }).not.toThrow();
    expect(() => {
      assertClusterAllowed("devnet", rpc("http://127.0.0.1:8899", GENESIS_HASH.devnet));
    }).not.toThrow();
    refused(() => {
      assertClusterAllowed("devnet", rpc("https://api.devnet.solana.com", LOCAL_GENESIS));
    });
    refused(() => {
      assertClusterAllowed("devnet", {
        endpoint: { kind: "in-process", name: "x" },
        genesisHash: LOCAL_GENESIS,
      });
    });
  });

  it("localnet needs a loopback host and a non-public genesis hash", () => {
    for (const url of [
      "http://127.0.0.1:8899",
      "http://localhost:8899",
      "http://[::1]:8899",
      "http://127.5.6.7:8899",
    ]) {
      expect(() => {
        assertClusterAllowed("localnet", rpc(url, LOCAL_GENESIS));
      }).not.toThrow();
    }
    refused(() => {
      assertClusterAllowed("localnet", rpc("https://example.com", LOCAL_GENESIS));
    });
    refused(() => {
      assertClusterAllowed("localnet", rpc("http://10.0.0.5:8899", LOCAL_GENESIS));
    });
    refused(() => {
      assertClusterAllowed("localnet", rpc("http://127.0.0.1.evil.com", LOCAL_GENESIS));
    });
    refused(() => {
      assertClusterAllowed("localnet", rpc("not a url", LOCAL_GENESIS));
    });
    refused(() => {
      assertClusterAllowed("localnet", rpc("http://127.0.0.1:8899", GENESIS_HASH.devnet));
    });
    expect(() => {
      assertClusterAllowed("localnet", {
        endpoint: { kind: "in-process", name: "litesvm" },
        genesisHash: LOCAL_GENESIS,
      });
    }).not.toThrow();
  });

  it("recognises loopback hosts strictly", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.255.255.255")).toBe(true);
    expect(isLoopbackHost("127.256.0.1")).toBe(false);
    expect(isLoopbackHost("128.0.0.1")).toBe(false);
    expect(isLoopbackHost("localhost.example.com")).toBe(false);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });

  it("only parses devnet and localnet as cluster names", () => {
    expect(parseCluster("devnet")).toBe("devnet");
    expect(parseCluster("localnet")).toBe("localnet");
    for (const bad of ["mainnet", "mainnet-beta", "testnet", "Devnet", ""]) {
      refused(() => parseCluster(bad));
    }
  });
});
