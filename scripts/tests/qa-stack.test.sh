#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
REPO_DIR="$(CDPATH= cd -- "$TEST_DIR/../.." && pwd -P)"
SCRIPT="$REPO_DIR/scripts/qa-stack.sh"

unset OPENAI_API_KEY

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  case "$haystack" in
    *"$needle"*) ;;
    *) fail "expected output to contain: $needle" ;;
  esac
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  case "$haystack" in
    *"$needle"*) fail "output unexpectedly contained: $needle" ;;
    *) ;;
  esac
}

make_state_dir() {
  local state_dir
  state_dir="$(mktemp -d "${TMPDIR:-/tmp}/predex-qa-stack-test.XXXXXX")"
  printf '%s\n' "$state_dir"
}

bash -n "$SCRIPT"

default_project="$(env -u QA_COMPOSE_PROJECT bash -c '
  source "$1"
  printf "%s" "$COMPOSE_PROJECT"
' _ "$SCRIPT")"
[[ "$default_project" == backend ]] ||
  fail "expected the default compose project to be backend, got $default_project"

override_project="$(QA_COMPOSE_PROJECT=qa-stack-test bash -c '
  source "$1"
  printf "%s" "$COMPOSE_PROJECT"
' _ "$SCRIPT")"
[[ "$override_project" == qa-stack-test ]] ||
  fail "expected QA_COMPOSE_PROJECT override to be honoured, got $override_project"

compose_call="$(QA_COMPOSE_PROJECT=qa-stack-test bash -c '
  source "$1"
  docker_command() {
    local arg
    for arg in "$@"; do printf "<%s>" "$arg"; done
  }
  compose ps
' _ "$SCRIPT")"
assert_contains "$compose_call" '<compose><--project-name><qa-stack-test>'

help_output="$($SCRIPT --help)"
assert_contains "$help_output" 'QA_COMPOSE_PROJECT=backend'
assert_contains "$help_output" 'QA_COMPOSE_PROJECT=my-qa-stack'
assert_contains "$help_output" 'Attached Postgres/Qdrant containers are never stopped or removed'

attachment_output="$(bash -c '
  source "$1"
  ATTACHED_SERVICES=(postgres qdrant)
  report_compose_attachment
' _ "$SCRIPT")"
assert_contains "$attachment_output" 'Compose project: backend (canonical)'
assert_contains "$attachment_output" 'Database URL:   postgresql://predex:predex@127.0.0.1:5432/predex_pump?schema=public'
assert_contains "$attachment_output" 'Attached to existing services: postgres, qdrant'

# An occupied database port is valid only when the selected compose service owns
# that exact published port.
bash -c '
  source "$1"
  port_is_listening() { return 0; }
  compose_service_owns_host_port() { return 0; }
  assert_database_port postgres 5432 5432
' _ "$SCRIPT" || fail 'expected an occupied port owned by the selected service to pass'

if unrelated_output="$(bash -c '
  source "$1"
  port_is_listening() { return 0; }
  compose_service_owns_host_port() { return 1; }
  compose_running_service_container_id() { return 1; }
  assert_database_port postgres 5432 5432
' _ "$SCRIPT" 2>&1)"; then
  fail 'an unrelated listener on the Postgres port unexpectedly passed'
fi
assert_contains "$unrelated_output" "TCP port 5432 is occupied by an unrelated process"
assert_contains "$unrelated_output" "compose project 'backend' service 'postgres'"

if app_port_output="$(bash -c '
  source "$1"
  port_is_listening() { [[ "$1" == 3001 ]]; }
  assert_application_ports_free
' _ "$SCRIPT" 2>&1)"; then
  fail 'an occupied backend application port unexpectedly passed'
fi
assert_contains "$app_port_output" 'TCP port 3001 is already occupied'

