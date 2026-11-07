/**
 * CricketArchive scorecard pipeline: discover every recognised-level match, then scrape
 * and parse each scorecard.
 *
 * Discovery walks the site's own season structure:
 *   /Archive/Seasons/index.html                       → 495 seasons (1702 … 2027/28)
 *   /Archive/Seasons/{season}.html                    → country seasons ("2024_IND.html")
 *   /Archive/Seasons/{season}_{CC}.html               → "List of all … matches" links
 *   /Archive/Seasons/Seasonal_Averages/{CC}/{season}_{code}_Match_List.html → scorecards
 * List codes: f (First-Class, includes Tests), a (List A, includes ODIs), tt (Twenty20,
 * includes T20Is), and the same with a "w" prefix for women.
 *
 * Everything else (2nd XI, minor counties, domestic leagues below List A/T20 status, youth,
 * university, club, veterans: the bulk of the 1.4M scorecard ids) has no match list, so
 * `--step discover-events` walks every event linked from each country-season page:
 *   /Archive/Events/{n}/{Event_Name}.html → scorecards
 * ({n} is a storage bucket that grows over time, not a level.) Event-only cards scrape after
 * every match-list card, tiered by event name (EVENT_TIERS): senior domestic and touring
 * sides, then university, club, youth, and veterans/disability last. Their HTML is not
 * cached (it would not fit on disk); parsed cards go to gzip-compressed
 * scorecards-events.jsonl.gz instead.
 *
 * Usage:
 *   npx tsx src/pipeline/scorecards.ts --step discover [--from 2000] [--to 2026]
 *   npx tsx src/pipeline/scorecards.ts --step discover-events [--from 2000] [--to 2026]
 *   npx tsx src/pipeline/scorecards.ts --step scrape [--limit N] [--levels tt,wtt] [--no-events]
 *   npx tsx src/pipeline/scorecards.ts                 # discover then scrape
 *
 * Output (data/scorecards/):
 *   match-index.json             { [scorecardId]: { title, season, country, lists[], event? } }
 *   scorecards.jsonl             parsed match-list Scorecards, one per line (resume skips ids present)
 *   scorecards-events.jsonl.gz   parsed event-only Scorecards (concatenated gzip members)
 *   players-seen.json            every player id seen in scraped scorecards, for the profile scraper
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream } from 'fs';
import { createGunzip, gzipSync } from 'zlib';
import { join } from 'path';
import { createInterface } from 'readline';
import { BASE_URL } from './config.js';
import { closeFetcher, fetchPage, forEachConcurrent } from './fetcher.js';
import { parseScorecard } from './scorecard-parse.js';
import { eventTier } from './event-tiers.js';

const OUT_DIR = new URL('../../data/scorecards', import.meta.url).pathname;
const MATCH_INDEX_FILE = join(OUT_DIR, 'match-index.json');
const DISCOVERY_PROGRESS_FILE = join(OUT_DIR, 'discovery-progress.json');
const SCORECARDS_FILE = join(OUT_DIR, 'scorecards.jsonl');
const EVENT_SCORECARDS_FILE = join(OUT_DIR, 'scorecards-events.jsonl.gz');
const EVENT_DISCOVERY_PROGRESS_FILE = join(OUT_DIR, 'event-discovery-progress.json');
const PLAYERS_SEEN_FILE = join(OUT_DIR, 'players-seen.json');

/** Scrape order: men's then women's top-level formats first, everything else after */
const LIST_PRIORITY = ['f', 'a', 'tt', 'wf', 'wa', 'wtt'];

interface MatchIndexEntry {
  title: string;
  season: string;
  country: string;
  /** Match-list codes this scorecard appears under, e.g. ["tt"] */
  lists: string[];
  /** Event it was found under by discover-events */
  event?: string;
}

function ensureOutDir(): void {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
}

function loadJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : fallback;
}

function uniqueMatches(html: string, re: RegExp): string[] {
  return [...new Set([...html.matchAll(re)].map(m => m[1]))];
}

// ── Discovery ────────────────────────────────────────────────────────────

function seasonYear(season: string): number {
  return parseInt(season.slice(0, 4), 10);
}

