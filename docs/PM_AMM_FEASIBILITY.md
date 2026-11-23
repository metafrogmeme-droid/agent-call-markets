# pm-AMM feasibility finding (M0)

> Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.

Status: **desk research only, 23 Nov 2026.** Nothing was deployed, signed or sent. No faucet was called. This finding does not claim PREDICT endorsement.

## Sources read (23 Nov 2026)

- https://predict-pm-amm.dev/ (landing page)
- https://predict-pm-amm.dev/hackathon.md (builder kit)
- https://predict-pm-amm.dev/llms.txt (SDK reference)
- npm package `@pm-amm/sdk@0.2.0` (MIT): the bundled IDL `src/idl/pm_amm.json` was read; no code was run
- https://hackathons.solana.com/hackathons/perps-and-prediction-markets (bounty text)

The GitHub repo (`sparkfun-labs/pm-amm`) and the API reference in it were **not** read. They are outside this session's access.

## What the sources state

| Topic | Stated by the source |
|---|---|
| What it is | Open-source implementation of the Paradigm pm-AMM paper (Moallemi & Robinson, 2024) on Solana. MIT licence. |
| Program | One Anchor program, 34 instructions. Program ID `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y`. **The same ID runs on devnet and on mainnet with real USDC.** |
| Devnet collateral | Mock USDC (`mUSDC`) mint `3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ`, 6 decimals. A faucet run by the project hands it out. |
| Market types | Binary YES/NO (seeded at 50% or 1–99%), multi-outcome groups, commitment vaults, bet vaults. |
| SDK | `@pm-amm/sdk` (TypeScript), peer deps `@solana/web3.js ^1.98`, `@anchor-lang/core ^1.0`, `@solana/spl-token ^0.4`. |
| Fees | **2% swap fee on the USDC leg**, split 50% to a protocol DAO address and 50% to the market creator. YES↔NO swaps are free. Winning tokens redeem 1:1. |
| Resolution | **Manual.** "Whoever creates a market is its authority and resolves it after `endTs`." There's no oracle. The site lists an oracle adapter (e.g. Pyth) as a wanted contribution. |
| Limits | Market duration ≥ 300 s. Names 1–64 bytes. `initialPriceBps` 100–9900. |
| Risks (self-declared) | Centralised resolution, single-key upgrade authority, **no third-party audit**, multi-outcome drift. |

## What the IDL shows (`@pm-amm/sdk@0.2.0`, `pm_amm.json`)

- `initialize_market(market_id, end_ts, name, initial_price_bps)`: `authority` is **signer + writable** (it pays rent; there's no separate payer). It also creates YES/NO mints, a vault and Metaplex metadata accounts.
- `resolve_market(winning_side)`: only `signer` + `market`. It's authority-only (error `Unauthorized`) and allowed after expiry (`MarketNotExpired`).
- `deposit_liquidity`, `swap`, `claim_winnings`: callable by any signer. `swap` needs `dao_usdc` and `creator_usdc` fee accounts.

## Assessment

**Technically feasible in principle, not yet proven on devnet.**

How it fits the brief:
- Our program would create each market through a CPI, with a **program-owned PDA as the pm-AMM market authority**.
- Our permissionless Pyth `settle` instruction would then call `resolve_market` through a CPI signed by that PDA.
- No human key could resolve or override an outcome. That matches "no admin override of outcomes".
- Trading, liquidity and claims would go straight to pm-AMM through its SDK.

The open risks are listed below. None of these is verified yet:

1. **PDA as rent payer.** `initialize_market` makes the authority pay rent, so the PDA must be a funded, system-owned account. That's possible with `invoke_signed`, but untested.
2. **Local testing.** Local-validator and LiteSVM tests need the pm-AMM and Metaplex Token Metadata program binaries. They would be dumped from devnet, which needs devnet RPC access, a human step, or a committed `.so` with a recorded hash.
3. **Compute budget.** The CPI cost of `initialize_market` (mints + metadata) inside our instruction is unknown.
4. **Upstream changes.** The devnet program can be upgraded by a single key at any time, so it could drift from the IDL we pin.
5. **Fees.** The 2% swap fee applies to test-token trades, and half goes to the market creator, which would be our PDA. Our product charges no fees, but the engine does. The README would have to say so plainly.
6. **Mainnet confusion.** The same program ID exists on mainnet, so our genesis-hash mainnet guard (plan §2.3) becomes mandatory, not optional.

## Bounty notes (facts from the bounty text; the decision is Patrick's)

- **Eligibility:** "The pm-AMM must be a core part of the product, not a side feature or a mock." It also requires "Working code with a public repo and a short demo."
- **Judging:** traction is the "biggest weight": "number of users, trades, volume, and fees generated on the pm-AMM. Show us the numbers."
- **Prize:** a "$1,000 investment in the winning project (not a grant)".
- **Conflict:** quoting user, trade or volume numbers would conflict with our honesty rules (no results figures in any copy). Per the brief, we apply **only** if pm-AMM is core **and** Patrick says yes.
- **Builder kit vs our rules:** the kit suggests "a deployed URL on devnet, ideally with burner wallets". That conflicts with our rules: no deploys without Patrick's yes, a read-only front end, and no keys in the browser. It isn't planned.

## Proposed go/no-go (by Fri 27 Nov)

**Go** if a local spike shows all of these:
- (a) a PDA can create a market via CPI;
- (b) the PDA can resolve it via CPI from our settle path;
- (c) it fits in the compute budget;
- (d) we can test it locally without network calls in CI.

**Otherwise:** use the parimutuel fallback and state it plainly in the README.
