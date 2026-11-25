import { describe, expect, it } from "vitest";
import { AccountRole, generateKeyPairSigner, getAddressDecoder, type Address } from "@solana/kit";
import { buildIx } from "../../src/codec/instructions.ts";
import { fieldCodec, fixedSizeOf } from "../../src/codec/layout.ts";
import { DEFINED_TYPES, INSTRUCTIONS } from "../../src/codec/program.ts";
import { PLACEHOLDER_PROGRAM_ID } from "../../src/constants.ts";

const addr = (b: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(b));

describe("buildIx", () => {
  it("orders accounts as the program's struct and sets roles and signers", async () => {
    const buyer = await generateKeyPairSigner();
    const ix = buildIx(
      PLACEHOLDER_PROGRAM_ID,
      "buy",
      {
        buyer,
        config: addr(1),
        call: addr(2),
        collateral_mint: addr(3),
        vault: addr(4),
        buyer_token: addr(5),
        position: addr(6),
        token_program: addr(7),
      },
      { amount: 10n, min_projected_payout: 0n },
    );
    expect(ix.programAddress).toBe(PLACEHOLDER_PROGRAM_ID);
    expect(ix.accounts?.map((a) => a.role)).toEqual([
      AccountRole.READONLY_SIGNER,
      AccountRole.READONLY,
      AccountRole.WRITABLE,
      AccountRole.READONLY,
      AccountRole.WRITABLE,
      AccountRole.WRITABLE,
      AccountRole.WRITABLE,
      AccountRole.READONLY,
    ]);
    expect(ix.accounts?.[0]).toMatchObject({ address: buyer.address, signer: buyer });
    expect(ix.data).toHaveLength(8 + 8 + 8);
  });

  it("marks writable signers and accepts a signer for a non-signer slot", async () => {
    const agent = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const ix = buildIx(
      PLACEHOLDER_PROGRAM_ID,
      "sealCall",
      { agent, config: other, call: addr(2), system_program: addr(3) },
      { commitment: new Uint8Array(32).fill(9), expiry_ts: 1n },
    );
    expect(ix.accounts?.[0]?.role).toBe(AccountRole.WRITABLE_SIGNER);
    expect(ix.accounts?.[1]).toEqual({ address: other.address, role: AccountRole.READONLY });
  });

  it("refuses missing accounts, plain addresses for signers and non-signers objects", () => {
    const base = { config: addr(1), call: addr(2) };
    expect(() => buildIx(PLACEHOLDER_PROGRAM_ID, "voidUnsettled", base as never, {})).toThrow(
      /missing account caller/,
    );
    expect(() =>
      buildIx(PLACEHOLDER_PROGRAM_ID, "voidUnsettled", { ...base, caller: addr(3) }, {}),
    ).toThrow(/must be a signer/);
    expect(() =>
      buildIx(
        PLACEHOLDER_PROGRAM_ID,
        "voidUnsettled",
        { ...base, caller: { address: addr(3) } as never },
        {},
      ),
    ).toThrow(/bad account caller/);
  });

  it("covers every instruction layout", () => {
    expect(Object.keys(INSTRUCTIONS)).toHaveLength(9);
  });
});

describe("layout helpers", () => {
  it("rejects unknown defined types and variable-size layouts", () => {
    expect(() => fieldCodec({ defined: { name: "Nope" } })).toThrow(/unknown defined type/);
    expect(fieldCodec({ defined: { name: "RevealArgs" } }, DEFINED_TYPES)).toBeDefined();
    expect(() => fixedSizeOf(DEFINED_TYPES.ConfigArgs)).toThrow(/not fixed-size/);
    expect(fixedSizeOf(DEFINED_TYPES.RevealArgs)).toBe(32 + 1 + 8 + 4 + 32);
    expect(fieldCodec({ array: ["u16", 2] }).encode([1, 2])).toHaveLength(4);
  });
});
