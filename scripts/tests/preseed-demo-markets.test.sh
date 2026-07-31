#!/usr/bin/env bash
set -euo pipefail

TEST_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$TEST_DIR/../.." && pwd)
SCRIPT=$REPO_DIR/scripts/preseed-demo-markets.sh
SENTINEL_KEY='this-key-must-never-appear'

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  case "$haystack" in
    *"$needle"*) ;;
    *) fail "expected dry-run output to contain: $needle" ;;
  esac
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  case "$haystack" in
    *"$needle"*) fail "output unexpectedly contained: $needle" ;;
    *) ;;
  esac
}

bash -n "$SCRIPT"

# The deliberately unreachable RPC proves the default planning path performs no
# network read or write. Supplying a sentinel key also verifies it is ignored and
# never printed in dry-run mode.
output=$(env \
  ARC_RPC_URL=http://127.0.0.1:1 \
  PREDEX_PRIVATE_KEY="$SENTINEL_KEY" \
  "$SCRIPT")

assert_contains "$output" 'PREDEX D5a DEMO PRE-SEED — DRY RUN'
assert_contains "$output" 'No RPC reads. No cast send. No transaction can be broadcast.'
assert_contains "$output" 'Will Manchester United score above 70 Premier League goals in the 2026-27 season?'
assert_contains "$output" 'Will Ethereum trade above $5,000 before January 1, 2027?'
assert_contains "$output" 'Did Arc testnet reach block 53,405,070 before July 25, 2026 00:00 UTC?'
assert_contains "$output" 'Type exactly: Will Man Utd score over 70 goals in the 2026/27 Premier League season?'
assert_contains "$output" '0x4d014c3548af93bc3efe36031005fa3a110a4be0c6125f2fdd0be4fe2ce354b9'
assert_contains "$output" '0xc192bb7ee56c736c4df2eaafbad5510140adf30d18e5a35443bb9287c46b34ab'
assert_contains "$output" '0xfd3960a2e79265d6b88f957d23170218fe805069660d11291b8029a369a9e883'
assert_contains "$output" 'ancillaryData:  0x57696c6c204d616e6368657374657220556e69746564'
assert_contains "$output" 'create args:    seed=1000000 maxOpeningFee=0 window=2592000s'
assert_not_contains "$output" "$SENTINEL_KEY"

calldata_count=$(printf '%s\n' "$output" | grep -c '^  create calldata:0xd571bd46')
[ "$calldata_count" -eq 3 ] || fail "expected 3 derived createMarket calldata values, got $calldata_count"

# Even with --send, the Arc-only guard must stop before key validation or a cast
# send whenever a local endpoint is supplied.
if send_output=$(env \
  ARC_RPC_URL=http://127.0.0.1:8545 \
  PREDEX_PRIVATE_KEY="$SENTINEL_KEY" \
  "$SCRIPT" --send 2>&1); then
  fail '--send unexpectedly accepted a local RPC'
fi
assert_contains "$send_output" 'Arc USDC flows require real Arc.'
assert_not_contains "$send_output" "$SENTINEL_KEY"

printf '%s\n' 'PASS: preseed demo plan derivation and no-broadcast guards'
