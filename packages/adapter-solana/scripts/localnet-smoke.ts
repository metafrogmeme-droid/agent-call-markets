// End-to-end smoke run on a real `solana-test-validator` bound to 127.0.0.1, through the CLI only
// (RpcTransport, cluster guard, error mapping). Localnet only: nothing here touches devnet.
//
//   node scripts/localnet-smoke.ts prepare DIR   # keys, a PriceUpdateV2 fixture, short params, DIR/env
//   source DIR/env && solana-test-validator --reset --bind-address 127.0.0.1 \
//     --upgradeable-program "$PROGRAM_ID" target/deploy/call_markets.so "$AUTHORITY" \
//     --account "$FIXTURE_ADDRESS" DIR/price-update.json &
//   node scripts/localnet-smoke.ts run DIR
//
// The fixture is a synthetic Pyth PriceUpdateV2 (owner: the pinned Pyth Core receiver) for a
// synthetic feed id, published at a planned time T; the smoke call expires exactly at T, so the
// fixture is the unique update covering expiry. Keys are throwaway files under DIR/.devnet/.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateKeyPairSigner, getBase64Decoder } from "@solana/kit";
import { bytes32, bytesToHex } from "@agent-call-markets/core";
import { runCli } from "../src/cli/run.ts";
import {
  DEFAULT_RPC_URL,
  PLACEHOLDER_PROGRAM_ID,
  PYTH_RECEIVER_PROGRAM_ID,
} from "../src/constants.ts";
import { encodePriceUpdateV2 } from "../src/pyth.ts";
import { RpcTransport } from "../src/transport.ts";

/** Seconds from `prepare` to the fixture's publish time (= the call's expiry). */
const LEAD_SECS = 180n;
const FEED = bytes32("f1".repeat(32)); // synthetic, not a real Pyth feed id
const SMOKE_PARAMS = {
  revealWindowSecs: 30,
  minLeadSecs: 60,
  maxHorizonSecs: 600,
  tradeCutoffSecs: 10,
  settleWindowSecs: 10,
  voidAfterSecs: 120,
};

interface Meta {
  readonly publishTime: string;
  readonly fixtureAddress: string;
  readonly authority: string;
  readonly trader: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(message: string): never {
  console.error(`localnet smoke: FAILED: ${message}`);
  process.exit(1);
}

async function cli(
  dir: string,
  ...argv: string[]
): Promise<{ code: number; json: Record<string, unknown> }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd: dir,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  });
  const text = out[0] ?? err[0] ?? "{}";
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { code, json };
}

async function step(dir: string, label: string, argv: string[], expectCode = 0) {
  const r = await cli(dir, ...argv);
  if (r.code !== expectCode) fail(`${label}: exit ${r.code} ${JSON.stringify(r.json)}`);
  console.log(`ok  ${label}`);
  return r.json;
}

