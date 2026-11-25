import {
  AccountRole,
  isTransactionSigner,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { discriminator } from "./discriminator.ts";
import { DEFINED_TYPES, INSTRUCTIONS, type IxLayout } from "./program.ts";
import { structCodec, type StructInput } from "./layout.ts";

export type IxName = keyof typeof INSTRUCTIONS;
type Layout<N extends IxName> = (typeof INSTRUCTIONS)[N];
export type IxAccounts<N extends IxName> = Readonly<
  Record<Layout<N>["accounts"][number]["name"], Address | TransactionSigner>
>;
export type IxArgs<N extends IxName> = StructInput<Layout<N>["args"]>;

function role(w: boolean, s: boolean): AccountRole {
  if (w && s) return AccountRole.WRITABLE_SIGNER;
  if (s) return AccountRole.READONLY_SIGNER;
  if (w) return AccountRole.WRITABLE;
  return AccountRole.READONLY;
}

/** Instruction data: 8-byte discriminator followed by the Borsh-encoded arguments. */
export function encodeIxData<N extends IxName>(name: N, args: IxArgs<N>): Uint8Array {
  const layout: IxLayout = INSTRUCTIONS[name];
  const body = structCodec(layout.args, DEFINED_TYPES).encode(args as never);
  const disc = discriminator("global", layout.name);
  const out = new Uint8Array(disc.length + body.length);
  out.set(disc, 0);
  out.set(body, disc.length);
  return out;
}

/**
 * Builds one call_markets instruction. Accounts are named as in the program's account struct and
 * placed in its order; signer accounts must be given as TransactionSigners.
 */
export function buildIx<N extends IxName>(
  programId: Address,
  name: N,
  accounts: IxAccounts<N>,
  args: IxArgs<N>,
): Instruction {
  const layout: IxLayout = INSTRUCTIONS[name];
  const given = accounts as Readonly<Record<string, Address | TransactionSigner>>;
  const metas = layout.accounts.map((a): AccountMeta | AccountSignerMeta => {
    const value = given[a.name];
    if (value === undefined) throw new Error(`${layout.name}: missing account ${a.name}`);
    const r = role(a.w, a.s);
    if (typeof value === "string") {
      if (a.s) throw new Error(`${layout.name}: account ${a.name} must be a signer`);
      return { address: value, role: r };
    }
    if (!isTransactionSigner(value)) throw new Error(`${layout.name}: bad account ${a.name}`);
    return a.s
      ? { address: value.address, role: r, signer: value }
      : { address: value.address, role: r };
  });
  return { programAddress: programId, accounts: metas, data: encodeIxData(name, args) };
}
