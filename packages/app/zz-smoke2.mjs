import { chromium } from "playwright";
const base = process.env.BASE;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let errs = [];
page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
for (const path of ["/", "/ratings", "PLAYER", "/season", "/hall-of-fame"]) {
  errs = [];
  if (path === "PLAYER") { await page.goto(base + "/ratings", { waitUntil: "networkidle" }); const a = await page.$("a[href^='/player/']"); const href = await a.getAttribute("href"); errs = []; await page.goto(base + href, { waitUntil: "networkidle" }); }
  else await page.goto(base + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const loop = errs.filter(e => /Maximum update depth/.test(e));
  console.log(path, "errors", errs.length, "loop", loop.length, loop[0] ? (loop[0].match(/at (\w+)/g) || []).slice(0, 6).join(" ") : "");
}
await browser.close();
