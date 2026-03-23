/**
 * ESPNCricinfo Playwright Scraper
 *
 * Scrapes player profiles from ESPNCricinfo using Playwright.
 * ESPNCricinfo uses Akamai CDN which blocks headless browsers and curl,
 * so we use headed Chrome with a persistent profile.
 *
 * Data is extracted from __NEXT_DATA__ embedded in each player's profile page.
 * A single page load gives us:
 *   - Player bio (name, DOB, batting/bowling style, role, country, teams)
 *   - Career stats across 6 formats (Test, ODI, T20I, FC, List A, T20)
 *   - Including 4s, 6s, balls faced — data not available from CricketArchive
 *
 * Usage:
 *   npx tsx packages/ratings/src/pipeline/espn-scraper.ts [--limit N] [--resume]
 *   npx tsx packages/ratings/src/pipeline/espn-scraper.ts --index-only
 *   npx tsx packages/ratings/src/pipeline/espn-scraper.ts --skip-index --resume
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

// ── Types ────────────────────────────────────────────────────────────────

interface ESPNPlayerProfile {
  espnId: number;
  name: string;
  longName: string;
  slug: string;
  dateOfBirth: { year: number; month: number; date: number } | null;
  gender: string;
  countryTeamId: number;
  battingStyles: string[];
  bowlingStyles: string[];
  playingRoles: string[];
  teams: string[];
  imageUrl: string;
  intlCareerSpan: string | null; // e.g. "2008 - 2026"
}

interface ESPNCareerStat {
  type: 'BATTING' | 'BOWLING';
  /** 1=Test, 2=ODI, 3=T20I, 4=FC, 5=ListA, 6=T20 */
  cl: number;
  mt: number;   // matches
  in: number;   // innings
  rn: number;   // runs
  bl: number;   // balls
  avg: number;  // average
  sr: number;   // strike rate
  no?: number;  // not outs (batting)
  fo?: number;  // fours (batting)
  si?: number;  // sixes (batting)
  hs?: string;  // high score (batting)
  hn?: number;  // hundreds (batting)
  ft?: number;  // fifties (batting)
  ct?: number;  // catches
  st?: number;  // stumpings
  wk?: number;  // wickets (bowling)
  bbi?: string; // best bowling innings
  bbm?: string; // best bowling match
  fwk?: number; // four-wicket hauls
  fw?: number;  // five-wicket hauls
  tw?: number;  // ten-wicket hauls
  bwe?: number; // economy (bowling)
}

interface ESPNPlayerData {
  profile: ESPNPlayerProfile;
  careerStats: ESPNCareerStat[];
  scrapedAt: string;
}

interface PlayerIndexEntry {
  name: string;
  slug: string;
  espnId: number;
  source: string; // which team page we found them on
}

// ── Constants ────────────────────────────────────────────────────────────

const DATA_DIR = path.resolve('packages/ratings/data/scraped');
const ESPN_PLAYERS_FILE = path.join(DATA_DIR, 'espn-players.json');
const ESPN_INDEX_FILE = path.join(DATA_DIR, 'espn-player-index.json');
const BROWSER_PROFILE_DIR = '/tmp/pw-espncricinfo-profile';

