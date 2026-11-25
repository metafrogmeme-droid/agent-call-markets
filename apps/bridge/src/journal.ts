import { createHash } from "node:crypto";
import { Direction, type ErrorCode, type FixedPoint } from "@agent-call-markets/core";
import { parseDecimal } from "./decimal.ts";

/**
 * Provisional journal format `acm-journal-fixture/v0` (JSON Lines, one entry per line).
 *
 * This is our own synthetic format for fixtures and tests. It is NOT the AudaceFi journal format,
 * which is still unknown (open question Q8); a real format gets its own parser next to this one.
 *
 *   { "schema": "acm-journal-fixture/v0", "entryId": "FAKE-0001", "agent": "FAKE-AGENT-1",
 *     "kind": "call", "createdAt": "2026-12-01T11:55:00Z", "asset": "FAKE-SOL/USD",
 *     "direction": "above", "level": "185.25", "expiresAt": "2026-12-01T18:00:00Z" }
 *
 * Only `kind: "call"` entries are bridged. Extra fields are ignored and never reach a seal (seals
 * carry no free text). Times are UTC, whole seconds, with a trailing Z.
 */
export const JOURNAL_SCHEMA_V0 = "acm-journal-fixture/v0";

/** Why an entry is not turned into a seal. Every skip is reported, so selection is auditable. */
export const SkipReason = {
  MalformedJson: "MALFORMED_JSON",
  WrongSchema: "WRONG_SCHEMA",
  InvalidField: "INVALID_FIELD",
  NotACall: "NOT_A_CALL",
  DuplicateEntryId: "DUPLICATE_ENTRY_ID",
  UnknownAgent: "UNKNOWN_AGENT",
  UnknownAsset: "UNKNOWN_ASSET",
  EntryInFuture: "ENTRY_IN_FUTURE",
  EntryTooOld: "ENTRY_TOO_OLD",
  /** The core's own rule rejects the call (`code` says which, as the chain would). */
  CoreRule: "CORE_RULE",
  AlreadyProcessed: "ALREADY_PROCESSED",
  LedgerConflict: "LEDGER_CONFLICT",
  /** Execution only: the entry's agent is not the signer the adapter seals as. */
  NotThisAgent: "NOT_THIS_AGENT",
} as const;
export type SkipReason = (typeof SkipReason)[keyof typeof SkipReason];

export interface Skip {
  readonly line: number;
  readonly entryId: string | null;
  readonly reason: SkipReason;
  readonly code?: ErrorCode;
  readonly detail: string;
}

/** The raw bridged fields, exactly as written in the journal (used for the content hash). */
export interface RawCallFields {
  readonly entryId: string;
  readonly agent: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly asset: string;
  readonly direction: string;
  readonly level: string;
  readonly expiresAt: string;
}

export interface JournalEntryV0 {
  readonly schema: typeof JOURNAL_SCHEMA_V0;
  readonly entryId: string;
  readonly agent: string;
  readonly asset: string;
  readonly direction: Direction;
  readonly level: FixedPoint;
  /** Unix seconds. */
  readonly createdAt: bigint;
  /** Unix seconds. */
  readonly expiresAt: bigint;
}

export interface ParsedEntry {
  readonly line: number;
  readonly entry: JournalEntryV0;
  readonly raw: RawCallFields;
  readonly contentHash: string;
}

export interface ParsedJournal {
  readonly entries: readonly ParsedEntry[];
  readonly skipped: readonly Skip[];
  /** Non-blank lines. */
  readonly lines: number;
}

