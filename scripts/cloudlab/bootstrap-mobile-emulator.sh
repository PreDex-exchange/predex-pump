#!/usr/bin/env bash
set -euo pipefail

CLOUDLAB_HOST="${CLOUDLAB_HOST:-span14@c220g1-031117.wisc.cloudlab.us}"
CLOUDLAB_IDENTITY_FILE="${CLOUDLAB_IDENTITY_FILE:-/Users/ggattacker/.ssh/cloudlab}"

if [[ "${1:-}" != '--accept-android-licenses' || $# -ne 1 ]]; then
  printf 'Usage: %s --accept-android-licenses\n' "$0" >&2
  printf 'The flag confirms acceptance of Android SDK package licenses.\n' >&2
  exit 2
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

toolchain_root="$HOME/.local/predex-toolchain"
android_root="$toolchain_root/android-sdk-15859902"
jdk_root="$toolchain_root/temurin-17.0.20.1_1"
sdkmanager="$android_root/cmdline-tools/latest/bin/sdkmanager"
avdmanager="$android_root/cmdline-tools/latest/bin/avdmanager"
emulator="$android_root/emulator/emulator"
system_image='system-images;android-34;google_apis;x86_64'
avd_name='predex_api_34'
cache_root="$HOME/.cache/predex-emulator"
metamask_apk="$cache_root/metamask-production-main-8.10.0-6766.apk"
metamask_url='https://github.com/MetaMask/metamask-mobile/releases/download/v8.10.0/metamask-production-main-8.10.0-6766.apk'
metamask_sha256='a5849c52c26003268ed612b01dffdecbad99419f6332caf305b3a14500fd0f67'
metamask_bytes='346778450'
metamask_signer_sha256='8966e9d5f1157f57fe18cc2633e71ea72162c8f484acc755b2a9cd06c2bd5b18'

for required in "$sdkmanager" "$avdmanager" "$jdk_root/bin/java"; do
  [[ -x "$required" ]] || {
    printf 'Missing base mobile toolchain component: %s\n' "$required" >&2
    exit 1
  }
done

sudo usermod -aG kvm "$(id -un)"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  libx11-xcb1
ldconfig -p | grep -Fq 'libX11-xcb.so.1'

export JAVA_HOME="$jdk_root"
export ANDROID_SDK_ROOT="$android_root"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export PATH="$JAVA_HOME/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$PATH"

set +o pipefail
yes | "$sdkmanager" --licenses >/tmp/predex-android-emulator-licenses.log
license_status="${PIPESTATUS[1]}"
set -o pipefail
[[ "$license_status" -eq 0 ]]
"$sdkmanager" 'emulator' "$system_image"

if ! "$emulator" -list-avds | grep -Fxq "$avd_name"; then
  printf 'no\n' | "$avdmanager" create avd \
    --force \
    --name "$avd_name" \
    --package "$system_image" \
    --device 'pixel_5'
fi

mkdir -p "$cache_root"
if [[ ! -f "$metamask_apk" ]] || \
  ! printf '%s  %s\n' "$metamask_sha256" "$metamask_apk" \
    | sha256sum --check --status; then
  temp_apk="$(mktemp "$cache_root/metamask.XXXXXX.apk")"
  cleanup_apk() {
    rm -f "$temp_apk"
  }
  trap cleanup_apk EXIT
  curl -fL --retry 3 --output "$temp_apk" "$metamask_url"
  printf '%s  %s\n' "$metamask_sha256" "$temp_apk" | sha256sum --check
  mv "$temp_apk" "$metamask_apk"
  trap - EXIT
fi

printf '%s  %s\n' "$metamask_sha256" "$metamask_apk" | sha256sum --check
[[ "$(stat -c '%s' "$metamask_apk")" == "$metamask_bytes" ]]
"$ANDROID_SDK_ROOT/build-tools/36.0.0/aapt" dump badging "$metamask_apk" \
  > "$cache_root/metamask-badging.txt"
grep -Fq "package: name='io.metamask' versionCode='6766' versionName='8.10.0'" \
  "$cache_root/metamask-badging.txt"
unzip -Z1 "$metamask_apk" > "$cache_root/metamask-files.txt"
grep -Fq 'lib/x86_64/' "$cache_root/metamask-files.txt"
"$ANDROID_SDK_ROOT/build-tools/36.0.0/apksigner" verify \
  --verbose --print-certs "$metamask_apk" \
  > "$cache_root/metamask-signature.txt"
grep -Fq "Signer #1 certificate SHA-256 digest: $metamask_signer_sha256" \
  "$cache_root/metamask-signature.txt"
grep -Fq 'Number of signers: 1' "$cache_root/metamask-signature.txt"

sg kvm -c "'$emulator' -accel-check"
"$sdkmanager" --list_installed | grep -E \
  '^(  emulator|  system-images;android-34;google_apis;x86_64)'
printf 'avd=%s\nmetamask_apk=%s\nmetamask_sha256=%s\n' \
  "$avd_name" "$metamask_apk" "$metamask_sha256"
printf 'Open a new SSH session before starting the emulator so kvm membership applies.\n'
REMOTE
