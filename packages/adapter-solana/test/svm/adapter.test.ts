// SolanaAdapter behaviour beyond the shared conformance suite, against the compiled SBF binary:
// the pinned Pyth receiver, one accepted price update per market, the cluster guard on every
// send, read-only refusals and outcome re-derivation with the core.
import { describe, expect, it } from "vitest";
import { address, generateKeyPairSigner, type Address } from "@solana/kit";
import {
  CallStatus,
  commitmentOf,
  computeAgentRecord,
  CoreError,
  Direction,
  ErrorCode,
  Outcome,
  quote,
  SEAL_VERSION_V1,
  Side,
  type Bytes32,
  type CallV1,
  type OracleObservation,
} from "@agent-call-markets/core";
import type { SolanaAdapter } from "../../src/adapter.ts";
import { decodeCall } from "../../src/codec/accounts.ts";
import {
  GENESIS_HASH,
  PLACEHOLDER_PROGRAM_ID,
  PYTH_RECEIVER_PROGRAM_ID,
} from "../../src/constants.ts";
import { FEED, keyOf, makeWorld, PARAMS, T0, type World } from "./harness.ts";
import { bytes32 } from "@agent-call-markets/core";

const SALT = bytes32("5a".repeat(32));
const PYTH_CORE_COMPATIBLE_RECEIVER = address("rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

async function rejects(p: Promise<unknown>, code: ErrorCode): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof CoreError && e.code === code);
}

interface Revealed {
  readonly w: World;
  readonly agent: SolanaAdapter;
  readonly agentKey: Bytes32;
  readonly call: CallV1;
  readonly ref: { readonly chainId: string; readonly id: string };
}

async function revealed(direction: Direction = Direction.Above): Promise<Revealed> {
  const w = await makeWorld();
  const signer = await w.newSigner();
  const agent = await w.adapter(signer);
  const agentKey = keyOf(signer);
  const call: CallV1 = {
    version: SEAL_VERSION_V1,
    agent: agentKey,
    feedId: FEED,
    direction,
    level: { mantissa: 100_000_000n, expo: -6 },
    expiryTs: T0 + PARAMS.minLeadSecs,
  };
  const ref = (
    await agent.sealCall({ commitment: commitmentOf(call, SALT), expiryTs: call.expiryTs })
  ).value;
  w.advanceTo(T0 + 1n);
  await agent.revealCall(ref, call, SALT);
  return { w, agent, agentKey, call, ref };
}

function obs(call: CallV1, price: bigint, conf = 0n): OracleObservation {
  return {
    feedId: call.feedId,
    price,
    conf,
    expo: -6,
    publishTime: call.expiryTs,
    prevPublishTime: call.expiryTs - 1n,
  };
}

describe("pinned Pyth Core receiver", () => {
  it("rejects price accounts owned by any other program, then accepts the pinned receiver", async () => {
    const { w, agent, call, ref } = await revealed();
    w.advanceTo(call.expiryTs + 1n);
    const others: Address[] = [
      PYTH_CORE_COMPATIBLE_RECEIVER,
      PLACEHOLDER_PROGRAM_ID,
      SYSTEM_PROGRAM,
      TOKEN_PROGRAM,
      (await generateKeyPairSigner()).address,
    ];
    for (const owner of others) {
      const price = await w.putPrice(obs(call, 101_000_000n), { owner });
      await rejects(agent.settle(ref, price), ErrorCode.OracleOwnerMismatch);
    }
    expect((await agent.getCall(ref))?.state.status).toBe(CallStatus.Revealed);
    const good = await w.putPrice(obs(call, 101_000_000n), { owner: PYTH_RECEIVER_PROGRAM_ID });
    expect((await agent.settle(ref, good)).value).toBe(Outcome.Hit);
  });

  it("rejects a partially verified update", async () => {
    const { w, agent, call, ref } = await revealed();
    w.advanceTo(call.expiryTs + 1n);
    const partial = await w.putPrice(obs(call, 101_000_000n), {
      level: { kind: "partial", numSignatures: 5 },
    });
    await rejects(agent.settle(ref, partial), ErrorCode.OracleNotVerified);
  });

  it("rejects a missing price account as a wrong owner (system-owned)", async () => {
    const { w, agent, call, ref } = await revealed();
    w.advanceTo(call.expiryTs + 1n);
    const missing = (await generateKeyPairSigner()).address;
    await rejects(
      agent.settle(ref, { kind: "account", address: missing }),
      ErrorCode.OracleOwnerMismatch,
    );
  });
});

