#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

RUNTIME_PROJECT='continuity-deadline'
PRODUCTION_REMOTE_ROOT='/users/span14/predex-builds/predex-pump'
PRODUCTION_NODE_ROOT='/users/span14/.local/predex-toolchain/node-v22.19.0-linux-x64'

if [[ "${PREDEX_RUNTIME_TESTING:-}" == 1 ]]; then
  REMOTE_ROOT="${PREDEX_RUNTIME_TEST_ROOT:?PREDEX_RUNTIME_TEST_ROOT is required in test mode}"
  USER_UNIT_DIR="${PREDEX_RUNTIME_TEST_UNIT_DIR:-$REMOTE_ROOT/user-units}"
  NODE_ROOT="${PREDEX_RUNTIME_TEST_NODE_ROOT:-$PRODUCTION_NODE_ROOT}"
else
  REMOTE_ROOT="$PRODUCTION_REMOTE_ROOT"
  USER_UNIT_DIR="$HOME/.config/systemd/user"
  NODE_ROOT="$PRODUCTION_NODE_ROOT"
  [[ "$(id -un)" == span14 ]] || {
    printf 'runtime: refusing unexpected remote user\n' >&2
    exit 1
  }
fi

SOURCE_DIR="$REMOTE_ROOT/source"
RUNTIME_DIR="$REMOTE_ROOT/runtime"
RUNTIME_BIN_DIR="$RUNTIME_DIR/bin"
RUNTIME_ENV_FILE="$RUNTIME_DIR/runtime.env"
ACTIVE_FILE="$RUNTIME_DIR/active"
OPERATOR_CREDENTIAL_FILE="$RUNTIME_DIR/operator.key"
EVIDENCE_ROOT="$REMOTE_ROOT/evidence"
COMPOSE_FILE="$SOURCE_DIR/backend/docker-compose.yml"
NODE_BIN="${PREDEX_RUNTIME_NODE_BIN:-$NODE_ROOT/bin/node}"
PNPM_BIN="${PREDEX_RUNTIME_PNPM_BIN:-$NODE_ROOT/bin/pnpm}"
SYSTEMCTL_BIN="${PREDEX_RUNTIME_SYSTEMCTL_BIN:-systemctl}"
JOURNALCTL_BIN="${PREDEX_RUNTIME_JOURNALCTL_BIN:-journalctl}"
DOCKER_BIN="${PREDEX_RUNTIME_DOCKER_BIN:-docker}"
CURL_BIN="${PREDEX_RUNTIME_CURL_BIN:-curl}"
SS_BIN="${PREDEX_RUNTIME_SS_BIN:-ss}"
SUDO_BIN="${PREDEX_RUNTIME_SUDO_BIN:-sudo}"
CHAIN_READY_TIMEOUT_SECONDS="${PREDEX_CHAIN_READY_TIMEOUT_SECONDS:-600}"

UNIT_FILES=(
  predex-data.service
  predex-api.service
  predex-indexer.service
  predex-operator.service
  predex-frontend.service
  predex.target
)
SERVICE_UNITS=(
  predex-data.service
  predex-api.service
  predex-indexer.service
  predex-operator.service
  predex-frontend.service
)
VERIFY_GATES=(
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
  frontend_lint
  frontend_typecheck
  frontend_test
  frontend_build
)

usage() {
  cat <<'HELP'
Usage: runtime-remote.sh COMMAND [ARGS]

Internal CloudLab runtime commands:
  install
  provision-operator        Reads exactly one private key from stdin.
  up | status | down
  restart api|indexer|operator|frontend
  logs [all|data|api|indexer|operator|frontend] [LINES]

Unit-only commands:
  unit-preflight data|api|indexer|operator|frontend
  data-up | data-stop | migrate-database
HELP
}

