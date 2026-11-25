import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  computeAgentRecord,
  MemoryAdapter,
  Outcome,
  RecordStatus,
} from "@agent-call-markets/core";
import { buildModel } from "../src/model.ts";
import { collectFromAdapter, type RecordData } from "../src/source.ts";
import { AGENT_1, AGENT_2, makeWorld, NOW, PARAMS } from "./world.ts";

async function setup() {
  const w = await makeWorld();
  const data = await collectFromAdapter(new MemoryAdapter(w.world, null), {
    agents: [
      { label: "FAKE-AGENT-1", id: AGENT_1 },
      { label: "FAKE-AGENT-2", id: AGENT_2 },
    ],
    now: NOW,
    params: PARAMS,
    source: "memory:test",
    synthetic: true,
  });
  return { ...w, data };
}

describe("site model", () => {
  it("computes each agent's record with the core, from chain data only", async () => {
    const { data } = await setup();
    const model = buildModel(data);
    const a1 = model.agents.find((a) => a.label === "FAKE-AGENT-1");
    expect(a1?.record).toEqual(
      computeAgentRecord(
        AGENT_1,
        data.calls.map((c) => c.state),
        NOW,
      ),
    );
    expect(a1?.record).toMatchObject({
      sealed: 6,
      revealed: 4,
      pending: 2,
      hits: 1,
      misses: 2,
      unrevealedMisses: 1,
      voids: 1,
      selfTradedCalls: 1,
      sampleSize: 3,
    });
    expect(a1?.summary).toBe("33.3% hit rate (1 of 3 decided; 1 void)");
    expect(a1?.id).toBe(bytesToHex(AGENT_1));
    expect(model.agents.find((a) => a.label === "FAKE-AGENT-2")?.summary).toBe(
      "100.0% hit rate (1 of 1 decided; 0 voids)",
    );
  });

  it("describes each call: status, hidden fields until reveal, self-trades, outcome re-check", async () => {
    const { data, refs } = await setup();
    const a1 = buildModel(data).agents.find((a) => a.label === "FAKE-AGENT-1");
    const row = (id: string) => a1?.calls.find((c) => c.id === id);
    expect(row(refs.pendingReveal.id)).toMatchObject({
      status: RecordStatus.PendingReveal,
      revealed: null,
    });
    expect(row(refs.unrevealed.id)).toMatchObject({
      status: RecordStatus.UnrevealedMiss,
      revealed: null,
    });
    expect(row(refs.pendingOutcome.id)).toMatchObject({
      status: RecordStatus.PendingOutcome,
      revealed: { direction: "above", level: "101.000000" },
      outcomeCheck: "n/a",
    });
    expect(row(refs.hit.id)).toMatchObject({
      status: RecordStatus.Hit,
      outcome: Outcome.Hit,
      coreOutcome: Outcome.Hit,
      outcomeCheck: "match",
      selfTraded: true,
      observation: { price: "110.000000" },
    });
    expect(row(refs.miss.id)).toMatchObject({
      status: RecordStatus.Miss,
      outcomeCheck: "match",
      selfTraded: false,
    });
    expect(row(refs.void.id)).toMatchObject({ status: RecordStatus.Void, outcome: null });
    expect(a1?.calls.map((c) => c.sealTs)).toEqual(
      [...(a1?.calls.map((c) => c.sealTs) ?? [])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
    );
    expect(a1?.mismatches).toBe(0);
  });

  it("flags an on-chain outcome that disagrees with the core rule", async () => {
    const { data, refs } = await setup();
    const tampered: RecordData = {
      ...data,
      calls: data.calls.map((c) =>
        c.id === refs.hit.id ? { ...c, state: { ...c.state, outcome: Outcome.Miss } } : c,
      ),
    };
    const a1 = buildModel(tampered).agents.find((a) => a.label === "FAKE-AGENT-1");
    expect(a1?.calls.find((c) => c.id === refs.hit.id)).toMatchObject({
      outcome: Outcome.Miss,
      coreOutcome: Outcome.Hit,
      outcomeCheck: "mismatch",
    });
    expect(a1?.mismatches).toBe(1);
  });

  it("lists agents by label, never by hit rate, and ignores calls of unlisted agents", async () => {
    const { data } = await setup();
    const relabelled: RecordData = {
      ...data,
      agents: [
        { label: "Zeta", id: AGENT_2 },
        { label: "Alpha", id: AGENT_1 },
      ],
    };
    expect(buildModel(relabelled).agents.map((a) => a.label)).toEqual(["Alpha", "Zeta"]);
    const onlyOne: RecordData = { ...data, agents: [{ label: "Alpha", id: AGENT_1 }] };
    const m = buildModel(onlyOne);
    expect(m.agents).toHaveLength(1);
    expect(m.agents[0]?.calls).toHaveLength(6);
    expect(m).toMatchObject({ source: "memory:test", synthetic: true, takenAt: NOW });
  });
});
