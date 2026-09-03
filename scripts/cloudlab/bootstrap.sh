#!/usr/bin/env bash
set -euo pipefail

CLOUDLAB_HOST="${CLOUDLAB_HOST:-span14@c220g1-031117.wisc.cloudlab.us}"
CLOUDLAB_IDENTITY_FILE="${CLOUDLAB_IDENTITY_FILE:-/Users/ggattacker/.ssh/cloudlab}"
PREDEX_NODE_VERSION="${PREDEX_NODE_VERSION:-22.19.0}"
PREDEX_PNPM_VERSION="${PREDEX_PNPM_VERSION:-10.29.2}"

ssh_args=(
  -i "$CLOUDLAB_IDENTITY_FILE"
  -o BatchMode=yes
  -o ConnectTimeout=12
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=4
)

ssh "${ssh_args[@]}" "$CLOUDLAB_HOST" bash -s -- \
  "$PREDEX_NODE_VERSION" "$PREDEX_PNPM_VERSION" <<'REMOTE'
set -euo pipefail

node_version="$1"
pnpm_version="$2"
toolchain_root="$HOME/.local/predex-toolchain"
node_root="$toolchain_root/node-v${node_version}-linux-x64"
node_archive="node-v${node_version}-linux-x64.tar.xz"
node_url="https://nodejs.org/dist/v${node_version}"

if [[ ! -x "$node_root/bin/node" ]]; then
  download_dir="$(mktemp -d)"
  trap 'rm -rf "$download_dir"' EXIT
  curl -fsSLo "$download_dir/$node_archive" "$node_url/$node_archive"
  curl -fsSLo "$download_dir/SHASUMS256.txt" "$node_url/SHASUMS256.txt"
  (
    cd "$download_dir"
    grep "  $node_archive\$" SHASUMS256.txt | sha256sum --check --strict
  )
  mkdir -p "$node_root"
  tar -xJf "$download_dir/$node_archive" -C "$node_root" --strip-components=1
fi

export PATH="$node_root/bin:$PATH"
if [[ "$(pnpm --version 2>/dev/null || true)" != "$pnpm_version" ]]; then
  npm install --global "pnpm@$pnpm_version"
fi

mkdir -p "$HOME/predex-builds/predex-pump"
printf 'node=%s\npnpm=%s\n' "$(node --version)" "$(pnpm --version)"
REMOTE
