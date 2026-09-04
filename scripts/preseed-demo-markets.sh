#!/usr/bin/env bash
# Prepare the D5a demo on the deployed Arc testnet stack.
#
# Arc's 6-decimal USDC touches a blocklist precompile, so every state-changing
# operation below is a direct `cast send` to REAL Arc. This script never invokes
# a local simulation or eth_call against a write method. macOS bash 3.2 compatible.
set -euo pipefail

ARC_CHAIN_ID=5042002
ARC_RPC_URL=${ARC_RPC_URL:-https://rpc.testnet.arc.network}
ARC_EXPLORER_URL=${ARC_EXPLORER_URL:-https://testnet.arcscan.app}
CAST_BIN=${CAST_BIN:-cast}

USDC=0x3600000000000000000000000000000000000000
CTF=0x53222F4e8Dc81B02421B33F84A79f12de3bc240D
ORACLE=0xf6a765fB79e31e62733EcAEbbED7d96d56386877
LMSR=0x16Ec1d8962014e5F488C319C0d7388aDCa032321
REGISTRY=0x5eb4f6320Cb52E3C8BdB146f1E5DD8B148af7f62
MINICLOB=0xDf3DDD60f0dC36e9459473C7c9391251bB301d2f

SEED_RAW=1000000
MAX_OPENING_FEE_RAW=0
TRADING_WINDOW_SECONDS=2592000
YES_INVENTORY_TARGET_RAW=250000
APPROVAL_RAW=1000000000
SLIPPAGE_BPS=200
BPS_SCALE=10000

BOOTSTRAP_QUESTION='Will Manchester United score above 70 Premier League goals in the 2026-27 season?'
GRADUATED_QUESTION='Will Ethereum trade above $5,000 before January 1, 2027?'
RESOLUTION_QUESTION='Did Arc testnet reach block 60,387,670 before September 5, 2026 00:00 UTC?'
DEDUP_OPERATOR_QUESTION='Will Man Utd score over 70 goals in the 2026/27 Premier League season?'

DEFAULT_PARAMS_SIG='defaultParams()((uint96,uint96,uint96,uint96,uint96,uint96,uint96,uint96,uint96,uint96,uint96,uint32,uint32,uint32,uint32,uint16,uint16))'
MARKET_LIFECYCLE_SIG='marketLifecycle(uint256)(address,uint32,uint8,bool,uint32,uint32,uint32,uint32,uint32)'
MARKET_METADATA_SIG='marketMetadata(uint256)(bytes32,bytes32,bytes32,bytes32,uint256,uint256)'
TOKEN_BINDING_SIG='tokenBinding(uint256)(address,address,address,bytes32,bytes32,uint256,uint256)'
AMM_STATE_SIG='ammState(uint256)((uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,bool,bool,bool,uint256,uint256,uint256,bool))'
QUOTE_BUY_SIG='quoteBuy(uint256,uint8,uint256,uint256,uint256)((uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256))'
CREATE_SIG='createMarket(bytes,uint256,uint256,uint256,bytes32)'

SEND=0
RUN_ID=''
RUN_ID_SET=0
QUESTION_TAG=''
PRIVATE_KEY=''
OPERATOR=''
OPENING_FEE_RAW=$MAX_OPENING_FEE_RAW
GRADUATION_TOLL_RAW=0
LAST_TX_HASH=''
MARKET_ID=''
CONDITION_ID=''
QUESTION_ID=''
YES_TOKEN_ID=''
NO_TOKEN_ID=''
BOOTSTRAP_MARKET_ID=''
GRADUATED_MARKET_ID=''
RESOLUTION_MARKET_ID=''

usage() {
  printf '%s\n' \
    'Usage: scripts/preseed-demo-markets.sh [--dry-run | --send] [--run-id ID]' \
    '' \
    'Default: --dry-run (offline planning only; no RPC reads and no broadcasts).' \
    '--send:   read PREDEX_PRIVATE_KEY at runtime and send direct transactions to Arc.' \
    '--run-id: derive a distinct, repeatable market set for this operator-supplied ID.'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) SEND=0 ;;
    --send) SEND=1 ;;
    --run-id)
      if [ "$#" -lt 2 ]; then
        printf 'ERROR: --run-id requires a value.\n' >&2
        usage >&2
        exit 2
      fi
      if [ "$RUN_ID_SET" -eq 1 ]; then
        printf 'ERROR: --run-id may only be supplied once.\n' >&2
        exit 2
      fi
      RUN_ID=$2
      RUN_ID_SET=1
      shift
      ;;
    --run-id=*)
      if [ "$RUN_ID_SET" -eq 1 ]; then
        printf 'ERROR: --run-id may only be supplied once.\n' >&2
        exit 2
      fi
      RUN_ID=${1#--run-id=}
      RUN_ID_SET=1
      ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'ERROR: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ "$RUN_ID_SET" -eq 1 ]; then
  if [ -z "$RUN_ID" ] || [ "${#RUN_ID}" -gt 64 ] || \
     ! printf '%s\n' "$RUN_ID" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$'; then
    printf '%s\n' \
      'ERROR: --run-id must be 1-64 ASCII letters, digits, dots, underscores, or hyphens and start with a letter or digit.' >&2
    exit 2
  fi
fi

if ! command -v "$CAST_BIN" >/dev/null 2>&1; then
  printf 'ERROR: cast is required (Foundry). CAST_BIN=%s\n' "$CAST_BIN" >&2
  exit 1
fi

if [ "$RUN_ID_SET" -eq 1 ]; then
  RUN_ID_BYTES=$("$CAST_BIN" from-utf8 "$RUN_ID")
  RUN_ID_DIGEST=$("$CAST_BIN" keccak "$RUN_ID_BYTES")
  RUN_TAG=$(printf '%s' "${RUN_ID_DIGEST#0x}" | \
    tr '[:upper:]' '[:lower:]' | \
    tr '0123456789abcdef' 'abcdefghijklmnop')
  QUESTION_TAG="[Predex demo seed run tag: $RUN_TAG]"
  BOOTSTRAP_QUESTION="$BOOTSTRAP_QUESTION $QUESTION_TAG"
  GRADUATED_QUESTION="$GRADUATED_QUESTION $QUESTION_TAG"
  RESOLUTION_QUESTION="$RESOLUTION_QUESTION $QUESTION_TAG"
  DEDUP_OPERATOR_QUESTION="$DEDUP_OPERATOR_QUESTION $QUESTION_TAG"
fi

lowercase() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

strip_annotations() {
  sed -E 's/ \[[^]]*\]//g'
}

cast_tokens() {
  printf '%s\n' "$1" | strip_annotations | tr '(),\n' '   '
}

token_at() {
  cast_tokens "$1" | awk -v n="$2" '{ print $n }'
}

scalar() {
  token_at "$1" 1
}

ancillary_for_question() {
  local encoded
  encoded=$("$CAST_BIN" from-utf8 "$1")
  printf '%s00\n' "$encoded"
}

metadata_for_ancillary() {
  "$CAST_BIN" keccak "$1"
}

print_market_plan() {
  local number="$1"
  local beat="$2"
  local question="$3"
  local actions="$4"
  local ancillary metadata calldata
  ancillary=$(ancillary_for_question "$question")
  metadata=$(metadata_for_ancillary "$ancillary")
  calldata=$("$CAST_BIN" calldata "$CREATE_SIG" \
    "$ancillary" "$SEED_RAW" "$MAX_OPENING_FEE_RAW" \
    "$TRADING_WINDOW_SECONDS" "$metadata")

  printf '\n[%s] %s\n' "$number" "$beat"
  printf '  question:       %s\n' "$question"
  printf '  ancillaryData:  %s\n' "$ancillary"
  printf '  metadataHash:   %s\n' "$metadata"
  printf '  create args:    seed=%s maxOpeningFee=%s window=%ss\n' \
    "$SEED_RAW" "$MAX_OPENING_FEE_RAW" "$TRADING_WINDOW_SECONDS"
  printf '  create calldata:%s\n' "$calldata"
  printf '  target actions: %s\n' "$actions"
  printf '  idempotency:    reuse the market with this metadataHash; never create twice\n'
  if [ "$RUN_ID_SET" -eq 1 ]; then
    printf '  expected:       create on first use of this run ID; reuse on repeats\n'
  else
    printf '  expected:       reuse the canonical market if present; otherwise create it\n'
  fi
}

print_plan() {
  local dedup_ancillary dedup_metadata
  if [ "$SEND" -eq 1 ]; then
    printf 'PREDEX D5a DEMO PRE-SEED — BROADCAST REQUESTED\n'
  else
    printf 'PREDEX D5a DEMO PRE-SEED — DRY RUN\n'
    printf 'No RPC reads. No cast send. No transaction can be broadcast.\n'
  fi
  printf '\nSeed identity\n'
  if [ "$RUN_ID_SET" -eq 1 ]; then
    printf '  Run ID:          %s\n' "$RUN_ID"
    printf '  Question tag:    %s\n' "$QUESTION_TAG"
    printf '%s\n' \
      '  First use:       create markets with this run ID; the dedup market is created through the operator cue'
    printf '%s\n' \
      '  Repeat use:      reuse markets with these metadata hashes; never duplicate'
  else
    printf '  Run ID:          (none; canonical default market set)\n'
    printf '  Question tag:    (none; canonical question text)\n'
    printf '%s\n' \
      '  Expected:        reuse canonical markets when present; create only missing markets'
  fi
  printf '\nDeployment (Arc testnet chainId %s)\n' "$ARC_CHAIN_ID"
  printf '  RPC:       %s\n' "$ARC_RPC_URL"
  printf '  Registry:  %s\n' "$REGISTRY"
  printf '  LMSR:      %s\n' "$LMSR"
  printf '  MiniCLOB:  %s\n' "$MINICLOB"
  printf '  Oracle:    %s\n' "$ORACLE"
  printf '  CTF:       %s\n' "$CTF"
  printf '  USDC:      %s (6 decimals)\n' "$USDC"
  printf '\nShared setup (send mode checks first and skips sufficient approvals)\n'
  printf '  ERC-20 approve Registry, LMSR, MiniCLOB up to %s raw\n' "$APPROVAL_RAW"
  printf '  ERC-1155 setApprovalForAll LMSR and MiniCLOB\n'

  print_market_plan \
    1 \
    'BOOTSTRAP + NEAR-DUPLICATE BEAT' \
    "$BOOTSTRAP_QUESTION" \
    'create; leave Opened and immediately tradable on the LMSR curve'
  print_market_plan \
    2 \
    'GRADUATED BOOK BEAT' \
    "$GRADUATED_QUESTION" \
    'create; buy 0.25 YES; graduate; verify non-zero MiniCLOB seed depth'
  print_market_plan \
    3 \
    'COMMITTEE RESOLUTION / REDEEM BEAT' \
    "$RESOLUTION_QUESTION" \
    'create; buy 0.25 YES for the operator; graduate; leave oracle unresolved'

  dedup_ancillary=$(ancillary_for_question "$DEDUP_OPERATOR_QUESTION")
  dedup_metadata=$(metadata_for_ancillary "$dedup_ancillary")
  printf '\nCreation-time dedup cue\n'
  printf '  Seeded: %s\n' "$BOOTSTRAP_QUESTION"
  printf '  Type exactly: %s\n' "$DEDUP_OPERATOR_QUESTION"
  printf '  metadataHash:   %s\n' "$dedup_metadata"
  printf '  Expected cue: Manchester United / Man Utd alias + above / over paraphrase\n'
  if [ "$RUN_ID_SET" -eq 1 ]; then
    printf '%s\n' \
      '  Expected action: create through the operator flow on first use; reuse on repeats'
  else
    printf '%s\n' \
      '  Expected action: reuse the canonical dedup market if present; otherwise create it through the operator flow'
  fi

  if [ "$SEND" -eq 0 ]; then
    printf '\nDRY RUN COMPLETE — nothing was broadcast.\n'
    printf 'Broadcast only with: PREDEX_PRIVATE_KEY set at runtime and --send\n'
  fi
}

print_plan
[ "$SEND" -eq 0 ] && exit 0

case "$ARC_RPC_URL" in
  *localhost*|*127.0.0.1*|*0.0.0.0*|*anvil*)
    printf 'ERROR: --send refuses local RPC %s; Arc USDC flows require real Arc.\n' \
      "$ARC_RPC_URL" >&2
    exit 1
    ;;