// All countries with active cricketers on ESPNCricinfo
// Includes ICC Full Members, Associates, and Affiliates with T20I status
const TEAM_PAGES = [
  // ICC Full Members
  { name: 'India', slug: 'india', id: 6 },
  { name: 'Australia', slug: 'australia', id: 2 },
  { name: 'England', slug: 'england', id: 1 },
  { name: 'South Africa', slug: 'south-africa', id: 3 },
  { name: 'New Zealand', slug: 'new-zealand', id: 5 },
  { name: 'Pakistan', slug: 'pakistan', id: 7 },
  { name: 'West Indies', slug: 'west-indies', id: 4 },
  { name: 'Sri Lanka', slug: 'sri-lanka', id: 8 },
  { name: 'Bangladesh', slug: 'bangladesh', id: 25 },
  { name: 'Afghanistan', slug: 'afghanistan', id: 40 },
  { name: 'Zimbabwe', slug: 'zimbabwe', id: 9 },
  { name: 'Ireland', slug: 'ireland', id: 29 },
  // ICC Associates with T20I status
  { name: 'Netherlands', slug: 'netherlands', id: 15 },
  { name: 'Scotland', slug: 'scotland', id: 30 },
  { name: 'Nepal', slug: 'nepal', id: 32 },
  { name: 'USA', slug: 'usa', id: 11 },
  { name: 'Namibia', slug: 'namibia', id: 28 },
  { name: 'Oman', slug: 'oman', id: 36 },
  { name: 'UAE', slug: 'united-arab-emirates', id: 27 },
  { name: 'Papua New Guinea', slug: 'papua-new-guinea', id: 20 },
  { name: 'Canada', slug: 'canada', id: 17 },
  { name: 'Hong Kong', slug: 'hong-kong', id: 19 },
  { name: 'Kenya', slug: 'kenya', id: 26 },
  { name: 'Uganda', slug: 'uganda', id: 34 },
  { name: 'Jersey', slug: 'jersey', id: 37 },
  { name: 'Singapore', slug: 'singapore', id: 35 },
  { name: 'Bermuda', slug: 'bermuda', id: 12 },
  { name: 'Italy', slug: 'italy', id: 31 },
  { name: 'Germany', slug: 'germany', id: 41 },
  { name: 'Denmark', slug: 'denmark', id: 14 },
  { name: 'Malaysia', slug: 'malaysia', id: 42 },
  { name: 'Tanzania', slug: 'tanzania', id: 43 },
  { name: 'Qatar', slug: 'qatar', id: 44 },
  { name: 'Bahrain', slug: 'bahrain', id: 45 },
  { name: 'Kuwait', slug: 'kuwait', id: 46 },
  { name: 'Saudi Arabia', slug: 'saudi-arabia', id: 47 },
  { name: 'Vanuatu', slug: 'vanuatu', id: 48 },
  { name: 'Czech Republic', slug: 'czech-republic', id: 49 },
  { name: 'Austria', slug: 'austria', id: 50 },
  { name: 'Spain', slug: 'spain', id: 51 },
  { name: 'Romania', slug: 'romania', id: 52 },
  { name: 'Hungary', slug: 'hungary', id: 53 },
  { name: 'Sweden', slug: 'sweden', id: 54 },
  { name: 'Portugal', slug: 'portugal', id: 55 },
  { name: 'Luxembourg', slug: 'luxembourg', id: 56 },
  { name: 'Belgium', slug: 'belgium', id: 57 },
  { name: 'Norway', slug: 'norway', id: 58 },
  { name: 'Bulgaria', slug: 'bulgaria', id: 59 },
  { name: 'Croatia', slug: 'croatia', id: 60 },
  { name: 'Finland', slug: 'finland', id: 61 },
  { name: 'France', slug: 'france', id: 62 },
  { name: 'Greece', slug: 'greece', id: 63 },
  { name: 'Guernsey', slug: 'guernsey', id: 64 },
  { name: 'Isle of Man', slug: 'isle-of-man', id: 65 },
  { name: 'Nigeria', slug: 'nigeria', id: 66 },
  { name: 'Rwanda', slug: 'rwanda', id: 67 },
  { name: 'Cameroon', slug: 'cameroon', id: 68 },
  { name: 'Ghana', slug: 'ghana', id: 69 },
  { name: 'Mozambique', slug: 'mozambique', id: 70 },
  { name: 'Botswana', slug: 'botswana', id: 71 },
  { name: 'Cayman Islands', slug: 'cayman-islands', id: 72 },
  { name: 'Thailand', slug: 'thailand', id: 73 },
  { name: 'Philippines', slug: 'philippines', id: 74 },
  { name: 'Japan', slug: 'japan', id: 75 },
  { name: 'South Korea', slug: 'south-korea', id: 76 },
  { name: 'Mongolia', slug: 'mongolia', id: 77 },
  { name: 'China', slug: 'china', id: 78 },
];

