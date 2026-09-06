#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
REPO_DIR="$(CDPATH= cd -- "$TEST_DIR/../.." && pwd -P)"
SCRIPT="$REPO_DIR/scripts/cloudlab/runtime.sh"
REMOTE_HELPER="$REPO_DIR/scripts/cloudlab/runtime-remote.sh"
UNIT_DIR="$REPO_DIR/deploy/systemd"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected output to contain: $2" ;;
  esac
}

assert_not_contains() {
  case "$1" in
    *"$2"*) fail "output unexpectedly contained: $2" ;;
    *) ;;
  esac
}

assert_file_contains() {
  grep -Fq -- "$2" "$1" || fail "$1 does not contain: $2"
}

file_mode() {
  local path="$1"
  if stat -f '%Lp' "$path" >/dev/null 2>&1; then
    stat -f '%Lp' "$path"
  else
    stat -c '%a' "$path"
  fi
}

bash -n "$SCRIPT"
bash -n "$REMOTE_HELPER"

expected_units=(
  predex-data.service
  predex-api.service
  predex-indexer.service
  predex-operator.service
  predex-frontend.service
  predex.target
)
for unit in "${expected_units[@]}"; do
  [[ -f "$UNIT_DIR/$unit" ]] || fail "missing checked-in unit $unit"
done
[[ "$(find "$UNIT_DIR" -maxdepth 1 -type f \( -name 'predex-*.service' -o -name 'predex.target' \) | wc -l | tr -d '[:space:]')" == 6 ]] ||
  fail 'unexpected Predex unit count'

for unit in predex-data.service predex-api.service predex-indexer.service predex-operator.service predex-frontend.service; do
  assert_file_contains "$UNIT_DIR/$unit" 'Restart=on-failure'
  assert_file_contains "$UNIT_DIR/$unit" 'KillMode=control-group'
  assert_file_contains "$UNIT_DIR/$unit" 'StandardOutput=journal'
done
assert_file_contains "$UNIT_DIR/predex-api.service" 'ExecStart=/users/span14/.local/predex-toolchain/node-v22.19.0-linux-x64/bin/pnpm api'
assert_file_contains "$UNIT_DIR/predex-indexer.service" 'ExecStart=/users/span14/.local/predex-toolchain/node-v22.19.0-linux-x64/bin/pnpm indexer'
assert_file_contains "$UNIT_DIR/predex-operator.service" 'ExecStart=/users/span14/.local/predex-toolchain/node-v22.19.0-linux-x64/bin/pnpm operator'
assert_file_contains "$UNIT_DIR/predex-operator.service" 'Environment=OPERATOR_PRIVATE_KEY_FILE=%d/operator-private-key'
assert_file_contains "$UNIT_DIR/predex-frontend.service" '127.0.0.1 --port 3002'
assert_file_contains "$UNIT_DIR/predex-api.service" 'Environment=DATABASE_POOL_SIZE=8'
assert_file_contains "$UNIT_DIR/predex-indexer.service" 'Environment=DATABASE_POOL_SIZE=8'
assert_file_contains "$UNIT_DIR/predex-operator.service" 'Environment=DATABASE_POOL_SIZE=8'
assert_file_contains "$UNIT_DIR/predex-api.service" 'Environment=REDIS_KEY_PREFIX=predex-continuity-deadline'
assert_file_contains "$UNIT_DIR/predex-indexer.service" 'Environment=REDIS_URL=redis://127.0.0.1:6379'
assert_file_contains "$UNIT_DIR/predex-indexer.service" 'Environment=REDIS_KEY_PREFIX=predex-continuity-deadline'
assert_file_contains "$UNIT_DIR/predex-api.service" 'Environment=PREDEX_WEB_ORIGIN=http://localhost:3002'
assert_file_contains "$UNIT_DIR/predex-api.service" 'Environment=SIWE_DOMAIN=localhost:3002'
assert_file_contains "$UNIT_DIR/predex-api.service" 'Environment=SIWE_URI=http://localhost:3002'
assert_file_contains "$UNIT_DIR/predex-api.service" 'Environment=ACCOUNT_COOKIE_SECURE=false'
assert_file_contains "$UNIT_DIR/predex-indexer.service" 'TimeoutStopSec=130'
assert_file_contains "$UNIT_DIR/predex-operator.service" 'TimeoutStopSec=130'
assert_file_contains "$UNIT_DIR/predex-operator.service" 'LoadCredential=operator-private-key:/users/span14/predex-builds/predex-pump/runtime/operator.key'
[[ "$(grep -c '^    restart: unless-stopped$' "$REPO_DIR/backend/docker-compose.yml")" == 3 ]] ||
  fail 'all three data services must use Docker unless-stopped supervision'

