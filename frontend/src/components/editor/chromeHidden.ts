/**
 * `chromeHidden` —— 面板 chrome 的折叠判定（从 `PanelChrome.tsx` 拆出，
 * 满足 `react-refresh/only-export-components`：那个文件只导出组件）。
 *
 * `chrome.visible === false` → 内容区加 `hidden`（**只切显示、不卸载 DOM**）：
 * 这就是用户说的「这是显示不显示，也不是独立窗口」的语义。
 */
import type { PanelChromeProps } from "./inspectorWindow";

/** 要不要给内容区加 `hidden`（`true` = 受控折叠）。 */
export const chromeHidden = (chrome?: Partial<PanelChromeProps>): boolean => chrome?.visible === false;

export default chromeHidden;
