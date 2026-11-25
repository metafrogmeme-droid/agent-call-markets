import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CoreError } from "@agent-call-markets/core";
import {
  FileLedger,
  FileSaltStore,
  MemoryLedger,
  MemorySaltStore,
  type LedgerRecord,
  type SaltRecord,
} from "../src/ledger.ts";

const record = (over: Partial<LedgerRecord> = {}): LedgerRecord => ({
  entryId: "FAKE-T-0001",
  contentHash: "ab".repeat(32),
  status: "pending",
  agent: "a1".repeat(32),
  commitment: "cd".repeat(32),
  updatedTs: "1796126400",
  ...over,
});

const salt = (commitment = "cd".repeat(32)): SaltRecord => ({
  version: 1,
  entryId: "FAKE-T-0001",
  chainId: "memory:test",
  agent: "a1".repeat(32),
  feedId: "f1".repeat(32),
  direction: 1,
  levelMantissa: "18525",
  levelExpo: -2,
  expiryTs: "1796148000",
  salt: "5a".repeat(32),
  commitment,
});

describe("ledgers", () => {
  it("memory ledger stores the latest record per entry", () => {
    const l = new MemoryLedger();
    expect(l.get("FAKE-T-0001")).toBeUndefined();
    l.put(record());
    l.put(record({ status: "sealed", callRef: { chainId: "memory:test", id: "x" } }));
    expect(l.get("FAKE-T-0001")?.status).toBe("sealed");
    expect(l.all()).toHaveLength(1);
  });

  it("file ledger: nothing is written until put; writes are 0600 and survive a reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-ledger-"));
    const path = join(dir, "sub", "ledger.json");
    const l = new FileLedger(path);
    expect(l.get("FAKE-T-0001")).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    l.put(record());
    l.put(record({ entryId: "FAKE-T-0002" }));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "sub"))).toEqual(["ledger.json"]); // no temp files left behind
    const again = new FileLedger(path);
    expect(again.get("FAKE-T-0002")).toEqual(record({ entryId: "FAKE-T-0002" }));
    expect(
      again
        .all()
        .map((r) => r.entryId)
        .sort(),
    ).toEqual(["FAKE-T-0001", "FAKE-T-0002"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1 });
  });

  it("file ledger refuses a corrupt or foreign file instead of starting over", () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-ledger-"));
    const path = join(dir, "ledger.json");
    writeFileSync(path, "{not json");
    expect(() => new FileLedger(path)).toThrow(CoreError);
    writeFileSync(path, JSON.stringify({ version: 2, entries: {} }));
    expect(() => new FileLedger(path)).toThrow(CoreError);
  });
});

describe("salt stores", () => {
  it("memory store refuses to overwrite a salt", () => {
    const s = new MemorySaltStore();
    s.put(salt());
    expect(s.get("cd".repeat(32))?.salt).toBe("5a".repeat(32));
    expect(() => {
      s.put(salt());
    }).toThrow(CoreError);
    expect(s.get("ef".repeat(32))).toBeUndefined();
  });

  it("file store writes one 0600 file per commitment in a 0700 directory, never overwriting", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "acm-salts-")), "salts");
    const s = new FileSaltStore(dir);
    expect(s.get("cd".repeat(32))).toBeUndefined();
    s.put(salt());
    const file = join(dir, `${"cd".repeat(32)}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(() => {
      s.put(salt());
    }).toThrow();
    expect(new FileSaltStore(dir).get("cd".repeat(32))).toEqual(salt());
    expect(() => s.get("../etc/passwd")).toThrow(CoreError);
  });
});
