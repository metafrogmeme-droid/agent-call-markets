import { CoreError, ErrorCode } from "./result.ts";

declare const bytes32Brand: unique symbol;

/** A 32-byte value (agent key, feed id, salt, commitment). Construct with `bytes32()`. */
export type Bytes32 = Uint8Array & { readonly [bytes32Brand]: true };

export const U64_MAX = (1n << 64n) - 1n;
export const I64_MIN = -(1n << 63n);
export const I64_MAX = (1n << 63n) - 1n;
export const I32_MIN = -(2 ** 31);
export const I32_MAX = 2 ** 31 - 1;

/** Copies and length-checks `input` as a Bytes32. Accepts bytes or a hex string (optional 0x). */
export function bytes32(input: Uint8Array | string): Bytes32 {
  const bytes = typeof input === "string" ? hexToBytes(input) : Uint8Array.from(input);
  if (bytes.length !== 32) {
    throw new CoreError(ErrorCode.InvalidLength, `expected 32 bytes, got ${bytes.length}`);
  }
  return bytes as Bytes32;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new CoreError(ErrorCode.InvalidHex, "hex string must have an even number of hex digits");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Equality that does not exit early on the first differing byte. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function isZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (const b of bytes) acc |= b;
  return acc === 0;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
