// A versioned JSON snapshot of the record data, so a page can be rebuilt offline from exactly the
// chain data it was made from. Decoding is strict: snapshots are untrusted input.
import {
  bytes32,
  bytesToHex,
  CallStatus,
  CoreError,
  Direction,
  ErrorCode,
  Outcome,
  SEAL_VERSION_V1,
  Side,
  unwrap,
  validateParams,
  type Bytes32,
  type CallState,
  type CallV1,
  type MarketState,
  type OracleObservation,
  type ProtocolParams,
} from "@agent-call-markets/core";
import type { RecordData } from "./source.ts";

export const SNAPSHOT_SCHEMA = "acm-record-snapshot/v1";

type Json = Record<string, unknown>;

// ---------------------------------------------------------------- encode

const big = (v: bigint): string => v.toString();
const hex = (b: Uint8Array): string => bytesToHex(b);
const opt = <T, R>(v: T | null, f: (x: T) => R): R | null => (v === null ? null : f(v));

function encodeCall(c: CallV1): Json {
  return {
    version: c.version,
    agent: hex(c.agent),
    feedId: hex(c.feedId),
    direction: c.direction,
    level: { mantissa: big(c.level.mantissa), expo: c.level.expo },
    expiryTs: big(c.expiryTs),
  };
}

function encodeMarket(m: MarketState): Json {
  return {
    openedTs: big(m.openedTs),
    pool: { yes: big(m.pool.yes), no: big(m.pool.no) },
    positions: m.positions.map((p) => ({
      owner: hex(p.owner),
      side: p.side,
      amount: big(p.amount),
      redeemed: p.redeemed,
    })),
  };
}

function encodeObservation(o: OracleObservation): Json {
  return {
    feedId: hex(o.feedId),
    price: big(o.price),
    conf: big(o.conf),
    expo: o.expo,
    publishTime: big(o.publishTime),
    prevPublishTime: big(o.prevPublishTime),
  };
}

function encodeState(s: CallState): Json {
  return {
    agent: hex(s.agent),
    commitment: hex(s.commitment),
    sealTs: big(s.sealTs),
    expiryTs: big(s.expiryTs),
    revealDeadlineTs: big(s.revealDeadlineTs),
    status: s.status,
    call: opt(s.call, encodeCall),
    salt: opt(s.salt, hex),
    revealTs: opt(s.revealTs, big),
    market: opt(s.market, encodeMarket),
    outcome: s.outcome,
    observation: opt(s.observation, encodeObservation),
    settledTs: opt(s.settledTs, big),
  };
}

function encodeParams(p: ProtocolParams): Json {
  return {
    revealWindowSecs: big(p.revealWindowSecs),
    minLeadSecs: big(p.minLeadSecs),
    maxHorizonSecs: big(p.maxHorizonSecs),
    tradeCutoffSecs: big(p.tradeCutoffSecs),
    settleWindowSecs: big(p.settleWindowSecs),
    maxConfBps: big(p.maxConfBps),
    voidAfterSecs: big(p.voidAfterSecs),
    minLevelExpo: p.minLevelExpo,
    maxLevelExpo: p.maxLevelExpo,
    allowedFeedIds: p.allowedFeedIds.map(hex),
  };
}

/** Deterministic JSON (fixed key order, bigints as decimal strings, bytes as hex). */
export function encodeSnapshot(d: RecordData): string {
  const body = {
    schema: SNAPSHOT_SCHEMA,
    source: d.source,
    synthetic: d.synthetic,
    takenAt: big(d.takenAt),
    params: encodeParams(d.params),
    agents: d.agents.map((a) => ({ label: a.label, id: hex(a.id) })),
    calls: d.calls.map((c) => ({ id: c.id, state: encodeState(c.state) })),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

// ---------------------------------------------------------------- decode

function bad(path: string, why: string): never {
  throw new CoreError(ErrorCode.InvalidParams, `snapshot ${path}: ${why}`);
}

function obj(v: unknown, path: string): Json {
  if (typeof v !== "object" || v === null || Array.isArray(v)) bad(path, "expected an object");
  return v as Json;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) bad(path, "expected an array");
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string") bad(path, "expected a string");
  return v;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") bad(path, "expected true or false");
  return v;
}

function int(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) bad(path, "expected an integer");
  return v;
}

function bigint(v: unknown, path: string): bigint {
  if (typeof v !== "string" || !/^-?\d+$/.test(v)) bad(path, "expected a decimal integer string");
  return BigInt(v);
}

function b32(v: unknown, path: string): Bytes32 {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v))
    bad(path, "expected 64 lowercase hex digits");
  return bytes32(v);
}

function nullable<T>(v: unknown, f: (x: unknown) => T): T | null {
  return v === null ? null : f(v);
}

function oneOf<T extends string | number>(v: unknown, allowed: readonly T[], path: string): T {
  if (!allowed.includes(v as T)) bad(path, `expected one of ${allowed.join(", ")}`);
  return v as T;
}

function decodeCall(v: unknown, p: string): CallV1 {
  const o = obj(v, p);
  if (o["version"] !== SEAL_VERSION_V1) bad(`${p}.version`, "unsupported seal version");
  const level = obj(o["level"], `${p}.level`);
  return {
    version: SEAL_VERSION_V1,
    agent: b32(o["agent"], `${p}.agent`),
    feedId: b32(o["feedId"], `${p}.feedId`),
    direction: oneOf(o["direction"], [Direction.Above, Direction.Below], `${p}.direction`),
    level: {
      mantissa: bigint(level["mantissa"], `${p}.level.mantissa`),
      expo: int(level["expo"], `${p}.level.expo`),
    },
    expiryTs: bigint(o["expiryTs"], `${p}.expiryTs`),
  };
}

