/**
 * ESPNCricinfo Year-by-Year Stats Scraper
 *
 * Scrapes year-by-year T20 stats from the stats page by:
 * 1. Loading the player stats page
 * 2. Clicking the format dropdown → T20Is (or T20)
 * 3. Reading the rendered DOM tables (not __NEXT_DATA__ which doesn't update)
 * 4. Switching to Bowling and reading again
 *
 * Usage:
 *   npx tsx packages/ratings/src/pipeline/espn-yearly-stats.ts [--limit N] [--resume] [--concurrency N]
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.resolve('packages/ratings/data/scraped');
const ESPN_PLAYERS_FILE = path.join(DATA_DIR, 'espn-players.json');
const ESPN_YEARLY_FILE = path.join(DATA_DIR, 'espn-yearly-stats.json');
const BROWSER_PROFILE_DIR = '/tmp/pw-espncricinfo-yearly';

interface YearlyStat {
  year: string;
  mt: number; in: number; no: number; rn: number; hs: string;
  avg: number; bf: number; sr: number; hn: number; ft: number;
  zeros: number; fo: number; si: number;
}

interface YearlyBowlingStat {
  year: string;
  mt: number; in: number; bl: number; md: number; rn: number;
  wk: number; bbi: string; avg: number; econ: number; sr: number;
  fw: number;
}

interface PlayerYearlyData {
  espnId: number;
  name: string;
  battingByYear: YearlyStat[];
  bowlingByYear: YearlyBowlingStat[];
  scrapedAt: string;
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function loadExisting(): Map<number, PlayerYearlyData> {
  const map = new Map<number, PlayerYearlyData>();
  if (fs.existsSync(ESPN_YEARLY_FILE)) {
    const data: PlayerYearlyData[] = JSON.parse(fs.readFileSync(ESPN_YEARLY_FILE, 'utf-8'));
    for (const p of data) map.set(p.espnId, p);
  }
  return map;
}

function saveData(data: Map<number, PlayerYearlyData>): void {
  fs.writeFileSync(ESPN_YEARLY_FILE, JSON.stringify(Array.from(data.values()), null, 2));
}

/** Click a format dropdown option by first opening the dropdown, then clicking the option */
async function selectFormat(page: Page, formatName: string): Promise<boolean> {
  // Open the format dropdown (first ds-popper-wrapper that shows Tests/ODIs/T20Is)
  const opened = await page.evaluate(() => {
    const wrapper = [...document.querySelectorAll('.ds-popper-wrapper')].find(el => {
      const text = el.textContent?.trim();
      return text === 'Tests' || text === 'ODIs' || text === 'T20Is' || text === 'T20' || text === 'FC';
    });
    if (wrapper) { wrapper.querySelector('div')?.click(); return true; }
    return false;
  });
  if (!opened) return false;
  await delay(500);

  // Click the desired format in the dropdown
  const clicked = await page.evaluate((name) => {
    const dropdown = document.querySelector('.tippy-box.ds-popper.ds-dropdown');
    if (!dropdown) return false;
    const opt = [...dropdown.querySelectorAll('*')].find(el =>
      el.textContent?.trim() === name && el.childElementCount === 0
    );
    if (opt) { (opt as HTMLElement).click(); return true; }
    return false;
  }, formatName);
  if (clicked) await delay(2000);
  return clicked;
}

/** Switch batting/bowling dropdown */
async function selectType(page: Page, typeName: string): Promise<boolean> {
  const opened = await page.evaluate((current) => {
    const wrapper = [...document.querySelectorAll('.ds-popper-wrapper')].find(el => {
      const text = el.textContent?.trim();
      return text === 'Batting' || text === 'Bowling';
    });
    if (wrapper) { wrapper.querySelector('div')?.click(); return true; }
    return false;
  }, typeName);
  if (!opened) return false;
  await delay(500);

  const clicked = await page.evaluate((name) => {
    const dropdown = document.querySelector('.tippy-box.ds-popper.ds-dropdown');
    if (!dropdown) return false;
    const opt = [...dropdown.querySelectorAll('*')].find(el =>
      el.textContent?.trim() === name && el.childElementCount === 0
    );
    if (opt) { (opt as HTMLElement).click(); return true; }
    return false;
  }, typeName);
  if (clicked) await delay(2000);
  return clicked;
}

