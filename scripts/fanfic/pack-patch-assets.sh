#!/usr/bin/env bash
# 纯离线打包：按 `build/patch-assets/curated.json` 把已落盘文件打成 Release 附件的 zip。
# 零网络；秒级（≈190 MB）。
set -euo pipefail
# `scripts/fanfic/` → 仓库根（上两级）。
cd "$(dirname "$0")/../.."
ROOT="$PWD"
SRC="$ROOT/build/patch-assets"
OUT="$ROOT/build/artifacts/Arkstage-1.3.0-assets-assets.zip"
[ -f "$SRC/curated.json" ] || { echo "缺少 $SRC/curated.json"; exit 1; }

node -e '
const fs=require("fs");
const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
fs.writeFileSync("/tmp/pa-list.txt", c.entries.map(e=>e.file).join("\n")+"\n");
console.log("files", c.entries.length, "bytes", (c.bytes/1048576).toFixed(1)+"MB");
' "$SRC/curated.json"

rm -f "$OUT"
( cd "$SRC" && zip -q -X -9 -j "$OUT" $(cat /tmp/pa-list.txt) )
ls -lh "$OUT"