function decodeMarket(v: unknown, p: string): MarketState {
  const o = obj(v, p);
  const pool = obj(o["pool"], `${p}.pool`);
  return {
    openedTs: bigint(o["openedTs"], `${p}.openedTs`),
    pool: { yes: bigint(pool["yes"], `${p}.pool.yes`), no: bigint(pool["no"], `${p}.pool.no`) },
    positions: arr(o["positions"], `${p}.positions`).map((x, i) => {
      const q = obj(x, `${p}.positions[${i}]`);
      return {
        owner: b32(q["owner"], `${p}.positions[${i}].owner`),
        side: oneOf(q["side"], [Side.Yes, Side.No], `${p}.positions[${i}].side`),
        amount: bigint(q["amount"], `${p}.positions[${i}].amount`),
        redeemed: bool(q["redeemed"], `${p}.positions[${i}].redeemed`),
      };
    }),
  };
}

function decodeObservation(v: unknown, p: string): OracleObservation {
  const o = obj(v, p);
  return {
    feedId: b32(o["feedId"], `${p}.feedId`),
    price: bigint(o["price"], `${p}.price`),
    conf: bigint(o["conf"], `${p}.conf`),
    expo: int(o["expo"], `${p}.expo`),
    publishTime: bigint(o["publishTime"], `${p}.publishTime`),
    prevPublishTime: bigint(o["prevPublishTime"], `${p}.prevPublishTime`),
  };
}

function decodeState(v: unknown, p: string): CallState {
  const o = obj(v, p);
  return {
    agent: b32(o["agent"], `${p}.agent`),
    commitment: b32(o["commitment"], `${p}.commitment`),
    sealTs: bigint(o["sealTs"], `${p}.sealTs`),
    expiryTs: bigint(o["expiryTs"], `${p}.expiryTs`),
    revealDeadlineTs: bigint(o["revealDeadlineTs"], `${p}.revealDeadlineTs`),
    status: oneOf(o["status"], Object.values(CallStatus), `${p}.status`),
    call: nullable(o["call"], (x) => decodeCall(x, `${p}.call`)),
    salt: nullable(o["salt"], (x) => b32(x, `${p}.salt`)),
    revealTs: nullable(o["revealTs"], (x) => bigint(x, `${p}.revealTs`)),
    market: nullable(o["market"], (x) => decodeMarket(x, `${p}.market`)),
    outcome: nullable(o["outcome"], (x) => oneOf(x, Object.values(Outcome), `${p}.outcome`)),
    observation: nullable(o["observation"], (x) => decodeObservation(x, `${p}.observation`)),
    settledTs: nullable(o["settledTs"], (x) => bigint(x, `${p}.settledTs`)),
  };
}

function decodeParams(v: unknown): ProtocolParams {
  const o = obj(v, "params");
  const params: ProtocolParams = {
    revealWindowSecs: bigint(o["revealWindowSecs"], "params.revealWindowSecs"),
    minLeadSecs: bigint(o["minLeadSecs"], "params.minLeadSecs"),
    maxHorizonSecs: bigint(o["maxHorizonSecs"], "params.maxHorizonSecs"),
    tradeCutoffSecs: bigint(o["tradeCutoffSecs"], "params.tradeCutoffSecs"),
    settleWindowSecs: bigint(o["settleWindowSecs"], "params.settleWindowSecs"),
    maxConfBps: bigint(o["maxConfBps"], "params.maxConfBps"),
    voidAfterSecs: bigint(o["voidAfterSecs"], "params.voidAfterSecs"),
    minLevelExpo: int(o["minLevelExpo"], "params.minLevelExpo"),
    maxLevelExpo: int(o["maxLevelExpo"], "params.maxLevelExpo"),
    allowedFeedIds: arr(o["allowedFeedIds"], "params.allowedFeedIds").map((x, i) =>
      b32(x, `params.allowedFeedIds[${i}]`),
    ),
  };
  return unwrap(validateParams(params));
}

/** Parses and validates a snapshot. Throws CoreError(INVALID_PARAMS) on anything unexpected. */
export function decodeSnapshot(text: string): RecordData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad("", "not valid JSON");
  }
  const o = obj(raw, "root");
  if (o["schema"] !== SNAPSHOT_SCHEMA) bad("schema", `expected "${SNAPSHOT_SCHEMA}"`);
  return {
    source: str(o["source"], "source"),
    synthetic: bool(o["synthetic"], "synthetic"),
    takenAt: bigint(o["takenAt"], "takenAt"),
    params: decodeParams(o["params"]),
    agents: arr(o["agents"], "agents").map((x, i) => {
      const a = obj(x, `agents[${i}]`);
      return { label: str(a["label"], `agents[${i}].label`), id: b32(a["id"], `agents[${i}].id`) };
    }),
    calls: arr(o["calls"], "calls").map((x, i) => {
      const c = obj(x, `calls[${i}]`);
      return {
        id: str(c["id"], `calls[${i}].id`),
        state: decodeState(c["state"], `calls[${i}].state`),
      };
    }),
  };
}
