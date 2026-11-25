# Localnet and devnet runbook

> Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited.

No US users.

These steps are **for a human to run**. CI never touches devnet. CI only builds the program, runs it in LiteSVM, and runs one smoke flow on a local validator bound to 127.0.0.1. **Nothing has been deployed.** A devnet deploy needs Patrick's go-ahead (`CLAUDE_BRIEF.md` §9).

The CLI refuses mainnet and testnet whatever flags are passed. It checks the RPC's genesis hash before any read and again before every transaction (`packages/adapter-solana/README.md`, "Mainnet guard").

## Tools

- Node 22 and pnpm (`pnpm install --frozen-lockfile`).
- Agave CLI **v3.1.12**, for `cargo build-sbf`, `solana-test-validator` and `solana`. Use the same tarball and sha256 as `.github/workflows/ci.yml`.
- Optional: Anchor CLI **1.2.2**, only to regenerate the IDL.

```bash
cargo build-sbf --tools-version v1.52
```

## Localnet

The quickest path is the smoke script, which runs the whole flow through the CLI against a local validator:

```bash
pnpm --filter @agent-call-markets/adapter-solana smoke:localnet prepare /tmp/acm-smoke
```

```bash
. /tmp/acm-smoke/env && solana-test-validator --reset --bind-address 127.0.0.1 \
  --upgradeable-program "$PROGRAM_ID" target/deploy/call_markets.so "$AUTHORITY" \
  --account "$FIXTURE_ADDRESS" /tmp/acm-smoke/price-update.json
```

In a second terminal:

```bash
pnpm --filter @agent-call-markets/adapter-solana smoke:localnet run /tmp/acm-smoke
```

To drive it by hand:

1. Run `pnpm acm keygen`. Its address will be your agent and the upgrade authority.
2. Start `solana-test-validator --reset --bind-address 127.0.0.1 --upgradeable-program 4SG3dvvHerGBWpbCTTEfcSXRLCiPqBtgF9za8CTnFgVq target/deploy/call_markets.so <that address>`.
3. Run these, all on `--cluster localnet`, the default:
   1. `pnpm acm airdrop --sol 10`
   2. `pnpm acm admin init-mint`
   3. `pnpm acm admin init-config --mint <MINT> --feed <64 hex>`. It takes `DEFAULT_PARAMS`; `--params file.json` overrides them.
   4. `pnpm acm admin mint-to --mint <MINT> --to <ADDR> --amount 1000`
4. Seal and trade:
   1. `pnpm acm seal --feed <hex> --direction above --level 100 --expires-in 3600`
   2. `pnpm acm reveal <CALL>`
   3. `pnpm acm open <CALL>`
   4. `pnpm acm buy <CALL> --side yes --amount 100`
5. Settling needs a `PriceUpdateV2` account owned by the Pyth Core receiver that is the unique update covering the call's expiry. On localnet the only way to get one is to load it at validator start with `--account`, as the smoke script does. So for a hand-run settle, plan the expiry in advance.

## Devnet (only with the go-ahead; not done)

1. **Throwaway keys, locally.**
   - Run `pnpm acm keygen` (it writes `.devnet/keypair.json`).
   - Run `solana-keygen new --no-bip39-passphrase -o .devnet/program-keypair.json` for the program id.
   - `.devnet/` and `*keypair*.json` are gitignored. Never commit them, never paste them anywhere, never reuse them.
2. **Program id.**
   - The repo uses a placeholder id that no one holds.
   - Set the real one locally: `anchor keys sync`, or edit `declare_id!` and `Anchor.toml` by hand.
   - Rebuild with `cargo build-sbf`. A program id change is a separate, reviewed PR.
3. **Fund the deployer** with devnet SOL from the public faucet: `pnpm acm airdrop --cluster devnet --sol 2`, or faucet.solana.com. A deploy needs a few SOL.
4. **Deploy.** The deployer becomes the upgrade authority, which is the only key that can `init-config`:

   ```bash
   solana program deploy --url devnet --keypair .devnet/keypair.json \
     --program-id .devnet/program-keypair.json target/deploy/call_markets.so
   ```

5. **Config.**
   - `pnpm acm admin init-mint --cluster devnet --program-id <ID>`
   - `pnpm acm admin init-config --cluster devnet --program-id <ID> --mint <MINT> --feed <Pyth feed id hex>`
   - Feeds come only from this explicit list (Q4), and the parameters are the provisional Q9 defaults. The config can't be changed afterwards.
6. **Calls.** `seal`, `reveal`, `open` and `buy`, with `--cluster devnet --program-id <ID>`.
7. **Settlement.**
   - It needs the unique Pyth `PriceUpdateV2` covering expiry, posted on devnet by the Pyth receiver.
   - Where that comes from is open question **Q3**: the hosted price service needs an API key, and none is used here.
   - Until Q3 is answered, devnet calls can only be voided after `expiry + voidAfter` (72 h), which refunds the stakes.

## If something goes wrong

- `CLUSTER_NOT_ALLOWED`: the RPC isn't the cluster you named. Check `--url` and `--cluster`. There's no flag to bypass this.
- A lost salt file: the call can't be revealed and counts as a **miss**. Salts are in `.devnet/salts/<cluster>-<commitment>.json`.
- `program config is not initialized`: run `admin init-config` with the upgrade authority's key.
