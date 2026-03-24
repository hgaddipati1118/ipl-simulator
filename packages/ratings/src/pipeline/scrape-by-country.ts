/**
 * Scrape CricketArchive player profiles by country.
 * Goes through the player index for a specific country and fetches profiles
 * for players NOT already scraped via Cricsheet matching.
 *
 * Filters to only keep players with T20 stats active since 2021.
 *
 * Usage:
 *   npx tsx src/pipeline/scrape-by-country.ts IND          # India
 *   npx tsx src/pipeline/scrape-by-country.ts IND --resume  # Resume India
 *   npx tsx src/pipeline/scrape-by-country.ts AUS --limit 500
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream } from "fs";
import { join } from "path";
import { createInterface } from "readline";
import { fetchPage, isCached } from "./fetcher.js";
import { parsePlayerProfile } from "./parse-stats.js";
import { BASE_URL, INDEX_DIR, OUTPUT_DIR } from "./config.js";
import type { PlayerIndexEntry } from "./build-index.js";
import type { ScrapedPlayer } from "./scrape-profiles.js";

const STATS_FILE = join(OUTPUT_DIR, "player-stats.json");
const COUNTRY_PROGRESS_FILE = (code: string) => join(OUTPUT_DIR, `country-progress-${code}.json`);

function loadScrapedStats(): ScrapedPlayer[] {
  if (existsSync(STATS_FILE)) {
    return JSON.parse(readFileSync(STATS_FILE, "utf-8"));
  }
  return [];
}

function saveScrapedStats(stats: ScrapedPlayer[]): void {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), "utf-8");
}

function loadCountryProgress(code: string): Set<string> {
  const file = COUNTRY_PROGRESS_FILE(code);
  if (existsSync(file)) {
    return new Set(JSON.parse(readFileSync(file, "utf-8")));
  }
  return new Set();
}

function saveCountryProgress(code: string, done: Set<string>): void {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(COUNTRY_PROGRESS_FILE(code), JSON.stringify([...done]), "utf-8");
}

/**
 * Stream-load players for a specific country from the index.
 */
async function loadCountryPlayers(countryCode: string): Promise<{ id: string; entry: PlayerIndexEntry }[]> {
  const indexFile = join(INDEX_DIR, "player-index.json");
  if (!existsSync(indexFile)) {
    throw new Error("Player index not found. Run build-index first.");
  }

  const players: { id: string; entry: PlayerIndexEntry }[] = [];
  const rl = createInterface({
    input: createReadStream(indexFile, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim().replace(/,$/, "");
    if (trimmed === "{" || trimmed === "}" || trimmed === "") continue;
    try {
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;
      const key = JSON.parse(trimmed.substring(0, colonIdx));
      const val = JSON.parse(trimmed.substring(colonIdx + 1));
      if (val.countryCode === countryCode) {
        players.push({ id: key, entry: val });
      }
    } catch {
      // skip
    }
  }

  return players;
}

/**
 * Scrape profiles for a specific country.
 */
async function scrapeCountry(
  countryCode: string,
  options?: { resume?: boolean; limit?: number },
): Promise<void> {
  console.log(`\n=== Scraping ${countryCode} from CricketArchive ===\n`);

  // Load country players from index
  console.log(`  Loading ${countryCode} players from index...`);
  const countryPlayers = await loadCountryPlayers(countryCode);
  console.log(`  Found ${countryPlayers.length.toLocaleString()} ${countryCode} players in index`);

  // Load existing scraped players (to skip already-scraped)
  const existing = loadScrapedStats();
  const existingIds = new Set(existing.map(p => p.id));
  console.log(`  Already scraped: ${existingIds.size} players total`);

  // Filter out already-scraped
  const toScrape = countryPlayers.filter(p => !existingIds.has(p.id));
  console.log(`  New to scrape: ${toScrape.length.toLocaleString()}`);

  // Load progress for resume
  const completed = options?.resume ? loadCountryProgress(countryCode) : new Set<string>();
  console.log(`  Previously attempted: ${completed.size}`);

  const limit = options?.limit ?? Infinity;
  let scraped = 0;
  let found = 0;
  const newPlayers: ScrapedPlayer[] = [];

  for (const { id: playerId, entry } of toScrape) {
    if (scraped >= limit) break;
    if (completed.has(playerId)) continue;

    const profileUrl = `${BASE_URL}${entry.links.profile}`;

    try {
      const html = await fetchPage(profileUrl);
      const profile = parsePlayerProfile(html);

      if (profile.hasT20Data && profile.activeSince2021) {
        newPlayers.push({
          id: playerId,
          name: entry.name,
          fullName: profile.bio.fullName || entry.name,
          country: entry.country,
          countryCode: entry.countryCode,
          born: profile.bio.born,
          battingHand: profile.bio.battingHand,
          bowlingStyle: profile.bio.bowlingStyle,
          links: entry.links,
          t20Batting: profile.t20Batting ?? null,
          t20Bowling: profile.t20Bowling ?? null,
          iplBatting: profile.iplBatting ?? null,
          iplBowling: profile.iplBowling ?? null,
          t20iBatting: profile.t20iBatting ?? null,
          t20iBowling: profile.t20iBowling ?? null,
          gender: "male", // CricketArchive country pages are men's by default
        });
        found++;
      }

      completed.add(playerId);
      scraped++;

      if (scraped % 100 === 0) {
        console.log(`  [${countryCode}] Scraped ${scraped}/${Math.min(toScrape.length, limit)} | T20 active: ${found} | New this run: ${newPlayers.length}`);
        // Save periodically
        const allPlayers = [...existing, ...newPlayers];
        saveScrapedStats(allPlayers);
        saveCountryProgress(countryCode, completed);
      }
    } catch (err) {
      console.error(`  ERROR ${entry.name} (${playerId}): ${(err as Error).message}`);
      completed.add(playerId);
    }
  }

  // Final save
  const allPlayers = [...existing, ...newPlayers];
  saveScrapedStats(allPlayers);
  saveCountryProgress(countryCode, completed);

  console.log(`\n=== ${countryCode} Complete ===`);
  console.log(`  Scraped: ${scraped}`);
  console.log(`  T20 active found: ${found}`);
  console.log(`  Total players in dataset: ${allPlayers.length}`);
}

// CLI entry point
const args = process.argv.slice(2);
const countryCode = args.find(a => !a.startsWith("--"));
if (!countryCode) {
  console.error("Usage: npx tsx src/pipeline/scrape-by-country.ts <COUNTRY_CODE> [--resume] [--limit N]");
  console.error("Example: npx tsx src/pipeline/scrape-by-country.ts IND --resume");
  process.exit(1);
}

const resume = args.includes("--resume");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : undefined;

scrapeCountry(countryCode.toUpperCase(), { resume, limit }).catch(console.error);
