#!/usr/bin/env bash
set -euo pipefail

# Runs the pc63 browse wrappers against a recording ssh/git, so each remote
# payload is decoded and inspected but never executed. Set
# BASH_UNDER_TEST=/bin/bash on macOS to reproduce the Bash 3.2 capture bug;
# CloudLab's system bash is newer and cannot reproduce it.

TEST_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
CLOUDLAB_DIR="$(CDPATH= cd -- "$TEST_DIR/../cloudlab" && pwd -P)"
BASH_UNDER_TEST="${BASH_UNDER_TEST:-bash}"
PRIVY_HOST='span14@pc63.cloudlab.umass.edu'
PRIVY_ROOT='/users/span14/predex-builds/predex-pump-privy'
GSTACK_COMMIT='e76f65a8da31ec14776a965c608222c1aecad656'
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/predex-browse-wrapper-test.XXXXXX")"
FAKE_BIN="$TEST_ROOT/bin"
output=''
status=0

cleanup() {
  local status="$?"
  trap - EXIT INT TERM
  case "$TEST_ROOT" in
    "${TMPDIR:-/tmp}"/predex-browse-wrapper-test.*) rm -rf -- "$TEST_ROOT" ;;
    *) status=1 ;;
  esac
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/ssh" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$FAKE_LOG_DIR/ssh-args"
printf '%s' "${@: -1}" > "$FAKE_LOG_DIR/remote-command"
cat > "$FAKE_LOG_DIR/ssh-stdin"
FAKE
cat > "$FAKE_BIN/git" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$FAKE_LOG_DIR/git-args"
case " $* " in
  *' rev-parse --verify '*) printf '%s\n' e76f65a8da31ec14776a965c608222c1aecad656 ;;
  *' archive '*)
    for arg in "$@"; do
      if [[ "$arg" == --output=* ]]; then
        printf 'fake archive\n' > "${arg#--output=}"
      fi
    done
    ;;
  *) exit 1 ;;
esac
FAKE
if ! command -v shasum > /dev/null 2>&1; then
  cat > "$FAKE_BIN/shasum" <<'FAKE'
