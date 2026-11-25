// The public record page (M6): a static, script-free site built from chain data only.
// See apps/web/README.md.
export { escapeHtml } from "./html.ts";
export { directionLabel, formatFixed, formatUtc, statusLabel } from "./format.ts";
export {
  collectFromAdapter,
  type AgentEntry,
  type CollectOptions,
  type RecordCall,
  type RecordData,
} from "./source.ts";
export { decodeSnapshot, encodeSnapshot, SNAPSHOT_SCHEMA } from "./snapshot.ts";
export {
  buildModel,
  type AgentView,
  type CallRow,
  type OutcomeCheck,
  type SiteModel,
} from "./model.ts";
export { CSP, DISCLAIMER, renderAgent, renderIndex, STYLE_CSS } from "./render.ts";
export { buildSite } from "./build.ts";
export { runWebCli, USAGE, type WebCliDeps } from "./cli/run.ts";
