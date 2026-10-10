---
name: arkstage-fanfic
description: Use when turning a fan-fiction article into a playable Arkstage story pack (script.txt DSL, PRTS-borrowed art, in-story Decision/Predicate branching, PRTS wikitext export).
---

# arkstage-fanfic：二创文章 → 方舟剧场可播剧本包

把一个（或一组）二创剧本转成 `<资源目录>/assets/library/<packId>/` 下的本地剧本包：
应用里像官方剧情一样在书架播放，同一份产物还能导出成 PRTS 可直接粘贴的
wikitext。**LLM 只做语义映射，格式合法性交给 `lint.mjs`。**

- 指令表与参数：`reference/commands.md`
- 分支契约（`Decision`/`Predicate` 纯语义、`maxStates`）：`reference/branching.md`
- 素材借用（PRTS 立绘/背景/CG/音频、OC 条目）：`reference/assets.md`
- 包/缓存/wikitext 的逐字段契约：`reference/package.md`
- **演出动效（fadetime/duration/`[End]` 的坑）：`reference/animation.md`**
- **可整段复制的演出预设：`templates/performance.md`**
- 实现（唯一真相）：`src/akstage/local/storyPack.js`、`src/akstage/local/library.js`

## 1. 触发条件

满足任一条即适用：

- 用户给一篇/多篇**明日方舟二创**（小说、剧本、对话体、分镜稿），要求
  「做成能播的剧情 / 放进方舟剧场 / 生成剧情包」；
- 要求把已有脚本转成 PRTS `{{剧情模拟器|…}}` 页面（wikitext 导出）；
- 要求给某个二创**加分叉选项**（`[Decision]`/`[Predicate]`）；
- 已有 `assets/library/<packId>/` 需要补 lint/打包/素材（OC 立绘、背景、音频）。

不适用：改引擎/前端（那是 arkstage 仓库本体）、把官方剧情拆成文本（用
`fetch-upstream.mjs`）。

## 2. 包结构（详见 `reference/package.md`）

```
$DATA_ROOT/assets/library/<packId>/   # packId = 目录名 = 路由 page_title = 文本路径
├── pack.json                        # 必填：{id,title,chapter,author,description,branchPoints}
├── script.txt                       # 必填：编译产物＝引擎直接播的文本（无 @tag）
├── source/{probe.txt,probe.plan.json}  # 作者脚本（@tag 控制位）+ 取景计划（编译输入）
├── patch/{characters,resolutionRules,story_variables}.json   # 可选：上游数据表增量
├── build/{runtime,assets,inspection,chapters,page.wikitext}  # 可选：hook/摘要/取景/分章/导出
├── assets/…                         # 可选：本地图片/字体副本（应用按 URL 走缓存，不读盘）
└── metadata.json                    # 可选：wikitext 的七个模板参数
```

`index.json`（由 `install-library.mjs` 写出，只在 Rust `list_library` 缺席的
回退路径上用）列出各包文件；`list_library` 上线时按目录直读、无需清单。

没有 `story.json`；包内 `manifest.json` 只是摘要（规范摘要 = `build/assets.json`）。

## 3. 硬约束清单（MUST，逐条可被 lint 检查）

**行语法**
1. 每行只能是 `[Cmd(...)]` / `[Cmd(...)]尾随文本` / `[name="X"]正文` / `正文`（旁白）
   / `// 注释` / 空行 / 行尾 `\` 续行。别的一律不算。
2. **对白只有一种写法**：`[name="X"]正文`（正则
   `^name\s*=\s*"((?:\\.|[^"])*)"$`）。不要写 `dialog`/`name2`/`[name=X]`。
3. `]` 后**不要留行尾空格**（正文的每个字符都会被渲染；编辑时开
   `trim trailing whitespace` 或让 lint 报 warning）。
4. 指令名大小写不敏感，**参数键大小写敏感**。`[Delay(1)]` 无效；
   **`delay` 必须写 `[Delay(time=1)]`**（`time` 缺键 → 0 秒；`TIME`/`times`
   只在官方语料里出现，二创别学）。
5. 只用 A 级指令；B 级要在 `metadata.json` 里声明；C 级默认禁用
   （分级见 `reference/commands.md`）。