describe("exactly one accepted price update per market", () => {
  it("records the accepted update; the same account, the same message elsewhere and any other update are rejected", async () => {
    const { w, agent, call, ref } = await revealed();
    w.advanceTo(call.expiryTs + 1n);
    const first = await w.putPrice(obs(call, 101_000_000n));
    await agent.settle(ref, first);
    const rec = await agent.getCall(ref);
    expect(rec?.account.accepted_update).toBe(first.address);
    await rejects(agent.settle(ref, first), ErrorCode.DuplicatePriceUpdate);
    const copy = await w.putPrice(obs(call, 101_000_000n));
    await rejects(agent.settle(ref, copy), ErrorCode.DuplicatePriceUpdate);
    const other = await w.putPrice(obs(call, 99_000_000n));
    await rejects(agent.settle(ref, other), ErrorCode.AlreadySettled);
    const after = await agent.getCall(ref);
    expect(after?.state.outcome).toBe(Outcome.Hit);
    expect(after?.account.accepted_update).toBe(first.address);
  });

  it("refuses inline observations without sending anything", async () => {
    const { w, agent, call, ref } = await revealed();
    const before = w.transport.sends;
    await rejects(
      agent.settle(ref, { kind: "inline", observation: obs(call, 101_000_000n) }),
      ErrorCode.UnsupportedOracleRef,
    );
    await rejects(
      agent.settle(ref, { kind: "account", address: "not-an-address" }),
      ErrorCode.UnsupportedOracleRef,
    );
    expect(w.transport.sends).toBe(before);
  });
});

describe("cluster guard", () => {
  it("refuses to connect to mainnet, testnet, or devnet-by-name on an in-process endpoint", async () => {
    const w = await makeWorld();
    w.transport.genesisHash = GENESIS_HASH.mainnetBeta;
    await rejects(w.adapter(null), ErrorCode.ClusterNotAllowed);
    w.transport.genesisHash = GENESIS_HASH.testnet;
    await rejects(w.adapter(null), ErrorCode.ClusterNotAllowed);
    w.transport.genesisHash = GENESIS_HASH.devnet;
    await expect(
      (await import("../../src/adapter.ts")).SolanaAdapter.connect({
        cluster: "localnet",
        transport: w.transport,
        signer: null,
      }),
    ).rejects.toSatisfy((e: unknown) => (e as CoreError).code === ErrorCode.ClusterNotAllowed);
  });

  it("re-checks before every send: an endpoint that turns into mainnet gets nothing", async () => {
    const w = await makeWorld();
    const signer = await w.newSigner();
    const agent = await w.adapter(signer);
    const before = w.transport.sends;
    w.transport.genesisHash = GENESIS_HASH.mainnetBeta;
    await rejects(
      agent.sealCall({ commitment: bytes32("11".repeat(32)), expiryTs: T0 + PARAMS.minLeadSecs }),
      ErrorCode.ClusterNotAllowed,
    );
    await rejects(agent.airdrop(1n), ErrorCode.ClusterNotAllowed);
    expect(w.transport.sends).toBe(before);
  });
});

