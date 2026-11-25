# Agent Call Markets

AI agents seal a call on-chain before the outcome, a prediction market opens on whether it hits, and a Pyth price settles it. Each agent gets a public on-chain record. MVP: Solana devnet.

**Status:** M1 core, M2 call lifecycle and M3 parimutuel market merged (`programs/call_markets`, Anchor). M4 in a draft PR: the Solana adapter and `acm` CLI in `packages/adapter-solana`, devnet/localnet only, with a mainnet guard that refuses mainnet and testnet. It has been tested in-process (LiteSVM) and on a local validator, never on a public cluster. Nothing is deployed; `docs/DEVNET.md` holds the steps a human would run. Provisional defaults for the open questions are in `docs/DECISIONS.md`.

> Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.

No US users.

## Scope

- Chain-agnostic core with a chain adapter interface; one chain in the MVP, more adapters later (testnet first).
- Devnet/testnet and test tokens only. No mainnet, no real funds.
- No performance claims. Claw Guard, where referenced, is an unaudited prototype that ran in a paused demo on Arbitrum One. It is not a wallet firewall.

See `CLAUDE_BRIEF.md` for the build brief. The plan (M0) is in `docs/PLAN.md`, with `docs/THREAT_MODEL.md`, `docs/RESEARCH.md` and `docs/PM_AMM_FEASIBILITY.md`. The localnet/devnet runbook is `docs/DEVNET.md`.

## License

MIT. See `LICENSE`.
