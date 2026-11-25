import {
  fixCodecSize,
  getAddressCodec,
  getArrayCodec,
  getBooleanCodec,
  getBytesCodec,
  getI32Codec,
  getI64Codec,
  getStructCodec,
  getU16Codec,
  getU64Codec,
  getU8Codec,
  type Address,
  type Codec,
  type ReadonlyUint8Array,
} from "@solana/kit";

/**
 * A tiny Borsh layout language, spelled like Anchor IDL types so layouts can be compared with the
 * generated IDL (packages/adapter-solana/idl/call_markets.json) field by field.
 */
export type FieldType =
  | "u8"
  | "u16"
  | "i32"
  | "i64"
  | "u64"
  | "bool"
  | "pubkey"
  | { readonly array: readonly [FieldType, number] }
  | { readonly vec: FieldType }
  | { readonly defined: { readonly name: string } };

export type Field = readonly [name: string, type: FieldType];
export type Fields = readonly Field[];

/** TypeScript type a field decodes to. Byte arrays stay bytes; other arrays become arrays. */
export type Decoded<T> = T extends "u8" | "u16" | "i32"
  ? number
  : T extends "i64" | "u64"
    ? bigint
    : T extends "bool"
      ? boolean
      : T extends "pubkey"
        ? Address
        : T extends { readonly array: readonly ["u8", number] }
          ? ReadonlyUint8Array
          : T extends { readonly array: readonly [infer I, number] }
            ? Decoded<I>[]
            : T extends { readonly vec: infer I }
              ? Decoded<I>[]
              : never;

/** What a field accepts when encoding (integers may be given as number or bigint). */
export type Encodable<T> = T extends "u8" | "u16" | "i32"
  ? number
  : T extends "i64" | "u64"
    ? number | bigint
    : T extends "bool"
      ? boolean
      : T extends "pubkey"
        ? Address
        : T extends { readonly array: readonly ["u8", number] }
          ? ReadonlyUint8Array
          : T extends { readonly array: readonly [infer I, number] }
            ? readonly Encodable<I>[]
            : T extends { readonly vec: infer I }
              ? readonly Encodable<I>[]
              : never;

export type StructOf<F extends Fields> = { [K in F[number] as K[0]]: Decoded<K[1]> };
export type StructInput<F extends Fields> = { [K in F[number] as K[0]]: Encodable<K[1]> };

// The codec of each FieldType is built at runtime; the static types above describe its values.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCodec = Codec<any, any>;

export function fieldCodec(
  type: FieldType,
  defined: Readonly<Record<string, Fields>> = {},
): AnyCodec {
  if (typeof type === "string") {
    switch (type) {
      case "u8":
        return getU8Codec();
      case "u16":
        return getU16Codec();
      case "i32":
        return getI32Codec();
      case "i64":
        return getI64Codec();
      case "u64":
        return getU64Codec();
      case "bool":
        return getBooleanCodec();
      case "pubkey":
        return getAddressCodec();
    }
  }
  if ("array" in type) {
    const [inner, size] = type.array;
    if (inner === "u8") return fixCodecSize(getBytesCodec(), size);
    return getArrayCodec(fieldCodec(inner, defined), { size });
  }
  if ("vec" in type) return getArrayCodec(fieldCodec(type.vec, defined));
  const fields = defined[type.defined.name];
  if (fields === undefined) throw new Error(`unknown defined type ${type.defined.name}`);
  return structCodec(fields, defined);
}

/** Byte size of a fixed-size layout (throws for layouts with vectors). */
export function fixedSizeOf(fields: Fields): number {
  const codec = structCodec(fields) as unknown as { readonly fixedSize?: number };
  if (typeof codec.fixedSize !== "number") throw new Error("layout is not fixed-size");
  return codec.fixedSize;
}

export function structCodec<F extends Fields>(
  fields: F,
  defined: Readonly<Record<string, Fields>> = {},
): Codec<StructInput<F>, StructOf<F>> {
  return getStructCodec(
    fields.map(([name, type]) => [name, fieldCodec(type, defined)] as const),
  ) as unknown as Codec<StructInput<F>, StructOf<F>>;
}
