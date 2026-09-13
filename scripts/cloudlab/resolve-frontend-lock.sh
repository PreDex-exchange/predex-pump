#!/usr/bin/env bash
set -Eeuo pipefail

# Resolves frontend/pnpm-lock.yaml on CloudLab for the isolated Privy build root
# only. frontend/package.json, frontend/pnpm-lock.yaml, and shared/package.json
# are copied byte-for-byte into a fresh scratch directory; the source mirror,
# the runtime, and this checkout are never written. The lockfile diff is printed
# on stdout for local review, and evidence stays in the scratch directory.
#
# Exit status: 0 lockfile unchanged, 1 lockfile changed (diff on stdout),
# 2 refused or failed, 255 ssh failure.

CLOUDLAB_HOST="${CLOUDLAB_HOST:-}"
CLOUDLAB_IDENTITY_FILE="${CLOUDLAB_IDENTITY_FILE:-/Users/ggattacker/.ssh/cloudlab}"
CLOUDLAB_REMOTE_ROOT="${CLOUDLAB_REMOTE_ROOT:-}"
ALLOWED_HOST='span14@pc63.cloudlab.umass.edu'
ALLOWED_ROOT='/users/span14/predex-builds/predex-pump-privy'
ALLOWED_WORKTREE='/Users/ggattacker/Documents/predex/predex-pump-privy'
SCRATCH_PATTERN='^/users/span14/predex-builds/predex-pump-privy/scratch/frontend-lock\.[A-Za-z0-9]{8}$'
NODE_VERSION='22.19.0'
PNPM_VERSION='10.29.2'
INPUTS=(frontend/package.json frontend/pnpm-lock.yaml shared/package.json)

trap 'exit 2' ERR

refuse() {
  printf 'Refusing %s\n' "$1" >&2
  exit 2
}

[[ "$CLOUDLAB_HOST" == "$ALLOWED_HOST" ]] ||
  refuse "unexpected CloudLab host: $CLOUDLAB_HOST"
[[ "$CLOUDLAB_REMOTE_ROOT" == "$ALLOWED_ROOT" ]] ||
  refuse "unexpected remote root: $CLOUDLAB_REMOTE_ROOT"
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ "$repo_root" == "$ALLOWED_WORKTREE" ]] ||
  refuse "unexpected worktree: $repo_root"

input_hashes=()
for input in "${INPUTS[@]}"; do
  [[ -f "$repo_root/$input" && ! -L "$repo_root/$input" ]] ||
    refuse "missing or symlinked input: $input"
  input_hashes+=("$(shasum -a 256 "$repo_root/$input" | awk '{print $1}')")
done

ssh_args=(
  -i "$CLOUDLAB_IDENTITY_FILE"
  -o BatchMode=yes
  -o ConnectTimeout=12
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=4
)

scratch="$(ssh "${ssh_args[@]}" "$CLOUDLAB_HOST" bash -s -- "$ALLOWED_ROOT" <<'REMOTE'
set -euo pipefail
remote_root="$1"
[[ "$remote_root" == /users/span14/predex-builds/predex-pump-privy ]] || {
  printf 'Refusing unexpected remote root: %s\n' "$remote_root" >&2
  exit 2
}
umask 077
mkdir -p "$remote_root/scratch"
scratch="$(mktemp -d "$remote_root/scratch/frontend-lock.XXXXXXXX")"
mkdir -p "$scratch/input/frontend" "$scratch/input/shared"
printf '%s\n' "$scratch"
REMOTE
)"
[[ "$scratch" =~ $SCRATCH_PATTERN ]] ||
  refuse "unexpected scratch directory: $scratch"
printf 'scratch=%s\n' "$scratch" >&2

for input in "${INPUTS[@]}"; do
  ssh "${ssh_args[@]}" "$CLOUDLAB_HOST" \
    "umask 077; cat > '$scratch/input/$input'" < "$repo_root/$input"
done

status=0
ssh "${ssh_args[@]}" "$CLOUDLAB_HOST" bash -s -- \
  "$ALLOWED_ROOT" "$scratch" "$NODE_VERSION" "$PNPM_VERSION" \
  "${input_hashes[@]}" <<'REMOTE' || status=$?
