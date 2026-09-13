#!/usr/bin/env bash
set -euo pipefail

# Installs libpq5, the only OS test library Matchstick needs, on pc63.

CLOUDLAB_HOST="${CLOUDLAB_HOST:-}"
CLOUDLAB_IDENTITY_FILE="${CLOUDLAB_IDENTITY_FILE:-/Users/ggattacker/.ssh/cloudlab}"

if [[ "$CLOUDLAB_HOST" != 'span14@pc63.cloudlab.umass.edu' ]]; then
  printf 'Refusing unexpected CloudLab host: %s\n' "$CLOUDLAB_HOST" >&2
  exit 1
fi

ssh_args=(
  -i "$CLOUDLAB_IDENTITY_FILE"
  -o BatchMode=yes
  -o ConnectTimeout=12
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=4
)

ssh "${ssh_args[@]}" "$CLOUDLAB_HOST" bash -s <<'REMOTE'
set -euo pipefail
export PATH="$PATH:/usr/sbin:/sbin"

# Capture the cache first so grep exiting early cannot SIGPIPE ldconfig.
libpq_visible() {
  local cache
  cache="$(ldconfig -p 2>/dev/null || true)"
  [[ "$cache" == *'libpq.so.5 '* ]]
}

if libpq_visible; then
  printf 'libpq.so.5 already visible to the loader; nothing to install.\n'
  exit 0
fi

printf 'Installing libpq5: an OS library outside /users and /mnt/data, used solely as a build/test prerequisite.\n'
sudo -n apt-get install --yes --no-install-recommends libpq5 < /dev/null

libpq_visible || {
  printf 'libpq.so.5 is still not visible to the loader after install.\n' >&2
  exit 1
}
printf 'libpq.so.5 visible to the loader.\n'
REMOTE