**分支**
6. 形状固定：`[Decision(options="A;B;C", values="1;2;3")]` → 重开闸门
   `[Predicate(references="1;2;3")]`（可选但推荐）→ 每支一条
   `[Predicate(references="n")]` → **必须**以
   `[Predicate(references="全部 values")]` 合流。
7. 一部脚本 **≤ 8 个 `Decision`**，且 **∏ options ≤ 64**（超了会撞 LOG ALL 的
   `maxStates=1e4`，退化成「全量文本」——不影响播放，只丢分支标注）。超预算就**拆章**。
8. 每个分支片段**开头**用**引擎真正会动**的写法把本片段的立绘/会话状态
   重新落地：`[Character(name=…, fadetime=…)]`（首选）；需要按槽位站位才用
   `[charslot(slot=…, duration=…, isblock=true)]`；换场按
   `Blocker(黑) → Background(fadetime) → Character(fadetime) → Blocker(透明)`。
   片段里起的 loop 音效在合流前 `[StopSound(channel=…)]`。

**角色与素材**
9. 角色引用只有 `base`、`base#N`、`base$G`、`base#N$G`、`base@alias`
   （`#N` 组内序号、`$G` 组号，均 1 基；`@alias` 只在你确认 alias 拼写时用）。
   基名必须在角色表里（上游 `character.json` 或 `patch/characters.json`）。
10. 默认**借用 PRTS 现成素材**：背景写 `background.json` 的键、CG 写官方
    `images` 键、音频写 `$变量`（`story_variables.json`）。本地 art 只作 fallback
    （见 §6）。
11. patch 只写增量：条目级覆盖；条目内 `array`/`groups`/`pos`/`size` 缺省沿用上游；
    显式 `null` = 删除条目。别把整张上游表复制进 patch。

**收尾与产物**
12. 收尾：`[endtip(block=true)]`（推荐，显式零 warn）或
    `[Blocker(a=1, r=0, g=0, b=0, fadetime=1, block=true)]` 淡黑收束；
    **`[End]` 引擎不认**（允许表里只有 `endtip`）→ `unknown_command end`，
    观感是"最后一帧卡住"（细则见 `reference/branching.md` §3.0）。
13. `source/` 与编译产物分离：`source/script.txt` 保留 `[Cmd@tag(...)]` 控制位，
    **`script.txt` 是去掉 `@tag` + 行号偏移后的可播文本**（一次播放里每个决策
    片段只保留一份对白）。`node scripts/fanfic/pack.mjs <packDir>` 负责编译。
14. 交付前跑 `node scripts/fanfic/lint.mjs <packDir>`：`errors` 必须为空
    （warning 要么修，要么在报告里解释）；再导出 `build/page.wikitext`。

## 4. 标准步骤

1. **读文章 → 场景表**：地点/时间/在场角色/情绪节拍，标出作者写的「选项」。
   1 个场景 = 1 个 `[Background]` + 一组角色；1 个情绪节拍 = 克制地用
   `[Delay]`/`[CameraShake]`/`[Blocker]`（不要每句都加演出）。
2. **对白 → `[name="X"]` 行**；旁白写 `[Dialog]` 或裸行（`[Narration]` 需要
   版式时才用 `[Div]` 搭配）。
3. **选素材（借用优先）**：背景查 `background.json`
   （`https://torappu.prts.wiki/assets/avg/background.json`，1041 键）；立绘查
   `character.json` 的组号/表情；音频查 `story_variables.json`。选不到就走 §6。
4. **写 `source/script.txt`**（`@tag` 控制位）+ `pack.json`
   + `source/probe.plan.json`（tag ↔ 片段）。样例结构见 `example/fanfic/demo/`。
5. **补 `patch/characters.json`**（只给上游没有的角色/差分：OC 用「本地图 base +
   合成条目」；`pos`/`size` 按引擎几何（`rect = 贴图尺寸 / ppu * 100`，
   见 `reference/assets.md` §5）给出，必要时用 `probe.mjs` 复核）。
