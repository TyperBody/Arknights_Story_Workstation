# 起步素材集出处（bundled starter assets）

为了「自创剧情不必每次打开都联网下载」，安装包内置一批**常用**素材：
UI 小图 7 张 + 背景 893 张 + 立绘 1747 张（覆盖 1747 个角色 base 的全差分），合计 230.25 MB。
全部取自 PRTS Wiki 托管的《明日方舟》AVG 资源；版权归上海鹰角网络（Hypergryph）所有，
此处仅作离线播放/同人创作之用，遵循应用整体免责声明（仓库根 `README.md`）。

选择规则（确定性）：背景 = `backgroundPaths` 全量、按语料 `[Background(image=…)]` 频次降序（来源：`/home/typer/桌面/.akresearch/akgd/zh_CN/gamedata/story`，5735 个脚本文件）；
立绘 = `[Character|charslot(name=…)]` base 频次降序，**逐 base 收全差分**（`character.json` 的 `array[].image` / `face`）。
转码：背景 PNG → WebP q88、立绘 PNG → WebP q90（libwebp，含 alpha）；UI 小图保持 PNG。
预算：1000.00 MB（`--budget=…` 可调）；超出即跳过并继续找更小的条目。

重新生成 / 离线校验：

```bash
node scripts/fanfic/fetch-starter-assets.mjs             # 下载并转换（幂等）
node scripts/fanfic/fetch-starter-assets.mjs --plan      # 只看清单与预估体积
node scripts/fanfic/fetch-starter-assets.mjs --check    # 离线：清单 ⇄ 磁盘 + 预算
```

清单：`curated.json`（含 bytes/sha256）+ `bundles.json`（canonical key → 文件名）。