async function discover(options: { from?: number; to?: number }): Promise<void> {
  ensureOutDir();
  const index = loadJson<Record<string, MatchIndexEntry>>(MATCH_INDEX_FILE, {});
  const done = new Set(loadJson<string[]>(DISCOVERY_PROGRESS_FILE, []));

  const seasonsHtml = await fetchPage(`${BASE_URL}/Archive/Seasons/index.html`);
  const seasons = uniqueMatches(seasonsHtml, /href="(\d{4}(?:-\d{2})?)\.html"/g)
    .filter(s => (options.from === undefined || seasonYear(s) >= options.from) &&
                 (options.to === undefined || seasonYear(s) <= options.to))
    // Newest first: modern cricket is what the game uses, so it lands earliest
    .sort((a, b) => b.localeCompare(a));
  console.log(`Seasons to walk: ${seasons.length} (${done.size} country-seasons already done)`);

  for (const [si, season] of seasons.entries()) {
    const seasonHtml = await fetchPage(`${BASE_URL}/Archive/Seasons/${season}.html`);
    const countrySeasons = uniqueMatches(seasonHtml, new RegExp(`href="(${season.replace('-', '\\-')}_[A-Z]+)\\.html"`, 'g'));
    let found = 0;

    for (const cs of countrySeasons) {
      if (done.has(cs)) continue;
      const country = cs.slice(cs.indexOf('_') + 1);
      const csHtml = await fetchPage(`${BASE_URL}/Archive/Seasons/${cs}.html`);
      const lists = uniqueMatches(csHtml, /href="([^"]*_Match_List\.html)"/g);

      for (const list of lists) {
        const code = list.match(/_([a-z]+)_Match_List\.html$/)?.[1] ?? '?';
        const listHtml = await fetchPage(new URL(list, `${BASE_URL}/Archive/Seasons/`).href);
        for (const m of listHtml.matchAll(/href="[^"]*\/Archive\/Scorecards\/\d+\/(\d+)\.html"[^>]*>([^<]*)/g)) {
          const entry = (index[m[1]] ??= { title: m[2].trim(), season, country, lists: [] });
          if (!entry.lists.includes(code)) entry.lists.push(code);
          found++;
        }
      }
      done.add(cs);
    }

    writeFileSync(MATCH_INDEX_FILE, JSON.stringify(index));
    writeFileSync(DISCOVERY_PROGRESS_FILE, JSON.stringify([...done]));
    console.log(`[${si + 1}/${seasons.length}] ${season}: ${countrySeasons.length} countries, ${found} list entries. Index: ${Object.keys(index).length} scorecards`);
  }
}

async function discoverEvents(options: { from?: number; to?: number }): Promise<void> {
  ensureOutDir();
  const index = loadJson<Record<string, MatchIndexEntry>>(MATCH_INDEX_FILE, {});
  const done = new Set(loadJson<string[]>(EVENT_DISCOVERY_PROGRESS_FILE, []));
  const before = Object.keys(index).length;

  const seasonsHtml = await fetchPage(`${BASE_URL}/Archive/Seasons/index.html`);
  const seasons = uniqueMatches(seasonsHtml, /href="(\d{4}(?:-\d{2})?)\.html"/g)
    .filter(s => (options.from === undefined || seasonYear(s) >= options.from) &&
                 (options.to === undefined || seasonYear(s) <= options.to))
    .sort((a, b) => b.localeCompare(a));
  console.log(`Seasons to walk for events: ${seasons.length} (${done.size} events already done)`);

  for (const [si, season] of seasons.entries()) {
    const seasonHtml = await fetchPage(`${BASE_URL}/Archive/Seasons/${season}.html`);
    const countrySeasons = uniqueMatches(seasonHtml, new RegExp(`href="(${season.replace('-', '\\-')}_[A-Z]+)\\.html"`, 'g'));
    let events = 0;
    let added = 0;

    for (const cs of countrySeasons) {
      const country = cs.slice(cs.indexOf('_') + 1);
      const csHtml = await fetchPage(`${BASE_URL}/Archive/Seasons/${cs}.html`);
      const eventLinks = uniqueMatches(csHtml, /href="(\/Archive\/Events\/\d+\/[^"\/]+\.html)"/g).filter(e => !done.has(e));

      await forEachConcurrent(eventLinks, async link => {
        const name = decodeURIComponent(link.slice(link.lastIndexOf('/') + 1, -'.html'.length)).replace(/_/g, ' ');
        try {
          const html = await fetchPage(`${BASE_URL}${link}`, false, { store: false });
          for (const m of html.matchAll(/href="[^"]*\/Archive\/Scorecards\/\d+\/(\d+)\.html"[^>]*>([^<]*)/g)) {
            const entry = index[m[1]];
            if (entry) {
              entry.event ??= name;
            } else {
              index[m[1]] = { title: m[2].trim(), season, country, lists: [], event: name };
              added++;
            }
          }
          done.add(link);
          events++;
        } catch (err) {
          console.error(`  ${link}: ${(err as Error).message.slice(0, 120)}`);
          if (/paywall/i.test((err as Error).message)) throw err;
        }
      });
    }

    writeFileSync(MATCH_INDEX_FILE, JSON.stringify(index));
    writeFileSync(EVENT_DISCOVERY_PROGRESS_FILE, JSON.stringify([...done]));
    console.log(`[${si + 1}/${seasons.length}] ${season}: ${events} events, +${added} scorecards. Index: ${Object.keys(index).length} (+${Object.keys(index).length - before} from events)`);
  }
}

// ── Scraping ─────────────────────────────────────────────────────────────

