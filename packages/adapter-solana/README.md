# @agent-call-markets/adapter-solana

> Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.

No US users.

The Solana `ChainAdapter` for the `call_markets` Anchor program (`programs/call_markets`), plus the `acm` CLI. **Devnet and localnet only. Mainnet is always refused.** Nothing has been deployed; the devnet steps in `docs/DEVNET.md` are for a human to run.

## What it does

- `SolanaAdapter` implements the core `ChainAdapter` (`packages/core/src/adapter/types.ts`): seal, reveal, open, quote, trade, redeem, settle, void, get and list calls.
- **The adapter moves data; the program decides.** The adapter doesn't repeat the core's checks before sending. Every rejection comes from the program and is mapped onto a core `ErrorCode` through the program's error list. The shared conformance suite runs against this adapter and against the core's `MemoryAdapter`, and both show the same behaviour.
- Client-side checks happen only where nothing can be sent:
  - a read-only instance → `READ_ONLY`;
  - an `inline` oracle ref → `UNSUPPORTED_ORACLE_REF`;
  - an unknown call → `UNKNOWN_CALL`;
  - a commitment this agent already sealed → `DUPLICATE_CALL`;
  - no unredeemed position → `NOT_REDEEMABLE` or `NOTHING_TO_REDEEM`, in the core's order;
  - no test-token account → `INSUFFICIENT_BALANCE`.
- `getCall` / `listCalls` map chain data to the core `CallState`, so the record is computed by the core from chain data only. For a settled call, the core's rule is re-applied to the stored observation and compared with the on-chain outcome (`outcomeCheck: "match" | "mismatch"`).

## Mainnet guard

Fail closed, with no override (`src/guard.ts`, docs/THREAT_MODEL.md item 12):

| Expected cluster | Accepted only if |
|---|---|
| any | the RPC's genesis hash is **not** mainnet-beta (`5eykt4Us…`) or testnet (`4uhcVJy…`): these are always refused |
| `devnet` | the genesis hash is exactly devnet's (`EtWTRABZ…`) |
| `localnet` | the RPC host is loopback (`127.0.0.0/8`, `localhost`, `::1`) **and** the genesis hash is not a public cluster's |

- The genesis hashes come from Anza's `solana-cluster-type` crate.
- `SolanaAdapter.connect()` is the only way to construct an adapter, and it applies the guard. The guard runs **again right before every transaction**, so an endpoint that changes after connecting gets nothing signed.
- The CLI's `--cluster` accepts only `devnet` or `localnet`. `Anchor.toml` has no mainnet cluster.
- In tests an in-process LiteSVM transport counts as localnet. It lives in `test/svm/` and isn't exported.

## Pyth price updates

- `settle` takes the address of **one existing** Pyth `PriceUpdateV2` account. The program accepts only accounts owned by the pinned Pyth Core receiver `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` and exactly one update per market. The same update again fails with `DUPLICATE_PRICE_UPDATE`; any other update fails with `ALREADY_SETTLED`.
- The adapter never posts price updates and holds no API key. Where devnet prices come from is still open question Q3, so **devnet settlement waits on Q3**. Until then, an unsettled call can be voided after `expiry + voidAfter`, and the stakes are refunded.
- On localnet and in tests, synthetic `PriceUpdateV2` accounts (`src/testing`) stand in for real ones.

## CLI

```
pnpm acm --help
```

| Command | What it does |
|---|---|
| `keygen` | throwaway keypair at `.devnet/keypair.json` (0600, never overwritten, never printed) |
| `airdrop [--sol N]` | devnet/localnet faucet |
| `admin init-mint` / `mint-to` / `init-config` | test mint, test tokens, one-time config (upgrade authority only) |
| `seal --feed HEX --direction above\|below --level DEC --expiry TS` | seal a call; the salt goes to `.devnet/salts/` **before** sending |
| `reveal CALL`, `open CALL` | reveal from the saved salt; open the market |
| `quote`, `buy CALL --side yes\|no --amount N` | parimutuel quote and stake |
| `settle CALL --price-update ADDR` | settle from one price account |
| `void CALL`, `redeem CALL` | void after the window; redeem positions |
| `show CALL`, `list [--agent ADDR]` | the call with the core's outcome re-check; an agent's raw counts and hit rate with n |

- Flags: `--cluster devnet|localnet` (default `localnet`), `--url`, `--keypair`, `--program-id`. Output is JSON.
- Key files readable by other users are refused.
- **A lost salt file means the call can't be revealed, and it counts as a miss.**

## Tests

| Command | What runs | Needs |
|---|---|---|
| `pnpm --filter @agent-call-markets/adapter-solana test` | unit tests: layouts vs the IDL, guard, Pyth decoding, error mapping, CLI files and parsing, RPC transport against a scripted local JSON-RPC server | nothing |
| `… test:svm` | the above, plus the shared conformance suite, the adapter tests and a full CLI run against the **compiled program** in LiteSVM, with enforced coverage | `target/deploy/call_markets.so` (`cargo build-sbf`) or `CALL_MARKETS_SO` |
| `… smoke:localnet prepare DIR` / `run DIR` | the CLI end to end on a real `solana-test-validator` on 127.0.0.1 (see the script header) | Agave CLI |

The layouts in `src/codec/program.ts` are checked field by field against `idl/call_markets.json`. CI regenerates that IDL with the pinned Anchor CLI and fails on any difference.