assert_file_contains "$REPO_DIR/scripts/cloudlab/sync.sh" '/users/span14/predex-builds/predex-pump/runtime/active'
assert_file_contains "$REPO_DIR/scripts/cloudlab/sync.sh" "--exclude='runtime/'"
assert_file_contains "$SCRIPT" 'LOCAL_OPERATOR_CREDENTIAL="${PREDEX_OPERATOR_CREDENTIAL_FILE:-$REPO_ROOT/../.credentials/.arc}"'
if grep -Eq '(^|[[:space:]])(kill|pkill|killall)([[:space:]]|$)|\.pid' "$REMOTE_HELPER"; then
  fail 'runtime helper uses unmanaged PID signalling'
fi
if grep -Eq 'docker (system )?prune|down[[:space:]]+(-v|--volumes)|volume[[:space:]]+rm' "$REMOTE_HELPER"; then
  fail 'runtime helper contains broad or volume-destructive Docker cleanup'
fi

test_root="$(mktemp -d "${TMPDIR:-/tmp}/predex-runtime-test.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT
fake_bin="$test_root/bin"
mkdir -p "$fake_bin"

# Mac wrapper: the private key may travel only on ssh stdin, never argv/stdout.
ssh_args_log="$test_root/ssh.args"
ssh_stdin_log="$test_root/ssh.stdin"
fake_ssh="$fake_bin/ssh"
cat > "$fake_ssh" <<'FAKE_SSH'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$@" > "$FAKE_SSH_ARGS_LOG"
cat > "$FAKE_SSH_STDIN_LOG"
printf 'remote command accepted\n'
FAKE_SSH
chmod +x "$fake_ssh"

sentinel="0x$(printf '1%.0s' {1..64})"
local_credential="$test_root/arc"
printf 'rpcUrl=https://example.invalid\nprivKey=%s\n' "$sentinel" > "$local_credential"
chmod 600 "$local_credential"
wrapper_output="$(
  FAKE_SSH_ARGS_LOG="$ssh_args_log" \
  FAKE_SSH_STDIN_LOG="$ssh_stdin_log" \
  PREDEX_RUNTIME_SSH_BIN="$fake_ssh" \
  PREDEX_OPERATOR_CREDENTIAL_FILE="$local_credential" \
  CLOUDLAB_HOST='test-host' \
  CLOUDLAB_IDENTITY_FILE="$test_root/identity" \
  "$SCRIPT" provision-operator
)"
[[ "$(tr -d '\n' < "$ssh_stdin_log")" == "$sentinel" ]] ||
  fail 'operator key was not sent exactly on ssh stdin'
assert_not_contains "$(cat "$ssh_args_log")" "$sentinel"
assert_not_contains "$wrapper_output" "$sentinel"
assert_contains "$(cat "$ssh_args_log")" 'provision-operator'

# The real credential format is accepted without a prefix but normalized
# before it reaches the strict remote/backend boundary.
printf 'privKey=%s\n' "${sentinel#0x}" > "$local_credential"
wrapper_output="$(
  FAKE_SSH_ARGS_LOG="$ssh_args_log" \
  FAKE_SSH_STDIN_LOG="$ssh_stdin_log" \
  PREDEX_RUNTIME_SSH_BIN="$fake_ssh" \
  PREDEX_OPERATOR_CREDENTIAL_FILE="$local_credential" \
  CLOUDLAB_HOST='test-host' \
  CLOUDLAB_IDENTITY_FILE="$test_root/identity" \
  "$SCRIPT" provision-operator
)"
[[ "$(tr -d '\n' < "$ssh_stdin_log")" == "$sentinel" ]] ||
  fail 'unprefixed local operator key was not normalized before ssh stdin'
assert_not_contains "$(cat "$ssh_args_log")" "$sentinel"
assert_not_contains "$wrapper_output" "$sentinel"

printf 'privKey=%s\nprivKey=%s\n' "$sentinel" "$sentinel" > "$local_credential"
if duplicate_output="$(
  PREDEX_RUNTIME_SSH_BIN="$fake_ssh" \
  PREDEX_OPERATOR_CREDENTIAL_FILE="$local_credential" \
  "$SCRIPT" provision-operator 2>&1
)"; then
  fail 'duplicate privKey records were accepted'
