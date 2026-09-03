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

command -v docker >/dev/null 2>&1 || {
  printf 'Docker is required for the isolated backend test database.\n' >&2
  exit 1
}
postgres_name="predex-test-${source_id:0:20}-$$"
postgres_id="$(docker run --detach --rm \
  --name "$postgres_name" \
  --env POSTGRES_DB=predex_pump \
  --env POSTGRES_USER=predex \
  --env POSTGRES_PASSWORD=predex \
  --publish 127.0.0.1::5432/tcp \
  --health-cmd='pg_isready -U predex -d predex_pump' \
  --health-interval=1s \
  --health-timeout=3s \
  --health-retries=30 \
  postgres:17-alpine)"
cleanup_postgres() {
  docker container rm --force "$postgres_id" >/dev/null 2>&1 || true
}
trap cleanup_postgres EXIT

postgres_status=''
for _ in {1..30}; do
  postgres_status="$(docker container inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$postgres_id" 2>/dev/null || true)"
  [[ "$postgres_status" == healthy ]] && break
  [[ "$postgres_status" == unhealthy || "$postgres_status" == exited ]] && break
  sleep 1
done
[[ "$postgres_status" == healthy ]] || {
  printf 'Isolated PostgreSQL did not become healthy (status=%s).\n' "$postgres_status" >&2
  exit 1
}
postgres_mapping="$(docker container port "$postgres_id" 5432/tcp)"
postgres_port="${postgres_mapping##*:}"
printf '\n== backend_test ==\n'
(
  cd "$source_dir/backend"
  TEST_DATABASE_URL="postgresql://predex:predex@127.0.0.1:${postgres_port}/predex_pump?schema=contract_test" \
    pnpm run test
)
printf 'backend_test=pass\n' >> "$evidence_dir/manifest.txt"
cleanup_postgres
trap - EXIT

run frontend_lint frontend lint
run frontend_typecheck frontend typecheck
run frontend_test frontend test
run frontend_build frontend build

printf 'finished_at=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$evidence_dir/manifest.txt"
printf '\nVerification passed. Evidence: %s\n' "$evidence_dir"
REMOTE
