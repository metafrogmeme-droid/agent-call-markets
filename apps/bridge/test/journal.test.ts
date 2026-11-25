import { describe, expect, it } from "vitest";
import { Direction } from "@agent-call-markets/core";
import { contentHash, JOURNAL_SCHEMA_V0, parseJournal, SkipReason } from "../src/journal.ts";
import { JOURNAL, line, unix } from "./helpers.ts";

describe("journal v0 parsing (provisional, synthetic format)", () => {
  it("parses the fixture: well-formed entries are kept, everything else is a reported skip", () => {
    const { entries, skipped } = parseJournal(JOURNAL);
    // Format-level parsing only: mapping, freshness and core rules come later in planBridge.
    expect(entries.map((e) => [e.line, e.entry.entryId])).toEqual([
      [1, "FAKE-0001"],
      [2, "FAKE-0002"],
      [4, "FAKE-0001"],
      [5, "FAKE-0004"],
      [6, "FAKE-0005"],
      [7, "FAKE-0006"],
      [9, "FAKE-0008"],
      [10, "FAKE-0009"],
      [13, "FAKE-0012"],
      [15, "FAKE-0013"],
    ]);
    expect(skipped.map((s) => [s.line, s.entryId, s.reason])).toEqual([
      [3, "FAKE-0003", SkipReason.NotACall],
      [8, "FAKE-0007", SkipReason.InvalidField],
      [11, null, SkipReason.MalformedJson],
      [12, "FAKE-0011", SkipReason.WrongSchema],
      [16, "FAKE-0014", SkipReason.InvalidField],
      [17, null, SkipReason.WrongSchema],
    ]);
    expect(skipped.find((s) => s.line === 8)?.detail).toMatch(/level/);
    expect(skipped.find((s) => s.line === 16)?.detail).toMatch(/expiresAt/);
  });

  it("maps fields exactly: unix seconds, direction, fixed-point level", () => {
    const [first] = parseJournal(line()).entries;
    expect(first?.entry).toMatchObject({
      schema: JOURNAL_SCHEMA_V0,
      entryId: "FAKE-T-0001",
      agent: "FAKE-AGENT-1",
      asset: "FAKE-SOL/USD",
      direction: Direction.Above,
      level: { mantissa: 18525n, expo: -2 },
      createdAt: unix("2026-12-01T11:55:00Z"),
      expiresAt: unix("2026-12-01T18:00:00Z"),
    });
    expect(
      parseJournal(line({ direction: "below", level: "90000" })).entries[0]?.entry,
    ).toMatchObject({
      direction: Direction.Below,
      level: { mantissa: 90000n, expo: 0 },
    });
  });

  it("ignores extra fields (free text never reaches a seal) and handles CRLF and blank lines", () => {
    const text = `${line({ note: "<b>any text</b>" })}\r\n\r\n${line({ entryId: "FAKE-T-0002" })}\r\n`;
    const { entries, skipped } = parseJournal(text);
    expect(skipped).toEqual([]);
    expect(entries.map((e) => e.line)).toEqual([1, 3]);
    expect(Object.keys(entries[0]?.entry ?? {})).not.toContain("note");
  });

  it("rejects each malformed field", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ entryId: "" }, "entryId"],
      [{ entryId: "has space" }, "entryId"],
      [{ entryId: "x".repeat(129) }, "entryId"],
      [{ agent: "" }, "agent"],
      [{ agent: 7 }, "agent"],
      [{ asset: "" }, "asset"],
      [{ direction: "long" }, "direction"],
      [{ level: "0" }, "level"],
      [{ level: "1e5" }, "level"],
      [{ level: 185.25 }, "level"],
      [{ createdAt: "2026-12-01 11:55:00" }, "createdAt"],
      [{ createdAt: "2026-02-30T00:00:00Z" }, "createdAt"],
      [{ expiresAt: "2026-12-01T18:00:00+01:00" }, "expiresAt"],
      [{ kind: 3 }, "kind"],
    ];
    for (const [over, field] of cases) {
      const { entries, skipped } = parseJournal(line(over));
      expect(entries, JSON.stringify(over)).toEqual([]);
      expect(skipped[0]?.reason).toBe(SkipReason.InvalidField);
      expect(skipped[0]?.detail).toContain(field);
    }
  });

  it("hashes the bridged content: stable, and any field change changes it", () => {
    const a = parseJournal(line()).entries[0];
    const b = parseJournal(line({ note: "extra fields do not count" })).entries[0];
    const c = parseJournal(line({ level: "185.26" })).entries[0];
    expect(a?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.contentHash).toBe(b?.contentHash);
    expect(a?.contentHash).not.toBe(c?.contentHash);
    if (a === undefined) throw new Error("entry");
    expect(contentHash(a.raw)).toBe(a.contentHash);
  });
});
