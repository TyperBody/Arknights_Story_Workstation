#!/usr/bin/env bash
#
# 本机（无 root 依赖）桌面端编译：Linux deb/rpm/tar.gz + Windows(NSIS) 交叉编译。
# Rust 工具链走**项目内**目录 build/toolchain/（rustup-init 安装，不碰系统），
# 依赖装在 build/toolchain/target（已在 /build/ 的 gitignore 里）。
#
#   scripts/desktop-build.sh linux      # deb + rpm + tar.gz
#   scripts/desktop-build.sh windows    # x86_64-pc-windows-gnu → NSIS setup.exe
#   scripts/desktop-build.sh all
#
# 系统依赖（一次性，需 root）：
#   apt-get install -y librsvg2-dev libxdo-dev nsis mingw-w64
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-linux}"
ROOT="$PWD"
export CARGO_HOME="$ROOT/build/toolchain/cargo"
export RUSTUP_HOME="$ROOT/build/toolchain/rustup"
export PATH="$CARGO_HOME/bin:$PATH"
export VITE_DEBUG_DEFAULT="${VITE_DEBUG_DEFAULT:-false}"

if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
  echo "==> 安装项目内 Rust 工具链（rustup --no-modify-path）"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh
  sh /tmp/rustup-init.sh -y --no-modify-path --profile minimal --default-toolchain stable
fi

mkdir -p build/artifacts

build_linux() {
  echo "==> Linux：deb + rpm"
  export CARGO_TARGET_DIR="$ROOT/build/toolchain/target-linux"
  npm run tauri:build -- --bundles deb,rpm
  # 注意：CARGO_TARGET_DIR 指向 build/toolchain/，产物**不在** src-tauri/target/
  # （旧脚本拷的是后者 → 只会静默 `|| true` 掉，`build/artifacts/` 里留下上一版）。
  cp -f "$CARGO_TARGET_DIR"/release/bundle/deb/*.deb "$CARGO_TARGET_DIR"/release/bundle/rpm/*.rpm build/artifacts/ 2>/dev/null || true
  echo "==> Linux：tar.gz（绿色版）"
  ( cd "$CARGO_TARGET_DIR/release" && tar czf "$ROOT/build/artifacts/Arkstage-linux-$(uname -m).tar.gz" app )
}

build_windows() {
  echo "==> Windows：x86_64-pc-windows-gnu（NSIS setup.exe）"
  "$CARGO_HOME/bin/rustup" target add x86_64-pc-windows-gnu
  export CARGO_TARGET_DIR="$ROOT/build/toolchain/target-win"
  npm run tauri:build -- --target x86_64-pc-windows-gnu
  cp -f "$CARGO_TARGET_DIR/x86_64-pc-windows-gnu/release/bundle/nsis/"*-setup.exe build/artifacts/
}

case "$TARGET" in
  linux) build_linux ;;
  windows) build_windows ;;
  all) build_linux; build_windows ;;
  *) echo "用法: scripts/desktop-build.sh [linux|windows|all]" >&2; exit 2 ;;
esac

echo "==> 产物："
ls -lh build/artifacts/ 2>/dev/null | tail -n +2
