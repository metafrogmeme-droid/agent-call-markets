# Threat model (M0)

> Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.

Each item below is handled in code and tests, or documented as a residual risk in the README. Items 1–8 come from `CLAUDE_BRIEF.md` §6; items 9–14 were added during planning. **Nothing here is implemented yet**: this is the plan for M1–M7.

| # | Threat | Mitigation | Where tested |
|---|---|---|---|
| 1 | **Look-ahead / late sealing** | The commitment is on-chain before the market opens (`seal_slot < open slot`). Reveal happens in a later slot than the seal. Expiry must be at least `min_lead` away and at most `max_horizon`. Trading closes `trade_cutoff` before expiry. | core validation tests; program tests (M2) |
| 2 | **Selective reveal** (agent hides losing calls) | An unrevealed call past `reveal_deadline` counts as a MISS in record maths, and its market never opens. A lost salt has the same effect. | core record tests (M1b) |
| 3 | **Oracle manipulation / stale price** | `PriceUpdateV2` owner check (Anchor), feed id = committed feed id, `publish_time ∈ [expiry, expiry + W]`, `conf / price ≤ max_conf_bps`. Fail closed. Permissionless void and refunds if no valid settle happens before `expiry + void_after`. | LiteSVM settle tests with fixtures (M2) |
| 4 | **Agent betting on own calls / wash trading** | Same-key positions on an agent's own market are flagged publicly on the record page. The hit rate is unaffected by trading. The README says plainly that self-trading from other wallets can't be detected. | record tests (M1b, M6) |
| 5 | **Settlement griefing** | Settle is permissionless and single-outcome: once settled, further settles are rejected and state never changes. Late settlement is possible while a valid observation exists; after that, the void path applies. | program tests (M2) |
| 6 | **Rounding and pool drain** | Integer floor maths, Σpayouts ≤ vault, one redeem per position, no redeem before settle or void. With pm-AMM, its on-chain solvency check applies, and our tests check claim totals against the vault. | fast-check (core) + proptest (program) |
| 7 | **Key handling** | No keys in the repo. Throwaway devnet keypairs are generated locally into `.devnet/` (gitignored). gitleaks scans the full history and Semgrep runs secrets rules on every push and PR. CI never needs secrets. | CI `security` job (from PR #0) |
| 8 | **Front-end** | Read-only by default: no wallet connection, no signing prompts, no third-party scripts, a CSP. Seals carry no free-text fields, so chain data can't inject markup. | review + build check (M6) |
| 9 | **Commitment copying / replay** | The agent key is in the preimage, and the reveal signer must equal `call.agent`. A domain tag plus version byte separate formats. | golden vectors + program tests |
| 10 | **Encoding ambiguity / salt brute force** | Fixed-width canonical encoding. A 32-byte CSPRNG salt (the call space is small, so the salt carries the hiding). The same vectors are checked in TS and Rust. | fast-check round-trip, vectors |
| 11 | **Settler picks a favourable update** (adversarial selection) | Keep W tight. Residual risk is documented. If Pyth Pro access is approved (Q3), consider exact-timestamp settlement (the first update at or after expiry, checked by its timestamp), which removes the settler's choice. | documented; tests for window bounds |
| 12 | **Accidental mainnet use** | The adapter and CLI refuse to write unless the RPC genesis hash is devnet or localnet. `Anchor.toml` has no mainnet cluster. pm-AMM uses the same program ID on mainnet, so this guard is mandatory. | adapter tests (M4) |
| 13 | **Third-party program risk (pm-AMM path)** | The pm-AMM devnet program can be upgraded by a single key and is unaudited (self-declared). Pin the IDL version, check the program ID, and fail closed on unexpected account layouts. If the spike fails, use the parimutuel fallback. | spike (M2/M3) |
| 14 | **Supply chain** | Frozen lockfile, pnpm build-script allowlist, actions pinned to commit SHAs, pinned tool versions, minimal dependencies. | CI |
