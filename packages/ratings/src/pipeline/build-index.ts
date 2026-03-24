/**
 * Phase 1: Crawl CricketArchive country index pages to build a player URL index.
 *
 * Structure:
 *   /Archive/Players/{CODE}.html          → letter links (A-Z)
 *   /Archive/Players/{CODE}_{letter}.html → sub-page links (0, 1, 2...)
 *   /Archive/Players/{CODE}_{letter}{n}.html → player links
 *
 * Output: data/index/player-index.json
 *   { [playerID]: { name, bucket, country, countryCode } }
 *
 * Usage: npx tsx src/pipeline/build-index.ts [--country IND] [--resume]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, writeSync as fsWriteSync, closeSync } from "fs";
import { join } from "path";
import { fetchPage } from "./fetcher.js";
import { BASE_URL, COUNTRY_CODES, INDEX_DIR, PLAYER_SUBPAGES } from "./config.js";

export interface PlayerIndexEntry {
  name: string;
  bucket: string;
  id: string;
  country: string;
  countryCode: string;
  /** Pre-computed links to detailed stat pages */
  links: {
    profile: string;
    statsIndex: string;
    t20Matches: string;
    iplMatches: string;
    t20BattingSeason: string;
    t20BowlingSeason: string;
    iplBattingSeason: string;
    iplBowlingSeason: string;
  };
}

export type PlayerIndex = Record<string, PlayerIndexEntry>;

const INDEX_FILE = join(INDEX_DIR, "player-index.json");
const PROGRESS_FILE = join(INDEX_DIR, "crawl-progress.json");

/** Load existing index (for resume) */
function loadIndex(): PlayerIndex {
  if (existsSync(INDEX_FILE)) {
    return JSON.parse(readFileSync(INDEX_FILE, "utf-8"));
  }
  return {};
}

/** Save index to disk — writes compact JSON to avoid heap overflow */
function saveIndex(index: PlayerIndex): void {
  if (!existsSync(INDEX_DIR)) mkdirSync(INDEX_DIR, { recursive: true });
  // Write in chunks to avoid JSON.stringify heap overflow on 200K+ entries
  const fd = openSync(INDEX_FILE, "w");
  const entries = Object.entries(index);
  fsWriteSync(fd, "{\n");
  for (let i = 0; i < entries.length; i++) {
    const [key, val] = entries[i];
    const line = `${JSON.stringify(key)}:${JSON.stringify(val)}${i < entries.length - 1 ? "," : ""}\n`;
    fsWriteSync(fd, line);
  }
  fsWriteSync(fd, "}");
  closeSync(fd);
}

/** Load/save crawl progress for resuming */
function loadProgress(): Set<string> {
  if (existsSync(PROGRESS_FILE)) {
    return new Set(JSON.parse(readFileSync(PROGRESS_FILE, "utf-8")));
  }
  return new Set();
}

function saveProgress(completed: Set<string>): void {
  if (!existsSync(INDEX_DIR)) mkdirSync(INDEX_DIR, { recursive: true });
  writeFileSync(PROGRESS_FILE, JSON.stringify([...completed]), "utf-8");
}

/**
 * Extract player links from a player list page.
 * Player links match: /Archive/Players/{bucket}/{id}/{id}.html
 */
function extractPlayerLinks(html: string): { name: string; bucket: string; id: string }[] {
  const regex = /href="\/Archive\/Players\/(\d+)\/(\d+)\/\2\.html"[^>]*>([^<]+)<\/a>/g;
  const players: { name: string; bucket: string; id: string }[] = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    players.push({
      bucket: match[1],
      id: match[2],
      name: match[3].trim(),
    });
  }
  return players;
}

/**
 * Extract sub-page links from a letter page.
 * Sub-page links match: {CODE}_{letter}{n}.html
 */
function extractSubPageLinks(html: string, code: string, letter: string): string[] {
  const regex = new RegExp(`href="(${code}_${letter}\\d+\\.html)"`, "gi");
  const links: string[] = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    links.push(match[1]);
  }
  return [...new Set(links)]; // dedupe
}

/**
 * Extract letter links from a country page.
 * Letter links match: {CODE}_{letter}.html
 */
function extractLetterLinks(html: string, code: string): string[] {
  const regex = new RegExp(`href="(${code}_[A-Z]\\.html)"`, "gi");
  const links: string[] = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    links.push(match[1]);
  }
  return [...new Set(links)];
}

/** Build links object for a player */
function buildPlayerLinks(bucket: string, id: string): PlayerIndexEntry["links"] {
  const base = `/Archive/Players/${bucket}/${id}`;
  return {
    profile: `${base}/${id}.html`,
    statsIndex: `${base}/statistics_lists.html`,
    t20Matches: `${base}/Twenty20_Matches.html`,
    iplMatches: `${base}/Indian_Premier_League_Matches.html`,
    t20BattingSeason: `${base}/tt_Batting_by_Season.html`,
    t20BowlingSeason: `${base}/tt_Bowling_by_Season.html`,
    iplBattingSeason: `${base}/ipl_Batting_by_Season.html`,
    iplBowlingSeason: `${base}/ipl_Bowling_by_Season.html`,
  };
}

