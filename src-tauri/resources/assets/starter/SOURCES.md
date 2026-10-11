# 起步素材集出处（bundled starter assets）

为了「自创剧情不必每次打开都联网下载」，安装包内置一批**常用**素材：
UI 小图 7 张 + 背景 120 张 + 立绘 160 张，合计 14.59 MB。
全部取自 PRTS Wiki 托管的《明日方舟》AVG 资源；版权归上海鹰角网络（Hypergryph）所有，
此处仅作离线播放/同人创作之用，遵循应用整体免责声明（仓库根 `README.md`）。

选择规则（确定性）：语料频次排序（来源：`/home/typer/桌面/.akresearch/akgd/zh_CN/gamedata/story`，5735 个脚本文件）；
背景 = `[Background(image=…)]` 频次降序，立绘 = `[Character|charslot(name=…)]` base 频次降序取首个可解析 image。
转码：背景 PNG → WebP q78、立绘 PNG → WebP q85（libwebp，含 alpha）；UI 小图保持 PNG。

重新生成 / 离线校验：

```bash
node scripts/fanfic/fetch-starter-assets.mjs            # 下载并转换（幂等）
node scripts/fanfic/fetch-starter-assets.mjs --check    # 离线：清单 ⇄ 磁盘 + 预算
```

清单：`curated.json`（含 bytes/sha256）+ `bundles.json`（canonical key → 文件名）。
