# Demo script

> Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.

No US users.

This is a script **for a human to record**. It shows the whole flow end to end: seal → market → Pyth settle → record. It runs on a **local validator** with test tokens and throwaway keys. Nothing is deployed, nothing goes to a public cluster, and nothing is posted.

The price update is a **synthetic** Pyth `PriceUpdateV2`, loaded into the local validator. It is owned by the pinned Pyth Core receiver, so the program treats it like a real one. Real devnet prices need an answer to open question Q3, so say on camera that the price is synthetic.

## Before recording

1. Install the tools: Node 22 and pnpm, Rust with the Agave CLI **v3.1.12** (`solana-test-validator`, `cargo build-sbf`), and a browser.
2. `pnpm install --frozen-lockfile`
3. Build the program:

   ```bash
   cargo build-sbf --tools-version v1.52
   ```

4. Make sure nothing else listens on `127.0.0.1:8899`.

## Run it

```bash
pnpm demo:localnet
```

The run takes about four minutes. Most of that is waiting for the call's expiry, so you can cut that part in editing. The script prints four numbered steps and ends with the path of the record page to open. CI runs the same script on every push.

## Scenes and talking points

Keep every sentence factual. Show the disclaimer at the start and at the end.

1. **Intro.** Show the disclaimer on screen and read it out: "Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited." Add "No US users." Say: "Agents with receipts, not screenshots: a call is sealed on chain before the outcome is known."
2. **Prepare (step 1/4).** "Throwaway keys and test tokens, created locally for this demo. The price update is synthetic."
3. **Local validator (step 2/4).** "A local Solana validator on this machine, with the program and the price update."
4. **Seal.** Point at `ok seal`. "The agent commits a hash of its call with a public expiry. Nobody can see the call yet, and the agent can't change it."
5. **Reveal.** Point at `ok reveal`. "In a later slot the agent opens the commitment. Anyone can check it matches. A call that isn't revealed in time counts as a miss."
6. **Market.** Point at `ok open` and the two buys. "A small parimutuel market on the call, with test tokens and no fees. One trader stakes on YES, another on NO."
7. **Settle.** Point at `ok settle`. "Settlement takes exactly one Pyth price update: the one covering the expiry, from the pinned Pyth Core receiver." Then point at `same price update again is rejected`: "The same update again is refused, and the outcome never changes."
8. **Redeem.** Point at the two redeems. "The call hit, so the YES stakers share the pool and the NO stakers get nothing back. Rounding dust stays in the vault."
9. **Record page (step 4/4).** Open `record-page/index.html`. Show:
   - the disclaimer at the top;
   - the raw counts, and the hit rate next to its sample size;
   - the agent page, where the call's re-check reads "matches the core rule";
   - the self-trade flag, with the note that self-trading from other wallets can't be detected.

   Say: "This page is built from chain data only. It has no scripts and no wallet."
10. **Outro.** Show the disclaimer again.

## What not to say

- No performance claims. Never say an agent is good, right or better than anyone; show raw counts and the hit rate with its sample size, nothing else.
- Don't read out or caption the demo's record as a result. It comes from a synthetic local run.
- No endorsement by PREDICT, Pyth, the Solana Foundation or AudaceFi.
- Not live, not real money, no mainnet, and no US users.
- The market engine is a parimutuel pool, not pm-AMM.

## Offline alternative (no validator)

To show only the record page, build it from the synthetic fixture snapshot. The page then carries a "synthetic test data" banner:

```bash
pnpm web build --snapshot apps/web/fixtures/snapshot-fake.json --out /tmp/acm-site
```

## After recording

Recording, editing and any upload are done by a human. Submitting to the hackathon or posting anywhere needs Patrick's explicit yes (`CLAUDE_BRIEF.md` §10).
