// The `acm` CLI: devnet/localnet only. Every command that touches a cluster goes through
// SolanaAdapter.connect, so the cluster guard runs before any read and again before every send.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isAddress, type Address, type KeyPairSigner } from "@solana/kit";
import {
  bytes32,
  bytesToHex,
  commitmentOf,
  computeAgentRecord,
  CoreError,
  decideOutcome,
  DEFAULT_PARAMS,
  Direction,
  ErrorCode,
  formatHitRate,
  randomSalt,
  recordStatus,
  SEAL_VERSION_V1,
  Side,
  validateParams,
  unwrap,
  type CallV1,
  type ProtocolParams,
} from "@agent-call-markets/core";
import { addressFromBytes32, SolanaAdapter, type SolanaCallRecord } from "../adapter.ts";
import { addressToBytes32 } from "../codec/accounts.ts";
import { DEFAULT_RPC_URL, DISCLAIMER, NO_US_USERS, type Cluster } from "../constants.ts";
import { parseCluster } from "../guard.ts";
import { RpcTransport, type SolanaTransport } from "../transport.ts";
import {
  defaultKeypairPath,
  generateKeypairFile,
  loadKeypairFile,
  readSaltFile,
  saltPath,
  writeSaltFile,
} from "./files.ts";

export interface CliDeps {
  /** Base directory for .devnet/ (keypair, salts). */
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Defaults to an RpcTransport on `url`. Tests inject an in-process transport. */
  readonly transport?: (cluster: Cluster, url: string) => SolanaTransport;
}

export const USAGE = `acm: Agent Call Markets CLI (Solana devnet / localnet only)

${DISCLAIMER}
${NO_US_USERS}

Usage: acm <command> [options]

Commands
  keygen                         create a throwaway keypair (.devnet/keypair.json, 0600)
  airdrop [--sol N]              devnet/localnet faucet for the keypair (default 1 SOL)
  admin init-mint [--decimals N] create an SPL Token test mint (you are the mint authority)
  admin mint-to --mint A --to A --amount N
  admin init-config --mint A --feed HEX [--feed HEX ...] [--params FILE]
                                 one-time config; signer must be the program upgrade authority
  seal --feed HEX --direction above|below --level DEC (--expiry TS | --expires-in SECS)
                                 seal a call; the salt is saved to .devnet/salts/ before sending
  reveal CALL                    reveal a sealed call from its saved salt
  open CALL                      open the parimutuel market on a revealed call
  quote CALL --side yes|no --amount N
  buy CALL --side yes|no --amount N [--min-payout N]
  settle CALL --price-update ADDR
                                 settle from one existing Pyth PriceUpdateV2 account
  void CALL                      void an unsettled call after expiry + voidAfter
  redeem CALL                    redeem the keypair's positions
  show CALL                      the call, its market and settlement, outcome re-checked by core
  list [--agent ADDR]            an agent's calls and record (raw counts, hit rate with n)

Options
  --cluster devnet|localnet      default localnet; any other cluster is refused
  --url URL                      RPC URL (must match --cluster: the genesis hash is checked)
  --keypair PATH                 default .devnet/keypair.json
  --program-id ADDR              default: the placeholder id in programs/call_markets
  --help
`;

const OPTIONS = {
  cluster: { type: "string" },
  url: { type: "string" },
  keypair: { type: "string" },
  "program-id": { type: "string" },
  help: { type: "boolean" },
  sol: { type: "string" },
  decimals: { type: "string" },
  mint: { type: "string" },
  to: { type: "string" },
  amount: { type: "string" },
  feed: { type: "string", multiple: true },
  params: { type: "string" },
  direction: { type: "string" },
  level: { type: "string" },
  expiry: { type: "string" },
  "expires-in": { type: "string" },
  side: { type: "string" },
  "min-payout": { type: "string" },
  "price-update": { type: "string" },
  agent: { type: "string" },
} as const;

type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>["values"];

class UsageError extends Error {}

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** JSON with bigints as decimal strings and bytes as hex. */
export function toJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v: unknown) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Uint8Array) return bytesToHex(v);
      return v;
    },
    2,
  );
}

function need(v: string | undefined, name: string): string {
  if (v === undefined || v === "") throw new UsageError(`missing --${name}`);
  return v;
}

