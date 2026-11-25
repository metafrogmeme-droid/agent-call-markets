// The shared ChainAdapter conformance suite (packages/core/src/testing/conformance.ts), run against
// SolanaAdapter -> compiled call_markets SBF binary in LiteSVM. The same suite runs against the
// core's MemoryAdapter, so both implementations show the same behaviour and error codes.
import { runAdapterConformance } from "@agent-call-markets/core/testing";
import { addressFromBytes32 } from "../../src/adapter.ts";
import { FEED, keyOf, makeWorld, PARAMS } from "./harness.ts";

runAdapterConformance("SolanaAdapter (LiteSVM, SBF binary)", {
  params: PARAMS,
  feedId: FEED,
  async setup() {
    const w = await makeWorld();
    const agentSigner = await w.newSigner();
    const traderSigner = await w.newSigner();
    return {
      agent: await w.adapter(agentSigner),
      agentKey: keyOf(agentSigner),
      trader: await w.adapter(traderSigner),
      traderKey: keyOf(traderSigner),
      now: () => w.transport.getUnixTimestamp(),
      advanceTo: (ts) => {
        w.advanceTo(ts);
        return Promise.resolve();
      },
      fund: async (owner, amount) => {
        await w.admin.mintTestTokens(w.mint, addressFromBytes32(owner), amount);
      },
      balanceOf: (owner) => w.admin.tokenBalance(addressFromBytes32(owner)),
      oracle: (observation) => w.putPrice(observation),
    };
  },
});
