// CLI parsing, refusals and local key/salt files. No cluster: transports here are fakes.
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createKeyPairSignerFromBytes, getAddressDecoder } from "@solana/kit";
import { bytes32, CoreError, Direction, ErrorCode } from "@agent-call-markets/core";
import {
  generateKeypairFile,
  loadKeypairFile,
  readSaltFile,
  saltPath,
  writeSaltFile,
} from "../../src/cli/files.ts";
import { parseLevel, runCli, toJson, USAGE, type CliDeps } from "../../src/cli/run.ts";
import { DISCLAIMER, GENESIS_HASH, NO_US_USERS } from "../../src/constants.ts";
import type { SolanaTransport } from "../../src/transport.ts";

function harness(transport?: SolanaTransport) {
  const cwd = mkdtempSync(join(tmpdir(), "acm-cli-"));
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    cwd,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ...(transport === undefined ? {} : { transport: () => transport }),
  };
  return { cwd, out, err, run: (...argv: string[]) => runCli(argv, deps) };
}

/** A transport that only answers the genesis hash and records whether anything was sent. */
function fakeTransport(genesisHash: string, url = "http://127.0.0.1:8899") {
  let sent = 0;
  const t: SolanaTransport = {
    endpoint: { kind: "rpc", url },
    getGenesisHash: () => Promise.resolve(genesisHash),
    getAccount: () => Promise.resolve(null),
    getProgramAccounts: () => Promise.resolve([]),
    send: () => {
      sent++;
      return Promise.reject(new Error("must not send"));
    },
    getUnixTimestamp: () => Promise.resolve(0n),
    requestAirdrop: () => {
      sent++;
      return Promise.reject(new Error("must not send"));
    },
    rentExempt: () => Promise.resolve(0n),
  };
  return { t, sent: () => sent };
}

describe("cli: help and usage", () => {
  it("prints the verbatim disclaimer and No US users", async () => {
    const h = harness();
    expect(await h.run("--help")).toBe(0);
    expect(h.out[0]).toContain(DISCLAIMER);
    expect(h.out[0]).toContain(NO_US_USERS);
    expect(USAGE).not.toMatch(/mainnet-beta|testnet/);
    expect(await h.run()).toBe(2);
  });

  it("rejects unknown commands and options", async () => {
    const h = harness(fakeTransport("LocalGenesis1111111111111111111111111111111").t);
    expect(await h.run("--bogus")).toBe(2);
    expect(await h.run("frobnicate", "--keypair", "/nonexistent")).toBe(1); // no key file
    await h.run("keygen");
    expect(await h.run("frobnicate")).toBe(2);
    expect(await h.run("admin", "nope")).toBe(2);
    expect(await h.run("open")).toBe(2);
    expect(await h.run("open", "not-an-address")).toBe(2);
    expect(
      await h.run("buy", "11111111111111111111111111111111", "--side", "maybe", "--amount", "1"),
    ).toBe(2);
    expect(await h.run("seal", "--feed", "f1".repeat(32), "--direction", "up")).toBe(2);
  });
});

describe("cli: cluster refusals", () => {
  it("refuses mainnet and testnet names before connecting", async () => {
    for (const name of ["mainnet", "mainnet-beta", "testnet"]) {
      const h = harness();
      expect(
        await h.run("list", "--cluster", name, "--agent", "11111111111111111111111111111111"),
      ).toBe(1);
      expect(JSON.parse(h.err[0] ?? "{}")).toMatchObject({ error: ErrorCode.ClusterNotAllowed });
    }
  });

  it("refuses an RPC whose genesis hash is mainnet, even on localhost, and sends nothing", async () => {
    const fake = fakeTransport(GENESIS_HASH.mainnetBeta);
    const h = harness(fake.t);
    await h.run("keygen");
    expect(await h.run("airdrop")).toBe(1);
    expect(JSON.parse(h.err[0] ?? "{}")).toMatchObject({ error: ErrorCode.ClusterNotAllowed });
    expect(await h.run("airdrop", "--cluster", "devnet")).toBe(1);
    expect(fake.sent()).toBe(0);
  });
});

