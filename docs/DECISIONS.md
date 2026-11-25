# Provisional decisions (M1)

> Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.

No US users.

None of the open questions from PR #0 had been answered when M1 started (24 Nov 2026). As instructed, M1 uses **the most conservative default for each one**. Every row below is **provisional** and can be changed when Patrick answers. Values that are code live in `packages/core/src/params.ts` (`DEFAULT_PARAMS`), so changing them is a one-line change plus tests.

## Defaults per open question

| Q | Topic | Conservative default used in M1 |
|---|---|---|
| Q1 | Hackathon code window | Assume code must be written during the event. All M1 code is new (24 Nov onward); no pre-existing code is imported. |
| Q2 | pm-AMM or parimutuel | **Parimutuel** pool maths in core: no third-party program, no fees. pm-AMM is not used in M1. No bounty application. |
| Q3 | Pyth price source | **Mocks only.** No API key, no live devnet price. Core takes an oracle-agnostic observation, and tests use synthetic fixtures. |
| Q4 | Feeds | No feed ids hard-coded. Feeds come only from an explicit allowlist (`allowedFeedIds`, empty by default). Tests use synthetic ids such as `f1f1…`, which are not real Pyth ids. |
| **Q5** | Reveal timing | **Reveal-at-open.** A market can open only on a revealed call (no blind betting). The reveal must come strictly after the seal and by `seal + revealWindowSecs`. An unrevealed call past its deadline counts as a **MISS**, and its market never opens. |
| **Q6** | Seal format | **Own provisional format `ACM-SEAL-V1`**, explicitly **not** claimed compatible with HashKey Seal / Proof of Call. It uses SHA-256 with a domain tag and a version byte, so a later version can map to that spec. Byte layout and golden vectors: `packages/core/test-vectors/seal-v1.json`. |
| Q7 | Agents and keys | No real agent ids; synthetic test identities only. One key per agent, so the record stays attributable to each key. |
| Q8 | AudaceFi journal | Still unknown. M5 uses its own provisional synthetic format `acm-journal-fixture/v0` with clearly fake fixtures, and doesn't claim it is AudaceFi's (see M5 additions). |
| **Q9** | Settlement parameters | See the table below. A **strict** hit: equality is a MISS, and a hit needs the **whole confidence interval** clear of the level. A wide confidence interval is **rejected** (fail closed). Tight windows and a long lead time. |
| Q10 | Voids | A void is never counted as a hit or a miss. The hit rate is `hits / (hits + misses)`, always shown with the sample size **and** the void count, e.g. `60.0% hit rate (3 of 5 decided; 1 void)`. The percentage is rounded **down**. |
| Q11 | Web | Not touched in M1. When it's built (M6): read-only, CLI-only trading, local only. |
| **Q12** | Branches | **One branch, one open PR at a time.** M1 is a single draft PR from `humanoid-traders/pensive-hopper-gtmaj1`, restarted from the latest `main` after PR #0 merged. No new branch names. M1a and M1b are separate commits in that PR. |
| Q13 | Branch protection | Repo settings unchanged. Recommended: require the `ci` and `security` checks on `main`. |
| Q14 | Collateral | Core is token-agnostic: amounts are bigint base units, with pool totals capped at u64. |
| Q15 | Config | Params are immutable values passed in; there is no setter. On-chain immutability comes in M2. |
| Q16 | Dates | Read as end of day CET. M1 opened on 24 Nov to leave review time before 26 Nov. |

## Q9 parameters (`DEFAULT_PARAMS`)

| Parameter | Default | Effect |
|---|---|---|
| `revealWindowSecs` | 900 (15 min) | Seal → reveal deadline. Short, to limit what an agent can learn before revealing. |
| `minLeadSecs` | 3 600 (1 h) | Minimum seal → expiry. Must exceed reveal window + trade cutoff. |
| `maxHorizonSecs` | 2 592 000 (30 d) | Maximum seal → expiry. |
| `tradeCutoffSecs` | 600 (10 min) | No market opening or trading in the last 10 minutes before expiry. |
| `settleWindowSecs` (W) | 10 | The observation's `publishTime` must be in `[expiry, expiry + 10 s]`. Tight, to limit a settler's choice among updates. |
| `maxConfBps` | 50 | Reject (fail closed) if `conf / price > 0.5%`. |
| `voidAfterSecs` | 259 200 (72 h) | Settlement is allowed only in `[expiry, expiry + 72 h)`; after that, only a permissionless void with refunds. |
| Level exponent | `[-18, 0]` | Exponent range accepted for a call's level. |
| `allowedFeedIds` | empty | No feed is allowed until one is listed explicitly. |

## Outcome rule (reference spec, `packages/core/src/settlement.ts`)

