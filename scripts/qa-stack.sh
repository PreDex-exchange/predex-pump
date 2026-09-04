#!/usr/bin/env bash
# Predex browser-QA stack.
#
# QA entry points (the operator supplies the key; this script never prints or
# persists it):
#   QA_WALLET_PRIVATE_KEY=<set-in-shell> ./scripts/qa-stack.sh up --read-only
#   QA_WALLET_PRIVATE_KEY=<set-in-shell> ./scripts/qa-stack.sh up --read-only --fixtures
#   QA_WALLET_PRIVATE_KEY=<set-in-shell> ./scripts/qa-stack.sh up --broadcast
#   ./scripts/qa-stack.sh up --external-wallet
#   ./scripts/qa-stack.sh down
#
# The frontend is always http://127.0.0.1:3002 (never port 3000). Useful pages:
# /, /create, /market/1, /market/2, /portfolio, /account, and /activity.
# With --fixtures, market 1 is live on HYBRID, market 2 is resolved, and market 3
# is open on the curve. By default the stack attaches to the canonical `backend`
# Compose project's Postgres/Qdrant/Redis containers. Set QA_COMPOSE_PROJECT to use a
# different, isolated Compose project. `down` never removes attached containers
# and never removes Docker networks or named volumes. Anonymous volumes on
# QA-created containers are removed; Redis itself is disposable and tmpfs-backed.
set -Eeuo pipefail
IFS=$'\n\t'

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
STATE_DIR="$ROOT_DIR/.qa"
LOG_DIR="$STATE_DIR/logs"
COMPOSE_FILE="$ROOT_DIR/backend/docker-compose.yml"
COMPOSE_PROJECT="${QA_COMPOSE_PROJECT:-backend}"
DATABASE_URL="postgresql://predex:predex@127.0.0.1:5432/predex_pump?schema=public"
REDIS_URL="redis://127.0.0.1:6379"
FRONTEND_URL="http://127.0.0.1:3002"
BACKEND_URL="http://127.0.0.1:3001"
WALLET_URL="http://127.0.0.1:3003"
WALLET_SCRIPT_URL="$WALLET_URL/provider.js"
FRONTEND_WS_URL="${QA_FRONTEND_WS_URL:-ws://127.0.0.1:3001/ws}"
MODE="read-only"
SEED_FIXTURES=false
EXTERNAL_WALLET=false
# When set, QA runs the wallet shim + frontend ONLY, against an already
# deployed backend. This is the only way to exercise the cross-site session
# cookie, the nginx /pump route and the WebSocket proxy — a local backend
# tests none of them.
REMOTE_API=""
COMPOSE_PROJECT_FILE="$STATE_DIR/compose-project"
CREATED_CONTAINERS_FILE="$STATE_DIR/docker-created-containers"
STARTED_CONTAINERS_FILE="$STATE_DIR/docker-started-containers"
ATTACHED_SERVICES=()
CREATED_SERVICES=()
STARTED_EXISTING_SERVICES=()

