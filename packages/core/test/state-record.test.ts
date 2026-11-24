import { describe, expect, it } from "vitest";
import {
  bytes32,
  CallStatus,
  commitmentOf,
  computeAgentRecord,
  ErrorCode,
  formatHitRate,
  openMarket,
  Outcome,
  placeTrade,
  recordStatus,
  RecordStatus,
  redeem,
  revealCall,
  sealCall,
  settleCall,
  Side,
  voidCall,
  type CallState,
  type Result,
} from "../src/index.ts";
import { AGENT, makeCall, makeObs, OTHER, OTHER_FEED, PARAMS, SALT, T0 } from "./fixtures.ts";

function must<T>(r: Result<T>): T {
  if (!r.ok) throw r.error;
  return r.value;
}

function code<T>(r: Result<T>): string | undefined {
  return r.ok ? undefined : r.error.code;
}

const call = makeCall();
const expiry = call.expiryTs;

function sealedState(): CallState {
  return must(
    sealCall({ agent: AGENT, commitment: commitmentOf(call, SALT), expiryTs: expiry }, T0, PARAMS),
  );
}

function revealedState(): CallState {
  return must(revealCall(sealedState(), { signer: AGENT, call, salt: SALT }, T0 + 1n, PARAMS));
}

function settled(price: bigint): CallState {
  return must(settleCall(revealedState(), makeObs({ price, publishTime: expiry }), expiry, PARAMS));
}

describe("sealCall", () => {
  it("rejects zero agent and zero commitment", () => {
    const zero = bytes32(new Uint8Array(32));
    expect(
      code(
        sealCall(
          { agent: zero, commitment: commitmentOf(call, SALT), expiryTs: expiry },
          T0,
          PARAMS,
        ),
      ),
    ).toBe(ErrorCode.ZeroAgent);
    expect(code(sealCall({ agent: AGENT, commitment: zero, expiryTs: expiry }, T0, PARAMS))).toBe(
      ErrorCode.ZeroCommitment,
    );
  });

  it("accepts exactly the minimum lead and the maximum horizon", () => {
    const c = commitmentOf(call, SALT);
    expect(
      sealCall({ agent: AGENT, commitment: c, expiryTs: T0 + PARAMS.minLeadSecs }, T0, PARAMS).ok,
    ).toBe(true);
    expect(
      sealCall({ agent: AGENT, commitment: c, expiryTs: T0 + PARAMS.maxHorizonSecs }, T0, PARAMS)
        .ok,
    ).toBe(true);
  });
});

describe("revealCall", () => {
  it("rejects a mismatched agent or expiry inside the preimage", () => {
    const s = sealedState();
    const otherAgentCall = makeCall({ agent: OTHER });
    expect(
      code(revealCall(s, { signer: AGENT, call: otherAgentCall, salt: SALT }, T0 + 1n, PARAMS)),
    ).toBe(ErrorCode.AgentMismatch);
    const otherExpiry = makeCall({ expiryTs: expiry + 1n });
    expect(
      code(revealCall(s, { signer: AGENT, call: otherExpiry, salt: SALT }, T0 + 1n, PARAMS)),
    ).toBe(ErrorCode.ExpiryMismatch);
  });

  it("rejects a matching commitment to a call that fails validation (feed not allowed)", () => {
    const bad = makeCall({ feedId: OTHER_FEED });
    const s = must(
      sealCall({ agent: AGENT, commitment: commitmentOf(bad, SALT), expiryTs: expiry }, T0, PARAMS),
    );
    expect(code(revealCall(s, { signer: AGENT, call: bad, salt: SALT }, T0 + 1n, PARAMS))).toBe(
      ErrorCode.FeedNotAllowed,
    );
  });

  it("accepts a reveal exactly at the deadline, and cannot reveal twice", () => {
    const s = sealedState();
    const r = must(revealCall(s, { signer: AGENT, call, salt: SALT }, s.revealDeadlineTs, PARAMS));
    expect(r.status).toBe(CallStatus.Revealed);
    expect(r.salt).toEqual(SALT);
    expect(
      code(revealCall(r, { signer: AGENT, call, salt: SALT }, s.revealDeadlineTs, PARAMS)),
    ).toBe(ErrorCode.WrongStatus);
  });
});

