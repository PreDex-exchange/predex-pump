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

assert_equals() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  [ "$actual" = "$expected" ] || fail "$label"
}

extract_questions() {
  printf '%s\n' "$1" | awk '
    /^  question:       / {
      sub(/^  question:       /, "")
      print
      next
    }
    /^  Type exactly: / {
      sub(/^  Type exactly: /, "")
      print
    }
  '
}

extract_hashes() {
  printf '%s\n' "$1" | awk '$1 == "metadataHash:" { print $2 }'
}

line_at() {
  printf '%s\n' "$1" | sed -n "${2}p"
}

nonempty_line_count() {
  printf '%s\n' "$1" | awk 'NF { count += 1 } END { print count + 0 }'
}

assert_disjoint_sets() {
  local left="$1"
  local right="$2"
  local label="$3"
  local item
  while IFS= read -r item; do
    [ -z "$item" ] && continue
    if printf '%s\n' "$right" | grep -Fqx "$item"; then
      fail "$label: shared value $item"
    fi
  done <<EOF
$left
EOF
}

canonical_subject() {
  printf '%s\n' "$1" | sed -E \
    -e 's/.*Manchester United.*/manchester-united/' \
    -e 's/.*Man Utd.*/manchester-united/'
}

goal_threshold() {
  printf '%s\n' "$1" | sed -E 's/.* (above|over) ([0-9]+).*/\2/'
}

season_period() {
  printf '%s\n' "$1" | sed -E 's/.*(20[0-9][0-9])[-\/]([0-9][0-9]).*/\1-\2/'
}

bash -n "$SCRIPT"

# The deliberately unreachable RPC proves the default planning path performs no
# network read or write. Supplying a sentinel key also verifies it is ignored and
# never printed in dry-run mode.
default_output=$(env \
  ARC_RPC_URL=http://127.0.0.1:1 \
  PREDEX_PRIVATE_KEY="$SENTINEL_KEY" \
  "$SCRIPT")

assert_contains "$default_output" 'PREDEX D5a DEMO PRE-SEED — DRY RUN'
assert_contains "$default_output" 'No RPC reads. No cast send. No transaction can be broadcast.'
assert_contains "$default_output" 'ancillaryData:  0x57696c6c204d616e6368657374657220556e69746564'
assert_contains "$default_output" 'create args:    seed=1000000 maxOpeningFee=0 window=2592000s'
assert_not_contains "$default_output" "$SENTINEL_KEY"

default_questions=$(extract_questions "$default_output")
expected_default_questions=$(printf '%s\n' \
  'Will Manchester United score above 70 Premier League goals in the 2026-27 season?' \
  'Will Ethereum trade above $5,000 before January 1, 2027?' \
  'Did Arc testnet reach block 60,387,670 before September 5, 2026 00:00 UTC?' \
  'Will Man Utd score over 70 goals in the 2026/27 Premier League season?')
assert_equals \
  "$default_questions" \
  "$expected_default_questions" \
  'default questions changed'

default_hashes=$(extract_hashes "$default_output")
expected_default_hashes=$(printf '%s\n' \
  '0x4d014c3548af93bc3efe36031005fa3a110a4be0c6125f2fdd0be4fe2ce354b9' \
  '0xc192bb7ee56c736c4df2eaafbad5510140adf30d18e5a35443bb9287c46b34ab' \
  '0x44b37b2e95e198d62da14b6e0fa09d6d56a9853ae4980d7c1871f3f309bd9dc7' \
  '0xd35a2987a9f4a146dd230ca57168327e34cf4bb286e232e486c0f389be3fb727')
assert_equals \
  "$default_hashes" \
  "$expected_default_hashes" \
  'default metadata hashes changed'

calldata_count=$(printf '%s\n' "$default_output" | grep -c '^  create calldata:0xd571bd46')
[ "$calldata_count" -eq 3 ] || fail "expected 3 derived createMarket calldata values, got $calldata_count"

run_id_a='qa-2026-08-12'
run_id_b='qa-2026-08-13'
run_output_a=$(env \
  ARC_RPC_URL=http://127.0.0.1:1 \
  PREDEX_PRIVATE_KEY="$SENTINEL_KEY" \
  "$SCRIPT" --dry-run --run-id "$run_id_a")
run_output_a_repeat=$(env \
  ARC_RPC_URL=http://127.0.0.1:1 \
  PREDEX_PRIVATE_KEY="$SENTINEL_KEY" \
  "$SCRIPT" --run-id "$run_id_a" --dry-run)
run_output_b=$(env \
  ARC_RPC_URL=http://127.0.0.1:1 \
  PREDEX_PRIVATE_KEY="$SENTINEL_KEY" \
  "$SCRIPT" --dry-run --run-id "$run_id_b")

