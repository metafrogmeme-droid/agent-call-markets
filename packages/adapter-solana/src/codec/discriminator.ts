import { sha256 } from "@noble/hashes/sha2.js";

const enc = new TextEncoder();

/** Anchor discriminator: the first 8 bytes of sha256("<namespace>:<name>"). */
export function discriminator(namespace: "global" | "account" | "event", name: string): Uint8Array {
  return sha256(enc.encode(`${namespace}:${name}`)).slice(0, 8);
}

export function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
}
