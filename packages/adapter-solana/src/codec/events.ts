import { getBase64Encoder } from "@solana/kit";
import { discriminator, startsWith } from "./discriminator.ts";
import { structCodec, type StructOf } from "./layout.ts";
import { EVENTS } from "./program.ts";

export type EventName = keyof typeof EVENTS;
export type EventOf<N extends EventName> = StructOf<(typeof EVENTS)[N]>;

const PREFIX = "Program data: ";

/**
 * Decodes every `N` event Anchor emitted (via sol_log_data) in a transaction's logs. Lines that
 * are not base64 or carry another discriminator are skipped.
 */
export function parseEvents<N extends EventName>(logs: readonly string[], name: N): EventOf<N>[] {
  const disc = discriminator("event", name);
  const codec = structCodec(EVENTS[name]);
  const out: EventOf<N>[] = [];
  for (const line of logs) {
    if (!line.startsWith(PREFIX)) continue;
    let data: Uint8Array;
    try {
      data = Uint8Array.from(getBase64Encoder().encode(line.slice(PREFIX.length).trim()));
    } catch {
      continue;
    }
    if (!startsWith(data, disc)) continue;
    out.push(codec.decode(data, disc.length));
  }
  return out;
}