/** Extract the YEAR table data from the rendered DOM */
async function extractYearTable(page: Page): Promise<{ headers: string[]; rows: string[][] }> {
  return page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    // Find the table that has "Year" or year data in first column
    for (const table of tables) {
      const firstCellText = table.querySelector('tbody tr td')?.textContent?.trim() || '';
      if (firstCellText.match(/^(year\s+)?\d{4}/i)) {
        const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent?.trim() || '');
        const rows = [...table.querySelectorAll('tbody tr')].map(tr =>
          [...tr.querySelectorAll('td')].map(td => td.textContent?.trim() || '')
        ).filter(r => r.length > 3 && r[0].match(/\d{4}/));
        return { headers, rows };
      }
    }
    // Fallback: look through all tables for one with year-like rows
    for (const table of tables) {
      const rows = [...table.querySelectorAll('tbody tr')].map(tr =>
        [...tr.querySelectorAll('td')].map(td => td.textContent?.trim() || '')
      );
      const yearRows = rows.filter(r => r.length > 3 && r[0]?.match(/\d{4}/));
      if (yearRows.length > 0) {
        const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent?.trim() || '');
        return { headers, rows: yearRows };
      }
    }
    return { headers: [], rows: [] };
  });
}

function parseNum(s: string): number {
  const n = parseFloat(s.replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

async function scrapePlayer(page: Page, espnId: number, slug: string, name: string): Promise<PlayerYearlyData | null> {
  const url = `https://www.espncricinfo.com/cricketers/${slug}-${espnId}/bowling-batting-stats`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2500);

    if ((await page.title()).includes('Access Denied')) {
      await delay(15000);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await delay(3000);
      if ((await page.title()).includes('Access Denied')) return null;
    }

    // Switch to T20/T20Is format
    // International players show: Tests, ODIs, T20Is
    // Domestic-only players show: FC, LA, T20
    // Try T20Is first (most common for active players), fall back to T20
    let switched = await selectFormat(page, 'T20Is');
    if (!switched) {
      switched = await selectFormat(page, 'T20');
    }
    if (!switched) {
      // Some players only have FC/LA — skip them
      return null;
    }

    // Extract batting year table
    // Table columns: [label, Span, Mat, Inns, NO, Runs, HS, Avg, BF, SR, 100s, 50s, 0s, 4s, 6s]
    // Index:          0      1     2    3     4   5     6   7    8   9   10    11   12   13  14
    const batTable = await extractYearTable(page);
    const battingByYear: YearlyStat[] = batTable.rows.map(r => {
      // Find column indices from headers
      const h = batTable.headers;
      const col = (name: string) => h.indexOf(name);
      // Use header-based indexing if available, otherwise positional
      if (h.length > 0 && col('Mat') >= 0) {
        return {
          year: r[0].replace(/^year\s+/i, '').trim(),
          mt: parseNum(r[col('Mat')]),
          in: parseNum(r[col('Inns')]),
          no: parseNum(r[col('NO')]),
          rn: parseNum(r[col('Runs')]),
          hs: r[col('HS')] || '',
          avg: parseNum(r[col('Avg')]),
          bf: parseNum(r[col('BF')]),
          sr: parseNum(r[col('SR')]),
          hn: parseNum(r[col('100s') >= 0 ? col('100s') : col('100')]),
          ft: parseNum(r[col('50s') >= 0 ? col('50s') : col('50')]),
          zeros: parseNum(r[col('0s') >= 0 ? col('0s') : col('0')]),
          fo: parseNum(r[col('4s')]),
          si: parseNum(r[col('6s')]),
        };
      }
      // Fallback positional (Span=1, Mat=2, Inns=3, NO=4, Runs=5, HS=6, Avg=7, BF=8, SR=9, 100s=10, 50s=11, 0s=12, 4s=13, 6s=14)
      return {
        year: r[0].replace(/^year\s+/i, '').trim(),
        mt: parseNum(r[2]), in: parseNum(r[3]), no: parseNum(r[4]),
        rn: parseNum(r[5]), hs: r[6] || '', avg: parseNum(r[7]),
        bf: parseNum(r[8]), sr: parseNum(r[9]), hn: parseNum(r[10]),
        ft: parseNum(r[11]), zeros: parseNum(r[12]),
        fo: parseNum(r[13]), si: parseNum(r[14]),
      };
    });

    // Switch to Bowling
    let bowlingByYear: YearlyBowlingStat[] = [];
    const switchedBowl = await selectType(page, 'Bowling');
    if (switchedBowl) {
      const bowlTable = await extractYearTable(page);
      bowlingByYear = bowlTable.rows.map(r => {
        const h = bowlTable.headers;
        const col = (name: string) => h.indexOf(name);
        if (h.length > 0 && col('Mat') >= 0) {
          return {
            year: r[0].replace(/^year\s+/i, '').trim(),
            mt: parseNum(r[col('Mat')]),
            in: parseNum(r[col('Inns')]),
            bl: parseNum(r[col('Overs') >= 0 ? col('Overs') : col('Balls')]),
            md: parseNum(r[col('Mdns')]),
            rn: parseNum(r[col('Runs')]),
            wk: parseNum(r[col('Wkts')]),
            bbi: r[col('BBI')] || '',
            avg: parseNum(r[col('Avg')]),
            econ: parseNum(r[col('Econ')]),
            sr: parseNum(r[col('SR')]),
            fw: parseNum(r[col('5w') >= 0 ? col('5w') : col('5')]),
          };
        }
        return {
          year: r[0].replace(/^year\s+/i, '').trim(),
          mt: parseNum(r[2]), in: parseNum(r[3]),
          bl: parseNum(r[4]), md: parseNum(r[5]),
          rn: parseNum(r[6]), wk: parseNum(r[7]),
          bbi: r[8] || '', avg: parseNum(r[9]),
          econ: parseNum(r[10]), sr: parseNum(r[11]),
          fw: parseNum(r[13]),
        };
      });
    }

    if (battingByYear.length === 0 && bowlingByYear.length === 0) return null;

    return {
      espnId,
      name,
      battingByYear,
      bowlingByYear,
      scrapedAt: new Date().toISOString(),
    };
  } catch (err) {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : undefined;
  const resume = args.includes('--resume');
  const concurrency = args.includes('--concurrency') ? parseInt(args[args.indexOf('--concurrency') + 1]) : 1;

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  ESPN Year-by-Year T20 Stats Scraper         ║');
  console.log('╚══════════════════════════════════════════════╝');

  if (!fs.existsSync(ESPN_PLAYERS_FILE)) {
    console.log('No espn-players.json. Run espn-scraper.ts first.');
    return;
  }

  const allPlayers = JSON.parse(fs.readFileSync(ESPN_PLAYERS_FILE, 'utf-8'));
  const t20Players = allPlayers.filter((p: any) =>
    p.careerStats.some((s: any) => (s.cl === 3 || s.cl === 6) && s.mt >= 3)
  );

  const existing = loadExisting();
  const toScrape = resume ? t20Players.filter((p: any) => !existing.has(p.profile.espnId)) : t20Players;

  console.log(`  T20 players (3+ matches): ${t20Players.length}`);
  console.log(`  Already scraped: ${existing.size}`);
  console.log(`  To scrape: ${toScrape.length}`);
  console.log(`  Concurrency: ${concurrency}`);

  const browser = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless: false, channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1440, height: 900 },
  });

  const pages: Page[] = [];
  for (let i = 0; i < concurrency; i++) pages.push(await browser.newPage());

  const total = limit ? Math.min(limit, toScrape.length) : toScrape.length;
  let scraped = 0, failed = 0;
  const startTime = Date.now();

  try {
    for (let i = 0; i < total; i += concurrency) {
      const batch = toScrape.slice(i, Math.min(i + concurrency, total));
      const results = await Promise.all(
        batch.map((p: any, idx: number) =>
          scrapePlayer(pages[idx], p.profile.espnId, p.profile.slug, p.profile.longName)
        )
      );

      for (const data of results) {
        if (data) {
          existing.set(data.espnId, data);
          scraped++;
        } else {
          failed++;
        }
      }

      const done = Math.min(i + concurrency, total);
      if (done % 50 < concurrency || done === total) {
        const pct = (done / total * 100).toFixed(1);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate = scraped > 0 ? (scraped / (Date.now() - startTime) * 3600000).toFixed(0) : '0';
        console.log(`  [${pct}%] ${done}/${total} | OK: ${scraped} | Fail: ${failed} | ${elapsed}s | ~${rate}/hr`);
        saveData(existing);
      }

      await delay(500 + Math.random() * 500);
    }
  } finally {
    for (const p of pages) await p.close();
    await browser.close();
  }

  saveData(existing);
  const mins = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\n  Done in ${mins} min! OK: ${scraped}, Failed: ${failed}`);
  console.log(`  Output: ${ESPN_YEARLY_FILE}`);
}

main().catch(console.error);
