import { bytes32, I32_MAX, I32_MIN, I64_MAX, I64_MIN, type Bytes32 } from "../bytes.ts";
import { CoreError, err, ErrorCode, ok, type Result } from "../result.ts";
import {
  isDirection,
  SEAL_V1_LAYOUT as L,
  SEAL_V1_PREIMAGE_LENGTH,
  SEAL_VERSION_V1,
  type CallV1,
} from "./schema.ts";

/**
 * Canonical v1 preimage: fixed-width, big-endian, 118 bytes. One call + salt has exactly one
 * encoding. Range-checks integer fields; semantic checks (level > 0, feed allowlist, ...) are in
 * validate.ts.
 */
export function encodeSealPreimage(call: CallV1, salt: Bytes32): Uint8Array {
  // Runtime guard: calls may come from untrusted input despite the static type.
  const version: number = call.version;
  if (version !== SEAL_VERSION_V1) {
    throw new CoreError(ErrorCode.InvalidVersion, `unsupported seal version ${version}`);
  }
  if (!isDirection(call.direction)) {
    throw new CoreError(ErrorCode.InvalidDirection, `invalid direction ${String(call.direction)}`);
  }
  if (call.agent.length !== 32 || call.feedId.length !== 32 || salt.length !== 32) {
    throw new CoreError(ErrorCode.InvalidLength, "agent, feedId and salt must be 32 bytes");
  }
  checkRange("level.mantissa", call.level.mantissa, I64_MIN, I64_MAX);
  checkRange("expiryTs", call.expiryTs, I64_MIN, I64_MAX);
  if (
    !Number.isInteger(call.level.expo) ||
    call.level.expo < I32_MIN ||
    call.level.expo > I32_MAX
  ) {
    throw new CoreError(ErrorCode.OutOfRange, "level.expo must be an i32");
  }

  const out = new Uint8Array(SEAL_V1_PREIMAGE_LENGTH);
  const view = new DataView(out.buffer);
  view.setUint8(L.version.offset, call.version);
  out.set(call.agent, L.agent.offset);
  out.set(call.feedId, L.feedId.offset);
  view.setUint8(L.direction.offset, call.direction);
  view.setBigInt64(L.levelMantissa.offset, call.level.mantissa, false);
  view.setInt32(L.levelExpo.offset, call.level.expo, false);
  view.setBigInt64(L.expiryTs.offset, call.expiryTs, false);
  out.set(salt, L.salt.offset);
  return out;
}

export function decodeSealPreimage(bytes: Uint8Array): Result<{ call: CallV1; salt: Bytes32 }> {
  if (bytes.length !== SEAL_V1_PREIMAGE_LENGTH) {
    return err(
      ErrorCode.InvalidLength,
      `expected ${SEAL_V1_PREIMAGE_LENGTH} bytes, got ${bytes.length}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(L.version.offset);
  if (version !== SEAL_VERSION_V1) {
    return err(ErrorCode.InvalidVersion, `unsupported seal version ${version}`);
  }
  const direction = view.getUint8(L.direction.offset);
  if (!isDirection(direction)) {
    return err(ErrorCode.InvalidDirection, `invalid direction ${direction}`);
  }
  const slice = (f: { offset: number; size: number }) =>
    bytes32(bytes.subarray(f.offset, f.offset + f.size));
  return ok({
    call: {
      version: SEAL_VERSION_V1,
      agent: slice(L.agent),
      feedId: slice(L.feedId),
      direction,
      level: {
        mantissa: view.getBigInt64(L.levelMantissa.offset, false),
        expo: view.getInt32(L.levelExpo.offset, false),
      },
      expiryTs: view.getBigInt64(L.expiryTs.offset, false),
    },
    salt: slice(L.salt),
  });
}

function checkRange(name: string, value: bigint, min: bigint, max: bigint): void {
  if (value < min || value > max) {
    throw new CoreError(ErrorCode.OutOfRange, `${name} out of range`);
  }
}