async function prepare(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const authority = (await step(dir, "keygen (agent + upgrade authority)", ["keygen"]))["address"];
  const trader = (
    await step(dir, "keygen (trader)", ["keygen", "--keypair", join(dir, ".devnet", "trader.json")])
  )["address"];
  const publishTime = BigInt(Math.floor(Date.now() / 1000)) + LEAD_SECS;
  const fixture = (await generateKeyPairSigner()).address;
  const data = encodePriceUpdateV2({
    feedId: FEED,
    price: 101_000_000n, // 101.000000 > level 100 -> HIT
    conf: 0n,
    expo: -6,
    publishTime,
    prevPublishTime: publishTime - 1n,
  });
  writeFileSync(
    join(dir, "price-update.json"),
    JSON.stringify({
      pubkey: fixture,
      account: {
        lamports: 1_000_000_000,
        data: [getBase64Decoder().decode(data), "base64"],
        owner: PYTH_RECEIVER_PROGRAM_ID,
        executable: false,
        rentEpoch: 0,
        space: data.length,
      },
    }),
  );
  writeFileSync(join(dir, "params.json"), JSON.stringify(SMOKE_PARAMS));
  const meta: Meta = {
    publishTime: publishTime.toString(),
    fixtureAddress: fixture,
    authority: String(authority),
    trader: String(trader),
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  writeFileSync(
    join(dir, "env"),
    `PROGRAM_ID=${PLACEHOLDER_PROGRAM_ID}\nAUTHORITY=${meta.authority}\nFIXTURE_ADDRESS=${fixture}\n`,
  );
  console.log(`prepared ${dir}: fixture ${fixture} publishes at ${publishTime}`);
}

async function waitFor(what: string, timeoutMs: number, check: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

async function run(dir: string): Promise<void> {
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Meta;
  const publishTime = BigInt(meta.publishTime);
  const rpc = new RpcTransport(DEFAULT_RPC_URL.localnet);
  await waitFor(
    "the local validator",
    120_000,
    async () => (await rpc.getGenesisHash()).length > 0,
  );
  const clock = () => rpc.getUnixTimestamp();
  const trader = ["--keypair", join(dir, ".devnet", "trader.json")];
  const feed = bytesToHex(FEED);

  await step(dir, "airdrop (agent)", ["airdrop", "--sol", "10"]);
  await step(dir, "airdrop (trader)", ["airdrop", "--sol", "2", ...trader]);
  const mint = String((await step(dir, "admin init-mint", ["admin", "init-mint"]))["mint"]);
  await step(dir, "admin init-config", [
    "admin",
    "init-config",
    "--mint",
    mint,
    "--feed",
    feed,
    "--params",
    join(dir, "params.json"),
  ]);
  await step(dir, "admin mint-to (agent)", [
    "admin",
    "mint-to",
    "--mint",
    mint,
    "--to",
    meta.authority,
    "--amount",
    "1000",
  ]);
  await step(dir, "admin mint-to (trader)", [
    "admin",
    "mint-to",
    "--mint",
    mint,
    "--to",
    meta.trader,
    "--amount",
    "1000",
  ]);

  const refused = await step(
    dir,
    "devnet claim on a local RPC is refused",
    // --url pins the local RPC: the claim "devnet" is checked against its genesis hash.
    ["list", "--cluster", "devnet", "--url", DEFAULT_RPC_URL.localnet, "--agent", meta.authority],
    1,
  );
  if (refused["error"] !== "CLUSTER_NOT_ALLOWED")
    fail(`expected CLUSTER_NOT_ALLOWED, got ${JSON.stringify(refused)}`);

  const sealed = await step(dir, "seal", [
    "seal",
    "--feed",
    feed,
    "--direction",
    "above",
    "--level",
    "100",
    "--expiry",
    publishTime.toString(),
  ]);
  const call = String(sealed["call"]);
  const shown = await step(dir, "show (sealed)", ["show", call]);
  const sealTs = BigInt(String(shown["sealTs"]));
  await waitFor("a later second than the seal", 30_000, async () => (await clock()) > sealTs);
  await step(dir, "reveal", ["reveal", call]);
  await step(dir, "open", ["open", call]);
  await step(dir, "buy yes 100 (agent)", ["buy", call, "--side", "yes", "--amount", "100"]);
  await step(dir, "buy no 300 (trader)", [
    "buy",
    call,
    "--side",
    "no",
    "--amount",
    "300",
    ...trader,
  ]);

  console.log(`waiting for the cluster clock to reach expiry ${publishTime} ...`);
  await waitFor(
    "expiry",
    Number(LEAD_SECS + 120n) * 1000,
    async () => (await clock()) >= publishTime,
  );
  const settled = await step(dir, "settle", [
    "settle",
    call,
    "--price-update",
    meta.fixtureAddress,
  ]);
  if (settled["outcome"] !== "HIT" || settled["outcomeCheck"] !== "match") {
    fail(`unexpected settlement ${JSON.stringify(settled)}`);
  }
  const dup = await step(
    dir,
    "same price update again is rejected",
    ["settle", call, "--price-update", meta.fixtureAddress],
    1,
  );
  if (dup["error"] !== "DUPLICATE_PRICE_UPDATE")
    fail(`expected DUPLICATE_PRICE_UPDATE, got ${JSON.stringify(dup)}`);

  const won = await step(dir, "redeem (agent, YES wins)", ["redeem", call]);
  if (won["payout"] !== "400") fail(`expected payout 400, got ${JSON.stringify(won)}`);
  const lost = await step(dir, "redeem (trader, NO loses)", ["redeem", call, ...trader]);
  if (lost["payout"] !== "0") fail(`expected payout 0, got ${JSON.stringify(lost)}`);
  const listed = await step(dir, "list", ["list", "--agent", meta.authority]);
  if (listed["summary"] !== "100.0% hit rate (1 of 1 decided; 0 voids)") {
    fail(`unexpected record ${JSON.stringify(listed)}`);
  }
  console.log("localnet smoke: OK");
}

const [mode, dirArg] = process.argv.slice(2);
if (dirArg === undefined || (mode !== "prepare" && mode !== "run")) {
  console.error("usage: localnet-smoke.ts prepare|run DIR");
  process.exit(2);
}
const dir = resolve(dirArg);
await (mode === "prepare" ? prepare(dir) : run(dir));
