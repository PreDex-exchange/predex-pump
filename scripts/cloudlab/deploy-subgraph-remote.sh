#!/usr/bin/env bash
set -euo pipefail

readonly STUDIO_DEPLOY_URL='https://api.studio.thegraph.com/deploy/'
readonly REQUIRED_VERIFY_GATES=(
  cloudlab_script_syntax
  subgraph_deploy_safety
  shared_typecheck
  shared_test
  agent_sdk_typecheck
  agent_sdk_test
  agent_sdk_build
  creator_typecheck
  creator_test
  creator_build
  trader_typecheck
  trader_test
  trader_build
  backend_typecheck
  backend_build
  backend_test
  subgraph_codegen
  subgraph_test
  subgraph_build
  frontend_lint
  frontend_typecheck
  frontend_test
  frontend_build
)

deploy_key=''
auth_parent=''
auth_home=''
auth_fifo=''
writer_pid=''

read_deploy_key() {
  local first_record=''
  if ! IFS= read -r first_record; then
    [[ -n "$first_record" ]] || {
      printf 'Graph deploy key was not received on stdin.\n' >&2
      return 1
    }
  fi
  [[ "$first_record" =~ ^[0-9a-fA-F]{32}$ ]] || {
    printf 'Graph deploy key must contain exactly 32 hexadecimal characters.\n' >&2
    return 1
  }

  local extra_record=''
  if IFS= read -r extra_record || [[ -n "$extra_record" ]]; then
    printf 'Graph deploy key input must contain exactly one record.\n' >&2
    return 1
  fi
  deploy_key="$first_record"
}

require_verified_manifest() {
  local manifest="$1"
  local expected_source_id="$2"
  [[ -f "$manifest" ]] || {
    printf 'Verification manifest is missing for source %s.\n' \
      "$expected_source_id" >&2
    return 1
  }
  grep -Fqx "source_id=$expected_source_id" "$manifest" || {
    printf 'Verification manifest belongs to a different source.\n' >&2
    return 1
  }

  local gate
  for gate in "${REQUIRED_VERIFY_GATES[@]}"; do
    grep -Fqx "$gate=pass" "$manifest" || {
      printf 'Verification gate %s has not passed.\n' "$gate" >&2
      return 1
    }
  done
  grep -Eq '^finished_at=[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$manifest" || {
    printf 'Verification manifest is incomplete.\n' >&2
    return 1
  }
}

cleanup_auth() {
  local status="$?"
  trap - EXIT INT TERM
  deploy_key=''
  if [[ -n "$writer_pid" ]] && kill -0 "$writer_pid" 2>/dev/null; then
    kill "$writer_pid" 2>/dev/null || true
    wait "$writer_pid" 2>/dev/null || true
  fi
  if [[ -n "$auth_home" ]]; then
    if [[ -n "$auth_parent" && "$auth_home" == "$auth_parent"/predex-graph-auth.* ]]; then
      rm -rf -- "$auth_home"
    else
      printf 'Refusing unexpected auth cleanup path: %s\n' "$auth_home" >&2
      status=1
    fi
  fi
  exit "$status"
}

prepare_auth_fifo() {
  auth_parent="$1"
  [[ -d "$auth_parent" ]] || {
    printf 'Graph auth temporary parent is unavailable: %s\n' "$auth_parent" >&2
    return 1
  }
  auth_home="$(mktemp -d "$auth_parent/predex-graph-auth.XXXXXX")"
  chmod 700 "$auth_home"
  auth_fifo="$auth_home/.graph-cli.json"
  mkfifo "$auth_fifo"
  chmod 600 "$auth_fifo"
  (
    umask 077
    printf '{"%s":"%s"}' "$STUDIO_DEPLOY_URL" "$deploy_key" > "$auth_fifo"
  ) &
  writer_pid="$!"
  deploy_key=''
  export HOME="$auth_home"
  export XDG_CONFIG_HOME="$auth_home/.config"
  export XDG_CACHE_HOME="$auth_home/.cache"
}

if [[ "${1:-}" == '--self-test-auth' ]]; then
  self_test_mode="${2:-success}"
  case "$self_test_mode" in
    success | failure | signal) ;;
    *) exit 2 ;;
  esac
  read_deploy_key
  trap cleanup_auth EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  prepare_auth_fifo "${TMPDIR:-/tmp}"
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const config = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".graph-cli.json"), "utf8"));
    const key = config["https://api.studio.thegraph.com/deploy/"];
    if (!/^[0-9a-fA-F]{32}$/.test(key)) process.exit(1);
    if (process.argv.includes(key)) process.exit(1);
    if (Object.values(process.env).includes(key)) process.exit(1);
  '
  wait "$writer_pid"
  writer_pid=''
  if [[ "$self_test_mode" == failure ]]; then
    false
  fi
  if [[ "$self_test_mode" == signal ]]; then
    kill -TERM "$$"
  fi
  printf 'auth-self-test=pass\n'
  exit 0
fi

if [[ "${1:-}" == '--self-test-manifest' ]]; then
  require_verified_manifest "$2" "$3"
  printf 'manifest-self-test=pass\n'
  exit 0
fi

remote_root="$1"
expected_source_id="$2"
subgraph_slug="$3"
version_label="$4"

case "$remote_root" in
  /users/span14/predex-builds/predex-pump) ;;
  *)
    printf 'Refusing unexpected remote root: %s\n' "$remote_root" >&2
    exit 1
    ;;
esac
[[ "$subgraph_slug" == predex ]] || {
  printf 'Refusing unexpected Studio slug: %s\n' "$subgraph_slug" >&2
  exit 1
}
[[ "$version_label" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  printf 'Subgraph version label must be semver, received %s\n' \
    "$version_label" >&2
  exit 1
}

source_dir="$remote_root/source"
source_id="$(cat "$source_dir/.predex-source-id")"
[[ "$source_id" == "$expected_source_id" ]] || {
  printf 'Remote source mismatch: expected %s, found %s\n' \
    "$expected_source_id" "$source_id" >&2
  exit 1
}

verification_manifest="$remote_root/evidence/$source_id/manifest.txt"
require_verified_manifest "$verification_manifest" "$source_id"

node_root="$HOME/.local/predex-toolchain/node-v22.19.0-linux-x64"
export PATH="$node_root/bin:$PATH"
subgraph_dir="$source_dir/subgraph"
evidence_dir="$remote_root/evidence/$source_id/graph-subgraph"
mkdir -p "$evidence_dir"

[[ -x "$subgraph_dir/node_modules/.bin/graph" ]] || {
  printf 'Verified Graph CLI install is missing; run scripts/cloudlab/verify.sh first.\n' >&2
  exit 1
}

read_deploy_key
trap cleanup_auth EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
prepare_auth_fifo /dev/shm

{
  printf 'source_id=%s\n' "$source_id"
  printf 'host=%s\n' "$(hostname)"
  printf 'started_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'slug=%s\n' "$subgraph_slug"
  printf 'version_label=%s\n' "$version_label"
  printf 'graph_cli=%s\n' \
    "$(cd "$subgraph_dir" && ./node_modules/.bin/graph --version)"
} > "$evidence_dir/deploy-manifest.txt"

cd "$subgraph_dir"
./node_modules/.bin/graph deploy \
  --node "$STUDIO_DEPLOY_URL" \
  --version-label "$version_label" \
  "$subgraph_slug" \
  subgraph.yaml 2>&1 | tee "$evidence_dir/deploy.log"

wait "$writer_pid"
writer_pid=''
printf 'finished_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >> "$evidence_dir/deploy-manifest.txt"
