#!/usr/bin/env bash
set -euo pipefail

# Read-only demo rehearsal on pc63 from the build-only verified mirror
# predex-pump-vercel. Never syncs, installs, builds, touches databases, or
# reads keys; the trader runs one dry-run scan with every secret blanked.
#
#   scripts/cloudlab/demo-recording.sh check | trader | world-evidence

CLOUDLAB_HOST="${CLOUDLAB_HOST:-span14@pc63.cloudlab.umass.edu}"
CLOUDLAB_IDENTITY_FILE="${CLOUDLAB_IDENTITY_FILE:-/Users/ggattacker/.ssh/cloudlab}"

fail() {
  printf 'demo-recording: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Usage: %s check | trader | world-evidence\n' "$0" >&2
  exit 2
}

[[ "$CLOUDLAB_HOST" == 'span14@pc63.cloudlab.umass.edu' ]] ||
  fail "refusing unexpected CloudLab host: $CLOUDLAB_HOST"
[[ "$CLOUDLAB_IDENTITY_FILE" == /Users/ggattacker/.ssh/cloudlab ]] ||
  fail "refusing unexpected identity file: $CLOUDLAB_IDENTITY_FILE"
[[ $# -eq 1 ]] || usage
case "$1" in
  check|trader|world-evidence) ;;
  *) usage ;;
esac

ssh -i "$CLOUDLAB_IDENTITY_FILE" -o BatchMode=yes -o ConnectTimeout=12 \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=4 \
  "$CLOUDLAB_HOST" bash -s -- "$1" <<'REMOTE'
set -euo pipefail

mode="$1"
builds=/users/span14/predex-builds
root="$builds/predex-pump-vercel"
source_dir="$root/source"
node_bin=/users/span14/.local/predex-toolchain/node-v24.19.0-linux-x64/bin

fail() {
  printf 'demo-recording: %s\n' "$*" >&2
  exit 1
}

[[ -f "$source_dir/.predex-source-id" && ! -L "$source_dir/.predex-source-id" ]] ||
  fail "verified mirror is incomplete at $source_dir"
source_id="$(head -n 1 "$source_dir/.predex-source-id")"
[[ "$source_id" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ ]] || fail 'unexpected source id format'
manifest="$root/evidence/$source_id/manifest.txt"
printf 'mode=%s\nhost=%s\nexecution_source=%s\nsource_id=%s\n' \
  "$mode" "$(hostname)" "$source_dir" "$source_id"

manifest_ok() {
  local gate
  [[ -f "$manifest" && ! -L "$manifest" ]] || return 1
  grep -Fxq "source_id=$source_id" "$manifest" || return 1
  for gate in trader_build trader_test backend_test; do
    grep -Fxq "$gate=pass" "$manifest" || return 1
  done
  grep -Eq '^finished_at=[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$manifest"
}

case "$mode" in
  check)
    if manifest_ok; then printf 'manifest_gate=pass\n'; else printf 'manifest_gate=FAIL (%s)\n' "$manifest"; fi
    runtime_id="$(head -n 1 "$builds/predex-pump-privy/source/.predex-source-id" 2>/dev/null || true)"
    [[ "$runtime_id" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ ]] || runtime_id='<unreadable>'
    printf 'runtime_source_id=%s (metadata only; API/frontend runtime, expected d700bb726eb5-bf63c6c0cdc8, not the agent mirror)\n' "$runtime_id"
    frontend_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3002/ 2>/dev/null || true)"
    printf 'frontend_url=http://127.0.0.1:3002/ frontend_http_status=%s\n' "${frontend_status:-000}"
    health="$(curl -sS -w '\n%{http_code}' --max-time 10 http://127.0.0.1:3001/health 2>/dev/null || true)"
    api_status="${health##*$'\n'}"
    printf 'api_url=http://127.0.0.1:3001/health api_http_status=%s\n' "${api_status:-000}"
    printf '%s' "${health%$'\n'*}" | "$node_bin/node" -e '
      let raw = "";
      process.stdin.on("data", (chunk) => { raw += chunk; }).on("end", () => {
        let health;
        try { health = JSON.parse(raw); } catch { console.log("health=<no JSON body>"); return; }
        for (const key of ["ok", "chainId", "indexerStatus", "indexedBlock", "headBlock", "lagBlocks",
          "secondsSinceLastSuccessfulPoll", "balancesReconciled"]) {
          console.log(`health.${key}=${JSON.stringify(health?.[key])}`);
        }
      });
    ' || printf 'health=<unparsed>\n'
    printf 'note: HTTP 200 does not mean the indexer is fresh; read indexerStatus/lagBlocks above\n'
    ;;
  trader)
    manifest_ok || fail "verification manifest is not complete and passing for $source_id"
    [[ -x "$node_bin/node" && -x "$node_bin/pnpm" ]] || fail 'pinned Node.js 24.19.0 toolchain is unavailable'
    [[ -x "$source_dir/agents/trader/node_modules/.bin/tsx" ]] ||
      fail 'trader dependencies are unavailable; nothing is installed here'
    printf '== READ-ONLY DRY RUN: no trading, no order posting, no payment signing; all keys blank ==\n'
    printf 'note: Graph discovery sends a read-only GraphQL query (HTTP POST) to The Graph Studio; no fallback\n'
    cd "$source_dir/agents/trader"
    status=0
    env -i HOME="$HOME" PATH="$node_bin:/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 \
      PREDEX_DRY_RUN=true \
      PREDEX_TRUTH_MODE=free \
      PREDEX_API_URL=http://127.0.0.1:3001 \
      PREDEX_MARKET_DISCOVERY=graph-required \
      PREDEX_GRAPH_QUERY_URL=https://api.studio.thegraph.com/query/1758846/predex/0.0.1 \
      PREDEX_GRAPH_MARKET_LIMIT=20 \
      PREDEX_TRADER_ADDRESS=0xfE4cc0643199d15a0e284E61088d4c9495D506aF \
      PREDEX_PRIVATE_KEY= PREDEX_TRUTH_PRIVATE_KEY= QA_WALLET_PRIVATE_KEY= \
      OPERATOR_PRIVATE_KEY= NODE_OPTIONS= \
      timeout --kill-after=5 60 pnpm start -- --once < /dev/null 2>&1 || status=$?
    [[ "$status" -ne 124 ]] || printf 'trader timed out after 60s\n'
    printf 'trader_exit=%s\nsource_id=%s\n' "$status" "$source_id"
    exit "$status"
    ;;
  world-evidence)
    manifest_ok || fail "verification manifest is not complete and passing for $source_id"
    log="$root/evidence/$source_id/verify.log"
    [[ -f "$log" && ! -L "$log" ]] || fail "verify.log is missing for source $source_id"
    printf '== EXISTING AUTOMATED INTEGRATION TEST EVIDENCE (external AgentBook/facilitator stubbed); NOT live World proof ==\n'
    printf 'manifest=%s\n' "$manifest"
    grep -E '^(started_at|backend_test|finished_at)=' "$manifest"
    printf 'verify_log=%s\n' "$log"
    for test_file in world-agentkit.test.ts truth-payment.test.ts; do
      grep -F "$test_file" "$log" || fail "no $test_file entry in $log"
    done
    ;;
  *)
    fail "unknown mode: $mode"
    ;;
esac
REMOTE
