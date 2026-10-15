/**
 * 根语言文件（简体中文 = **参考语言**）。
 *
 * 拆分照 LangBot `web/src/i18n/locales/zh-Hans.ts`：
 * ```
 * import editor from "./editor/zh-Hans.ts";
 * const zhHans = { common, editor };
 * export default zhHans;
 * ```
 * 命名空间按目录拆分（`locales/editor/`），语言按文件拆分
 * （`locales/editor/zh-Hans.ts` ↔ `locales/editor/en-US.ts`）。
 * 键集合一致性由 `frontend/scripts/check-i18n.mjs` 校验。
 */
import editor from "./editor/zh-Hans.ts";

const zhHans = {
  common: {
    appName: "方舟剧场",
    language: "语言",
    languageHint: "界面与编辑器文案的语言；立即生效，保存在本机。",
  },
  fanfic: {
    count: "已安装 {{count}} 个剧本包",
  },
  editor,
};

export default zhHans;