fail() {
  printf 'runtime: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

systemctl_user() {
  "$SYSTEMCTL_BIN" --user "$@"
}

docker_safe() {
  env -u OPERATOR_PRIVATE_KEY -u QA_WALLET_PRIVATE_KEY -u OPENAI_API_KEY \
    "$DOCKER_BIN" "$@"
}

compose() {
  docker_safe compose \
    --project-name "$RUNTIME_PROJECT" \
    --file "$COMPOSE_FILE" \
    "$@"
}

valid_source_id() {
  [[ "$1" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ ]]
}

current_source_id() {
  local source_id
  [[ -f "$SOURCE_DIR/.predex-source-id" && ! -L "$SOURCE_DIR/.predex-source-id" ]] ||
    fail 'the remote source marker is missing or unsafe'
  IFS= read -r source_id < "$SOURCE_DIR/.predex-source-id" || true
  valid_source_id "$source_id" || fail 'the remote source marker is invalid'
  printf '%s' "$source_id"
}

expected_source_id() {
  local line
  [[ -f "$RUNTIME_ENV_FILE" && ! -L "$RUNTIME_ENV_FILE" ]] ||
    fail 'runtime.env is missing or unsafe; run runtime.sh up'
  [[ "$(wc -l < "$RUNTIME_ENV_FILE" | tr -d '[:space:]')" == 1 ]] ||
    fail 'runtime.env must contain exactly one assignment'
  IFS= read -r line < "$RUNTIME_ENV_FILE" || true
  [[ "$line" =~ ^PREDEX_EXPECTED_SOURCE_ID=([0-9a-f]{12}-[0-9a-f]{12})$ ]] ||
    fail 'runtime.env contains an invalid source assignment'
  printf '%s' "${BASH_REMATCH[1]}"
}

assert_package_script() {
  local package_file="$1"
  local script_name="$2"
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const name = process.argv[2];
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    process.exit(typeof value.scripts?.[name] === "string" ? 0 : 1);
  ' "$package_file" "$script_name" ||
    fail "required package script is missing: $script_name"
}

assert_verified_source() {
  local source_id="$1"
  local manifest="$EVIDENCE_ROOT/$source_id/manifest.txt"
  local gate

  valid_source_id "$source_id" || fail 'refusing an invalid source ID'
  [[ -f "$manifest" && ! -L "$manifest" ]] ||
    fail "verification manifest is missing for source $source_id"
  grep -Fxq "source_id=$source_id" "$manifest" ||
    fail 'verification manifest source ID does not match the source marker'
  for gate in "${VERIFY_GATES[@]}"; do
    grep -Fxq "$gate=pass" "$manifest" ||
      fail "verification manifest is not fully passing: $gate"
  done
  grep -Eq '^finished_at=[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$manifest" ||
    fail 'verification manifest has no completion timestamp'
  [[ -s "$SOURCE_DIR/frontend/.next/BUILD_ID" ]] ||
    fail 'the verified production Next.js build is missing'
  [[ -x "$PNPM_BIN" && -x "$NODE_BIN" ]] ||
    fail 'the pinned Node.js toolchain is unavailable'
  [[ -x "$SOURCE_DIR/backend/node_modules/.bin/tsx" ]] ||
    fail 'backend runtime dependencies are unavailable'
  [[ -x "$SOURCE_DIR/frontend/node_modules/.bin/next" ]] ||
    fail 'frontend runtime dependencies are unavailable'
  assert_package_script "$SOURCE_DIR/backend/package.json" api
  assert_package_script "$SOURCE_DIR/backend/package.json" indexer
  assert_package_script "$SOURCE_DIR/backend/package.json" operator
  assert_package_script "$SOURCE_DIR/frontend/package.json" start
}

assert_source() {
  local expected current
  expected="$(expected_source_id)"
  current="$(current_source_id)"
  [[ "$current" == "$expected" ]] ||
    fail "source marker $current does not match installed runtime source $expected"
  assert_verified_source "$expected"
}

write_runtime_env() {
  local source_id="$1"
  local temporary
  mkdir -p "$RUNTIME_DIR"
  chmod 700 "$RUNTIME_DIR"
  temporary="$(mktemp "$RUNTIME_DIR/.runtime.env.XXXXXX")"
  chmod 600 "$temporary"
  printf 'PREDEX_EXPECTED_SOURCE_ID=%s\n' "$source_id" > "$temporary"
  mv -f "$temporary" "$RUNTIME_ENV_FILE"
}

credential_mode() {
  if stat -c '%a' "$OPERATOR_CREDENTIAL_FILE" >/dev/null 2>&1; then
    stat -c '%a' "$OPERATOR_CREDENTIAL_FILE"
  else
    stat -f '%Lp' "$OPERATOR_CREDENTIAL_FILE" 2>/dev/null || true
  fi
}

credential_owner_id() {
  if stat -c '%u' "$OPERATOR_CREDENTIAL_FILE" >/dev/null 2>&1; then
    stat -c '%u' "$OPERATOR_CREDENTIAL_FILE"
  else
    stat -f '%u' "$OPERATOR_CREDENTIAL_FILE" 2>/dev/null || true
  fi
}

assert_operator_credential() {
  local operator_key owner_id
  [[ -f "$OPERATOR_CREDENTIAL_FILE" && ! -L "$OPERATOR_CREDENTIAL_FILE" ]] ||
    fail 'operator credential is missing or unsafe; provision it first'
  [[ "$(credential_mode)" == 600 ]] || fail 'operator credential mode must be 0600'
  owner_id="$(credential_owner_id)"
  [[ "$owner_id" == "$(id -u)" ]] || fail 'operator credential has the wrong owner'
  IFS= read -r operator_key < "$OPERATOR_CREDENTIAL_FILE" || true
  [[ "$operator_key" =~ ^0x[0-9a-fA-F]{64}$ ]] ||
    fail 'operator credential is not a valid private-key record'
  unset operator_key
}

unit_installed() {
  [[ -f "$USER_UNIT_DIR/$1" && ! -L "$USER_UNIT_DIR/$1" ]]
}

assert_units_installed() {
  local unit
  [[ -x "$RUNTIME_BIN_DIR/runtime-remote.sh" ]] ||
    fail 'installed runtime helper is missing; run runtime.sh install'
  cmp -s \
    "$SOURCE_DIR/scripts/cloudlab/runtime-remote.sh" \
    "$RUNTIME_BIN_DIR/runtime-remote.sh" ||
    fail 'installed runtime helper does not match the current source; reinstall it'
  for unit in "${UNIT_FILES[@]}"; do
    unit_installed "$unit" || fail "systemd unit is not installed: $unit"
    cmp -s "$SOURCE_DIR/deploy/systemd/$unit" "$USER_UNIT_DIR/$unit" ||
      fail "installed systemd unit does not match the current source: $unit"
  done
}

unit_active() {
  systemctl_user is-active --quiet "$1"
}

assert_units_inactive() {
  local unit
  for unit in "${SERVICE_UNITS[@]}" predex.target; do
    if unit_active "$unit"; then
      fail "runtime unit is already active without a valid up transition: $unit"
    fi
  done
}

port_is_listening() {
  "$SS_BIN" -H -ltn "sport = :$1" 2>/dev/null | grep -q .
}

assert_ports_free() {
  local port
  for port in 3001 3002 5432 6333 6379; do
    port_is_listening "$port" && fail "required loopback port is already occupied: $port"
  done
  return 0
}

container_id() {
  compose ps --all --quiet "$1" 2>/dev/null || true
}

container_identity() {
  docker_safe container inspect --format \
    '{{.Id}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$1" 2>/dev/null || true
}

assert_named_volume() {
  local container="$1"
  local expected_name="$2"
  local expected_destination="$3"
  local mounts
  mounts="$(docker_safe container inspect --format \
    '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Destination}}{{"\n"}}{{end}}' \
    "$container")"
  [[ "$mounts" == "volume|$expected_name|$expected_destination" ]] ||
    fail "container mount does not match protected runtime volume: $expected_name"
}

assert_data_container() {
  local service="$1"
  local id identity
  id="$(container_id "$service")"
  [[ "$id" =~ ^[0-9a-f]{12,64}$ ]] || fail "missing $service container"
  identity="$(container_identity "$id")"
  [[ "$identity" == "$id|$RUNTIME_PROJECT|$service|running|healthy" ]] ||
    fail "$service is not the healthy container owned by $RUNTIME_PROJECT"
  case "$service" in
    postgres)
      assert_named_volume \
        "$id" \
        'continuity-deadline_predex-pump-postgres' \
        '/var/lib/postgresql/data'
      ;;
    qdrant)
      assert_named_volume \
        "$id" \
        'continuity-deadline_predex-pump-qdrant' \
        '/qdrant/storage'
      ;;
    redis)
      [[ -z "$(docker_safe container inspect --format '{{range .Mounts}}{{.Name}}{{end}}' "$id")" ]] ||
        fail 'runtime Redis must not have a persistent volume'
      [[ -n "$(docker_safe container inspect --format '{{index .HostConfig.Tmpfs "/data"}}' "$id")" ]] ||
        fail 'runtime Redis must use the hardened /data tmpfs'
      ;;
    *) fail "unknown data service: $service" ;;
  esac
}

