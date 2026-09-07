#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_HELPER="$SCRIPT_DIR/../cloudlab/deploy-subgraph-remote.sh"
SENTINEL='0123456789abcdef0123456789abcdef'
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/predex-subgraph-deploy-test.XXXXXX")"

cleanup() {
  local status="$?"
  trap - EXIT INT TERM
  case "$TEST_ROOT" in
    "${TMPDIR:-/tmp}"/predex-subgraph-deploy-test.*) rm -rf -- "$TEST_ROOT" ;;
    *) status=1 ;;
  esac
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

bash -n "$REMOTE_HELPER"

auth_output="$(printf '%s' "$SENTINEL" | \
  TMPDIR="$TEST_ROOT" bash "$REMOTE_HELPER" --self-test-auth 2>&1)"
[[ "$auth_output" == 'auth-self-test=pass' ]]
[[ "$auth_output" != *"$SENTINEL"* ]]
[[ -z "$(find "$TEST_ROOT" -mindepth 1 -print -quit)" ]]

for self_test_mode in failure signal; do
  failure_output=''
  if failure_output="$(printf '%s' "$SENTINEL" | \
    TMPDIR="$TEST_ROOT" bash "$REMOTE_HELPER" \
      --self-test-auth "$self_test_mode" 2>&1)"; then
    printf 'Credential self-test mode %s unexpectedly succeeded.\n' \
      "$self_test_mode" >&2
    exit 1
  fi
  [[ "$failure_output" != *"$SENTINEL"* ]]
  [[ -z "$(find "$TEST_ROOT" -mindepth 1 -print -quit)" ]]
done

extra_output=''
if extra_output="$(printf '%s\n%s' "$SENTINEL" "$SENTINEL" | \
  TMPDIR="$TEST_ROOT" bash "$REMOTE_HELPER" --self-test-auth 2>&1)"; then
  printf 'Credential reader accepted a second record.\n' >&2
  exit 1
fi
[[ "$extra_output" != *"$SENTINEL"* ]]
[[ -z "$(find "$TEST_ROOT" -mindepth 1 -print -quit)" ]]

manifest="$TEST_ROOT/manifest.txt"
source_id='test-source-id'
printf 'source_id=%s\n' "$source_id" > "$manifest"
for gate in \
  cloudlab_script_syntax subgraph_deploy_safety \
  shared_typecheck shared_test \
  agent_sdk_typecheck agent_sdk_test agent_sdk_build \
  creator_typecheck creator_test creator_build \
  trader_typecheck trader_test trader_build \
  backend_typecheck backend_build backend_test \
  subgraph_codegen subgraph_test subgraph_build \
  frontend_lint frontend_typecheck frontend_test frontend_build; do
  printf '%s=pass\n' "$gate" >> "$manifest"
done
printf 'finished_at=2026-09-07T00:00:00Z\n' >> "$manifest"

manifest_output="$(bash "$REMOTE_HELPER" \
  --self-test-manifest "$manifest" "$source_id")"
[[ "$manifest_output" == 'manifest-self-test=pass' ]]

sed '/^subgraph_build=pass$/d' "$manifest" > "$TEST_ROOT/incomplete.txt"
if bash "$REMOTE_HELPER" --self-test-manifest \
  "$TEST_ROOT/incomplete.txt" "$source_id" > /dev/null 2>&1; then
  printf 'Deployment accepted an incomplete verification manifest.\n' >&2
  exit 1
fi
if bash "$REMOTE_HELPER" --self-test-manifest \
  "$manifest" 'different-source' > /dev/null 2>&1; then
  printf 'Deployment accepted a verification manifest for another source.\n' >&2
  exit 1
fi

if grep -En -- 'graph[[:space:]]+auth|--deploy-key|graph[[:space:]]+publish' \
  "$REMOTE_HELPER" > /dev/null; then
  printf 'Remote helper contains a credential-leaking or publishing command.\n' >&2
  exit 1
fi
grep -F -- '--node "$STUDIO_DEPLOY_URL"' "$REMOTE_HELPER" > /dev/null
grep -F -- '--version-label "$version_label"' "$REMOTE_HELPER" > /dev/null

printf 'Subgraph deployment safety tests passed.\n'
