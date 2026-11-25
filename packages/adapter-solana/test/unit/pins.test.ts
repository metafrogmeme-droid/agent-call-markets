// Cross-checks between the TypeScript constants and the Rust program / Anchor workspace.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLUSTERS,
  DEFAULT_RPC_URL,
  DISCLAIMER,
  PLACEHOLDER_PROGRAM_ID,
  PYTH_RECEIVER_PROGRAM_ID,
} from "../../src/constants.ts";

const root = new URL("../../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

describe("pins", () => {
  it("pins the original Pyth Core receiver, exactly as the program does", () => {
    expect(PYTH_RECEIVER_PROGRAM_ID).toBe("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
    expect(read("programs/call_markets/src/state.rs")).toContain(
      `pub const PYTH_RECEIVER_PROGRAM_ID: Pubkey = pubkey!("${PYTH_RECEIVER_PROGRAM_ID}");`,
    );
  });

  it("uses the program's declare_id! placeholder", () => {
    expect(read("programs/call_markets/src/lib.rs")).toContain(
      `declare_id!("${PLACEHOLDER_PROGRAM_ID}");`,
    );
  });

  it("Anchor.toml configures only localnet and devnet", () => {
    const toml = read("Anchor.toml");
    const sections = [...toml.matchAll(/^\[programs\.([a-z-]+)\]/gm)].map((m) => m[1]);
    expect(sections.sort()).toEqual(["devnet", "localnet"]);
    expect(toml).toMatch(/^cluster = "localnet"$/m);
    expect(toml).not.toMatch(/mainnet-beta\.solana\.com|testnet\.solana\.com/);
  });

  it("knows only devnet and localnet", () => {
    expect([...CLUSTERS]).toEqual(["devnet", "localnet"]);
    expect(Object.keys(DEFAULT_RPC_URL).sort()).toEqual(["devnet", "localnet"]);
    expect(Object.values(DEFAULT_RPC_URL).join(" ")).not.toMatch(/mainnet|testnet/);
  });

  it("carries the verbatim disclaimer from the brief", () => {
    expect(read("CLAUDE_BRIEF.md").replace(/\s+/g, " ")).toContain(DISCLAIMER);
  });
});