fi
assert_not_contains "$duplicate_output" "$sentinel"

if PREDEX_RUNTIME_SSH_BIN="$fake_ssh" "$SCRIPT" restart data >/dev/null 2>&1; then
  fail 'invalid restart scope was accepted'
fi

# Remote helper fixture with public source/evidence data and fake host tools.
remote_root="$test_root/remote"
source_root="$remote_root/source"
runtime_root="$remote_root/runtime"
user_units="$remote_root/user-units"
source_id='b11b5580e7de-5da4645336eb'
mkdir -p \
  "$source_root/scripts/cloudlab" \
  "$source_root/deploy/systemd" \
  "$source_root/backend/node_modules/.bin" \
  "$source_root/frontend/node_modules/.bin" \
  "$source_root/frontend/.next" \
  "$remote_root/evidence/$source_id" \
  "$user_units"
cp "$REMOTE_HELPER" "$source_root/scripts/cloudlab/runtime-remote.sh"
for unit in "${expected_units[@]}"; do
  cp "$UNIT_DIR/$unit" "$source_root/deploy/systemd/$unit"
done
chmod +x "$source_root/scripts/cloudlab/runtime-remote.sh"
printf '%s\n' "$source_id" > "$source_root/.predex-source-id"
printf 'build-id\n' > "$source_root/frontend/.next/BUILD_ID"
printf '{"scripts":{"api":"x","indexer":"x","operator":"x","db:migrate":"x"}}\n' > "$source_root/backend/package.json"
printf '{"scripts":{"start":"x"}}\n' > "$source_root/frontend/package.json"
for executable in tsx prisma next; do
  target="$source_root/backend/node_modules/.bin/$executable"
  [[ "$executable" == next ]] && target="$source_root/frontend/node_modules/.bin/next"
  : > "$target"
  chmod +x "$target"
done
{
  printf 'source_id=%s\n' "$source_id"
  for gate in \
    shared_typecheck shared_test agent_sdk_typecheck agent_sdk_test agent_sdk_build \
    creator_typecheck creator_test creator_build trader_typecheck trader_test \
    trader_build backend_typecheck backend_build backend_test frontend_lint \
    frontend_typecheck frontend_test frontend_build; do
    printf '%s=pass\n' "$gate"
  done
  printf 'finished_at=2026-09-07T00:00:00Z\n'
} > "$remote_root/evidence/$source_id/manifest.txt"
mkdir -p "$runtime_root"
printf 'PREDEX_EXPECTED_SOURCE_ID=%s\n' "$source_id" > "$runtime_root/runtime.env"
chmod 600 "$runtime_root/runtime.env"

systemctl_log="$test_root/systemctl.log"
fake_systemctl="$fake_bin/systemctl"
cat > "$fake_systemctl" <<'FAKE_SYSTEMCTL'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$FAKE_SYSTEMCTL_LOG"
case "$*" in
  *' is-active --quiet '*) exit 1 ;;
  *' is-active '*) printf 'inactive\n'; exit 3 ;;
  *' is-failed --quiet '*) exit 1 ;;
esac
exit 0
FAKE_SYSTEMCTL
chmod +x "$fake_systemctl"

sudo_log="$test_root/sudo.log"
fake_sudo="$fake_bin/sudo"
cat > "$fake_sudo" <<'FAKE_SUDO'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$FAKE_SUDO_LOG"
exit 0
FAKE_SUDO
chmod +x "$fake_sudo"

pnpm_log="$test_root/pnpm.log"
fake_pnpm="$fake_bin/pnpm"
cat > "$fake_pnpm" <<'FAKE_PNPM'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$FAKE_PNPM_LOG"
exit 0
FAKE_PNPM
chmod +x "$fake_pnpm"

runtime_env=(
  PREDEX_RUNTIME_TESTING=1
  PREDEX_RUNTIME_TEST_ROOT="$remote_root"
  PREDEX_RUNTIME_TEST_UNIT_DIR="$user_units"
  PREDEX_RUNTIME_NODE_BIN="$(command -v node)"
  PREDEX_RUNTIME_PNPM_BIN="$fake_pnpm"
  PREDEX_RUNTIME_SYSTEMCTL_BIN="$fake_systemctl"
  PREDEX_RUNTIME_SUDO_BIN="$fake_sudo"
  FAKE_SYSTEMCTL_LOG="$systemctl_log"
  FAKE_SUDO_LOG="$sudo_log"
  FAKE_PNPM_LOG="$pnpm_log"
)

