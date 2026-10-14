import { chromium } from "playwright-core";
const SCRIPT=[
 '[HEADER(key="fanfic_demo", fit_mode="BLACK_MASK")]',
 '[Background(image="bg_corridor", fadetime=0)]',
 '[Character(name="char_002_amiya_1", fadetime=0.5)]',
 '[Character(name="char_130_doberm_ex", fadetime=0.5)]',
 '[name="阿米娅"]  这边走，博士。',
].join("\n");
const b=await chromium.launch({executablePath:"/snap/bin/chromium",args:["--no-sandbox","--disable-dev-shm-usage"]});
const p=await b.newPage({viewport:{width:1500,height:950}});
await p.goto(`http://localhost:5174/editor/demo?text=${encodeURIComponent(SCRIPT)}`,{waitUntil:"networkidle"});
await p.addStyleTag({content:".bookshelf-sync-warning{display:none!important}"}).catch(()=>{});
await p.waitForTimeout(4000);
// 光标放到角色行，让舞台有内容
await p.click(".ed-textarea");
for (let i=0;i<3;i++) await p.keyboard.press("ArrowDown");
await p.waitForTimeout(1500);
for (const [tag, times] of [["100",0],["150",5]]) {
  if (times) for (let i=0;i<times;i++) await p.locator('[data-stage-action="zoom-in"]').click();
  await p.waitForTimeout(350);
  const box=await p.locator('[data-stage-frame="1"]').boundingBox();
  await p.screenshot({path:`build/harness/shots/stage-${tag}-fixed.png`, clip: box});
  const info=await p.evaluate(()=>{
    const svg=document.querySelector('[data-stage-svg="1"]');
    const clip=document.querySelector('#ark-stage-clip-rect');
    const bg=document.querySelector('[data-stage-background]');
    const bb=(el)=>{if(!el)return null;const b=el.getBoundingClientRect();return `${Math.round(b.width)}x${Math.round(b.height)} AR ${(b.width/b.height).toFixed(3)}`;};
    return { viewBox:svg?.getAttribute("viewBox"), clipRect:clip?`${clip.getAttribute("x")},${clip.getAttribute("y")},${clip.getAttribute("width")},${clip.getAttribute("height")}`:null, bgScreen:bb(bg), fill:document.querySelector('[data-stage-pane]')?.getAttribute("data-stage-fill") };
  });
  console.log(tag, JSON.stringify(info));
}
await b.close();
