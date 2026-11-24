import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { vectorsJson } from "../scripts/vectors.ts";
import {
  bytes32,
  bytesToHex,
  commitmentOf,
  CoreError,
  decodeSealPreimage,
  Direction,
  encodeSealPreimage,
  ErrorCode,
  hexToBytes,
  I32_MAX,
  I32_MIN,
  I64_MAX,
  I64_MIN,
  SEAL_DOMAIN_PREFIX,
  SEAL_V1_PREIMAGE_LENGTH,
  SEAL_VERSION_V1,
  type CallV1,
} from "../src/index.ts";
import { makeCall, SALT } from "./fixtures.ts";

interface VectorFile {
  domainPrefix: string;
  valid: {
    name: string;
    call: {
      version: number;
      agent: string;
      feedId: string;
      direction: number;
      levelMantissa: string;
      levelExpo: number;
      expiryTs: string;
    };
    salt: string;
    preimage: string;
    commitment: string;
  }[];
  invalidPreimages: { name: string; preimage: string; error: string }[];
}

const VECTOR_PATH = new URL("../test-vectors/seal-v1.json", import.meta.url);
const vectors = JSON.parse(readFileSync(VECTOR_PATH, "utf8")) as VectorFile;

function callFrom(v: VectorFile["valid"][number]): CallV1 {
  return {
    version: SEAL_VERSION_V1,
    agent: bytes32(v.call.agent),
    feedId: bytes32(v.call.feedId),
    direction: v.call.direction as Direction,
    level: { mantissa: BigInt(v.call.levelMantissa), expo: v.call.levelExpo },
    expiryTs: BigInt(v.call.expiryTs),
  };
}

const arbBytes32 = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((b) => bytes32(b));
const arbCall: fc.Arbitrary<CallV1> = fc.record({
  version: fc.constant(SEAL_VERSION_V1),
  agent: arbBytes32,
  feedId: arbBytes32,
  direction: fc.constantFrom(Direction.Above, Direction.Below),
  level: fc.record({
    mantissa: fc.bigInt({ min: I64_MIN, max: I64_MAX }),
    expo: fc.integer({ min: I32_MIN, max: I32_MAX }),
  }),
  expiryTs: fc.bigInt({ min: I64_MIN, max: I64_MAX }),
});

describe("seal v1 golden vectors", () => {
  it("the committed file is exactly what the generator produces", () => {
    expect(readFileSync(VECTOR_PATH, "utf8")).toBe(vectorsJson());
  });

  it("domain prefix is 'ACM-SEAL-V1' + 0x00", () => {
    expect(vectors.domainPrefix).toBe(bytesToHex(SEAL_DOMAIN_PREFIX));
    expect(Buffer.from(SEAL_DOMAIN_PREFIX).toString("latin1")).toBe("ACM-SEAL-V1\u0000");
  });

  it.each(vectors.valid.map((v) => [v.name, v] as const))(
    "%s encodes and hashes as recorded",
    (_, v) => {
      const call = callFrom(v);
      const salt = bytes32(v.salt);
      const preimage = encodeSealPreimage(call, salt);
      expect(bytesToHex(preimage)).toBe(v.preimage);
      expect(bytesToHex(commitmentOf(call, salt))).toBe(v.commitment);
      // Independent of @noble/hashes: node's own SHA-256.
      const nodeHash = createHash("sha256")
        .update(hexToBytes(vectors.domainPrefix))
        .update(preimage)
        .digest("hex");
      expect(nodeHash).toBe(v.commitment);
      const decoded = decodeSealPreimage(preimage);
      expect(decoded.ok && decoded.value).toEqual({ call, salt });
    },
  );

  it.each(vectors.invalidPreimages.map((v) => [v.name, v] as const))("%s is rejected", (_, v) => {
    const r = decodeSealPreimage(hexToBytes(v.preimage));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(v.error);
  });

  it("matches a preimage assembled by hand from the documented offsets", () => {
    const call = makeCall({
      level: { mantissa: 0x0102030405060708n, expo: -8 },
      expiryTs: 0x1122334455667788n,
    });
    const hand = new Uint8Array(118);
    hand[0] = 1;
    hand.set(call.agent, 1);
    hand.set(call.feedId, 33);
    hand[65] = Direction.Above;
    hand.set([1, 2, 3, 4, 5, 6, 7, 8], 66);
    hand.set([0xff, 0xff, 0xff, 0xf8], 74);
    hand.set([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88], 78);
    hand.set(SALT, 86);
    expect(bytesToHex(encodeSealPreimage(call, SALT))).toBe(bytesToHex(hand));
  });
});

describe("codec properties", () => {
  it("round-trips every in-range call", () => {
    fc.assert(
      fc.property(arbCall, arbBytes32, (call, salt) => {
        const bytes = encodeSealPreimage(call, salt);
        expect(bytes.length).toBe(SEAL_V1_PREIMAGE_LENGTH);
        const back = decodeSealPreimage(bytes);
        expect(back.ok && back.value).toEqual({ call, salt });
      }),
    );
  });

  it("decodes from an offset view of a larger buffer", () => {
    const bytes = encodeSealPreimage(makeCall(), SALT);
    const big = new Uint8Array(200);
    big.set(bytes, 7);
    const r = decodeSealPreimage(big.subarray(7, 7 + bytes.length));
    expect(r.ok && r.value.call).toEqual(makeCall());
  });
});

describe("encode rejects malformed calls", () => {
  const cases: [string, CallV1, Uint8Array, string][] = [
    ["version", { ...makeCall(), version: 2 as unknown as 1 }, SALT, ErrorCode.InvalidVersion],
    ["direction", { ...makeCall(), direction: 9 as Direction }, SALT, ErrorCode.InvalidDirection],
    [
      "agent length",
      { ...makeCall(), agent: new Uint8Array(31) as never },
      SALT,
      ErrorCode.InvalidLength,
    ],
    ["salt length", makeCall(), new Uint8Array(33), ErrorCode.InvalidLength],
    [
      "mantissa > i64",
      makeCall({ level: { mantissa: I64_MAX + 1n, expo: 0 } }),
      SALT,
      ErrorCode.OutOfRange,
    ],
    ["expiry < i64", makeCall({ expiryTs: I64_MIN - 1n }), SALT, ErrorCode.OutOfRange],
    [
      "expo > i32",
      makeCall({ level: { mantissa: 1n, expo: I32_MAX + 1 } }),
      SALT,
      ErrorCode.OutOfRange,
    ],
    [
      "expo not integer",
      makeCall({ level: { mantissa: 1n, expo: 0.5 } }),
      SALT,
      ErrorCode.OutOfRange,
    ],
  ];
  it.each(cases)("%s", (_, call, salt, code) => {
    expect(() => encodeSealPreimage(call, salt as never)).toThrow(CoreError);
    try {
      encodeSealPreimage(call, salt as never);
    } catch (e) {
      expect((e as CoreError).code).toBe(code);
    }
  });
});
