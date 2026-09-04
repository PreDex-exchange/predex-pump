#!/usr/bin/env bash
set -euo pipefail

CLOUDLAB_HOST="${CLOUDLAB_HOST:-span14@c220g1-031117.wisc.cloudlab.us}"
CLOUDLAB_IDENTITY_FILE="${CLOUDLAB_IDENTITY_FILE:-/Users/ggattacker/.ssh/cloudlab}"

command_name="${1:-status}"
[[ $# -le 1 ]] || {
  printf 'Usage: %s start|status|stop\n' "$0" >&2
  exit 2
}
case "$command_name" in
  start|status|stop) ;;
  --help|-h|help)
    printf 'Usage: %s start|status|stop\n' "$0"
    exit 0
    ;;
  *)
    printf 'Unknown emulator command: %s\n' "$command_name" >&2
    exit 2
    ;;
esac

ssh_args=(
  -i "$CLOUDLAB_IDENTITY_FILE"
  -o BatchMode=yes
  -o ConnectTimeout=12
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=4
)

ssh "${ssh_args[@]}" "$CLOUDLAB_HOST" bash -s -- "$command_name" <<'REMOTE'
set -euo pipefail

command_name="$1"
android_root="$HOME/.local/predex-toolchain/android-sdk-15859902"
jdk_root="$HOME/.local/predex-toolchain/temurin-17.0.20.1_1"
adb="$android_root/platform-tools/adb"
emulator="$android_root/emulator/emulator"
serial='emulator-5554'
avd_name='predex_api_34'
cache_root="$HOME/.cache/predex-emulator"
remote_root='/users/span14/predex-builds/predex-pump'
metamask_apk="$cache_root/metamask-production-main-8.10.0-6766.apk"
metamask_sha256='a5849c52c26003268ed612b01dffdecbad99419f6332caf305b3a14500fd0f67'
export JAVA_HOME="$jdk_root"
export PATH="$JAVA_HOME/bin:$android_root/platform-tools:$PATH"

for required in "$adb" "$emulator"; do
  [[ -x "$required" ]] || {
    printf 'Missing emulator tool: %s\n' "$required" >&2
    exit 1
  }
done

emulator_online() {
  "$adb" -s "$serial" get-state >/dev/null 2>&1
}

case "$command_name" in
  start)
    [[ -w /dev/kvm ]] || {
      printf 'KVM is unavailable to this user; rerun the emulator bootstrap.\n' >&2
      exit 1
    }
    "$emulator" -list-avds | grep -Fxq "$avd_name" || {
      printf 'AVD %s is missing; rerun the emulator bootstrap.\n' "$avd_name" >&2
      exit 1
    }
    mkdir -p "$cache_root"
    printf '%s  %s\n' "$metamask_sha256" "$metamask_apk" \
      | sha256sum --check --status || {
        printf 'The pinned MetaMask APK is missing or has the wrong checksum.\n' >&2
        exit 1
      }

    source_id="$(cat "$remote_root/source/.predex-source-id" 2>/dev/null || true)"
    [[ "$source_id" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ ]] || {
      printf 'The CloudLab source has no valid source ID; run sync.sh first.\n' >&2
      exit 1
    }
    predex_evidence="$remote_root/evidence/$source_id/mobile"
    predex_apk="$predex_evidence/predex-mobile-debug.apk"
    predex_hash="$(awk 'NR == 1 { print $1 }' "$predex_evidence/apk.sha256" 2>/dev/null || true)"
    [[ "$predex_hash" =~ ^[0-9a-f]{64}$ && -f "$predex_apk" ]] || {
      printf 'No verified Predex APK exists for source %s; run verify-mobile.sh first.\n' \
        "$source_id" >&2
      exit 1
    }
    printf '%s  %s\n' "$predex_hash" "$predex_apk" \
      | sha256sum --check --status
    "$android_root/build-tools/36.0.0/aapt" dump badging "$predex_apk" \
      > "$cache_root/predex-installed-badging.txt"
    grep -Fq "package: name='exchange.predex.mobile'" \
      "$cache_root/predex-installed-badging.txt"
    "$android_root/build-tools/36.0.0/apksigner" verify "$predex_apk"

    if ! emulator_online; then
      nohup "$emulator" "@$avd_name" \
        -port 5554 \
        -no-window \
        -no-audio \
        -no-boot-anim \
        -no-snapshot \
        -gpu swiftshader_indirect \
        -accel on \
        -camera-back none \
        -camera-front none \
        > "$cache_root/emulator.log" 2>&1 </dev/null &
      printf '%s\n' "$!" > "$cache_root/emulator.pid"
    fi

    started_at=$SECONDS
    boot_completed=''
    while ((SECONDS - started_at < 180)); do
      if emulator_online; then
        boot_completed="$($adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
        [[ "$boot_completed" == 1 ]] && break
      fi
      sleep 2
    done
    [[ "$boot_completed" == 1 ]] || {
      tail -n 60 "$cache_root/emulator.log" >&2
      printf 'Android emulator did not boot within 180 seconds.\n' >&2
      exit 1
    }

    "$adb" -s "$serial" shell settings put global window_animation_scale 0
    "$adb" -s "$serial" shell settings put global transition_animation_scale 0
    "$adb" -s "$serial" shell settings put global animator_duration_scale 0
    "$adb" -s "$serial" reverse tcp:3001 tcp:3001 >/dev/null
    "$adb" -s "$serial" reverse tcp:3002 tcp:3002 >/dev/null

    if ! "$adb" -s "$serial" shell pm path io.metamask >/dev/null 2>&1; then
      "$adb" -s "$serial" install --no-streaming "$metamask_apk"
    fi
    "$adb" -s "$serial" install --no-streaming -r "$predex_apk"
    "$adb" -s "$serial" shell dumpsys package io.metamask \
      > "$cache_root/metamask-installed-package.txt"
    grep -Fq 'versionName=8.10.0' \
      "$cache_root/metamask-installed-package.txt"
    printf 'Android emulator ready: %s API %s, MetaMask 8.10.0.\n' \
      "$serial" "$($adb -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')"
    printf 'Predex source: %s (%s)\n' "$source_id" "$predex_hash"
    printf 'Reverse ports:\n'
    "$adb" -s "$serial" reverse --list
    ;;
  status)
    if ! emulator_online; then
      printf 'Android emulator is stopped.\n'
      exit 0
    fi
    printf 'serial=%s\nboot_completed=%s\nandroid_release=%s\napi=%s\nabi=%s\n' \
      "$serial" \
      "$($adb -s "$serial" shell getprop sys.boot_completed | tr -d '\r')" \
      "$($adb -s "$serial" shell getprop ro.build.version.release | tr -d '\r')" \
      "$($adb -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')" \
      "$($adb -s "$serial" shell getprop ro.product.cpu.abi | tr -d '\r')"
    "$adb" -s "$serial" shell pm list packages \
      | grep -E '^package:(exchange\.predex\.mobile|io\.metamask)$' || true
    "$adb" -s "$serial" reverse --list
    ;;
  stop)
    if ! emulator_online; then
      printf 'Android emulator is already stopped.\n'
      exit 0
    fi
    "$adb" -s "$serial" emu kill >/dev/null
    for _ in $(seq 1 30); do
      emulator_online || break
      sleep 1
    done
    emulator_online && {
      printf 'Android emulator did not stop cleanly.\n' >&2
      exit 1
    }
    printf 'Android emulator stopped; AVD data was retained.\n'
    ;;
esac
REMOTE