wait_data() {
  local started_at=$SECONDS
  while ((SECONDS - started_at < 120)); do
    if (assert_data_container postgres) 2>/dev/null &&
      (assert_data_container qdrant) 2>/dev/null &&
      (assert_data_container redis) 2>/dev/null; then
      return
    fi
    sleep 2
  done
  fail 'continuity data containers did not become healthy and correctly isolated'
}

wait_unit_active() {
  local unit="$1"
  local started_at=$SECONDS
  while ((SECONDS - started_at < 60)); do
    unit_active "$unit" && return
    systemctl_user is-failed --quiet "$unit" && fail "$unit failed during startup"
    sleep 1
  done
  fail "$unit did not become active"
}

wait_http_reachable() {
  local label="$1"
  local url="$2"
  local require_success="$3"
  local started_at=$SECONDS
  while ((SECONDS - started_at < 120)); do
    if [[ "$require_success" == true ]]; then
      "$CURL_BIN" --fail --silent --show-error --max-time 3 "$url" >/dev/null 2>&1 && return
    else
      "$CURL_BIN" --silent --show-error --max-time 3 --output /dev/null "$url" >/dev/null 2>&1 && return
    fi
    sleep 1
  done
  fail "$label did not become reachable"
}

health_is_operator_ready() {
  "$NODE_BIN" -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const health = JSON.parse(raw);
        const ready = health.ok === true &&
          health.chainState?.ready === true &&
          health.balancesReconciled === true &&
          health.lagBlocks === 0;
        process.exit(ready ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  '
}

wait_chain_ready() {
  local started_at=$SECONDS
  local payload
  while ((SECONDS - started_at < CHAIN_READY_TIMEOUT_SECONDS)); do
    payload="$($CURL_BIN --fail --silent --show-error --max-time 5 \
      http://127.0.0.1:3001/health 2>/dev/null || true)"
    if [[ -n "$payload" ]] && printf '%s' "$payload" | health_is_operator_ready; then
      return
    fi
    sleep 2
  done
  fail 'backend did not reach chainState.ready, balancesReconciled, and lagBlocks=0'
}

install_runtime() {
  local source_unit unit
  [[ ! -e "$ACTIVE_FILE" ]] || fail 'runtime is active; stop it before reinstalling units'
  require_command "$SUDO_BIN"
  require_command "$SYSTEMCTL_BIN"
  mkdir -p "$RUNTIME_BIN_DIR" "$USER_UNIT_DIR"
  chmod 700 "$RUNTIME_DIR" "$RUNTIME_BIN_DIR"
  "$SUDO_BIN" -n loginctl enable-linger "$(id -un)"
  install -m 700 "$SOURCE_DIR/scripts/cloudlab/runtime-remote.sh" \
    "$RUNTIME_BIN_DIR/runtime-remote.sh"
  for unit in "${UNIT_FILES[@]}"; do
    source_unit="$SOURCE_DIR/deploy/systemd/$unit"
    [[ -f "$source_unit" && ! -L "$source_unit" ]] ||
      fail "checked-in unit is missing or unsafe: $unit"
    install -m 644 "$source_unit" "$USER_UNIT_DIR/$unit"
  done
  systemctl_user daemon-reload
  printf 'Installed exact Predex user units; no service was started.\n'
}

provision_operator() {
  local operator_key extra temporary
  [[ ! -e "$ACTIVE_FILE" ]] || fail 'runtime is active; refuse credential replacement'
  if unit_active predex-operator.service; then
    fail 'operator service is active; refuse credential replacement'
  fi
  IFS= read -r operator_key || fail 'operator credential was not supplied on stdin'
  if IFS= read -r extra; then
    fail 'operator credential input must contain exactly one line'
  fi
  [[ "$operator_key" =~ ^0x[0-9a-fA-F]{64}$ ]] ||
    fail 'operator credential input is invalid'
  mkdir -p "$RUNTIME_DIR"
  chmod 700 "$RUNTIME_DIR"
  temporary="$(mktemp "$RUNTIME_DIR/.operator.key.XXXXXX")"
  chmod 600 "$temporary"
  printf '%s\n' "$operator_key" > "$temporary"
  unset operator_key
  mv -f "$temporary" "$OPERATOR_CREDENTIAL_FILE"
  assert_operator_credential
  printf 'Operator credential provisioned outside the source tree with mode 0600.\n'
}

data_up() {
  assert_source
  compose up --detach postgres qdrant redis
  wait_data
}

migrate_database() {
  assert_source
  (
    cd "$SOURCE_DIR/backend"
    env -u OPERATOR_PRIVATE_KEY -u QA_WALLET_PRIVATE_KEY -u OPENAI_API_KEY \
      DATABASE_URL='postgresql://predex:predex@127.0.0.1:5432/predex_pump?schema=public' \
      DATABASE_POOL_SIZE=8 \
      "$PNPM_BIN" db:migrate
  )
}

data_stop() {
  compose stop postgres qdrant redis
  docker_safe volume inspect \
    continuity-deadline_predex-pump-postgres \
    continuity-deadline_predex-pump-qdrant >/dev/null
  printf 'Continuity data containers stopped; named volumes preserved.\n'
}

unit_preflight() {
  local scope="${1:-}"
  case "$scope" in
    data|api|indexer|frontend)
      assert_source
      ;;
    operator)
      assert_source
      assert_operator_credential
      wait_chain_ready
      ;;
    *) fail 'unit-preflight requires data, api, indexer, operator, or frontend' ;;
  esac
}

