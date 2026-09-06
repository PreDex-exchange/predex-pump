#!/usr/bin/env bash
set -euo pipefail

CLOUDLAB_HOST="${CLOUDLAB_HOST:-span14@c220g1-031117.wisc.cloudlab.us}"
CLOUDLAB_IDENTITY_FILE="${CLOUDLAB_IDENTITY_FILE:-/Users/ggattacker/.ssh/cloudlab}"
CLOUDLAB_REMOTE_ROOT="${CLOUDLAB_REMOTE_ROOT:-/users/span14/predex-builds/predex-pump}"

case "$CLOUDLAB_REMOTE_ROOT" in
  /users/span14/predex-builds/predex-pump) ;;
  *)
    printf 'Refusing unexpected remote root: %s\n' "$CLOUDLAB_REMOTE_ROOT" >&2
    exit 1
    ;;
esac

repo_root="$(git rev-parse --show-toplevel)"
source_dir="$CLOUDLAB_REMOTE_ROOT/source"
ssh_args=(
  -i "$CLOUDLAB_IDENTITY_FILE"
  -o BatchMode=yes
  -o ConnectTimeout=12
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=4
)

source_hash="$({
  git -C "$repo_root" ls-files --cached --others --exclude-standard |
    LC_ALL=C sort |
    while IFS= read -r path; do
      printf '%s\n' "$path"
      shasum -a 256 "$repo_root/$path" | awk '{print $1}'
    done
} | shasum -a 256 | awk '{print $1}')"
source_id="$(git -C "$repo_root" rev-parse --short=12 HEAD)-${source_hash:0:12}"

ssh "${ssh_args[@]}" "$CLOUDLAB_HOST" bash -s -- "$source_dir" <<'REMOTE'
set -euo pipefail
source_dir="$1"
runtime_active='/users/span14/predex-builds/predex-pump/runtime/active'
case "$source_dir" in
  /users/span14/predex-builds/predex-pump/source) ;;
  *)
    printf 'Refusing unexpected remote source: %s\n' "$source_dir" >&2
    exit 1
    ;;
esac
if [[ -e "$source_dir/.qa/active" ]]; then
  printf 'Refusing to sync over an active QA stack; run qa-stack.sh down first.\n' >&2
  exit 1
fi
if [[ -e "$runtime_active" ]]; then
  printf 'Refusing to sync over the active persistent runtime; run runtime.sh down first.\n' >&2
  exit 1
fi
REMOTE

ssh "${ssh_args[@]}" "$CLOUDLAB_HOST" mkdir -p "$source_dir"
ssh "${ssh_args[@]}" "$CLOUDLAB_HOST" rm -f "$source_dir/.git"

rsync -az --delete --delete-excluded \
  --include='.env.example' \
  --include='.env.*.example' \
  --include='**/.env.example' \
  --include='**/.env.*.example' \
  --exclude='.git' \
  --exclude='.env*' \
  --exclude='**/.env*' \
  --exclude='**/node_modules/' \
  --exclude='**/.next/' \
  --exclude='**/.dart_tool/' \
  --exclude='**/.flutter-plugins-dependencies' \
  --exclude='**/.gradle/' \
  --exclude='**/.idea/' \
  --exclude='**/*.iml' \
  --exclude='**/build/' \
  --exclude='**/android/local.properties' \
  --exclude='**/android/key.properties' \
  --exclude='**/android/gradlew' \
  --exclude='**/android/gradlew.bat' \
  --exclude='**/android/gradle/wrapper/gradle-wrapper.jar' \
  --exclude='**/ios/Pods/' \
  --exclude='**/ios/.symlinks/' \
  --exclude='**/*.jks' \
  --exclude='**/*.keystore' \
  --exclude='**/dist/' \
  --exclude='**/coverage/' \
  --exclude='.qa/' \
  --exclude='.gstack/' \
  --exclude='runtime/' \
  --exclude='*.log' \
  -e "ssh ${ssh_args[*]}" \
  "$repo_root/" "$CLOUDLAB_HOST:$source_dir/"

printf '%s\n' "$source_id" |
  ssh "${ssh_args[@]}" "$CLOUDLAB_HOST" "umask 077; cat > '$source_dir/.predex-source-id'"

printf 'source_id=%s\nremote_source=%s:%s\n' \
  "$source_id" "$CLOUDLAB_HOST" "$source_dir"
