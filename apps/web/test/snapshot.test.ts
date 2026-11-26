import { describe, expect, it } from "vitest";
import { CoreError, ErrorCode, MemoryAdapter } from "@agent-call-markets/core";
import { decodeSnapshot, encodeSnapshot, SNAPSHOT_SCHEMA } from "../src/snapshot.ts";
import { collectFromAdapter, type RecordData } from "../src/source.ts";
import { AGENT_1, AGENT_2, makeWorld, NOW, PARAMS } from "./world.ts";

async function data(): Promise<RecordData> {
  const { world } = await makeWorld();
  return collectFromAdapter(new MemoryAdapter(world, null), {
    agents: [
      { label: "FAKE-AGENT-1", id: AGENT_1 },
      { label: "FAKE-AGENT-2", id: AGENT_2 },
    ],
    now: NOW,
    params: PARAMS,
    source: "memory:test",
    synthetic: true,
  });
}

describe("record data from a read-only ChainAdapter", () => {
  it("collects every call of each listed agent", async () => {
    const d = await data();
    expect(d.calls.filter((c) => c.state.agent.every((b, i) => b === AGENT_1[i]))).toHaveLength(6);
    expect(d.calls).toHaveLength(7);
    expect(d).toMatchObject({ source: "memory:test", synthetic: true, takenAt: NOW });
  });
});

describe("snapshot codec (acm-record-snapshot/v1)", () => {
  it("round-trips exactly", async () => {
    const d = await data();
    const text = encodeSnapshot(d);
    expect(JSON.parse(text)).toMatchObject({ schema: SNAPSHOT_SCHEMA, synthetic: true });
    expect(decodeSnapshot(text)).toEqual(d);
    expect(encodeSnapshot(decodeSnapshot(text))).toBe(text);
  });

  it("refuses anything malformed", async () => {
    const good = JSON.parse(encodeSnapshot(await data())) as Record<string, unknown>;
    const calls = good["calls"] as Record<string, Record<string, unknown>>[];
    const firstState = calls[0]?.["state"] ?? {};
    const variants: unknown[] = [
      "not json",
      [],
      { ...good, schema: "acm-record-snapshot/v9" },
      { ...good, synthetic: "yes" },
      { ...good, takenAt: "soon" },
      { ...good, agents: [{ label: "X", id: "zz" }] },
      { ...good, params: { ...(good["params"] as object), minLeadSecs: "1" } },
      { ...good, calls: [{ id: "x", state: { ...firstState, status: "MAYBE" } }] },
      { ...good, calls: [{ id: "x", state: { ...firstState, agent: "00" } }] },
      { ...good, calls: [{ id: 3, state: firstState }] },
      { ...good, calls: [{ id: "x" }] },
    ];
    for (const v of variants) {
      const text = typeof v === "string" ? v : JSON.stringify(v);
      expect(() => decodeSnapshot(text), text.slice(0, 80)).toThrow(CoreError);
      try {
        decodeSnapshot(text);
      } catch (e) {
        expect((e as CoreError).code).toBe(ErrorCode.InvalidParams);
      }
    }
  });
});
