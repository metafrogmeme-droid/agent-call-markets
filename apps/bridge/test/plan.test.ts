import { describe, expect, it } from "vitest";
import { Direction, ErrorCode } from "@agent-call-markets/core";
import { SkipReason } from "../src/journal.ts";
import { parseIdMap } from "../src/maps.ts";
import { DEFAULT_MAX_ENTRY_AGE_SECS, planBridge, type PlanInput } from "../src/plan.ts";
import {
  AGENT_1,
  AGENT_2,
  AGENTS_JSON,
  FEED_BTC,
  FEED_SOL,
  FEEDS_JSON,
  JOURNAL,
  line,
  NOW,
  PARAMS,
  unix,
} from "./helpers.ts";

const base: PlanInput = {
  journal: JOURNAL,
  agents: parseIdMap(AGENTS_JSON, "agents"),
  feeds: parseIdMap(FEEDS_JSON, "feeds"),
  now: NOW,
};

describe("planBridge (dry run)", () => {
  it("turns exactly the eligible entries into seal intents and reports every other entry", () => {
    const plan = planBridge(base);
    expect(plan.mode).toBe("dry-run");
    expect(plan.now).toBe(NOW);
    expect(plan.intents.map((i) => [i.line, i.entryId])).toEqual([
      [1, "FAKE-0001"],
      [2, "FAKE-0002"],
    ]);
    const why = plan.skipped.map((s) => [s.line, s.entryId, s.reason, s.code ?? null]);
    expect(why).toEqual([
      [3, "FAKE-0003", SkipReason.NotACall, null],
      [4, "FAKE-0001", SkipReason.DuplicateEntryId, null],
      [5, "FAKE-0004", SkipReason.UnknownAsset, null],
      [6, "FAKE-0005", SkipReason.CoreRule, ErrorCode.ExpiryTooSoon],
      [7, "FAKE-0006", SkipReason.CoreRule, ErrorCode.ExpiryTooFar],
      [8, "FAKE-0007", SkipReason.InvalidField, null],
      [9, "FAKE-0008", SkipReason.EntryInFuture, null],
      [10, "FAKE-0009", SkipReason.EntryTooOld, null],
      [11, null, SkipReason.MalformedJson, null],
      [12, "FAKE-0011", SkipReason.WrongSchema, null],
      [13, "FAKE-0012", SkipReason.UnknownAgent, null],
      [15, "FAKE-0013", SkipReason.CoreRule, ErrorCode.InvalidExponent],
      [16, "FAKE-0014", SkipReason.InvalidField, null],
      [17, null, SkipReason.WrongSchema, null],
    ]);
    expect(plan.counts).toEqual({ lines: 16, intents: 2, skipped: 14 });
  });

  it("builds the CallV1 the agent would seal (no salt, no commitment in a dry run)", () => {
    const [sol, btc] = planBridge(base).intents;
    expect(sol?.call).toEqual({
      version: 1,
      agent: AGENT_1,
      feedId: FEED_SOL,
      direction: Direction.Above,
      level: { mantissa: 18525n, expo: -2 },
      expiryTs: unix("2026-12-01T18:00:00Z"),
    });
    expect(btc?.call).toMatchObject({
      agent: AGENT_2,
      feedId: FEED_BTC,
      direction: Direction.Below,
    });
    expect(sol).toMatchObject({ agentLabel: "FAKE-AGENT-1", asset: "FAKE-SOL/USD" });
    expect(sol?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(sol ?? {})).not.toContain("salt");
  });

  it("is pure and deterministic", () => {
    expect(planBridge(base)).toEqual(planBridge(base));
  });

  it("uses the core's timing rule at the planning clock (exactly minLead is allowed)", () => {
    const journal = line({ createdAt: "2026-12-01T16:59:00Z" }); // expires 18:00:00
    const atLead = planBridge({ ...base, now: unix("2026-12-01T17:00:00Z"), journal });
    expect(atLead.intents).toHaveLength(1);
    const late = planBridge({ ...base, now: unix("2026-12-01T17:00:01Z"), journal });
    expect(late.skipped[0]).toMatchObject({
      reason: SkipReason.CoreRule,
      code: ErrorCode.ExpiryTooSoon,
    });
  });

  it("refuses entries older than the maximum entry age (no sealing with hindsight)", () => {
    expect(DEFAULT_MAX_ENTRY_AGE_SECS).toBe(900n);
    const at = (createdAt: string, maxEntryAgeSecs?: bigint) =>
      planBridge({
        ...base,
        journal: line({ createdAt }),
        ...(maxEntryAgeSecs === undefined ? {} : { maxEntryAgeSecs }),
      });
    expect(at("2026-12-01T11:45:00Z").intents).toHaveLength(1); // exactly 15 min old
    expect(at("2026-12-01T11:44:59Z").skipped[0]?.reason).toBe(SkipReason.EntryTooOld);
    expect(at("2026-12-01T11:00:00Z", 3600n).intents).toHaveLength(1);
    expect(at("2026-12-01T12:00:00Z").intents).toHaveLength(1);
    expect(at("2026-12-01T12:00:01Z").skipped[0]?.reason).toBe(SkipReason.EntryInFuture);
  });

  it("only allows feeds in the params allowlist (defaults to the feeds map)", () => {
    const solOnly = { ...PARAMS, allowedFeedIds: [FEED_SOL] };
    const plan = planBridge({ ...base, params: solOnly });
    expect(plan.intents.map((i) => i.entryId)).toEqual(["FAKE-0001"]);
    expect(plan.skipped.find((s) => s.entryId === "FAKE-0002")).toMatchObject({
      reason: SkipReason.CoreRule,
      code: ErrorCode.FeedNotAllowed,
    });
  });

  it("dedupes across runs through the ledger and flags edited entries", () => {
    const [first] = planBridge(base).intents;
    if (first === undefined) throw new Error("intent");
    const ledger = new Map([
      [
        first.entryId,
        { entryId: first.entryId, contentHash: first.contentHash, status: "sealed" as const },
      ],
      [
        "FAKE-0002",
        { entryId: "FAKE-0002", contentHash: "00".repeat(32), status: "pending" as const },
      ],
    ]);
    const plan = planBridge({ ...base, ledger: { get: (id) => ledger.get(id) } });
    expect(plan.intents).toEqual([]);
    expect(plan.skipped.find((s) => s.entryId === "FAKE-0001" && s.line === 1)).toMatchObject({
      reason: SkipReason.AlreadyProcessed,
    });
    expect(plan.skipped.find((s) => s.entryId === "FAKE-0002")).toMatchObject({
      reason: SkipReason.LedgerConflict,
    });
  });

  it("resumes a pending entry (no freshness or timing re-check; the executor decides)", () => {
    const [first] = planBridge(base).intents;
    if (first === undefined) throw new Error("intent");
    const pending = {
      entryId: first.entryId,
      contentHash: first.contentHash,
      status: "pending" as const,
    };
    const later = planBridge({
      ...base,
      now: NOW + 7200n, // the entry is stale by now
      ledger: { get: (id) => (id === first.entryId ? pending : undefined) },
    });
    expect(later.intents.map((i) => [i.entryId, i.resume])).toEqual([["FAKE-0001", true]]);
    expect(planBridge(base).intents.every((i) => !i.resume)).toBe(true);
  });

  it("treats an id used by an earlier, invalid line as taken", () => {
    const plan = planBridge({ ...base, journal: [line({ level: "-1" }), line()].join("\n") });
    expect(plan.intents).toEqual([]);
    expect(plan.skipped.map((s) => [s.line, s.reason])).toEqual([
      [1, SkipReason.InvalidField],
      [2, SkipReason.DuplicateEntryId],
    ]);
    expect(plan.skipped[1]?.detail).toMatch(/already used on line 1/);
  });

  it("keeps the first occurrence of an entry id and says when the duplicate differs", () => {
    const plan = planBridge({
      ...base,
      journal: [line(), line(), line({ level: "200" })].join("\n"),
    });
    expect(plan.intents.map((i) => i.line)).toEqual([1]);
    expect(plan.skipped.map((s) => [s.line, s.reason])).toEqual([
      [2, SkipReason.DuplicateEntryId],
      [3, SkipReason.DuplicateEntryId],
    ]);
    expect(plan.skipped[0]?.detail).toMatch(/identical/);
    expect(plan.skipped[1]?.detail).toMatch(/differs/);
  });
});
