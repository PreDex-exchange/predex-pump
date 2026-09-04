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
flutter_root="$toolchain_root/flutter-3.47.2"
jdk_root="$toolchain_root/temurin-17.0.20.1_1"
android_root="$toolchain_root/android-sdk-15859902"
mkdir -p "$toolchain_root" "$HOME/.cache/predex-flutter"

sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  zip unzip libglu1-mesa

if [[ ! -x "$flutter_root/bin/flutter" ]]; then
  temp_dir="$(mktemp -d "$toolchain_root/flutter-download.XXXXXX")"
  cleanup_flutter() {
    if [[ -d "$temp_dir" ]]; then
      find "$temp_dir" -depth -mindepth 1 -delete
      rmdir "$temp_dir"
    fi
  }
  trap cleanup_flutter EXIT
  archive="$temp_dir/flutter.tar.xz"
  curl -fL --retry 3 --output "$archive" \
    https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_3.47.2-stable.tar.xz
  printf '%s  %s\n' \
    447878859d01ca9bfdb99a85f245af07ed8a15fedcd9d189c4749e8e92d1f185 \
    "$archive" | sha256sum --check
  mkdir -p "$temp_dir/extracted"
  tar -xJf "$archive" -C "$temp_dir/extracted"
  mv "$temp_dir/extracted/flutter" "$flutter_root"
  trap - EXIT
  cleanup_flutter
fi

if [[ ! -x "$jdk_root/bin/java" ]]; then
  temp_dir="$(mktemp -d "$toolchain_root/jdk-download.XXXXXX")"
  cleanup_jdk() {
    if [[ -d "$temp_dir" ]]; then
      find "$temp_dir" -depth -mindepth 1 -delete
      rmdir "$temp_dir"
    fi
  }
  trap cleanup_jdk EXIT
  archive="$temp_dir/jdk.tar.gz"
  curl -fL --retry 3 --output "$archive" \
    'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_linux_hotspot_17.0.20.1_1.tar.gz'
  printf '%s  %s\n' \
    3808d1d15e3ec6bd5b84057fb5d84c33d8a1536a258146bcea2e603fc726e08e \
    "$archive" | sha256sum --check
  mkdir -p "$temp_dir/extracted"
  tar -xzf "$archive" -C "$temp_dir/extracted"
  extracted="$(find "$temp_dir/extracted" -mindepth 1 -maxdepth 1 \
    -type d -name 'jdk-*' -print -quit)"
  [[ -n "$extracted" ]]
  mv "$extracted" "$jdk_root"
  trap - EXIT
  cleanup_jdk
fi

if [[ ! -x "$android_root/cmdline-tools/latest/bin/sdkmanager" ]]; then
  temp_dir="$(mktemp -d "$toolchain_root/android-download.XXXXXX")"
  cleanup_android() {
    if [[ -d "$temp_dir" ]]; then
      find "$temp_dir" -depth -mindepth 1 -delete
      rmdir "$temp_dir"
    fi
  }
  trap cleanup_android EXIT
  archive="$temp_dir/commandlinetools.zip"
  curl -fL --retry 3 --output "$archive" \
    https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip
  printf '%s  %s\n' \
    4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583 \
    "$archive" | sha256sum --check
  unzip -q "$archive" -d "$temp_dir/extracted"
  mkdir -p "$android_root/cmdline-tools"
  mv "$temp_dir/extracted/cmdline-tools" "$android_root/cmdline-tools/latest"
  trap - EXIT
  cleanup_android
fi

export FLUTTER_ROOT="$flutter_root"
export JAVA_HOME="$jdk_root"
export ANDROID_SDK_ROOT="$android_root"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export PATH="$FLUTTER_ROOT/bin:$JAVA_HOME/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$PATH"
mkdir -p "$HOME/.android"
touch "$HOME/.android/repositories.cfg"

set +o pipefail
yes | sdkmanager --licenses >/tmp/predex-android-licenses.log
license_status="${PIPESTATUS[1]}"
set -o pipefail
[[ "$license_status" -eq 0 ]]
sdkmanager \
  'platform-tools' \
  'platforms;android-36' \
  'build-tools;36.0.0' \
  'ndk;28.2.13676358'

flutter config --no-analytics
flutter --version
java -version
sdkmanager --list_installed | sed -n '1,80p'
printf 'Mobile toolchain ready.\nFlutter: %s\nJDK: %s\nAndroid: %s\n' \
  "$flutter_root" "$jdk_root" "$android_root"
REMOTE
