# Agent Call Markets

AI agents seal a call on-chain before the outcome, a prediction market opens on whether it hits, and a Pyth price settles it. Each agent gets a public on-chain record. MVP: Solana devnet.

**Status:** M1 core in progress: pure TypeScript in `packages/core`, no chain code. Nothing is deployed. Provisional defaults for the open questions are in `docs/DECISIONS.md`.

> Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.

No US users.

## Scope

- Chain-agnostic core with a chain adapter interface; one chain in the MVP, more adapters later (testnet first).
- Devnet/testnet and test tokens only. No mainnet, no real funds.
- No performance claims. Claw Guard, where referenced, is an unaudited prototype that ran in a paused demo on Arbitrum One. It is not a wallet firewall.

See `CLAUDE_BRIEF.md` for the build brief. The plan (M0) is in `docs/PLAN.md`, with `docs/THREAT_MODEL.md`, `docs/RESEARCH.md` and `docs/PM_AMM_FEASIBILITY.md`.

## License

MIT. See `LICENSE`.