esac

if [ "${PREDEX_PRIVATE_KEY+x}" != x ] || [ -z "${PREDEX_PRIVATE_KEY:-}" ]; then
  printf 'ERROR: PREDEX_PRIVATE_KEY is required at runtime with --send.\n' >&2
  exit 1
fi
if ! printf '%s' "$PREDEX_PRIVATE_KEY" | grep -Eq '^0x[0-9a-fA-F]{64}$'; then
  printf 'ERROR: PREDEX_PRIVATE_KEY must be a 32-byte 0x-prefixed key.\n' >&2
  exit 1
fi
PRIVATE_KEY=$PREDEX_PRIVATE_KEY
unset PREDEX_PRIVATE_KEY
OPERATOR=$("$CAST_BIN" wallet address --private-key "$PRIVATE_KEY")

call() {
  "$CAST_BIN" call --rpc-url "$ARC_RPC_URL" "$@"
}

send_tx() {
  local label="$1"
  local target="$2"
  local signature="$3"
  local output tx_hash status
  shift 3
  printf '  SEND  %s\n' "$label"
  if output=$("$CAST_BIN" send \
    --rpc-url "$ARC_RPC_URL" \
    --private-key "$PRIVATE_KEY" \
    "$target" "$signature" "$@" 2>&1); then
    tx_hash=$(printf '%s\n' "$output" | awk \
      '$1 == "transactionHash" || $1 == "transaction_hash" { print $2; exit }')
    status=$(printf '%s\n' "$output" | awk '$1 == "status" { print $2; exit }')
    if [ -z "$tx_hash" ]; then
      printf '  FAIL  %s: cast returned no transaction hash\n%s\n' \
        "$label" "$output" >&2
      exit 1
    fi
    LAST_TX_HASH=$tx_hash
    printf '  OK    %s\n' "$label"
    printf '        txHash=%s status=%s\n' "$tx_hash" "${status:-confirmed}"
    printf '        %s/tx/%s\n' "${ARC_EXPLORER_URL%/}" "$tx_hash"
  else
    printf '  FAIL  %s\n' "$label" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
}

