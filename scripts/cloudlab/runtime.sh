#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

CLOUDLAB_HOST="${CLOUDLAB_HOST:-span14@c220g1-031117.wisc.cloudlab.us}"
CLOUDLAB_IDENTITY_FILE="${CLOUDLAB_IDENTITY_FILE:-/Users/ggattacker/.ssh/cloudlab}"
CLOUDLAB_REMOTE_ROOT="${CLOUDLAB_REMOTE_ROOT:-/users/span14/predex-builds/predex-pump}"
SSH_BIN="${PREDEX_RUNTIME_SSH_BIN:-ssh}"

case "$CLOUDLAB_REMOTE_ROOT" in
  /users/span14/predex-builds/predex-pump) ;;
  *)
    printf 'Refusing unexpected remote root: %s\n' "$CLOUDLAB_REMOTE_ROOT" >&2
    exit 1
    ;;
esac

REPO_ROOT="$(git rev-parse --show-toplevel)"
REMOTE_HELPER="$CLOUDLAB_REMOTE_ROOT/source/scripts/cloudlab/runtime-remote.sh"
LOCAL_OPERATOR_CREDENTIAL="${PREDEX_OPERATOR_CREDENTIAL_FILE:-$REPO_ROOT/../.credentials/.arc}"
SSH_ARGS=(
  -i "$CLOUDLAB_IDENTITY_FILE"
  -o BatchMode=yes
  -o ConnectTimeout=12
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=4
)

usage() {
  cat <<'HELP'
Usage: scripts/cloudlab/runtime.sh COMMAND [ARGS]

Commands:
  install
      Enable user lingering, install only the checked-in Predex user-systemd
      units and helper, and reload the user manager. Starts nothing.
  provision-operator
      Parse privKey= from local ../.credentials/.arc and securely replace the
      remote mode-0600 operator credential through stdin.
  up | status | down
  restart api|indexer|operator|frontend
  logs [all|data|api|indexer|operator|frontend] [LINES]

The persistent runtime is fixed to Compose project continuity-deadline, one
API, one indexer, one operator, and one production frontend. It has no proxy,
second API worker, HTTPS termination, or QA wallet signer.
HELP
}

fail() {
  printf 'runtime: %s\n' "$*" >&2
  exit 1
}

remote_runtime() {
  "$SSH_BIN" "${SSH_ARGS[@]}" "$CLOUDLAB_HOST" "$REMOTE_HELPER" "$@"
}

credential_mode() {
  if stat -f '%Lp' "$LOCAL_OPERATOR_CREDENTIAL" >/dev/null 2>&1; then
    stat -f '%Lp' "$LOCAL_OPERATOR_CREDENTIAL"
  else
    stat -c '%a' "$LOCAL_OPERATOR_CREDENTIAL"
  fi
}

read_local_operator_key() {
  local line value=''
  local matches=0
  [[ -f "$LOCAL_OPERATOR_CREDENTIAL" && ! -L "$LOCAL_OPERATOR_CREDENTIAL" ]] ||
    fail 'local ../.credentials/.arc is missing or is not a regular file'
  [[ -O "$LOCAL_OPERATOR_CREDENTIAL" ]] ||
    fail 'local operator credential is not owned by the current user'
  case "$(credential_mode)" in
    400|600) ;;
    *) fail 'local operator credential mode must be 0400 or 0600' ;;
  esac
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    case "$line" in
      privKey=*)
        matches=$((matches + 1))
        value="${line#privKey=}"
        ;;
    esac
  done < "$LOCAL_OPERATOR_CREDENTIAL"
  [[ "$matches" -eq 1 ]] ||
    fail 'local operator credential must contain exactly one privKey= record'
  [[ "$value" =~ ^(0x)?[0-9a-fA-F]{64}$ ]] ||
    fail 'local privKey= record is invalid'
  [[ "$value" == 0x* ]] || value="0x$value"
  printf '%s' "$value"
}

provision_operator() {
  local operator_key
  operator_key="$(read_local_operator_key)"
  printf '%s\n' "$operator_key" | remote_runtime provision-operator
  unset operator_key
}

main() {
  local command_name="${1:---help}"
  shift || true
  case "$command_name" in
    --help|-h|help)
      [[ $# -eq 0 ]] || fail 'help accepts no arguments'
      usage
      ;;
    install|up|status|down)
      [[ $# -eq 0 ]] || fail "$command_name accepts no arguments"
      remote_runtime "$command_name"
      ;;
    provision-operator)
      [[ $# -eq 0 ]] || fail 'provision-operator accepts no arguments'
      provision_operator
      ;;
    restart)
      [[ $# -eq 1 ]] || fail 'restart requires api, indexer, operator, or frontend'
      case "$1" in
        api|indexer|operator|frontend) ;;
        *) fail 'restart requires api, indexer, operator, or frontend' ;;
      esac
      remote_runtime restart "$1"
      ;;
    logs)
      [[ $# -le 2 ]] || fail 'logs accepts at most scope and line count'
      if [[ $# -ge 1 ]]; then
        case "$1" in
          all|data|api|indexer|operator|frontend) ;;
          *) fail 'logs scope must be all, data, api, indexer, operator, or frontend' ;;
        esac
      fi
      if [[ $# -eq 2 && ! "$2" =~ ^[1-9][0-9]{0,3}$ ]]; then
        fail 'log line count must be 1-9999'
      fi
      remote_runtime logs "$@"
      ;;
    *) fail "unknown command: $command_name" ;;
  esac
}

main "$@"
