import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SiteModel } from "./model.ts";
import { renderAgent, renderIndex, STYLE_CSS } from "./render.ts";

/**
 * Writes the static site: index.html, style.css and agents/<public id>.html. Deterministic for a
 * given model. Returns the written paths, relative to `outDir`.
 */
export function buildSite(model: SiteModel, outDir: string): string[] {
  mkdirSync(join(outDir, "agents"), { recursive: true });
  const files: [string, string][] = [
    ["index.html", renderIndex(model)],
    ["style.css", STYLE_CSS],
    ...model.agents.map((a): [string, string] => [`agents/${a.id}.html`, renderAgent(model, a)]),
  ];
  for (const [path, content] of files) writeFileSync(join(outDir, path), content);
  return files.map(([path]) => path);
}
