// A synthetic in-memory chain (the core's MemoryWorld) with calls in every record state.
// Identities and feeds are synthetic 32-byte ids, never real keys or Pyth feeds.
import {
  bytes32,
  commitmentOf,
  DEFAULT_PARAMS,
  Direction,
  MemoryAdapter,
  MemoryWorld,
  SEAL_VERSION_V1,
  Side,
  type Bytes32,
  type CallRef,
  type CallV1,
  type ProtocolParams,
} from "@agent-call-markets/core";

export const AGENT_1 = bytes32("a1".repeat(32));
export const AGENT_2 = bytes32("b2".repeat(32));
export const FEED = bytes32("f1".repeat(32));
export const PARAMS: ProtocolParams = { ...DEFAULT_PARAMS, allowedFeedIds: [FEED] };
export const T0 = 1_800_000_000n;
/** After every expiry and void window below. */
export const NOW = T0 + 3_600n + PARAMS.voidAfterSecs + 20n;

const salt = (n: number): Bytes32 => bytes32(n.toString(16).padStart(2, "0").repeat(32));

export interface World {
  readonly world: MemoryWorld;
  readonly refs: Record<
    "pendingReveal" | "unrevealed" | "pendingOutcome" | "hit" | "miss" | "void" | "otherHit",
    CallRef
  >;
}

/** AGENT_1: one call in each record state (the HIT market has an own-key self-trade). AGENT_2: one HIT. */
export async function makeWorld(): Promise<World> {
  const world = new MemoryWorld(PARAMS, T0);
  const a1 = new MemoryAdapter(world, AGENT_1);
  const a2 = new MemoryAdapter(world, AGENT_2);
  const reader = new MemoryAdapter(world, AGENT_2);
  let n = 1;
  const seal = async (
    adapter: MemoryAdapter,
    agent: Bytes32,
    expiryTs: bigint,
    mantissa = 100_000_000n,
  ) => {
    const call: CallV1 = {
      version: SEAL_VERSION_V1,
      agent,
      feedId: FEED,
      direction: Direction.Above,
      level: { mantissa, expo: -6 },
      expiryTs,
    };
    const s = salt(n++);
    const ref = (await adapter.sealCall({ commitment: commitmentOf(call, s), expiryTs })).value;
    return { ref, call, s };
  };
  const obs = (call: CallV1, price: bigint) => ({
    kind: "inline" as const,
    observation: {
      feedId: FEED,
      price,
      conf: 0n,
      expo: -6,
      publishTime: call.expiryTs,
      prevPublishTime: call.expiryTs - 1n,
    },
  });

  const e1 = T0 + 3_600n;
  const unrevealed = await seal(a1, AGENT_1, e1);
  const pendingOutcome = await seal(a1, AGENT_1, T0 + 7_200n, 101_000_000n);
  const hit = await seal(a1, AGENT_1, e1, 102_000_000n);
  const miss = await seal(a1, AGENT_1, e1, 103_000_000n);
  const voided = await seal(a1, AGENT_1, e1, 104_000_000n);
  const otherHit = await seal(a2, AGENT_2, e1);

  world.now = T0 + 1n;
  for (const c of [pendingOutcome, hit, miss, voided]) await a1.revealCall(c.ref, c.call, c.s);
  await a2.revealCall(otherHit.ref, otherHit.call, otherHit.s);
  await a1.openMarket(hit.ref);
  world.fund(AGENT_1, 10n);
  await a1.trade(hit.ref, Side.Yes, 10n, 0n); // the agent's own key on its own market

  world.now = e1;
  await reader.settle(hit.ref, obs(hit.call, 110_000_000n));
  await reader.settle(miss.ref, obs(miss.call, 90_000_000n));
  await reader.settle(otherHit.ref, obs(otherHit.call, 110_000_000n));

  world.now = e1 + PARAMS.voidAfterSecs;
  await reader.voidUnsettled(voided.ref);

  world.now = NOW - 10n;
  const pendingReveal = await seal(a1, AGENT_1, NOW - 10n + 3_600n, 105_000_000n);
  world.now = NOW;

  return {
    world,
    refs: {
      pendingReveal: pendingReveal.ref,
      unrevealed: unrevealed.ref,
      pendingOutcome: pendingOutcome.ref,
      hit: hit.ref,
      miss: miss.ref,
      void: voided.ref,
      otherHit: otherHit.ref,
    },
  };
}
