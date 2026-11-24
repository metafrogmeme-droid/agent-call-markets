import { describe, expect, it } from "vitest";
import {
  bytes32,
  commitmentOf,
  CoreError,
  ErrorCode,
  MemoryAdapter,
  MemoryWorld,
  Side,
  type CallRef,
} from "../src/index.ts";
import { runAdapterConformance } from "../src/testing/index.ts";
import { AGENT, FEED, makeCall, makeObs, OTHER, PARAMS, SALT, T0 } from "./fixtures.ts";

runAdapterConformance("MemoryAdapter", {
  params: PARAMS,
  feedId: FEED,
  setup() {
    const world = new MemoryWorld(PARAMS, T0);
    return Promise.resolve({
      agent: new MemoryAdapter(world, AGENT),
      agentKey: AGENT,
      trader: new MemoryAdapter(world, OTHER),
      traderKey: OTHER,
      now: () => Promise.resolve(world.now),
      advanceTo: (ts: bigint) => {
        world.now = ts;
        return Promise.resolve();
      },
      fund: (owner, amount) => {
        world.fund(owner, amount);
        return Promise.resolve();
      },
      balanceOf: (owner) => Promise.resolve(world.balanceOf(owner)),
      oracle: (observation) => Promise.resolve({ kind: "inline" as const, observation }),
    });
  },
});

async function rejectsWith(p: Promise<unknown>, code: ErrorCode) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof CoreError && e.code === code);
}

describe("MemoryAdapter specifics", () => {
  const call = makeCall();

  function setup() {
    const world = new MemoryWorld(PARAMS, T0);
    return {
      world,
      agent: new MemoryAdapter(world, AGENT),
      reader: new MemoryAdapter(world, null),
    };
  }

  it("validates params at construction", () => {
    expect(() => new MemoryWorld({ ...PARAMS, maxConfBps: 0n }, T0)).toThrow(CoreError);
  });

  it("read-only instances can read but not send", async () => {
    const { agent, reader } = setup();
    const ref = (
      await agent.sealCall({ commitment: commitmentOf(call, SALT), expiryTs: call.expiryTs })
    ).value;
    expect((await reader.getCall(ref))?.state.agent).toEqual(AGENT);
    await rejectsWith(
      reader.sealCall({ commitment: bytes32("99".repeat(32)), expiryTs: call.expiryTs }),
      ErrorCode.ReadOnly,
    );
    await rejectsWith(
      reader.settle(ref, { kind: "inline", observation: makeObs() }),
      ErrorCode.ReadOnly,
    );
  });

  it("rejects duplicate seals, unknown calls and account oracle refs", async () => {
    const { world, agent } = setup();
    const seal = { commitment: commitmentOf(call, SALT), expiryTs: call.expiryTs };
    const ref = (await agent.sealCall(seal)).value;
    await rejectsWith(agent.sealCall(seal), ErrorCode.DuplicateCall);
    const ghost: CallRef = { chainId: agent.chainId, id: "nope" };
    expect(await agent.getCall(ghost)).toBeNull();
    await rejectsWith(agent.revealCall(ghost, call, SALT), ErrorCode.UnknownCall);
    world.now = T0 + 1n;
    await agent.revealCall(ref, call, SALT);
    world.now = call.expiryTs;
    await rejectsWith(
      agent.settle(ref, { kind: "account", address: "x" }),
      ErrorCode.UnsupportedOracleRef,
    );
  });

  it("quotes open markets only, and checks test-token balances", async () => {
    const { world, agent } = setup();
    const ref = (
      await agent.sealCall({ commitment: commitmentOf(call, SALT), expiryTs: call.expiryTs })
    ).value;
    await rejectsWith(agent.quote(ref, Side.Yes, 1n), ErrorCode.MarketNotOpen);
    world.now = T0 + 1n;
    await agent.revealCall(ref, call, SALT);
    const m = (await agent.openMarket(ref)).value;
    expect((await agent.quote(m, Side.Yes, 5n)).projectedPayout).toBe(5n);
    await rejectsWith(agent.trade(m, Side.Yes, 5n, 0n), ErrorCode.InsufficientBalance);
    expect((await agent.getCall(ref))?.state.market?.pool).toEqual({ yes: 0n, no: 0n });
  });

  it("the test-token ledger rejects bad amounts and stays within u64", () => {
    const { world } = setup();
    expect(() => {
      world.fund(AGENT, 0n);
    }).toThrow(CoreError);
    world.fund(AGENT, (1n << 64n) - 1n);
    expect(() => {
      world.fund(AGENT, 1n);
    }).toThrow(CoreError);
  });

  it("issues distinct transaction ids", async () => {
    const { agent } = setup();
    const a = await agent.sealCall({
      commitment: bytes32("01".repeat(32)),
      expiryTs: call.expiryTs,
    });
    const b = await agent
      .as(OTHER)
      .sealCall({ commitment: bytes32("01".repeat(32)), expiryTs: call.expiryTs });
    expect(a.txId).not.toBe(b.txId);
    expect(a.value.id).not.toBe(b.value.id);
  });
});
