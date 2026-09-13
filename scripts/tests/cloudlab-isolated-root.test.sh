#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
CLOUDLAB_DIR="$(CDPATH= cd -- "$TEST_DIR/../cloudlab" && pwd -P)"
CANONICAL_ROOT='/users/span14/predex-builds/predex-pump'
CANONICAL_HOST='span14@c220g1-031117.wisc.cloudlab.us'
PRIVY_ROOT='/users/span14/predex-builds/predex-pump-privy'
PRIVY_HOST='span14@pc63.cloudlab.umass.edu'
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/predex-cloudlab-root-test.XXXXXX")"
FAKE_BIN="$TEST_ROOT/bin"
output=''
status=0

cleanup() {
  local status="$?"
  trap - EXIT INT TERM
  case "$TEST_ROOT" in
    "${TMPDIR:-/tmp}"/predex-cloudlab-root-test.*) rm -rf -- "$TEST_ROOT" ;;
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

# CloudLab transports are replaced with recorders. The only remote program ever
# executed is sync.sh's read-only marker preflight, and only when requested.
mkdir -p "$FAKE_BIN" "$TEST_ROOT/repo"
cat > "$FAKE_BIN/ssh" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG_DIR/ssh.log"
if [[ " $* " == *" bash -s -- "* && "${FAKE_SSH_RUN_PREFLIGHT:-0}" == 1 ]]; then
  exec bash -s -- "${@: -1}"
fi
cat > /dev/null
FAKE
cat > "$FAKE_BIN/rsync" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$FAKE_LOG_DIR/rsync.log"
FAKE
cat > "$FAKE_BIN/git" <<'FAKE'
#!/usr/bin/env bash
if [[ "$1" == -C ]]; then
  shift 2
fi
case "$*" in
  'rev-parse --show-toplevel') printf '%s\n' "$FAKE_REPO" ;;
  'rev-parse --short=12 HEAD') printf '0123456789ab\n' ;;
  ls-files*) ;;
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
export FAKE_LOG_DIR="$TEST_ROOT" FAKE_REPO="$TEST_ROOT/repo"

run_script() {
  local script="$1" host="$2" root="$3" preflight="${4:-0}"
  : > "$TEST_ROOT/ssh.log"
  : > "$TEST_ROOT/rsync.log"
  status=0
  output="$(PATH="$FAKE_BIN:$PATH" CLOUDLAB_HOST="$host" \
    CLOUDLAB_REMOTE_ROOT="$root" FAKE_SSH_RUN_PREFLIGHT="$preflight" \
    bash "$CLOUDLAB_DIR/$script" 2>&1 < /dev/null)" || status=$?
}

expect_refused() {
  local script="$1" host="$2" root="$3" message="$4"
  run_script "$script" "$host" "$root"
  [[ "$status" -ne 0 ]] || fail "$script accepted host='$host' root='$root'"
  [[ "$output" == *"$message"* ]] ||
    fail "$script refused host='$host' root='$root' without '$message': $output"
  [[ ! -s "$TEST_ROOT/ssh.log" && ! -s "$TEST_ROOT/rsync.log" ]] ||
    fail "$script contacted CloudLab for host='$host' root='$root'"
}

host_message='Refusing isolated remote root on unexpected host'
root_message='Refusing unexpected remote root'
for script in sync.sh verify.sh; do
  bash -n "$CLOUDLAB_DIR/$script"
  expect_refused "$script" '' "$PRIVY_ROOT" "$host_message"
  expect_refused "$script" "$CANONICAL_HOST" "$PRIVY_ROOT" "$host_message"
  expect_refused "$script" 'pc63.cloudlab.umass.edu' "$PRIVY_ROOT" "$host_message"
  expect_refused "$script" "$PRIVY_HOST.example" "$PRIVY_ROOT" "$host_message"
  expect_refused "$script" "$PRIVY_HOST" "$PRIVY_ROOT/" "$root_message"
  expect_refused "$script" "$PRIVY_HOST" "$PRIVY_ROOT/../predex-pump" "$root_message"
  expect_refused "$script" "$PRIVY_HOST" "${PRIVY_ROOT}2" "$root_message"
  expect_refused "$script" "$PRIVY_HOST" '/tmp/predex-pump-privy' "$root_message"
done

for marker in "$PRIVY_ROOT/runtime/active" "$PRIVY_ROOT/source/.qa/active"; do
  [[ ! -e "$marker" ]] || fail "isolated root must not host an active stack: $marker"