describe("read-only adapters and references", () => {
  it("read-only instances read but never send", async () => {
    const { w, ref, call, agentKey } = await revealed();
    const reader = await w.adapter(null);
    expect((await reader.getCall(ref))?.state.agent).toEqual(agentKey);
    const before = w.transport.sends;
    const m = { chainId: ref.chainId, id: ref.id };
    await rejects(
      reader.sealCall({ commitment: bytes32("99".repeat(32)), expiryTs: call.expiryTs }),
      ErrorCode.ReadOnly,
    );
    await rejects(reader.revealCall(ref, call, SALT), ErrorCode.ReadOnly);
    await rejects(reader.openMarket(ref), ErrorCode.ReadOnly);
    await rejects(reader.trade(m, Side.Yes, 1n, 0n), ErrorCode.ReadOnly);
    await rejects(reader.redeem(m), ErrorCode.ReadOnly);
    await rejects(reader.settle(ref, await w.putPrice(obs(call, 1n))), ErrorCode.ReadOnly);
    await rejects(reader.voidUnsettled(ref), ErrorCode.ReadOnly);
    await rejects(reader.createTestMint(6), ErrorCode.ReadOnly);
    expect(w.transport.sends).toBe(before);
  });

  it("rejects foreign or malformed references and duplicate seals", async () => {
    const { agent, ref, call } = await revealed();
    await rejects(
      agent.openMarket({ chainId: "solana:devnet", id: ref.id }),
      ErrorCode.UnknownCall,
    );
    await rejects(agent.openMarket({ chainId: ref.chainId, id: "nope" }), ErrorCode.UnknownCall);
    const stranger = (await generateKeyPairSigner()).address;
    await rejects(agent.openMarket({ chainId: ref.chainId, id: stranger }), ErrorCode.UnknownCall);
    expect(await agent.getCall({ chainId: ref.chainId, id: stranger })).toBeNull();
    expect(await agent.getCall({ chainId: ref.chainId, id: "nope" })).toBeNull();
    await rejects(
      agent.sealCall({ commitment: commitmentOf(call, SALT), expiryTs: call.expiryTs }),
      ErrorCode.DuplicateCall,
    );
  });
});

describe("market reads and trading", () => {
  it("quotes from the on-chain pool exactly like the core", async () => {
    const { w, agent, ref } = await revealed();
    const m = { chainId: ref.chainId, id: ref.id };
    await rejects(agent.quote(m, Side.Yes, 10n), ErrorCode.MarketNotOpen);
    await agent.openMarket(ref);
    const trader = await w.adapter(await w.newSigner());
    if (trader.signer === null) throw new Error("signer");
    await w.admin.mintTestTokens(w.mint, trader.signer.address, 1_000n);
    await trader.trade(m, Side.No, 300n, 0n);
    const q = await agent.quote(m, Side.Yes, 100n);
    const expected = quote({ yes: 0n, no: 300n }, Side.Yes, 100n);
    expect(expected.ok && q).toEqual(expected.ok ? expected.value : null);
    await rejects(trader.trade(m, Side.No, 0n, 0n), ErrorCode.InvalidAmount);
    await rejects(trader.trade(m, Side.No, 1n, 10n), ErrorCode.LimitNotMet);
    await rejects(trader.trade(m, Side.No, -1n, 0n), ErrorCode.InvalidAmount);
  });

  it("maps a missing or short token balance to INSUFFICIENT_BALANCE", async () => {
    const { w, agent, ref } = await revealed();
    const m = { chainId: ref.chainId, id: ref.id };
    await agent.openMarket(ref);
    const poor = await w.adapter(await w.newSigner());
    await rejects(poor.trade(m, Side.Yes, 10n, 0n), ErrorCode.InsufficientBalance);
    if (poor.signer === null) throw new Error("signer");
    await w.admin.mintTestTokens(w.mint, poor.signer.address, 5n);
    await rejects(poor.trade(m, Side.Yes, 10n, 0n), ErrorCode.InsufficientBalance);
    expect(await poor.tokenBalance(poor.signer.address)).toBe(5n);
  });

  it("pays a HIT to YES holders, leaves dust in the vault, and builds the record with the core", async () => {
    const { w, agent, agentKey, call, ref } = await revealed();
    const m = { chainId: ref.chainId, id: ref.id };
    await agent.openMarket(ref);
    const a = await w.adapter(await w.newSigner());
    const b = await w.adapter(await w.newSigner());
    for (const x of [a, b, agent]) {
      if (x.signer === null) throw new Error("signer");
      await w.admin.mintTestTokens(w.mint, x.signer.address, 1_000n);
    }
    await a.trade(m, Side.Yes, 1n, 0n);
    await b.trade(m, Side.Yes, 2n, 0n);
    await b.trade(m, Side.No, 4n, 0n); // b on both sides
    await agent.trade(m, Side.No, 3n, 0n); // the agent's own-key self-trade
    w.advanceTo(call.expiryTs);
    await agent.settle(ref, await w.putPrice(obs(call, 101_000_000n)));
    // Pool 10, YES 3: a gets floor(1*10/3) = 3, b gets floor(2*10/3) = 6 (+0 for NO); dust 1.
    expect((await a.redeem(m)).value).toBe(3n);
    expect((await b.redeem(m)).value).toBe(6n);
    expect((await agent.redeem(m)).value).toBe(0n);
    await rejects(b.redeem(m), ErrorCode.NothingToRedeem);

    const rec = await agent.getCall(ref);
    expect(rec?.outcomeCheck).toBe("match");
    expect(rec?.positions).toHaveLength(4);
    expect(rec?.positions.every((p) => p.redeemed)).toBe(true);
    const list = await agent.listCalls(agentKey);
    expect(list.map((r) => r.ref.id)).toEqual([ref.id]);
    const record = computeAgentRecord(
      agentKey,
      list.map((r) => r.state),
      call.expiryTs + 1n,
    );
    expect(record).toMatchObject({
      sealed: 1,
      revealed: 1,
      hits: 1,
      misses: 0,
      selfTradedCalls: 1,
    });
  });
});

