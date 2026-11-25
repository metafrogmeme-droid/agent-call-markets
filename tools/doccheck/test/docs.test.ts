// Checks on the repository's documentation, run in CI with the other unit tests.
// CLAUDE_BRIEF.md §8: the exact disclaimer on README, page and demo; "No US users"; no results
// figures, no performance or endorsement claims; Claw Guard never overclaimed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(new URL("../../../", import.meta.url).pathname);
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

const DISCLAIMER =
  "Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.";

/** Pages a reader or viewer sees: they carry the disclaimer and must not make claims. */
const FRONT = [
  "README.md",
  "docs/ARCHITECTURE.md",
  "docs/DEMO.md",
  "docs/DEVNET.md",
  "apps/bridge/README.md",
  "apps/web/README.md",
  "packages/adapter-solana/README.md",
];

function markdownFiles(dir = ROOT): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "target", "coverage", "dist"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...markdownFiles(p));
    else if (e.name.endsWith(".md")) out.push(relative(ROOT, p));
  }
  return out.sort();
}

/** Text without fenced code blocks (prose only). */
const prose = (md: string): string => md.replace(/```[\s\S]*?```/g, "");

describe("front-facing docs", () => {
  it("exist and carry the verbatim disclaimer and No US users", () => {
    for (const f of FRONT) {
      const md = read(f).replace(/\s+/g, " ");
      expect(md, f).toContain(DISCLAIMER);
      expect(md, f).toContain("No US users.");
    }
  });

  it("quote no results figures (the record page shows live chain data only)", () => {
    for (const f of FRONT) {
      expect(read(f), f).not.toMatch(/\d+(\.\d+)?\s*% hit rate|\d+ of \d+ decided/i);
    }
  });

  it("make no performance or endorsement claims", () => {
    const claims =
      /\b(guaranteed?|profitable|profitability|beats? the market|outperform\w*|accurate|winning|endorsed by|endorsement from|official partner|in partnership with|sponsored by)\b/i;
    for (const f of FRONT) expect(prose(read(f)), f).not.toMatch(claims);
  });

  it("never overclaim Claw Guard", () => {
    for (const f of FRONT) {
      const md = read(f);
      if (/claw guard/i.test(md)) expect(md, f).toMatch(/not a wallet firewall/i);
    }
  });
});

describe("links and commands", () => {
  it("every relative Markdown link in the repository resolves to a file", () => {
    const broken: string[] = [];
    for (const f of markdownFiles()) {
      for (const m of prose(read(f)).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = (m[1] ?? "").split("#")[0] ?? "";
        if (target === "" || /^[a-z]+:/i.test(target)) continue;
        if (!existsSync(resolve(ROOT, dirname(f), target))) broken.push(`${f} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("every pnpm command in the front-facing docs names an existing script", () => {
    const pkgOf = (dir: string) =>
      JSON.parse(read(join(dir, "package.json"))) as {
        name: string;
        scripts?: Record<string, string>;
      };
    const packages = ["packages", "apps", "tools"].flatMap((d) =>
      readdirSync(join(ROOT, d)).map((n) => join(d, n)),
    );
    const byName = new Map(packages.map((p) => [pkgOf(p).name, pkgOf(p)]));
    const root = pkgOf(".");
    const builtins = new Set(["install", "-r", "exec", "dlx", "add"]);
    const bad: string[] = [];
    for (const f of FRONT) {
      const md = read(f);
      const commands = [
        ...[...md.matchAll(/`(pnpm [^`]+)`/g)].map((m) => m[1] ?? ""),
        ...[...md.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)].flatMap((m) =>
          (m[1] ?? "").split("\n").filter((l) => l.trim().startsWith("pnpm ")),
        ),
      ];
      for (const cmd of commands) {
        const words = cmd
          .trim()
          .split(/\s+/)
          .filter((w) => w !== "-s");
        let pkg = root;
        let i = 1;
        if (words[1] === "--filter") {
          const named = byName.get(words[2] ?? "");
          if (named === undefined) {
            bad.push(`${f}: unknown package in "${cmd}"`);
            continue;
          }
          pkg = named;
          i = 3;
        }
        const script = words[i] ?? "";
        if (builtins.has(script) && pkg === root) continue;
        if (pkg.scripts?.[script] === undefined)
          bad.push(`${f}: no script "${script}" in "${cmd}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the README points to the architecture, demo, runbook, decisions and threat model", () => {
    const readme = read("README.md");
    for (const doc of [
      "docs/ARCHITECTURE.md",
      "docs/DEMO.md",
      "docs/DEVNET.md",
      "docs/DECISIONS.md",
      "docs/THREAT_MODEL.md",
    ]) {
      expect(readme, doc).toContain(`(${doc})`);
    }
    expect(readme).toMatch(/parimutuel/i); // the brief: say plainly which market engine is used
  });
});

describe("architecture", () => {
  it("has Mermaid diagrams covering every component, and every path it names exists", () => {
    const md = read("docs/ARCHITECTURE.md");
    const diagrams = [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
    expect(diagrams.length).toBeGreaterThanOrEqual(2);
    const all = diagrams.join("\n");
    for (const c of ["core", "adapter-solana", "call_markets", "bridge", "web", "Pyth"]) {
      expect(all, c).toContain(c);
    }
    expect(all).toMatch(/stateDiagram/);
    for (const m of md.matchAll(
      /`((?:packages|apps|programs|tools|docs|scripts)\/[A-Za-z0-9_./-]+)`/g,
    )) {
      const p = (m[1] ?? "").replace(/\/$/, "");
      expect(existsSync(join(ROOT, p)), p).toBe(true);
    }
  });
});

describe("demo", () => {
  const SCRIPT = "scripts/demo-localnet.sh";

  it("the demo doc runs the script CI runs, and that script is executable", () => {
    expect(read("docs/DEMO.md")).toContain("pnpm demo:localnet");
    expect(
      (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts[
        "demo:localnet"
      ],
    ).toBe(`bash ${SCRIPT}`);
    expect(statSync(join(ROOT, SCRIPT)).mode & 0o111).not.toBe(0);
    expect(read(".github/workflows/ci.yml")).toContain("pnpm demo:localnet");
  });

  it("the demo script stays on a local validator", () => {
    const sh = read(SCRIPT);
    expect(sh).toMatch(/set -euo pipefail/);
    expect(sh).toContain("--bind-address 127.0.0.1");
    expect(sh).not.toMatch(/devnet\.solana|mainnet|testnet\.solana|--cluster devnet/i);
    expect(sh).not.toMatch(/solana program deploy|solana airdrop|keygen\s+-o/);
  });
});