- **ABOVE** hits iff `price − conf > level`.
- **BELOW** hits iff `price + conf < level`.
- Anything else, including equality, is a **MISS**.
- These observations are **rejected**, and no outcome is decided:
  - the feed differs from the committed feed;
  - `publishTime` is outside the window, or later than "now";
  - it is not the unique update covering expiry: `prevPublishTime < expiry ≤ publishTime` must hold (added in M2; conservative, Q9);
  - the price is ≤ 0, the confidence is negative, or the exponent is out of range;
  - the confidence interval is too wide.

## M2 additions (on-chain program, provisional)

| Topic | Conservative default used in M2 |
|---|---|
| Unique price update | Settlement needs the one Pyth update with `prev_publish_time < expiry ≤ publish_time` (Pyth's definition of the unique update for a moment). This removes a settler's choice among updates in the window. If no such update exists, the call can only be voided after 72 h. Applied in core and in the program, checked by shared vectors. |
| Oracle checks | `Account<PriceUpdateV2>` (owner = Pyth Core receiver program `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`), **full** verification only, publish time not later than now. |
| Config | Initialized once, only by the program's **upgrade authority** (checked against its ProgramData account), so a front-run init with hostile parameters is impossible. There is no update instruction and no outcome override. 1–8 unique, non-zero feed ids (stricter than core, which allows an empty list). |
| Reveal timing | Strictly after the seal in both a later **slot** and a later **second**, and by the deadline. |
| Market | M2 records that a market opened. The pool, vault, buy and redeem come in M3. |
| Program id | A placeholder derived from a hash (`sha256("agent-call-markets/call_markets/placeholder-program-id/v1")`), not a key anyone holds. No keypair was generated. A human runs `anchor keys sync` before any devnet deploy. |
| Pyth source (Q3) | Still **mocks only**: synthetic `PriceUpdateV2` accounts in tests. No API key, no live devnet price. |
| Tests | Logic unit tests and the shared golden vectors on the host. Instruction tests in solana-program-test's in-process runtime, natively here and against the SBF binary in CI. `anchor test` on a separate local validator comes with the TypeScript client (M4). |
| Toolchain | Anchor 1.2.2 (Solana v3 crates, which the Pyth SDK 2.0.0 requires), Rust 1.97.1 on the host, Agave CLI v3.1.12 and platform-tools v1.52 (Rust 1.89) for the SBF build in CI. |

## Decided (25 Nov)

| Topic | Decision |
|---|---|
| Pyth receiver | Only the original **Pyth Core** Solana receiver `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` is accepted as owner of price accounts: the `pyth-solana-receiver-sdk` default without the `pro-compatible` feature, as listed on docs.pyth.network/pro/contract-addresses. It is pinned as `PYTH_RECEIVER_PROGRAM_ID` in `programs/call_markets/src/state.rs`; settle checks the owner against that constant (error `OracleOwnerMismatch`), and tests reject every other owner, including the Pyth Core Compatible receiver `rec2HH…`. A test also fails if the SDK default ever stops matching the pinned id. |
| Price updates | The strictest rule: **exactly one accepted price update per market**. It must be the unique update covering expiry (`prev_publish_time < expiry ≤ publish_time`) and published inside the settlement window `[expiry, expiry + 10 s]`. Once a market is settled, presenting the same update again (same account, or the same message posted into another account) fails with `DUPLICATE_PRICE_UPDATE`, and any other update fails with `ALREADY_SETTLED`. The accepted update's account is stored on the call. Applied in core and in the program. |

## M3 additions (market engine, provisional)

| Topic | Conservative default used in M3 |
|---|---|
| Engine (Q2) | Parimutuel pool, no fees. Winners split the whole pool pro rata with floor rounding; rounding dust stays in the vault. VOID, or nobody on the winning side, refunds every stake. Pool totals are capped at u64; products use u128. |
| Collateral (Q14) | One SPL Token test mint, fixed in the config at init (`collateral_mint`). Every buy and payout checks the mint. |
| Vault | Token account PDA `["vault", call]` whose authority is the call PDA, so only the program can move funds out, and only through `redeem`. |
| Positions | One PDA per (market, owner, side), created by an explicit `open_position` instruction (no `init-if-needed`). Stakes accumulate; each position redeems once; losing positions redeem for zero. Positions are public, so the agent's own-key self-trades are visible. |
| Buy | Only while the market is open and before the trading cutoff. `min_projected_payout` guards against the pool moving between quote and buy; the final payout is only known at settlement. |
| Redeem | Only after settlement or void, only to a token account the position owner owns. |

## M4 additions (Solana adapter, CLI, mainnet guard, provisional)

| Topic | Default used in M4 |
|---|---|
| Mainnet guard | Fail closed, **no override flag**, which is stricter than "refuse by default", in line with the brief's "No mainnet". Mainnet-beta and testnet genesis hashes are always refused. `devnet` needs exactly the devnet genesis hash. `localnet` needs a loopback RPC host **and** a non-public genesis hash, so a loopback tunnel to mainnet is still refused. It is checked when the adapter connects and again before every transaction. Hashes are from Anza's `solana-cluster-type` 3.2.1. |
| Client stack | `@solana/kit` 8.6.0 with `@solana-program/token`/`system`, exact pins, all with npm provenance. No web3.js v1 and no Anchor TS client. Instruction, account and event layouts are written by hand and checked field by field against the generated IDL. |
| IDL | `packages/adapter-solana/idl/call_markets.json`, generated by the pinned Anchor CLI 1.2.2. CI regenerates it and fails on any difference. Generating it needed `anchor-spl/idl-build` in the program's `idl-build` feature, which is a build-feature change, not a program change. |
| Adapter role | The adapter moves data and the program decides. No core check is repeated client-side before sending, so every rejection in the conformance suite comes from the program. Client-side checks only where no transaction can be sent. |
| Conformance run | The shared suite runs against the **compiled SBF binary in LiteSVM** (in-process), not on `solana-test-validator`. The suite moves the clock by up to 72 h and creates price accounts on demand, and a real validator can do neither. A separate smoke run on a real `solana-test-validator` (127.0.0.1) covers the JSON-RPC path, the guard and error mapping over RPC. |
| Pyth source (Q3) | Still open. `settle` takes the address of one existing `PriceUpdateV2` account. The adapter posts no updates and uses no API key. Devnet settlement waits on Q3; voids still refund. Localnet and tests use synthetic `PriceUpdateV2` fixtures owned by the pinned receiver. |
| Keys and salts | `keygen` writes a throwaway Solana-format keypair to `.devnet/keypair.json` (0600, never overwritten, never printed); key files readable by others are refused. `seal` writes the salt to `.devnet/salts/<cluster>-<commitment>.json` (0600) **before** sending; salts are never printed. `.devnet/` is gitignored. A lost salt means a miss. |
| Errors | Program errors map onto core `ErrorCode`s by name. New additive core codes: `CLUSTER_NOT_ALLOWED`, `CHAIN_ERROR`, `ORACLE_OWNER_MISMATCH`, `ORACLE_NOT_VERIFIED`, `WRONG_MINT`, `UNAUTHORIZED`, `INVALID_FEED_LIST`, `INVALID_SIDE`. |
| Outcome re-check | `getCall`/`show` re-apply the core rule to the stored observation and report `match` or `mismatch` next to the on-chain outcome (PLAN §1.3). |
| Branch (Q12) | M4 uses the session branch `humanoid-traders/modest-babbage-0y0y25`. #5 (adapter, guard) merged; the CLI, smoke run and docs follow in one draft PR from the same branch, so there is still one open PR at a time. |

## M5 additions (journal bridge, provisional)

| Topic | Default used in M5 |
|---|---|
| Journal format (Q8) | Our own provisional `acm-journal-fixture/v0` (JSON Lines): `entryId`, `agent` (label), `kind`, `createdAt`, `asset` (label), `direction` (`above`/`below`), `level` (decimal string), `expiresAt` (UTC, whole seconds). Only `kind: "call"` is bridged. Extra fields are ignored and never reach a seal. It is **not** claimed to be AudaceFi's format. |
| Maps (Q4, Q7) | Agent labels and asset labels map to 32-byte public ids through explicit JSON files. The feeds map is also the feed allowlist. Each agent maps to exactly one key, and a map with ambiguous or zero ids is refused. |
| Rules | The planner uses the core's own `validateCall` and `sealCall` expiry window, so it reports the same `ErrorCode` the chain would. |
| Freshness | Entries dated after the planning clock, or older than **900 s** (the maximum entry age, equal to the default reveal window), are not sealed. A seal anchors a call at seal time, and this stops old entries being backfilled with hindsight. |
| Transparency | Every entry left out is reported with its reason. The bridge seals every eligible entry; there is no discretionary filter. |
| Dedupe | Entry ids are unique per journal (the first occurrence wins). Across runs a ledger records pending / sealed / rejected. An edited entry (a different content hash) is a conflict and is never re-sealed. |
| Execution | `executePlan` works with any `ChainAdapter`, with one attempt per entry. The salt and a pending record are stored before sending. Chain rejections are final. Client or transport failures stop the run. A pending entry is looked up on chain first and re-sent with the same salt only while still fresh. **Tested only with the core's `MemoryAdapter`**: no keys, no signing. The CLI has no execute command; a Solana signer path needs a go-ahead. |
| CLI | `pnpm bridge plan` is a dry run. It reads its input files, writes nothing, and prints a JSON report including the journal's sha256 and `"sent": false`. |
| Files | The ledger and salt files are 0600 in 0700 directories, and ledger writes are atomic. A corrupt ledger is refused rather than reset. |