env "${runtime_env[@]}" "$REMOTE_HELPER" unit-preflight api
printf 'wrong-source-id000000000000\n' > "$source_root/.predex-source-id"
if env "${runtime_env[@]}" "$REMOTE_HELPER" unit-preflight api >/dev/null 2>&1; then
  fail 'unit preflight accepted a changed source marker'
fi
printf '%s\n' "$source_id" > "$source_root/.predex-source-id"

printf 'keep me\n' > "$user_units/unrelated.service"
env "${runtime_env[@]}" "$REMOTE_HELPER" install >/dev/null
[[ "$(find "$user_units" -maxdepth 1 -type f \( -name 'predex-*.service' -o -name 'predex.target' \) | wc -l | tr -d '[:space:]')" == 6 ]] ||
  fail 'install did not copy exactly six Predex units'
[[ -f "$user_units/unrelated.service" ]] || fail 'install changed an unrelated unit'
assert_contains "$(cat "$sudo_log")" 'loginctl enable-linger'
assert_contains "$(cat "$systemctl_log")" '--user daemon-reload'

printf '\n# drift\n' >> "$user_units/predex-api.service"
if env "${runtime_env[@]}" "$REMOTE_HELPER" up >/dev/null 2>&1; then
  fail 'up accepted an installed unit that differed from the current source'
fi
cp "$UNIT_DIR/predex-api.service" "$user_units/predex-api.service"

remote_secret_output="$(
  printf '%s\n' "$sentinel" |
    env "${runtime_env[@]}" "$REMOTE_HELPER" provision-operator
)"
[[ "$(tr -d '\n' < "$runtime_root/operator.key")" == "$sentinel" ]] ||
  fail 'remote credential content changed'
[[ "$(file_mode "$runtime_root/operator.key")" == 600 ]] ||
  fail 'remote credential mode is not 0600'
assert_not_contains "$remote_secret_output" "$sentinel"

docker_log="$test_root/docker.log"
fake_docker="$fake_bin/docker"
cat > "$fake_docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$1" == compose ]]; then
  service="${@: -1}"
  if [[ "$*" == *' ps --all --quiet '* ]]; then
    case "$service" in
      postgres) printf '%064d\n' 1 ;;
      qdrant) printf '%064d\n' 2 ;;
      redis) printf '%064d\n' 3 ;;
    esac
  fi
  exit 0
fi
if [[ "$1" == container && "$2" == inspect ]]; then
  format="$4"
  id="$5"
  case "$format" in
    *'com.docker.compose.project'*)
      case "$id" in
        *1) service=postgres ;;
        *2) service=qdrant ;;
        *3) service=redis ;;
      esac
      printf '%s|continuity-deadline|%s|running|healthy\n' "$id" "$service"
      ;;
    *'.Type'*)
      case "$id" in
        *1) printf 'volume|continuity-deadline_predex-pump-postgres|/var/lib/postgresql/data\n' ;;
        *2) printf 'volume|continuity-deadline_predex-pump-qdrant|/qdrant/storage\n' ;;
      esac
      ;;
    *'.Mounts'*) ;;
    *'.HostConfig.Tmpfs'*) printf 'rw,noexec,nosuid,nodev,size=67108864,mode=0700\n' ;;
  esac
  exit 0
fi
if [[ "$1" == volume && "$2" == inspect ]]; then
  exit 0
fi
exit 1
FAKE_DOCKER
chmod +x "$fake_docker"

data_env=(
  "${runtime_env[@]}"
  PREDEX_RUNTIME_DOCKER_BIN="$fake_docker"
  FAKE_DOCKER_LOG="$docker_log"
)
env "${data_env[@]}" "$REMOTE_HELPER" data-up >/dev/null
env "${data_env[@]}" "$REMOTE_HELPER" down >/dev/null
docker_calls="$(cat "$docker_log")"
assert_contains "$docker_calls" 'compose --project-name continuity-deadline'
assert_contains "$docker_calls" 'up --detach postgres qdrant redis'
assert_contains "$docker_calls" 'stop postgres qdrant redis'
assert_not_contains "$docker_calls" '--volumes'
assert_not_contains "$docker_calls" 'prune'
assert_not_contains "$docker_calls" 'backend_predex-pump-postgres'

printf 'runtime shell tests passed\n'