const ENTRY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** sha256 over the bridged fields in a fixed order; extra fields never count. */
export function contentHash(raw: RawCallFields): string {
  const canonical = JSON.stringify([
    raw.entryId,
    raw.agent,
    raw.kind,
    raw.createdAt,
    raw.asset,
    raw.direction,
    raw.level,
    raw.expiresAt,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Strict ISO-8601 UTC with whole seconds -> unix seconds; null if invalid (e.g. 30 February). */
function parseUtc(text: string): bigint | null {
  if (!UTC_SECONDS.test(text)) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== text.replace("Z", ".000Z"))
    return null;
  return BigInt(ms / 1000);
}

function str(o: Record<string, unknown>, key: string, max = 64): string | null {
  const v = o[key];
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

type FieldResult =
  { ok: true; entry: JournalEntryV0; raw: RawCallFields } | { ok: false; field: string };

function readCall(o: Record<string, unknown>, entryId: string): FieldResult {
  const agent = str(o, "agent");
  if (agent === null) return { ok: false, field: "agent" };
  const asset = str(o, "asset");
  if (asset === null) return { ok: false, field: "asset" };
  const dir = o["direction"];
  if (dir !== "above" && dir !== "below") return { ok: false, field: "direction" };
  const levelText = o["level"];
  const level = typeof levelText === "string" ? parseDecimal(levelText) : null;
  if (level === null || typeof levelText !== "string") return { ok: false, field: "level" };
  const createdText = o["createdAt"];
  const createdAt = typeof createdText === "string" ? parseUtc(createdText) : null;
  if (createdAt === null || typeof createdText !== "string")
    return { ok: false, field: "createdAt" };
  const expiresText = o["expiresAt"];
  const expiresAt = typeof expiresText === "string" ? parseUtc(expiresText) : null;
  if (expiresAt === null || typeof expiresText !== "string")
    return { ok: false, field: "expiresAt" };
  return {
    ok: true,
    entry: {
      schema: JOURNAL_SCHEMA_V0,
      entryId,
      agent,
      asset,
      direction: dir === "above" ? Direction.Above : Direction.Below,
      level,
      createdAt,
      expiresAt,
    },
    raw: {
      entryId,
      agent,
      kind: "call",
      createdAt: createdText,
      asset,
      direction: dir,
      level: levelText,
      expiresAt: expiresText,
    },
  };
}

/**
 * Parses a v0 journal. Never throws on content: each bad line becomes a reported skip. This only
 * checks the format; mapping, freshness, the core's rules and dedupe happen in `planBridge`.
 */
export function parseJournal(text: string): ParsedJournal {
  const entries: ParsedEntry[] = [];
  const skipped: Skip[] = [];
  let lines = 0;
  text.split(/\r?\n/).forEach((source, index) => {
    const lineNo = index + 1;
    if (source.trim() === "") return;
    lines++;
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      skipped.push({
        line: lineNo,
        entryId: null,
        reason: SkipReason.MalformedJson,
        detail: "not valid JSON",
      });
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      skipped.push({
        line: lineNo,
        entryId: null,
        reason: SkipReason.WrongSchema,
        detail: "not a JSON object",
      });
      return;
    }
    const o = value as Record<string, unknown>;
    const id = o["entryId"];
    const entryId = typeof id === "string" ? id : null;
    if (o["schema"] !== JOURNAL_SCHEMA_V0) {
      skipped.push({
        line: lineNo,
        entryId,
        reason: SkipReason.WrongSchema,
        detail: `schema must be "${JOURNAL_SCHEMA_V0}"`,
      });
      return;
    }
    if (entryId === null || !ENTRY_ID.test(entryId)) {
      skipped.push({
        line: lineNo,
        entryId,
        reason: SkipReason.InvalidField,
        detail: "invalid entryId",
      });
      return;
    }
    const kind = o["kind"];
    if (typeof kind !== "string") {
      skipped.push({
        line: lineNo,
        entryId,
        reason: SkipReason.InvalidField,
        detail: "invalid kind",
      });
      return;
    }
    if (kind !== "call") {
      skipped.push({
        line: lineNo,
        entryId,
        reason: SkipReason.NotACall,
        detail: `kind "${kind}" is not bridged`,
      });
      return;
    }
    const r = readCall(o, entryId);
    if (!r.ok) {
      skipped.push({
        line: lineNo,
        entryId,
        reason: SkipReason.InvalidField,
        detail: `invalid ${r.field}`,
      });
      return;
    }
    entries.push({ line: lineNo, entry: r.entry, raw: r.raw, contentHash: contentHash(r.raw) });
  });
  return { entries, skipped, lines };
}
