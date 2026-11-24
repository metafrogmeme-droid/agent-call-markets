import { describe, expect, it } from "vitest";
import type { CallRef, ChainAdapter, OracleRef } from "../adapter/types.ts";
import { bytes32, type Bytes32 } from "../bytes.ts";
import { Side } from "../parimutuel.ts";
import type { ProtocolParams } from "../params.ts";
import { ErrorCode, type CoreError } from "../result.ts";
import { commitmentOf } from "../seal/commit.ts";
import { Direction, SEAL_VERSION_V1, type CallV1 } from "../seal/schema.ts";
import { Outcome, type OracleObservation } from "../settlement.ts";
import { CallStatus } from "../state.ts";

/** One isolated environment per test. Identities are synthetic 32-byte ids, never real keys. */
export interface ConformanceEnv {
  readonly agent: ChainAdapter;
  readonly agentKey: Bytes32;
  readonly trader: ChainAdapter;
  readonly traderKey: Bytes32;
  now(): Promise<bigint>;
  advanceTo(ts: bigint): Promise<void>;
  /** Credit mock test tokens. */
  fund(owner: Bytes32, amount: bigint): Promise<void>;
  balanceOf(owner: Bytes32): Promise<bigint>;
  /** Turn an observation into whatever OracleRef this adapter's settle() takes. */
  oracle(observation: OracleObservation): Promise<OracleRef>;
}

export interface ConformanceHarness {
  /** Must have `feedId` in `allowedFeedIds`. */
  readonly params: ProtocolParams;
  readonly feedId: Bytes32;
  setup(): Promise<ConformanceEnv>;
}

const SALT = bytes32("5a".repeat(32));
const WRONG_SALT = bytes32("a5".repeat(32));

async function expectCode(promise: Promise<unknown>, code: ErrorCode): Promise<void> {
  await expect(promise).rejects.toSatisfy((e: unknown) => (e as CoreError).code === code);
}

/**
 * Behaviour every ChainAdapter must show. Runs against MemoryAdapter in M1 and against the
 * Solana adapter (local validator) in M4.
 */
