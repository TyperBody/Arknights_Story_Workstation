/**
 * `frontend/stage-demo.html` —— StagePane 的**截图专用**演示页。
 *
 * **仅供 `build/*.mjs` 截图 harness**（`build/stage-check.mjs`）；**不是应用路由**，
 * 也不在 `frontend/index.html` 的构建图里（它由独立的 Vite HTML 入口
 * `stage-demo.html` → `src/stageDemoMain.tsx` 载入）。
 *
 * 为什么不挂 `App.tsx` 的 `<Route>`：`StoryEditorPage` 用
 * `import.meta.glob`（= 动态 import）载入 `StagePane.tsx`；演示页若静态 import
 * 同一个组件、又和应用在同一张 bundle 图里，Vite 会报
 * `INEFFECTIVE_DYNAMIC_IMPORT`（动态 import 拆不出 chunk）。独立入口把两者分开。
 *
 * 真实挂载点是编辑器页（`StoryEditorPage.tsx` 的 `.ed-stage`）；这里把组件单独
 * 挂起来，方便在浏览器里量几何、拖动、切缩放档（不需要 Tauri）。
 *
 * 每个场景就是一段**真实脚本**（`[Background]` + `[Character]`/`[charslot]`），
 * 喂给 `stageModel.parseStage`，结果原样交给 `StagePane` —— 与编辑器页同一条链路。
 */
import { useEffect, useMemo, useState } from "react";
import StagePane, { type StagePaneProps } from "./components/editor/StagePane";
import {
  ensureBackgroundRules,
  ensureCharacterTable,
  getCharacterTable,
  type BackgroundRules,
  type CharacterTable,
  movePatch,
  parseStage,
} from "./components/editor/stageModel";

type Scene = "two" | "unknown" | "rules" | "nobg" | "split" | "empty";

interface SceneDef {
  /** 场景脚本（`\n` 分隔）。 */
  text: string;
  /** 叠加在抓到的 `background.json` 之上的 `patch/resolutionRules.json` 形态。 */
  rules?: BackgroundRules;
  /** 「复制这一行」用：脚本里那条 `[Character]`/`[charslot]` 的原文。 */
  line?: string;
}

const SCENES: Record<Scene, SceneDef> = {
  two: {
    text: [
      '[Background(image="bg_corridor", fadetime=0)]',
      '[Character(name="char_002_amiya_1", name2="char_130_doberm_ex", fadetime=0.5)]',
    ].join("\n"),
    line: '[Character(name="char_002_amiya_1", name2="char_130_doberm_ex", fadetime=0.5)]',
  },
  unknown: {
    text: [
      '[Background(image="bg_black", fadetime=0)]',
      '[Character(name="no_such_character#1$1", fadetime=0.5)]',
    ].join("\n"),
    line: '[Character(name="no_such_character#1$1", fadetime=0.5)]',
  },
  /**
   * 「换个背景立绘就飘」在**数据**上的可解释形态：包把站位写进
   * `patch/resolutionRules.json`，同一张立绘在 `bg_forest` 上与别处不同。
   */
  rules: {
    text: [
      '[Background(image="bg_forest", fadetime=0)]',
      '[Character(name="char_002_amiya_1", name2="char_130_doberm_ex", fadetime=0.5)]',
    ].join("\n"),
    line: '[Character(name="char_002_amiya_1", name2="char_130_doberm_ex", fadetime=0.5)]',
    rules: { bg_forest: { pos: { x: 60, y: -40 }, note: "森林这张地面更低" } },
  },
  /** 无背景（黑底）：**不能**渲染成 `src=""` 的空请求。 */
  nobg: {
    text: '[Character(name="char_130_doberm_ex", fadetime=0.5)]',
    line: '[Character(name="char_130_doberm_ex", fadetime=0.5)]',
  },
  /** `[Character(name=…)]` 只有 name → 引擎只摆 m 槽，l/r 一起被清。 */
  split: {
    text: [
      '[Background(image="bg_room_2", fadetime=0)]',
      '[Character(name="char_010_chen_1", fadetime=0.5)]',
      '[charslot(slot="m", name="char_empty", duration=0)]',
      '[Character(name="avg_npc_012", fadetime=0.5)]',
    ].join("\n"),
    line: '[Character(name="avg_npc_012", fadetime=0.5)]',
  },
  empty: { text: '[Background(image="bg_forest", fadetime=0)]' },
};

