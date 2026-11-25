// Local key and salt files for the CLI. Everything lives under <cwd>/.devnet/ (gitignored).
// Keys are throwaway devnet/localnet keys; files are created 0600 and never overwritten.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import {
  bytes32,
  bytesToHex,
  CoreError,
  ErrorCode,
  SEAL_VERSION_V1,
  type Bytes32,
  type CallV1,
  type Direction,
} from "@agent-call-markets/core";

export const DEVNET_DIR = ".devnet";

export function defaultKeypairPath(cwd: string): string {
  return join(cwd, DEVNET_DIR, "keypair.json");
}

export function saltsDir(cwd: string): string {
  return join(cwd, DEVNET_DIR, "salts");
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Writes a new file with mode 0600; refuses to overwrite an existing one. */
function writePrivateFile(path: string, content: string): void {
  ensurePrivateDir(dirname(path));
  writeFileSync(path, content, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Generates a throwaway keypair and stores it in the Solana CLI format (a JSON array of the
 * 64 bytes secret || public). Returns its address; the secret is never printed.
 */
export async function generateKeypairFile(path: string): Promise<Address> {
  if (existsSync(path)) {
    throw new CoreError(ErrorCode.InvalidParams, `refusing to overwrite existing key file ${path}`);
  }
  const seed = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const bytes = new Uint8Array(64);
  bytes.set(seed, 0);
  bytes.set(getAddressEncoder().encode(signer.address), 32);
  writePrivateFile(path, JSON.stringify(Array.from(bytes)));
  seed.fill(0);
  bytes.fill(0);
  return signer.address;
}

/** Loads a keypair file. Refuses files readable by group or others (like ssh). */
export async function loadKeypairFile(path: string): Promise<KeyPairSigner> {
  if (!existsSync(path)) {
    throw new CoreError(
      ErrorCode.InvalidParams,
      `no key file at ${path}: run \`keygen\` first (a throwaway devnet key)`,
    );
  }
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
    throw new CoreError(
      ErrorCode.InvalidParams,
      `key file ${path} is readable by others; run: chmod 600 ${path}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CoreError(ErrorCode.InvalidParams, `key file ${path} is not valid JSON`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every((b) => Number.isInteger(b) && (b as number) >= 0 && (b as number) <= 255)
  ) {
    throw new CoreError(ErrorCode.InvalidParams, `key file ${path} is not a 64-byte keypair`);
  }
  const bytes = Uint8Array.from(parsed as number[]);
  try {
    return await createKeyPairSignerFromBytes(bytes);
  } finally {
    bytes.fill(0);
  }
}

/** What `seal` must remember to `reveal` later. Losing it means the call counts as a MISS. */
export interface SaltRecord {
  readonly version: 1;
  readonly cluster: string;
  readonly programId: string;
  readonly call: string;
  readonly agent: string;
  readonly feedId: string;
  readonly direction: Direction;
  readonly levelMantissa: string;
  readonly levelExpo: number;
  readonly expiryTs: string;
  readonly salt: string;
}

export function saltPath(cwd: string, cluster: string, commitment: Bytes32): string {
  return join(saltsDir(cwd), `${cluster}-${bytesToHex(commitment)}.json`);
}

/** Written before the seal is sent, so a crash after sending cannot lose the salt. */
export function writeSaltFile(path: string, record: SaltRecord): void {
  writePrivateFile(path, `${JSON.stringify(record, null, 2)}\n`);
}

export function readSaltFile(path: string): {
  readonly call: CallV1;
  readonly salt: Bytes32;
  readonly record: SaltRecord;
} {
  if (!existsSync(path)) {
    throw new CoreError(
      ErrorCode.CommitmentMismatch,
      `no salt file ${path}: without it this call cannot be revealed (it will count as a miss)`,
    );
  }
  const record = JSON.parse(readFileSync(path, "utf8")) as SaltRecord;
  const call: CallV1 = {
    version: SEAL_VERSION_V1,
    agent: bytes32(record.agent),
    feedId: bytes32(record.feedId),
    direction: record.direction,
    level: { mantissa: BigInt(record.levelMantissa), expo: record.levelExpo },
    expiryTs: BigInt(record.expiryTs),
  };
  return { call, salt: bytes32(record.salt), record };
}