6. **编译**：`node scripts/fanfic/pack.mjs <packDir>`（先
   `node scripts/fanfic/fetch-upstream.mjs` 取上游 bundle，产出
   `script.txt` + `build/runtime.json` + `build/assets.json`）。
   取景/逐段校验需要时先跑 `probe.mjs`（见 `reference/package.md` §5）。
7. **lint**：`node scripts/fanfic/lint.mjs <packDir>`（`--json` 出报告）；
   `errors` 清零才算过。
8. **verify**：`npm run build`（应用侧编译）→ 把包放进
   `$DATA_ROOT/assets/library/<packId>/`（或 `install-library.mjs`）→ 书架「同人剧场」出现 → 播放 → 断网复播 →
   多分支逐条选一遍确认合流一致（可用
   `node scripts/fanfic/verify-pack.mjs --library example/library --choice 0|1`）
   → 导出 `build/page.wikitext` 贴 PRTS 沙盒。

**自动播放/取景约定**（工具链，不影响引擎语义）：`SPEED_PROFILE` 取
`fast` / `normal` / `slow`；`SEQ_DELAY` 是段间等待基线。`fast` = 每个
SessionStart 立刻 POST 并跳到下一段（重复条目用于对拍）；`normal` = 按上游
`duration` 等待；`slow` = 只走 `Delay`/`Dialog`/`PlaySound`/`StopSound`。
`source/probe.plan.json` 里的 `tag` 是这套流程的锚点；<8 段可用
`[Subtitle(text="@chunk:N")]` 精确跳转，≥8 段用带日期的 `source/facts.md`
做文本搜索定位。

## 5. 最小可用示例（21 行，全部素材键均可在上游表/语料中查到）

用**换场四步**（黑场 → 背景 → 立绘 → 淡出黑场）与 `[endtip]` 收尾，
可以照抄成新包的骨架；`[name="…"]` 的说话人与素材键取自官方
`obt/main/level_main_00-01_beg.txt` / 上游数据表：

```
[HEADER(key="title_test", is_skippable=true, fit_mode="BLACK_MASK")]
[Blocker(a=1, r=0, g=0, b=0, fadetime=0.5, block=true)]
[Background(image="bg_cher_1", x=0, y=20, xScale=1.1, yScale=1.1, fadetime=1, block=true)]
[PlayMusic(intro="$escape_intro", key="$escape_loop", volume=0.8, crossfade=1.5, delay=0.5)]
[Character(name="char_130_doberm_ex", fadetime=0.6)]
[Blocker(a=0, r=0, g=0, b=0, fadetime=0.6, block=true)]
[name="杜宾"]  你来了。
[Delay(time=0.5)]
[Decision(options="先听她说完;先问阿米娅", values="1;2")]
[Predicate(references="1")]
[Character(name="char_130_doberm_ex", fadetime=0.3)]
[name="杜宾"]  这里不安全，边走边说。
[Predicate(references="2")]
[Character(name="char_002_amiya_1#1", fadetime=0.3)]
[name="阿米娅"]  博士，我在这里。
[Predicate(references="1;2")]
[Character(name="char_130_doberm_ex", fadetime=0.3)]
[name="杜宾"]  走吧。
[StopMusic(fadetime=1)]
[Blocker(a=1, r=0, g=0, b=0, fadetime=1, block=true)]
```

（想显式写收尾指令就把最后一行换成 `[endtip(block=true)]`；两者都零 warn。）

素材核对（每条都能在仓库研究资料里查到）：

| 键 | 上游位置 | 解析结果 |
|---|---|---|
| `bg_cher_1` | `background.json`（ppu 68.24644470214844） | `https://torappu.prts.wiki/assets/avg/background/bg_cher_1.png` |
| `char_130_doberm_ex` | `character.json`（5 档差分） | `…/assets/avg/characters/char_130_doberm_ex/char_130_doberm_ex.png` |
| `char_002_amiya_1#1` | `character.json`（`array[0]`=`char_002_amiya_1`） | `…/characters/char_002_amiya_1/char_002_amiya_1.png` |
| `$escape_intro` / `$escape_loop` | `story_variables.json` → `Sound_Beta_2/Music/beta2_180603/m_dia_escape_*` | `…/assets/audio/music/beta2_180603/m_dia_escape_loop.mp3` |