#!/usr/bin/env bash
shift 2
exec sha256sum "$@"
FAKE
fi
chmod +x "$FAKE_BIN"/*
export FAKE_LOG_DIR="$TEST_ROOT"
unset NEXT_PUBLIC_PRIVY_APP_ID NEXT_PUBLIC_PRIVY_CLIENT_ID PREDEX_PREVIEW_API_URL

run_wrapper() {
  local stdin_file="$1" script="$2"
  shift 2
  rm -f "$TEST_ROOT/ssh-args" "$TEST_ROOT/remote-command" "$TEST_ROOT/ssh-stdin"
  status=0
  output="$(PATH="$FAKE_BIN:$PATH" CLOUDLAB_HOST="$PRIVY_HOST" \
    "$BASH_UNDER_TEST" "$CLOUDLAB_DIR/$script" "$@" 2>&1 < "$stdin_file")" || status=$?
}

# Decodes the base64 payload from the recorded remote command without running it.
payload() {
  local command encoded
  command="$(< "$TEST_ROOT/remote-command")"
  encoded="${command#*printf %s }"
  encoded="${encoded%% | base64 -d*}"
  printf '%s' "$encoded" | base64 -d
}

# Parses only the wrapper's single-quoted argument words, never the payload.
remote_argv() {
  local command words
  command="$(< "$TEST_ROOT/remote-command")"
  words="${command#*\" $1}"
  eval "set -- $words"
  printf '%s\n' "$@"
}

expect_payload() {
  local script_payload="$1" label="$2"
  shift 2
  local needle
  for needle in "$@"; do
    [[ "$script_payload" == *"$needle"* ]] || fail "$label payload lost literal: $needle"
  done
}

printf '' > "$TEST_ROOT/empty"

run_wrapper "$TEST_ROOT/empty" privy-preview.sh status
[[ "$status" -eq 0 ]] || fail "privy-preview status did not reach ssh: $output"
[[ "$(head -n 1 "$TEST_ROOT/ssh-args")" == -n ]] || fail 'status must detach ssh stdin'
status_payload="$(payload)"
expect_payload "$status_payload" privy-preview \
  'command_name="$2"' \
  'case "$command_name" in' \
  "printf 'privy-preview: %s\\n' \"\$*\" >&2" \
  '[[ "$source_id" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ ]]' \
  "-w '%{http_code}'" \
  '  status)' \
  'api_http_status=%s' \
  'api_unit=%s load=%s active=%s' \
  'exec "$browse_bin" "$@"'
[[ "$status_payload" != *api.predex.exchange* ]] || fail 'privy-preview still hardcodes a default API'
[[ "$(remote_argv privy-preview)" == "$PRIVY_ROOT"$'\n'status ]] ||
  fail 'status remote argv changed'

tricky="document.title + \"')(\" + '\$HOME' \\ done"
printf '[["goto","http://127.0.0.1:3002/"]]\n' > "$TEST_ROOT/chain.json"
run_wrapper "$TEST_ROOT/chain.json" privy-preview.sh browse js "$tricky"
[[ "$status" -eq 0 ]] || fail "privy-preview browse did not reach ssh: $output"
! grep -Fxq -- -n "$TEST_ROOT/ssh-args" || fail 'browse must keep ssh stdin attached'
cmp -s "$TEST_ROOT/chain.json" "$TEST_ROOT/ssh-stdin" || fail 'browse stdin was not passed through'
[[ "$(remote_argv privy-preview)" == "$PRIVY_ROOT"$'\n'browse$'\n'js$'\n'"$tricky" ]] ||
  fail 'browse argv was not preserved literally'

run_wrapper "$TEST_ROOT/empty" privy-preview.sh up
[[ "$status" -ne 0 && ! -e "$TEST_ROOT/remote-command" ]] ||
  fail 'up without a public App ID must refuse before ssh'
export NEXT_PUBLIC_PRIVY_APP_ID='testAppId_123-abc'
run_wrapper "$TEST_ROOT/empty" privy-preview.sh up
[[ "$status" -ne 0 && ! -e "$TEST_ROOT/remote-command" && "$output" == *PREDEX_PREVIEW_API_URL* ]] ||
  fail 'up without PREDEX_PREVIEW_API_URL must refuse before ssh'
for bad_url in 'http://api.example.test/pump' 'https://user:pw@api.example.test/pump' \
  'https://api.example.test/pump?x=1' 'https://api.example.test/pump#frag' 'https://api.example.test/pu mp'; do
  export PREDEX_PREVIEW_API_URL="$bad_url"
  run_wrapper "$TEST_ROOT/empty" privy-preview.sh up
  [[ "$status" -ne 0 && ! -e "$TEST_ROOT/remote-command" ]] ||
    fail "up accepted unsafe API URL before ssh: $bad_url"
done
export PREDEX_PREVIEW_API_URL='https://api.example.test/pump'
run_wrapper "$TEST_ROOT/empty" privy-preview.sh up
unset NEXT_PUBLIC_PRIVY_APP_ID PREDEX_PREVIEW_API_URL
[[ "$status" -eq 0 ]] || fail "privy-preview up did not reach ssh: $output"
[[ "$(remote_argv privy-preview)" == "$PRIVY_ROOT"$'\n'up$'\n'testAppId_123-abc$'\n'$'\n'https://api.example.test/pump ]] ||
  fail 'up remote argv changed'
expect_payload "$(payload)" privy-preview \
  'remote_api="$(PREVIEW_API_URL="$api_url" bun --eval "$api_check")"' \
  'await import(`${process.cwd()}/shared/src/addresses.ts`)' \
  'AbortSignal.timeout(10_000)' \
  '["usdc", "ctf", "oracle", "lmsr", "registry", "miniClob"]' \
  'mismatched: ${mismatches.join(", ")}' \
  'bash "$qa_stack" up --external-wallet --remote-api "$remote_api"'

for api_command in api-up api-down; do
  run_wrapper "$TEST_ROOT/empty" privy-preview.sh "$api_command" unexpected
  [[ "$status" -ne 0 && ! -e "$TEST_ROOT/remote-command" ]] ||
    fail "$api_command must refuse extra arguments before ssh"
done

nl=$'\n'
run_wrapper "$TEST_ROOT/empty" privy-preview.sh api-up
[[ "$status" -eq 0 ]] || fail "api-up must reach ssh without an App ID or API URL: $output"
[[ "$(head -n 1 "$TEST_ROOT/ssh-args")" == -n ]] || fail 'api-up must detach ssh stdin'
[[ "$(remote_argv privy-preview)" == "$PRIVY_ROOT"$'\n'api-up ]] || fail 'api-up remote argv changed'
api_payload="$(payload)"
api_up_block="${api_payload#*${nl}  api-up)${nl}}"
api_up_block="${api_up_block%%${nl}  api-down)${nl}*}"
api_down_block="${api_payload#*${nl}  api-down)${nl}}"
api_down_block="${api_down_block%%${nl}  status)${nl}*}"
[[ "$api_up_block" != "$api_payload" && "$api_down_block" != "$api_payload" ]] ||
  fail 'api-up/api-down branches are missing from the payload'
expect_payload "$api_payload" privy-preview-api \
  'api_unit=predex-privy-api' \
  'preview_api_url=http://127.0.0.1:3001' \
  'api_marker_dir="$remote_root/runtime"' \
  'api_marker="$api_marker_dir/active"' \
  'for gate in backend_typecheck backend_build backend_test; do' \
  'process.exit(scripts.api === "tsx src/api.ts" ? 0 : 1);'
expect_payload "$api_up_block" privy-preview-api-up \
  'require_verified_backend' \
  'for unit in predex-indexer.service predex-operator.service; do' \
  "listeners=\"\$(ss -H -ltn 'sport = :3001')\"" \
  'ln "$marker_tmp" "$api_marker"' \
  'systemd-run --user --unit="$api_unit" --collect' \
  '--property=Type=exec' \
  '--property=Restart=on-failure' \
  '--property=KillMode=control-group' \
  '--property=UMask=0077' \
  '--property=WorkingDirectory="$source_dir/backend"' \
  '--setenv=API_HOST=127.0.0.1' \
  '--setenv=API_PORT=3001' \
  "--setenv=DATABASE_URL='postgresql://predex:predex@127.0.0.1:5432/predex_pump?schema=public'" \
  '--setenv=REDIS_KEY_PREFIX=predex-privy-preview' \
  '--setenv=PREDEX_TRUTH_SELLER_MODE=disabled' \
  '--setenv=OPENAI_API_KEY= \' \
  '--setenv=OPERATOR_PRIVATE_KEY= \' \
  '--setenv=QA_WALLET_PRIVATE_KEY= \' \
  '"$node_root/bin/pnpm" api; then' \
  '"$preview_api_url/health"' \
  'PREVIEW_API_URL="$preview_api_url" bun --eval "$api_check"' \
  'systemctl --user stop "$api_unit_file" >/dev/null 2>&1 ||' \
  'keeping $api_marker to protect the source' \
  'API unit creation is ambiguous; keeping $api_marker for inspection'
[[ "$(printf '%s\n' "$api_payload" | grep -c -F 'systemd-run --user')" == 1 ]] ||
  fail 'payload must launch exactly one transient unit'
[[ "$(printf '%s\n' "$api_payload" | grep -c -F '"$node_root/bin/pnpm" api')" == 1 ]] ||
  fail 'payload must launch only the pnpm api entry'
[[ "$(printf '%s\n' "$api_payload" | grep -c -F 'systemctl --user stop')" == \
  "$(printf '%s\n' "$api_payload" | grep -c -F 'systemctl --user stop "$api_unit_file"')" ]] ||
  fail 'payload may stop only predex-privy-api.service'
for forbidden in docker compose prisma migrate 'pnpm start' 'pnpm indexer' 'pnpm operator' \
  'systemctl --user start' 'systemctl --user restart' daemon-reload daemon-reexec \
  import-environment show-environment predex.target 'Requires=' 'PartOf='; do
  [[ "$api_payload" != *"$forbidden"* ]] || fail "privy-preview payload must not contain: $forbidden"
done

run_wrapper "$TEST_ROOT/empty" privy-preview.sh api-down
[[ "$status" -eq 0 ]] || fail "api-down must reach ssh without an App ID or API URL: $output"
[[ "$(head -n 1 "$TEST_ROOT/ssh-args")" == -n ]] || fail 'api-down must detach ssh stdin'
[[ "$(remote_argv privy-preview)" == "$PRIVY_ROOT"$'\n'api-down ]] || fail 'api-down remote argv changed'
[[ "$(payload)" == "$api_payload" ]] || fail 'api-down payload differs from api-up payload'
expect_payload "$api_down_block" privy-preview-api-down \
  'marker_is_ours ||' \
  'grep -Fxq "source_id=$source_id" "$api_marker" ||' \
  '[[ "$(unit_property WorkingDirectory)" == "$source_dir/backend" ]] ||' \
  '*"argv[]=$node_root/bin/pnpm api ;"*' \
  '"$source_dir/.qa/active"' \
  'systemctl --user stop "$api_unit_file"' \
  'rm -f "$api_marker"'
[[ "$api_down_block" != *'"$qa_stack"'* && "$api_down_block" != *systemd-run* ]] ||
  fail 'api-down must neither stop the frontend nor start units'

run_wrapper "$TEST_ROOT/empty" bootstrap-browse.sh
[[ "$status" -eq 0 ]] || fail "bootstrap-browse did not reach ssh: $output"
[[ "$(< "$TEST_ROOT/ssh-stdin")" == 'fake archive' ]] || fail 'bootstrap did not stream the archive'
grep -Fxq -- ':(exclude)lib/diagram-render/dist' "$TEST_ROOT/git-args" ||
  fail 'bootstrap lost the diagram-render dist exclusion'
bootstrap_payload="$(payload)"
expect_payload "$bootstrap_payload" bootstrap-browse \
  "Bun's standard alias" \
  'gstack_root="$toolchain_root/gstack-${commit:0:12}"' \
  'ln -s bun "$bun_root/bin/bunx"' \
  'exec > >(tee "$evidence_dir/bootstrap-$(date -u +%Y%m%dT%H%M%SZ).log") 2>&1' \
  "fail 'gstack archive checksum mismatch after transfer'"
[[ "$(remote_argv bootstrap-browse | head -n 1)" == "$GSTACK_COMMIT" ]] ||
  fail 'bootstrap remote argv changed'

printf 'CloudLab browse wrapper tests passed (bash: %s).\n' \
  "$("$BASH_UNDER_TEST" -c 'printf %s "$BASH_VERSION"')"
