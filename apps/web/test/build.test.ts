import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "@agent-call-markets/core";
import { buildSite } from "../src/build.ts";
import { buildModel } from "../src/model.ts";
import { encodeSnapshot } from "../src/snapshot.ts";
import { collectFromAdapter } from "../src/source.ts";
import { AGENT_1, AGENT_2, makeWorld, NOW, PARAMS } from "./world.ts";

async function data() {
  const { world } = await makeWorld();
  return collectFromAdapter(new MemoryAdapter(world, null), {
    agents: [
      { label: "FAKE-AGENT-1", id: AGENT_1 },
      { label: "FAKE-AGENT-2", id: AGENT_2 },
    ],
    now: NOW,
    params: PARAMS,
    source: "memory:test",
    synthetic: true,
  });
}

const tree = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .sort();

describe("static site build", () => {
  it("writes the index, one page per agent and the stylesheet, nothing else", async () => {
    const model = buildModel(await data());
    const out = mkdtempSync(join(tmpdir(), "acm-site-"));
    const written = buildSite(model, out);
    const expected = [
      "agents/" + "a1".repeat(32) + ".html",
      "agents/" + "b2".repeat(32) + ".html",
      "index.html",
      "style.css",
    ];
    expect([...written].sort()).toEqual(expected);
    expect(tree(out)).toEqual(expected);
  });

  it("is deterministic", async () => {
    const model = buildModel(await data());
    const a = mkdtempSync(join(tmpdir(), "acm-site-"));
    const b = mkdtempSync(join(tmpdir(), "acm-site-"));
    buildSite(model, a);
    buildSite(model, b);
    for (const f of tree(a)) expect(readFileSync(join(a, f))).toEqual(readFileSync(join(b, f)));
  });

  it("has only relative links, and every one resolves to a built file", async () => {
    const out = mkdtempSync(join(tmpdir(), "acm-site-"));
    for (const page of buildSite(buildModel(await data()), out).filter((p) =>
      p.endsWith(".html"),
    )) {
      const html = readFileSync(join(out, page), "utf8");
      const links = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1] ?? "");
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(link).not.toMatch(/^[a-z]+:|^\/\//i);
        expect(existsSync(resolve(dirname(join(out, page)), link)), `${page} -> ${link}`).toBe(
          true,
        );
      }
    }
  });

  it("the committed fixture snapshot is exactly what the synthetic world produces", async () => {
    const fixture = readFileSync(
      new URL("../fixtures/snapshot-fake.json", import.meta.url),
      "utf8",
    );
    expect(fixture).toBe(encodeSnapshot(await data()));
  });
});