async function loadScrapedIds(): Promise<Set<number>> {
  const ids = new Set<number>();
  for (const file of [SCORECARDS_FILE, EVENT_SCORECARDS_FILE]) {
    if (!existsSync(file)) continue;
    const raw = createReadStream(file);
    const lines = createInterface({ input: file.endsWith('.gz') ? raw.pipe(createGunzip()) : raw });
    for await (const line of lines) {
      const id = line.match(/^\{"id":(\d+)/)?.[1];
      if (id) ids.add(parseInt(id, 10));
    }
  }
  return ids;
}

function priorityOf(entry: MatchIndexEntry): number {
  if (entry.lists.length === 0) {
    // Event-only cards: after every match-list level
    return LIST_PRIORITY.length + 1 + eventTier(entry.event);
  }
  const ranks = entry.lists.map(code => {
    const i = LIST_PRIORITY.indexOf(code);
    return i === -1 ? LIST_PRIORITY.length : i;
  });
  return Math.min(...ranks);
}

async function scrape(options: { limit?: number; levels?: string[]; events: boolean }): Promise<void> {
  ensureOutDir();
  const index = loadJson<Record<string, MatchIndexEntry>>(MATCH_INDEX_FILE, {});
  if (Object.keys(index).length === 0) throw new Error('No match index; run --step discover first.');
  const scraped = await loadScrapedIds();
  const playersSeen = new Set<number>(loadJson<number[]>(PLAYERS_SEEN_FILE, []));

  const queue = Object.entries(index)
    .map(([id, entry]) => ({ id: parseInt(id, 10), entry }))
    .filter(({ id, entry }) => !scraped.has(id) &&
      (entry.lists.length > 0 || options.events) &&
      (!options.levels || entry.lists.some(c => options.levels!.includes(c))))
    // Priority level first, then newest (highest id) first within a level
    .sort((a, b) => priorityOf(a.entry) - priorityOf(b.entry) || b.id - a.id);

  const total = options.limit ? Math.min(options.limit, queue.length) : queue.length;
  console.log(`Scorecards indexed: ${Object.keys(index).length} | already scraped: ${scraped.size} | to scrape now: ${total}`);

  let ok = 0;
  let failed = 0;
  const start = Date.now();
  // Event-only cards are buffered and appended as gzip members (a valid concatenated .gz)
  let eventBuffer: string[] = [];
  const flushEvents = () => {
    if (eventBuffer.length === 0) return;
    appendFileSync(EVENT_SCORECARDS_FILE, gzipSync(eventBuffer.join('')));
    eventBuffer = [];
  };
  await forEachConcurrent(queue.slice(0, total), async ({ id, entry }) => {
    const url = `${BASE_URL}/Archive/Scorecards/${Math.floor(id / 1000)}/${id}.html`;
    const isEvent = entry.lists.length === 0;
    try {
      const html = await fetchPage(url, false, { store: !isEvent });
      const card = html ? parseScorecard(html, id) : null;
      if (!card) {
        failed++;
      } else {
        if (isEvent) eventBuffer.push(JSON.stringify(card) + '\n');
        else appendFileSync(SCORECARDS_FILE, JSON.stringify(card) + '\n');
        for (const inn of card.innings) {
          for (const b of inn.batting) playersSeen.add(b.player.id);
          for (const b of inn.bowling) playersSeen.add(b.player.id);
        }
        ok++;
      }
    } catch (err) {
      failed++;
      console.error(`  ${id}: ${(err as Error).message.slice(0, 120)}`);
      if (/paywall/i.test((err as Error).message)) throw err;
    }

    const done = ok + failed;
    if (done % 100 === 0 || done === total) {
      flushEvents();
      writeFileSync(PLAYERS_SEEN_FILE, JSON.stringify([...playersSeen]));
      const rate = (done / ((Date.now() - start) / 3_600_000)).toFixed(0);
      console.log(`  [${((done / total) * 100).toFixed(1)}%] ${done}/${total} | OK: ${ok} | Fail: ${failed} | players seen: ${playersSeen.size} | ~${rate}/hr`);
    }
  });
  flushEvents();
  writeFileSync(PLAYERS_SEEN_FILE, JSON.stringify([...playersSeen]));
}

// ── CLI ──────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const step = arg('--step') ?? 'all';
  const from = arg('--from') ? parseInt(arg('--from')!, 10) : undefined;
  const to = arg('--to') ? parseInt(arg('--to')!, 10) : undefined;
  const limit = arg('--limit') ? parseInt(arg('--limit')!, 10) : undefined;
  const levels = arg('--levels')?.split(',');

  const events = !args.includes('--no-events');

  if (step === 'discover' || step === 'all') await discover({ from, to });
  if (step === 'discover-events' || (step === 'all' && events)) await discoverEvents({ from, to });
  if (step === 'scrape' || step === 'all') await scrape({ limit, levels, events });
}

main()
  .catch(err => {
    console.error('Scorecard pipeline failed:', err);
    process.exitCode = 1;
  })
  .finally(closeFetcher);
