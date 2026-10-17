import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/snap/bin/chromium", args: ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu"] });
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
for (const [url, name] of [
  ["https://ak-ui.yyj.moe/components/ak-button.html", "btn"],
  ["https://ak-ui.yyj.moe/components/ak-card.html", "card"],
  ["https://ak-ui.yyj.moe/components/ak-tabs.html", "tabs"],
  ["https://ak-ui.yyj.moe/showcase/", "showcase"],
]) {
  await p.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch(()=>{});
  await p.waitForTimeout(1800);
  await p.screenshot({ path: `/tmp/akui-${name}.png`, fullPage: false });
  console.log("shot", name);
}
await b.close();