usage() {
  cat <<'HELP'
Usage:
  QA_WALLET_PRIVATE_KEY=<set-in-shell> ./scripts/qa-stack.sh up [--read-only]
  QA_WALLET_PRIVATE_KEY=<set-in-shell> ./scripts/qa-stack.sh up --read-only --fixtures
  QA_WALLET_PRIVATE_KEY=<set-in-shell> ./scripts/qa-stack.sh up --broadcast
  ./scripts/qa-stack.sh up --external-wallet
  ./scripts/qa-stack.sh down
  ./scripts/qa-stack.sh --help

Modes:
  --read-only  Default. Signs SIWE messages and EIP-712 orders, but rejects
               eth_sendTransaction before any network request. No chain writes.
  --fixtures   Reset the selected loopback QA database and seed deterministic
               opened, graduated, and resolved markets before services start.
  --remote-api URL
               Run the wallet shim and frontend ONLY, against an already
               deployed backend (e.g. https://api.predex.exchange/pump).
               Skips Docker, Prisma and the local backend. Required to test
               the cross-site session cookie, the nginx route and the WS
               proxy; a local backend exercises none of those.
  --broadcast  Enables eth_sendTransaction for approvals and fills. The local
               signer signs and broadcasts to Arc testnet. Use deliberately.
  --external-wallet
               Starts no signer and injects no QA provider. Use this mode to
               test the real MetaMask connector. Wallet confirmations can
               broadcast, so the wallet operator controls every chain write.

Runtime key:
  QA_WALLET_PRIVATE_KEY is required by `up` unless --external-wallet is used.
  It must be a 0x-prefixed 32-byte private key supplied by the operator at
  runtime. The value is never printed, logged, saved to a file, passed to
  Next/backend, or built into assets.

State services:
  QA_COMPOSE_PROJECT=backend is the default. It attaches to the canonical
  backend-postgres-1, backend-qdrant-1, and backend-redis-1 containers. Redis is
  a disposable cache with no persisted volume.

  For a genuinely isolated stack, first make sure ports 5432, 6333, and 6379 are free,
  then choose a new project namespace explicitly:
    QA_COMPOSE_PROJECT=my-qa-stack QA_WALLET_PRIVATE_KEY=<set-in-shell> \
      ./scripts/qa-stack.sh up --read-only

  The selected project is recorded for teardown, so the matching `down` command
  does not need the override to be repeated. Each project has separate named
  volumes; changing the project changes which database state the UI displays.

QA URLs:
  Frontend       http://127.0.0.1:3002
  Backend REST   http://127.0.0.1:3001
  Backend WS     ws://127.0.0.1:3001/ws
  Wallet health  http://127.0.0.1:3003/healthz

WebSocket fault injection:
  QA_FRONTEND_WS_URL=ws://127.0.0.1:3999/ws points only the frontend at a
  dead loopback socket while REST remains healthy. This is intended for
  verifying polling fallback; the default remains the backend's /ws route.

Pages and useful fixtures:
  /              market list
  /create        create flow
  /market/1      live HYBRID venue; tick=1000 raw (0.001), size multiple=1000 raw
  /market/2      resolved market
  /market/3      open bonding-curve market and mobile trade sheet
  /portfolio     connected-wallet positions
  /account       SIWE account/profile
  /activity      indexed activity

Production gate:
  The provider source is external to the Next module graph and next.config.ts
  exposes its script URL only during PHASE_DEVELOPMENT_SERVER with the explicit
  QA_WALLET_ENABLED flag. Production builds bake in an empty URL and scan their
  artifacts for the provider marker/key. The signer also refuses NODE_ENV=production.

Teardown:
  `down` stops only the signer, backend, and frontend processes recorded by `up`.
  Attached Postgres/Qdrant/Redis containers are never stopped or removed. A previously
  stopped container started by `up` is stopped again; a container created by
  `up` is removed by exact container ID. Docker networks and named volumes are
  always retained. Anonymous volumes on QA-created containers are removed, while
  non-secret process logs remain under .qa/logs/.
HELP
}

fail() {
  printf 'qa-stack: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

validate_compose_project() {
  [[ "$COMPOSE_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] ||
    fail 'QA_COMPOSE_PROJECT must start with a lowercase letter or digit and contain only lowercase letters, digits, hyphens, or underscores'
}

docker_command() {
  env -u QA_WALLET_PRIVATE_KEY docker "$@"
}

compose() {
  docker_command compose \
    --project-name "$COMPOSE_PROJECT" --file "$COMPOSE_FILE" "$@"
}

compose_service_container_id() {
  local service="$1"
  local output
  output="$(compose ps --all --quiet "$service")"
  if [[ "$output" == *$'\n'* ]]; then
    fail "compose project '$COMPOSE_PROJECT' has more than one container for service '$service'"
  fi
  if [[ -n "$output" && ! "$output" =~ ^[0-9a-f]{12,64}$ ]]; then
    fail "unexpected container ID for compose project '$COMPOSE_PROJECT' service '$service'"
  fi
  printf '%s' "$output"
}

compose_running_service_container_id() {
  local service="$1"
  local output
  output="$(compose ps --status running --quiet "$service")"
  if [[ "$output" == *$'\n'* ]]; then
    fail "compose project '$COMPOSE_PROJECT' has more than one running container for service '$service'"
  fi
  if [[ -n "$output" && ! "$output" =~ ^[0-9a-f]{12,64}$ ]]; then
    fail "unexpected running container ID for compose project '$COMPOSE_PROJECT' service '$service'"
  fi
  printf '%s' "$output"
}

port_is_listening() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1 &&
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    return 0
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    return 1
  fi
  fail 'port checks require lsof or nc'
}

compose_service_owns_host_port() {
  local service="$1"
  local container_port="$2"
  local host_port="$3"
  local container_id
  local mapping
  container_id="$(compose_running_service_container_id "$service")"
  [[ -n "$container_id" ]] || return 1
  while IFS= read -r mapping; do
    if [[ -n "$mapping" && "${mapping##*:}" == "$host_port" ]]; then
      return 0
    fi
  done < <(docker_command container port "$container_id" "${container_port}/tcp" 2>/dev/null)
  return 1
}

assert_application_ports_free() {
  local port
  for port in 3001 3002 3003; do
    if port_is_listening "$port"; then
      fail "TCP port $port is already occupied; backend, frontend, and signer ports must be free"
    fi
  done
}

assert_database_port() {
  local service="$1"
  local container_port="$2"
  local host_port="$3"
  local running_id
  if port_is_listening "$host_port"; then
    if compose_service_owns_host_port "$service" "$container_port" "$host_port"; then
      return
    fi
    fail "TCP port $host_port is occupied by an unrelated process; compose project '$COMPOSE_PROJECT' service '$service' does not publish that port"
  fi

  if compose_service_owns_host_port "$service" "$container_port" "$host_port"; then
    fail "compose project '$COMPOSE_PROJECT' service '$service' publishes TCP port $host_port, but the port is not listening"
  fi
  running_id="$(compose_running_service_container_id "$service")"
  if [[ -n "$running_id" ]]; then
    fail "compose project '$COMPOSE_PROJECT' service '$service' is running but does not publish required TCP port $host_port"
  fi
}

assert_ports_usable() {
  assert_application_ports_free
  assert_database_port postgres 5432 5432
  assert_database_port qdrant 6333 6333
  assert_database_port redis 6379 6379
}

install_runtime_dependencies() {
  if [[ ! -f "$ROOT_DIR/shared/node_modules/viem/package.json" ]]; then
    printf 'Installing shared dependencies from the frozen lockfile...\n'
    (
      cd "$ROOT_DIR/shared"
      unset QA_WALLET_PRIVATE_KEY OPENAI_API_KEY
      pnpm install --frozen-lockfile
    )
  fi
  if [[ ! -x "$ROOT_DIR/backend/node_modules/.bin/prisma" || ! -x "$ROOT_DIR/backend/node_modules/.bin/tsx" ]]; then
    printf 'Installing backend dependencies from the frozen lockfile...\n'
    (
      cd "$ROOT_DIR/backend"
      unset QA_WALLET_PRIVATE_KEY OPENAI_API_KEY
      pnpm install --frozen-lockfile
    )
  fi
  if [[ ! -x "$ROOT_DIR/frontend/node_modules/.bin/next" ]]; then
    printf 'Installing frontend dependencies from the frozen lockfile...\n'
    (
      cd "$ROOT_DIR/frontend"
      unset QA_WALLET_PRIVATE_KEY OPENAI_API_KEY
      pnpm install --frozen-lockfile
    )
  fi
}

pid_is_running() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" >/dev/null 2>&1
}

process_children() {
  local pid="$1"
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -P "$pid" 2>/dev/null || true
  fi
}

process_working_directory() {
  local pid="$1"
  if [[ -e "/proc/$pid/cwd" ]]; then
    readlink "/proc/$pid/cwd" 2>/dev/null || true
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/ { print substr($0, 2); exit }'
  fi
}

pid_belongs_to_service() {
  local name="$1"
  local pid="$2"
  local command_line
  local expected_directory
  local working_directory
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$name" in
    wallet)
      expected_directory="$ROOT_DIR/frontend"
      [[ "$command_line" == *qa/server.mjs* ]] || return 1
      ;;
    backend)
      expected_directory="$ROOT_DIR/backend"
      [[ "$command_line" == *src/start.ts* ]] || return 1
      ;;
    frontend)
      expected_directory="$ROOT_DIR/frontend"
      [[ "$command_line" == *next* ]] || return 1
      ;;
    *)
      return 1
      ;;
  esac
  working_directory="$(process_working_directory "$pid")"
  [[ "$working_directory" == "$expected_directory" ]]
}

