/**
 * Scrape full CricketArchive profiles for every player, in priority order:
 *   1. Cricsheet players (2021+ T20, men and women): ids from Cricsheet's people register
 *      plus the name-matched list (matched-players.json)
 *   2. Everyone seen in a scraped scorecard (data/scorecards/players-seen.json)
 *   3. With --all-index: the rest of the 1.6M-player index (mostly club/school cricket)
 *
 * Output: data/archive/profiles.jsonl, one ArchiveProfile per line. Resume skips ids already
 * written; fetch errors are logged and retried on the next run rather than marked done.
 *
 * Usage:
 *   npx tsx src/pipeline/archive-profiles.ts [--limit N] [--all-index]
 */

import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { BASE_URL, INDEX_DIR, OUTPUT_DIR } from './config.js';
import { closeFetcher, fetchPage, forEachConcurrent } from './fetcher.js';
import { parseArchiveProfile } from './archive-profile-parse.js';

const ARCHIVE_DIR = new URL('../../data/archive', import.meta.url).pathname;
const PROFILES_FILE = join(ARCHIVE_DIR, 'profiles.jsonl');
const SCORECARD_PLAYERS_FILE = new URL('../../data/scorecards/players-seen.json', import.meta.url).pathname;

function profileUrl(id: number): string {
  return `${BASE_URL}/Archive/Players/${Math.floor(id / 1000)}/${id}/${id}.html`;
}

async function loadDoneIds(): Promise<Set<number>> {
  const ids = new Set<number>();
  if (!existsSync(PROFILES_FILE)) return ids;
  for await (const line of createInterface({ input: createReadStream(PROFILES_FILE) })) {
    const id = line.match(/^\{"id":(\d+)/)?.[1];
    if (id) ids.add(parseInt(id, 10));
  }
  return ids;
}

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : fallback;
}

async function buildQueue(allIndex: boolean): Promise<{ tier: string; ids: number[] }[]> {
  const cricsheet = new Set<number>();
  for (const p of readJson<{ cricketArchiveId?: number }[]>(join(OUTPUT_DIR, 'cricsheet-players.json'), [])) {
    if (p.cricketArchiveId) cricsheet.add(p.cricketArchiveId);
  }
  for (const p of readJson<{ archiveId: string }[]>(join(OUTPUT_DIR, 'matched-players.json'), [])) {
    cricsheet.add(parseInt(p.archiveId, 10));
  }

  const scorecard = new Set<number>(readJson<number[]>(SCORECARD_PLAYERS_FILE, []));
  for (const id of cricsheet) scorecard.delete(id);

  const tiers = [
    { tier: 'cricsheet', ids: [...cricsheet] },
    { tier: 'scorecards', ids: [...scorecard] },
  ];

  if (allIndex) {
    const rest: number[] = [];
    const indexFile = join(INDEX_DIR, 'player-index.json');
    const seen = new Set([...cricsheet, ...scorecard]);
    for (const key of Object.keys(readJson<Record<string, unknown>>(indexFile, {}))) {
      const id = parseInt(key, 10);
      if (!seen.has(id)) rest.push(id);
    }
    tiers.push({ tier: 'index', ids: rest });
  }
  return tiers;
}

async function main() {
  const args = process.argv.slice(2);
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : Infinity;
  const allIndex = args.includes('--all-index');

  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const done = await loadDoneIds();
  const tiers = await buildQueue(allIndex);
  console.log(`Already scraped: ${done.size}`);
  for (const t of tiers) console.log(`  ${t.tier}: ${t.ids.length} players (${t.ids.filter(id => !done.has(id)).length} to do)`);

  let ok = 0;
  let failed = 0;
  const start = Date.now();
  for (const { tier, ids } of tiers) {
    const todo = ids.filter(id => !done.has(id));
    await forEachConcurrent(todo, async (id) => {
      try {
        const html = await fetchPage(profileUrl(id));
        const profile = html ? parseArchiveProfile(html, id) : null;
        if (profile) {
          appendFileSync(PROFILES_FILE, JSON.stringify(profile) + '\n');
          done.add(id);
          ok++;
        } else {
          failed++;
        }
      } catch (err) {
        failed++;
        console.error(`  ${id}: ${(err as Error).message.slice(0, 120)}`);
        if (/paywall/i.test((err as Error).message)) throw err;
      }
      if ((ok + failed) % 100 === 0) {
        const rate = ((ok + failed) / ((Date.now() - start) / 3_600_000)).toFixed(0);
        console.log(`  [${tier}] OK: ${ok} | Fail: ${failed} | total profiles: ${done.size} | ~${rate}/hr`);
      }
    }, () => ok + failed >= limit);
    if (ok + failed >= limit) return;
    console.log(`Tier ${tier} complete. Total profiles: ${done.size}`);
  }
}

main()
  .catch(err => {
    console.error('Profile scrape failed:', err);
    process.exitCode = 1;
  })
  .finally(closeFetcher);
