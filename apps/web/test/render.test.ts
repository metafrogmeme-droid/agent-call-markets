import { describe, expect, it } from "vitest";
import { MemoryAdapter, Outcome } from "@agent-call-markets/core";
import { buildModel, type SiteModel } from "../src/model.ts";
import { CSP, renderAgent, renderIndex, STYLE_CSS } from "../src/render.ts";
import { collectFromAdapter, type RecordData } from "../src/source.ts";
import { AGENT_1, AGENT_2, makeWorld, NOW, PARAMS } from "./world.ts";

const DISCLAIMER =
  "Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.";

async function data(labels: [string, string] = ["FAKE-AGENT-1", "FAKE-AGENT-2"], synthetic = true) {
  const w = await makeWorld();
  const d = await collectFromAdapter(new MemoryAdapter(w.world, null), {
    agents: [
      { label: labels[0], id: AGENT_1 },
      { label: labels[1], id: AGENT_2 },
    ],
    now: NOW,
    params: PARAMS,
    source: "memory:test",
    synthetic,
  });
  return { ...w, d };
}

function pages(model: SiteModel): string[] {
  return [renderIndex(model), ...model.agents.map((a) => renderAgent(model, a))];
}

describe("rendered pages", () => {
  it("carry the verbatim disclaimer and No US users on every page", async () => {
    const { d } = await data();
    for (const html of pages(buildModel(d))) {
      expect(html).toContain(DISCLAIMER);
      expect(html).toContain("No US users.");
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain('<html lang="en">');
    }
  });

  it("are script-free, self-contained and locked down by a strict CSP", async () => {
    const { d } = await data();
    expect(CSP).toContain("default-src 'none'");
    expect(CSP).toContain("style-src 'self'");
    expect(CSP).not.toMatch(/script-src|unsafe/);
    for (const html of pages(buildModel(d))) {
      expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
      expect(html).toContain('<meta name="referrer" content="no-referrer">');
      expect(html).not.toMatch(/<script|<iframe|<form|<object|<embed|<img|javascript:/i);
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/https?:\/\//i);
      expect(html).not.toMatch(/style="/i);
    }
    expect(STYLE_CSS).not.toMatch(/url\(|@import|https?:/i);
  });

  it("escapes every value, so a hostile label cannot inject markup", async () => {
    const { d } = await data(['<script>alert("x")</script>', `"><b onclick=x>`]);
    for (const html of pages(buildModel(d))) {
      expect(html).not.toMatch(/<script|<b onclick/i);
    }
    expect(renderIndex(buildModel(d))).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
  });

  it("shows raw counts and the hit rate with its sample size, sorted by label, without performance language", async () => {
    const { d } = await data();
    const model = buildModel(d);
    const index = renderIndex(model);
    for (const a of model.agents) {
      expect(index).toContain(a.summary);
      expect(index).toContain(`href="agents/${a.id}.html"`);
    }
    expect(index.indexOf("FAKE-AGENT-1")).toBeLessThan(index.indexOf("FAKE-AGENT-2"));
    expect(index).toMatch(/Unrevealed calls past their reveal deadline count as misses/);
    expect(index).toMatch(/Voids are not counted/);
    for (const html of pages(model)) {
      expect(html).not.toMatch(
        /\b(rank|ranking|best|top|profit|profitable|pnl|returns?|guarantee[sd]?|accurate|accuracy|beats?|winning)\b/i,
      );
    }
  });

  it("shows calls: hidden until reveal, self-trades flagged, outcomes re-checked", async () => {
    const { d, refs } = await data();
    const model = buildModel(d);
    const a1 = model.agents.find((a) => a.label === "FAKE-AGENT-1");
    if (a1 === undefined) throw new Error("agent");
    const html = renderAgent(model, a1);
    expect(html).toContain(refs.unrevealed.id);
    expect(html).toContain("Not revealed in time (counts as a miss)");
    expect(html).toMatch(/hidden until reveal/);
    expect(html).toMatch(/own key traded this market/);
    expect(html).toMatch(/Self-trading from other wallets cannot be detected/);
    expect(html).toContain("matches the core rule");
    expect(html).toContain('href="../index.html"');
    expect(html).toContain('href="../style.css"');
    expect(html).toContain(a1.summary);
    expect(html).not.toMatch(/differs from the core rule/);
  });

  it("warns loudly about an outcome that differs from the core rule", async () => {
    const { d, refs } = await data();
    const tampered: RecordData = {
      ...d,
      calls: d.calls.map((c) =>
        c.id === refs.hit.id ? { ...c, state: { ...c.state, outcome: Outcome.Miss } } : c,
      ),
    };
    const model = buildModel(tampered);
    const a1 = model.agents.find((a) => a.label === "FAKE-AGENT-1");
    if (a1 === undefined) throw new Error("agent");
    expect(renderAgent(model, a1)).toMatch(/differs from the core rule/);
    expect(renderIndex(model)).toMatch(/1 outcome differs from the core rule/);
  });

  it("marks synthetic data, and says where real data came from", async () => {
    const synthetic = buildModel((await data()).d);
    expect(renderIndex(synthetic)).toMatch(/Synthetic test data/);
    const real = buildModel((await data(["A", "B"], false)).d);
    expect(renderIndex(real)).not.toMatch(/Synthetic test data/);
    expect(renderIndex(real)).toContain("memory:test");
  });
});
