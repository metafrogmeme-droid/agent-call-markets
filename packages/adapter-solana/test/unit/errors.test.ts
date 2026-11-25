import { describe, expect, it } from "vitest";
import { SolanaError, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM } from "@solana/kit";
import { ErrorCode } from "@agent-call-markets/core";
import {
  failureFromRawError,
  failureFromSolanaError,
  programErrorName,
  toCoreError,
} from "../../src/codec/errors.ts";

describe("program error mapping", () => {
  it("maps custom codes of program instructions by name", () => {
    expect(programErrorName(6000)).toBe("InvalidParams");
    expect(programErrorName(6031)).toBe("DuplicatePriceUpdate");
    expect(programErrorName(6038)).toBe("NothingToRedeem");
    expect(programErrorName(6039)).toBeNull();
    expect(programErrorName(5999)).toBeNull();
    const f = (ix: number, code: number) => ({
      instructionIndex: ix,
      customCode: code,
      detail: "d",
    });
    expect(toCoreError(f(0, 6031), [0]).code).toBe(ErrorCode.DuplicatePriceUpdate);
    expect(toCoreError(f(0, 6024), [0]).code).toBe(ErrorCode.OracleNotVerified);
    expect(toCoreError(f(0, 6030), [0]).code).toBe(ErrorCode.OracleOwnerMismatch);
  });

  it("only maps codes from call_markets instructions; others are CHAIN_ERROR", () => {
    const f = (ix: number, code: number | null) => ({
      instructionIndex: ix,
      customCode: code,
      detail: "raw",
    });
    expect(toCoreError(f(0, 6031), [1]).code).toBe(ErrorCode.ChainError);
    expect(toCoreError(f(1, 3012), [1]).code).toBe(ErrorCode.ChainError);
    expect(toCoreError(f(1, null), [1]).code).toBe(ErrorCode.ChainError);
    expect(
      toCoreError({ instructionIndex: null, customCode: null, detail: "x" }, [0]).message,
    ).toContain("x");
  });

  it("reads SPL Token's insufficient funds only on buy instructions", () => {
    const f = { instructionIndex: 1, customCode: 1, detail: "d" };
    expect(toCoreError(f, [0, 1], [1]).code).toBe(ErrorCode.InsufficientBalance);
    expect(toCoreError(f, [0, 1], []).code).toBe(ErrorCode.ChainError);
  });
});

describe("transport failure normalisation", () => {
  it("parses raw RPC transaction errors", () => {
    expect(failureFromRawError({ InstructionError: [2, { Custom: 6021 }] })).toMatchObject({
      instructionIndex: 2,
      customCode: 6021,
    });
    expect(failureFromRawError({ InstructionError: [0, "InvalidAccountData"] })).toMatchObject({
      instructionIndex: 0,
      customCode: null,
    });
    expect(failureFromRawError("BlockhashNotFound")).toMatchObject({
      instructionIndex: null,
      customCode: null,
      detail: '"BlockhashNotFound"',
    });
    expect(
      failureFromRawError({ InsufficientFundsForRent: { account_index: 1n } }).detail,
    ).toContain('"1"');
  });

  it("finds the custom instruction error inside a kit SolanaError chain", () => {
    const inner = new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, {
      code: 6018,
      index: 1,
    });
    const outer = new Error("wrapper", { cause: inner });
    expect(failureFromSolanaError(inner)).toMatchObject({ instructionIndex: 1, customCode: 6018 });
    expect(failureFromSolanaError(outer)).toBeNull(); // not a SolanaError at the top
    expect(failureFromSolanaError(new Error("plain"))).toBeNull();
  });
});