function parseUint(v: string, name: string): bigint {
  if (!/^\d+$/.test(v)) throw new UsageError(`--${name} must be a non-negative integer`);
  return BigInt(v);
}

function parseAddr(v: string, name: string): Address {
  if (!isAddress(v)) throw new UsageError(`${name} is not a valid address: ${v}`);
  return v;
}

/** "100.25" -> { mantissa: 10025n, expo: -2 } (positive decimals only). */
export function parseLevel(v: string): { mantissa: bigint; expo: number } {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(v);
  if (m === null) throw new UsageError("--level must be a positive decimal like 100 or 100.25");
  const frac = m[2] ?? "";
  const mantissa = BigInt(`${m[1] ?? ""}${frac}`);
  if (mantissa <= 0n) throw new UsageError("--level must be positive");
  return { mantissa, expo: frac.length === 0 ? 0 : -frac.length };
}

function parseDirection(v: string): Direction {
  if (v === "above") return Direction.Above;
  if (v === "below") return Direction.Below;
  throw new UsageError("--direction must be above or below");
}

function parseSide(v: string): Side {
  if (v === "yes") return Side.Yes;
  if (v === "no") return Side.No;
  throw new UsageError("--side must be yes or no");
}

/** Optional overrides of DEFAULT_PARAMS from a JSON file (durations in seconds). */
function readParams(path: string | undefined, feeds: readonly string[]): ProtocolParams {
  const allowedFeedIds = feeds.map((f) => bytes32(f));
  let p: ProtocolParams = { ...DEFAULT_PARAMS, allowedFeedIds };
  if (path !== undefined) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const big = (k: keyof ProtocolParams) =>
      raw[k] === undefined ? (p[k] as bigint) : BigInt(raw[k] as string | number);
    const num = (k: keyof ProtocolParams) =>
      raw[k] === undefined ? (p[k] as number) : Number(raw[k]);
    p = {
      revealWindowSecs: big("revealWindowSecs"),
      minLeadSecs: big("minLeadSecs"),
      maxHorizonSecs: big("maxHorizonSecs"),
      tradeCutoffSecs: big("tradeCutoffSecs"),
      settleWindowSecs: big("settleWindowSecs"),
      maxConfBps: big("maxConfBps"),
      voidAfterSecs: big("voidAfterSecs"),
      minLevelExpo: num("minLevelExpo"),
      maxLevelExpo: num("maxLevelExpo"),
      allowedFeedIds,
    };
  }
  return unwrap(validateParams(p));
}

function callRef(adapter: SolanaAdapter, id: string | undefined) {
  if (id === undefined) throw new UsageError("missing CALL (the call account address)");
  return { chainId: adapter.chainId, id: parseAddr(id, "CALL") };
}

function describe(rec: SolanaCallRecord, now: bigint, params: ProtocolParams) {
  const { state, account } = rec;
  const coreOutcome =
    state.call !== null && state.observation !== null
      ? decideOutcome(state.call, state.observation, params)
      : null;
  return {
    call: rec.address,
    chainId: rec.ref.chainId,
    status: state.status,
    recordStatus: recordStatus(state, now),
    agent: addressFromBytes32(state.agent),
    commitment: state.commitment,
    sealSlot: account.seal_slot,
    sealTs: state.sealTs,
    expiryTs: state.expiryTs,
    revealDeadlineTs: state.revealDeadlineTs,
    revealed:
      state.call === null
        ? null
        : {
            feedId: state.call.feedId,
            direction: state.call.direction === Direction.Above ? "above" : "below",
            level: state.call.level,
            salt: state.salt,
            revealTs: state.revealTs,
          },
    market:
      state.market === null
        ? null
        : {
            openedTs: state.market.openedTs,
            pool: state.market.pool,
            positions: rec.positions.map((p) => ({
              owner: p.owner,
              side: p.side === 1 ? "yes" : "no",
              amount: p.amount,
              redeemed: p.redeemed,
            })),
          },
    settlement:
      state.outcome === null
        ? null
        : {
            outcome: state.outcome,
            coreOutcome:
              coreOutcome === null
                ? null
                : coreOutcome.ok
                  ? coreOutcome.value
                  : coreOutcome.error.code,
            outcomeCheck: rec.outcomeCheck,
            acceptedUpdate: account.accepted_update,
            observation: state.observation,
            settledTs: state.settledTs,
            settler: account.settler,
          },
  };
}

