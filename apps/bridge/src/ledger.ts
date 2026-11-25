// The bridge's local state: a dedupe ledger (entry id -> what happened) and a salt store (needed to
// reveal later; a lost salt means the call counts as a miss). Files are created 0600 in 0700
// directories. Planning only reads; only executePlan writes.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { CoreError, ErrorCode, type CallRef, type Direction } from "@agent-call-markets/core";
import type { LedgerReader, LedgerRecordView } from "./plan.ts";

export interface LedgerRecord extends LedgerRecordView {
  /** Agent public id, hex. */
  readonly agent: string;
  /** Commitment, hex: set as soon as a salt is drawn, before anything is sent. */
  readonly commitment?: string;
  readonly callRef?: CallRef;
  /** Why the chain rejected it (status "rejected"), when it said so. */
  readonly code?: ErrorCode;
  readonly detail?: string;
  /** Unix seconds of the last change, as a decimal string. */
  readonly updatedTs: string;
}

export interface Ledger extends LedgerReader {
  get(entryId: string): LedgerRecord | undefined;
  put(record: LedgerRecord): void;
  all(): LedgerRecord[];
}

export class MemoryLedger implements Ledger {
  private readonly records = new Map<string, LedgerRecord>();

  get(entryId: string): LedgerRecord | undefined {
    return this.records.get(entryId);
  }

  put(record: LedgerRecord): void {
    this.records.set(record.entryId, record);
  }

  all(): LedgerRecord[] {
    return [...this.records.values()];
  }
}

function corrupt(path: string, why: string): never {
  throw new CoreError(ErrorCode.InvalidParams, `ledger ${path}: ${why}; refusing to start over`);
}

/** JSON file ledger: `{ "version": 1, "entries": { [entryId]: LedgerRecord } }`, atomic writes. */
export class FileLedger implements Ledger {
  readonly path: string;
  private readonly records = new Map<string, LedgerRecord>();

  /** Loads the file if it exists. Never creates or writes anything until `put`. */
  constructor(path: string) {
    this.path = path;
    if (!existsSync(path)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      corrupt(path, "not valid JSON");
    }
    const file = raw as { version?: unknown; entries?: unknown } | null;
    if (file?.version !== 1 || typeof file.entries !== "object" || file.entries === null) {
      corrupt(path, "unknown format");
    }
    for (const rec of Object.values(file.entries as Record<string, LedgerRecord>)) {
      this.records.set(rec.entryId, rec);
    }
  }

  get(entryId: string): LedgerRecord | undefined {
    return this.records.get(entryId);
  }

  put(record: LedgerRecord): void {
    this.records.set(record.entryId, record);
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.ledger-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    const body = { version: 1, entries: Object.fromEntries(this.records) };
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }

  all(): LedgerRecord[] {
    return [...this.records.values()];
  }
}

/** Everything needed to reveal a sealed call later. Kept secret until the reveal. */
export interface SaltRecord {
  readonly version: 1;
  readonly entryId: string;
  readonly chainId: string;
  readonly agent: string;
  readonly feedId: string;
  readonly direction: Direction;
  readonly levelMantissa: string;
  readonly levelExpo: number;
  readonly expiryTs: string;
  readonly salt: string;
  readonly commitment: string;
}

export interface SaltStore {
  /** Stores a salt; refuses to overwrite one that already exists. */
  put(record: SaltRecord): void;
  get(commitment: string): SaltRecord | undefined;
}

const HEX32 = /^[0-9a-f]{64}$/;

function checkCommitment(commitment: string): void {
  if (!HEX32.test(commitment)) {
    throw new CoreError(ErrorCode.InvalidParams, "commitment must be 64 lowercase hex digits");
  }
}

export class MemorySaltStore implements SaltStore {
  private readonly salts = new Map<string, SaltRecord>();

  put(record: SaltRecord): void {
    checkCommitment(record.commitment);
    if (this.salts.has(record.commitment)) {
      throw new CoreError(ErrorCode.InvalidParams, "a salt for this commitment is already stored");
    }
    this.salts.set(record.commitment, record);
  }

  get(commitment: string): SaltRecord | undefined {
    return this.salts.get(commitment);
  }

  size(): number {
    return this.salts.size;
  }
}

/** One 0600 file per commitment, `<dir>/<commitment>.json`, in a 0700 directory. */
export class FileSaltStore implements SaltStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  put(record: SaltRecord): void {
    checkCommitment(record.commitment);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const path = join(this.dir, `${record.commitment}.json`);
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
  }

  get(commitment: string): SaltRecord | undefined {
    checkCommitment(commitment);
    const path = join(this.dir, `${commitment}.json`);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SaltRecord) : undefined;
  }
}