cleanup_failed_up() {
  trap - ERR INT TERM
  systemctl_user stop predex-operator.service >/dev/null 2>&1 || true
  systemctl_user stop predex-frontend.service >/dev/null 2>&1 || true
  systemctl_user stop predex-indexer.service >/dev/null 2>&1 || true
  systemctl_user stop predex-api.service >/dev/null 2>&1 || true
  systemctl_user stop predex-data.service >/dev/null 2>&1 || true
  compose stop postgres qdrant redis >/dev/null 2>&1 || true
  systemctl_user stop predex.target >/dev/null 2>&1 || true
  systemctl_user disable predex.target >/dev/null 2>&1 || true
  rm -f "$ACTIVE_FILE"
}

write_active_marker() {
  local source_id="$1"
  local temporary
  temporary="$(mktemp "$RUNTIME_DIR/.active.XXXXXX")"
  chmod 600 "$temporary"
  printf 'source_id=%s\nstarted_at=%s\n' \
    "$source_id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$temporary"
  mv -f "$temporary" "$ACTIVE_FILE"
}

up_runtime() {
  local source_id
  assert_units_installed
  [[ ! -e "$ACTIVE_FILE" ]] || fail 'runtime is already active; use status or restart'
  [[ ! -e "$SOURCE_DIR/.qa/active" ]] || fail 'QA stack is active; stop it first'
  assert_units_inactive
  assert_ports_free
  source_id="$(current_source_id)"
  assert_verified_source "$source_id"
  assert_operator_credential
  write_runtime_env "$source_id"

  trap cleanup_failed_up ERR INT TERM
  systemctl_user reset-failed "${SERVICE_UNITS[@]}" predex.target >/dev/null 2>&1 || true
  systemctl_user start predex-data.service
  wait_data
  systemctl_user start predex-api.service predex-indexer.service predex-frontend.service
  wait_unit_active predex-api.service
  wait_unit_active predex-indexer.service
  wait_unit_active predex-frontend.service
  wait_http_reachable 'Predex API' http://127.0.0.1:3001/health false
  wait_http_reachable 'Predex frontend' http://127.0.0.1:3002/ true
  wait_chain_ready
  systemctl_user start predex-operator.service
  wait_unit_active predex-operator.service
  systemctl_user start predex.target
  systemctl_user enable predex.target
  write_active_marker "$source_id"
  trap - ERR INT TERM
  printf 'Predex persistent runtime is active at source %s.\n' "$source_id"
}