find_market_by_metadata() {
  local expected="$1"
  local next_market_id market_id metadata output
  next_market_id=$(scalar "$(call "$REGISTRY" 'nextMarketId()(uint256)')")
  market_id=1
  while [ "$market_id" -lt "$next_market_id" ]; do
    output=$(call "$REGISTRY" "$MARKET_METADATA_SIG" "$market_id")
    metadata=$(token_at "$output" 2)
    if [ "$(lowercase "$metadata")" = "$(lowercase "$expected")" ]; then
      printf '%s\n' "$market_id"
      return 0
    fi
    market_id=$((market_id + 1))
  done
  return 1
}

market_state() {
  token_at "$(call "$REGISTRY" "$MARKET_LIFECYCLE_SIG" "$1")" 3
}

load_binding() {
  local output
  output=$(call "$REGISTRY" "$TOKEN_BINDING_SIG" "$1")
  QUESTION_ID=$(token_at "$output" 4)
  CONDITION_ID=$(token_at "$output" 5)
  YES_TOKEN_ID=$(token_at "$output" 6)
  NO_TOKEN_ID=$(token_at "$output" 7)
}

ensure_market() {
  local beat="$1"
  local question="$2"
  local ancillary metadata existing creator
  ancillary=$(ancillary_for_question "$question")
  metadata=$(metadata_for_ancillary "$ancillary")
  existing=$(find_market_by_metadata "$metadata" || true)
  if [ -n "$existing" ]; then
    MARKET_ID=$existing
    creator=$(token_at "$(call "$REGISTRY" "$MARKET_LIFECYCLE_SIG" "$MARKET_ID")" 1)
    if [ "$(lowercase "$creator")" != "$(lowercase "$OPERATOR")" ]; then
      printf 'ERROR: %s metadata already belongs to market #%s created by %s, not operator %s.\n' \
        "$beat" "$MARKET_ID" "$creator" "$OPERATOR" >&2
      exit 1
    fi
    printf '  SKIP  %s already exists as market #%s\n' "$beat" "$MARKET_ID"
  else
    send_tx \
      "create $beat" \
      "$REGISTRY" \
      "$CREATE_SIG" \
      "$ancillary" \
      "$SEED_RAW" \
      "$OPENING_FEE_RAW" \
      "$TRADING_WINDOW_SECONDS" \
      "$metadata"
    MARKET_ID=$(find_market_by_metadata "$metadata" || true)
    if [ -z "$MARKET_ID" ]; then
      printf 'ERROR: create confirmed (%s), but metadataHash %s was not found.\n' \
        "$LAST_TX_HASH" "$metadata" >&2
      exit 1
    fi
    printf '        marketId=%s metadataHash=%s\n' "$MARKET_ID" "$metadata"
  fi
  load_binding "$MARKET_ID"
}