export default function StageDemoPage() {
  const [scene, setScene] = useState<Scene>("two");
  const [table, setTable] = useState<CharacterTable>(() => getCharacterTable());
  const [fetchedRules, setFetchedRules] = useState<BackgroundRules>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [move, setMove] = useState("");
  const [patch, setPatch] = useState("");

  useEffect(() => {
    let alive = true;
    void ensureCharacterTable().then((loaded) => {
      if (alive && loaded) setTable(loaded);
    });
    void ensureBackgroundRules().then((loaded) => {
      if (alive && loaded) setFetchedRules(loaded);
    });
    return () => {
      alive = false;
    };
  }, []);

  const rules = useMemo(
    () => ({ ...fetchedRules, ...(SCENES[scene].rules ?? {}) }),
    [fetchedRules, scene],
  );

  // 截图 harness 的锚点：把「场景脚本 + 规则」原样挂到 window 上，让
  // `build/stage-check.mjs` 用**同一份 stagingModel**在 Node 里算出期望几何，再与
  // 页面里真实渲染的坐标对拍（不是各算一套）。
  useEffect(() => {
    const target = window as unknown as { __stageDemo?: unknown };
    target.__stageDemo = {
      scene,
      scenes: Object.fromEntries(
        Object.entries(SCENES).map(([key, value]) => [key, { text: value.text, rules: value.rules ?? {} }]),
      ),
      rules: SCENES[scene].rules ?? {},
      tableKeys: Object.keys(table).length,
      rulesKeys: Object.keys(rules).length,
    };
  }, [rules, scene, table]);

  /** 与编辑器页同一条链路：脚本 → `parseStage` → `StagePane`。 */
  const snapshot = useMemo(
    () =>
      parseStage(SCENES[scene].text, Number.MAX_SAFE_INTEGER, {
        table,
        model: { characters: table, resolutionRules: rules },
        rules,
      }),
    [rules, scene, table],
  );

  const props: StagePaneProps = {
    chars: snapshot.chars,
    background: snapshot.background,
    height: 320,
    model: { characters: table, resolutionRules: rules },
    rules,
    line: SCENES[scene].line ?? null,
    selected,
    onSelect: (slot) => setSelected(slot),
    onMove: (slot, delta) => {
      const next = movePatch(slot, delta.x, delta.y, { line: SCENES[scene].line });
      setMove(`${slot} Δ ${delta.x},${delta.y} → ${next.note}`);
      document
        .querySelector("[data-stage-pane]")
        ?.setAttribute("data-stage-move", `${slot}:${delta.x},${delta.y}`);
    },
    onPatch: (next) => setPatch(next.line ?? next.slideLine),
  };

  return (
    <div style={{ padding: 12, background: "#0b0f14", minHeight: "100vh", color: "#dbe4ef", font: "12px/1.5 ui-monospace, monospace" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <button type="button" data-stage-scene="two" onClick={() => setScene("two")}>两立绘 + 背景</button>
        <button type="button" data-stage-scene="unknown" onClick={() => setScene("unknown")}>未知角色</button>
        <button type="button" data-stage-scene="rules" onClick={() => setScene("rules")}>背景规则</button>
        <button type="button" data-stage-scene="nobg" onClick={() => setScene("nobg")}>无背景</button>
        <button type="button" data-stage-scene="split" onClick={() => setScene("split")}>单槽清位</button>
        <button type="button" data-stage-scene="empty" onClick={() => setScene("empty")}>空舞台</button>
        <span style={{ marginLeft: "auto", color: "#8fa1b5" }}>
          character.json {Object.keys(table).length} 条 · background.json {Object.keys(fetchedRules).length} 条
        </span>
      </div>
      <StagePane {...props} />
      <pre data-stage-readout="1" style={{ marginTop: 8, color: "#9fe0a0", whiteSpace: "pre-wrap" }}>
        {`场景脚本：\n${SCENES[scene].text}\n`}
        {patch ? `补丁：${patch}\n` : ""}
        {move || "拖动立绘试试（pointerup 时给出补丁与增量）"}
      </pre>
    </div>
  );
}
