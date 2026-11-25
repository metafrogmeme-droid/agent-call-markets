# Agent Call Markets: build plan (M0)

> Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.

No US users.

`CLAUDE_BRIEF.md` is the source of truth. This plan implements it and is a proposal until Patrick approves it. Facts gathered on 23 Nov 2026 are in `docs/RESEARCH.md` and `docs/PM_AMM_FEASIBILITY.md`. Open questions are in the PR #0 description.

**Status (25 Nov):** M0 to M3 merged (M3: parimutuel market with vault, positions, buy, redeem). M4: the Solana adapter and mainnet guard merged (#5); the CLI, localnet smoke run and M4 docs are in a draft follow-up PR. The open questions are still unanswered, so M1 uses the most conservative default for each one. They are listed in `docs/DECISIONS.md`, and all of them are provisional. Where this plan says "proposed", `docs/DECISIONS.md` gives the value M1 actually uses.

## 0. Hard rules (apply to every PR)

- Draft PRs only. Never merge. Never push to `main`.
- No private keys, seed phrases, secrets or API keys in the repo, logs or chat. No paid services.
- No mainnet. Devnet/testnet and test tokens only.
- No deploys beyond the local validator and devnet scripts **that a human runs**.
- No registering, submitting, posting or contacting anyone.
- Honesty:
  - The disclaimer is used verbatim, and "No US users" appears in the README and UI.
  - No performance claims, no results figures, no "guaranteed".
  - No endorsement claims (PREDICT, Pyth, Solana Foundation, AudaceFi).
  - Claw Guard is not part of this product and is never described as protecting it.

## 1. Architecture

```
packages/core            pure TS, no I/O: seal codec, commit/reveal, validation,
                         market state machine, settlement rule, pool maths,
                         record maths, ChainAdapter interface, in-memory adapter,
                         adapter conformance suite, golden test vectors (JSON)
packages/adapter-solana  ChainAdapter over the Anchor program + CLI/devnet scripts
programs/call_markets    Anchor program (Rust)
apps/bridge              AudaceFi journal -> sealed call (read-only, dry-run default)
apps/web                 read-only public record page (static build)
docs/                    plan, threat model, research, architecture, demo script
```

Tooling: pnpm workspaces, Node 22, TypeScript strict, vitest + fast-check, a Cargo workspace for the program (proptest). Hashing in core uses `@noble/hashes` (pure JS). The Anchor version is pinned in M2: Anchor 1.0 is the likely choice, because `pyth-solana-receiver-sdk` 2.0.0 targets Anchor 1.0 and `@pm-amm/sdk` peers on `@anchor-lang/core ^1.0`. This gets verified before M2 starts.

### 1.1 Seal format v1 (provisional until Q6, the HashKey Seal / Proof of Call spec)

Fixed width, big-endian, so it's easy to reproduce in Rust and later on EVM chains:

| field | bytes | notes |
|---|---|---|
| version | 1 | `0x01` |
| agent | 32 | chain-native agent key (Solana pubkey; EVM address left-padded) |
| feed_id | 32 | Pyth price feed id |
| direction | 1 | `0x01` ABOVE, `0x02` BELOW |
| level_mantissa | 8 | i64 |
| level_expo | 4 | i32 (same fixed-point form as Pyth prices) |
| expiry_ts | 8 | i64 unix seconds (no slots in core) |
| salt | 32 | CSPRNG, never derived from public data |

- `commitment = sha256("ACM-SEAL-V1" ‖ 0x00 ‖ encoded_call)`.
- The domain tag and version byte separate this format from any other and allow later versions.
- The agent key in the preimage stops one agent copying another agent's commitment.
- There are no free-text fields.
- Golden vectors (`packages/core/test-vectors/seal-v1.json`) are checked by both vitest and Rust tests.

### 1.2 Commit/reveal: proposed reveal-at-open (Q5)

- `seal(commitment, expiry_ts)` records the seal slot and time. `reveal_deadline = seal_ts + reveal_window`.
- `reveal(call, salt)` runs at or before the deadline, in a later slot than the seal. The preimage must hash to the commitment, the signer must equal `call.agent`, and the expiry must match.
- `open_market` needs a revealed call, `seal_slot < open slot`, and enough time before expiry. Trading closes at `expiry_ts - trade_cutoff`.
- A call that isn't revealed by its deadline counts as a **MISS** in the record. Its market never opens.

Why reveal-at-open: traders price a known call, viewers can follow it, and the AMM or pool has something real to price. With reveal-at-settle, traders would bet blind while the agent knows the call.

### 1.3 Settlement rule (core = reference spec)

`decideOutcome(call, observation, params)` returns HIT, MISS or a rejection.

The observation is `{ feedId, price, conf, expo, publishTime }`. That's oracle-agnostic, so it fits Pyth price update accounts and price feed accounts the same way.

Checks:
- **Feed:** `feedId == call.feed_id`.
- **Time:** `publishTime ∈ [expiry, expiry + W]`.
- **Price:** greater than 0.
- **Confidence:** `conf / price ≤ max_conf_bps`. If not, reject and fail closed.

The comparison uses bigint arithmetic after normalising exponents, so there are no floats. M1 uses the conservative rule from `docs/DECISIONS.md` (Q9): ABOVE hits iff price − conf > level, BELOW hits iff price + conf < level, and equality is a MISS.

If no valid settle happens before `expiry + void_after`, a permissionless void refunds everyone. The record shows VOID separately.

**Who decides outcomes.** On-chain payouts must be trustless, so the program computes the outcome itself, mirroring core. Core stays the reference spec, and shared golden vectors prove the program matches. The adapter and web page re-derive every outcome with core from the stored on-chain observation and flag any mismatch. This is a design decision for sign-off.

### 1.4 Record maths

Per agent:
- **Counts:** sealed, revealed, pending, hits, misses (including unrevealed past the deadline), voids, and same-key self-trades.
- **Hit rate:** an exact rational `hits / (hits + misses)`, always shown with the sample size n.

Nothing else: no intervals, no PnL, no rankings.

### 1.5 ChainAdapter interface (`packages/core/src/adapter.ts`)

```ts
interface ChainAdapter {
  readonly chainId: string; // e.g. "solana:devnet"
  sealCall(c: { commitment: Bytes32; expiryTs: bigint }): Promise<Tx<CallRef>>;
  revealCall(ref: CallRef, call: CallV1, salt: Bytes32): Promise<Tx>;
  openMarket(ref: CallRef): Promise<Tx<MarketRef>>;
  quote(m: MarketRef, side: Side, amount: bigint): Promise<Quote>;
  trade(m: MarketRef, side: Side, amount: bigint, minProjectedPayout: bigint): Promise<Tx>;
  redeem(m: MarketRef): Promise<Tx<bigint>>; // additive: needed by M3 "redeem"
  settle(ref: CallRef, oracle: OracleRef): Promise<Tx<Outcome>>; // CallRef: a call without a market is still decided
  voidUnsettled(ref: CallRef): Promise<Tx>; // additive: refund path after expiry + voidAfter
  getCall(ref: CallRef): Promise<CallRecord | null>;
  listCalls(agent: AgentId): Promise<CallRecord[]>;
}
```

- Write methods use an injected signer. Read-only instances (for the web page) have none.
- `MemoryAdapter` (no I/O) implements the interface in core.
- A shared **conformance suite** runs against `MemoryAdapter` in M1 and against the Solana adapter on the local validator in M4.

## 2. The MVP adapter: Solana devnet

### 2.1 Anchor program `programs/call_markets`

**Accounts**
- `Config` PDA: windows, `max_conf_bps`, allowed feed ids, collateral mint. Set once at init, with **no update instruction and no outcome override**.
- `Call` PDA `["call", agent, commitment]`: commitment, seal slot and time, expiry, reveal deadline, revealed fields, status, outcome, settle observation and settler.
- `Market` (or a pm-AMM market reference, see 2.2) plus a vault and `Position` PDAs.

**Instructions**
- `seal_call`, `reveal_call`, `open_market` (permissionless once revealed).
- `buy` and `redeem` (M3).
- `settle`: permissionless, single outcome. It reads `PriceUpdateV2` (Anchor owner check), checks the feed id, publish-time window and confidence, and fails closed. After that, settle is rejected with `AlreadySettled` and state never changes.
- `void_unsettled`: permissionless, after `expiry + void_after`.

Checked maths everywhere and `overflow-checks = true`.

**Where devnet prices come from is open (Q3).** Hermes now needs an API key, and devnet sponsored feeds aren't listed (`docs/RESEARCH.md` §2). The program code is the same either way, because it reads `PriceUpdateV2`.

**Tests:**
- LiteSVM (deterministic clock, injected `PriceUpdateV2` fixtures) for every instruction and edge case.
- `anchor test` on a local validator for an end-to-end smoke flow.
- Rust tests against the golden vectors.
- proptest for the pool maths.

### 2.2 Market engine (M3): pm-AMM or parimutuel

- **pm-AMM** (see `docs/PM_AMM_FEASIBILITY.md`):
  - Our program creates the pm-AMM market by CPI, with a program PDA as the market authority.
  - `settle` resolves it by CPI from the Pyth outcome, so no human key can resolve it.
  - Trading, liquidity and claims go straight to pm-AMM through its SDK.
  - Go/no-go by **Fri 27 Nov** after a local spike.
- **Parimutuel fallback:**
  - One vault. Winners get `floor(stake × total / winning_total)`.
  - No winners, or VOID: everyone is refunded.
  - No fees. Rounding dust stays in the vault and is documented.
  - The maths is pure TS in core (fast-check) and mirrored in Rust (proptest).
  - Invariants: Σpayouts ≤ vault; one redeem per position; no redeem before settle or void.
- The README states plainly which engine is used.

### 2.3 `packages/adapter-solana` + CLI (M4)

- A `@solana/kit` client implementing `ChainAdapter`. Its layouts are checked against the IDL that CI regenerates (`docs/DECISIONS.md`, M4).
- CLI (`pnpm acm`): `keygen`, `airdrop`, `admin init-mint|mint-to|init-config`, `seal`, `reveal`, `open`, `quote`, `buy`, `settle`, `void`, `redeem`, `show`, `list`.
- **Mainnet guard:** the RPC genesis hash must be devnet, or localnet on a loopback host. Mainnet and testnet are always refused, with no override. It is checked on connect and again before every transaction. This is mandatory, because pm-AMM uses the same program ID on mainnet.
- **Keys:** `keygen` writes a throwaway keypair to `.devnet/` (gitignored). Salts are stored in `.devnet/salts/`. A lost salt means the call stays unrevealed and counts as a MISS.
- **Tests:** the conformance suite runs against the compiled program in LiteSVM, because it needs clock control and on-demand price accounts. A smoke run uses a real `solana-test-validator` on 127.0.0.1.
- **Deploys:** the devnet deploy is a documented command a human runs (`docs/DEVNET.md`). It's never in CI.

### 2.4 `apps/bridge` (M5)

- Maps AudaceFi journal entries to `CallV1`. It's read-only on journals and never trades.
- Dry-run is the default. `--execute` is required to send.
- It dedupes by journal entry id.
- It uses synthetic, clearly fake fixtures until the journal format is known (Q8).

### 2.5 `apps/web` (M6)

- A static build that reads devnet RPC through the read-only adapter and computes the record with core.
- No wallet connection, no third-party scripts, a CSP.
- The disclaimer and "No US users" on every page.
- Raw counts plus the hit rate with n, nothing else.
- It runs locally. Public hosting is a deploy and needs Patrick's yes.

## 3. Milestones (each a small draft PR)

| PR | Scope | Target |
|---|---|---|
| **M0 (PR #0)** | This plan, threat model, research notes, pm-AMM finding, README "No US users", `security.yml` (gitleaks + Semgrep) | **Mon 23 Nov** (brief) |
| M1a | Workspace tooling + TS CI job; seal schema, codec, commit/reveal, golden vectors | Tue 24 Nov |
| M1b | Validation, state machine, settlement rule, pool maths, record maths, `ChainAdapter`, `MemoryAdapter`, conformance suite, ≥ 90% line coverage | **by Thu 26 Nov, merge-ready** (brief) |
| M2 | Anchor program: config, seal, reveal, open, settle (Pyth), void; Rust + anchor CI jobs | Fri 27 – Sun 29 Nov (pm-AMM go/no-go Fri 27) |
| M3 | Market engine (pm-AMM or parimutuel): buy, redeem, invariants | Sat 28 – Mon 30 Nov |
| M4 | Solana adapter + CLI + mainnet guard; conformance suite on the local validator | Mon 30 Nov – Tue 1 Dec |
| M5 | Journal bridge (dry-run default) | Tue 1 Dec |
| M6 | Record page | Tue 1 – **Wed 2 Dec, MVP feature-complete** (brief) |
| M7 | README, architecture diagram, demo script for a human to record | **Thu 3 – Fri 4 Dec** (brief) |
| — | Submission: **only with Patrick's explicit yes.** The hackathon deadline is `2026-12-05T21:00Z`. | by Sat 5 Dec |

Bold dates come from the brief; the others are proposals. After 5 Dec, each further adapter (Base/Arbitrum Sepolia, other EVM L2s, QIE, HSK, NEAR, Concordium, Injective) is its own small PR, testnet first.

## 4. CI (GitHub Actions; must pass on every PR)

- **Global settings:** triggers `push` + `pull_request` (never `pull_request_target`); `permissions: contents: read`; concurrency cancel; job timeouts; no secrets; no paid services.
- **Pinning:**
  - Actions are pinned to full commit SHAs, resolved with `git ls-remote` on 23 Nov.
  - Tools have pinned versions: gitleaks via the Go module proxy, which checks module checksums; Semgrep via PyPI.
  - Toolchains are pinned too: `packageManager`, `.nvmrc`, `rust-toolchain.toml`, and exact Agave/Anchor versions.
- **Jobs:**
  - **security** (from PR #0): gitleaks over the full git history (`--redact`). Semgrep `--config p/default --config p/secrets --error --metrics=off`, with no Semgrep account or token.
  - **ts** (from M1a): frozen-lockfile install → eslint (typescript-eslint strict, type-checked) → `prettier --check` → `tsc --noEmit` (strict) → `vitest --coverage`. The core thresholds are lines ≥ 90 (statements/functions ≥ 90, branches ≥ 85). Coverage is uploaded as an artifact.
  - **rust** (from M2): `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.
  - **sbf** (from M2): pinned Agave CLI; `cargo build-sbf` (fails on SBF stack-frame overflow) and the instruction tests against the binary.
  - **rust** also regenerates the IDL with the pinned Anchor CLI and fails on drift (M4).
  - **adapter** (M4, needs sbf): the adapter suite and shared conformance suite against the binary in LiteSVM (enforced coverage), then the CLI smoke run on `solana-test-validator` bound to 127.0.0.1. No devnet calls in CI.
- **Local equivalence:** `pnpm verify` runs the same TS steps locally.

## 5. Threat model

See `docs/THREAT_MODEL.md`.