describe("market and settlement transitions", () => {
  it("cannot open twice; trade needs an open market and a non-zero trader", () => {
    const r = revealedState();
    expect(
      code(
        placeTrade(
          r,
          { owner: OTHER, side: Side.Yes, amount: 1n, minProjectedPayout: 0n },
          T0 + 2n,
          PARAMS,
        ),
      ),
    ).toBe(ErrorCode.MarketNotOpen);
    const m = must(openMarket(r, T0 + 2n, PARAMS));
    expect(code(openMarket(m, T0 + 3n, PARAMS))).toBe(ErrorCode.MarketAlreadyOpen);
    const zero = bytes32(new Uint8Array(32));
    expect(
      code(
        placeTrade(
          m,
          { owner: zero, side: Side.Yes, amount: 1n, minProjectedPayout: 0n },
          T0 + 3n,
          PARAMS,
        ),
      ),
    ).toBe(ErrorCode.WrongSigner);
  });

  it("accumulates stakes per (owner, side) and enforces the payout limit", () => {
    let m = must(openMarket(revealedState(), T0 + 2n, PARAMS));
    m = must(
      placeTrade(
        m,
        { owner: OTHER, side: Side.Yes, amount: 10n, minProjectedPayout: 10n },
        T0 + 3n,
        PARAMS,
      ),
    );
    m = must(
      placeTrade(
        m,
        { owner: OTHER, side: Side.Yes, amount: 5n, minProjectedPayout: 0n },
        T0 + 4n,
        PARAMS,
      ),
    );
    m = must(
      placeTrade(
        m,
        { owner: AGENT, side: Side.No, amount: 15n, minProjectedPayout: 0n },
        T0 + 5n,
        PARAMS,
      ),
    );
    expect(m.market?.positions).toHaveLength(2);
    expect(m.market?.pool).toEqual({ yes: 15n, no: 15n });
    // Buying 15 more YES: projected 15 * 45 / 30 = 22; a limit of 23 fails.
    expect(
      code(
        placeTrade(
          m,
          { owner: OTHER, side: Side.Yes, amount: 15n, minProjectedPayout: 23n },
          T0 + 6n,
          PARAMS,
        ),
      ),
    ).toBe(ErrorCode.LimitNotMet);
  });

  it("cannot trade on a settled market", () => {
    let m = must(openMarket(revealedState(), T0 + 2n, PARAMS));
    m = must(settleCall(m, makeObs({ publishTime: expiry }), expiry, PARAMS));
    expect(
      code(
        placeTrade(
          m,
          { owner: OTHER, side: Side.Yes, amount: 1n, minProjectedPayout: 0n },
          T0 + 3n,
          PARAMS,
        ),
      ),
    ).toBe(ErrorCode.TradingClosed);
  });

  it("an unrevealed call can be neither settled nor voided", () => {
    const s = sealedState();
    expect(code(settleCall(s, makeObs(), expiry, PARAMS))).toBe(ErrorCode.WrongStatus);
    expect(code(voidCall(s, expiry + PARAMS.voidAfterSecs, PARAMS))).toBe(ErrorCode.WrongStatus);
  });

  it("rejects observations from the future and decision errors", () => {
    const r = revealedState();
    expect(code(settleCall(r, makeObs({ publishTime: expiry + 5n }), expiry + 1n, PARAMS))).toBe(
      ErrorCode.ObservationOutsideWindow,
    );
    expect(
      code(settleCall(r, makeObs({ feedId: OTHER_FEED, publishTime: expiry }), expiry, PARAMS)),
    ).toBe(ErrorCode.FeedMismatch);
  });

  it("settled and void are final", () => {
    const hit = settled(101_000_000n);
    expect(hit.outcome).toBe(Outcome.Hit);
    expect(code(voidCall(hit, expiry + PARAMS.voidAfterSecs, PARAMS))).toBe(
      ErrorCode.AlreadySettled,
    );
    const v = must(voidCall(revealedState(), expiry + PARAMS.voidAfterSecs, PARAMS));
    expect(code(voidCall(v, expiry + PARAMS.voidAfterSecs, PARAMS))).toBe(ErrorCode.AlreadyVoid);
    expect(code(settleCall(v, makeObs(), expiry + 1n, PARAMS))).toBe(ErrorCode.AlreadyVoid);
  });

  it("redeem needs a market and a final state", () => {
    expect(code(redeem(settled(101_000_000n), OTHER))).toBe(ErrorCode.NotRedeemable);
    const open = must(openMarket(revealedState(), T0 + 2n, PARAMS));
    expect(code(redeem(open, OTHER))).toBe(ErrorCode.NotRedeemable);
  });
});