/**
 * Crawl a single country's player index.
 */
async function crawlCountry(
  code: string,
  countryName: string,
  index: PlayerIndex,
  completedPages: Set<string>,
): Promise<number> {
  let newPlayers = 0;

  // Fetch country page
  const countryUrl = `${BASE_URL}/Archive/Players/${code}.html`;
  const countryHtml = await fetchPage(countryUrl);
  if (!countryHtml) {
    console.warn(`  Skipping ${code}: empty page`);
    return 0;
  }

  // Get letter links
  const letterLinks = extractLetterLinks(countryHtml, code);

  // Some small countries have players directly on the main page (no letter sub-pages)
  if (letterLinks.length === 0) {
    const directPlayers = extractPlayerLinks(countryHtml);
    for (const p of directPlayers) {
      if (!index[p.id]) {
        index[p.id] = {
          name: p.name,
          bucket: p.bucket,
          id: p.id,
          country: countryName,
          countryCode: code,
          links: buildPlayerLinks(p.bucket, p.id),
        };
        newPlayers++;
      }
    }
    return newPlayers;
  }

  for (const letterFile of letterLinks) {
    const letterUrl = `${BASE_URL}/Archive/Players/${letterFile}`;
    const letterHtml = await fetchPage(letterUrl);
    if (!letterHtml) continue;

    // Check for sub-pages
    const letter = letterFile.match(new RegExp(`${code}_([A-Z])`, "i"))?.[1] ?? "";
    const subPageLinks = extractSubPageLinks(letterHtml, code, letter);

    if (subPageLinks.length === 0) {
      // Players are directly on this letter page
      if (completedPages.has(letterUrl)) continue;
      const players = extractPlayerLinks(letterHtml);
      for (const p of players) {
        if (!index[p.id]) {
          index[p.id] = {
            name: p.name,
            bucket: p.bucket,
            id: p.id,
            country: countryName,
            countryCode: code,
            links: buildPlayerLinks(p.bucket, p.id),
          };
          newPlayers++;
        }
      }
      completedPages.add(letterUrl);
    } else {
      // Crawl each sub-page
      for (const subFile of subPageLinks) {
        const subUrl = `${BASE_URL}/Archive/Players/${subFile}`;
        if (completedPages.has(subUrl)) continue;

        const subHtml = await fetchPage(subUrl);
        if (!subHtml) continue;

        const players = extractPlayerLinks(subHtml);
        for (const p of players) {
          if (!index[p.id]) {
            index[p.id] = {
              name: p.name,
              bucket: p.bucket,
              id: p.id,
              country: countryName,
              countryCode: code,
              links: buildPlayerLinks(p.bucket, p.id),
            };
            newPlayers++;
          }
        }
        completedPages.add(subUrl);
      }
    }
  }

  return newPlayers;
}

/**
 * Main: Build the complete player index.
 */
export async function buildPlayerIndex(options?: {
  countryFilter?: string;
  resume?: boolean;
}): Promise<PlayerIndex> {
  const index = options?.resume ? loadIndex() : {};
  const completedPages = options?.resume ? loadProgress() : new Set<string>();

  const countries = options?.countryFilter
    ? COUNTRY_CODES.filter(c => c.code === options.countryFilter)
    : COUNTRY_CODES;

  console.log(`\n=== CricketArchive Player Index Builder ===`);
  console.log(`Countries to crawl: ${countries.length}`);
  console.log(`Existing index entries: ${Object.keys(index).length}`);
  console.log(`Completed pages: ${completedPages.size}\n`);

  for (let i = 0; i < countries.length; i++) {
    const { code, name } = countries[i];
    console.log(`[${i + 1}/${countries.length}] Crawling ${name} (${code})...`);

    try {
      const newCount = await crawlCountry(code, name, index, completedPages);
      console.log(`  → ${newCount} new players (total: ${Object.keys(index).length})`);
    } catch (err) {
      console.error(`  ERROR crawling ${code}: ${(err as Error).message}`);
    }

    // Save progress after each country
    saveIndex(index);
    saveProgress(completedPages);
  }

  console.log(`\n=== Index Complete ===`);
  console.log(`Total players indexed: ${Object.keys(index).length}`);
  saveIndex(index);

  return index;
}

// CLI entry point
if (process.argv[1]?.endsWith("build-index.ts") || process.argv[1]?.endsWith("build-index.js")) {
  const args = process.argv.slice(2);
  const countryFilter = args.includes("--country") ? args[args.indexOf("--country") + 1] : undefined;
  const resume = args.includes("--resume");

  buildPlayerIndex({ countryFilter, resume }).catch(console.error);
}
