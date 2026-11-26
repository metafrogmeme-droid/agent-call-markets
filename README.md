# Agent Call Markets

AI agents seal a call on chain before the outcome is known. A small prediction market opens on whether it hits, a Pyth price settles it, and each agent gets a public on-chain record. Agents with receipts, not screenshots.

> Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.

No US users.

**Status:** Milestones M0–M6 are merged, and M7 (demo and docs) is in a draft PR. Everything has been tested in-process and on a local validator, never on a public cluster. **Nothing is deployed.** Provisional defaults for the open questions are in [docs/DECISIONS.md](docs/DECISIONS.md).

## How it works

1. **Seal.** An agent commits a hash of its call (asset feed, direction, level, expiry) with a random salt. The call stays hidden, and the agent can't change it.
2. **Reveal.** In a later slot the agent opens the commitment. A call that isn't revealed in time counts as a miss.
3. **Market.** Anyone can open a **parimutuel pool** on a revealed call and stake test tokens on YES or NO, with no fees. This is the fallback engine named in the brief: pm-AMM is not used (see [docs/PM_AMM_FEASIBILITY.md](docs/PM_AMM_FEASIBILITY.md)).
4. **Settle.** Anyone can settle with **exactly one Pyth price update**: the unique update covering expiry, from the pinned Pyth Core receiver. Checks fail closed, and no admin can override an outcome.
5. **Record.** A static page shows each agent's raw counts and hit rate, with its sample size, computed from chain data only. Every outcome is re-checked against the core rule.

More detail and diagrams are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quickstart (local only)

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` runs lint, format, typecheck and every TypeScript test. The Rust tests run with `cargo test --locked`.

**End-to-end demo on a local validator.** This needs the Agave CLI v3.1.12 and the built program, `cargo build-sbf --tools-version v1.52`:

```bash
pnpm demo:localnet
```

It seals a call, reveals it, opens a market, settles from a synthetic Pyth price update, redeems, and builds the record page. The recording script is [docs/DEMO.md](docs/DEMO.md).

**Record page offline, from synthetic data:**

```bash
pnpm web build --snapshot apps/web/fixtures/snapshot-fake.json --out /tmp/acm-site
```

## Repository

| Path | What |
|---|---|
| `packages/core` | Chain-agnostic reference spec: seal format, rules, pool and record maths, the `ChainAdapter` interface |
| `programs/call_markets` | Anchor program for Solana |
| `packages/adapter-solana` | Solana adapter and the `acm` CLI, devnet/localnet only ([README](packages/adapter-solana/README.md)) |
| `apps/bridge` | Journal → sealed-call planner: dry run, read-only on journals ([README](apps/bridge/README.md)) |
| `apps/web` | Public record page: static, no scripts, read-only ([README](apps/web/README.md)) |
| `tools/doccheck` | Checks on these docs |
| `scripts/demo-localnet.sh` | The end-to-end local demo (CI runs it too) |

## Safety and honesty

- **Devnet and localnet only.** The adapter checks the RPC's genesis hash before any read and before every transaction. Mainnet and testnet are always refused, with no override.
- **Test tokens only. No keys in the repo.** Throwaway keys are created locally in a gitignored `.devnet/` folder. CI needs no secrets and runs gitleaks and Semgrep on every push.
- **Unaudited hackathon code.** Threats and how each is handled are in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
- **No performance claims, no results figures.** The record page shows live chain data only.
- **No endorsement** by PREDICT, Pyth, the Solana Foundation or AudaceFi is claimed.
- Claw Guard, where referenced, is an unaudited prototype that ran in a paused demo on Arbitrum One. It is not a wallet firewall, and it is not part of this product.
- Running on devnet is a human-run step that needs a go-ahead ([docs/DEVNET.md](docs/DEVNET.md)). Devnet settlement waits on the devnet Pyth price source (open question Q3).

## Built for the hackathon

The repository starts on 22 Nov 2026 with the build brief (`CLAUDE_BRIEF.md`). Everything else was added during the event, in milestone pull requests M0–M7: the plan ([docs/PLAN.md](docs/PLAN.md)), the core, the program, the market, the adapter and CLI, the bridge, the record page, and these docs. Submitting needs an explicit yes from the project owner.

## License

MIT. See [LICENSE](LICENSE).
