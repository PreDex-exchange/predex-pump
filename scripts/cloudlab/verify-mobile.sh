#!/usr/bin/env bash
set -euo pipefail

CLOUDLAB_HOST="${CLOUDLAB_HOST:-span14@c220g1-031117.wisc.cloudlab.us}"
CLOUDLAB_IDENTITY_FILE="${CLOUDLAB_IDENTITY_FILE:-/Users/ggattacker/.ssh/cloudlab}"
CLOUDLAB_REMOTE_ROOT="${CLOUDLAB_REMOTE_ROOT:-/users/span14/predex-builds/predex-pump}"
MOBILE_APP_URL="${MOBILE_APP_URL:-http://127.0.0.1:3002}"
MOBILE_ALLOW_INSECURE_LOOPBACK="${MOBILE_ALLOW_INSECURE_LOOPBACK:-true}"

case "$CLOUDLAB_REMOTE_ROOT" in
  /users/span14/predex-builds/predex-pump) ;;
  *)
    printf 'Refusing unexpected remote root: %s\n' "$CLOUDLAB_REMOTE_ROOT" >&2
    exit 1
    ;;
esac

case "$MOBILE_ALLOW_INSECURE_LOOPBACK:$MOBILE_APP_URL" in
  false:https://*) ;;
  true:http://127.0.0.1:* | true:http://localhost:* | true:http://10.0.2.2:*) ;;
  *)
    printf 'Refusing mobile URL without an explicit HTTPS or loopback policy: %s\n' \
      "$MOBILE_APP_URL" >&2
    exit 1
    ;;
esac

ssh_args=(
  -i "$CLOUDLAB_IDENTITY_FILE"
  -o BatchMode=yes
  -o ConnectTimeout=12
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=4
)

ssh "${ssh_args[@]}" "$CLOUDLAB_HOST" bash -s -- \
  "$CLOUDLAB_REMOTE_ROOT" "$MOBILE_APP_URL" "$MOBILE_ALLOW_INSECURE_LOOPBACK" <<'REMOTE'
set -euo pipefail

remote_root="$1"
mobile_app_url="$2"
allow_insecure_loopback="$3"
source_dir="$remote_root/source"
toolchain_root="$HOME/.local/predex-toolchain"
source_id="$(cat "$source_dir/.predex-source-id")"
evidence_dir="$remote_root/evidence/$source_id/mobile"

export FLUTTER_ROOT="$toolchain_root/flutter-3.47.2"
export JAVA_HOME="$toolchain_root/temurin-17.0.20.1_1"
export ANDROID_SDK_ROOT="$toolchain_root/android-sdk-15859902"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export PUB_CACHE="$HOME/.cache/predex-flutter/pub"
export GRADLE_USER_HOME="$HOME/.cache/predex-flutter/gradle"
export PATH="$FLUTTER_ROOT/bin:$JAVA_HOME/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$PATH"

for executable in flutter dart java sdkmanager; do
  command -v "$executable" >/dev/null 2>&1 || {
    printf 'Required mobile tool is unavailable: %s\n' "$executable" >&2
    exit 1
  }
done

mkdir -p "$evidence_dir"
exec > >(tee "$evidence_dir/verify.log") 2>&1

flutter --version --machine > "$evidence_dir/flutter-version.json"
java -version 2> "$evidence_dir/java-version.txt"
sdkmanager --list_installed > "$evidence_dir/android-packages.txt"
grep -Fq '"frameworkVersion": "3.47.2"' \
  "$evidence_dir/flutter-version.json"
grep -Fq '"frameworkRevision": "d3b14c876900e553bc736ca19295fc09e3853e8e"' \
  "$evidence_dir/flutter-version.json"
grep -Fq '"dartSdkVersion": "3.13.2"' \
  "$evidence_dir/flutter-version.json"
grep -Fq 'openjdk version "17.0.20.1"' \
  "$evidence_dir/java-version.txt"
for android_package in \
  'build-tools;36.0.0' \
  'ndk;28.2.13676358' \
  'platform-tools' \
  'platforms;android-36'; do
  grep -Fq "$android_package" "$evidence_dir/android-packages.txt"
done
printf 'source_id=%s\nstarted_at=%s\napp_url=%s\nallow_insecure_loopback=%s\n' \
  "$source_id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$mobile_app_url" \
  "$allow_insecure_loopback" > "$evidence_dir/manifest.txt"

