#!/usr/bin/env bash
#
# Keep Accounts - one-command Android APK build.
#
# Hand-rolled on purpose: no Gradle, no AndroidX, no npm, no network access.
# Everything is aapt2 + javac + d8 + zipalign + apksigner driven from this file.
#
# Usage:
#   bash build.sh              # build dist/keep-accounts.apk
#   bash build.sh --help
#
# Environment:
#   ANDROID_SDK_ROOT / ANDROID_HOME   override the SDK location
#   JAVA_HOME                         override the JDK (java/javac/keytool come from PATH)
#
# Compatible with the macOS system bash 3.2.

set -euo pipefail

# --------------------------------------------------------------------------- constants

APP_ID="com.keepaccounts.app"
# 包名转目录路径：com.keepaccounts.app -> com/keepaccounts/app
APP_ID_PATH="$(printf '%s' "$APP_ID" | tr '.' '/')"
VERSION_CODE=1
VERSION_NAME="1.0"
MIN_SDK=26
TARGET_SDK=35
BUILD_TOOLS_VERSION="34.0.0"

KEYSTORE_ALIAS="keep"
KEYSTORE_PASS="keepaccounts"
KEYSTORE_VALIDITY_DAYS=10950
KEYSTORE_DNAME="CN=Keep Accounts, OU=Dev, O=Keep, L=Beijing, S=Beijing, C=CN"

# --------------------------------------------------------------------------- helpers

step()  { printf '\n==> %s\n' "$*"; }
info()  { printf '    %s\n' "$*"; }
warn()  { printf 'WARNING: %s\n' "$*" >&2; }
die()   { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
have()  { command -v "$1" >/dev/null 2>&1; }

usage() {
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

case "${1:-}" in
    -h|--help|help) usage ;;
    "") ;;
    *) warn "ignoring unknown argument: $1" ;;
esac

# --------------------------------------------------------------------------- paths

