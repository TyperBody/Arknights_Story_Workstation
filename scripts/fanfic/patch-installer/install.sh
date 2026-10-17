#!/bin/sh
# Arkstage 素材补丁安装器（Linux / macOS，自解压 .run 的**载荷**部分）。
#
# 用法：把本脚本与载荷 zip 拼在一起（见 `build-patch-installer.mjs`），
#   sh Arkstage-1.4.0-assets-assets-setup.run [--data-root <dir>]
#
# 行为（用户口径）：
#   1. 找 **Arkstage 本体**：`--data-root` → `$PRTS_DATA_DIR` → `config.json` 的
#      `data_root` → `~/.local/share/cn.aunly.arkstage` → 可执行文件同级目录；
#   2. 找不到本体 → 打印「没有找到 Arkstage 本体」并**退出 2**（不写任何文件）；
#   3. 找到 → 把载荷解到 `<root>/assets/starter/`（**只补缺失**，不覆盖已有）。
set -eu
KIND="__KIND__"
VERSION="__VERSION__"
SELF="$0"
PAYLOAD_OFFSET=__PAYLOAD_OFFSET__

DATA_ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --data-root) DATA_ROOT="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

config_root() {
  for c in "${XDG_CONFIG_HOME:-$HOME/.config}/cn.aunly.arkstage/config.json" \
           "$HOME/.config/cn.aunly.arkstage/config.json"; do
    [ -f "$c" ] || continue
    python3 - "$c" <<'PY' 2>/dev/null || true
import json,sys
try:
    d=json.load(open(sys.argv[1]))
    r=d.get("data_root") or d.get("dataRoot")
    print(r or "")
except Exception:
    pass
PY
    return 0
  done
}

if [ -z "$DATA_ROOT" ]; then DATA_ROOT="${PRTS_DATA_DIR:-}"; fi
if [ -z "$DATA_ROOT" ]; then DATA_ROOT="$(config_root)"; fi
if [ -z "$DATA_ROOT" ] && [ -d "$HOME/.local/share/cn.aunly.arkstage" ]; then
  DATA_ROOT="$HOME/.local/share/cn.aunly.arkstage"
fi
# 可执行文件同级目录（**便携版**：`Arkstage` 与 `resources/` 在一起）。
if [ -z "$DATA_ROOT" ]; then
  for candidate in "$(dirname "$SELF")/Arkstage" "$(dirname "$SELF")/resources"; do
    [ -e "$candidate" ] && { DATA_ROOT="$(dirname "$SELF")"; break; }
  done
fi

if [ -z "$DATA_ROOT" ] || [ ! -d "$DATA_ROOT" ]; then
  echo "✗ 没有找到 Arkstage 本体：请先安装 / 解压 Arkstage，或显式指定 --data-root <资源目录>。" >&2
  echo "  （本补丁只补素材：$KIND，$VERSION）" >&2
  exit 2
fi

DEST="$DATA_ROOT/assets/starter"
mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# ⚠️ 用**字节偏移**（`tail -c`）而不是行数：zip 是二进制，按行数会切歪
#  （实测 \$((lines+1)) 差了一个"行"→ zip 报 missing bytes / overlapped）。
tail -c +"$((PAYLOAD_OFFSET + 1))" "$SELF" > "$TMP/payload.zip"
echo "==> Arkstage 本体：$DATA_ROOT"
echo "==> 解压 $KIND 补丁 → $DEST（只补缺失，不覆盖已有）"
ADDED=0; KEPT=0
if command -v unzip >/dev/null 2>&1; then
  unzip -q -o "$TMP/payload.zip" -d "$TMP/unpack"
  for f in "$TMP"/unpack/*; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    if [ -e "$DEST/$name" ]; then KEPT=$((KEPT+1)); else cp "$f" "$DEST/$name"; ADDED=$((ADDED+1)); fi
  done
else
  echo "✗ 需要 unzip（apt install unzip / brew install unzip）" >&2; exit 3
fi
echo "✓ 完成：新增 $ADDED 个文件，已有 $KEPT 个保持不变。"
echo "  在应用「设置 → 缓存管理」里可看到随包素材数量。"
exit 0
