#!/usr/bin/env bash
# Predex browser-QA stack.
#
# QA entry points (the operator supplies the key; this script never prints or
# persists it):
#   QA_WALLET_PRIVATE_KEY=<set-in-shell> ./scripts/qa-stack.sh up --read-only
#   QA_WALLET_PRIVATE_KEY=<set-in-shell> ./scripts/qa-stack.sh up --broadcast
#   ./scripts/qa-stack.sh down
#
# The frontend is always http://127.0.0.1:3002 (never port 3000). Useful pages:
# /, /create, /market/1, /market/2, /portfolio, /account, and /activity.
# Market 1 is live on HYBRID (price tick 1000 raw / 0.001; size multiple 1000);
# market 2 is resolved. `down` removes QA containers/network but retains the
# named Postgres and Qdrant volumes.
set -Eeuo pipefail
IFS=$'\n\t'

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
STATE_DIR="$ROOT_DIR/.qa"
LOG_DIR="$STATE_DIR/logs"
COMPOSE_FILE="$ROOT_DIR/backend/docker-compose.yml"
COMPOSE_PROJECT="predex-pump-qa"
DATABASE_URL="postgresql://predex:predex@127.0.0.1:5432/predex_pump?schema=public"
FRONTEND_URL="http://127.0.0.1:3002"
BACKEND_URL="http://127.0.0.1:3001"
WALLET_URL="http://127.0.0.1:3003"
WALLET_SCRIPT_URL="$WALLET_URL/provider.js"
MODE="read-only"
DOCKER_STARTED=0

usage() {
  cat <<'HELP'
Usage:
  QA_WALLET_PRIVATE_KEY=<set-in-shell> ./scripts/qa-stack.sh up [--read-only]
  QA_WALLET_PRIVATE_KEY=<set-in-shell> ./scripts/qa-stack.sh up --broadcast
  ./scripts/qa-stack.sh down
  ./scripts/qa-stack.sh --help

Modes:
  --read-only  Default. Signs SIWE messages and EIP-712 orders, but rejects
               eth_sendTransaction before any network request. No chain writes.
  --broadcast  Enables eth_sendTransaction for approvals and fills. The local
               signer signs and broadcasts to Arc testnet. Use deliberately.

Runtime key:
  QA_WALLET_PRIVATE_KEY is required only by `up`. It must be a 0x-prefixed
  32-byte private key supplied by the operator at runtime. The value is never
  printed, logged, saved to a file, passed to Next/backend, or built into assets.

QA URLs:
  Frontend       http://127.0.0.1:3002
  Backend REST   http://127.0.0.1:3001
  Backend WS     ws://127.0.0.1:3001/ws
  Wallet health  http://127.0.0.1:3003/healthz

Pages and useful fixtures:
  /              market list
  /create        create flow
  /market/1      live HYBRID venue; tick=1000 raw (0.001), size multiple=1000 raw
  /market/2      resolved market
  /portfolio     connected-wallet positions
  /account       SIWE account/profile
  /activity      indexed activity

Production gate:
  The provider source is external to the Next module graph and next.config.ts
  exposes its script URL only during PHASE_DEVELOPMENT_SERVER with the explicit
  QA_WALLET_ENABLED flag. Production builds bake in an empty URL and scan their
  artifacts for the provider marker/key. The signer also refuses NODE_ENV=production.

Teardown:
  `down` stops the signer, backend, and frontend; Docker Compose removes the QA
  Postgres/Qdrant containers and network while retaining both named volumes and
  the non-secret process logs under .qa/logs/.
HELP
}

fail() {
  printf 'qa-stack: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

port_is_listening() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1
    return
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1
    return
  fi
  fail 'port checks require lsof or nc'
}

assert_ports_free() {
  local port
  for port in 3001 3002 3003 5432 6333; do
    if port_is_listening "$port"; then
      fail "TCP port $port is already occupied; refusing to attach to an existing service"
    fi
  done
}

compose() {
  env -u QA_WALLET_PRIVATE_KEY docker compose \
    --project-name "$COMPOSE_PROJECT" --file "$COMPOSE_FILE" "$@"
}

