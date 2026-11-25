// Regenerates fixtures/snapshot-fake.json from the synthetic in-memory world in test/world.ts.
// Fake agents and synthetic feed ids only; a test checks the committed file matches.
import { writeFileSync } from "node:fs";
import { MemoryAdapter } from "@agent-call-markets/core";
import { encodeSnapshot } from "../src/snapshot.ts";
import { collectFromAdapter } from "../src/source.ts";
import { AGENT_1, AGENT_2, makeWorld, NOW, PARAMS } from "../test/world.ts";

const { world } = await makeWorld();
const data = await collectFromAdapter(new MemoryAdapter(world, null), {
  agents: [
    { label: "FAKE-AGENT-1", id: AGENT_1 },
    { label: "FAKE-AGENT-2", id: AGENT_2 },
  ],
  now: NOW,
  params: PARAMS,
  source: "memory:test",
  synthetic: true,
});
const path = new URL("../fixtures/snapshot-fake.json", import.meta.url).pathname;
writeFileSync(path, encodeSnapshot(data));
process.stdout.write(`wrote ${path}\n`);