// ── Helpers ──────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadExistingData(): Map<number, ESPNPlayerData> {
  const map = new Map<number, ESPNPlayerData>();
  if (fs.existsSync(ESPN_PLAYERS_FILE)) {
    const data: ESPNPlayerData[] = JSON.parse(fs.readFileSync(ESPN_PLAYERS_FILE, 'utf-8'));
    for (const p of data) {
      map.set(p.profile.espnId, p);
    }
  }
  return map;
}

function saveData(players: Map<number, ESPNPlayerData>): void {
  const arr = Array.from(players.values());
  fs.writeFileSync(ESPN_PLAYERS_FILE, JSON.stringify(arr, null, 2));
}

function loadIndex(): Map<number, PlayerIndexEntry> {
  const map = new Map<number, PlayerIndexEntry>();
  if (fs.existsSync(ESPN_INDEX_FILE)) {
    const data: PlayerIndexEntry[] = JSON.parse(fs.readFileSync(ESPN_INDEX_FILE, 'utf-8'));
    for (const p of data) {
      map.set(p.espnId, p);
    }
  }
  return map;
}

function saveIndex(index: Map<number, PlayerIndexEntry>): void {
  fs.writeFileSync(ESPN_INDEX_FILE, JSON.stringify(Array.from(index.values()), null, 2));
}

async function launchBrowser(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless: false,
    channel: 'chrome',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--window-size=1440,900',
      '--window-position=50,50',
    ],
    viewport: { width: 1440, height: 900 },
  });
}

// ── Extract player links from a page ────────────────────────────────────

async function extractPlayerLinks(page: Page): Promise<PlayerIndexEntry[]> {
  return page.evaluate(() => {
    const seen = new Set<string>();
    return [...document.querySelectorAll('a')]
      .filter(a => a.href.match(/\/cricketers\/[^\/]+-\d+$/) && !a.href.includes('/team/'))
      .map(a => {
        const m = a.href.match(/\/cricketers\/(.+)-(\d+)$/);
        if (!m || seen.has(m[2])) return null;
        seen.add(m[2]);
        return {
          name: a.textContent?.trim() || '',
          slug: m[1],
          espnId: parseInt(m[2]),
          source: '',
        };
      })
      .filter(Boolean) as PlayerIndexEntry[];
  });
}

// ── Step 1: Build player index from team pages ──────────────────────────

