import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runWebCli, USAGE, type WebCliDeps } from "../src/cli/run.ts";
import { decodeSnapshot } from "../src/snapshot.ts";
import type { SolanaTransport } from "@agent-call-markets/adapter-solana";

const FIXTURE = new URL("../fixtures/snapshot-fake.json", import.meta.url).pathname;
const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const LOCAL = "LocaLGenesis1111111111111111111111111111111";

/** A transport that answers reads but fails the test if anything is ever sent. */
function fakeTransport(genesisHash: string) {
  let sends = 0;
  const t: SolanaTransport = {
    endpoint: { kind: "rpc", url: "http://127.0.0.1:8899" },
    getGenesisHash: () => Promise.resolve(genesisHash),
    getAccount: () => Promise.resolve(null),
    getProgramAccounts: () => Promise.resolve([]),
    send: () => {
      sends++;
      return Promise.reject(new Error("must not send"));
    },
    getUnixTimestamp: () => Promise.resolve(0n),
    requestAirdrop: () => {
      sends++;
      return Promise.reject(new Error("must not send"));
    },
    rentExempt: () => Promise.resolve(0n),
  };
  return { t, sends: () => sends };
}

async function run(argv: string[], transport?: SolanaTransport) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: WebCliDeps = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    ...(transport === undefined ? {} : { transport: () => transport }),
  };
  const code = await runWebCli(argv, deps);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("web CLI", () => {
  it("prints the disclaimer", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("No US users.");
    expect(USAGE).toMatch(/read-only/i);
    expect((await run([])).code).toBe(2);
  });

  it("builds the site from a snapshot, offline", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "acm-web-")), "site");
    const r = await run(["build", "--snapshot", FIXTURE, "--out", out]);
    expect(r.code).toBe(0);
    const summary = JSON.parse(r.out) as {
      pages: string[];
      agents: { label: string; summary: string }[];
      synthetic: boolean;
    };
    expect(summary.synthetic).toBe(true);
    expect(summary.pages).toContain("index.html");
    expect(summary.agents.map((a) => a.label)).toEqual(["FAKE-AGENT-1", "FAKE-AGENT-2"]);
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain(
      summary.agents[0]?.summary ?? "?",
    );
  });

  it("refuses mainnet and testnet before connecting, and never sends", async () => {
    for (const name of ["mainnet", "mainnet-beta", "testnet"]) {
      const r = await run(["build", "--cluster", name, "--agents", "x.json", "--out", "y"]);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.err)).toMatchObject({ error: "CLUSTER_NOT_ALLOWED" });
    }
    const dir = mkdtempSync(join(tmpdir(), "acm-web-"));
    const agents = join(dir, "agents.json");
    writeFileSync(agents, JSON.stringify({ "FAKE-AGENT-1": "a1".repeat(32) }));
    const fake = fakeTransport(MAINNET);
    const r = await run(
      ["snapshot", "--cluster", "localnet", "--agents", agents, "--out", join(dir, "s.json")],
      fake.t,
    );
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err)).toMatchObject({ error: "CLUSTER_NOT_ALLOWED" });
    expect(fake.sends()).toBe(0);
  });

  it("reads from a localnet chain through the read-only adapter (no config -> clear error)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-web-"));
    const agents = join(dir, "agents.json");
    writeFileSync(agents, JSON.stringify({ "FAKE-AGENT-1": "a1".repeat(32) }));
    const fake = fakeTransport(LOCAL);
    const r = await run(
      ["build", "--cluster", "localnet", "--agents", agents, "--out", join(dir, "site")],
      fake.t,
    );
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err)).toMatchObject({ error: "CHAIN_ERROR" });
    expect(r.err).toMatch(/config is not initialized/);
    expect(fake.sends()).toBe(0);
  });

  it("writes a snapshot that rebuilds the same site", async () => {
    // Round trip through the snapshot command using the fixture as the "chain" is covered by the
    // codec tests; here: snapshot input errors and usage errors have clear exit codes.
    const dir = mkdtempSync(join(tmpdir(), "acm-web-"));
    writeFileSync(join(dir, "bad.json"), "{}");
    expect(
      (await run(["build", "--snapshot", join(dir, "bad.json"), "--out", join(dir, "o")])).code,
    ).toBe(1);
    expect(
      (await run(["build", "--snapshot", join(dir, "missing.json"), "--out", join(dir, "o")])).code,
    ).toBe(1);
    expect((await run(["build", "--out", join(dir, "o")])).code).toBe(2);
    expect((await run(["build", "--snapshot", FIXTURE])).code).toBe(2);
    expect(
      (await run(["build", "--snapshot", FIXTURE, "--cluster", "localnet", "--out", "o"])).code,
    ).toBe(2);
    expect((await run(["deploy"])).code).toBe(2);
    expect((await run(["build", "--bogus"])).code).toBe(2);
    expect(decodeSnapshot(readFileSync(FIXTURE, "utf8")).synthetic).toBe(true);
  });
});