ensure_erc20_allowance() {
  local label="$1"
  local spender="$2"
  local allowance
  allowance=$(scalar "$(call "$USDC" 'allowance(address,address)(uint256)' \
    "$OPERATOR" "$spender")")
  if [ "$allowance" -ge "$APPROVAL_RAW" ]; then
    printf '  SKIP  %s allowance=%s raw\n' "$label" "$allowance"
  else
    send_tx "$label approval" "$USDC" 'approve(address,uint256)' \
      "$spender" "$APPROVAL_RAW"
  fi
}

ensure_ctf_approval() {
  local label="$1"
  local operator="$2"
  local approved
  approved=$(scalar "$(call "$CTF" 'isApprovedForAll(address,address)(bool)' \
    "$OPERATOR" "$operator")")
  if [ "$approved" = true ]; then
    printf '  SKIP  %s CTF approval already active\n' "$label"
  else
    send_tx "$label CTF approval" "$CTF" 'setApprovalForAll(address,bool)' \
      "$operator" true
  fi
}

ensure_bootstrap_state() {
  local market_id="$1"
  local beat="$2"
  local state
  state=$(market_state "$market_id")
  case "$state" in
    1|2) printf '  OK    %s market #%s is Opened and LMSR-tradable\n' \
      "$beat" "$market_id" ;;
    *) printf 'ERROR: %s market #%s is lifecycle state %s, not Bootstrap.\n' \
      "$beat" "$market_id" "$state" >&2; exit 1 ;;
  esac
}

