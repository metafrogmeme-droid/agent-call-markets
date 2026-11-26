# @agent-call-markets/web

> Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.

No US users.

The public record page (M6). It is a **static, script-free** site built from **chain data only**, and it is **read-only**: no wallet, no signing, no keys. It is built locally; hosting it publicly would be a deploy and needs a go-ahead.

## What the page shows

- **Index:** every listed agent, sorted by label (never ranked), with its raw counts:
  - sealed, revealed, pending;
  - hits, misses (and how many of those are unrevealed);
  - voids;
  - calls where the agent's own key traded.

  Next to them is the hit rate, always with its sample size and voids, using the core's `formatHitRate` (rounded down). It also explains how calls are counted.
- **Agent page:** each call, with:
  - its record status, seal time, expiry and reveal deadline;
  - the call itself once revealed (direction, level, feed, and the public salt, so anyone can recompute the commitment), or "hidden until reveal" before that;
  - the outcome stored on chain, and **the core's re-check of it**: every settled outcome is re-derived from the stored observation, and a difference is shown in red and counted on the index;
  - the settlement price and the own-key self-trade flag.
- **Every page** carries the verbatim disclaimer and "No US users" in its header and footer. It also notes that self-trading from other wallets cannot be detected (threat model item 4). Fixture data carries a "synthetic test data" banner.

Nothing else is shown: no PnL, no rankings, no claims.

## Security (threat model item 8)

- There is no JavaScript. Every page sets `Content-Security-Policy: default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'` (a meta tag) and `no-referrer`.
- One local stylesheet. Relative links only. No fonts, images, frames, forms or external URLs.
- Every interpolated value is HTML-escaped. Tests use hostile labels, and seals carry no free text anyway.
- Chain reads go through the Solana adapter **without a signer**: devnet or localnet only, with the genesis-hash guard, so mainnet and testnet are refused.

## Build

```bash
# Offline, from the synthetic fixture snapshot:
pnpm web build --snapshot apps/web/fixtures/snapshot-fake.json --out /tmp/acm-site

# From a local validator or devnet (read-only):
pnpm web build --cluster localnet --agents agents.json --out /tmp/acm-site
pnpm web snapshot --cluster devnet --agents agents.json --out snapshot.json
```

- `agents.json` maps agent labels to 32-byte public ids (hex), the same format as the bridge's agents map.
- Open `index.html` from `--out` in a browser.
- `snapshot` writes `acm-record-snapshot/v1`: deterministic JSON of exactly the chain data a page was built from. `build --snapshot` rebuilds the same pages offline.

## Tests

`pnpm --filter @agent-call-markets/web test:coverage`, with coverage enforced. The tests were written first. They cover:
- the model, against the core's `MemoryAdapter` with calls in every record state;
- the snapshot codec;
- rendering: CSP, no scripts or handlers or external URLs, the disclaimer on every page, escaping, no performance wording;
- a deterministic build with resolvable links;
- the CLI, including the refusal of mainnet and testnet.

In CI the `adapter` job also builds the page from the localnet smoke validator through the read-only adapter. It checks the record and the outcome re-check, fails on any script or external URL, and uploads the page as an artifact.
