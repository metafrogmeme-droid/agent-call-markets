#!/usr/bin/env bash
# Agent Call Markets: the end-to-end demo on a local validator (127.0.0.1 only).
#
#   seal -> reveal -> market -> settle from one Pyth price update -> redeem -> record page
#
# Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not
# financial advice. Unaudited. No US users.
#
# Localnet only: a fresh solana-test-validator bound to 127.0.0.1, throwaway keys in a temp
# directory, test tokens, and a synthetic Pyth PriceUpdateV2 (owned by the pinned receiver) loaded
# at validator start. Nothing here talks to a public cluster. CI runs this same script.
#
# Usage: pnpm demo:localnet        (DEMO_DIR=/some/dir to choose where files go)
# Needs: pnpm, solana-test-validator (Agave CLI v3.1.12) and the built program
#        (cargo build-sbf --tools-version v1.52, or CALL_MARKETS_SO=/path/to/call_markets.so).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SO="${CALL_MARKETS_SO:-$ROOT/target/deploy/call_markets.so}"
DEMO_DIR="${DEMO_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/acm-demo.XXXXXX")}"
RPC_PORT=8899

say() { printf '\n== %s\n' "$*"; }
fail() { printf 'demo: %s\n' "$*" >&2; exit 1; }

command -v pnpm >/dev/null || fail "pnpm is required"
command -v solana-test-validator >/dev/null || fail "solana-test-validator is required (Agave CLI v3.1.12)"
[[ -f "$SO" ]] || fail "program not built: run cargo build-sbf --tools-version v1.52 (or set CALL_MARKETS_SO)"
if (exec 3<>"/dev/tcp/127.0.0.1/$RPC_PORT") 2>/dev/null; then
  fail "something already listens on 127.0.0.1:$RPC_PORT; stop it first (the demo starts its own validator)"
fi
mkdir -p "$DEMO_DIR"

say "Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited. No US users."
echo "Working directory: $DEMO_DIR"

say "1/4 Prepare: throwaway keys, test parameters, a synthetic Pyth price update"
pnpm --filter @agent-call-markets/adapter-solana smoke:localnet prepare "$DEMO_DIR"
# shellcheck disable=SC1091 # written by the prepare step
. "$DEMO_DIR/env"

say "2/4 Start a local validator on 127.0.0.1 with the program and the price update"
solana-test-validator --reset --quiet --ledger "$DEMO_DIR/ledger" \
  --bind-address 127.0.0.1 --rpc-port "$RPC_PORT" \
  --upgradeable-program "$PROGRAM_ID" "$SO" "$AUTHORITY" \
  --account "$FIXTURE_ADDRESS" "$DEMO_DIR/price-update.json" \
  >"$DEMO_DIR/validator.log" 2>&1 &
VALIDATOR_PID=$!
trap 'kill "$VALIDATOR_PID" 2>/dev/null || true' EXIT

say "3/4 The call: seal, reveal, market, settle (one price update), redeem"
pnpm --filter @agent-call-markets/adapter-solana smoke:localnet run "$DEMO_DIR"

say "4/4 The record page, built from this chain through the read-only adapter"
pnpm --filter @agent-call-markets/web cli build --cluster localnet \
  --agents "$DEMO_DIR/agents.json" --out "$DEMO_DIR/record-page"
grep -q 'hit rate (1 of 1 decided; 0 voids)' "$DEMO_DIR/record-page/index.html" ||
  fail "the record page does not show the expected record"
grep -q 'matches the core rule' "$DEMO_DIR/record-page/agents/"*.html ||
  fail "the record page does not show the outcome re-check"
if grep -rqiE '<script|https?://' "$DEMO_DIR/record-page"; then
  fail "the record page must be script-free and self-contained"
fi

say "Done. Open $DEMO_DIR/record-page/index.html in a browser."
echo "Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and not financial advice. Unaudited. No US users."
