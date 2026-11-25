// The hand-written layouts must match the IDL generated from the Rust program
// (`anchor idl build`, committed as idl/call_markets.json and re-generated in CI).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCOUNT_DISCRIMINATOR, ACCOUNT_SIZE } from "../../src/codec/accounts.ts";
import { discriminator } from "../../src/codec/discriminator.ts";
import { PROGRAM_ERROR_TO_CORE } from "../../src/codec/errors.ts";
import type { Fields, FieldType } from "../../src/codec/layout.ts";
import {
  ACCOUNTS,
  DEFINED_TYPES,
  EVENTS,
  INSTRUCTIONS,
  PROGRAM_ERROR_OFFSET,
  PROGRAM_ERRORS,
} from "../../src/codec/program.ts";
import { PLACEHOLDER_PROGRAM_ID } from "../../src/constants.ts";

interface IdlField {
  name: string;
  type: FieldType;
}
interface Idl {
  address: string;
  instructions: {
    name: string;
    discriminator: number[];
    accounts: { name: string; writable?: boolean; signer?: boolean }[];
    args: IdlField[];
  }[];
  accounts: { name: string; discriminator: number[] }[];
  events: { name: string; discriminator: number[] }[];
  errors: { code: number; name: string }[];
  types: { name: string; type: { kind: string; fields: IdlField[] } }[];
}

const idl = JSON.parse(
  readFileSync(new URL("../../idl/call_markets.json", import.meta.url), "utf8"),
) as Idl;

function typeFields(name: string): Fields {
  const t = idl.types.find((x) => x.name === name);
  if (t === undefined) throw new Error(`IDL type ${name} missing`);
  return t.type.fields.map((f) => [f.name, f.type] as const);
}

/** Instruction args with `defined` struct args expanded (Borsh encodes them identically). */
function flatArgs(args: IdlField[]): Fields {
  return args.flatMap((a) =>
    typeof a.type === "object" && "defined" in a.type
      ? typeFields(a.type.defined.name)
      : [[a.name, a.type] as const],
  );
}

describe("layouts match the generated IDL", () => {
  it("is the IDL of the placeholder program id", () => {
    expect(idl.address).toBe(PLACEHOLDER_PROGRAM_ID);
  });

  it("instructions: discriminators, account order and flags, arguments", () => {
    const ours = Object.values(INSTRUCTIONS);
    expect(ours.map((i) => i.name).sort()).toEqual(idl.instructions.map((i) => i.name).sort());
    for (const ix of ours) {
      const theirs = idl.instructions.find((i) => i.name === ix.name);
      if (theirs === undefined) throw new Error(ix.name);
      expect([...discriminator("global", ix.name)]).toEqual(theirs.discriminator);
      expect(ix.accounts.map((a) => [a.name, a.w, a.s])).toEqual(
        theirs.accounts.map((a) => [a.name, a.writable === true, a.signer === true]),
      );
      expect(ix.args).toEqual(flatArgs(theirs.args));
    }
  });

  it("defined argument types", () => {
    for (const [name, fields] of Object.entries(DEFINED_TYPES)) {
      expect(fields).toEqual(typeFields(name));
    }
  });

  it("accounts: discriminators, fields and sizes", () => {
    expect(Object.keys(ACCOUNTS).sort()).toEqual(idl.accounts.map((a) => a.name).sort());
    for (const [name, fields] of Object.entries(ACCOUNTS)) {
      const theirs = idl.accounts.find((a) => a.name === name);
      expect([...ACCOUNT_DISCRIMINATOR[name as keyof typeof ACCOUNTS]]).toEqual(
        theirs?.discriminator,
      );
      expect(fields).toEqual(typeFields(name));
    }
    // 8 + INIT_SPACE, as allocated by the program.
    expect(ACCOUNT_SIZE).toEqual({ Config: 357, Call: 333, Position: 83 });
  });

  it("events: discriminators and fields", () => {
    expect(Object.keys(EVENTS).sort()).toEqual(idl.events.map((e) => e.name).sort());
    for (const [name, fields] of Object.entries(EVENTS)) {
      const theirs = idl.events.find((e) => e.name === name);
      expect([...discriminator("event", name)]).toEqual(theirs?.discriminator);
      expect(fields).toEqual(typeFields(name));
    }
  });

  it("errors: same names in the same order, each mapped to a core code", () => {
    expect(idl.errors.map((e) => [e.code, e.name])).toEqual(
      PROGRAM_ERRORS.map((name, i) => [PROGRAM_ERROR_OFFSET + i, name]),
    );
    expect(Object.keys(PROGRAM_ERROR_TO_CORE).sort()).toEqual([...PROGRAM_ERRORS].sort());
  });
});
