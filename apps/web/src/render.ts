// Static, script-free HTML. Every interpolated value goes through escapeHtml. No external
// resources: one local stylesheet, relative links only, and a CSP that allows nothing else.
import { formatUtc } from "./format.ts";
import { escapeHtml as e } from "./html.ts";
import type { AgentView, CallRow, SiteModel } from "./model.ts";

/** Verbatim, from CLAUDE_BRIEF.md §8. */
export const DISCLAIMER =
  "Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.";

/** Nothing but the local stylesheet may load; no scripts, frames, forms or images. */
export const CSP = "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'";

export const STYLE_CSS = `:root { color-scheme: light dark; --muted: #666; --warn: #b00020; }
body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 1200px; padding: 0 16px; }
header.disclaimer, footer { border: 1px solid; padding: 8px 12px; margin: 16px 0; }
.banner { background: #fff3cd; color: #000; border: 1px solid #c90; padding: 8px 12px; }
.warn { color: var(--warn); font-weight: 600; }
.meta, .note { color: var(--muted); }
.summary { font-size: 1.2em; font-weight: 600; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; }
th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; }
td.num { text-align: right; }
code { font-size: 0.85em; word-break: break-all; }
`;

function page(opts: { title: string; css: string; model: SiteModel; body: string }): string {
  const { model } = opts;
  const banner = model.synthetic
    ? `<p class="banner">Synthetic test data: fake agents and synthetic feed ids. This is not a real agent record.</p>\n`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(opts.title)}</title>
<link rel="stylesheet" href="${e(opts.css)}">
</head>
<body>
<header class="disclaimer">
<p>${e(DISCLAIMER)}</p>
<p>No US users.</p>
</header>
${banner}<main>
${opts.body}
</main>
<footer>
<p>${e(DISCLAIMER)}</p>
<p>No US users.</p>
<p>Records are computed from chain data only (source <code>${e(model.source)}</code>, read at ${e(formatUtc(model.takenAt))}).</p>
<p>Self-trading from other wallets cannot be detected; only positions held by the agent's own key are flagged.</p>
<p>Read-only page: no wallet connection, no scripts.</p>
</footer>
</body>
</html>
`;
}

function mismatchNote(n: number): string {
  if (n === 0) return "";
  return `<p class="warn">${n} ${n === 1 ? "outcome differs" : "outcomes differ"} from the core rule</p>`;
}

const td = (v: string | number | bigint, cls = ""): string =>
  `<td${cls === "" ? "" : ` class="${cls}"`}>${e(String(v))}</td>`;

export function renderIndex(model: SiteModel): string {
  const rows = model.agents
    .map((a) => {
      const r = a.record;
      return `<tr>
<td><a href="agents/${e(a.id)}.html">${e(a.label)}</a>${mismatchNote(a.mismatches)}</td>
<td><code>${e(a.id)}</code></td>
${td(r.sealed, "num")}${td(r.revealed, "num")}${td(r.pending, "num")}${td(r.hits, "num")}${td(r.misses, "num")}${td(r.unrevealedMisses, "num")}${td(r.voids, "num")}${td(r.selfTradedCalls, "num")}
${td(a.summary)}
</tr>`;
    })
    .join("\n");
  const body = `<h1>Agent call records</h1>
<p class="meta">Each agent sealed its calls on chain before the outcome was known. These counts are read from chain data only.</p>
<h2>How calls are counted</h2>
<ul>
<li>Hit rate = hits / (hits + misses), always shown with its sample size and the number of voids.</li>
<li>Unrevealed calls past their reveal deadline count as misses.</li>
<li>Voids are not counted as hits or misses.</li>
<li>Every settled outcome is re-checked against the core rule; a difference is shown in red.</li>
<li>Agents are listed by name only.</li>
</ul>
<table>
<thead><tr><th>Agent</th><th>Public id</th><th>Sealed</th><th>Revealed</th><th>Pending</th><th>Hits</th><th>Misses</th><th>of which unrevealed</th><th>Voids</th><th>Own-key self-trades</th><th>Hit rate</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
  return page({ title: "Agent call records", css: "style.css", model, body });
}

function callRow(c: CallRow): string {
  const call =
    c.revealed === null
      ? `<td class="note">hidden until reveal (commitment <code>${e(c.commitment)}</code>)</td>`
      : `<td>${e(c.revealed.direction)} ${e(c.revealed.level)}<br><span class="note">feed <code>${e(c.revealed.feedId)}</code><br>salt <code>${e(c.revealed.salt)}</code></span></td>`;
  let check = "<td>-</td>";
  if (c.outcomeCheck === "match") check = "<td>matches the core rule</td>";
  if (c.outcomeCheck === "mismatch") {
    check = `<td class="warn">differs from the core rule (core: ${e(String(c.coreOutcome))})</td>`;
  }
  const settlement =
    c.observation === null
      ? "<td>-</td>"
      : `<td>${e(c.observation.price)} (conf ${e(c.observation.conf)})<br><span class="note">published ${e(formatUtc(c.observation.publishTime))}</span></td>`;
  return `<tr>
<td><code>${e(c.id)}</code></td>
${td(c.statusLabel)}
${td(formatUtc(c.sealTs))}${td(formatUtc(c.expiryTs))}${td(formatUtc(c.revealDeadlineTs))}
${call}
${td(c.outcome ?? "-")}
${check}
${settlement}
${td(c.selfTraded ? "own key traded this market" : "-")}
</tr>`;
}

export function renderAgent(model: SiteModel, agent: AgentView): string {
  const r = agent.record;
  const body = `<p><a href="../index.html">All agents</a></p>
<h1>${e(agent.label)}</h1>
<p>Public id <code>${e(agent.id)}</code></p>
<p class="summary">${e(agent.summary)}</p>
${mismatchNote(agent.mismatches)}
<p>Sealed ${e(String(r.sealed))}, revealed ${e(String(r.revealed))}, pending ${e(String(r.pending))}, hits ${e(String(r.hits))}, misses ${e(String(r.misses))} (of which unrevealed ${e(String(r.unrevealedMisses))}), voids ${e(String(r.voids))}, calls with own-key self-trades ${e(String(r.selfTradedCalls))}.</p>
<table>
<thead><tr><th>Call account</th><th>Status</th><th>Sealed</th><th>Expiry</th><th>Reveal deadline</th><th>Call</th><th>Outcome on chain</th><th>Core re-check</th><th>Settlement price</th><th>Own-key self-trade</th></tr></thead>
<tbody>
${agent.calls.map(callRow).join("\n")}
</tbody>
</table>`;
  return page({ title: `${agent.label}: calls`, css: "../style.css", model, body });
}