async function buildPlayerIndex(page: Page): Promise<Map<number, PlayerIndexEntry>> {
  const index = loadIndex();
  const teamsScraped = new Set<string>();

  // Track which teams we've already scraped (from index source field)
  for (const [, entry] of index) {
    if (entry.source) teamsScraped.add(entry.source);
  }

  console.log('\n━━━ Building Player Index from Team Pages ━━━');
  if (index.size > 0) {
    console.log(`  Existing index: ${index.size} players`);
  }

  for (const team of TEAM_PAGES) {
    const teamKey = `${team.slug}-${team.id}`;

    // Always re-check active players (they change)
    const url = `https://www.espncricinfo.com/cricketers/team/${teamKey}`;
    process.stdout.write(`  ${team.name}...`);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await delay(3000);

      // Check for access denied
      const title = await page.title();
      if (title.includes('Access Denied')) {
        console.log(' BLOCKED (Access Denied)');
        await delay(10000);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(5000);
        const retryTitle = await page.title();
        if (retryTitle.includes('Access Denied')) {
          console.log('  ⚠ Still blocked, skipping');
          continue;
        }
      }

      // Click "ALL" filter to get all players (not just international)
      const clickedAll = await page.evaluate(() => {
        const allSpan = [...document.querySelectorAll('span')].find(s =>
          s.textContent?.trim() === 'ALL' && s.className.includes('ds-text-tight')
        );
        const link = allSpan?.closest('a');
        if (link) { link.click(); return true; }
        return false;
      });
      if (clickedAll) await delay(2000);

      // Scroll to bottom to load all lazy-loaded players
      let prevCount = 0;
      for (let scroll = 0; scroll < 50; scroll++) {
        const currentCount = await page.evaluate(() => {
          const links = [...document.querySelectorAll('a')].filter(a =>
            a.href.match(/\/cricketers\/[^\/]+-\d+$/) && !a.href.includes('/team/')
          );
          return new Set(links.map(a => a.href.match(/(\d+)$/)?.[1]).filter(Boolean)).size;
        });
        if (currentCount === prevCount && scroll > 0) break; // no new players loaded
        prevCount = currentCount;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(1000);
      }

      const players = await extractPlayerLinks(page);
      let newCount = 0;
      for (const p of players) {
        if (!index.has(p.espnId)) {
          p.source = teamKey;
          index.set(p.espnId, p);
          newCount++;
        }
      }
      console.log(` ${players.length} players (${newCount} new). Total: ${index.size}`);

      // Save after each team in case we get blocked
      saveIndex(index);

    } catch (err) {
      console.log(` ⚠ Failed: ${(err as Error).message.slice(0, 80)}`);
    }

    // Rate limit between team pages
    await delay(2000 + Math.random() * 1000);
  }

  saveIndex(index);
  console.log(`\n  Total unique players indexed: ${index.size}`);
  return index;
}

// ── Step 2: Scrape individual player profiles ───────────────────────────

async function scrapePlayerProfile(page: Page, espnId: number, slug: string): Promise<ESPNPlayerData | null> {
  const url = `https://www.espncricinfo.com/cricketers/${slug}-${espnId}`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2000);

    // Check for access denied
    const title = await page.title();
    if (title.includes('Access Denied')) {
      // Wait and retry
      await delay(15000);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await delay(3000);
      const retryTitle = await page.title();
      if (retryTitle.includes('Access Denied')) {
        return null;
      }
    }

    const data = await page.evaluate(() => {
      const nextDataEl = document.getElementById('__NEXT_DATA__');
      if (!nextDataEl) return null;

      const nextData = JSON.parse(nextDataEl.textContent || '{}');
      const appData = nextData?.props?.appPageProps?.data;
      if (!appData?.player) return null;

      const player = appData.player;
      const content = appData.content;

      // Extract team names
      const teams = (content?.teams || [])
        .map((t: any) => t?.team?.longName || t?.team?.name || '')
        .filter(Boolean);

      const profile = {
        espnId: player.objectId,
        name: player.name,
        longName: player.longName,
        slug: player.slug,
        dateOfBirth: player.dateOfBirth,
        gender: player.gender,
        countryTeamId: player.countryTeamId,
        battingStyles: player.longBattingStyles || player.battingStyles || [],
        bowlingStyles: player.longBowlingStyles || player.bowlingStyles || [],
        playingRoles: player.playingRoles || [],
        teams,
        imageUrl: player.imageUrl || '',
        intlCareerSpan: player.intlCareerSpan || null,
      };

      const careerStats = content?.careerAverages?.stats || [];

      return { profile, careerStats };
    });

    if (!data) return null;

    return {
      ...data,
      scrapedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.log(`    ⚠ Error: ${(err as Error).message.slice(0, 80)}`);
    return null;
  }
}

