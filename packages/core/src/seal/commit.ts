import { sha256 } from "@noble/hashes/sha2.js";
import { bytes32, bytesEqual, concatBytes, isZero, type Bytes32 } from "../bytes.ts";
import { CoreError, ErrorCode } from "../result.ts";
import { encodeSealPreimage } from "./codec.ts";
import { SEAL_DOMAIN_TAG, type CallV1 } from "./schema.ts";

/** "ACM-SEAL-V1" followed by a 0x00 separator. */
export const SEAL_DOMAIN_PREFIX: Uint8Array = concatBytes(
  new TextEncoder().encode(SEAL_DOMAIN_TAG),
  new Uint8Array([0]),
);

/** commitment = SHA-256("ACM-SEAL-V1" || 0x00 || preimage(call, salt)) */
export function commitmentOf(call: CallV1, salt: Bytes32): Bytes32 {
  return bytes32(sha256(concatBytes(SEAL_DOMAIN_PREFIX, encodeSealPreimage(call, salt))));
}

/** True iff (call, salt) opens `commitment`. Never throws on malformed calls; returns false. */
export function verifyReveal(commitment: Bytes32, call: CallV1, salt: Bytes32): boolean {
  try {
    return bytesEqual(commitmentOf(call, salt), commitment);
  } catch {
    return false;
  }
}

/** Minimal interface of `globalThis.crypto` used for salts, so tests can inject a source. */
export interface RandomSource {
  getRandomValues<T extends Uint8Array>(array: T): T;
}

/**
 * A fresh 32-byte salt from a CSPRNG. The call space (feed, direction, level, expiry) is small,
 * so the salt is what keeps a sealed call hidden; it must never be derived from public data.
 */
export function randomSalt(source: RandomSource = globalThis.crypto): Bytes32 {
  for (let attempt = 0; attempt < 4; attempt++) {
    const salt = source.getRandomValues(new Uint8Array(32));
    if (!isZero(salt)) return bytes32(salt);
  }
  // An all-zero 32-byte draw from a working CSPRNG is not a realistic event; fail closed.
  throw new CoreError(ErrorCode.ZeroSalt, "random source returned only zero bytes");
}
