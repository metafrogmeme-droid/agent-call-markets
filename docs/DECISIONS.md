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
| Q8 | AudaceFi journal | Not touched in M1 (it's M5). |
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
