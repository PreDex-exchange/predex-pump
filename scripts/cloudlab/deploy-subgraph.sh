#!/usr/bin/env bash
set -euo pipefail

CLOUDLAB_HOST="${CLOUDLAB_HOST:-span14@c220g1-031117.wisc.cloudlab.us}"
CLOUDLAB_IDENTITY_FILE="${CLOUDLAB_IDENTITY_FILE:-/Users/ggattacker/.ssh/cloudlab}"
CLOUDLAB_REMOTE_ROOT="${CLOUDLAB_REMOTE_ROOT:-/users/span14/predex-builds/predex-pump}"
GRAPH_DEPLOY_KEY_FILE="${GRAPH_DEPLOY_KEY_FILE:-/Users/ggattacker/Documents/predex/.credentials/.graph}"
SUBGRAPH_SLUG="${SUBGRAPH_SLUG:-predex}"
SUBGRAPH_VERSION_LABEL="${SUBGRAPH_VERSION_LABEL:-0.0.1}"

case "$CLOUDLAB_REMOTE_ROOT" in
  /users/span14/predex-builds/predex-pump) ;;
  *)
    printf 'Refusing unexpected remote root: %s\n' "$CLOUDLAB_REMOTE_ROOT" >&2
    exit 1
    ;;
esac

[[ "$SUBGRAPH_SLUG" == predex ]] || {
  printf 'Refusing unexpected Studio slug: %s\n' "$SUBGRAPH_SLUG" >&2
  exit 1
}
[[ "$SUBGRAPH_VERSION_LABEL" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  printf 'Subgraph version label must be semver, received %s\n' \
    "$SUBGRAPH_VERSION_LABEL" >&2
  exit 1
}
[[ -f "$GRAPH_DEPLOY_KEY_FILE" && ! -L "$GRAPH_DEPLOY_KEY_FILE" ]] || {
  printf 'Graph deploy key must be a regular, non-symlink file: %s\n' \
    "$GRAPH_DEPLOY_KEY_FILE" >&2
  exit 1
}
[[ -O "$GRAPH_DEPLOY_KEY_FILE" ]] || {
  printf 'Graph deploy key must be owned by the current user.\n' >&2
  exit 1
}

key_mode="$(stat -f '%Lp' "$GRAPH_DEPLOY_KEY_FILE")"
case "$key_mode" in
  400 | 600) ;;
  *)
    printf 'Graph deploy key mode must be 400 or 600, received %s\n' \
      "$key_mode" >&2
    exit 1
    ;;
esac

repo_root="$(git rev-parse --show-toplevel)"
source_hash="$({
  git -C "$repo_root" ls-files --cached --others --exclude-standard |
    LC_ALL=C sort |
    while IFS= read -r path; do
      printf '%s\n' "$path"
      shasum -a 256 "$repo_root/$path" | awk '{print $1}'
    done
} | shasum -a 256 | awk '{print $1}')"
source_id="$(git -C "$repo_root" rev-parse --short=12 HEAD)-${source_hash:0:12}"
remote_helper="$CLOUDLAB_REMOTE_ROOT/source/scripts/cloudlab/deploy-subgraph-remote.sh"
ssh_args=(
  -i "$CLOUDLAB_IDENTITY_FILE"
  -o BatchMode=yes
  -o ConnectTimeout=12
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=4
)

# The token travels only over SSH stdin. It is never placed in argv, an
# environment variable, source, or a persistent Graph CLI credential file.
ssh "${ssh_args[@]}" "$CLOUDLAB_HOST" \
  "$remote_helper" \
  "$CLOUDLAB_REMOTE_ROOT" \
  "$source_id" \
  "$SUBGRAPH_SLUG" \
  "$SUBGRAPH_VERSION_LABEL" < "$GRAPH_DEPLOY_KEY_FILE"