ensure_yes_inventory() {
  local market_id="$1"
  local state balance deficit block_timestamp deadline quote total_cost max_cost
  load_binding "$market_id"
  balance=$(scalar "$(call "$CTF" 'balanceOf(address,uint256)(uint256)' \
    "$OPERATOR" "$YES_TOKEN_ID")")
  if [ "$balance" -ge "$YES_INVENTORY_TARGET_RAW" ]; then
    printf '  SKIP  operator already holds %s YES raw on market #%s\n' \
      "$balance" "$market_id"
    return
  fi
  state=$(market_state "$market_id")
  case "$state" in
    1|2) ;;
    *) printf 'ERROR: market #%s is state %s and cannot top up YES on the LMSR.\n' \
      "$market_id" "$state" >&2; exit 1 ;;
  esac
  deficit=$((YES_INVENTORY_TARGET_RAW - balance))
  block_timestamp=$("$CAST_BIN" block latest --rpc-url "$ARC_RPC_URL" --field timestamp)
  deadline=$((block_timestamp + 1200))
  quote=$(call "$LMSR" "$QUOTE_BUY_SIG" \
    "$market_id" 0 "$deficit" "$((deficit * 2))" "$deadline")
  total_cost=$(token_at "$quote" 4)
  max_cost=$(((total_cost * (BPS_SCALE + SLIPPAGE_BPS) + BPS_SCALE - 1) / BPS_SCALE))
  printf '  QUOTE buyYes market #%s amount=%s totalCost=%s maxCost=%s deadline=%s\n' \
    "$market_id" "$deficit" "$total_cost" "$max_cost" "$deadline"
  send_tx \
    "buy $deficit YES raw on market #$market_id" \
    "$LMSR" \
    'buyYes(uint256,uint256,uint256,uint256)' \
    "$market_id" "$deficit" "$max_cost" "$deadline"
  balance=$(scalar "$(call "$CTF" 'balanceOf(address,uint256)(uint256)' \
    "$OPERATOR" "$YES_TOKEN_ID")")
  if [ "$balance" -lt "$YES_INVENTORY_TARGET_RAW" ]; then
    printf 'ERROR: post-buy YES balance %s is below target %s.\n' \
      "$balance" "$YES_INVENTORY_TARGET_RAW" >&2
    exit 1
  fi
}

