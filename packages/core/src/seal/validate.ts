import { bytesEqual, I64_MAX, isZero, type Bytes32 } from "../bytes.ts";
import type { ProtocolParams } from "../params.ts";
import { err, ErrorCode, ok, type Result } from "../result.ts";
import { isDirection, SEAL_VERSION_V1, type CallV1 } from "./schema.ts";

/**
 * Semantic checks on a revealed call (timing is checked by the state machine):
 * version, direction, non-zero agent/feed/salt, level > 0, exponent within params,
 * feed in the explicit allowlist.
 */
export function validateCall(call: CallV1, salt: Bytes32, params: ProtocolParams): Result<CallV1> {
  // Runtime guard: calls may come from decoded, untrusted data despite the static type.
  const version: number = call.version;
  if (version !== SEAL_VERSION_V1) {
    return err(ErrorCode.InvalidVersion, `unsupported seal version ${version}`);
  }
  if (!isDirection(call.direction)) {
    return err(ErrorCode.InvalidDirection, `invalid direction ${String(call.direction)}`);
  }
  if (call.agent.length !== 32 || isZero(call.agent)) {
    return err(ErrorCode.ZeroAgent, "agent must be a non-zero 32-byte key");
  }
  if (call.feedId.length !== 32 || isZero(call.feedId)) {
    return err(ErrorCode.ZeroFeed, "feedId must be a non-zero 32-byte id");
  }
  if (salt.length !== 32 || isZero(salt)) {
    return err(ErrorCode.ZeroSalt, "salt must be a non-zero 32-byte value");
  }
  if (call.level.mantissa <= 0n || call.level.mantissa > I64_MAX) {
    return err(ErrorCode.InvalidLevel, "level mantissa must be in (0, i64 max]");
  }
  if (
    !Number.isInteger(call.level.expo) ||
    call.level.expo < params.minLevelExpo ||
    call.level.expo > params.maxLevelExpo
  ) {
    return err(
      ErrorCode.InvalidExponent,
      `level exponent must be in [${params.minLevelExpo}, ${params.maxLevelExpo}]`,
    );
  }
  if (!params.allowedFeedIds.some((f) => bytesEqual(f, call.feedId))) {
    return err(ErrorCode.FeedNotAllowed, "feed is not in the allowlist");
  }
  return ok(call);
}