terminate_process_tree() {
  local pid="$1"
  local child
  local children=()
  if ! pid_is_running "$pid"; then
    return
  fi
  while IFS= read -r child; do
    [[ -n "$child" ]] && children+=("$child")
  done < <(process_children "$pid")
  kill -TERM "$pid" >/dev/null 2>&1 || true
  # bash 3.2 (macOS default) treats an empty array's "${arr[@]}" as unbound
  # under `set -u`, so a leaf process with no children aborted `down`.
  for child in ${children[@]+"${children[@]}"}; do
    terminate_process_tree "$child"
  done
}

stop_pid_file() {
  local name="$1"
  local pid_file="$STATE_DIR/$name.pid"
  local pid
  local attempt
  [[ -f "$pid_file" ]] || return 0
  pid="$(tr -d '[:space:]' < "$pid_file")"
  if pid_is_running "$pid"; then
    if ! pid_belongs_to_service "$name" "$pid"; then
      printf 'Skipping stale %s pid %s because it is not the recorded QA service.\n' "$name" "$pid" >&2
      rm -f "$pid_file"
      return
    fi
    printf 'Stopping %s (pid %s)...\n' "$name" "$pid"
    terminate_process_tree "$pid"
    for attempt in {1..50}; do
      pid_is_running "$pid" || break
      sleep 0.2
    done
    if pid_is_running "$pid"; then
      kill -KILL "$pid" >/dev/null 2>&1 || true
    fi
  fi
  rm -f "$pid_file"
}