ensure_graduated_book() {
  local market_id="$1"
  local state status qualified activity threshold earliest seeded amm handoff
  state=$(market_state "$market_id")
  case "$state" in
    1|2)
      status=$(call "$REGISTRY" \
        'graduationStatus(uint256)(bool,uint256,uint256,uint256,uint256,uint256)' \
        "$market_id")
      qualified=$(token_at "$status" 1)
      activity=$(token_at "$status" 2)
      threshold=$(token_at "$status" 3)
      earliest=$(token_at "$status" 6)
      if [ "$qualified" != true ]; then
        printf 'ERROR: market #%s is not graduation-qualified (activity %s/%s; earliest %s).\n' \
          "$market_id" "$activity" "$threshold" "$earliest" >&2
        exit 1
      fi
      send_tx \
        "graduate market #$market_id" \
        "$REGISTRY" \
        'graduateIfQualified(uint256)' \
        "$market_id"
      ;;
    3) printf '  SKIP  market #%s is already Graduated\n' "$market_id" ;;
    *) printf 'ERROR: market #%s is lifecycle state %s, not a live graduated market.\n' \
      "$market_id" "$state" >&2; exit 1 ;;
  esac

  state=$(market_state "$market_id")
  if [ "$state" -ne 3 ]; then
    printf 'ERROR: market #%s expected state 3 after graduation, got %s.\n' \
      "$market_id" "$state" >&2
    exit 1
  fi
  load_binding "$market_id"
  seeded=$(scalar "$(call "$MINICLOB" 'graduationSeeded(bytes32)(bool)' \
    "$CONDITION_ID")")
  amm=$(call "$LMSR" "$AMM_STATE_SIG" "$market_id")
  handoff=$(token_at "$amm" 16)
  if [ "$seeded" != true ] || [ "$handoff" -le 0 ]; then
    printf 'ERROR: market #%s graduated without usable book depth (seeded=%s handoffRaw=%s).\n' \
      "$market_id" "$seeded" "$handoff" >&2
    exit 1
  fi
  printf '  OK    market #%s has live MiniCLOB seed depth: %s complete sets raw\n' \
    "$market_id" "$handoff"
}

printf '\n### LIVE PREFLIGHT (read-only calls only)\n'
chain_id=$("$CAST_BIN" chain-id --rpc-url "$ARC_RPC_URL")
if [ "$chain_id" -ne "$ARC_CHAIN_ID" ]; then
  printf 'ERROR: RPC chainId is %s; expected Arc testnet %s.\n' \
    "$chain_id" "$ARC_CHAIN_ID" >&2
  exit 1
fi
for address in "$USDC" "$CTF" "$ORACLE" "$LMSR" "$REGISTRY" "$MINICLOB"; do
  code=$("$CAST_BIN" code --rpc-url "$ARC_RPC_URL" "$address")
  if [ "$code" = 0x ] || [ -z "$code" ]; then
    printf 'ERROR: no deployed code at %s on Arc testnet.\n' "$address" >&2
    exit 1
  fi
done

params=$(call "$REGISTRY" "$DEFAULT_PARAMS_SIG")
OPENING_FEE_RAW=$(token_at "$params" 1)
seed_floor=$(token_at "$params" 2)
seed_cap=$(token_at "$params" 3)
graduation_threshold=$(token_at "$params" 6)
GRADUATION_TOLL_RAW=$(token_at "$params" 7)
min_window=$(token_at "$params" 13)
max_window=$(token_at "$params" 14)
minimum_open=$(token_at "$params" 15)

if [ "$OPENING_FEE_RAW" -gt "$MAX_OPENING_FEE_RAW" ]; then
  printf 'ERROR: live opening fee %s exceeds script cap %s. Review before spending.\n' \
    "$OPENING_FEE_RAW" "$MAX_OPENING_FEE_RAW" >&2
  exit 1
fi
if [ "$SEED_RAW" -lt "$seed_floor" ] || [ "$SEED_RAW" -gt "$seed_cap" ]; then
  printf 'ERROR: seed %s is outside live range %s-%s.\n' \
    "$SEED_RAW" "$seed_floor" "$seed_cap" >&2
  exit 1
fi
if [ "$TRADING_WINDOW_SECONDS" -lt "$min_window" ] || \
   [ "$TRADING_WINDOW_SECONDS" -gt "$max_window" ]; then
  printf 'ERROR: trading window %s is outside live range %s-%s.\n' \
    "$TRADING_WINDOW_SECONDS" "$min_window" "$max_window" >&2
  exit 1
fi
if [ "$graduation_threshold" -ne 0 ] || [ "$minimum_open" -ne 0 ]; then
  printf 'ERROR: deployment is no longer instant-graduation safe (threshold=%s minimumOpen=%s).\n' \
    "$graduation_threshold" "$minimum_open" >&2
  exit 1
fi

