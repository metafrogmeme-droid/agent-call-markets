# @agent-call-markets/bridge

> Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.

No US users.

The journal bridge (M5): it turns an agent's journal entries into sealed calls. It is **read-only on journals**, **dry run by default**, chain-agnostic, and holds **no keys**. Nothing here trades.

## Journal format (provisional)

The bridge reads `acm-journal-fixture/v0`, one JSON entry per line:

```json
{"schema":"acm-journal-fixture/v0","entryId":"FAKE-0001","agent":"FAKE-AGENT-1","kind":"call",
 "createdAt":"2026-12-01T11:55:00Z","asset":"FAKE-SOL/USD","direction":"above","level":"185.25",
 "expiresAt":"2026-12-01T18:00:00Z"}
```

- **This is our own synthetic format, not the AudaceFi journal format.** That one is still unknown (open question Q8). A real format gets its own parser next to this one.
- Only `kind: "call"` entries are bridged.
- Times are UTC, whole seconds, with a trailing `Z`. Levels are positive decimal strings and are converted exactly (`"185.25"` → mantissa 18525, exponent −2).
- Extra fields are ignored and never reach a seal; seals carry no free text.
- Agent and asset labels map to 32-byte public ids through explicit JSON map files: `--agents` and `--feeds`. Feeds come only from that list (Q4), and each agent maps to exactly one key (Q7). The fixtures use fake labels and synthetic ids (`fixtures/README.md`).

## What the planner checks (`planBridge`, a dry run)

In order, for each line:
1. Format (`MALFORMED_JSON`, `WRONG_SCHEMA`, `INVALID_FIELD`, `NOT_A_CALL`).
2. Unique entry id (`DUPLICATE_ENTRY_ID`; the first occurrence wins).
3. The ledger from earlier runs:
   - `ALREADY_PROCESSED`;
   - `LEDGER_CONFLICT` if the entry was edited;
   - a pending entry becomes a *resume* intent.
4. Agent and feed maps (`UNKNOWN_AGENT`, `UNKNOWN_ASSET`).
5. Freshness: `ENTRY_IN_FUTURE`, or `ENTRY_TOO_OLD` beyond a maximum entry age of 900 s by default. A seal anchors a call at seal time, so old entries are never sealed with hindsight.
6. **The core's own rules:** `validateCall` and the expiry window of `sealCall` at the planning clock (`CORE_RULE`, with the core `ErrorCode` the chain would return).

Every entry that is not turned into a seal is listed with its reason, so what was left out is visible. The planner is pure and deterministic for a given input.

## Executing a plan (library only in M5)

`executePlan(plan, { adapter, agentKey, ledger, salts, now })` works with any core `ChainAdapter`. In this milestone it is tested **only against the core's in-memory `MemoryAdapter`**, so no keys, signing or network are involved. A Solana signer path needs keys and is out of scope until it gets a go-ahead.

- **One attempt per entry.** The salt and a `pending` ledger record are stored **before** sending.
- A chain rejection (for example the expiry window) is recorded as `rejected` and never retried.
- Client or transport failures stop the run and leave the entry `pending`.
- **Recovery:** a `pending` entry is looked up on chain first (`listCalls`, matching the commitment). If it isn't there, it is re-sent with the **same stored salt**, but only while the entry is still fresh. Otherwise it is recorded as rejected.
- Intents for another agent are skipped, never sealed. A salt that no longer opens its commitment is refused.

## CLI

```bash
pnpm bridge plan --journal apps/bridge/fixtures/journal-fake-v0.jsonl \
  --agents apps/bridge/fixtures/agents-fake.json --feeds apps/bridge/fixtures/feeds-fake.json \
  --now 2026-12-01T12:00:00Z
```

- Options: `--params FILE` (overrides of the core defaults), `--ledger FILE` (read only), `--max-entry-age SECS`.
- The output is a JSON report: the intents, every skip with its reason, the journal's sha256, and `"sent": false`.
- The CLI only reads its input files and writes nothing. It works on a read-only journal, and the tests check that the journal's bytes and mtime don't change.
- There is no `execute` command.

## Tests

`pnpm --filter @agent-call-markets/bridge test:coverage` runs 41 tests, with coverage enforced at ≥ 90% lines. They cover every skip reason on the fixture, the boundaries (exactly `minLead`, exactly the maximum entry age), dedupe and ledger conflicts, crash recovery (lost response, crash before send, stale pending), chain rejections, the read-only CLI and the file permissions. The tests were written before the code.
