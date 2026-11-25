// The whole demo flow through the CLI only, against the compiled program in LiteSVM:
// keygen, admin setup, seal, reveal, open, buy, quote, settle (and a duplicate settle), show,
// redeem, list. The CLI's own key file is the program's upgrade authority here.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { address } from "@solana/kit";
import { CallStatus, ErrorCode, Outcome } from "@agent-call-markets/core";
import { loadKeypairFile } from "../../src/cli/files.ts";
import { runCli, type CliDeps } from "../../src/cli/run.ts";
import { FEED, makeWorld, PARAMS, T0 } from "./harness.ts";

describe("CLI end to end (LiteSVM, SBF binary)", () => {
  it("runs the demo flow and refuses a devnet claim on a local endpoint", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "acm-e2e-"));
    const out: string[] = [];
    const err: string[] = [];
    const ctx: { transport?: NonNullable<CliDeps["transport"]> } = {};
    const deps = (): CliDeps => ({
      cwd,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      ...(ctx.transport === undefined ? {} : { transport: ctx.transport }),
    });
    const run = async (...argv: string[]) => {
      out.length = 0;
      err.length = 0;
      const code = await runCli(argv, deps());
      const text = out[0] ?? err[0] ?? "null";
      // Usage errors (exit 2) are plain text; everything else is JSON.
      const json = (code === 2 ? { usage: text } : JSON.parse(text)) as Record<string, unknown>;
      return { code, json };
    };

    // Admin key (also the upgrade authority) and an agent key, both created by the CLI.
    expect((await run("keygen")).code).toBe(0);
    const adminKey = join(cwd, ".devnet", "keypair.json");
    const agentKey = join(cwd, ".devnet", "agent.json");
    const traderKey = join(cwd, ".devnet", "trader.json");
    const agentAddr = (await run("keygen", "--keypair", agentKey)).json["address"] as string;
    const traderAddr = (await run("keygen", "--keypair", traderKey)).json["address"] as string;
    const w = await makeWorld(PARAMS, {
      initConfig: false,
      authority: await loadKeypairFile(adminKey),
    });
    ctx.transport = () => w.transport;

    expect((await run("airdrop", "--keypair", agentKey, "--sol", "2")).code).toBe(0);
    expect((await run("airdrop", "--keypair", traderKey)).code).toBe(0);
    const mint = (await run("admin", "init-mint")).json["mint"] as string;
    const init = await run(
      "admin",
      "init-config",
      "--mint",
      mint,
      "--feed",
      Buffer.from(FEED).toString("hex"),
    );
    expect(init.code).toBe(0);
    for (const to of [agentAddr, traderAddr]) {
      expect(
        (await run("admin", "mint-to", "--mint", mint, "--to", to, "--amount", "1000")).code,
      ).toBe(0);
    }

    // The agent seals a call: ABOVE 100.000000, expiring at T0 + minLead.
    const expiry = T0 + PARAMS.minLeadSecs;
    const sealed = await run(
      "seal",
      "--keypair",
      agentKey,
      "--feed",
      Buffer.from(FEED).toString("hex"),
      "--direction",
      "above",
      "--level",
      "100.000000",
      "--expiry",
      expiry.toString(),
    );
    expect(sealed.code).toBe(0);
    const call = sealed.json["call"] as string;
    expect(sealed.json["saltFile"]).toContain(join(".devnet", "salts", "localnet-"));
    expect(out[0]).not.toContain("5a5a"); // the salt is never printed (random anyway)

    w.advanceTo(T0 + 1n);
    expect((await run("reveal", call, "--keypair", agentKey)).code).toBe(0);
    expect((await run("open", call)).code).toBe(0);
    expect(
      (await run("buy", call, "--keypair", agentKey, "--side", "yes", "--amount", "100")).code,
    ).toBe(0);
    expect(
      (await run("buy", call, "--keypair", traderKey, "--side", "no", "--amount", "300")).code,
    ).toBe(0);
    const q = await run(
      "quote",
      call,
      "--side",
      "yes",
      "--amount",
      "100",
      "--keypair",
      join(cwd, "none.json"),
    );
    expect(q.code).toBe(0);
    expect(q.json["projectedPayout"]).toBe("250"); // 100 * 500 / 200

    w.advanceTo(expiry + 1n);
    const price = await w.putPrice({
      feedId: FEED,
      price: 101_000_000n,
      conf: 0n,
      expo: -6,
      publishTime: expiry,
      prevPublishTime: expiry - 1n,
    });
    const settled = await run("settle", call, "--price-update", price.address);
    expect(settled.json).toMatchObject({ outcome: Outcome.Hit, outcomeCheck: "match" });
    const again = await run("settle", call, "--price-update", price.address);
    expect(again.code).toBe(1);
    expect(again.json["error"]).toBe(ErrorCode.DuplicatePriceUpdate);

    const shown = await run("show", call);
    expect(shown.json).toMatchObject({
      status: CallStatus.Settled,
      recordStatus: "HIT",
      settlement: {
        outcome: Outcome.Hit,
        coreOutcome: Outcome.Hit,
        outcomeCheck: "match",
        acceptedUpdate: price.address,
      },
    });
    expect((await run("redeem", call, "--keypair", agentKey)).json["payout"]).toBe("400");
    expect((await run("redeem", call, "--keypair", traderKey)).json["payout"]).toBe("0");
    expect((await run("redeem", call, "--keypair", traderKey)).json["error"]).toBe(
      ErrorCode.NothingToRedeem,
    );

    const listed = await run("list", "--agent", agentAddr);
    expect(listed.json).toMatchObject({
      record: { sealed: 1, hits: 1, misses: 0, sampleSize: 1, selfTradedCalls: 1, hitRate: "1/1" },
      summary: "100.0% hit rate (1 of 1 decided; 0 voids)",
    });
    expect((await run("list", "--keypair", agentKey)).json["agent"]).toBe(agentAddr);
    expect((await run("list", "--keypair", join(cwd, "none.json"))).code).toBe(2);

    // An unrevealed second call voids nothing and reveals nothing without its salt file.
    expect((await run("void", call)).json["error"]).toBe(ErrorCode.AlreadySettled);
    expect((await run("show", address("11111111111111111111111111111111"))).code).toBe(1);

    // Claiming devnet on this (local, in-process) endpoint is refused before anything is sent.
    const sends = w.transport.sends;
    const refused = await run("open", call, "--cluster", "devnet");
    expect(refused.json["error"]).toBe(ErrorCode.ClusterNotAllowed);
    expect(w.transport.sends).toBe(sends);
  });
});
