CLAUDE BUILD BRIEF: AGENT CALL MARKETS
Owner: HUMANOID-TRADERS / RUNECLAW. Approved by Patrick on 22 Nov 2026, 19:09 CET.
Repo: github.com/metafrogmeme-droid/agent-call-markets (private)
MVP chain: Solana devnet only. Target: Solana Perps & Prediction Markets hackathon,
https://hackathons.solana.com/hackathons/perps-and-prediction-markets, deadline Sat 5 Dec 2026.

1. GOAL AND USERS
An AI trading agent seals a call on-chain BEFORE the outcome is known (asset, direction,
level, expiry). A small prediction market opens on "does this call hit?". At expiry the
market settles from a Pyth price feed, and the agent's public record (calls, hits, misses)
updates. Message: "agents with receipts, not screenshots".
Users: (a) agent operators who want a verifiable record (our AudaceFi agents first);
(b) traders who want to bet on or against an agent's call with test tokens;
(c) judges and viewers who read the public hit-rate page.

2. MVP SCOPE (FITS 5 DEC, ONE CHAIN ONLY)
- Chain-agnostic core (TypeScript package): seal format, commit/reveal rules, market state
  machine, settlement rule and hit-rate maths. No chain code inside the core.
- Chain adapter interface plus ONE adapter: Solana devnet (Anchor program + TS client).
- Seal: agent commits hash(call || salt) with an expiry slot/time; reveals before the
  market opens (or opens market on the commitment and reveals at settle, pick one in plan).
- Market: binary YES/NO outcome tokens on test tokens only. Investigate the PREDICT pm-AMM
  (predict-pm-amm.dev) as the market engine; if it cannot be integrated on devnet in time,
  fall back to a simple parimutuel pool and say so plainly in the README.
- Settlement: permissionless settle instruction that reads a Pyth price account at/after
  expiry, with staleness and confidence checks. No admin override of outcomes.
- Call source: a script that turns AudaceFi journal entries (devnet agents) into sealed
  calls. Read-only on journals; no trading from this repo.
- Public record: minimal web page (static or Next.js) listing agents, calls, status, hits,
  misses and hit rate computed from chain data only.
Out of MVP: other chains, mainnet, real money, fees, token launch, mobile app.

3. DATES
- 23 Nov: plan in Plan mode, open PR #0 (plan + open questions) as draft.
- by 26 Nov: M1 merged-ready (core seal format + adapter interface + tests).
- by 2 Dec: MVP feature-complete on Solana devnet.
- 3-4 Dec: demo video, README, submission prep.
- by 5 Dec: submit ONLY with Patrick's explicit yes.

4. MILESTONES (EACH A SMALL DRAFT PR)
M0 Plan: architecture notes, pm-AMM feasibility finding, open questions.
M1 Core: seal schema (versioned), canonical encoding, hash/commit/reveal, call validation,
   hit/miss rule, hit-rate maths, ChainAdapter interface. 100% pure TS, unit tested.
M2 Solana program: seal account, reveal, market create, expiry, settle (Pyth). Anchor tests
   on local validator.
M3 Market engine: pm-AMM integration or parimutuel fallback; buy YES/NO, redeem.
M4 Solana adapter + CLI: implements ChainAdapter; devnet scripts using a throwaway
   devnet keypair generated locally and gitignored.
M5 Journal bridge: AudaceFi journal -> sealed call (dry-run default).
M6 Record page: reads chain, shows hit rate, disclaimer on every page.
M7 Demo + docs: README, architecture diagram, demo script.
After 5 Dec (each its own small PR, testnet first): adapters for Base (Sepolia), Arbitrum
(Sepolia), other EVM L2s, and chains we already use: QIE, HSK (HashKey Chain), NEAR,
Concordium, Injective. Reuse the HashKey Seal / Proof of Call seal format so seals are
portable across chains.

5. ARCHITECTURE
packages/core      chain-agnostic: types, seal codec, market state machine, settlement
                   rule, record maths. No I/O.
packages/adapter-solana  implements ChainAdapter (sealCall, revealCall, openMarket,
                   trade, settle, readRecord) against the Anchor program.
