import {
  getAddressDecoder,
  getAddressEncoder,
  getI32Codec,
  getI64Codec,
  getU64Codec,
  type Address,
} from "@solana/kit";
import { bytes32, CoreError, ErrorCode, type OracleObservation } from "@agent-call-markets/core";
import { discriminator, startsWith } from "./codec/discriminator.ts";

/**
 * Pyth `PriceUpdateV2` (pyth-solana-receiver-sdk 2.0.0, `price_update.rs`):
 *   discriminator(8) | write_authority(32) | verification_level (Borsh enum: 0 = Partial{u8}, 1 = Full)
 *   | PriceFeedMessage { feed_id[32], price i64, conf u64, exponent i32, publish_time i64,
 *     prev_publish_time i64, ema_price i64, ema_conf u64 } | posted_slot u64
 * Accounts are allocated at LEN = 134 bytes (room for the Partial variant).
 */
export const PRICE_UPDATE_V2_DISCRIMINATOR = discriminator("account", "PriceUpdateV2");
export const PRICE_UPDATE_V2_LEN = 8 + 32 + 2 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8;

export type VerificationLevel =
  { readonly kind: "full" } | { readonly kind: "partial"; readonly numSignatures: number };

export interface PriceUpdateV2 {
  readonly writeAuthority: Address;
  readonly verificationLevel: VerificationLevel;
  readonly feedId: Uint8Array;
  readonly price: bigint;
  readonly conf: bigint;
  readonly exponent: number;
  readonly publishTime: bigint;
  readonly prevPublishTime: bigint;
  readonly emaPrice: bigint;
  readonly emaConf: bigint;
  readonly postedSlot: bigint;
}

const fail = (msg: string): never => {
  throw new CoreError(ErrorCode.ChainError, `not a PriceUpdateV2 account: ${msg}`);
};

export function decodePriceUpdateV2(data: Uint8Array): PriceUpdateV2 {
  if (!startsWith(data, PRICE_UPDATE_V2_DISCRIMINATOR)) fail("discriminator");
  let o = 8;
  const need = (n: number) => {
    if (data.length < o + n) fail("too short");
  };
  need(32);
  const writeAuthority = getAddressDecoder().decode(data, o);
  o += 32;
  need(1);
  const tag = data[o] ?? 0;
  o += 1;
  let verificationLevel: VerificationLevel;
  if (tag === 0) {
    need(1);
    verificationLevel = { kind: "partial", numSignatures: data[o] ?? 0 };
    o += 1;
  } else if (tag === 1) {
    verificationLevel = { kind: "full" };
  } else {
    return fail(`verification level tag ${tag}`);
  }
  need(32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8);
  const feedId = data.slice(o, o + 32);
  o += 32;
  const i64 = () => {
    const v = getI64Codec().decode(data, o);
    o += 8;
    return v;
  };
  const u64 = () => {
    const v = getU64Codec().decode(data, o);
    o += 8;
    return v;
  };
  const price = i64();
  const conf = u64();
  const exponent = getI32Codec().decode(data, o);
  o += 4;
  const publishTime = i64();
  const prevPublishTime = i64();
  const emaPrice = i64();
  const emaConf = u64();
  const postedSlot = u64();
  return {
    writeAuthority,
    verificationLevel,
    feedId,
    price,
    conf,
    exponent,
    publishTime,
    prevPublishTime,
    emaPrice,
    emaConf,
    postedSlot,
  };
}

/** The core's oracle-agnostic observation of a price update. */
export function observationOf(u: PriceUpdateV2): OracleObservation {
  return {
    feedId: bytes32(u.feedId),
    price: u.price,
    conf: u.conf,
    expo: u.exponent,
    publishTime: u.publishTime,
    prevPublishTime: u.prevPublishTime,
  };
}

/**
 * Encodes a synthetic PriceUpdateV2, padded to LEN like real receiver accounts. For tests and the
 * localnet smoke fixture only: on a real cluster such accounts are posted by the Pyth receiver.
 */
export function encodePriceUpdateV2(
  obs: OracleObservation,
  opts: {
    readonly verificationLevel?: VerificationLevel;
    readonly writeAuthority?: Address;
    readonly postedSlot?: bigint;
  } = {},
): Uint8Array {
  const out = new Uint8Array(PRICE_UPDATE_V2_LEN);
  const level = opts.verificationLevel ?? { kind: "full" };
  let o = 0;
  out.set(PRICE_UPDATE_V2_DISCRIMINATOR, o);
  o += 8;
  out.set(
    getAddressEncoder().encode(
      opts.writeAuthority ?? ("11111111111111111111111111111111" as Address),
    ),
    o,
  );
  o += 32;
  if (level.kind === "full") {
    out[o++] = 1;
  } else {
    out[o++] = 0;
    out[o++] = level.numSignatures;
  }
  out.set(obs.feedId, o);
  o += 32;
  const put = (bytes: ArrayLike<number>) => {
    out.set(bytes, o);
    o += bytes.length;
  };
  put(getI64Codec().encode(obs.price));
  put(getU64Codec().encode(obs.conf));
  put(getI32Codec().encode(obs.expo));
  put(getI64Codec().encode(obs.publishTime));
  put(getI64Codec().encode(obs.prevPublishTime));
  put(getI64Codec().encode(obs.price)); // ema_price
  put(getU64Codec().encode(obs.conf)); // ema_conf
  put(getU64Codec().encode(opts.postedSlot ?? 0n));
  return out;
}
