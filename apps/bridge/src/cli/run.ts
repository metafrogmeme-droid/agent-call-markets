// `pnpm bridge plan ...`: a dry run. It only reads its input files and prints a JSON report.
// Nothing is sent, nothing is written, no keys are involved. Execution (which needs a signer) is
// not part of the CLI in M5.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  bytes32,
  bytesToHex,
  CoreError,
  DEFAULT_PARAMS,
  type ProtocolParams,
} from "@agent-call-markets/core";
import { FileLedger } from "../ledger.ts";
import { parseIdMap, type IdMap } from "../maps.ts";
import { planBridge } from "../plan.ts";

export interface BridgeCliDeps {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const DISCLAIMER =
  "Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.";

export const USAGE = `bridge: journal -> sealed-call planner (dry run only)

${DISCLAIMER}
No US users.

Usage: pnpm bridge plan --journal FILE --agents FILE --feeds FILE [options]

  --journal FILE        journal in the provisional acm-journal-fixture/v0 format (read only)
  --agents FILE         JSON map: agent label -> 32-byte public id (hex)
  --feeds FILE          JSON map: asset label -> 32-byte feed id (hex); also the feed allowlist
  --params FILE         JSON overrides of the core's default parameters (seconds)
  --ledger FILE         dedupe ledger from earlier runs (read only; a missing file is empty)
  --now ISO|UNIX        planning clock, e.g. 2026-12-01T12:00:00Z (default: the current time)
  --max-entry-age SECS  entries older than this are not sealed (default 900)

This is a dry run: it prints what would be sealed and why every other entry is left out. It reads
its input files and writes nothing. Sending seals needs a signer and is not part of this CLI.
`;

const OPTIONS = {
  journal: { type: "string" },
  agents: { type: "string" },
  feeds: { type: "string" },
  params: { type: "string" },
  ledger: { type: "string" },
  now: { type: "string" },
  "max-entry-age": { type: "string" },
  help: { type: "boolean" },
} as const;

class UsageError extends Error {}
class FileError extends Error {}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new FileError(`cannot read ${path}: ${(e as Error).message}`);
  }
}

function need(v: string | undefined, name: string): string {
  if (v === undefined || v === "") throw new UsageError(`missing --${name}`);
  return v;
}

function parseNow(v: string | undefined): bigint {
  if (v === undefined) return BigInt(Math.floor(Date.now() / 1000));
  if (/^\d+$/.test(v)) return BigInt(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v) && Number.isFinite(Date.parse(v))) {
    return BigInt(Date.parse(v) / 1000);
  }
  throw new UsageError("--now must be ISO UTC (2026-12-01T12:00:00Z) or unix seconds");
}

const DURATIONS = [
  "revealWindowSecs",
  "minLeadSecs",
  "maxHorizonSecs",
  "tradeCutoffSecs",
  "settleWindowSecs",
  "maxConfBps",
  "voidAfterSecs",
] as const;

/** Core defaults, the feeds map as allowlist, and optional overrides from a JSON file. */
function readParams(path: string | undefined, feeds: IdMap): ProtocolParams {
  const base: ProtocolParams = { ...DEFAULT_PARAMS, allowedFeedIds: [...feeds.values()] };
  if (path === undefined) return base;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(read(path)) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof FileError) throw e;
    throw new UsageError(`--params ${path} is not valid JSON`);
  }
  const out: Record<string, unknown> = { ...base };
  for (const key of DURATIONS) {
    const v = raw[key];
    if (v !== undefined) out[key] = BigInt(v as string | number);
  }
  for (const key of ["minLevelExpo", "maxLevelExpo"] as const) {
    if (raw[key] !== undefined) out[key] = Number(raw[key]);
  }
  if (Array.isArray(raw["allowedFeedIds"])) {
    out["allowedFeedIds"] = (raw["allowedFeedIds"] as string[]).map((f) => bytes32(f));
  }
  return out as unknown as ProtocolParams;
}

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

/** Runs the CLI. Exit codes: 0 report printed, 1 unreadable or invalid input, 2 usage. */
export function runBridgeCli(argv: readonly string[], deps: BridgeCliDeps): number {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    if (values.help === true) {
      deps.stdout(USAGE);
      return 0;
    }
    const [command] = positionals;
    if (command !== "plan") {
      throw new UsageError(
        command === undefined
          ? "missing command"
          : `unknown command "${command}" (only "plan", a dry run)`,
      );
    }
    const journalPath = need(values.journal, "journal");
    const agentsPath = need(values.agents, "agents");
    const feedsPath = need(values.feeds, "feeds");
    const now = parseNow(values.now);
    const maxAgeText = values["max-entry-age"];
    if (maxAgeText !== undefined && !/^\d+$/.test(maxAgeText)) {
      throw new UsageError("--max-entry-age must be a non-negative integer (seconds)");
    }

    const journal = read(journalPath);
    const agents = parseIdMap(read(agentsPath), "agents");
    const feeds = parseIdMap(read(feedsPath), "feeds");
    const params = readParams(values.params, feeds);
    const plan = planBridge({
      journal,
      agents,
      feeds,
      now,
      params,
      ...(maxAgeText === undefined ? {} : { maxEntryAgeSecs: BigInt(maxAgeText) }),
      ...(values.ledger === undefined ? {} : { ledger: new FileLedger(values.ledger) }),
    });
    deps.stdout(
      toJson({
        ...plan,
        sent: false,
        journal: {
          path: journalPath,
          sha256: createHash("sha256").update(journal).digest("hex"),
          lines: plan.counts.lines,
        },
      }),
    );
    return 0;
  } catch (e) {
    if (
      e instanceof UsageError ||
      (e instanceof Error && "code" in e && String(e.code).startsWith("ERR_PARSE_ARGS"))
    ) {
      deps.stderr(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof FileError) {
      deps.stderr(toJson({ error: "FILE_UNREADABLE", message: e.message }));
      return 1;
    }
    if (e instanceof CoreError) {
      deps.stderr(toJson({ error: e.code, message: e.message }));
      return 1;
    }
    deps.stderr(toJson({ error: "UNEXPECTED", message: (e as Error).message }));
    return 1;
  }
}
