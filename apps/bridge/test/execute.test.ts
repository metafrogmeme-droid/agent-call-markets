// executePlan against the core's in-memory chain (MemoryAdapter): no keys, no signing, no network.
// The same function works with any ChainAdapter; a Solana signer is out of scope for M5.
import { describe, expect, it } from "vitest";
import {
  bytes32,
  bytesToHex,
  CallStatus,
  CoreError,
  ErrorCode,
  MemoryAdapter,
  MemoryWorld,
  SEAL_VERSION_V1,
  type Bytes32,
  type CallRef,
  type RandomSource,
  type Tx,
} from "@agent-call-markets/core";
import { executePlan, type ExecuteOptions } from "../src/execute.ts";
import { SkipReason } from "../src/journal.ts";
import { MemoryLedger, MemorySaltStore, type Ledger } from "../src/ledger.ts";
import { parseIdMap } from "../src/maps.ts";
import { planBridge, type PlanInput } from "../src/plan.ts";
import { AGENT_1, AGENTS_JSON, FEEDS_JSON, JOURNAL, NOW, PARAMS, unix } from "./helpers.ts";

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  journal: JOURNAL,
  agents: parseIdMap(AGENTS_JSON, "agents"),
  feeds: parseIdMap(FEEDS_JSON, "feeds"),
  now: NOW,
  params: PARAMS,
  ...over,
});

/** MemoryAdapter with hooks around sealCall, to simulate lost responses and crashes. */
class HookedAdapter extends MemoryAdapter {
  before: (() => void) | null = null;
  after: (() => void) | null = null;
  seals = 0;

  override async sealCall(c: {
    readonly commitment: Bytes32;
    readonly expiryTs: bigint;
  }): Promise<Tx<CallRef>> {
    this.before?.();
    const tx = await super.sealCall(c);
    this.seals++;
    this.after?.();
    return tx;
  }
}

function setup(signer: Bytes32 | null = AGENT_1) {
  const world = new MemoryWorld(PARAMS, NOW);
  const adapter = new HookedAdapter(world, signer);
  const ledger: Ledger = new MemoryLedger();
  const salts = new MemorySaltStore();
  const opts: ExecuteOptions = {
    adapter,
    agentKey: AGENT_1,
    ledger,
    salts,
    now: () => world.now,
  };
  return { world, adapter, ledger, salts, opts };
}

