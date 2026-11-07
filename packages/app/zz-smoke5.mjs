import { chromium } from "playwright";
const base = "http://localhost:3861", SP = process.env.SP;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
const errs = []; page.on("console", m => { if (m.type() === "error") errs.push(m.text().slice(0,160)); }); page.on("pageerror", e => errs.push("PAGEERR " + e.message));
await page.goto(base + "/", { waitUntil: "networkidle" });
await page.getByRole("button", { name: "WBBL", exact: true }).click();
await page.waitForTimeout(4000);
const teams = await page.$$eval("button", bs => bs.map(b => b.innerText.trim().replace(/\s+/g," ")).filter(t => /PWR/.test(t)));
console.log("WBBL teams:", JSON.stringify(teams));
await page.screenshot({ path: `${SP}/6-wbbl.png` });
// pick first team
await page.locator("button", { hasText: "PWR" }).first().click();
await page.waitForTimeout(3000);
console.log("url after pick:", page.url());
const links = await page.$$eval("a[href^='/player/']", as => as.map(a => a.getAttribute("href")));
console.log("player links:", links.length, links.slice(0,3), "ca links:", links.filter(h => /ca_/.test(h)).length);
const hrefs = await page.$$eval("a", as => as.map(a => a.getAttribute("href")).filter(Boolean));
console.log("season links:", JSON.stringify([...new Set(hrefs)].slice(0, 25)));
const tl = hrefs.find(h => h.startsWith("/team/"));
await page.goto(base + (tl ?? "/lineup"), { waitUntil: "networkidle" }); await page.waitForTimeout(2000);
await page.screenshot({ path: `${SP}/8-team.png` });
const plinks = await page.$$eval("a[href^='/player/']", as => as.map(a => a.getAttribute("href")));
console.log("team page player links:", plinks.length, "ca:", plinks.filter(h => /ca_/.test(h)).length);
if (plinks[0]) { await page.goto(base + plinks[0], { waitUntil: "networkidle" }); await page.waitForTimeout(2500);
  console.log("has over-time:", /over time/i.test(await page.innerText("body")), "| projection:", /projection/i.test(await page.innerText("body")));
  await page.screenshot({ path: `${SP}/7-player-own.png`, fullPage: true }); }
console.log("errors:", errs.length ? errs.join(" | ") : "none");
await browser.close();
