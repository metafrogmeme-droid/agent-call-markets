// Golden test vectors for ACM-SEAL-V1 (provisional). Consumed by the TS tests now and by the
// Rust program tests in M2. All ids and salts are synthetic patterns: none is a real key,
// a real agent or a real Pyth feed id.
import {
  bytes32,
  bytesToHex,
  commitmentOf,
  Direction,
  encodeSealPreimage,
  I32_MIN,
  I64_MAX,
  SEAL_DOMAIN_PREFIX,
  SEAL_VERSION_V1,
  type CallV1,
} from "../src/index.ts";

interface Case {
  readonly name: string;
  readonly codecOnly: boolean;
  readonly call: CallV1;
  readonly saltHex: string;
}

const sequentialSalt = Array.from({ length: 32 }, (_, i) =>
  (i + 1).toString(16).padStart(2, "0"),
).join("");

const CASES: readonly Case[] = [
  {
    name: "above_basic",
    codecOnly: false,
    call: {
      version: SEAL_VERSION_V1,
      agent: bytes32("11".repeat(32)),
      feedId: bytes32("f1".repeat(32)),
      direction: Direction.Above,
      level: { mantissa: 100_000_000n, expo: -6 },
      expiryTs: 1_800_000_000n,
    },
    saltHex: "5a".repeat(32),
  },
  {
    name: "below_basic",
    codecOnly: false,
    call: {
      version: SEAL_VERSION_V1,
      agent: bytes32("22".repeat(32)),
      feedId: bytes32("f2".repeat(32)),
      direction: Direction.Below,
      level: { mantissa: 6_500_000n, expo: -2 },
      expiryTs: 1_800_003_600n,
    },
    saltHex: sequentialSalt,
  },
  {
    name: "extremes_valid",
    codecOnly: false,
    call: {
      version: SEAL_VERSION_V1,
      agent: bytes32("33".repeat(32)),
      feedId: bytes32("f3".repeat(32)),
      direction: Direction.Above,
      level: { mantissa: I64_MAX, expo: -18 },
      expiryTs: I64_MAX,
    },
    saltHex: "ff".repeat(32),
  },
  {
    name: "negative_fields_codec_only",
    codecOnly: true,
    call: {
      version: SEAL_VERSION_V1,
      agent: bytes32("44".repeat(32)),
      feedId: bytes32("f4".repeat(32)),
      direction: Direction.Below,
      level: { mantissa: -1n, expo: I32_MIN },
      expiryTs: 0n,
    },
    saltHex: "01".repeat(32),
  },
];

export function buildVectors(): unknown {
  const valid = CASES.map((c) => {
    const salt = bytes32(c.saltHex);
    return {
      name: c.name,
      codecOnly: c.codecOnly,
      call: {
        version: c.call.version,
        agent: bytesToHex(c.call.agent),
        feedId: bytesToHex(c.call.feedId),
        direction: c.call.direction,
        levelMantissa: c.call.level.mantissa.toString(),
        levelExpo: c.call.level.expo,
        expiryTs: c.call.expiryTs.toString(),
      },
      salt: c.saltHex,
      preimage: bytesToHex(encodeSealPreimage(c.call, salt)),
      commitment: bytesToHex(commitmentOf(c.call, salt)),
    };
  });
  const base = valid[0]?.preimage ?? "";
  const withByte = (offset: number, byte: string) =>
    base.slice(0, offset * 2) + byte + base.slice(offset * 2 + 2);
  return {
    format: "ACM-SEAL-V1",
    provisional: true,
    note:
      "Provisional format (open question Q6). Not claimed compatible with HashKey Seal / Proof of Call. " +
      "commitment = sha256(domainPrefix || preimage). Integers are big-endian two's complement. " +
      "All ids and salts are synthetic test patterns. codecOnly cases fail semantic validation.",
    domainPrefix: bytesToHex(SEAL_DOMAIN_PREFIX),
    preimageLength: 118,
    valid,
    invalidPreimages: [
      { name: "too_short", preimage: base.slice(0, -2), error: "INVALID_LENGTH" },
      { name: "too_long", preimage: base + "00", error: "INVALID_LENGTH" },
      { name: "version_2", preimage: withByte(0, "02"), error: "INVALID_VERSION" },
      { name: "direction_0", preimage: withByte(65, "00"), error: "INVALID_DIRECTION" },
      { name: "direction_3", preimage: withByte(65, "03"), error: "INVALID_DIRECTION" },
    ],
  };
}

export function vectorsJson(): string {
  return JSON.stringify(buildVectors(), null, 2) + "\n";
}