export function runAdapterConformance(name: string, harness: ConformanceHarness): void {
  const { params, feedId } = harness;

  async function sealed(env: ConformanceEnv, direction: Direction = Direction.Above) {
    const now = await env.now();
    const call: CallV1 = {
      version: SEAL_VERSION_V1,
      agent: env.agentKey,
      feedId,
      direction,
      level: { mantissa: 100_000_000n, expo: -6 }, // 100.000000
      expiryTs: now + params.minLeadSecs,
    };
    const tx = await env.agent.sealCall({
      commitment: commitmentOf(call, SALT),
      expiryTs: call.expiryTs,
    });
    return { call, ref: tx.value, sealTs: now };
  }

  async function revealed(env: ConformanceEnv, direction: Direction = Direction.Above) {
    const s = await sealed(env, direction);
    await env.advanceTo(s.sealTs + 1n);
    await env.agent.revealCall(s.ref, s.call, SALT);
    return s;
  }

  function obs(
    call: CallV1,
    price: bigint,
    conf = 0n,
    publishTime = call.expiryTs,
  ): OracleObservation {
    return { feedId: call.feedId, price, conf, expo: -6, publishTime };
  }

  async function status(env: ConformanceEnv, ref: CallRef) {
    return (await env.agent.getCall(ref))?.state.status;
  }

  describe(`ChainAdapter conformance: ${name}`, () => {
    it("seals a call and reads it back", async () => {
      const env = await harness.setup();
      const s = await sealed(env);
      const rec = await env.agent.getCall(s.ref);
      expect(rec?.state.status).toBe(CallStatus.Sealed);
      expect(rec?.state.expiryTs).toBe(s.call.expiryTs);
      expect(rec?.state.revealDeadlineTs).toBe(s.sealTs + params.revealWindowSecs);
      expect(rec?.state.call).toBeNull();
    });

    it("rejects expiry too soon or too far", async () => {
      const env = await harness.setup();
      const now = await env.now();
      const c = bytes32("11".repeat(32));
      await expectCode(
        env.agent.sealCall({ commitment: c, expiryTs: now + params.minLeadSecs - 1n }),
        ErrorCode.ExpiryTooSoon,
      );
      await expectCode(
        env.agent.sealCall({ commitment: c, expiryTs: now + params.maxHorizonSecs + 1n }),
        ErrorCode.ExpiryTooFar,
      );
    });

    it("rejects a reveal in the seal's own time, with a wrong salt, or from another signer", async () => {
      const env = await harness.setup();
      const s = await sealed(env);
      await expectCode(env.agent.revealCall(s.ref, s.call, SALT), ErrorCode.RevealTooEarly);
      await env.advanceTo(s.sealTs + 1n);
      await expectCode(
        env.agent.revealCall(s.ref, s.call, WRONG_SALT),
        ErrorCode.CommitmentMismatch,
      );
      await expectCode(env.trader.revealCall(s.ref, s.call, SALT), ErrorCode.WrongSigner);
      expect(await status(env, s.ref)).toBe(CallStatus.Sealed);
    });

    it("rejects a late reveal; the call stays sealed", async () => {
      const env = await harness.setup();
      const s = await sealed(env);
      await env.advanceTo(s.sealTs + params.revealWindowSecs + 1n);
      await expectCode(env.agent.revealCall(s.ref, s.call, SALT), ErrorCode.RevealDeadlinePassed);
      expect(await status(env, s.ref)).toBe(CallStatus.Sealed);
    });

    it("opens a market only after reveal and before the trading cutoff", async () => {
      const env = await harness.setup();
      const s = await sealed(env);
      await expectCode(env.agent.openMarket(s.ref), ErrorCode.WrongStatus);
      await env.advanceTo(s.sealTs + 1n);
      await env.agent.revealCall(s.ref, s.call, SALT);
      await env.advanceTo(s.call.expiryTs - params.tradeCutoffSecs);
      await expectCode(env.agent.openMarket(s.ref), ErrorCode.TradingClosed);
    });

    it("rejects zero trades and trades after the cutoff", async () => {
      const env = await harness.setup();
      const s = await revealed(env);
      const m = (await env.trader.openMarket(s.ref)).value;
      await env.fund(env.traderKey, 1_000n);
      await expectCode(env.trader.trade(m, Side.Yes, 0n, 0n), ErrorCode.InvalidAmount);
      await env.advanceTo(s.call.expiryTs - params.tradeCutoffSecs);
      await expectCode(env.trader.trade(m, Side.Yes, 10n, 0n), ErrorCode.TradingClosed);
      expect(await env.balanceOf(env.traderKey)).toBe(1_000n);
    });

    it("rejects settlement before expiry, outside the window, or with wide confidence", async () => {
      const env = await harness.setup();
      const s = await revealed(env);
      await expectCode(
        env.agent.settle(s.ref, await env.oracle(obs(s.call, 200_000_000n))),
        ErrorCode.NotExpired,
      );
      await env.advanceTo(s.call.expiryTs + params.settleWindowSecs + 5n);
      const late = obs(s.call, 200_000_000n, 0n, s.call.expiryTs + params.settleWindowSecs + 1n);
      await expectCode(
        env.agent.settle(s.ref, await env.oracle(late)),
        ErrorCode.ObservationOutsideWindow,
      );
      const wide = obs(s.call, 200_000_000n, 2_000_000n); // 1% > 50 bps default
      await expectCode(
        env.agent.settle(s.ref, await env.oracle(wide)),
        ErrorCode.ConfidenceTooWide,
      );
      expect(await status(env, s.ref)).toBe(CallStatus.Revealed);
    });

    it("settles a HIT once; a second settle cannot change it", async () => {
      const env = await harness.setup();
      const s = await revealed(env);
      await env.advanceTo(s.call.expiryTs + 1n);
      const tx = await env.trader.settle(
        s.ref,
        await env.oracle(obs(s.call, 100_500_000n, 100_000n)),
      );
      expect(tx.value).toBe(Outcome.Hit);
      await expectCode(
        env.trader.settle(s.ref, await env.oracle(obs(s.call, 1n))),
        ErrorCode.AlreadySettled,
      );
      expect((await env.agent.getCall(s.ref))?.state.outcome).toBe(Outcome.Hit);
    });

    it("settles a MISS when the confidence interval touches the level", async () => {
      const env = await harness.setup();
      const s = await revealed(env, Direction.Above);
      await env.advanceTo(s.call.expiryTs);
      const tx = await env.agent.settle(
        s.ref,
        await env.oracle(obs(s.call, 100_100_000n, 100_000n)),
      );
      expect(tx.value).toBe(Outcome.Miss);
    });

    it("pays winners, pays losers nothing, and redeems once", async () => {
      const env = await harness.setup();
      const s = await revealed(env);
      const m = (await env.agent.openMarket(s.ref)).value;
      await env.fund(env.traderKey, 300n);
      await env.fund(env.agentKey, 100n);
      await env.trader.trade(m, Side.No, 300n, 0n);
      await env.agent.trade(m, Side.Yes, 100n, 0n);
      await expectCode(env.trader.redeem(m), ErrorCode.NotRedeemable);
      await env.advanceTo(s.call.expiryTs);
      await env.agent.settle(s.ref, await env.oracle(obs(s.call, 90_000_000n)));
      expect((await env.trader.redeem(m)).value).toBe(400n);
      expect((await env.agent.redeem(m)).value).toBe(0n);
      await expectCode(env.trader.redeem(m), ErrorCode.NothingToRedeem);
      expect(await env.balanceOf(env.traderKey)).toBe(400n);
      expect(await env.balanceOf(env.agentKey)).toBe(0n);
    });

    it("voids an unsettled call after voidAfter and refunds stakes", async () => {
      const env = await harness.setup();
      const s = await revealed(env);
      const m = (await env.trader.openMarket(s.ref)).value;
      await env.fund(env.traderKey, 50n);
      await env.trader.trade(m, Side.Yes, 50n, 0n);
      await env.advanceTo(s.call.expiryTs + params.voidAfterSecs - 1n);
      await expectCode(env.trader.voidUnsettled(s.ref), ErrorCode.VoidTooEarly);
      await env.advanceTo(s.call.expiryTs + params.voidAfterSecs);
      await expectCode(
        env.trader.settle(s.ref, await env.oracle(obs(s.call, 200_000_000n))),
        ErrorCode.SettlementWindowClosed,
      );
      await env.trader.voidUnsettled(s.ref);
      expect(await status(env, s.ref)).toBe(CallStatus.Void);
      expect((await env.trader.redeem(m)).value).toBe(50n);
      expect(await env.balanceOf(env.traderKey)).toBe(50n);
    });

    it("lists only the given agent's calls", async () => {
      const env = await harness.setup();
      const s = await sealed(env);
      const mine = await env.agent.listCalls(env.agentKey);
      expect(mine.map((r) => r.ref.id)).toContain(s.ref.id);
      expect(await env.agent.listCalls(env.traderKey)).toHaveLength(0);
    });
  });
}
