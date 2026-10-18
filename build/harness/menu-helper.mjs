/**
 * 菜单栏 helper（harness 共用）。
 *
 * 编辑器工具栏在 2026-10-19 改成了**文本菜单**（Blender 口径：文字 + 小三角，
 * 条目在弹出面板里；用户原话「菜单栏不要选择按钮式 要文本式」）。**旧选择器仍然
 * 命中**（条目保留 `.ed-btn`），但默认是收起的 —— 要"点条目"得先把**它所在的那个**
 * 菜单展开（**只展开一个**：全展开的话，右边的弹出面板会盖住左边的条目，
 * Playwright 的命中测试就会一直重试到超时）。
 *
 *   await openMenu(page, "分支图");        // 只展开含该条目的菜单
 *   await clickMenuItem(page, "分支图");    // 展开 + JS 点击（不做命中测试）
 *   await openAllMenus(page);             // 全部展开（只用于"读所有菜单文案"）
 */

/** 全部展开（`_i18n-ui-check` 读文案用；**别**在这之后做命中测试点击）。 */
export async function openAllMenus(page) {
  return page.evaluate(() => {
    document.querySelectorAll(".ed-menu").forEach((menu) => {
      menu.classList.add("is-open");
      menu.querySelector(".ed-menu-trigger")?.setAttribute("aria-expanded", "true");
      menu.querySelector(".ed-menu-pop")?.removeAttribute("hidden");
    });
    return document.querySelectorAll(".ed-menu-pop .ed-btn").length;
  });
}

/** 只展开**含 `text` 条目**的那一个菜单，其余收起。返回是否找到。 */
export async function openMenu(page, text) {
  return page.evaluate((want) => {
    const menus = [...document.querySelectorAll(".ed-menu")];
    const owner = menus.find((menu) =>
      [...menu.querySelectorAll(".ed-menu-pop .ed-btn")].some((el) =>
        (el.textContent ?? "").includes(want)
      )
    );
    menus.forEach((menu) => {
      const open = menu === owner;
      menu.classList.toggle("is-open", open);
      menu.querySelector(".ed-menu-trigger")?.setAttribute("aria-expanded", String(open));
      const pop = menu.querySelector(".ed-menu-pop");
      if (!pop) return;
      if (open) pop.removeAttribute("hidden");
      else pop.setAttribute("hidden", "");
    });
    return Boolean(owner);
  }, text);
}

/** 展开 + **JS 点击**该条目（不走命中测试，避免和浮层打架）。 */
export async function clickMenuItem(page, text) {
  const found = await openMenu(page, text);
  if (!found) return false;
  return page.evaluate((want) => {
    const items = [...document.querySelectorAll(".ed-menu-pop .ed-btn")];
    const hit = items.find((el) => (el.textContent ?? "").trim().includes(want));
    if (!hit) return false;
    hit.click();
    return true;
  }, text);
}

/** 第一条 `text` 命中的条目所在**菜单**（收起）——留给"点完再看状态"的断言。 */
export async function closeMenus(page) {
  return page.evaluate(() => {
    document.querySelectorAll(".ed-menu").forEach((menu) => {
      menu.classList.remove("is-open");
      menu.querySelector(".ed-menu-trigger")?.setAttribute("aria-expanded", "false");
      menu.querySelector(".ed-menu-pop")?.setAttribute("hidden", "");
    });
  });
}
