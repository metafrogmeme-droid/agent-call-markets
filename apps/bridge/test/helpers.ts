// Synthetic fixtures only (see fixtures/README.md). None of these are real agents, feeds or keys.
import { readFileSync } from "node:fs";
import { bytes32, DEFAULT_PARAMS, type ProtocolParams } from "@agent-call-markets/core";

export const fixturePath = (name: string): string =>
  new URL(`../fixtures/${name}`, import.meta.url).pathname;
export const readFixture = (name: string): string => readFileSync(fixturePath(name), "utf8");

export const JOURNAL = readFixture("journal-fake-v0.jsonl");
export const AGENTS_JSON = readFixture("agents-fake.json");
export const FEEDS_JSON = readFixture("feeds-fake.json");

/** "Now" for every test: 2026-12-01T12:00:00Z. */
export const NOW = BigInt(Date.parse("2026-12-01T12:00:00Z") / 1000);

export const AGENT_1 = bytes32("a1".repeat(32));
export const AGENT_2 = bytes32("b2".repeat(32));
export const FEED_SOL = bytes32("f1".repeat(32));
export const FEED_BTC = bytes32("f2".repeat(32));

export const PARAMS: ProtocolParams = { ...DEFAULT_PARAMS, allowedFeedIds: [FEED_SOL, FEED_BTC] };

export const unix = (iso: string): bigint => BigInt(Date.parse(iso) / 1000);

/** One valid journal line; `over` replaces fields. */
export function line(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "acm-journal-fixture/v0",
    entryId: "FAKE-T-0001",
    agent: "FAKE-AGENT-1",
    kind: "call",
    createdAt: "2026-12-01T11:55:00Z",
    asset: "FAKE-SOL/USD",
    direction: "above",
    level: "185.25",
    expiresAt: "2026-12-01T18:00:00Z",
    ...over,
  });
}
