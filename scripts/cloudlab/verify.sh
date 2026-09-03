#!/usr/bin/env bash
set -euo pipefail

CLOUDLAB_HOST="${CLOUDLAB_HOST:-span14@c220g1-031117.wisc.cloudlab.us}"
CLOUDLAB_IDENTITY_FILE="${CLOUDLAB_IDENTITY_FILE:-/Users/ggattacker/.ssh/cloudlab}"
CLOUDLAB_REMOTE_ROOT="${CLOUDLAB_REMOTE_ROOT:-/users/span14/predex-builds/predex-pump}"
PREDEX_NODE_VERSION="${PREDEX_NODE_VERSION:-22.19.0}"

case "$CLOUDLAB_REMOTE_ROOT" in
  /users/span14/predex-builds/predex-pump) ;;
  *)
    printf 'Refusing unexpected remote root: %s\n' "$CLOUDLAB_REMOTE_ROOT" >&2
    exit 1
    ;;
esac

ssh_args=(
  -i "$CLOUDLAB_IDENTITY_FILE"
  -o BatchMode=yes
  -o ConnectTimeout=12
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=4
)

ssh "${ssh_args[@]}" "$CLOUDLAB_HOST" bash -s -- \
  "$CLOUDLAB_REMOTE_ROOT" "$PREDEX_NODE_VERSION" <<'REMOTE'
set -euo pipefail

remote_root="$1"
node_version="$2"
source_dir="$remote_root/source"
node_root="$HOME/.local/predex-toolchain/node-v${node_version}-linux-x64"
source_id="$(cat "$source_dir/.predex-source-id")"
evidence_dir="$remote_root/evidence/$source_id"

export PATH="$node_root/bin:$PATH"
mkdir -p "$evidence_dir"
exec > >(tee "$evidence_dir/verify.log") 2>&1

printf 'source_id=%s\nhost=%s\nstarted_at=%s\nnode=%s\npnpm=%s\n' \
  "$source_id" "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(node --version)" "$(pnpm --version)" > "$evidence_dir/manifest.txt"

packages=(shared agent-sdk agents/creator agents/trader backend frontend)
for package in "${packages[@]}"; do
  printf '\n== install %s ==\n' "$package"
  (cd "$source_dir/$package" && pnpm install --frozen-lockfile)
done

rm -rf \
  "$source_dir/shared/dist" \
  "$source_dir/agent-sdk/dist" \
  "$source_dir/agents/creator/dist" \
  "$source_dir/agents/trader/dist" \
  "$source_dir/frontend/.next"

run() {
  local label="$1"
  local package="$2"
  local command="$3"
  printf '\n== %s ==\n' "$label"
  (cd "$source_dir/$package" && pnpm run "$command")
  printf '%s=pass\n' "$label" >> "$evidence_dir/manifest.txt"
}

run shared_typecheck shared typecheck
run shared_test shared test
run agent_sdk_typecheck agent-sdk typecheck
run agent_sdk_test agent-sdk test
run agent_sdk_build agent-sdk build
run creator_typecheck agents/creator typecheck
run creator_test agents/creator test
run creator_build agents/creator build
run trader_typecheck agents/trader typecheck
run trader_test agents/trader test
run trader_build agents/trader build
run backend_typecheck backend typecheck
run backend_build backend build
run frontend_lint frontend lint
run frontend_typecheck frontend typecheck
run frontend_test frontend test
run frontend_build frontend build

printf 'backend_test=not_run_requires_postgres\nfinished_at=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$evidence_dir/manifest.txt"
printf '\nVerification passed. Evidence: %s\n' "$evidence_dir"
REMOTE
