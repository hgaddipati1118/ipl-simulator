/**
 * Phase 2: Fetch player profiles from CricketArchive and extract T20 stats.
 *
 * Reads the player index built by build-index.ts, fetches each player's profile page,
 * parses stats, and filters to only T20 players active since 2021.
 *
 * Output: data/scraped/player-stats.json
 *
 * Usage: npx tsx src/pipeline/scrape-profiles.ts [--resume] [--limit 100]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fetchPage, isCached } from "./fetcher.js";
import { parsePlayerProfile, type PlayerProfile, type BattingStats, type BowlingStats } from "./parse-stats.js";
import { BASE_URL, INDEX_DIR, OUTPUT_DIR } from "./config.js";
import type { PlayerIndex, PlayerIndexEntry } from "./build-index.js";

export interface ScrapedPlayer {
  id: string;
  name: string;
  fullName: string;
  country: string;
  countryCode: string;
  born: string;
  battingHand: string;
  bowlingStyle: string;
  /** Links to detailed sub-pages (stored for future use, not fetched now) */
  links: PlayerIndexEntry["links"];
  /** T20 career stats (all T20s) */
  t20Batting: BattingStats | null;
  t20Bowling: BowlingStats | null;
  /** IPL career stats */
  iplBatting: BattingStats | null;
  iplBowling: BowlingStats | null;
  /** T20I career stats */
  t20iBatting: BattingStats | null;
  t20iBowling: BowlingStats | null;
  /** Gender from Cricsheet match data */
  gender: "male" | "female" | "unknown";
}

const STATS_FILE = join(OUTPUT_DIR, "player-stats.json");
const SCRAPE_PROGRESS_FILE = join(OUTPUT_DIR, "scrape-progress.json");

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

function loadScrapeProgress(): Set<string> {
  if (existsSync(SCRAPE_PROGRESS_FILE)) {
    return new Set(JSON.parse(readFileSync(SCRAPE_PROGRESS_FILE, "utf-8")));
  }
  return new Set();
}

function saveScrapeProgress(completed: Set<string>): void {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(SCRAPE_PROGRESS_FILE, JSON.stringify([...completed]), "utf-8");
}

/**
 * Stream-parse the player index JSON line by line using readline.
 * The index is too large (1.1GB) to load as a single string.
 * Our saveIndex writes one entry per line: "playerID":{...}
 */
async function loadPlayerIndex(): Promise<PlayerIndex> {
  const indexFile = join(INDEX_DIR, "player-index.json");
  if (!existsSync(indexFile)) {
    throw new Error(`Player index not found at ${indexFile}. Run build-index.ts first.`);
  }

  const { createReadStream } = await import("fs");
  const { createInterface } = await import("readline");

  const index: PlayerIndex = {};
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
      index[key] = val;
    } catch {
      // Skip malformed lines
    }
  }

  return index;
}

/**
 * Load the matched players list from Cricsheet (much smaller than full index).
 */
function loadMatchedPlayers(): { archiveId: string; name: string; country: string; gender: string; links: PlayerIndexEntry["links"] }[] {
  const matchedFile = join(OUTPUT_DIR, "matched-players.json");
  if (existsSync(matchedFile)) {
    return JSON.parse(readFileSync(matchedFile, "utf-8"));
  }
  return [];
}

/**
 * Scrape player profiles and extract T20 stats.
 */
export async function scrapeProfiles(options?: {
  resume?: boolean;
  limit?: number;
  matched?: boolean;
}): Promise<ScrapedPlayer[]> {
  let index: PlayerIndex;
  let playerIds: string[];
  let genderMap = new Map<string, string>();

  if (options?.matched) {
    // Use the Cricsheet-matched player list (fast: ~5K players instead of 1.6M)
    const matchedPlayers = loadMatchedPlayers();
    if (matchedPlayers.length === 0) {
      throw new Error("No matched players found. Run cricsheet-players.ts first.");
    }
    index = {};
    for (const mp of matchedPlayers) {
      index[mp.archiveId] = {
        name: mp.name,
        bucket: mp.links.profile.split("/")[3],
        id: mp.archiveId,
        country: mp.country,
        countryCode: "",
        links: mp.links,
      };
      genderMap.set(mp.archiveId, mp.gender ?? "unknown");
    }
    playerIds = Object.keys(index);
    console.log(`  Loaded ${playerIds.length.toLocaleString()} matched players (from Cricsheet)`);
  } else {
    console.log("  Loading player index (streaming 1.6M entries)...");
    index = await loadPlayerIndex();
    playerIds = Object.keys(index);
    console.log(`  Index loaded: ${playerIds.length.toLocaleString()} players`);
  }

  const existing = options?.resume ? loadScrapedStats() : [];
  const existingMap = new Map(existing.map(p => [p.id, p]));
  const completed = options?.resume ? loadScrapeProgress() : new Set<string>();

  const results: ScrapedPlayer[] = [...existing];
  const limit = options?.limit ?? Infinity;

  console.log(`\n=== CricketArchive Profile Scraper ===`);
  console.log(`Players in index: ${playerIds.length}`);
  console.log(`Already scraped: ${completed.size}`);
  console.log(`Limit: ${limit === Infinity ? "none" : limit}\n`);

  let scraped = 0;
  let t20Players = 0;
  let skipped = 0;

  for (const playerId of playerIds) {
    if (scraped >= limit) break;
    if (completed.has(playerId)) {
      skipped++;
      continue;
    }

    const entry = index[playerId];
    const profileUrl = `${BASE_URL}${entry.links.profile}`;

    try {
      const html = await fetchPage(profileUrl);
      const profile = parsePlayerProfile(html);

      // Only keep players who have T20 data AND were active since 2021
      if (profile.hasT20Data && profile.activeSince2021) {
        const player: ScrapedPlayer = {
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
          gender: (options?.matched ? (genderMap?.get(playerId) as any) : "unknown") ?? "unknown",
        };

        if (!existingMap.has(playerId)) {
          results.push(player);
        }
        t20Players++;
      }

      completed.add(playerId);
      scraped++;

      // Progress logging
      if (scraped % 50 === 0) {
        console.log(`  Scraped ${scraped}/${playerIds.length - skipped} | T20 active: ${t20Players} | Cached: ${isCached(profileUrl) ? "hit" : "miss"}`);
        // Save progress periodically
        saveScrapedStats(results);
        saveScrapeProgress(completed);
      }
    } catch (err) {
      console.error(`  ERROR scraping ${entry.name} (${playerId}): ${(err as Error).message}`);
      completed.add(playerId); // Mark as attempted to avoid infinite retries
    }
  }

  // Final save
  saveScrapedStats(results);
  saveScrapeProgress(completed);

  console.log(`\n=== Scraping Complete ===`);
  console.log(`Total scraped: ${scraped}`);
  console.log(`T20 players (active since 2021): ${results.length}`);
  console.log(`Output: ${STATS_FILE}`);

  return results;
}

// CLI entry point
if (process.argv[1]?.endsWith("scrape-profiles.ts") || process.argv[1]?.endsWith("scrape-profiles.js")) {
  const args = process.argv.slice(2);
  const resume = args.includes("--resume");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : undefined;

  scrapeProfiles({ resume, limit }).catch(console.error);
}