stop_processes() {
  stop_pid_file frontend
  stop_pid_file backend
  stop_pid_file wallet
}

record_container() {
  local record_file="$1"
  local service="$2"
  local container_id="$3"
  printf '%s %s\n' "$service" "$container_id" >> "$record_file"
}

record_compose_project() {
  printf '%s\n' "$COMPOSE_PROJECT" > "$COMPOSE_PROJECT_FILE"
}

load_recorded_compose_project() {
  local recorded_project
  [[ -f "$COMPOSE_PROJECT_FILE" ]] ||
    fail 'QA Docker ownership state has no recorded compose project; refusing to change Docker services'
  IFS= read -r recorded_project < "$COMPOSE_PROJECT_FILE" || true
  [[ "$recorded_project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] ||
    fail 'recorded QA compose project is invalid; refusing to change Docker services'
  COMPOSE_PROJECT="$recorded_project"
}

wait_for_compose_service() {
  local service="$1"
  local container_id="$2"
  local status
  local started_at=$SECONDS
  while (( SECONDS - started_at < 60 )); do
    status="$(docker_command container inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
    case "$status" in
      healthy|running)
        printf '%s is healthy.\n' "$service"
        return
        ;;
      unhealthy|exited|dead)
        fail "compose service '$service' entered state '$status' before becoming healthy"
        ;;
    esac
    sleep 1
  done
  fail "compose service '$service' did not become healthy within 60s"
}

start_or_attach_compose_service() {
  local service="$1"
  local existing_id
  local running_id
  local created_id
  existing_id="$(compose_service_container_id "$service")"
  running_id="$(compose_running_service_container_id "$service")"

  if [[ -n "$running_id" ]]; then
    [[ -z "$existing_id" || "$existing_id" == "$running_id" ]] ||
      fail "compose service '$service' has inconsistent running and existing container IDs"
    wait_for_compose_service "$service" "$running_id"
    ATTACHED_SERVICES+=("$service")
    return
  fi

  if [[ -n "$existing_id" ]]; then
    record_container "$STARTED_CONTAINERS_FILE" "$service" "$existing_id"
    compose start "$service"
    wait_for_compose_service "$service" "$existing_id"
    STARTED_EXISTING_SERVICES+=("$service")
    return
  fi

  if ! compose create "$service"; then
    created_id="$(compose_service_container_id "$service" || true)"
    if [[ -n "$created_id" ]]; then
      record_container "$CREATED_CONTAINERS_FILE" "$service" "$created_id"
    fi
    return 1
  fi
  created_id="$(compose_service_container_id "$service")"
  [[ -n "$created_id" ]] || fail "compose create did not create a container for service '$service'"
  record_container "$CREATED_CONTAINERS_FILE" "$service" "$created_id"
  compose start "$service"
  wait_for_compose_service "$service" "$created_id"
  CREATED_SERVICES+=("$service")
}

join_services() {
  local joined=''
  local service
  for service in "$@"; do
    if [[ -n "$joined" ]]; then
      joined+=', '
    fi
    joined+="$service"
  done
  printf '%s' "$joined"
}

