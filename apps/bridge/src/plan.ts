import {
  bytes32,
  DEFAULT_PARAMS,
  SEAL_VERSION_V1,
  sealCall,
  unwrap,
  validateCall,
  validateParams,
  type CallV1,
  type ProtocolParams,
} from "@agent-call-markets/core";
import { parseJournal, SkipReason, type ParsedEntry, type Skip } from "./journal.ts";
import type { IdMap } from "./maps.ts";

/**
 * Entries older than this at planning time are not sealed (provisional, docs/DECISIONS.md M5).
 * A seal anchors a call at seal time; refusing stale entries stops anyone from backfilling old
 * journal entries with hindsight. Equal to the core's default reveal window.
 */
export const DEFAULT_MAX_ENTRY_AGE_SECS = 900n;

/** Status of an entry in the bridge's dedupe ledger (see ledger.ts). */
export type LedgerStatus = "pending" | "sealed" | "rejected";

export interface LedgerRecordView {
  readonly entryId: string;
  readonly contentHash: string;
  readonly status: LedgerStatus;
}

export interface LedgerReader {
  get(entryId: string): LedgerRecordView | undefined;
}

export interface PlanInput {
  readonly journal: string;
  readonly agents: IdMap;
  readonly feeds: IdMap;
  /** Planning clock, unix seconds (injected; the CLI uses the current time by default). */
  readonly now: bigint;
  /** Defaults to the core's DEFAULT_PARAMS with the feeds map as the feed allowlist. */
  readonly params?: ProtocolParams;
  readonly maxEntryAgeSecs?: bigint;
  /** Entries already processed in earlier runs. Read only: planning never writes. */
  readonly ledger?: LedgerReader;
}

/** What the agent would seal for one entry. A dry run has no salt and no commitment. */
export interface SealIntent {
  readonly line: number;
  readonly entryId: string;
  readonly contentHash: string;
  readonly agentLabel: string;
  readonly asset: string;
  readonly createdAt: bigint;
  readonly call: CallV1;
  /**
   * The ledger holds this entry as pending: an earlier run drew a salt and may have sent it. The
   * executor looks it up on chain first and re-sends only while the entry is still fresh.
   */
  readonly resume: boolean;
}

export interface BridgePlan {
  readonly mode: "dry-run";
  readonly now: bigint;
  readonly params: ProtocolParams;
  readonly maxEntryAgeSecs: bigint;
  readonly intents: readonly SealIntent[];
  readonly skipped: readonly Skip[];
  readonly counts: { readonly lines: number; readonly intents: number; readonly skipped: number };
}

// Placeholders that let the core's validators run before any salt exists. Never sealed or sent.
const VALIDATION_SALT = bytes32("01".repeat(32));
const VALIDATION_COMMITMENT = bytes32("01".repeat(32));

/**
 * Dry run: turns a journal into seal intents. Pure and deterministic for a given input. Checks, in
 * order: format (journal.ts) -> unique entry id -> ledger -> agent and asset maps -> freshness ->
 * the core's call rules -> the core's expiry window at `now`. Every entry that is not an intent
 * is reported with its reason, so what was left out is visible.
 */
export function planBridge(input: PlanInput): BridgePlan {
  const params = unwrap(
    validateParams(
      input.params ?? { ...DEFAULT_PARAMS, allowedFeedIds: [...input.feeds.values()] },
    ),
  );
  const maxAge = input.maxEntryAgeSecs ?? DEFAULT_MAX_ENTRY_AGE_SECS;
  const parsed = parseJournal(input.journal);
  const skipped: Skip[] = [...parsed.skipped];
  const intents: SealIntent[] = [];
  const firstSeen = new Map<string, ParsedEntry | number>();
  for (const s of parsed.skipped) {
    if (s.entryId !== null && !firstSeen.has(s.entryId)) firstSeen.set(s.entryId, s.line);
  }

  // Entry ids from skipped lines count as used too, so ids must be unique across the journal.
  const ordered = [...parsed.entries].sort((a, b) => a.line - b.line);
  for (const p of ordered) {
    const skip = (reason: SkipReason, detail: string, extra: Partial<Skip> = {}) => {
      skipped.push({ line: p.line, entryId: p.entry.entryId, reason, detail, ...extra });
    };
    const { entry } = p;

    const earlier = firstSeen.get(entry.entryId);
    if (
      earlier !== undefined &&
      (typeof earlier === "number" ? earlier < p.line : earlier.line < p.line)
    ) {
      if (typeof earlier === "number") {
        skip(SkipReason.DuplicateEntryId, `entry id already used on line ${earlier}`);
      } else {
        const same = earlier.contentHash === p.contentHash;
        skip(
          SkipReason.DuplicateEntryId,
          `${same ? "identical to" : "differs from"} line ${earlier.line}; the first occurrence wins`,
        );
      }
      continue;
    }
    firstSeen.set(entry.entryId, p);

    const done = input.ledger?.get(entry.entryId);
    if (done !== undefined && done.contentHash !== p.contentHash) {
      skip(SkipReason.LedgerConflict, "the entry changed since it was processed; not re-sealed");
      continue;
    }
    if (done !== undefined && done.status !== "pending") {
      skip(SkipReason.AlreadyProcessed, `ledger status ${done.status}`);
      continue;
    }
    const resume = done !== undefined; // pending: the executor decides (chain lookup, freshness)

    const agent = input.agents.get(entry.agent);
    if (agent === undefined) {
      skip(SkipReason.UnknownAgent, `agent "${entry.agent}" is not in the agents map`);
      continue;
    }
    const feedId = input.feeds.get(entry.asset);
    if (feedId === undefined) {
      skip(SkipReason.UnknownAsset, `asset "${entry.asset}" is not in the feeds map`);
      continue;
    }
    const call: CallV1 = {
      version: SEAL_VERSION_V1,
      agent,
      feedId,
      direction: entry.direction,
      level: entry.level,
      expiryTs: entry.expiresAt,
    };
    const intent: SealIntent = {
      line: p.line,
      entryId: entry.entryId,
      contentHash: p.contentHash,
      agentLabel: entry.agent,
      asset: entry.asset,
      createdAt: entry.createdAt,
      call,
      resume,
    };
    if (resume) {
      intents.push(intent);
      continue;
    }
    if (entry.createdAt > input.now) {
      skip(SkipReason.EntryInFuture, "createdAt is after the planning clock");
      continue;
    }
    if (input.now - entry.createdAt > maxAge) {
      skip(SkipReason.EntryTooOld, `older than ${maxAge}s; stale entries are never sealed`);
      continue;
    }

    const valid = validateCall(call, VALIDATION_SALT, params);
    if (!valid.ok) {
      skip(SkipReason.CoreRule, valid.error.message, { code: valid.error.code });
      continue;
    }
    const timing = sealCall(
      { agent, commitment: VALIDATION_COMMITMENT, expiryTs: call.expiryTs },
      input.now,
      params,
    );
    if (!timing.ok) {
      skip(SkipReason.CoreRule, timing.error.message, { code: timing.error.code });
      continue;
    }

    intents.push(intent);
  }

  skipped.sort((a, b) => a.line - b.line);
  return {
    mode: "dry-run",
    now: input.now,
    params,
    maxEntryAgeSecs: maxAge,
    intents,
    skipped,
    counts: { lines: parsed.lines, intents: intents.length, skipped: skipped.length },
  };
}
