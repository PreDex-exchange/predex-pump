#!/usr/bin/env bash
set -euo pipefail

# Installs the pinned gstack browse tool on pc63 under the predex toolchain.
# The exact gstack commit is archived locally (no .git, deps, or builds) and
# gstack's own ./setup builds browse and Playwright Chromium on pc63. Nothing is
# installed or built on the Mac. Re-running is a no-op once setup has completed.

CLOUDLAB_HOST="${CLOUDLAB_HOST:-}"
CLOUDLAB_IDENTITY_FILE="${CLOUDLAB_IDENTITY_FILE:-/Users/ggattacker/.ssh/cloudlab}"
GSTACK_SOURCE=/Users/ggattacker/Documents/gstack
GSTACK_COMMIT=e76f65a8da31ec14776a965c608222c1aecad656

fail() {
  printf 'bootstrap-browse: %s\n' "$*" >&2
  exit 1
}

# POSIX single-quoting, so the remote login shell's flavour does not matter.
sq() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

if [[ "$CLOUDLAB_HOST" != 'span14@pc63.cloudlab.umass.edu' ]]; then
  fail "refusing unexpected CloudLab host: $CLOUDLAB_HOST"
fi
(($# == 0)) || fail 'accepts no arguments'

resolved_commit="$(git -C "$GSTACK_SOURCE" rev-parse --verify "$GSTACK_COMMIT^{commit}")" ||
  fail "pinned gstack commit $GSTACK_COMMIT is not present in $GSTACK_SOURCE"
[[ "$resolved_commit" == "$GSTACK_COMMIT" ]] || fail 'pinned gstack commit did not resolve exactly'

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/predex-gstack-archive.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
archive="$work_dir/gstack-$GSTACK_COMMIT.tar"
# Archive the commit, not the worktree: untracked markers never leave the Mac.
git -C "$GSTACK_SOURCE" archive --format=tar --output="$archive" "$GSTACK_COMMIT" -- . ':(exclude)lib/diagram-render/dist'
archive_sha256="$(shasum -a 256 "$archive" | cut -d' ' -f1)"
printf 'gstack_commit=%s\narchive_sha256=%s\n' "$GSTACK_COMMIT" "$archive_sha256"

# Capture the payload with a top-level heredoc: Bash 3.2 mis-parses quotes in a
# heredoc nested inside $(...). read returns nonzero at EOF, which is expected.
remote_script=''
IFS= read -r -d '' remote_script <<'REMOTE' || true
set -euo pipefail

commit="$1"
archive_sha256="$2"
bun_version=1.3.10
bun_url='https://github.com/oven-sh/bun/releases/download/bun-v1.3.10/bun-linux-x64-baseline.zip'
bun_sha256='41201a8c5ee74a9dcbb1ce25a1104f1f929838b57a845aa78d98379b0ce7cde2'
toolchain_root=/users/span14/.local/predex-toolchain
node_bin="$toolchain_root/node-v22.19.0-linux-x64/bin"
bun_root="$toolchain_root/bun-v1.3.10-baseline"
gstack_root="$toolchain_root/gstack-${commit:0:12}"
evidence_dir="$toolchain_root/evidence/gstack-${commit:0:12}"
provenance="gstack_commit=$commit"

fail() {
  printf 'bootstrap-browse: %s\n' "$*" >&2
  exit 1
}

[[ -x "$node_bin/node" ]] || fail "missing Node toolchain at $node_bin"
mkdir -p "$evidence_dir"
exec > >(tee "$evidence_dir/bootstrap-$(date -u +%Y%m%dT%H%M%SZ).log") 2>&1

tmp_dir="$(mktemp -d "$toolchain_root/.gstack-bootstrap.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT
cat > "$tmp_dir/gstack.tar"
printf '%s  %s\n' "$archive_sha256" "$tmp_dir/gstack.tar" | sha256sum --check --quiet ||
  fail 'gstack archive checksum mismatch after transfer'

if [[ -e "$bun_root" ]]; then
  [[ -x "$bun_root/bin/bun" && "$("$bun_root/bin/bun" --version)" == "$bun_version" ]] ||
    fail "refusing: $bun_root exists but is not Bun $bun_version"
  printf 'Bun %s already installed at %s\n' "$bun_version" "$bun_root"
else
  command -v unzip >/dev/null 2>&1 || fail 'unzip is required to unpack the Bun archive'
  curl -fL --retry 3 --output "$tmp_dir/bun.zip" "$bun_url"
  # Verify before anything is extracted or executed.
  printf '%s  %s\n' "$bun_sha256" "$tmp_dir/bun.zip" | sha256sum --check
  unzip -q "$tmp_dir/bun.zip" -d "$tmp_dir/bun"
  bun_candidate="$tmp_dir/bun/bun-linux-x64-baseline/bun"
  chmod 0755 "$bun_candidate"
  [[ "$("$bun_candidate" --version)" == "$bun_version" ]] || fail 'downloaded Bun reports an unexpected version'
  mkdir -p "$tmp_dir/bun-stage/bin"
  install -m 0755 "$bun_candidate" "$tmp_dir/bun-stage/bin/bun"
  printf 'url=%s\nsha256=%s\n' "$bun_url" "$bun_sha256" > "$tmp_dir/bun-stage/.predex-provenance"
  mv -T "$tmp_dir/bun-stage" "$bun_root"
  printf 'Installed Bun %s at %s\n' "$bun_version" "$bun_root"
fi

# gstack setup calls bunx; provide Bun's standard alias without clobbering anything.
if [[ ! -e "$bun_root/bin/bunx" && ! -L "$bun_root/bin/bunx" ]]; then
  ln -s bun "$bun_root/bin/bunx"
fi
[[ -L "$bun_root/bin/bunx" && "$(readlink "$bun_root/bin/bunx")" == bun ]] ||
  fail "refusing: $bun_root/bin/bunx exists and is not a symlink to bun"

if [[ -e "$gstack_root" ]]; then
  [[ -f "$gstack_root/.predex-gstack-provenance" ]] &&
    grep -Fxq "$provenance" "$gstack_root/.predex-gstack-provenance" ||
    fail "refusing: $gstack_root exists without provenance for $commit"
  printf 'gstack %s already unpacked at %s\n' "$commit" "$gstack_root"
else
  mkdir "$tmp_dir/gstack-stage"
  tar -xf "$tmp_dir/gstack.tar" -C "$tmp_dir/gstack-stage"
  [[ ! -e "$tmp_dir/gstack-stage/.git" ]] || fail 'archive unexpectedly contains .git'
  printf '%s\narchive_sha256=%s\nsource=git archive of the exact commit; no .git\n' \
    "$provenance" "$archive_sha256" > "$tmp_dir/gstack-stage/.predex-gstack-provenance"
  mv -T "$tmp_dir/gstack-stage" "$gstack_root"
  printf 'Unpacked gstack %s at %s\n' "$commit" "$gstack_root"
fi

# Playwright's Chromium needs these shared libraries; install only what is absent.
missing_packages=()
for package in libnspr4 libnss3 libgbm1; do
  if [[ "$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)" != installed ]]; then
    missing_packages+=("$package")
  fi
done
if ((${#missing_packages[@]} > 0)); then
  printf 'Installing Chromium runtime libraries: %s\n' "${missing_packages[*]}"
  sudo -n DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    "${missing_packages[@]}" < /dev/null
fi

export PATH="$bun_root/bin:$node_bin:$PATH"
browse_bin="$gstack_root/browse/dist/browse"
setup_marker="$gstack_root/.predex-setup-complete"
if [[ -x "$browse_bin" && -f "$setup_marker" ]]; then
  printf 'Pinned browse already set up; skipping ./setup.\n'
else
  (
    cd "$gstack_root"
    GSTACK_SKIP_FONTS=1 GSTACK_SKIP_COREUTILS=1 ./setup \
      --host codex --model gpt-5.6-sol --no-team --no-prefix --no-plan-tune-hooks < /dev/null
  )
  [[ -x "$browse_bin" ]] || fail "setup finished without $browse_bin"
  printf 'setup_completed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$setup_marker"
fi

printf '\ngstack_commit=%s\ngstack_version=%s\nbun=%s (%s)\nnode=%s\nbrowse=%s\nevidence=%s\n' \
  "$commit" "$(cat "$gstack_root/VERSION" 2>/dev/null || printf unknown)" \
  "$(bun --version)" "$bun_root/bin/bun" "$(node --version)" "$browse_bin" "$evidence_dir"
REMOTE

encoded_script="$(printf '%s\n' "$remote_script" | base64 | tr -d '\n')"
remote_command="bash -c \"\$(printf %s $encoded_script | base64 -d)\" bootstrap-browse"
remote_command+=" $(sq "$GSTACK_COMMIT") $(sq "$archive_sha256")"

ssh_args=(
  -i "$CLOUDLAB_IDENTITY_FILE"
  -o BatchMode=yes
  -o ConnectTimeout=12
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=4
)

ssh "${ssh_args[@]}" "$CLOUDLAB_HOST" "$remote_command" < "$archive"