describe("record maths", () => {
  const now = expiry + 100n;

  it("counts hits, settled misses, unrevealed misses, voids and pending calls", () => {
    const states: CallState[] = [
      settled(101_000_000n), // hit
      settled(99_000_000n), // miss
      sealedState(), // unrevealed past deadline at `now` -> miss
      must(voidCall(revealedState(), expiry + PARAMS.voidAfterSecs, PARAMS)), // void
      revealedState(), // pending outcome
      must(
        sealCall(
          {
            agent: AGENT,
            commitment: bytes32("77".repeat(32)),
            expiryTs: now + PARAMS.minLeadSecs,
          },
          now,
          PARAMS,
        ),
      ), // pending reveal
      must(
        sealCall(
          { agent: OTHER, commitment: bytes32("88".repeat(32)), expiryTs: expiry },
          T0,
          PARAMS,
        ),
      ), // other agent
    ];
    const rec = computeAgentRecord(AGENT, states, now);
    expect(rec).toMatchObject({
      sealed: 6,
      revealed: 4,
      pending: 2,
      hits: 1,
      misses: 2,
      unrevealedMisses: 1,
      voids: 1,
      selfTradedCalls: 0,
      sampleSize: 3,
    });
    expect(rec.hitRate).toEqual({ num: 1n, den: 3n });
    expect(formatHitRate(rec)).toBe("33.3% hit rate (1 of 3 decided; 1 void)");
  });

  it("an unrevealed call is pending before its deadline and a miss after", () => {
    const s = sealedState();
    expect(recordStatus(s, s.revealDeadlineTs)).toBe(RecordStatus.PendingReveal);
    expect(recordStatus(s, s.revealDeadlineTs + 1n)).toBe(RecordStatus.UnrevealedMiss);
  });

  it("flags self-trades without changing the hit rate", () => {
    let m = must(openMarket(revealedState(), T0 + 2n, PARAMS));
    m = must(
      placeTrade(
        m,
        { owner: AGENT, side: Side.Yes, amount: 5n, minProjectedPayout: 0n },
        T0 + 3n,
        PARAMS,
      ),
    );
    m = must(settleCall(m, makeObs({ price: 99_000_000n, publishTime: expiry }), expiry, PARAMS));
    const rec = computeAgentRecord(AGENT, [m], now);
    expect(rec.selfTradedCalls).toBe(1);
    expect(rec.hitRate).toEqual({ num: 0n, den: 1n });
  });

  it("reports no rate when nothing is decided, and rounds the percentage down", () => {
    const empty = computeAgentRecord(AGENT, [], now);
    expect(empty.hitRate).toBeNull();
    expect(formatHitRate(empty)).toBe("no decided calls yet (0 decided; 0 voids)");
    const twoThirds = computeAgentRecord(
      AGENT,
      [settled(101_000_000n), settled(102_000_000n), settled(1n)],
      now,
    );
    expect(formatHitRate(twoThirds)).toBe("66.6% hit rate (2 of 3 decided; 0 voids)");
  });
});
