#!/usr/bin/env bash
#
# Cross-build a PORTABLE Windows build FROM Linux — a standalone .exe that runs
# without installation (just unzip and double-click). Great for quick testing.
#
# How it differs from build-windows.sh:
#   - No installer. We build with `--no-bundle` (skips NSIS/MSI), so this needs
#     only the MinGW toolchain — no NSIS, no nsis_tauri_utils.dll download.
#   - Output is the raw self-contained exe. Rust's windows-gnu target statically
#     links the MinGW runtime, so the exe stands alone. The only external need is
#     the Microsoft Edge WebView2 runtime, which is preinstalled on Win10/11.
#
# Caveats (same as build-windows.sh):
#   - GNU ABI (not MSVC). Runs on Windows; for the "official" artifact use the
#     windows-latest CI workflow. The exe is unsigned (SmartScreen may warn).
#
# Output: build/artifacts/Arkstage_<version>_windows_x64-portable.zip
# （内含 `Arkstage.exe` + `WebView2Loader.dll` + `resources/assets/**`）。
# 目录：build/artifacts/arkstage-win-portable/。跨编译缓存默认删（KEEP_TARGET=1 保留，
# 也复用 `desktop-build.sh windows` 的 `CARGO_TARGET_DIR` —— 两者**同一目录**才好复用）。
#
# Usage: scripts/build-windows-portable.sh   [KEEP_TARGET=1 scripts/build-windows-portable.sh]
set -euo pipefail
cd "$(dirname "$0")/.."

SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"

ARTIFACTS_DIR="build/artifacts"
OUT="$ARTIFACTS_DIR/arkstage-win-portable"
# ⚠️ 与 `desktop-build.sh windows` 用**同一个** CARGO_TARGET_DIR：这样"先出 NSIS、
# 再打便携包"能复用同一份产物（否则 cargo 会把整个 Windows 依赖图重编一遍，实测 +76 min）。
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/build/toolchain/target-win}"
TRIPLE_DIR="$CARGO_TARGET_DIR/x86_64-pc-windows-gnu"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)"
PORTABLE_ZIP="$ARTIFACTS_DIR/Arkstage_${VERSION}_windows_x64-portable.zip"

# --- Pre-build cleanup: start from a clean slate so a stale/partial previous build
# can't leak into this one. Removes prior products and (unless KEEP_TARGET=1) the
# cross-compile cache. ---
echo "==> Cleaning stale build products before building"
echo "==> Pre-build cleanup"
scripts/clean.sh --junk
mkdir -p "$ARTIFACTS_DIR"
rm -rf "$OUT" "$PORTABLE_ZIP"
if [ "${KEEP_TARGET:-0}" = "1" ]; then
  echo "    KEEP_TARGET=1; keeping cross-compile cache at $TRIPLE_DIR (faster rebuilds)"
else
  rm -rf "$TRIPLE_DIR"
fi

echo "==> Checking host tools (mingw-w64)"
if ! command -v x86_64-w64-mingw32-gcc >/dev/null; then
  if command -v apt-get >/dev/null; then
    echo "    installing: mingw-w64"
    $SUDO apt-get update -qq
    $SUDO apt-get install -y mingw-w64
  else
    echo "ERROR: missing mingw-w64 and no apt-get to install it." >&2
    exit 2
  fi
fi

echo "==> Ensuring Rust target x86_64-pc-windows-gnu"
"${CARGO_HOME:-$HOME/.cargo}/bin/rustup" target add x86_64-pc-windows-gnu \
  || rustup target add x86_64-pc-windows-gnu

echo "==> Building portable exe (--no-bundle: compile only, no installer)"
# Release build: on-screen debug console OFF by default (users can enable it in
# Settings) — matches build-android.sh RELEASE=1. Override with VITE_DEBUG_DEFAULT=true.
export VITE_DEBUG_DEFAULT="${VITE_DEBUG_DEFAULT:-false}"
npm run tauri:build -- --target x86_64-pc-windows-gnu --no-bundle

REL_DIR="$TRIPLE_DIR/release"
# The main binary (exclude build-script/dep exes, which live in subdirs anyway).
exe="$(find "$REL_DIR" -maxdepth 1 -name '*.exe' | head -1 || true)"
if [ -z "$exe" ]; then
  echo "ERROR: no .exe produced under $REL_DIR" >&2
  exit 1
fi
echo "==> Built: $exe"

# Assemble the portable folder: the exe (renamed to the product name) + any
# runtime DLLs Tauri may have emitted next to it (e.g. WebView2Loader.dll).
rm -rf "$OUT" "$OUT.zip"
mkdir -p "$OUT"
cp -f "$exe" "$OUT/Arkstage.exe"
find "$REL_DIR" -maxdepth 1 -name '*.dll' -exec cp -f {} "$OUT/" \;

# 随包资源（starter 素材等）：`tauri.conf.json::bundle.resources` 在**打包**时才拷，
# `--no-bundle` 不会。便携版必须自己带上，否则「自创剧情不用联网」就失效了。
if [ -d src-tauri/resources/assets ]; then
  echo "==> Shipping bundled resources (starter assets)"
  mkdir -p "$OUT/resources"
  cp -R src-tauri/resources/assets "$OUT/resources/"
  echo "    $(find "$OUT/resources" -type f | wc -l) file(s), $(du -sh "$OUT/resources" | cut -f1)"
fi

# Zip it for easy transfer (zip if available, else leave the folder). Zip from
# inside artifacts/ so the archive root is a single `arkstage-portable/` folder
# rather than the nested `build/artifacts/arkstage-portable/` path.
if command -v zip >/dev/null; then
  ( cd "$ARTIFACTS_DIR" && rm -f "$(basename "$PORTABLE_ZIP")" "$(basename "$OUT").zip" \
      && zip -rq "$(basename "$PORTABLE_ZIP")" "$(basename "$OUT")" )
fi

# Clean the heavy intermediate cross-compile target dir (KEEP_TARGET=1 to keep).
if [ "${KEEP_TARGET:-0}" = "1" ]; then
  echo "==> KEEP_TARGET=1 set; keeping $TRIPLE_DIR"
else
  echo "==> Cleaning intermediate build products ($TRIPLE_DIR)"
  rm -rf "$TRIPLE_DIR"
fi

echo
echo "==> Post-build cleanup"
scripts/clean.sh --junk
echo "==> Done. Portable build in $ARTIFACTS_DIR:"
ls -lh "$OUT"/ 2>/dev/null
[ -f "$PORTABLE_ZIP" ] && ls -lh "$PORTABLE_ZIP"
