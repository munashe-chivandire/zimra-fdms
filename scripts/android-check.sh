#!/usr/bin/env bash
# Build packages/react-native/android/check into an APK with the SDK's own
# tools (javac, d8, aapt2, zipalign, apksigner), install it on the running
# emulator, forward the bridge port, and run scripts/android-emulator-e2e.ts.
#
# No Gradle, AGP or React Native download is needed: the check app is plain
# Java over the platform jar. Needs a JDK, ANDROID_HOME (or the default SDK
# path) and one booted emulator or device on adb.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$LOCALAPPDATA/Android/Sdk}}"
JDK="${JAVA_HOME:-/c/Program Files/Android/Android Studio/jbr}"
BT="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)"
PLATFORM="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)/android.jar"
ADB="$SDK/platform-tools/adb"
SRC="$ROOT/packages/react-native/android/check"
OUT="${ANDROID_CHECK_OUT:-$ROOT/packages/react-native/android/check/build}"
PORT="${ADB_FORWARD_PORT:-9999}"

# On Windows d8 and apksigner are .bat wrappers.
tool() { if [ -f "$BT/$1.bat" ]; then echo "$BT/$1.bat"; else echo "$BT/$1"; fi; }
D8="$(tool d8)"; APKSIGNER="$(tool apksigner)"
# The .bat wrappers look for java through JAVA_HOME, as a Windows path.
if command -v cygpath >/dev/null 2>&1; then export JAVA_HOME="$(cygpath -w "$JDK")"; else export JAVA_HOME="$JDK"; fi
export PATH="$JDK/bin:$PATH"

echo "build-tools $BT"
echo "platform    $PLATFORM"
# Keep debug.keystore across runs; a new signing key makes adb refuse the update.
rm -rf "$OUT/classes" "$OUT/dex" "$OUT"/*.apk && mkdir -p "$OUT/classes" "$OUT/dex"

"$JDK/bin/javac" --release 17 -Xlint:-options -cp "$PLATFORM" -d "$OUT/classes" "$SRC"/src/com/zimrafdms/check/*.java
"$D8" --min-api 26 --lib "$PLATFORM" --output "$OUT/dex" "$OUT"/classes/com/zimrafdms/check/*.class
"$BT/aapt2" link -o "$OUT/unaligned.apk" --manifest "$SRC/AndroidManifest.xml" -I "$PLATFORM" --min-sdk-version 26 --target-sdk-version 34
# aapt2 only packages resources and the manifest; add the dex ourselves.
(cd "$OUT/dex" && "$JDK/bin/jar" --update --file "$OUT/unaligned.apk" classes.dex)
"$BT/zipalign" -f 4 "$OUT/unaligned.apk" "$OUT/aligned.apk"
if [ ! -f "$OUT/debug.keystore" ]; then
  "$JDK/bin/keytool" -genkeypair -keystore "$OUT/debug.keystore" -storepass android -keypass android -alias check \
    -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=zimra-fdms check" >/dev/null 2>&1
fi
"$APKSIGNER" sign --ks "$OUT/debug.keystore" --ks-pass pass:android --key-pass pass:android --ks-key-alias check \
  --out "$OUT/check.apk" "$OUT/aligned.apk"
echo "apk         $OUT/check.apk"

"$ADB" wait-for-device
"$ADB" install -r "$OUT/check.apk" || { "$ADB" uninstall com.zimrafdms.check >/dev/null; "$ADB" install "$OUT/check.apk"; }
"$ADB" shell am force-stop com.zimrafdms.check >/dev/null 2>&1 || true
"$ADB" shell am start -n com.zimrafdms.check/.MainActivity >/dev/null
"$ADB" forward "tcp:$PORT" "tcp:9999"
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/ping" -X POST -d '{}'; then break; fi
  sleep 1
done
echo "bridge      http://127.0.0.1:$PORT"

cd "$ROOT" && ADB_FORWARD_PORT="$PORT" npx tsx scripts/android-emulator-e2e.ts