async function scrapeAllProfiles(
  browser: BrowserContext,
  index: Map<number, PlayerIndexEntry>,
  options: { limit?: number; resume: boolean; concurrency: number }
): Promise<void> {
  const existing = loadExistingData();
  const toScrape: PlayerIndexEntry[] = [];

  for (const [id, info] of index) {
    if (options.resume && existing.has(id)) continue;
    toScrape.push(info);
  }

  console.log(`\n━━━ Scraping Player Profiles ━━━`);
  console.log(`  Total in index: ${index.size}`);
  console.log(`  Already scraped: ${existing.size}`);
  console.log(`  To scrape: ${toScrape.length}`);
  console.log(`  Concurrency: ${options.concurrency} tabs`);
  if (options.limit) console.log(`  Limit: ${options.limit}`);

  const total = options.limit ? Math.min(options.limit, toScrape.length) : toScrape.length;
  let scraped = 0;
  let t20Active = 0;
  let failed = 0;
  let consecutiveBlocks = 0;
  const startTime = Date.now();

  // Create worker tabs
  const pages: Page[] = [];
  for (let t = 0; t < options.concurrency; t++) {
    pages.push(await browser.newPage());
  }
  console.log(`  Opened ${pages.length} tabs`);

  // Process in batches of concurrency
  for (let i = 0; i < total; i += options.concurrency) {
    const batch = toScrape.slice(i, Math.min(i + options.concurrency, total));

    const results = await Promise.all(
      batch.map((player, idx) =>
        scrapePlayerProfile(pages[idx], player.espnId, player.slug)
      )
    );

    for (const data of results) {
      if (data) {
        existing.set(data.profile.espnId, data);
        scraped++;
        consecutiveBlocks = 0;
        const hasT20 = data.careerStats.some(s => (s.cl === 3 || s.cl === 6) && s.mt > 0);
        if (hasT20) t20Active++;
      } else {
        failed++;
        consecutiveBlocks++;
      }
    }

    // If getting blocked, slow down
    if (consecutiveBlocks >= options.concurrency * 2) {
      console.log(`  ⚠ ${consecutiveBlocks} consecutive failures, waiting 30s...`);
      await delay(30000);
      consecutiveBlocks = 0;
    }

    const done = Math.min(i + options.concurrency, total);
    if (done % 50 < options.concurrency || done === total) {
      const pct = (done / total * 100).toFixed(1);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = (scraped / (Date.now() - startTime) * 1000 * 3600).toFixed(0);
      console.log(`  [${pct}%] ${done}/${total} | OK: ${scraped} | T20: ${t20Active} | Fail: ${failed} | ${elapsed}s | ~${rate}/hr`);
      saveData(existing);
    }

    // Small delay between batches to not hammer ESPN
    await delay(500 + Math.random() * 500);
  }

  // Close worker tabs
  for (const p of pages) await p.close();

  saveData(existing);
  const totalTime = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\n  Done in ${totalTime} min! Scraped: ${scraped}, Failed: ${failed}, T20 active: ${t20Active}`);
  console.log(`  Total players in database: ${existing.size}`);
  console.log(`  Output: ${ESPN_PLAYERS_FILE}`);
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : undefined;
  const resume = args.includes('--resume');
  const skipIndex = args.includes('--skip-index');
  const indexOnly = args.includes('--index-only');
  const concurrency = args.includes('--concurrency') ? parseInt(args[args.indexOf('--concurrency') + 1]) : 4;

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  ESPNCricinfo Playwright Scraper             ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Options: limit=${limit || 'none'}, resume=${resume}, concurrency=${concurrency}`);
  console.log(`Browser profile: ${BROWSER_PROFILE_DIR}`);

  // Use headed Chrome with persistent profile to bypass Akamai
  const browser = await launchBrowser();

  try {
    // Step 1: Build index from team pages
    let index: Map<number, PlayerIndexEntry>;

    if (skipIndex) {
      index = loadIndex();
      console.log(`  Loaded existing index: ${index.size} players`);
    } else {
      const page = browser.pages()[0] || await browser.newPage();
      index = await buildPlayerIndex(page);
      await page.close();
    }

    if (indexOnly) {
      console.log('\n✓ Index complete.');
      return;
    }

    if (index.size === 0) {
      console.log('\n⚠ No players in index. Run without --skip-index first.');
      return;
    }

    // Step 2: Scrape profiles with parallel tabs
    await scrapeAllProfiles(browser, index, { limit, resume, concurrency });

  } finally {
    await browser.close();
  }
}

main().catch(console.error);