generated_inputs=(
  "$source_dir/mobile/.dart_tool"
  "$source_dir/mobile/.flutter-plugins-dependencies"
  "$source_dir/mobile/.idea"
  "$source_dir/mobile/build"
  "$source_dir/mobile/predex_mobile.iml"
  "$source_dir/mobile/android/.gradle"
  "$source_dir/mobile/android/local.properties"
  "$source_dir/mobile/android/predex_mobile_android.iml"
  "$source_dir/mobile/android/gradlew"
  "$source_dir/mobile/android/gradlew.bat"
  "$source_dir/mobile/android/gradle/wrapper/gradle-wrapper.jar"
  "$source_dir/mobile/ios/Pods"
  "$source_dir/mobile/ios/.symlinks"
)
for generated_input in "${generated_inputs[@]}"; do
  if [ -e "$generated_input" ]; then
    printf 'Remote source was not clean before verification: %s\n' \
      "$generated_input" >&2
    exit 1
  fi
done
printf 'generated_inputs_at_start=absent\n' >> "$evidence_dir/manifest.txt"

if find "$source_dir/mobile" -type f \
  \( -name 'key.properties' -o -name '*.jks' -o -name '*.keystore' \) \
  -print -quit | grep -q .; then
  printf 'Mobile source contains forbidden signing material.\n' >&2
  exit 1
fi

cd "$source_dir/mobile"
flutter pub get --enforce-lockfile
dart format --output=none --set-exit-if-changed .
flutter analyze --fatal-infos --fatal-warnings
flutter test --coverage --reporter=expanded
flutter build apk --debug \
  --dart-define="PREDEX_APP_URL=$mobile_app_url" \
  --dart-define="PREDEX_ALLOW_INSECURE_LOOPBACK=$allow_insecure_loopback"

for generated_wrapper in \
  android/gradlew \
  android/gradlew.bat \
  android/gradle/wrapper/gradle-wrapper.jar; do
  [ -f "$generated_wrapper" ] || {
    printf 'Pinned Flutter did not regenerate %s\n' "$generated_wrapper" >&2
    exit 1
  }
done
sha256sum \
  android/gradlew \
  android/gradlew.bat \
  android/gradle/wrapper/gradle-wrapper.jar \
  > "$evidence_dir/gradle-wrapper.sha256"
printf 'gradle_wrapper=pinned_flutter_regeneration\n' \
  >> "$evidence_dir/manifest.txt"

apk="build/app/outputs/flutter-apk/app-debug.apk"
[ -f "$apk" ]
if unzip -l "$apk" | grep -Eiq '\.(jks|keystore)$|key\.properties$'; then
  printf 'APK unexpectedly contains signing-material filenames.\n' >&2
  exit 1
fi
"$ANDROID_SDK_ROOT/build-tools/36.0.0/aapt" dump badging "$apk" \
  | tee "$evidence_dir/apk-badging.txt"
grep -Fq "package: name='exchange.predex.mobile'" \
  "$evidence_dir/apk-badging.txt"
grep -Fq "targetSdkVersion:'36'" "$evidence_dir/apk-badging.txt"
"$ANDROID_SDK_ROOT/build-tools/36.0.0/aapt" dump xmltree \
  "$apk" AndroidManifest.xml > "$evidence_dir/apk-manifest.txt"
grep -Fq 'android:allowBackup' "$evidence_dir/apk-manifest.txt"
grep -F 'android:allowBackup' "$evidence_dir/apk-manifest.txt" \
  | grep -Fq '0x0'
grep -F 'android:usesCleartextTraffic' "$evidence_dir/apk-manifest.txt" \
  | grep -Fq '0xffffffff'
"$ANDROID_SDK_ROOT/build-tools/36.0.0/apksigner" verify \
  --verbose --print-certs "$apk" | tee "$evidence_dir/apk-signature.txt"
grep -Fq 'Verified using v2 scheme (APK Signature Scheme v2): true' \
  "$evidence_dir/apk-signature.txt"
grep -Fq 'Number of signers: 1' "$evidence_dir/apk-signature.txt"
grep -Fq 'CN=Android Debug' "$evidence_dir/apk-signature.txt"
cp "$apk" "$evidence_dir/predex-mobile-debug.apk"
cmp "$apk" "$evidence_dir/predex-mobile-debug.apk"
sha256sum "$apk" | tee "$evidence_dir/apk.sha256"
stat -c 'apk_bytes=%s' "$apk" | tee -a "$evidence_dir/manifest.txt"

verified_source_id="$(cat "$source_dir/.predex-source-id")"
[ "$verified_source_id" = "$source_id" ] || {
  printf 'Source changed during mobile verification: %s -> %s\n' \
    "$source_id" "$verified_source_id" >&2
  exit 1
}
printf 'finished_at=%s\nstatus=pass\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >> "$evidence_dir/manifest.txt"
printf 'Mobile verification passed. Evidence: %s\n' "$evidence_dir"
REMOTE
