#!/usr/bin/env bash
# 纯离线打包补丁 zip：按 `<build/patch-*>/curated.json` 把已落盘文件打成 Release 附件。
# 零网络；只做 zip（`-j` 扁平 + `-X` 可复现 + `-9`）。素材先在本地/CI 用
# `npm run assets:patch:assets` / `assets:patch:audio` 备好。
#
#   scripts/fanfic/pack-patch.sh                 # assets + audio（缺的跳过）
#   scripts/fanfic/pack-patch.sh assets
#   scripts/fanfic/pack-patch.sh audio
set -euo pipefail
# `scripts/fanfic/` → 仓库根（上两级）。
cd "$(dirname "$0")/../.."
ROOT="$PWD"
KIND="${1:-both}"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)"
OUT_DIR="$ROOT/build/artifacts"
mkdir -p "$OUT_DIR"

pack_one() {
  local suffix="$1"
  local src="$ROOT/build/patch-$suffix"
  [ -f "$src/curated.json" ] || { echo "skip $suffix：缺 $src/curated.json"; return 0; }
  local out="$OUT_DIR/Arkstage-${VERSION}-assets-${suffix}.zip"
  node -e '
    const fs=require("fs");
    const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    fs.writeFileSync(process.argv[2], c.entries.map(e=>e.file).join("\n")+"\n");
    console.log("  files", c.entries.length, "bytes", (c.bytes/1048576).toFixed(1)+"MB");
  ' "$src/curated.json" "/tmp/patch-${suffix}-list.txt"
  rm -f "$out"
  # shellcheck disable=SC2046
  ( cd "$src" && zip -q -X -9 -j "$out" $(cat "/tmp/patch-${suffix}-list.txt") )
  ls -lh "$out"
}

case "$KIND" in
  assets) pack_one assets ;;
  audio)  pack_one audio ;;
  both)   pack_one assets; pack_one audio ;;
  *) echo "用法: scripts/fanfic/pack-patch.sh [assets|audio|both]" >&2; exit 2 ;;
esac
