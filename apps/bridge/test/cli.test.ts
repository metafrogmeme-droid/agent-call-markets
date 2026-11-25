import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBridgeCli, USAGE } from "../src/cli/run.ts";
import { FileLedger } from "../src/ledger.ts";
import { fixturePath } from "./helpers.ts";

const DISCLAIMER =
  "Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.";

function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runBridgeCli(argv, { stdout: (t) => out.push(t), stderr: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A temp dir holding read-only copies of the fixtures. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "acm-bridge-"));
  for (const f of ["journal-fake-v0.jsonl", "agents-fake.json", "feeds-fake.json"]) {
    copyFileSync(fixturePath(f), join(dir, f));
    chmodSync(join(dir, f), 0o444);
  }
  const args = [
    "--journal",
    join(dir, "journal-fake-v0.jsonl"),
    "--agents",
    join(dir, "agents-fake.json"),
    "--feeds",
    join(dir, "feeds-fake.json"),
    "--now",
    "2026-12-01T12:00:00Z",
  ];
  return { dir, args };
}

describe("bridge CLI (dry run only)", () => {
  it("prints the disclaimer and No US users", () => {
    const r = run("--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain(DISCLAIMER);
    expect(r.out).toContain("No US users.");
    expect(USAGE).toMatch(/dry run/i);
    expect(run().code).toBe(2);
  });

  it("plans from read-only files, changes nothing on disk, and reports every entry", () => {
    const { dir, args } = workspace();
    const journal = join(dir, "journal-fake-v0.jsonl");
    const before = {
      bytes: readFileSync(journal),
      mtime: statSync(journal).mtimeMs,
      files: readdirSync(dir).sort(),
    };
    const r = run("plan", ...args);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as Record<string, unknown> & {
      intents: { entryId: string; call: { expiryTs: string; agent: string } }[];
      skipped: { reason: string }[];
    };
    expect(report["mode"]).toBe("dry-run");
    expect(report["sent"]).toBe(false);
    expect(report.intents.map((i) => i.entryId)).toEqual(["FAKE-0001", "FAKE-0002"]);
    expect(report.intents[0]?.call.expiryTs).toBe(
      String(Date.parse("2026-12-01T18:00:00Z") / 1000),
    );
    expect(report.intents[0]?.call.agent).toBe("a1".repeat(32));
    expect(report.skipped).toHaveLength(14);
    const meta = report["journal"] as { path: string; sha256: string };
    expect(meta.path).toBe(journal);
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(journal)).toEqual(before.bytes);
    expect(statSync(journal).mtimeMs).toBe(before.mtime);
    expect(readdirSync(dir).sort()).toEqual(before.files);
  });

  it("reads the ledger but never writes it", () => {
    const { dir, args } = workspace();
    const ledgerPath = join(dir, "ledger.json");
    const first = JSON.parse(run("plan", ...args).out) as {
      intents: { entryId: string; contentHash: string }[];
    };
    const sealed = first.intents[0];
    if (sealed === undefined) throw new Error("intent");
    new FileLedger(ledgerPath).put({
      entryId: sealed.entryId,
      contentHash: sealed.contentHash,
      status: "sealed",
      agent: "a1".repeat(32),
      updatedTs: "1796126400",
    });
    const bytes = readFileSync(ledgerPath);
    const r = JSON.parse(run("plan", ...args, "--ledger", ledgerPath).out) as {
      intents: { entryId: string }[];
      skipped: { entryId: string; reason: string }[];
    };
    expect(r.intents.map((i) => i.entryId)).toEqual(["FAKE-0002"]);
    expect(r.skipped).toContainEqual(
      expect.objectContaining({ entryId: "FAKE-0001", reason: "ALREADY_PROCESSED" }),
    );
    expect(readFileSync(ledgerPath)).toEqual(bytes);
    // A ledger path that does not exist yet is simply empty, and is not created.
    expect(run("plan", ...args, "--ledger", join(dir, "none.json")).code).toBe(0);
    expect(readdirSync(dir)).not.toContain("none.json");
  });

  it("accepts unix seconds for --now, overrides params, and the maximum entry age", () => {
    const { dir, args } = workspace();
    const at = args.slice(0, -2);
    interface Ids {
      intents: { entryId: string }[];
    }
    const ids = (r: Ids) => r.intents.map((i) => i.entryId);
    // At 12:20 FAKE-0001/0002 are older than 15 min; FAKE-0008 (created 12:10) is now fresh.
    const late = JSON.parse(
      run("plan", ...at, "--now", String(Date.parse("2026-12-01T12:20:00Z") / 1000)).out,
    ) as Ids;
    expect(ids(late)).toEqual(["FAKE-0008"]);
    const loose = JSON.parse(
      run("plan", ...at, "--now", "2026-12-01T12:20:00Z", "--max-entry-age", "3600").out,
    ) as Ids;
    expect(ids(loose)).toEqual(["FAKE-0001", "FAKE-0002", "FAKE-0008"]); // FAKE-0009 is 3h old
    const params = join(dir, "params.json");
    writeFileSync(params, JSON.stringify({ minLeadSecs: 86_401 }));
    const strict = JSON.parse(run("plan", ...args, "--params", params).out) as {
      intents: unknown[];
      params: { minLeadSecs: string };
    };
    expect(strict.params.minLeadSecs).toBe("86401");
    expect(strict.intents).toHaveLength(0);
  });

  it("refuses bad input with clear exit codes", () => {
    const { dir, args } = workspace();
    expect(run("plan").code).toBe(2); // missing files
    expect(run("execute", ...args).code).toBe(2); // no execute in the CLI
    expect(run("plan", ...args, "--bogus").code).toBe(2);
    expect(run("plan", ...args.slice(0, -2), "--now", "yesterday").code).toBe(2);
    expect(run("plan", ...args, "--max-entry-age", "-5").code).toBe(2);
    const missing = run("plan", "--journal", join(dir, "nope.jsonl"), ...args.slice(2));
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.err)).toMatchObject({ error: "FILE_UNREADABLE" });
    writeFileSync(join(dir, "bad-agents.json"), "[]");
    const badMap = run(
      "plan",
      ...args.slice(0, 2),
      "--agents",
      join(dir, "bad-agents.json"),
      ...args.slice(4),
    );
    expect(badMap.code).toBe(1);
    expect(JSON.parse(badMap.err)).toMatchObject({ error: "INVALID_PARAMS" });
    writeFileSync(join(dir, "bad-params.json"), JSON.stringify({ minLeadSecs: 1 }));
    expect(run("plan", ...args, "--params", join(dir, "bad-params.json")).code).toBe(1);
    writeFileSync(join(dir, "broken-params.json"), "{nope");
    expect(run("plan", ...args, "--params", join(dir, "broken-params.json")).code).toBe(2);
    expect(run("plan", ...args, "--params", join(dir, "missing.json")).code).toBe(1);
  });

  it("lets --params narrow the feed allowlist and the exponent window", () => {
    const { dir, args } = workspace();
    const params = join(dir, "params.json");
    writeFileSync(params, JSON.stringify({ allowedFeedIds: ["f1".repeat(32)], minLevelExpo: -1 }));
    const r = JSON.parse(run("plan", ...args, "--params", params).out) as {
      intents: { entryId: string }[];
      skipped: { entryId: string; code?: string }[];
    };
    expect(r.intents).toEqual([]); // FAKE-0001's level 185.25 has exponent -2
    expect(r.skipped).toContainEqual(
      expect.objectContaining({ entryId: "FAKE-0001", code: "INVALID_EXPONENT" }),
    );
    expect(r.skipped).toContainEqual(
      expect.objectContaining({ entryId: "FAKE-0002", code: "FEED_NOT_ALLOWED" }),
    );
  });
});