对应的 `source/script.txt`（控制位；`pack.mjs` 编译时去掉 `@tag`）：

```
[HEADER@open(key="title_test", is_skippable=true, fit_mode="BLACK_MASK")]
[Blocker@fadein(a=1, r=0, g=0, b=0, fadetime=0.5, block=true)]
[Background@open(image="bg_cher_1", x=0, y=20, xScale=1.1, yScale=1.1, fadetime=1, block=true)]
[Character@arrive(name="char_130_doberm_ex", fadetime=0.6)]
[Decision@pick(options="先听她说完;先问阿米娅", values="1;2")]
[Character@branchA(name="char_130_doberm_ex", fadetime=0.3)]
[Character@branchB(name="char_002_amiya_1#1", fadetime=0.3)]
[Character@resolve(name="char_130_doberm_ex", fadetime=0.3)]
[Blocker@fadeout(a=1, r=0, g=0, b=0, fadetime=1, block=true)]
```

`probe.mjs` 只认 `source/probe.txt`；把上面这份存成 `source/probe.txt`、
并在 `source/probe.plan.json` 里登记 `open/pick/arrive/branchA/branchB/resolve`
各 tag。**控制位以外的行（对白、`Delay`、`Predicate`、收尾）与上面的
`script.txt` 逐字相同**，区别只是这些被登记的指令行写成了
`[Cmd@tag(...)]`（`pack.mjs` 编译时去掉 `@tag`）。真实样例：
`example/library/fanfic-demo/source/probe.txt` + `probe.plan.json`。

`pack.json`：

```json
{ "id": "fanfic-demo", "title": "同人样例：初次见面", "chapter": "同人剧场",
  "author": "demo", "description": "两分支小脚本", "branchPoints": ["pick"] }
```

## 6. 上游没有这个背景/立绘怎么办（fallback 顺序）

1. **换近似键**：通用背景优先（`bg_black`／`bg_corridor`／`bg_room_2`／
   `bg_forest`…，见 `reference/assets.md` §2）；立绘优先选同角色**别的组**
   （`$G`/`#N`）或 NPC 通用体（`avg_npc_*`）。
2. **换演出**：用 `[Blocker]` 纯色 + `[Subtitle]`/`[Sticker]` 交代环境；
   回忆/失神用 `[cameraEffect(effect="Grayscale")]` + `[focusout]`。
3. **自备本地图**：放 `assets/`，引用写带点的假 host
   `https://local.arkstage.invalid/art/x.png`（`library.js::localHosts()` 会把它
   并进 `assetDomains`，离线命中 `$DATA_ROOT/media/…`）。**别用 `file://`/`data:`**。
4. **OC / 机设角色**：本地图作 base + 写一条**合成 `patch/characters.json` 条目**
   （`array` 里一项=一档差分，`image` 指本地 URL；`pos`/`size` 按引擎
   几何 `rect = 贴图尺寸 / ppu * 100` 给出）。样例条目见
   `reference/assets.md` §5。
5. 借用+自备可以混用；只要 `[Image]`/立绘 URL 能返回 PNG，引擎不关心来源域。

## 7. 产出（Definition of Done）


- [ ] `pack.json` 的 `id` == 目录名 == wikitext 的 `文本路径`；
- [ ] `node scripts/fanfic/lint.mjs <packDir>` 无 error（报告形状见
      `reference/package.md` §9）；
- [ ] `script.txt` 无 `@tag` 残留、**有收尾**（`[endtip(block=true)]` 或
      `[Blocker(a=1, …)]`；`[End]` 会 warn）、分支全部合流；
- [ ] `build/runtime.json` 三个 sidecar 形状正确；patch 合并不误删；
- [ ] `build/page.wikitext` = `{{剧情模拟器|图片数据=…|角色数据=…|音频数据=…|文本路径=…|剧情类型=…|剧情分组=…|文本数据=…}}`
      （自备素材换成自己的表；`文本数据` 后是脚本正文）；
- [ ] 书架可见（`list_library` 或 `assets/library/index.json` 回退）、可播、断网可播；
- [ ] 报告里给出：lint 结论、用到的上游素材清单、fallback 及原因。
