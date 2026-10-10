# 内置样例素材出处（bundled sample assets）

方舟剧场内置的二创样例包（`sample-fanfic`）**自带**这 8 份素材，断网首启即可播放。
全部取自 PRTS Wiki 托管的《明日方舟》AVG 资源；版权归上海鹰角网络（Hypergryph）所有，
此处仅作离线演示与同人创作示例，遵循应用的整体免责声明（见仓库根 `README.md`）。

下载/转换脚本：`node scripts/fanfic/fetch-sample-assets.mjs`（`--check` 离线校验本表的字节数与 sha256）。
转换：PNG → WebP（libwebp，q80 背景 / q88 立绘）；合计 381916 B（373.0 KiB ≤ 1.5 MiB 预算）。

| # | 用途 | canonical key | 上游 PNG | 文件 | 字节 | sha256 |
|---|---|---|---|---|---|---|
| 1 | 背景 | `torappu.prts.wiki/assets/avg/background/bg_black.png` | https://torappu.prts.wiki/assets/avg/background/bg_black.png | `assets/bg_black.webp` | 1110 | `832a510128bb2c84c76de02710fbe7e4e40836e7613b8589c814060687e46164` |
| 2 | 背景 | `torappu.prts.wiki/assets/avg/background/bg_room_2.png` | https://torappu.prts.wiki/assets/avg/background/bg_room_2.png | `assets/bg_room_2.webp` | 18590 | `93db15257bb56fb5a7da33920935abb2d4c0cda1dfe4eb7d04c828093625d290` |
| 3 | 背景 | `torappu.prts.wiki/assets/avg/background/bg_forest.png` | https://torappu.prts.wiki/assets/avg/background/bg_forest.png | `assets/bg_forest.webp` | 68156 | `4710dac31bf38b5eb8b95c839aaf6cca366f548309ba4c9d6d2c0d50291a6fb0` |
| 4 | 背景 | `torappu.prts.wiki/assets/avg/background/bg_rhodeslounge_2.png` | https://torappu.prts.wiki/assets/avg/background/bg_rhodeslounge_2.png | `assets/bg_rhodeslounge_2.webp` | 65576 | `8c7e99d29c3ddff00a68bea4d456576874483dad765e0ae51144b5a3e74d1597` |
| 5 | 立绘 | `torappu.prts.wiki/assets/avg/characters/char_002_amiya_1/char_002_amiya_1.png` | https://torappu.prts.wiki/assets/avg/characters/char_002_amiya_1/char_002_amiya_1.png | `assets/char_002_amiya_1.webp` | 60884 | `d520c9266ab908a2268344229325fe4c6e82dec17213928f95945c556cb60623` |
| 6 | 立绘 | `torappu.prts.wiki/assets/avg/characters/char_002_amiya_1/char_002_amiya_3.png` | https://torappu.prts.wiki/assets/avg/characters/char_002_amiya_1/char_002_amiya_3.png | `assets/char_002_amiya_3.webp` | 60912 | `840b2d990dc93832846755e6afc4f6e3e961e35b77a79abe1aa1bbc41f83bcc7` |
| 7 | 立绘 | `torappu.prts.wiki/assets/avg/characters/char_130_doberm_ex/char_130_doberm_ex.png` | https://torappu.prts.wiki/assets/avg/characters/char_130_doberm_ex/char_130_doberm_ex.png | `assets/char_130_doberm_ex.webp` | 35972 | `7cdb5bdc80f5ea867478f1fdfee283f1681292365b7adf20daf3b77e54dfa0d5` |
| 8 | 立绘 | `torappu.prts.wiki/assets/avg/characters/char_010_chen_1/char_010_chen_1.png` | https://torappu.prts.wiki/assets/avg/characters/char_010_chen_1/char_010_chen_1.png | `assets/char_010_chen_1.webp` | 70716 | `5e475dbd1d6d72032de8804984803854a468522e94144b457b102f441d950dd0` |

键取自引擎已知的表：背景键来自 `assets/avg/background.json`，立绘键是
`assets/avg/character.json` 中 `array[].image`（形如 `char_xxx/char_xxx`）。
映射表：包内 `src-tauri/resources/library/sample-fanfic/build/assets.local.json`
（canonical key → 包内相对路径，应用侧 `pack_asset_path`）与本目录的
`bundles.json`（canonical key → 文件名，`prts-cdn://` 协议的内置兜底层）。