describe("executePlan", () => {
  it("seals only this agent's intents, and stores salt + ledger before sending", async () => {
    const { adapter, ledger, salts, opts } = setup();
    let checkedBeforeSend = false;
    adapter.before = () => {
      const rec = ledger.get("FAKE-0001");
      expect(rec?.status).toBe("pending");
      expect(salts.get(rec?.commitment ?? "")).toBeDefined();
      checkedBeforeSend = true;
    };
    const report = await executePlan(planBridge(input()), opts);
    expect(checkedBeforeSend).toBe(true);
    expect(report.chainId).toBe("memory:test");
    expect(report.sealed.map((s) => [s.entryId, s.recovered])).toEqual([["FAKE-0001", false]]);
    expect(report.skipped).toEqual([
      expect.objectContaining({ entryId: "FAKE-0002", reason: SkipReason.NotThisAgent }),
    ]);
    expect(report.rejected).toEqual([]);
    expect(ledger.get("FAKE-0001")).toMatchObject({
      status: "sealed",
      callRef: report.sealed[0]?.callRef,
    });
    expect(ledger.get("FAKE-0002")).toBeUndefined();
  });

  it("the stored salt opens the sealed commitment (the call can be revealed)", async () => {
    const { world, adapter, salts, opts } = setup();
    const report = await executePlan(planBridge(input()), opts);
    const sealed = report.sealed[0];
    if (sealed === undefined) throw new Error("sealed");
    const rec = salts.get(sealed.commitment);
    if (rec === undefined) throw new Error("salt");
    world.now = NOW + 1n;
    await adapter.revealCall(
      sealed.callRef,
      {
        version: SEAL_VERSION_V1,
        agent: bytes32(rec.agent),
        feedId: bytes32(rec.feedId),
        direction: rec.direction,
        level: { mantissa: BigInt(rec.levelMantissa), expo: rec.levelExpo },
        expiryTs: BigInt(rec.expiryTs),
      },
      bytes32(rec.salt),
    );
    expect((await adapter.getCall(sealed.callRef))?.state.status).toBe(CallStatus.Revealed);
  });

  it("a re-run sends nothing", async () => {
    const { adapter, ledger, opts } = setup();
    await executePlan(planBridge(input()), opts);
    const again = planBridge(input({ ledger }));
    // FAKE-0001 is in the ledger now; FAKE-0002 belongs to another agent and was never sealed.
    expect(again.intents.map((i) => i.entryId)).toEqual(["FAKE-0002"]);
    const report = await executePlan(again, opts);
    expect(report.sealed).toEqual([]);
    expect(report.skipped.map((s) => s.reason)).toEqual([SkipReason.NotThisAgent]);
    expect(adapter.seals).toBe(1);
  });

  it("a chain rejection is final: recorded, reported, never retried", async () => {
    const { world, adapter, ledger, opts } = setup();
    const plan = planBridge(input());
    world.now = unix("2026-12-01T17:00:01Z"); // less than minLead before FAKE-0001's expiry
    const report = await executePlan(plan, opts);
    expect(report.rejected).toEqual([
      expect.objectContaining({ entryId: "FAKE-0001", code: ErrorCode.ExpiryTooSoon }),
    ]);
    expect(ledger.get("FAKE-0001")).toMatchObject({
      status: "rejected",
      code: ErrorCode.ExpiryTooSoon,
    });
    expect(planBridge(input({ ledger })).skipped.find((s) => s.line === 1)?.reason).toBe(
      SkipReason.AlreadyProcessed,
    );
    expect(adapter.seals).toBe(0);
  });

  it("recovers a seal whose response was lost, without sealing twice", async () => {
    const { world, adapter, ledger, opts } = setup();
    adapter.after = () => {
      throw new Error("connection reset after send");
    };
    await expect(executePlan(planBridge(input()), opts)).rejects.toThrow(/connection reset/);
    expect(ledger.get("FAKE-0001")?.status).toBe("pending");
    adapter.after = null;
    const resumed = planBridge(input({ ledger, now: NOW + 60n }));
    expect(resumed.intents[0]?.resume).toBe(true);
    const report = await executePlan(resumed, opts);
    expect(report.sealed.map((s) => [s.entryId, s.recovered])).toEqual([["FAKE-0001", true]]);
    expect(adapter.seals).toBe(1);
    expect(await adapter.listCalls(AGENT_1)).toHaveLength(1);
    expect(ledger.get("FAKE-0001")?.status).toBe("sealed");
    expect(world.now).toBe(NOW);
  });

  it("re-sends with the same salt when the run died before sending, while still fresh", async () => {
    const { adapter, ledger, salts, opts } = setup();
    adapter.before = () => {
      throw new Error("crashed before send");
    };
    await expect(executePlan(planBridge(input()), opts)).rejects.toThrow(/crashed/);
    const commitment = ledger.get("FAKE-0001")?.commitment;
    adapter.before = null;
    const report = await executePlan(planBridge(input({ ledger })), opts);
    expect(report.sealed[0]).toMatchObject({ entryId: "FAKE-0001", commitment, recovered: true });
    expect(salts.size()).toBe(1);
    expect(adapter.seals).toBe(1);
  });

  it("does not re-send a pending entry that has gone stale", async () => {
    const { world, adapter, ledger, opts } = setup();
    adapter.before = () => {
      throw new Error("crashed before send");
    };
    await expect(executePlan(planBridge(input()), opts)).rejects.toThrow();
    adapter.before = null;
    world.now = NOW + 7200n;
    const report = await executePlan(planBridge(input({ ledger, now: world.now })), opts);
    expect(report.sealed).toEqual([]);
    expect(report.rejected[0]).toMatchObject({ entryId: "FAKE-0001" });
    expect(report.rejected[0]?.detail).toMatch(/stale/);
    expect(ledger.get("FAKE-0001")?.status).toBe("rejected");
    expect(adapter.seals).toBe(0);
  });

  it("client-side failures are not chain rejections: the run stops and the entry stays pending", async () => {
    const { ledger, opts } = setup(null); // read-only adapter
    await expect(executePlan(planBridge(input()), opts)).rejects.toSatisfy(
      (e: unknown) => e instanceof CoreError && e.code === ErrorCode.ReadOnly,
    );
    expect(ledger.get("FAKE-0001")?.status).toBe("pending");
  });

  it("never seals twice when an older plan is executed after another run sealed the entry", async () => {
    const { adapter, opts } = setup();
    const plan = planBridge(input());
    await executePlan(plan, opts);
    const second = await executePlan(plan, opts); // the same, now outdated, plan
    expect(second.sealed).toEqual([]);
    expect(second.skipped.map((s) => [s.entryId, s.reason])).toEqual([
      ["FAKE-0001", SkipReason.AlreadyProcessed],
      ["FAKE-0002", SkipReason.NotThisAgent],
    ]);
    expect(adapter.seals).toBe(1);
  });

  it("refuses to resume without a matching pending record, a missing salt, or a tampered salt", async () => {
    const crash = () => {
      throw new Error("crashed before send");
    };
    // Resume intent but the ledger no longer holds the pending record.
    {
      const { adapter, ledger, opts } = setup();
      adapter.before = crash;
      await expect(executePlan(planBridge(input()), opts)).rejects.toThrow();
      const resumed = planBridge(input({ ledger }));
      adapter.before = null;
      const report = await executePlan(resumed, { ...opts, ledger: new MemoryLedger() });
      expect(report.skipped[0]).toMatchObject({
        entryId: "FAKE-0001",
        reason: SkipReason.LedgerConflict,
      });
      expect(adapter.seals).toBe(0);
    }
    // The salt was lost: nothing can be re-sent; recorded as rejected.
    {
      const { adapter, ledger, opts } = setup();
      adapter.before = crash;
      await expect(executePlan(planBridge(input()), opts)).rejects.toThrow();
      adapter.before = null;
      const report = await executePlan(planBridge(input({ ledger })), {
        ...opts,
        salts: new MemorySaltStore(),
      });
      expect(report.rejected[0]?.detail).toMatch(/salt is missing/);
      expect(adapter.seals).toBe(0);
    }
    // The stored salt no longer opens the commitment: refuse loudly.
    {
      const { adapter, ledger, salts, opts } = setup();
      adapter.before = crash;
      await expect(executePlan(planBridge(input()), opts)).rejects.toThrow();
      adapter.before = null;
      const commitment = ledger.get("FAKE-0001")?.commitment ?? "";
      const original = salts.get(commitment);
      if (original === undefined) throw new Error("salt");
      const tampered = new MemorySaltStore();
      tampered.put({ ...original, levelMantissa: "99999" });
      await expect(
        executePlan(planBridge(input({ ledger })), { ...opts, salts: tampered }),
      ).rejects.toSatisfy(
        (e: unknown) => e instanceof CoreError && e.code === ErrorCode.CommitmentMismatch,
      );
      expect(adapter.seals).toBe(0);
    }
  });

  it("draws salts from the injected CSPRNG source", async () => {
    const { salts, opts } = setup();
    const fixed: RandomSource = {
      getRandomValues: <T extends Uint8Array>(a: T): T => {
        a.fill(0x7e);
        return a;
      },
    };
    const report = await executePlan(planBridge(input()), { ...opts, random: fixed });
    expect(salts.get(report.sealed[0]?.commitment ?? "")?.salt).toBe(
      bytesToHex(new Uint8Array(32).fill(0x7e)),
    );
  });
});