# Attached canonical services have no ownership records. `down` must therefore
# issue no Docker command at all; this is the core shared-state safety assertion.
attached_state="$(make_state_dir)"
attached_calls="$attached_state/docker.calls"
printf '%s\n' backend > "$attached_state/compose-project"
: > "$attached_state/active"
bash -c '
  source "$1"
  STATE_DIR="$2"
  LOG_DIR="$STATE_DIR/logs"
  COMPOSE_PROJECT_FILE="$STATE_DIR/compose-project"
  CREATED_CONTAINERS_FILE="$STATE_DIR/docker-created-containers"
  STARTED_CONTAINERS_FILE="$STATE_DIR/docker-started-containers"
  docker_command() {
    printf "%s\n" "$*" >> "$3"
    return 99
  }
  down >/dev/null
' _ "$SCRIPT" "$attached_state" "$attached_calls"
[[ ! -s "$attached_calls" ]] ||
  fail 'attached teardown attempted to mutate Docker services'

# If a run starts a pre-existing stopped container and creates another one,
# teardown restores/removes only those exact IDs. It still never runs a
# project-wide compose down or removes a network/volume.
owned_state="$(make_state_dir)"
owned_calls="$owned_state/docker.calls"
started_id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
created_id='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
printf '%s\n' qa-stack-test > "$owned_state/compose-project"
printf 'qdrant %s\n' "$started_id" > "$owned_state/docker-started-containers"
printf 'postgres %s\n' "$created_id" > "$owned_state/docker-created-containers"
bash -c '
  source "$1"
  STATE_DIR="$2"
  LOG_DIR="$STATE_DIR/logs"
  COMPOSE_PROJECT_FILE="$STATE_DIR/compose-project"
  CREATED_CONTAINERS_FILE="$STATE_DIR/docker-created-containers"
  STARTED_CONTAINERS_FILE="$STATE_DIR/docker-started-containers"
  calls_file="$3"
  started_id="$4"
  created_id="$5"
  docker_command() {
    if [[ "$1 $2 $3" == "container inspect --format" ]]; then
      case "${5:-}" in
        "$started_id") printf "%s\n" "qa-stack-test|qdrant" ;;
        "$created_id") printf "%s\n" "qa-stack-test|postgres" ;;
        *) return 1 ;;
      esac
      return
    fi
    local arg
    for arg in "$@"; do printf "<%s>" "$arg" >> "$calls_file"; done
    printf "\n" >> "$calls_file"
  }
  down >/dev/null
' _ "$SCRIPT" "$owned_state" "$owned_calls" "$started_id" "$created_id"
owned_output="$(<"$owned_calls")"
assert_contains "$owned_output" "<container><stop><$started_id>"
assert_contains "$owned_output" "<container><rm><--force><$created_id>"
assert_not_contains "$owned_output" '<compose><down>'
assert_not_contains "$owned_output" '<network>'
assert_not_contains "$owned_output" '<volume>'

# Even a stale/forged ownership record cannot remove a container whose live
# Compose labels do not match the recorded project and service.
unowned_state="$(make_state_dir)"
unowned_calls="$unowned_state/docker.calls"
unowned_id='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
printf '%s\n' qa-stack-test > "$unowned_state/compose-project"
printf 'postgres %s\n' "$unowned_id" > "$unowned_state/docker-created-containers"
if bash -c '
  source "$1"
  STATE_DIR="$2"
  LOG_DIR="$STATE_DIR/logs"
  COMPOSE_PROJECT_FILE="$STATE_DIR/compose-project"
  CREATED_CONTAINERS_FILE="$STATE_DIR/docker-created-containers"
  STARTED_CONTAINERS_FILE="$STATE_DIR/docker-started-containers"
  calls_file="$3"
  docker_command() {
    if [[ "$1 $2 $3" == "container inspect --format" ]]; then
      printf "%s\n" "backend|postgres"
      return
    fi
    printf "%s\n" mutation >> "$calls_file"
  }
  down >/dev/null
' _ "$SCRIPT" "$unowned_state" "$unowned_calls" 2>/dev/null; then
  fail 'teardown unexpectedly accepted a container owned by another project'
fi
[[ ! -s "$unowned_calls" ]] ||
  fail 'teardown mutated a container owned by another project'

rm -rf "$attached_state" "$owned_state" "$unowned_state"

printf '%s\n' 'PASS: qa-stack compose attachment, port ownership, and teardown safety'