describe("cli: key and salt files", () => {
  it("keygen writes a 0600 Solana-format keypair and never overwrites it", async () => {
    const h = harness();
    expect(await h.run("keygen")).toBe(0);
    const { address, keypair } = JSON.parse(h.out[0] ?? "{}") as {
      address: string;
      keypair: string;
    };
    expect(keypair).toBe(join(h.cwd, ".devnet", "keypair.json"));
    expect(statSync(keypair).mode & 0o777).toBe(0o600);
    expect(statSync(join(h.cwd, ".devnet")).mode & 0o777).toBe(0o700);
    const bytes = Uint8Array.from(JSON.parse(readFileSync(keypair, "utf8")) as number[]);
    expect(bytes).toHaveLength(64);
    expect((await createKeyPairSignerFromBytes(bytes)).address).toBe(address);
    expect(h.out[0]).not.toContain(JSON.stringify(Array.from(bytes.slice(0, 32))).slice(1, -1));
    expect(await h.run("keygen")).toBe(1);
    expect((await loadKeypairFile(keypair)).address).toBe(address);
  });

  it("refuses group/world-readable or malformed key files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-key-"));
    const path = join(dir, "k.json");
    await generateKeypairFile(path);
    chmodSync(path, 0o644);
    await expect(loadKeypairFile(path)).rejects.toThrow(/readable by others/);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "not json", { mode: 0o600 });
    await expect(loadKeypairFile(bad)).rejects.toThrow(/not valid JSON/);
    writeFileSync(bad, "[1,2,3]", { mode: 0o600 });
    await expect(loadKeypairFile(bad)).rejects.toThrow(/64-byte/);
    await expect(loadKeypairFile(join(dir, "missing.json"))).rejects.toThrow(/keygen/);
  });

  it("stores salts 0600, keyed by cluster and commitment, never overwriting", () => {
    const cwd = mkdtempSync(join(tmpdir(), "acm-salt-"));
    const commitment = bytes32("ab".repeat(32));
    const path = saltPath(cwd, "localnet", commitment);
    const record = {
      version: 1 as const,
      cluster: "localnet",
      programId: "p",
      call: "pending",
      agent: "a1".repeat(32),
      feedId: "f1".repeat(32),
      direction: Direction.Below,
      levelMantissa: "12345",
      levelExpo: -2,
      expiryTs: "1800003600",
      salt: "5a".repeat(32),
    };
    writeSaltFile(path, record);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => {
      writeSaltFile(path, record);
    }).toThrow();
    const { call, salt } = readSaltFile(path);
    expect(call).toMatchObject({
      direction: Direction.Below,
      level: { mantissa: 12345n, expo: -2 },
      expiryTs: 1_800_003_600n,
    });
    expect(salt).toEqual(bytes32("5a".repeat(32)));
    expect(() => readSaltFile(join(cwd, "missing.json"))).toThrow(CoreError);
  });
});

describe("cli: value parsing", () => {
  it("parses decimal levels exactly", () => {
    expect(parseLevel("100")).toEqual({ mantissa: 100n, expo: 0 });
    expect(parseLevel("100.25")).toEqual({ mantissa: 10025n, expo: -2 });
    expect(parseLevel("0.000001")).toEqual({ mantissa: 1n, expo: -6 });
    for (const bad of ["0", "0.0", "-1", "1e5", "1.", ".5", "abc"]) {
      expect(() => parseLevel(bad)).toThrow();
    }
  });

  it("prints bigints as strings and bytes as hex", () => {
    const addr = getAddressDecoder().decode(new Uint8Array(32).fill(1));
    expect(JSON.parse(toJson({ a: 1n, b: Uint8Array.of(0xab, 0x01), addr }))).toEqual({
      a: "1",
      b: "ab01",
      addr,
    });
  });
});
