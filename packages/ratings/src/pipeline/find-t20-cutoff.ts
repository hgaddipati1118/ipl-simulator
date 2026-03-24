/**
 * Binary search to find the earliest CricketArchive player ID that has T20 data.
 * T20 cricket started in 2003, so players before that era won't have T20 stats.
 *
 * This avoids scraping 100K+ historical players who predate T20 cricket.
 *
 * Usage: npx tsx src/pipeline/find-t20-cutoff.ts IND
 */

import { createReadStream } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import { fetchPage } from "./fetcher.js";
import { parsePlayerProfile } from "./parse-stats.js";
import { BASE_URL, INDEX_DIR } from "./config.js";

/**
 * Load all player IDs for a country, sorted numerically.
 */
async function loadCountryPlayerIds(countryCode: string): Promise<{ id: number; bucket: string; profileUrl: string }[]> {
  const indexFile = join(INDEX_DIR, "player-index.json");
  const players: { id: number; bucket: string; profileUrl: string }[] = [];

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
        players.push({
          id: parseInt(key),
          bucket: val.bucket,
          profileUrl: val.links.profile,
        });
      }
    } catch { /* skip */ }
  }

  return players.sort((a, b) => a.id - b.id);
}

/**
 * Check if a player has T20 data by fetching their profile.
 */
async function hasT20Data(profileUrl: string): Promise<boolean> {
  const html = await fetchPage(`${BASE_URL}${profileUrl}`);
  const profile = parsePlayerProfile(html);
  return profile.hasT20Data;
}

/**
 * Binary search for the first player with T20 data.
 * Returns the index in the sorted array.
 */
async function binarySearchT20Start(
  players: { id: number; bucket: string; profileUrl: string }[],
): Promise<number> {
  let lo = 0;
  let hi = players.length - 1;
  let firstT20 = players.length; // Default: none found

  console.log(`  Binary searching ${players.length.toLocaleString()} players for T20 cutoff...\n`);

  // First, verify the last player has T20 data (otherwise no T20 players at all)
  const lastHasT20 = await hasT20Data(players[hi].profileUrl);
  console.log(`  Last player (ID ${players[hi].id}): T20=${lastHasT20}`);
  if (!lastHasT20) {
    console.log("  No T20 players found in this country!");
    return players.length;
  }

  // Check if the first player already has T20 (all players have T20)
  const firstHasT20 = await hasT20Data(players[lo].profileUrl);
  console.log(`  First player (ID ${players[lo].id}): T20=${firstHasT20}`);
  if (firstHasT20) {
    return 0;
  }

  // Binary search: find transition from no-T20 to T20
  // Note: not perfectly sorted (some old players might have played T20 late in career)
  // So we look for the approximate region where T20 players start appearing
  let iterations = 0;
  while (lo < hi && iterations < 30) {
    iterations++;
    const mid = Math.floor((lo + hi) / 2);
    const midHasT20 = await hasT20Data(players[mid].profileUrl);
    console.log(`  [${iterations}] ID ${players[mid].id} (idx ${mid}): T20=${midHasT20}`);

    if (midHasT20) {
      firstT20 = mid;
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }

  // Go back a bit to catch stragglers (T20 era starts gradually)
  const safeStart = Math.max(0, firstT20 - 500);
  console.log(`\n  First T20 player at index ${firstT20} (ID ${players[firstT20]?.id})`);
  console.log(`  Safe start (with 500 buffer): index ${safeStart} (ID ${players[safeStart]?.id})`);
  console.log(`  Players to skip: ${safeStart.toLocaleString()} of ${players.length.toLocaleString()}`);
  console.log(`  Players to scrape: ${(players.length - safeStart).toLocaleString()}`);

  return safeStart;
}

// CLI
const countryCode = process.argv[2]?.toUpperCase();
if (!countryCode) {
  console.error("Usage: npx tsx src/pipeline/find-t20-cutoff.ts <COUNTRY_CODE>");
  process.exit(1);
}

console.log(`\n=== Finding T20 Cutoff for ${countryCode} ===\n`);
const players = await loadCountryPlayerIds(countryCode);
console.log(`  Total ${countryCode} players: ${players.length.toLocaleString()}`);
console.log(`  ID range: ${players[0]?.id} — ${players[players.length - 1]?.id}\n`);

const cutoffIdx = await binarySearchT20Start(players);

// Save the cutoff for use by the scraper
const cutoffFile = join(INDEX_DIR, `t20-cutoff-${countryCode}.json`);
const { writeFileSync } = await import("fs");
writeFileSync(cutoffFile, JSON.stringify({
  countryCode,
  totalPlayers: players.length,
  cutoffIndex: cutoffIdx,
  cutoffId: players[cutoffIdx]?.id,
  playersToScrape: players.length - cutoffIdx,
  playersToSkip: cutoffIdx,
}), "utf-8");

console.log(`\n  Saved cutoff to ${cutoffFile}`);