committee_threshold=$(scalar "$(call "$ORACLE" 'currentThreshold()(uint256)')")
committee_member=$(scalar "$(call "$ORACLE" 'isCurrentMember(address)(bool)' "$OPERATOR")")
if [ "$committee_threshold" -ne 1 ] || [ "$committee_member" != true ]; then
  printf 'ERROR: operator %s is not ready for the threshold-1 committee flow (threshold=%s member=%s).\n' \
    "$OPERATOR" "$committee_threshold" "$committee_member" >&2
  exit 1
fi

minimum_balance=$((3 * (SEED_RAW + OPENING_FEE_RAW) + \
  2 * GRADUATION_TOLL_RAW + 4 * YES_INVENTORY_TARGET_RAW))
balance=$(scalar "$(call "$USDC" 'balanceOf(address)(uint256)' "$OPERATOR")")
if [ "$balance" -lt "$minimum_balance" ]; then
  printf 'ERROR: operator has %s raw USDC; at least %s raw is required.\n' \
    "$balance" "$minimum_balance" >&2
  exit 1
fi
printf '  OK    chainId=%s operator=%s balance=%s raw USDC\n' \
  "$chain_id" "$OPERATOR" "$balance"
printf '  OK    params seed=%s fee=%s toll=%s threshold=%s minimumOpen=%s\n' \
  "$SEED_RAW" "$OPENING_FEE_RAW" "$GRADUATION_TOLL_RAW" \
  "$graduation_threshold" "$minimum_open"

printf '\n### 1. IDEMPOTENT APPROVALS\n'
ensure_erc20_allowance Registry "$REGISTRY"
ensure_erc20_allowance LMSR "$LMSR"
ensure_erc20_allowance MiniCLOB "$MINICLOB"
ensure_ctf_approval LMSR "$LMSR"
ensure_ctf_approval MiniCLOB "$MINICLOB"

printf '\n### 2. BOOTSTRAP + DEDUP MARKET\n'
ensure_market bootstrap-dedup "$BOOTSTRAP_QUESTION"
BOOTSTRAP_MARKET_ID=$MARKET_ID
ensure_bootstrap_state "$BOOTSTRAP_MARKET_ID" bootstrap-dedup

printf '\n### 3. GRADUATED LIVE-BOOK MARKET\n'
ensure_market graduated-book "$GRADUATED_QUESTION"
GRADUATED_MARKET_ID=$MARKET_ID
ensure_yes_inventory "$GRADUATED_MARKET_ID"
ensure_graduated_book "$GRADUATED_MARKET_ID"

printf '\n### 4. READY-TO-RESOLVE MARKET\n'
ensure_market ready-to-resolve "$RESOLUTION_QUESTION"
RESOLUTION_MARKET_ID=$MARKET_ID
ensure_yes_inventory "$RESOLUTION_MARKET_ID"
ensure_graduated_book "$RESOLUTION_MARKET_ID"
load_binding "$RESOLUTION_MARKET_ID"
resolved=$(scalar "$(call "$ORACLE" 'isResolved(bytes32)(bool)' "$QUESTION_ID")")
snapshot_member=$(scalar "$(call "$ORACLE" 'isSnapshotMember(bytes32,address)(bool)' \
  "$QUESTION_ID" "$OPERATOR")")
if [ "$resolved" != false ] || [ "$snapshot_member" != true ]; then
  printf 'ERROR: market #%s is not ready for operator resolution (resolved=%s snapshotMember=%s).\n' \
    "$RESOLUTION_MARKET_ID" "$resolved" "$snapshot_member" >&2
  exit 1
fi
printf '  OK    market #%s is unresolved; operator is a snapshotted committee signer\n' \
  "$RESOLUTION_MARKET_ID"

printf '\n### PRE-SEED COMPLETE\n'
printf '  Bootstrap / near duplicate: market #%s — %s\n' \
  "$BOOTSTRAP_MARKET_ID" "$BOOTSTRAP_QUESTION"
printf '  Graduated live book:       market #%s — %s\n' \
  "$GRADUATED_MARKET_ID" "$GRADUATED_QUESTION"
printf '  Ready to resolve YES:      market #%s — %s\n' \
  "$RESOLUTION_MARKET_ID" "$RESOLUTION_QUESTION"
printf '  Dedup input:               %s\n' "$DEDUP_OPERATOR_QUESTION"
printf '  Frontend:                  configure NEXT_PUBLIC_AGENT_ADDRESSES with agent wallets\n'
printf '  No resolution was sent; use the market #%s settlement UI for resolve → observe → redeem → closeout.\n' \
  "$RESOLUTION_MARKET_ID"