status_runtime() {
  local current='absent' expected='absent' marker='inactive' unit state id
  if [[ -f "$SOURCE_DIR/.predex-source-id" ]]; then
    current="$(current_source_id)"
  fi
  if [[ -f "$RUNTIME_ENV_FILE" ]]; then
    expected="$(expected_source_id)"
  fi
  [[ -f "$ACTIVE_FILE" ]] && marker='active'
  printf 'source.current=%s\nsource.expected=%s\nruntime.marker=%s\n' \
    "$current" "$expected" "$marker"
  for unit in "${SERVICE_UNITS[@]}" predex.target; do
    state="$(systemctl_user is-active "$unit" 2>/dev/null || true)"
    printf 'unit.%s=%s\n' "$unit" "${state:-unknown}"
  done
  for unit in postgres qdrant redis; do
    id="$(container_id "$unit")"
    if [[ -n "$id" ]]; then
      printf 'container.%s=%s\n' "$unit" "$(container_identity "$id")"
    else
      printf 'container.%s=absent\n' "$unit"
    fi
  done
  if "$CURL_BIN" --fail --silent --max-time 3 http://127.0.0.1:3001/health >/dev/null 2>&1; then
    printf 'health.api=reachable\n'
  else
    printf 'health.api=unreachable\n'
  fi
  if "$CURL_BIN" --fail --silent --max-time 3 http://127.0.0.1:3002/ >/dev/null 2>&1; then
    printf 'health.frontend=reachable\n'
  else
    printf 'health.frontend=unreachable\n'
  fi
}

