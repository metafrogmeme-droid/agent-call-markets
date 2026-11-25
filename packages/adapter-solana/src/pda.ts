import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import type { Bytes32 } from "@agent-call-markets/core";
import { SEEDS } from "./constants.ts";

const enc = new TextEncoder();
const addressBytes = (a: Address): Uint8Array => Uint8Array.from(getAddressEncoder().encode(a));

/** PDA ["config"]. */
export async function configPda(programId: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [enc.encode(SEEDS.config)],
  });
  return pda;
}

/** PDA ["call", agent, commitment]. */
export async function callPda(
  programId: Address,
  agent: Address,
  commitment: Bytes32,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [enc.encode(SEEDS.call), addressBytes(agent), commitment],
  });
  return pda;
}

/** PDA ["vault", call]: the market's token vault, whose authority is the call PDA. */
export async function vaultPda(programId: Address, call: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [enc.encode(SEEDS.vault), addressBytes(call)],
  });
  return pda;
}

/** PDA ["position", call, owner, side] with side 1 = YES, 2 = NO. */
export async function positionPda(
  programId: Address,
  call: Address,
  owner: Address,
  side: number,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      enc.encode(SEEDS.position),
      addressBytes(call),
      addressBytes(owner),
      Uint8Array.of(side),
    ],
  });
  return pda;
}

/** The owner's associated token account for the collateral mint (SPL Token). */
export async function collateralAta(owner: Address, mint: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({
    owner,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return ata;
}