programs/call_markets  Anchor program (Rust).
apps/bridge        AudaceFi journal -> call (read-only on journals).
apps/web           public record page.
ChainAdapter interface: chainId, sealCall(commit), revealCall(call, salt), openMarket(id),
quote/trade(side, amount), settle(id, oracleRef), getCall(id), listCalls(agent).
The core decides outcomes from (call, oracle price, timestamp); adapters only move data.

6. THREAT MODEL (ADDRESS EACH IN CODE OR README)
- Look-ahead / late sealing: commitment must be on-chain before market open; reject calls
  whose expiry is too close or whose seal slot is after the reference time.
- Selective reveal (agent hides losing calls): unrevealed calls count as misses after a
  reveal deadline.
- Oracle manipulation / stale price: Pyth staleness and confidence bounds; fail closed.
- Agent betting on own calls / wash trading: record it publicly; no hit-rate inflation.
- Settlement griefing: permissionless settle, idempotent, single outcome per market.
- Rounding and pool drain in market maths: property tests and invariants.
- Key handling: no keys in repo; devnet keypairs only, generated locally, gitignored.
- Front-end: no wallet drain prompts; read-only by default.

7. TESTS AND STRICT CI (GITHUB ACTIONS, MUST PASS ON EVERY PR)
- Lint: eslint + prettier (TS), cargo fmt --check + clippy -D warnings (Rust).
- Typecheck: tsc --noEmit, strict mode.
- Unit tests: vitest for core (target >=90% line coverage on core, enforced), anchor test
  on local validator for the program; property tests for market maths.
- Coverage report uploaded as an artifact; CI fails below threshold.
- Semgrep (default + secrets rules) and gitleaks on every push and PR.
- No network calls to paid services in CI. Pin action versions.

8. HONESTY AND CLAIMS RULES
- Exact disclaimer on README, web page and demo (use verbatim):
  "Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling,
  and not financial advice. Unaudited."
- Also state "No US users" in README and UI.
- No hit-rate promises, no "guaranteed" anything, no results figures in README, UI, demo
  or any copy. The record page shows live chain data only; never quote it in marketing.
- No performance claims: never say an agent is profitable, accurate or "beats the market".
  Show raw counts and hit rate with sample size; nothing else.
- Never overclaim Claw Guard: it is an unaudited prototype in a paused demo on Arbitrum
  One, not a wallet firewall. Do not say it protects this product.
- Do not claim PREDICT, Pyth, Solana Foundation or AudaceFi endorsement.
- If pm-AMM is not core to the product, do not apply for the pm-AMM bounty.

9. HARD RULES
- Plan mode first; present the plan; then Accept edits mode only after the plan is approved.
- Draft PRs only. Never merge, never push to main after the initial commit.
- No private keys or seed phrases in the repo, logs, or chat. No mainnet. No deploys beyond
  local validator / devnet test scripts that a human runs. No paid services or API keys.
- Devnet/testnet only. Test tokens only.
- Commit author: HUMANOID-TRADERS <313699818+metafrogmeme-droid@users.noreply.github.com>
- Open questions go in the PR description under "Open questions", not guessed.
- Do not register for the hackathon, post on X, or contact anyone.

10. HACKATHON SUBMISSION CHECKLIST (ALL NEED PATRICK'S YES)
[ ] Patrick's yes to register / submit on hackathons.solana.com
[ ] Public repo link (repo is private now; making it public needs Patrick's yes)
[ ] Short demo video (end-to-end: seal -> market -> Pyth settle -> record)
[ ] Project description + what was built during the hackathon
[ ] pm-AMM bounty only if pm-AMM is core and working (needs real on-chain usage; no fakes)
[ ] Disclaimer visible in repo, demo and page
[ ] Optional X post: drafted by Marketing, posted only with Patrick's yes

11. OPEN QUESTIONS FOR PR #0
- Does the hackathon require code written during the event window? (Note which parts are new.)
- pm-AMM on devnet: available? If not, parimutuel fallback.
- Which Pyth feeds (SOL/USD, BTC/USD, ETH/USD) and which AudaceFi agents feed calls?
- Reveal-at-open vs reveal-at-settle.