done
run_script sync.sh "$PRIVY_HOST" "$PRIVY_ROOT" 1
[[ "$status" -eq 0 ]] || fail "sync.sh refused the isolated root: $output"
ssh_log="$(< "$TEST_ROOT/ssh.log")"
rsync_log="$(< "$TEST_ROOT/rsync.log")"
[[ "$ssh_log" == *"$PRIVY_HOST bash -s -- $PRIVY_ROOT/source"* ]] ||
  fail 'sync.sh preflight did not target the isolated source'
[[ "$ssh_log" == *"$PRIVY_HOST mkdir -p $PRIVY_ROOT/source"* ]] ||
  fail 'sync.sh did not create the isolated source'
[[ "$ssh_log" == *"$PRIVY_ROOT/source/.predex-source-id"* ]] ||
  fail 'sync.sh did not record the isolated source id'
[[ "$ssh_log$rsync_log" != *"$CANONICAL_ROOT/"* ]] ||
  fail 'sync.sh referenced the canonical root for the isolated target'
grep -Fxq -- "$PRIVY_HOST:$PRIVY_ROOT/source/" "$TEST_ROOT/rsync.log" ||
  fail 'sync.sh rsync destination is not the isolated source'
for exclude in .git '.env*' '**/.env*' .credentials .ssh/ .gnupg/ runtime/ '**/node_modules/'; do
  grep -Fxq -- "--exclude=$exclude" "$TEST_ROOT/rsync.log" ||
    fail "sync.sh lost exclusion $exclude"
done

if [[ -e "$CANONICAL_ROOT/runtime/active" && ! -e "$CANONICAL_ROOT/source/.qa/active" ]]; then
  run_script sync.sh "$CANONICAL_HOST" "$CANONICAL_ROOT" 1
  [[ "$status" -ne 0 && "$output" == *'active persistent runtime'* ]] ||
    fail "sync.sh no longer protects the active canonical runtime: $output"
  [[ "$(< "$TEST_ROOT/ssh.log")" != *'mkdir -p'* && ! -s "$TEST_ROOT/rsync.log" ]] ||
    fail 'sync.sh continued past the canonical runtime refusal'
  printf 'canonical runtime refusal checked against the live marker\n'
else
  printf 'canonical runtime marker absent; live refusal check skipped\n'
fi

run_script verify.sh "$PRIVY_HOST" "$PRIVY_ROOT"
[[ "$status" -eq 0 ]] || fail "verify.sh refused the isolated root: $output"
[[ "$(< "$TEST_ROOT/ssh.log")" == *"$PRIVY_HOST bash -s -- $PRIVY_ROOT 22.19.0"* ]] ||
  fail 'verify.sh did not target the isolated root'
run_script verify.sh '' "$CANONICAL_ROOT"
[[ "$status" -eq 0 ]] || fail "verify.sh refused the canonical defaults: $output"
[[ "$(< "$TEST_ROOT/ssh.log")" == *"$CANONICAL_HOST bash -s -- $CANONICAL_ROOT 22.19.0"* ]] ||
  fail 'verify.sh canonical defaults changed'

HELPER="$CLOUDLAB_DIR/resolve-frontend-lock.sh"
bash -n "$HELPER"
expect_refused resolve-frontend-lock.sh '' "$PRIVY_ROOT" 'Refusing unexpected CloudLab host'
expect_refused resolve-frontend-lock.sh "$CANONICAL_HOST" "$PRIVY_ROOT" 'Refusing unexpected CloudLab host'
expect_refused resolve-frontend-lock.sh "$PRIVY_HOST.example" "$PRIVY_ROOT" 'Refusing unexpected CloudLab host'
expect_refused resolve-frontend-lock.sh "$PRIVY_HOST" '' "$root_message"
expect_refused resolve-frontend-lock.sh "$PRIVY_HOST" "$CANONICAL_ROOT" "$root_message"
expect_refused resolve-frontend-lock.sh "$PRIVY_HOST" "$PRIVY_ROOT/" "$root_message"
expect_refused resolve-frontend-lock.sh "$PRIVY_HOST" "$PRIVY_ROOT" 'Refusing unexpected worktree'
! grep -En -- '\.env|/source|/runtime|rm -' "$HELPER" > /dev/null ||
  fail 'lock helper references env files, the source mirror, the runtime, or deletion'
grep -Fq -- 'pnpm install --lockfile-only --ignore-scripts' "$HELPER" ||
  fail 'lock helper no longer resolves lockfile-only without scripts'

printf 'CloudLab isolated root guard tests passed.\n'