install_runtime_dependencies() {
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
  for child in "${children[@]}"; do
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
  trap - ERR INT TERM
  printf '\nQA stack startup failed; cleaning up partial state.\n' >&2
  print_log_tail wallet
  print_log_tail backend
  print_log_tail frontend
  stop_processes
  if [[ "$DOCKER_STARTED" -eq 1 || -f "$STATE_DIR/docker.started" ]]; then
    compose down >/dev/null 2>&1 || true
  fi
  rm -f "$STATE_DIR/docker.started" "$STATE_DIR/active"
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
    export QA_WALLET_ENABLED=1
    export QA_WALLET_SCRIPT_URL="$WALLET_SCRIPT_URL"
    export NEXT_PUBLIC_API_URL="$BACKEND_URL"
    export NEXT_PUBLIC_WS_URL="ws://127.0.0.1:3001/ws"
    export NEXT_PUBLIC_ARC_EXPLORER_URL=https://testnet.arcscan.app
    export NEXT_PUBLIC_AGENT_ADDRESSES="${NEXT_PUBLIC_AGENT_ADDRESSES:-}"
    exec ./node_modules/.bin/next dev --hostname 127.0.0.1 --port 3002
  ) >>"$LOG_DIR/frontend.log" 2>&1 &
  printf '%s\n' "$!" > "$STATE_DIR/frontend.pid"
}

up() {
  [[ ! -e "$STATE_DIR/active" && ! -e "$STATE_DIR/docker.started" ]] ||
    fail 'QA state already exists; run ./scripts/qa-stack.sh down first'
  [[ -n "${QA_WALLET_PRIVATE_KEY:-}" ]] ||
    fail 'QA_WALLET_PRIVATE_KEY must be supplied by the operator at runtime'
  [[ "$QA_WALLET_PRIVATE_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]] ||
    fail 'QA_WALLET_PRIVATE_KEY must be a 0x-prefixed 32-byte private key'

  require_command node
  require_command pnpm
  require_command docker
  require_command curl
  env -u QA_WALLET_PRIVATE_KEY docker info >/dev/null 2>&1 || fail 'Docker is not available'
  assert_ports_free
  install_runtime_dependencies

  mkdir -p "$LOG_DIR"
  : > "$LOG_DIR/wallet.log"
  : > "$LOG_DIR/backend.log"
  : > "$LOG_DIR/frontend.log"
  trap cleanup_failed_up ERR INT TERM

  printf 'Starting isolated Postgres and Qdrant containers...\n'
  compose up -d --wait postgres qdrant
  DOCKER_STARTED=1
  : > "$STATE_DIR/docker.started"

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

  launch_wallet
  # The already-running signer is the only child allowed to retain the key.
  unset QA_WALLET_PRIVATE_KEY
  wait_until 'QA wallet signer' "$STATE_DIR/wallet.pid" 30 wallet_is_healthy
  launch_backend
  wait_until 'Backend/indexer' "$STATE_DIR/backend.pid" 240 backend_is_healthy
  launch_frontend
  wait_until 'Frontend/provider injection' "$STATE_DIR/frontend.pid" 180 frontend_is_healthy

  : > "$STATE_DIR/active"
  trap - ERR INT TERM
  local wallet_account
  wallet_account="$(curl --fail --silent --show-error "$WALLET_URL/healthz" |
    node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => process.stdout.write(JSON.parse(raw).account));
    ')"
  printf '\nPredex QA stack is ready (mode: %s).\n' "$MODE"
  printf 'Frontend:      %s\n' "$FRONTEND_URL"
  printf 'Backend REST:  %s\n' "$BACKEND_URL"
  printf 'Backend WS:    ws://127.0.0.1:3001/ws\n'
  printf 'Wallet:        %s\n' "$wallet_account"
  printf 'HYBRID market: %s/market/1\n' "$FRONTEND_URL"
  printf 'Resolved:      %s/market/2\n' "$FRONTEND_URL"
  printf 'Logs:          %s\n' "$LOG_DIR"
  printf 'Teardown:      ./scripts/qa-stack.sh down\n'
}

down() {
  local docker_result
  mkdir -p "$STATE_DIR"
  stop_processes
  if [[ -f "$STATE_DIR/docker.started" ]]; then
    printf 'Stopping QA Postgres and Qdrant containers...\n'
    compose down
    docker_result='QA Docker containers/network were removed; named data volumes were retained.'
  else
    docker_result='No recorded QA Docker services were changed.'
  fi
  rm -f "$STATE_DIR/docker.started" "$STATE_DIR/active"
  printf 'QA stack is down. %s Non-secret .qa/logs were retained.\n' "$docker_result"
}

command_name="${1:---help}"
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
        --broadcast)
          MODE=broadcast
          ;;
        --help|-h)
          usage
          exit 0
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