assert_contains "$run_output_a" "Run ID:          $run_id_a"
assert_contains "$run_output_a" 'First use:       create markets with this run ID; the dedup market is created through the operator cue'
assert_contains "$run_output_a" 'Repeat use:      reuse markets with these metadata hashes; never duplicate'
assert_not_contains "$run_output_a" "$SENTINEL_KEY"

run_questions_a=$(extract_questions "$run_output_a")
run_questions_a_repeat=$(extract_questions "$run_output_a_repeat")
run_questions_b=$(extract_questions "$run_output_b")
run_hashes_a=$(extract_hashes "$run_output_a")
run_hashes_a_repeat=$(extract_hashes "$run_output_a_repeat")
run_hashes_b=$(extract_hashes "$run_output_b")
question_tag_a=$(printf '%s\n' "$run_output_a" | sed -n 's/^  Question tag:    //p')
question_tag_a_repeat=$(printf '%s\n' "$run_output_a_repeat" | sed -n 's/^  Question tag:    //p')
question_tag_b=$(printf '%s\n' "$run_output_b" | sed -n 's/^  Question tag:    //p')
run_suffix_a=" $question_tag_a"

[ "$(nonempty_line_count "$run_questions_a")" -eq 4 ] || fail 'expected four run-scoped questions'
[ "$(nonempty_line_count "$run_hashes_a")" -eq 4 ] || fail 'expected four run-scoped metadata hashes'
printf '%s\n' "$question_tag_a" | grep -Eq '^\[Predex demo seed run tag: [a-p]{64}\]$' || \
  fail 'question tag was not a 256-bit letters-only namespace'
assert_equals "$question_tag_a" "$question_tag_a_repeat" 'same run ID derived a different question tag'
[ "$question_tag_a" != "$question_tag_b" ] || fail 'different run IDs derived the same question tag'
assert_not_contains "$run_questions_a" "$run_id_a"
assert_equals "$run_questions_a" "$run_questions_a_repeat" 'same run ID derived different questions'
assert_equals "$run_hashes_a" "$run_hashes_a_repeat" 'same run ID derived different metadata hashes'
assert_disjoint_sets "$default_hashes" "$run_hashes_a" 'run-scoped hashes overlap the default set'
assert_disjoint_sets "$run_hashes_a" "$run_hashes_b" 'different run IDs produced overlapping hashes'

question_number=1
while [ "$question_number" -le 4 ]; do
  default_question=$(line_at "$default_questions" "$question_number")
  run_question=$(line_at "$run_questions_a" "$question_number")
  [ "$run_question" != "$default_question" ] || \
    fail "run-scoped question $question_number matched its default"
  assert_equals \
    "${run_question%"$run_suffix_a"}" \
    "$default_question" \
    "run ID changed the structure of question $question_number"
  case "$run_question" in
    *"$run_suffix_a") ;;
    *) fail "question $question_number did not use the shared run suffix" ;;
  esac
  question_number=$((question_number + 1))
done

# The run identifier is the same non-semantic suffix on both near-duplicates.
# Their underlying subject, threshold, competition, and period remain aligned.
bootstrap_question=$(line_at "$run_questions_a" 1)
dedup_question=$(line_at "$run_questions_a" 4)
bootstrap_fact=${bootstrap_question%"$run_suffix_a"}
dedup_fact=${dedup_question%"$run_suffix_a"}
assert_equals \
  "$(canonical_subject "$bootstrap_fact")" \
  "$(canonical_subject "$dedup_fact")" \
  'bootstrap/dedup subjects diverged'
assert_equals \
  "$(goal_threshold "$bootstrap_fact")" \
  "$(goal_threshold "$dedup_fact")" \
  'bootstrap/dedup thresholds diverged'
assert_equals \
  "$(season_period "$bootstrap_fact")" \
  "$(season_period "$dedup_fact")" \
  'bootstrap/dedup periods diverged'
assert_contains "$bootstrap_fact" 'Premier League'
assert_contains "$dedup_fact" 'Premier League'

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

# A broadcast request against the configured Arc endpoint still stops locally
# unless a runtime key is present. No RPC call occurs before this check.
if no_key_output=$(env -u PREDEX_PRIVATE_KEY \
  "$SCRIPT" --send --run-id "$run_id_a" 2>&1); then
  fail '--send unexpectedly proceeded without a runtime key'
fi
assert_contains "$no_key_output" 'PREDEX_PRIVATE_KEY is required at runtime with --send.'

printf '%s\n' 'PASS: preseed demo plan derivation and no-broadcast guards'
