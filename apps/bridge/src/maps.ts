import {
  bytes32,
  bytesToHex,
  CoreError,
  ErrorCode,
  isZero,
  type Bytes32,
} from "@agent-call-markets/core";

/** Label -> 32-byte public id (agent public keys, or oracle feed ids). Public data only. */
export type IdMap = ReadonlyMap<string, Bytes32>;

function bad(kind: string, message: string): never {
  throw new CoreError(ErrorCode.InvalidParams, `${kind} map: ${message}`);
}

/**
 * Parses an explicit label -> id map, e.g. `{ "FAKE-AGENT-1": "a1a1…" }` (64 hex digits, optional
 * 0x). Feeds come only from this list (Q4); agents must map one-to-one so every sealed call stays
 * attributable to one key (Q7). Ambiguous or zero ids are refused.
 */
export function parseIdMap(text: string, kind: "agents" | "feeds"): IdMap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad(kind, "not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return bad(kind, "expected an object of label -> 32-byte hex id");
  }
  const out = new Map<string, Bytes32>();
  const seen = new Map<string, string>();
  for (const [label, value] of Object.entries(raw)) {
    if (label.length === 0 || label.length > 64) bad(kind, `invalid label "${label}"`);
    if (typeof value !== "string" || !/^(0x)?[0-9a-fA-F]{64}$/.test(value)) {
      bad(kind, `"${label}" must map to a 32-byte hex id`);
    }
    const id = bytes32(value);
    if (isZero(id)) bad(kind, `"${label}" maps to the zero id`);
    const hex = bytesToHex(id);
    const other = seen.get(hex);
    if (other !== undefined) bad(kind, `"${label}" and "${other}" map to the same id`);
    seen.set(hex, label);
    out.set(label, id);
  }
  return out;
}