/** Runs one CLI command. Returns the process exit code (0 ok, 1 refused/failed, 2 usage). */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    }));
  } catch (e) {
    deps.stderr(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help === true || positionals.length === 0) {
    deps.stdout(USAGE);
    return values.help === true ? 0 : 2;
  }
  const out = (v: unknown) => {
    deps.stdout(toJson(v));
  };
  try {
    await dispatch(positionals, values, deps, out);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      deps.stderr(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof CoreError) {
      deps.stderr(toJson({ error: e.code, message: e.message }));
      return 1;
    }
    deps.stderr(toJson({ error: "UNEXPECTED", message: (e as Error).message }));
    return 1;
  }
}

async function dispatch(
  positionals: string[],
  values: Values,
  deps: CliDeps,
  out: (v: unknown) => void,
): Promise<void> {
  const [command, ...rest] = positionals;
  // Refuses mainnet/testnet names before anything else happens.
  const cluster = parseCluster(values.cluster ?? "localnet");
  const keypairPath = values.keypair ?? defaultKeypairPath(deps.cwd);

  if (command === "keygen") {
    const address = await generateKeypairFile(keypairPath);
    out({
      address,
      keypair: keypairPath,
      note: "throwaway devnet/localnet key; never use it for real funds",
    });
    return;
  }

  const url = values.url ?? DEFAULT_RPC_URL[cluster];
  const transport = deps.transport ? deps.transport(cluster, url) : new RpcTransport(url);
  const readOnly = command === "show" || command === "list" || command === "quote";
  let signer: KeyPairSigner | null = null;
  try {
    signer = await loadKeypairFile(keypairPath);
  } catch (e) {
    if (!readOnly) throw e;
  }
  const programId =
    values["program-id"] === undefined
      ? undefined
      : parseAddr(values["program-id"], "--program-id");
  const adapter = await SolanaAdapter.connect({
    cluster,
    transport,
    signer,
    ...(programId === undefined ? {} : { programId }),
  });

  switch (command) {
    case "airdrop": {
      const sol = parseUint(values.sol ?? "1", "sol");
      out({ signature: await adapter.airdrop(sol * LAMPORTS_PER_SOL), sol });
      return;
    }
    case "admin": {
      const [sub] = rest;
      if (sub === "init-mint") {
        const decimals = Number(parseUint(values.decimals ?? "6", "decimals"));
        const tx = await adapter.createTestMint(decimals);
        out({ mint: tx.value, decimals, txId: tx.txId });
        return;
      }
      if (sub === "mint-to") {
        const tx = await adapter.mintTestTokens(
          parseAddr(need(values.mint, "mint"), "--mint"),
          parseAddr(need(values.to, "to"), "--to"),
          parseUint(need(values.amount, "amount"), "amount"),
        );
        out({ tokenAccount: tx.value, txId: tx.txId });
        return;
      }
      if (sub === "init-config") {
        const feeds = values.feed ?? [];
        if (feeds.length === 0) throw new UsageError("init-config needs at least one --feed");
        const params = readParams(values.params, feeds);
        const tx = await adapter.initializeConfig(
          params,
          parseAddr(need(values.mint, "mint"), "--mint"),
        );
        out({ config: tx.value, txId: tx.txId, params });
        return;
      }
      throw new UsageError("admin needs init-mint, mint-to or init-config");
    }
    case "seal": {
      if (signer === null) throw new UsageError("seal needs a keypair");
      const now = await adapter.now();
      const expiryTs =
        values.expiry !== undefined
          ? parseUint(values.expiry, "expiry")
          : now + parseUint(need(values["expires-in"], "expires-in"), "expires-in");
      const call: CallV1 = {
        version: SEAL_VERSION_V1,
        agent: addressToBytes32(signer.address),
        feedId: bytes32(need(values.feed?.[0], "feed")),
        direction: parseDirection(need(values.direction, "direction")),
        level: parseLevel(need(values.level, "level")),
        expiryTs,
      };
      const salt = randomSalt();
      const commitment = commitmentOf(call, salt);
      const path = saltPath(deps.cwd, cluster, commitment);
      writeSaltFile(path, {
        version: 1,
        cluster,
        programId: adapter.programId,
        call: "pending",
        agent: bytesToHex(call.agent),
        feedId: bytesToHex(call.feedId),
        direction: call.direction,
        levelMantissa: call.level.mantissa.toString(),
        levelExpo: call.level.expo,
        expiryTs: expiryTs.toString(),
        salt: bytesToHex(salt),
      });
      const tx = await adapter.sealCall({ commitment, expiryTs });
      const rec = await adapter.getCall(tx.value);
      out({
        call: tx.value.id,
        commitment,
        expiryTs,
        revealDeadlineTs: rec?.state.revealDeadlineTs ?? null,
        saltFile: path,
        txId: tx.txId,
      });
      return;
    }
    case "reveal": {
      const ref = callRef(adapter, rest[0]);
      const rec = await adapter.getCall(ref);
      if (rec === null) throw new CoreError(ErrorCode.UnknownCall, `unknown call ${ref.id}`);
      const { call, salt } = readSaltFile(saltPath(deps.cwd, cluster, rec.state.commitment));
      const tx = await adapter.revealCall(ref, call, salt);
      out({ call: ref.id, txId: tx.txId });
      return;
    }
    case "open": {
      const tx = await adapter.openMarket(callRef(adapter, rest[0]));
      out({ market: tx.value.id, txId: tx.txId });
      return;
    }
    case "quote": {
      const q = await adapter.quote(
        callRef(adapter, rest[0]),
        parseSide(need(values.side, "side")),
        parseUint(need(values.amount, "amount"), "amount"),
      );
      out({
        ...q,
        note: "projected payout if nobody trades after you; parimutuel, final payout known at settlement",
      });
      return;
    }
    case "buy": {
      const tx = await adapter.trade(
        callRef(adapter, rest[0]),
        parseSide(need(values.side, "side")),
        parseUint(need(values.amount, "amount"), "amount"),
        parseUint(values["min-payout"] ?? "0", "min-payout"),
      );
      out({ txId: tx.txId });
      return;
    }
    case "settle": {
      const ref = callRef(adapter, rest[0]);
      const priceUpdate = parseAddr(need(values["price-update"], "price-update"), "--price-update");
      const tx = await adapter.settle(ref, { kind: "account", address: priceUpdate });
      const rec = await adapter.getCall(ref);
      out({
        call: ref.id,
        outcome: tx.value,
        outcomeCheck: rec?.outcomeCheck ?? null,
        txId: tx.txId,
      });
      return;
    }
    case "void": {
      const tx = await adapter.voidUnsettled(callRef(adapter, rest[0]));
      out({ txId: tx.txId });
      return;
    }
    case "redeem": {
      const tx = await adapter.redeem(callRef(adapter, rest[0]));
      out({ payout: tx.value, txId: tx.txId });
      return;
    }
    case "show": {
      const rec = await adapter.getCall(callRef(adapter, rest[0]));
      if (rec === null) throw new CoreError(ErrorCode.UnknownCall, `unknown call ${rest[0] ?? ""}`);
      out(describe(rec, await adapter.now(), (await adapter.config()).params));
      return;
    }
    case "list": {
      let agent: Address;
      if (values.agent !== undefined) agent = parseAddr(values.agent, "--agent");
      else if (signer !== null) agent = signer.address;
      else throw new UsageError("list needs --agent (or a keypair)");
      const now = await adapter.now();
      const records = await adapter.listCalls(addressToBytes32(agent));
      const record = computeAgentRecord(
        addressToBytes32(agent),
        records.map((r) => r.state),
        now,
      );
      out({
        agent,
        now,
        record: {
          ...record,
          hitRate: record.hitRate === null ? null : `${record.hitRate.num}/${record.hitRate.den}`,
        },
        summary: formatHitRate(record),
        calls: records.map((r) => ({
          call: r.address,
          status: r.state.status,
          recordStatus: recordStatus(r.state, now),
          expiryTs: r.state.expiryTs,
          outcome: r.state.outcome,
          outcomeCheck: r.outcomeCheck,
        })),
      });
      return;
    }
    case undefined:
    default:
      throw new UsageError(`unknown command ${command ?? ""}`);
  }
}