require_active_runtime() {
  [[ -f "$ACTIVE_FILE" && ! -L "$ACTIVE_FILE" ]] ||
    fail 'runtime active marker is absent'
  assert_source
}

restart_runtime() {
  local scope="${1:-}"
  local operator_was_active=false
  require_active_runtime
  case "$scope" in
    api)
      systemctl_user restart predex-api.service
      wait_http_reachable 'Predex API' http://127.0.0.1:3001/health false
      ;;
    frontend)
      systemctl_user restart predex-frontend.service
      wait_http_reachable 'Predex frontend' http://127.0.0.1:3002/ true
      ;;
    operator)
      wait_chain_ready
      systemctl_user restart predex-operator.service
      wait_unit_active predex-operator.service
      ;;
    indexer)
      unit_active predex-operator.service && operator_was_active=true
      if [[ "$operator_was_active" == true ]]; then
        systemctl_user stop predex-operator.service
      fi
      systemctl_user restart predex-indexer.service
      wait_unit_active predex-indexer.service
      wait_chain_ready
      if [[ "$operator_was_active" == true ]]; then
        systemctl_user start predex-operator.service
        wait_unit_active predex-operator.service
      fi
      ;;
    *) fail 'restart requires api, indexer, operator, or frontend' ;;
  esac
  printf 'Restarted Predex %s scope.\n' "$scope"
}

logs_runtime() {
  local scope="${1:-all}"
  local lines="${2:-200}"
  local units=()
  [[ "$lines" =~ ^[1-9][0-9]{0,3}$ ]] || fail 'log line count must be 1-9999'
  case "$scope" in
    all) units=("${SERVICE_UNITS[@]}") ;;
    data|api|indexer|operator|frontend) units=("predex-$scope.service") ;;
    *) fail 'logs scope must be all, data, api, indexer, operator, or frontend' ;;
  esac
  local journal_args=()
  local unit
  for unit in "${units[@]}"; do
    journal_args+=(--unit "$unit")
  done
  "$JOURNALCTL_BIN" --user --no-pager --lines "$lines" "${journal_args[@]}"
}

down_runtime() {
  systemctl_user stop predex-operator.service
  systemctl_user stop predex-frontend.service
  systemctl_user stop predex-indexer.service
  systemctl_user stop predex-api.service
  systemctl_user stop predex-data.service
  # ExecStop normally performs this exact stop. Repeat it deliberately so an
  # already-inactive oneshot unit cannot leave unless-stopped containers live.
  data_stop
  systemctl_user stop predex.target
  systemctl_user disable predex.target >/dev/null 2>&1 || true
  rm -f "$ACTIVE_FILE"
  printf 'Predex runtime stopped; continuity named volumes and operator credential preserved.\n'
}

main() {
  local command_name="${1:---help}"
  shift || true
  case "$command_name" in
    --help|-h|help) usage ;;
    install) [[ $# -eq 0 ]] || fail 'install accepts no arguments'; install_runtime ;;
    provision-operator)
      [[ $# -eq 0 ]] || fail 'provision-operator accepts no arguments'
      provision_operator
      ;;
    up) [[ $# -eq 0 ]] || fail 'up accepts no arguments'; up_runtime ;;
    status) [[ $# -eq 0 ]] || fail 'status accepts no arguments'; status_runtime ;;
    restart) [[ $# -eq 1 ]] || fail 'restart requires one scope'; restart_runtime "$1" ;;
    logs) [[ $# -le 2 ]] || fail 'logs accepts at most scope and line count'; logs_runtime "$@" ;;
    down) [[ $# -eq 0 ]] || fail 'down accepts no arguments'; down_runtime ;;
    unit-preflight)
      [[ $# -eq 1 ]] || fail 'unit-preflight requires one scope'
      unit_preflight "$1"
      ;;
    data-up) [[ $# -eq 0 ]] || fail 'data-up accepts no arguments'; data_up ;;
    data-stop) [[ $# -eq 0 ]] || fail 'data-stop accepts no arguments'; data_stop ;;
    migrate-database)
      [[ $# -eq 0 ]] || fail 'migrate-database accepts no arguments'
      migrate_database
      ;;
    *) fail "unknown command: $command_name" ;;
  esac
}

main "$@"