report_compose_attachment() {
  local project_kind='override'
  if [[ "$COMPOSE_PROJECT" == backend ]]; then
    project_kind='canonical'
  fi
  printf 'Compose project: %s (%s)\n' "$COMPOSE_PROJECT" "$project_kind"
  printf 'Database URL:   %s\n' "$DATABASE_URL"
  printf 'Redis URL:      %s\n' "$REDIS_URL"
  if ((${#ATTACHED_SERVICES[@]})); then
    printf 'Attached to existing services: %s\n' "$(join_services "${ATTACHED_SERVICES[@]}")"
  fi
  if ((${#STARTED_EXISTING_SERVICES[@]})); then
    printf 'Started pre-existing stopped services: %s\n' "$(join_services "${STARTED_EXISTING_SERVICES[@]}")"
  fi
  if ((${#CREATED_SERVICES[@]})); then
    printf 'Started new services: %s\n' "$(join_services "${CREATED_SERVICES[@]}")"
  fi
}

prepare_compose_services() {
  record_compose_project
  start_or_attach_compose_service postgres
  start_or_attach_compose_service qdrant
  start_or_attach_compose_service redis
  assert_database_port postgres 5432 5432
  assert_database_port qdrant 6333 6333
  assert_database_port redis 6379 6379
  report_compose_attachment
}

container_compose_identity() {
  local container_id="$1"
  docker_command container inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}' "$container_id" 2>/dev/null
}

teardown_recorded_containers() {
  local record_file="$1"
  local action="$2"
  local service
  local container_id
  local extra
  local identity
  local result=0
  [[ -f "$record_file" ]] || return 0

  while IFS=' ' read -r service container_id extra; do
    [[ -n "$service" && -n "$container_id" && -z "${extra:-}" ]] || {
      printf 'Skipping invalid QA Docker ownership record in %s.\n' "$record_file" >&2
      result=1
      continue
    }
    case "$service" in
      postgres|qdrant|redis) ;;
      *)
        printf 'Skipping unknown QA Docker service %s.\n' "$service" >&2
        result=1
        continue
        ;;
    esac
    if [[ ! "$container_id" =~ ^[0-9a-f]{12,64}$ ]]; then
      printf 'Skipping invalid QA Docker container ID for %s.\n' "$service" >&2
      result=1
      continue
    fi
    if ! identity="$(container_compose_identity "$container_id")"; then
      printf 'Could not verify recorded %s container %s; leaving it unchanged.\n' "$service" "$container_id" >&2
      result=1
      continue
    fi
    if [[ "$identity" != "$COMPOSE_PROJECT|$service" ]]; then
      printf 'Skipping container %s because it is not compose project %s service %s.\n' "$container_id" "$COMPOSE_PROJECT" "$service" >&2
      result=1
      continue
    fi
    case "$action" in
      stop)
        printf 'Stopping pre-existing %s container started by this QA run (%s)...\n' "$service" "$container_id"
        docker_command container stop "$container_id" >/dev/null || result=1
        ;;
      remove)
        printf 'Removing %s container created by this QA run (%s)...\n' "$service" "$container_id"
        docker_command container rm --force --volumes "$container_id" >/dev/null || result=1
        ;;
      *)
        fail "unknown Docker teardown action: $action"
        ;;
    esac
  done < "$record_file"
  return "$result"
}

teardown_owned_compose_services() {
  local result=0
  teardown_recorded_containers "$STARTED_CONTAINERS_FILE" stop || result=1
  teardown_recorded_containers "$CREATED_CONTAINERS_FILE" remove || result=1
  return "$result"
}

print_log_tail() {
  local name="$1"
  local log_file="$LOG_DIR/$name.log"
  if [[ -s "$log_file" ]]; then
    printf '\nLast %s log lines:\n' "$name" >&2
    tail -n 30 "$log_file" >&2
  fi
}

cleanup_failed_up() {
  local status=$?
  local docker_cleanup_status=0
  trap - ERR INT TERM
  printf '\nQA stack startup failed; cleaning up partial state.\n' >&2
  print_log_tail wallet
  print_log_tail backend
  print_log_tail frontend
  stop_processes
  if [[ -f "$COMPOSE_PROJECT_FILE" ]]; then
    load_recorded_compose_project
    teardown_owned_compose_services || docker_cleanup_status=$?
  fi
  rm -f "$STATE_DIR/docker.started" "$STATE_DIR/active"
  if ((docker_cleanup_status == 0)); then
    rm -f "$CREATED_CONTAINERS_FILE" "$STARTED_CONTAINERS_FILE" \
      "$COMPOSE_PROJECT_FILE"
  else
    printf 'Docker cleanup was incomplete; exact ownership records were retained for a later `qa-stack.sh down`.\n' >&2
  fi
  exit "$status"
}

wait_until() {
  local name="$1"
  local pid_file="$2"
  local timeout_seconds="$3"
  local check_function="$4"
  local started_at=$SECONDS
  local pid
  while (( SECONDS - started_at < timeout_seconds )); do
    if "$check_function" >/dev/null 2>&1; then
      printf '%s is healthy.\n' "$name"
      return
    fi
    pid="$(tr -d '[:space:]' < "$pid_file")"
    if ! pid_is_running "$pid"; then
      fail "$name exited before becoming healthy"
    fi
    sleep 1
  done
  fail "$name did not become healthy within ${timeout_seconds}s"
}

wallet_is_healthy() {
  curl --fail --silent --show-error --max-time 3 "$WALLET_URL/healthz" |
    node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => {
        const body = JSON.parse(raw);
        process.exit(body.ok === true && body.chainId === 5042002 && body.mode === process.argv[1] ? 0 : 1);
      });
    ' "$MODE"
}

backend_is_healthy() {
  curl --fail --silent --show-error --max-time 3 "$BACKEND_URL/health" |
    node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => {
        const body = JSON.parse(raw);
        process.exit(body.ok === true && body.chainId === 5042002 ? 0 : 1);
      });
    '
}

frontend_is_healthy() {
  local html
  local provider_script
  html="$(curl --fail --silent --show-error --max-time 5 "$FRONTEND_URL/")" || return 1
  if [[ "$EXTERNAL_WALLET" == true ]]; then
    [[ "$html" != *"$WALLET_SCRIPT_URL"* ]] || return 1
    ! port_is_listening 3003
    return
  fi
  [[ "$html" == *"$WALLET_SCRIPT_URL"* ]] || return 1
  provider_script="$(curl --fail --silent --show-error --max-time 3 "$WALLET_SCRIPT_URL")" || return 1
  [[ "$provider_script" == *PREDEX_QA_INJECTED_PROVIDER_V1* ]]
}

launch_wallet() {
  (
    cd "$ROOT_DIR/frontend"
    export NODE_ENV=development
    export QA_WALLET_MODE="$MODE"
    export QA_WALLET_PORT=3003
    export QA_WALLET_ALLOWED_ORIGIN="$FRONTEND_URL"
    exec node qa/server.mjs
  ) >>"$LOG_DIR/wallet.log" 2>&1 &
  printf '%s\n' "$!" > "$STATE_DIR/wallet.pid"
}

launch_backend() {
  (
    cd "$ROOT_DIR/backend"
    unset QA_WALLET_PRIVATE_KEY OPENAI_API_KEY
    export NODE_ENV=development
    export DATABASE_URL
    export REDIS_URL
    export API_HOST=127.0.0.1
    export API_PORT=3001
    export QDRANT_URL=http://127.0.0.1:6333
    export PREDEX_WEB_ORIGIN="$FRONTEND_URL"
    export SIWE_DOMAIN=127.0.0.1:3002
    export SIWE_URI="$FRONTEND_URL"
    export ACCOUNT_COOKIE_SECURE=false
    exec ./node_modules/.bin/tsx src/start.ts
  ) >>"$LOG_DIR/backend.log" 2>&1 &
  printf '%s\n' "$!" > "$STATE_DIR/backend.pid"
}

launch_frontend() {
  (
    cd "$ROOT_DIR/frontend"
    unset QA_WALLET_PRIVATE_KEY OPENAI_API_KEY
    export NODE_ENV=development
    configure_frontend_wallet
    if [[ -n "$REMOTE_API" ]]; then
      export NEXT_PUBLIC_API_URL="$REMOTE_API"
      export NEXT_PUBLIC_WS_URL="$(printf '%s' "$REMOTE_API" | sed -e 's|^https://|wss://|' -e 's|^http://|ws://|')/ws"
    else
      export NEXT_PUBLIC_API_URL="$BACKEND_URL"
      export NEXT_PUBLIC_WS_URL="$FRONTEND_WS_URL"
    fi
    export NEXT_PUBLIC_ARC_EXPLORER_URL=https://testnet.arcscan.app
    export NEXT_PUBLIC_AGENT_ADDRESSES="${NEXT_PUBLIC_AGENT_ADDRESSES:-}"
    exec ./node_modules/.bin/next dev --hostname 127.0.0.1 --port 3002
  ) >>"$LOG_DIR/frontend.log" 2>&1 &
  printf '%s\n' "$!" > "$STATE_DIR/frontend.pid"
}

configure_frontend_wallet() {
  if [[ "$EXTERNAL_WALLET" == true ]]; then
    unset QA_WALLET_ENABLED QA_WALLET_SCRIPT_URL
    return
  fi
  export QA_WALLET_ENABLED=1
  export QA_WALLET_SCRIPT_URL="$WALLET_SCRIPT_URL"
}

prepare_wallet_mode() {
  if [[ "$EXTERNAL_WALLET" == true ]]; then
    unset QA_WALLET_PRIVATE_KEY
    return
  fi
  [[ -n "${QA_WALLET_PRIVATE_KEY:-}" ]] ||
    fail 'QA_WALLET_PRIVATE_KEY must be supplied by the operator at runtime'
  [[ "$QA_WALLET_PRIVATE_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]] ||
    fail 'QA_WALLET_PRIVATE_KEY must be a 0x-prefixed 32-byte private key'
}

up() {
  [[ ! -e "$STATE_DIR/active" && ! -e "$STATE_DIR/docker.started" &&
    ! -e "$COMPOSE_PROJECT_FILE" && ! -e "$CREATED_CONTAINERS_FILE" &&
    ! -e "$STARTED_CONTAINERS_FILE" ]] ||
    fail 'QA state already exists; run ./scripts/qa-stack.sh down first'
  prepare_wallet_mode

  require_command node
  require_command pnpm
  require_command curl
  if [[ -z "$REMOTE_API" ]]; then
    require_command docker
    validate_compose_project
    [[ "$FRONTEND_WS_URL" =~ ^ws://(127\.0\.0\.1|localhost):[0-9]+/ws$ ]] ||
      fail 'QA_FRONTEND_WS_URL must be a loopback ws:// URL ending in /ws'
    docker_command info >/dev/null 2>&1 || fail 'Docker is not available'
    assert_ports_usable
  else
    # Only the signer and frontend run locally; 3001 belongs to the deployed API.
    for port in 3002 3003; do
      port_is_listening "$port" &&
        fail "TCP port $port is already occupied; frontend and signer ports must be free"
    done
    printf 'Running against deployed API: %s\n' "$REMOTE_API"
  fi
  install_runtime_dependencies

  mkdir -p "$LOG_DIR"
  : > "$LOG_DIR/wallet.log"
  : > "$LOG_DIR/backend.log"
  : > "$LOG_DIR/frontend.log"
  trap cleanup_failed_up ERR INT TERM

  if [[ -n "$REMOTE_API" ]]; then
    curl -fsS --max-time 15 "$REMOTE_API/health" >/dev/null 2>&1 ||
      fail "deployed API is not reachable at $REMOTE_API/health"
    printf 'Deployed API is healthy.\n'
  fi

  if [[ -z "$REMOTE_API" ]]; then
  prepare_compose_services

  printf 'Applying Prisma migrations...\n'
  (
    cd "$ROOT_DIR/backend"
    unset QA_WALLET_PRIVATE_KEY OPENAI_API_KEY
    DATABASE_URL="$DATABASE_URL" ./node_modules/.bin/prisma migrate deploy
  )
  printf 'Regenerating Prisma client after migrations...\n'
  (
    cd "$ROOT_DIR/backend"
    unset QA_WALLET_PRIVATE_KEY OPENAI_API_KEY
    DATABASE_URL="$DATABASE_URL" ./node_modules/.bin/prisma generate
  )

  if [[ "$SEED_FIXTURES" == true ]]; then
    printf 'Seeding deterministic QA market fixtures...\n'
    (
      cd "$ROOT_DIR/backend"
      unset QA_WALLET_PRIVATE_KEY OPENAI_API_KEY
      DATABASE_URL="$DATABASE_URL" \
        TEST_DATABASE_URL="$DATABASE_URL" \
        PREDEX_QA_FIXTURES=1 \
        ./node_modules/.bin/tsx tests/seed-qa-database.ts
    )
  fi

  fi

  if [[ "$EXTERNAL_WALLET" == false ]]; then
    launch_wallet
    # The already-running signer is the only child allowed to retain the key.
    unset QA_WALLET_PRIVATE_KEY
    wait_until 'QA wallet signer' "$STATE_DIR/wallet.pid" 30 wallet_is_healthy
  fi
  if [[ -z "$REMOTE_API" ]]; then
    launch_backend
    wait_until 'Backend/indexer' "$STATE_DIR/backend.pid" 240 backend_is_healthy
  fi
  launch_frontend
  if [[ "$EXTERNAL_WALLET" == true ]]; then
    wait_until 'Frontend without QA provider' "$STATE_DIR/frontend.pid" 180 frontend_is_healthy
  else
    wait_until 'Frontend/provider injection' "$STATE_DIR/frontend.pid" 180 frontend_is_healthy
  fi

  : > "$STATE_DIR/active"
  trap - ERR INT TERM
  local wallet_account
  local displayed_mode="$MODE"
  if [[ "$EXTERNAL_WALLET" == true ]]; then
    wallet_account='external MetaMask (no QA provider)'
    displayed_mode='external-wallet'
  else
    wallet_account="$(curl --fail --silent --show-error "$WALLET_URL/healthz" |
      node -e '
        let raw = "";
        process.stdin.on("data", (chunk) => { raw += chunk; });
        process.stdin.on("end", () => process.stdout.write(JSON.parse(raw).account));
      ')"
  fi
  printf '\nPredex QA stack is ready (mode: %s).\n' "$displayed_mode"
  printf 'Frontend:      %s\n' "$FRONTEND_URL"
  if [[ -n "$REMOTE_API" ]]; then
    printf 'Backend REST:  %s  (deployed)\n' "$REMOTE_API"
    printf 'Backend WS:    %s/ws\n' \
      "$(printf '%s' "$REMOTE_API" | sed -e 's|^https://|wss://|' -e 's|^http://|ws://|')"
  else
    printf 'Backend REST:  %s\n' "$BACKEND_URL"
    printf 'Backend WS:    ws://127.0.0.1:3001/ws\n'
    printf 'Frontend WS:   %s\n' "$FRONTEND_WS_URL"
  fi
  printf 'Wallet:        %s\n' "$wallet_account"
  # Market ids are deployment-specific; list what this backend actually serves
  # rather than hardcoding fixtures that may not exist.
  local listed
  listed="$(curl -fsS --max-time 15 "${REMOTE_API:-$BACKEND_URL}/markets" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{
      const items=JSON.parse(s).items||[];
      console.log(items.map(m=>"#"+m.id+" "+m.phase).join("  "));
    }catch{console.log("")}})' 2>/dev/null || true)"
  if [[ -n "$listed" ]]; then
    printf 'Markets:       %s\n' "$listed"
  else
    printf 'Markets:       (none indexed)\n'
  fi
  printf 'Logs:          %s\n' "$LOG_DIR"
  printf 'Teardown:      ./scripts/qa-stack.sh down\n'
}

down() {
  local docker_result
  local docker_status=0
  mkdir -p "$STATE_DIR"
  stop_processes
  if [[ -f "$COMPOSE_PROJECT_FILE" ]]; then
    load_recorded_compose_project
  elif [[ -f "$CREATED_CONTAINERS_FILE" || -f "$STARTED_CONTAINERS_FILE" ]]; then
    fail 'QA Docker ownership records exist without a compose project; refusing to change Docker services'
  fi

  if [[ -f "$CREATED_CONTAINERS_FILE" || -f "$STARTED_CONTAINERS_FILE" ]]; then
    teardown_owned_compose_services || docker_status=$?
    if ((docker_status != 0)); then
      fail 'one or more recorded Docker services could not be safely torn down; ownership records were retained'
    fi
    docker_result='Only containers recorded by exact ID were restored or removed. Docker networks and named volumes were retained; anonymous volumes on QA-created containers were removed.'
  elif [[ -f "$STATE_DIR/docker.started" ]]; then
    printf 'Legacy Docker state has no exact container ownership records; leaving all Docker services unchanged.\n' >&2
    docker_result='No Docker container, network, or volume was changed.'
  else
    docker_result='Attached Postgres/Qdrant/Redis were left running; no Docker container, network, or volume was changed.'
  fi
  rm -f "$CREATED_CONTAINERS_FILE" "$STARTED_CONTAINERS_FILE" \
    "$COMPOSE_PROJECT_FILE" "$STATE_DIR/docker.started" "$STATE_DIR/active"
  printf 'QA stack is down. %s Non-secret .qa/logs were retained.\n' "$docker_result"
}

main() {
  local command_name="${1:---help}"
  case "$command_name" in
    --help|-h|help)
      usage
      ;;
    up)
      shift
      while (($#)); do
        case "$1" in
          --read-only)
            MODE=read-only
            ;;
          --fixtures)
            SEED_FIXTURES=true
            ;;
          --remote-api)
            shift
            [[ $# -gt 0 ]] || fail '--remote-api requires a base URL, e.g. https://api.predex.exchange/pump'
            REMOTE_API="${1%/}"
            ;;
          --remote-api=*)
            REMOTE_API="${1#--remote-api=}"
            REMOTE_API="${REMOTE_API%/}"
            ;;
          --broadcast)
            MODE=broadcast
            ;;
          --external-wallet)
            EXTERNAL_WALLET=true
            ;;
          --help|-h)
            usage
            return 0
            ;;
          *)
            fail "unknown up option: $1"
            ;;
        esac
        shift
      done
      up
      ;;
    down)
      (($# == 1)) || fail 'down accepts no options'
      down
      ;;
    *)
      fail "unknown command: $command_name"
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