SCRIPT_SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SCRIPT_SOURCE" ]; do
    _link_dir="$(cd -P "$(dirname "$SCRIPT_SOURCE")" && pwd)"
    SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
    case "$SCRIPT_SOURCE" in
        /*) ;;
        *) SCRIPT_SOURCE="$_link_dir/$SCRIPT_SOURCE" ;;
    esac
done
ROOT="$(cd -P "$(dirname "$SCRIPT_SOURCE")" && pwd)"

BACKEND="$ROOT/android"
RES_DIR="$BACKEND/res"
SRC_DIR="$BACKEND/src"
MANIFEST="$BACKEND/AndroidManifest.xml"
ASSETS_DIR="$BACKEND/assets"
UI_DIR="$ASSETS_DIR/ui"
BUILD_DIR="$BACKEND/build"
GEN_DIR="$BUILD_DIR/gen"
CLASSES_DIR="$BUILD_DIR/classes"
DEX_DIR="$BUILD_DIR/dex"
KEYSTORE_DIR="$BACKEND/keystore"
KEYSTORE_FILE="$KEYSTORE_DIR/keep-accounts.jks"
DIST_DIR="$ROOT/dist"
OUT_APK="$DIST_DIR/keep-accounts.apk"
VERIFY_LOG="$BUILD_DIR/apksigner-verify.txt"

# --------------------------------------------------------------------------- SDK discovery

if [ -n "${ANDROID_SDK_ROOT:-}" ]; then
    SDK="$ANDROID_SDK_ROOT"
elif [ -n "${ANDROID_HOME:-}" ]; then
    SDK="$ANDROID_HOME"
elif [ -d "$ROOT/android-sdk/build-tools/$BUILD_TOOLS_VERSION" ]; then
    SDK="$ROOT/android-sdk"
elif [ -d "$HOME/Library/Android/sdk/build-tools/$BUILD_TOOLS_VERSION" ]; then
    SDK="$HOME/Library/Android/sdk"
else
    SDK="$ROOT/android-sdk"
fi

BT="$SDK/build-tools/$BUILD_TOOLS_VERSION"
PLATFORM="$SDK/platforms/android-35/android.jar"

step "Checking toolchain"

[ -d "$SDK" ] || die "Android SDK not found at: $SDK
  Fix one of:
    * put the SDK at $ROOT/android-sdk  (expected layout below), or
    * export ANDROID_SDK_ROOT=/path/to/android-sdk
  Expected layout:
    \$SDK/build-tools/$BUILD_TOOLS_VERSION/{aapt2,d8,zipalign,apksigner}
    \$SDK/platforms/android-35/android.jar"

for tool in aapt2 d8 zipalign apksigner; do
    if [ ! -x "$BT/$tool" ]; then
        die "missing build-tools executable: $BT/$tool
  Fix: install Android SDK Build-Tools $BUILD_TOOLS_VERSION, or point ANDROID_SDK_ROOT at a
  correct SDK. Do not download from dl.google.com on this machine (network is blocked)."
    fi
done

if [ ! -f "$PLATFORM" ]; then
    die "missing platform jar: $PLATFORM
  Fix: install Android SDK Platform 35 (creates platforms/android-35/android.jar), or set
  ANDROID_SDK_ROOT to an SDK that already has it."
fi

for tool in java javac keytool zip; do
    have "$tool" || die "required command not found on PATH: $tool
  Fix: install a JDK 17+ (this project builds with JDK 21) and make sure \$JAVA_HOME/bin is on PATH."
done

# Binaries extracted from a downloaded zip may be quarantined by Gatekeeper.
xattr -dr com.apple.quarantine "$SDK" >/dev/null 2>&1 || true

info "root      : $ROOT"
info "sdk       : $SDK"
info "build-tools: $BT ($("$BT/aapt2" version 2>&1 | head -1))"
info "platform  : $PLATFORM"
info "javac     : $(javac -version 2>&1)"

[ -f "$MANIFEST" ] || die "manifest not found: $MANIFEST"
[ -d "$RES_DIR" ] || die "resources not found: $RES_DIR"
[ -d "$SRC_DIR" ] || die "java sources not found: $SRC_DIR"

# --------------------------------------------------------------------------- safety guard

safe_rm() {
    _target="$1"
    case "$_target" in
        "$BUILD_DIR"|"$UI_DIR") ;;
        *) die "refusing to delete unexpected path: $_target" ;;
    esac
    rm -rf "$_target"
}

# --------------------------------------------------------------------------- 1. assets

step "Staging web assets -> android/assets/ui"

safe_rm "$UI_DIR"
mkdir -p "$UI_DIR"

UI_SOURCE_MISSING=0

if [ -d "$ROOT/public" ]; then
    info "public/ -> android/assets/ui/"
    if have rsync; then
        rsync -a --delete "$ROOT/public/" "$UI_DIR/"
    else
        cp -R "$ROOT/public/." "$UI_DIR/"
    fi
else
    UI_SOURCE_MISSING=1
    warn "public/ does not exist yet - staging a placeholder UI"
fi

# 把接口地址写进包内配置（正式包里用户看不到也不需要填服务器地址）
KA_API_BASE="${KA_API_BASE:-}"
node -e '
  const fs = require("fs");
  const base = (process.env.KA_API_BASE || "").replace(/\/+$/, "");
  fs.writeFileSync(process.argv[1], "window.__KA_CONFIG__ = " + JSON.stringify({ apiBase: base }) + ";\n");
' "$UI_DIR/config.js"
if [ -n "$KA_API_BASE" ]; then
    info "接口地址已写入包内配置: $KA_API_BASE"
else
    warn "未设置 KA_API_BASE：这个 APK 没有接口地址，装到手机上无法登录。"
    warn "  正式打包请用：KA_API_BASE=https://your.domain bash build.sh"
fi

if [ -d "$ROOT/shared" ]; then
    # 关键：shared/ 必须放在 assets/ 下与 ui/ 同级。
    # 页面在 assets/ui/js/*.js 里用 '../../shared/x.js' 引用共享模块，
    # 从 ui/js/ 往上两级正好是 assets/ —— 这样同一份代码在服务器（/shared/x.js）
    # 和 APK（file:///android_asset/shared/x.js）两种环境下都能正确解析。
    info "shared/ -> android/assets/shared/   (imported as ../../shared/x.js)"
    SHARED_DIR="$ASSETS_DIR/shared"
    mkdir -p "$SHARED_DIR"
    if have rsync; then
        rsync -a --delete "$ROOT/shared/" "$SHARED_DIR/"
    else
        rm -rf "$SHARED_DIR"
        mkdir -p "$SHARED_DIR"
        cp -R "$ROOT/shared/." "$SHARED_DIR/"
    fi
else
    UI_SOURCE_MISSING=1
    warn "shared/ does not exist yet - ../../shared/*.js imports will 404"
fi

if [ ! -f "$UI_DIR/index.html" ]; then
    warn "android/assets/ui/index.html not found - writing a placeholder page"
    cat > "$UI_DIR/index.html" <<'PLACEHOLDER_HTML'
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>记账本</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; min-height: 100%; background: #0F1115; }
  body {
    color: #E6E9EF;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB",
                 "Microsoft YaHei", Arial, sans-serif;
    display: flex; align-items: center; justify-content: center;
    padding: 24px 24px calc(24px + env(safe-area-inset-bottom));
    box-sizing: border-box; text-align: center;
  }
  .card { max-width: 420px; }
  .dot { width: 56px; height: 56px; border-radius: 28px; margin: 0 auto 20px;
         background: rgba(108,140,255,.14); border: 1px solid rgba(108,140,255,.5);
         display: flex; align-items: center; justify-content: center;
         font-size: 26px; font-weight: 700; color: #6C8CFF; }
  h1 { font-size: 18px; margin: 0 0 10px; font-weight: 600; }
  p { font-size: 14px; line-height: 1.7; color: #9AA3B2; margin: 0 0 8px; }
  code { font-size: 12px; color: #6C8CFF; word-break: break-all; }
</style>
</head>
<body>
  <div class="card">
    <div class="dot">!</div>
    <h1>界面尚未构建</h1>
    <p>这是占位页面：打包时仓库里还没有 <code>public/</code> 目录。</p>
    <p>把前端产物放到 <code>public/</code>（共享模块放 <code>shared/</code>），重新运行 <code>bash build.sh</code> 即可。</p>
  </div>
</body>
</html>
PLACEHOLDER_HTML
    info "placeholder written to android/assets/ui/index.html"
fi

if [ "$UI_SOURCE_MISSING" -ne 0 ]; then
    warn "web sources (public/ and/or shared/) are missing - the APK below contains a placeholder UI.
        The build still succeeds so the Android toolchain can be validated."
fi

UI_FILE_COUNT="$(find "$UI_DIR" -type f | wc -l | tr -d ' ')"
info "staged $UI_FILE_COUNT file(s)"

# --------------------------------------------------------------------------- 2. clean build dir

step "Preparing android/build"
safe_rm "$BUILD_DIR"
mkdir -p "$GEN_DIR" "$CLASSES_DIR" "$DEX_DIR"
info "clean build directory ready"

# --------------------------------------------------------------------------- 3. aapt2 compile

step "aapt2 compile (resources)"
"$BT/aapt2" compile --dir "$RES_DIR" -o "$BUILD_DIR/res.zip"
info "res.zip: $(du -h "$BUILD_DIR/res.zip" | cut -f1)"

# --------------------------------------------------------------------------- 4. aapt2 link

step "aapt2 link (resources + manifest + assets)"
"$BT/aapt2" link \
    -o "$BUILD_DIR/base.apk" \
    -I "$PLATFORM" \
    --manifest "$MANIFEST" \
    -A "$ASSETS_DIR" \
    --java "$GEN_DIR" \
    --min-sdk-version "$MIN_SDK" \
    --target-sdk-version "$TARGET_SDK" \
    --version-code "$VERSION_CODE" \
    --version-name "$VERSION_NAME" \
    "$BUILD_DIR/res.zip"
info "base.apk: $(du -h "$BUILD_DIR/base.apk" | cut -f1)"
[ -f "$GEN_DIR/$APP_ID_PATH/R.java" ] || die "aapt2 link did not generate $GEN_DIR/$APP_ID_PATH/R.java"
info "generated $APP_ID_PATH/R.java"

# --------------------------------------------------------------------------- 5. javac

step "javac (java sources + generated R.java)"
find "$SRC_DIR" "$GEN_DIR" -name '*.java' -print > "$BUILD_DIR/sources.txt"
SRC_COUNT="$(wc -l < "$BUILD_DIR/sources.txt" | tr -d ' ')"
[ "$SRC_COUNT" -gt 0 ] || die "no .java sources found under $SRC_DIR"
JAVAC="${JAVAC:-javac}"
"$JAVAC" -encoding UTF-8 --release 17 -cp "$PLATFORM" -d "$CLASSES_DIR" "@$BUILD_DIR/sources.txt"
info "compiled $SRC_COUNT source file(s)"

# --------------------------------------------------------------------------- 6. d8

step "d8 (dex)"
CLASS_COUNT="$(find "$CLASSES_DIR" -name '*.class' | wc -l | tr -d ' ')"
[ "$CLASS_COUNT" -gt 0 ] || die "no .class files produced by javac"

D8_INPUTS=()
while IFS= read -r class_file; do
    D8_INPUTS[${#D8_INPUTS[@]}]="$class_file"
done < <(find "$CLASSES_DIR" -name '*.class')

"$BT/d8" --release --lib "$PLATFORM" --min-api "$MIN_SDK" --output "$DEX_DIR" "${D8_INPUTS[@]}"
[ -f "$DEX_DIR/classes.dex" ] || die "d8 did not produce classes.dex"
info "classes.dex: $(du -h "$DEX_DIR/classes.dex" | cut -f1)"

# --------------------------------------------------------------------------- 7. pack dex

step "Packing classes.dex into base.apk"
( cd "$DEX_DIR" && zip -q "$BUILD_DIR/base.apk" classes.dex )
info "apk now contains: $(unzip -l "$BUILD_DIR/base.apk" | tail -1 | awk '{print $2}') entr(ies)"

# --------------------------------------------------------------------------- 8. zipalign

step "zipalign"
"$BT/zipalign" -f -p 4 "$BUILD_DIR/base.apk" "$BUILD_DIR/aligned.apk"
info "aligned.apk: $(du -h "$BUILD_DIR/aligned.apk" | cut -f1)"

# --------------------------------------------------------------------------- 9. keystore

step "Signing keystore"
if [ -f "$KEYSTORE_FILE" ]; then
    info "reusing existing keystore (never regenerated): android/keystore/keep-accounts.jks"
else
    mkdir -p "$KEYSTORE_DIR"
    info "no keystore found - generating android/keystore/keep-accounts.jks"
    keytool -genkeypair -v \
        -keystore "$KEYSTORE_FILE" \
        -alias "$KEYSTORE_ALIAS" \
        -keyalg RSA \
        -keysize 2048 \
        -validity "$KEYSTORE_VALIDITY_DAYS" \
        -storetype PKCS12 \
        -storepass "$KEYSTORE_PASS" \
        -keypass "$KEYSTORE_PASS" \
        -dname "$KEYSTORE_DNAME"
    info "keystore created (alias=$KEYSTORE_ALIAS, validity=${KEYSTORE_VALIDITY_DAYS}d)"
fi

# --------------------------------------------------------------------------- 10. sign

step "apksigner sign -> dist/keep-accounts.apk"
mkdir -p "$DIST_DIR"
rm -f "$OUT_APK"
if ! "$BT/apksigner" sign \
        --ks "$KEYSTORE_FILE" \
        --ks-key-alias "$KEYSTORE_ALIAS" \
        --ks-pass "pass:$KEYSTORE_PASS" \
        --key-pass "pass:$KEYSTORE_PASS" \
        --v1-signing-enabled true \
        --v2-signing-enabled true \
        --v3-signing-enabled true \
        --out "$OUT_APK" \
        "$BUILD_DIR/aligned.apk"; then
    die "apksigner sign FAILED - no APK was produced"
fi
[ -f "$OUT_APK" ] || die "apksigner reported success but $OUT_APK does not exist"

# --------------------------------------------------------------------------- 11. verify

step "apksigner verify"
if ! "$BT/apksigner" verify --verbose --print-certs "$OUT_APK" > "$VERIFY_LOG" 2>&1; then
    cat "$VERIFY_LOG" >&2
    die "apksigner verify FAILED for $OUT_APK"
fi
cat "$VERIFY_LOG"

# --------------------------------------------------------------------------- 12. summary

SIZE_BYTES="$(wc -c < "$OUT_APK" | tr -d ' ')"
SIZE_HUMAN="$(du -h "$OUT_APK" | cut -f1)"
if have shasum; then
    SHA256="$(shasum -a 256 "$OUT_APK" | awk '{print $1}')"
else
    SHA256="$(openssl dgst -sha256 "$OUT_APK" | awk '{print $NF}')"
fi
FINGERPRINT="$(grep -m1 'certificate SHA-256 digest' "$VERIFY_LOG" | sed 's/.*digest: //')"

printf '\n============================================================\n'
printf ' BUILD OK\n'
printf '============================================================\n'
printf ' APK        : %s\n' "$OUT_APK"
printf ' Size       : %s (%s bytes)\n' "$SIZE_HUMAN" "$SIZE_BYTES"
printf ' SHA-256    : %s\n' "$SHA256"
printf ' Signer     : %s\n' "${FINGERPRINT:-see apksigner output above}"
printf ' UI assets  : %s file(s) in android/assets/ui\n' "$UI_FILE_COUNT"
printf ' SDK        : %s\n' "$SDK"
printf ' Install    : adb install -r %s\n' "${OUT_APK#$ROOT/}"
printf '============================================================\n'