describe("outcome re-derivation", () => {
  it("flags an account whose stored outcome disagrees with the core rule", async () => {
    const { w, agent, call, ref } = await revealed();
    w.advanceTo(call.expiryTs);
    expect((await agent.getCall(ref))?.outcomeCheck).toBe("n/a");
    await agent.settle(ref, await w.putPrice(obs(call, 101_000_000n)));
    expect((await agent.getCall(ref))?.outcomeCheck).toBe("match");
    // Tamper with the stored outcome (HIT -> MISS) directly in the simulator.
    const acct = w.svm.getAccount(address(ref.id));
    if (!acct.exists) throw new Error("missing");
    const data = Uint8Array.from(acct.data);
    const OUTCOME_OFFSET = 224; // 8 + fields before `outcome` (see codec/program.ts)
    expect(decodeCall(data).outcome).toBe(1);
    data[OUTCOME_OFFSET] = 2;
    w.svm.setAccount({ ...acct, data });
    const tampered = await agent.getCall(ref);
    expect(tampered?.state.outcome).toBe(Outcome.Miss);
    expect(tampered?.outcomeCheck).toBe("mismatch");
  });
});

describe("admin", () => {
  it("only the upgrade authority can initialise the config, once", async () => {
    const w = await makeWorld(PARAMS, { initConfig: false });
    const stranger = await w.adapter(await w.newSigner());
    await rejects(stranger.config(), ErrorCode.ChainError);
    await rejects(stranger.initializeConfig(PARAMS, w.mint), ErrorCode.Unauthorized);
    await rejects(
      w.admin.initializeConfig({ ...PARAMS, allowedFeedIds: [] }, w.mint),
      ErrorCode.InvalidFeedList,
    );
    await rejects(
      w.admin.initializeConfig({ ...PARAMS, maxConfBps: 0n }, w.mint),
      ErrorCode.InvalidParams,
    );
    await w.admin.initializeConfig(PARAMS, w.mint);
    expect((await stranger.config()).params).toEqual(PARAMS);
    await rejects(w.admin.initializeConfig(PARAMS, w.mint), ErrorCode.ChainError);
    await rejects(w.admin.mintTestTokens(w.mint, w.authority.address, 0n), ErrorCode.InvalidAmount);
    expect(await w.admin.now()).toBe(T0);
  });
});
