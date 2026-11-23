# Research notes (M0, 23 Nov 2026)

> Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.

These are facts read from public pages on 23 Nov 2026. Quotes are marked. Where a page doesn't say something, these notes say "not stated". This is no claim of endorsement by the Solana Foundation, Pyth or anyone else.

## 1. Hackathon page

Sources:
- https://hackathons.solana.com/hackathons/perps-and-prediction-markets
- https://hackathons.solana.com/how-it-works

| Item | Finding |
|---|---|
| Submission deadline | `2026-12-05T21:00:00Z` (22:00 CET), from the page data |
| Judging deadline | `2026-12-19T21:00:00Z` |
| Start date | Not stated (`launch_date` is empty; the status is "scheduled"). The page says "One week to build". The generic how-it-works page says "14 days from launch". |
| Rules on pre-existing code | **Not stated.** The page's `rules` field is empty. |
| What to submit | GitHub repo, live demo ("Deployed to devnet or mainnet"), pitch video (3 min max), technical video (5 min). Each is marked "Optional". "Pick up to 3 sponsor tracks." |
| Visibility | "Projects are private until after judging." |
| Main track | $100,000, "Awarded by the Solana Foundation, judged across every submission." |
| pm-AMM bounty | See `docs/PM_AMM_FEASIBILITY.md`. |
| OrbitFlare free RPC | Needs a sign-up and a Discord support ticket. **Not used:** it would mean registering and contacting a third party. |
| Eligibility (countries, KYC, team size) | Not stated on these pages. |

## 2. Pyth on Solana

Sources:
- https://docs.pyth.network/price-feeds/use-real-time-data/solana
- https://docs.pyth.network/pro/sponsored-feeds
- https://docs.pyth.network/pro/contract-addresses
- https://docs.pyth.network/pro/acquire-api-key
- https://docs.pyth.network/pro/best-practices

**Contracts and SDKs**
- "All Pyth Core contracts were upgraded on August 26, 2026 and kept their interface."
- The Pyth Core programs (receiver `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`, price feed `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT`, Wormhole receiver `HDwcJBJXjL9FpJ7UBsYBtaDjsBUhuLCUYoz3zr8SWWaQ`) run on Solana mainnet **and devnet**, at the same addresses.
- The Pyth Core Compatible programs also run on devnet: receiver `rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp`, price feed `pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou`, Wormhole receiver `HDw2E7P8X1SkCyjvoGsfBGAVUutKcj874bXjHrpVYrVL`.
- The Pyth Pro program `pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt` has the same address on mainnet, devnet and testnet.
- Rust crate: `pyth-solana-receiver-sdk`. "Version 1.2.0 works with Anchor v0.32.1, and 2.0.0 with Anchor v1.0." Programs read `Account<'info, PriceUpdateV2>`, and Anchor checks the owner. `get_price_no_older_than(clock, max_age, feed_id)` checks age and feed.
- "Price feed accounts and price update accounts work identically from the perspective of the on-chain program."

**Getting prices (the blocker)**
- **Hermes needs an API key:** "Hermes requires a Pyth API Key". The key comes from signing up for a free Pyth Terminal account. The price pusher also needs a key.
- **Sponsored feeds:** the list of continuously pushed price feed accounts on Solana says "currently sponsored in Solana **mainnet**". Devnet isn't listed.

**Best practices**
- Use the confidence interval, e.g. "Pause new activity that depends on the asset's price when confidence / price exceeds a threshold".
- Adversarial selection: "users can still choose any price update that satisfies these constraints".
- Delayed settlement: round the time up to the first update at or after t, then check that the verified timestamp equals the rounded one. That uses Pyth Pro fixed-rate channels, which also need an API key.

**Feed IDs**
- BTC/USD Pyth Core id `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` appears in the Solana guide.
- The SOL/USD and ETH/USD ids weren't readable in these pages (the table renders client-side). They'll be taken from Pyth's feed list in M2, not from memory.

**Consequence for this project**
- A live **devnet** Pyth settlement needs one of two things: a Pyth API key, which means a sign-up, against the brief's "no API keys" rule; or a devnet price feed account that someone keeps fresh, which is unverified.
- Tests (vitest, LiteSVM, local validator) use fixture price accounts and need no key.
- This is open question **Q3** in PR #0.