set -Eeuo pipefail
trap 'exit 2' ERR

remote_root="$1"
scratch="$2"
node_version="$3"
pnpm_version="$4"
shift 4
expected_hashes=("$@")
inputs=(frontend/package.json frontend/pnpm-lock.yaml shared/package.json)

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

sha256() {
  sha256sum "$1" | awk '{print $1}'
}

[[ "$remote_root" == /users/span14/predex-builds/predex-pump-privy ]] ||
  fail "Refusing unexpected remote root: $remote_root"
case "$scratch" in
  "$remote_root"/scratch/frontend-lock.*) ;;
  *) fail "Refusing unexpected scratch directory: $scratch" ;;
esac
[[ ! -L "$scratch" && -d "$scratch/input" && ! -e "$scratch/work" ]] ||
  fail "Refusing reused scratch directory: $scratch"
[[ "${#expected_hashes[@]}" -eq "${#inputs[@]}" ]] ||
  fail 'Refusing mismatched input hash count.'

# Only the lockfile diff reaches stdout.
exec 3>&1 1>&2

for index in "${!inputs[@]}"; do
  [[ "$(sha256 "$scratch/input/${inputs[$index]}")" == "${expected_hashes[$index]}" ]] ||
    fail "Uploaded ${inputs[$index]} does not match the local file."
done

node_root="$HOME/.local/predex-toolchain/node-v${node_version}-linux-x64"
export PATH="$node_root/bin:$PATH"
[[ "$(node --version 2>/dev/null || true)" == "v$node_version" ]] ||
  fail "Node v$node_version is missing; run scripts/cloudlab/bootstrap.sh."
[[ "$(pnpm --version 2>/dev/null || true)" == "$pnpm_version" ]] ||
  fail "pnpm $pnpm_version is missing; run scripts/cloudlab/bootstrap.sh."
node -e '
  const manifest = require(process.argv[1]);
  process.exit(manifest.packageManager === `pnpm@${process.argv[2]}` ? 0 : 1);
' "$scratch/input/frontend/package.json" "$pnpm_version" ||
  fail "frontend/package.json must pin packageManager pnpm@$pnpm_version."

# input/ keeps the uploaded originals; pnpm only runs against the work/ copy.
mkdir "$scratch/work"
cp -R "$scratch/input/frontend" "$scratch/input/shared" "$scratch/work/"

printf '\n== pnpm install --lockfile-only ==\n'
(
  cd "$scratch/work/frontend"
  pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile < /dev/null
) 2>&1 | tee "$scratch/pnpm.log"

cmp -s "$scratch/input/frontend/package.json" "$scratch/work/frontend/package.json" ||
  fail 'pnpm modified frontend/package.json; refusing to emit a lockfile-only diff.'

original_lock="$scratch/input/frontend/pnpm-lock.yaml"
resolved_lock="$scratch/work/frontend/pnpm-lock.yaml"
diff_status=0
diff -u --label a/frontend/pnpm-lock.yaml --label b/frontend/pnpm-lock.yaml \
  "$original_lock" "$resolved_lock" > "$scratch/lockfile.diff" || diff_status=$?
[[ "$diff_status" -le 1 ]] || fail 'Lockfile diff failed.'
if [[ "$diff_status" -eq 0 ]]; then
  lockfile_diff=unchanged
else
  lockfile_diff=changed
fi

{
  printf 'scratch=%s\n' "$scratch"
  printf 'node=%s\npnpm=%s\n' "$(node --version)" "$(pnpm --version)"
  for input in "${inputs[@]}"; do
    printf 'input_sha256=%s %s\n' "$(sha256 "$scratch/input/$input")" "$input"
  done
  printf 'resolved_lock_sha256=%s frontend/pnpm-lock.yaml\n' "$(sha256 "$resolved_lock")"
  printf 'lockfile_diff=%s\n' "$lockfile_diff"
} | tee "$scratch/resolution.txt"

cat "$scratch/lockfile.diff" >&3
exit "$diff_status"
REMOTE
exit "$status"
