/**
 * Use Cricsheet.org data to identify all players who played T20 cricket since 2021.
 * Downloads match ZIP files, parses JSON, extracts unique player names.
 * Then matches them against our CricketArchive index.
 *
 * This is MUCH faster than scanning all 1.6M CricketArchive profiles —
 * Cricsheet gives us exactly which ~5-8K players are relevant.
 *
 * Usage: npx tsx src/pipeline/cricsheet-players.ts
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, createReadStream } from "fs";
import { join, basename } from "path";
import { createInterface } from "readline";
import { INDEX_DIR, OUTPUT_DIR } from "./config.js";
import type { PlayerIndex, PlayerIndexEntry } from "./build-index.js";

const CRICSHEET_DIR = join(OUTPUT_DIR, "..", "cricsheet");
const CRICSHEET_PLAYERS_FILE = join(OUTPUT_DIR, "cricsheet-players.json");
const MATCHED_PLAYERS_FILE = join(OUTPUT_DIR, "matched-players.json");

/** Cricsheet match ZIP URLs for T20 leagues (names from https://cricsheet.org/downloads/) */
const CRICSHEET_URLS = [
  "https://cricsheet.org/downloads/ipl_json.zip",
  "https://cricsheet.org/downloads/t20s_json.zip",       // T20 Internationals
  "https://cricsheet.org/downloads/bbl_json.zip",
  "https://cricsheet.org/downloads/cpl_json.zip",
  "https://cricsheet.org/downloads/psl_json.zip",
  "https://cricsheet.org/downloads/ntb_json.zip",        // T20 Blast
  "https://cricsheet.org/downloads/sat_json.zip",        // SA20
  "https://cricsheet.org/downloads/ilt_json.zip",        // ILT20
  "https://cricsheet.org/downloads/mlc_json.zip",        // Major League Cricket
  "https://cricsheet.org/downloads/bpl_json.zip",
  "https://cricsheet.org/downloads/lpl_json.zip",
  "https://cricsheet.org/downloads/sma_json.zip",        // Syed Mushtaq Ali Trophy
  "https://cricsheet.org/downloads/hnd_json.zip",        // The Hundred
  "https://cricsheet.org/downloads/wbb_json.zip",        // WBBL
  "https://cricsheet.org/downloads/wpl_json.zip",
];

/** Extract dirs that aren't single competitions (all_json is every match in every format) */
const SKIP_EXTRACT_DIRS = new Set(["all_json"]);

/** Cricsheet's people register: maps its player ids to ESPNcricinfo, CricketArchive, etc. */
const CRICSHEET_REGISTER_URL = "https://cricsheet.org/register/people.csv";

interface CricsheetPlayer {
  name: string;
  registryId?: string;
  /** ESPNcricinfo player id, from Cricsheet's people.csv register */
  cricinfoId?: number;
  /** CricketArchive player id, from Cricsheet's people.csv register */
  cricketArchiveId?: number;
  countries: string[];
  teams: string[];
  matchCount: number;
  lastMatch: string;   // date string
  leagues: string[];
  gender: "male" | "female" | "unknown";
}

/**
 * Download and extract Cricsheet ZIP files.
 */
async function downloadCricsheet(): Promise<void> {
  if (!existsSync(CRICSHEET_DIR)) mkdirSync(CRICSHEET_DIR, { recursive: true });

  // The register changes as players debut, so refresh it every run
  const registerRes = await fetch(CRICSHEET_REGISTER_URL);
  if (registerRes.ok) {
    writeFileSync(join(CRICSHEET_DIR, "people.csv"), await registerRes.text(), "utf-8");
    console.log("  Downloaded people.csv register");
  } else {
    console.error(`  Failed to download people.csv: ${registerRes.status}`);
  }

  for (const url of CRICSHEET_URLS) {
    const zipName = basename(url);
    const extractDir = join(CRICSHEET_DIR, zipName.replace(".zip", ""));

    if (existsSync(extractDir) && readdirSync(extractDir).length > 10) {
      console.log(`  Skip ${zipName} (already extracted: ${readdirSync(extractDir).length} files)`);
      continue;
    }

    console.log(`  Downloading ${zipName}...`);
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`  Failed to download ${url}: ${response.status}`);
      continue;
    }

    // Save ZIP
    const zipPath = join(CRICSHEET_DIR, zipName);
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(zipPath, buffer);
    console.log(`  Downloaded ${zipName} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);

    // Extract using unzip command (simpler than a JS unzip library)
    if (!existsSync(extractDir)) mkdirSync(extractDir, { recursive: true });
    const { execSync } = await import("child_process");
    try {
      execSync(`unzip -o -q "${zipPath}" -d "${extractDir}"`, { timeout: 120000 });
      console.log(`  Extracted to ${extractDir} (${readdirSync(extractDir).length} files)`);
    } catch (err) {
      console.error(`  Failed to extract ${zipName}: ${(err as Error).message}`);
    }
  }
}

/**
 * Parse all Cricsheet JSON match files and extract unique players.
 * Only includes matches from 2021 onwards.
 */
async function extractPlayers(): Promise<Map<string, CricsheetPlayer>> {
  const players = new Map<string, CricsheetPlayer>();

  const extractDirs = readdirSync(CRICSHEET_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !SKIP_EXTRACT_DIRS.has(d.name))
    .map(d => d.name)
    .filter(d => readdirSync(join(CRICSHEET_DIR, d)).some(f => f.endsWith(".json")));

  let totalMatches = 0;
  let matchesSince2021 = 0;

  for (const dir of extractDirs) {
    const league = dir.replace("_json", "");
    const dirPath = join(CRICSHEET_DIR, dir);
    const files = readdirSync(dirPath).filter(f => f.endsWith(".json") && !f.startsWith("README"));

    console.log(`  Processing ${league}: ${files.length} match files...`);

    for (const file of files) {
      try {
        const content = readFileSync(join(dirPath, file), "utf-8");
        const match = JSON.parse(content);
        totalMatches++;

        // Check match date is 2021+
        const dates = match.info?.dates;
        if (!dates || !Array.isArray(dates) || dates.length === 0) continue;
        const matchDate = dates[0]; // "2024-03-22"
        const year = parseInt(matchDate.substring(0, 4));
        if (year < 2021) continue;
        matchesSince2021++;

        // Track gender from match info
        const gender: "male" | "female" | "unknown" = match.info?.gender ?? "unknown";

        const teams = match.info?.teams ?? [];
        const people = match.info?.registry?.people ?? {};
        const seenThisMatch = new Set<string>();

        // Extract players from innings
        for (const inning of (match.innings ?? [])) {
          const team = inning.team ?? "";
          for (const over of (inning.overs ?? [])) {
            for (const delivery of (over.deliveries ?? [])) {
              // Batter
              const batterName = delivery.batter;
              if (batterName) {
                addPlayer(players, batterName, people, team, matchDate, league, teams, gender, seenThisMatch);
              }

              // Bowler
              const bowlerName = delivery.bowler;
              if (bowlerName) {
                const bowlerTeam = teams.find((t: string) => t !== team) ?? "";
                addPlayer(players, bowlerName, people, bowlerTeam, matchDate, league, teams, gender, seenThisMatch);
              }

              // Non-striker
              const nonStriker = delivery.non_striker;
              if (nonStriker) {
                addPlayer(players, nonStriker, people, team, matchDate, league, teams, gender, seenThisMatch);
              }

              // Fielders on wickets
              for (const wkt of (delivery.wickets ?? [])) {
                for (const fielder of (wkt.fielders ?? [])) {
                  if (fielder.name) {
                    addPlayer(players, fielder.name, people, "", matchDate, league, teams, gender, seenThisMatch);
                  }
                }
              }
            }
          }
        }
      } catch {
        // Skip unparseable files
      }
    }
  }

  console.log(`  Total matches: ${totalMatches}, since 2021: ${matchesSince2021}`);
  console.log(`  Unique players found: ${players.size}`);

  return players;
}

function addPlayer(
  players: Map<string, CricsheetPlayer>,
  name: string,
  people: Record<string, any>,
  team: string,
  matchDate: string,
  league: string,
  allTeams: string[],
  gender: "male" | "female" | "unknown",
  seenThisMatch: Set<string>,
): void {
  // Called once per delivery; count each player once per match
  const firstInMatch = !seenThisMatch.has(name);
  seenThisMatch.add(name);
  const existing = players.get(name);
  if (existing) {
    if (firstInMatch) existing.matchCount++;
    if (matchDate > existing.lastMatch) existing.lastMatch = matchDate;
    if (team && !existing.teams.includes(team)) existing.teams.push(team);
    if (league && !existing.leagues.includes(league)) existing.leagues.push(league);
    // Upgrade gender from unknown if we now know
    if (existing.gender === "unknown" && gender !== "unknown") existing.gender = gender;
  } else {
    // match.info.registry.people maps display name -> register identifier string
    const entry = people[name];
    const registryId: string | undefined = typeof entry === "string" ? entry : entry?.identifier;
    players.set(name, {
      name,
      registryId,
      countries: [],
      teams: team ? [team] : [],
      matchCount: 1,
      lastMatch: matchDate,
      leagues: league ? [league] : [],
      gender,
    });
  }
}

/**
 * Match Cricsheet player names against CricketArchive index.
 */
async function matchToArchive(
  cricsheetPlayers: Map<string, CricsheetPlayer>,
): Promise<{ id: string; entry: PlayerIndexEntry; cricsheet: CricsheetPlayer }[]> {
  console.log("\n  Matching against CricketArchive index...");

  // Stream-load the index
  const indexFile = join(INDEX_DIR, "player-index.json");
  if (!existsSync(indexFile)) {
    throw new Error("Player index not found. Run build-index first.");
  }

  // Build a name lookup from the archive index
  const archiveByName = new Map<string, { id: string; entry: PlayerIndexEntry }[]>();

  const rl = createInterface({
    input: createReadStream(indexFile, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  let indexCount = 0;
  for await (const line of rl) {
    const trimmed = line.trim().replace(/,$/, "");
    if (trimmed === "{" || trimmed === "}" || trimmed === "") continue;
    try {
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;
      const key = JSON.parse(trimmed.substring(0, colonIdx));
      const val = JSON.parse(trimmed.substring(colonIdx + 1));
      indexCount++;

      const name = val.name as string;
      const normalizedName = name.toLowerCase().trim();
      if (!archiveByName.has(normalizedName)) {
        archiveByName.set(normalizedName, []);
      }
      archiveByName.get(normalizedName)!.push({ id: key, entry: val });
    } catch {
      // skip
    }
  }
  console.log(`  Archive index loaded: ${indexCount.toLocaleString()} entries`);

  // Also build a last-name lookup for fuzzy matching
  const archiveByLastName = new Map<string, { id: string; entry: PlayerIndexEntry; fullName: string }[]>();
  for (const [normName, entries] of archiveByName) {
    const parts = normName.split(" ");
    const lastName = parts[parts.length - 1];
    if (!archiveByLastName.has(lastName)) {
      archiveByLastName.set(lastName, []);
    }
    for (const e of entries) {
      archiveByLastName.get(lastName)!.push({ ...e, fullName: normName });
    }
  }

  // Match Cricsheet names to archive with multi-strategy matching
  const matched: { id: string; entry: PlayerIndexEntry; cricsheet: CricsheetPlayer }[] = [];
  let unmatched = 0;
  const unmatchedNames: string[] = [];

  for (const [name, cricPlayer] of cricsheetPlayers) {
    const normalizedName = name.toLowerCase().trim();
    let archiveMatch: { id: string; entry: PlayerIndexEntry } | null = null;

    // Strategy 1: Exact match (e.g., "V Kohli" → "V Kohli")
    const exactMatches = archiveByName.get(normalizedName);
    if (exactMatches && exactMatches.length > 0) {
      // Prefer match from same country
      const countryMatch = exactMatches.find(e =>
        cricPlayer.teams.some(t => e.entry.country.toLowerCase().includes(t.toLowerCase().substring(0, 4)))
      );
      archiveMatch = countryMatch ?? exactMatches[0];
    }

    // Strategy 2: Last name + initials match
    if (!archiveMatch) {
      const parts = normalizedName.split(" ");
      const lastName = parts[parts.length - 1];
      const initials = parts.slice(0, -1).map(p => p[0]).filter(Boolean);
      const candidates = archiveByLastName.get(lastName);
      if (candidates) {
        // Score each candidate
        let bestScore = 0;
        for (const c of candidates) {
          let score = 0;
          const cParts = c.fullName.split(" ");
          // Last name matches (we know this)
          score += 5;
          // Check initials match
          const cInitials = cParts.slice(0, -1).map(p => p[0]).filter(Boolean);
          for (const init of initials) {
            if (cInitials.includes(init)) score += 2;
          }
          // Country match bonus
          if (cricPlayer.teams.some(t => c.entry.country.toLowerCase().includes(t.toLowerCase().substring(0, 4)))) {
            score += 3;
          }
          if (score > bestScore) {
            bestScore = score;
            archiveMatch = c;
          }
        }
      }
    }

    // Strategy 3: Full name contains (e.g., "Virat Kohli" in Cricsheet, "V Kohli" in archive)
    if (!archiveMatch) {
      const parts = normalizedName.split(" ");
      if (parts.length >= 2) {
        const lastName = parts[parts.length - 1];
        const firstName = parts[0];
        // Try "firstInitial lastName"
        const initialsName = `${firstName[0]} ${lastName}`;
        const initialMatches = archiveByName.get(initialsName);
        if (initialMatches) {
          archiveMatch = initialMatches[0];
        }
        // Try "firstName lastName" → "fi lastName" (CricketArchive uses initials)
        if (!archiveMatch) {
          for (const [archName, entries] of archiveByName) {
            if (archName.endsWith(lastName) && archName[0] === firstName[0] && archName.length < normalizedName.length + 3) {
              archiveMatch = entries[0];
              break;
            }
          }
        }
      }
    }

    if (archiveMatch) {
      matched.push({ id: archiveMatch.id, entry: archiveMatch.entry, cricsheet: cricPlayer });
    } else {
      unmatched++;
      unmatchedNames.push(name);
    }
  }

  // Log some unmatched for debugging
  if (unmatchedNames.length > 0) {
    console.log(`\n  Sample unmatched players (first 10):`);
    for (const n of unmatchedNames.slice(0, 10)) {
      console.log(`    - ${n}`);
    }
  }

  console.log(`  Matched: ${matched.length}, Unmatched: ${unmatched}`);
  return matched;
}

/**
 * Main entry point.
 */
/**
 * Add ESPNcricinfo / CricketArchive ids from Cricsheet's people register, so both
 * scrapers can look players up directly instead of fuzzy-matching names.
 */
function attachRegisterIds(players: Map<string, CricsheetPlayer>): void {
  const registerPath = join(CRICSHEET_DIR, "people.csv");
  if (!existsSync(registerPath)) {
    console.log("  people.csv missing; skipping register ids");
    return;
  }
  const [header, ...rows] = readFileSync(registerPath, "utf-8").trim().split("\n");
  const cols = header.split(",");
  const idCol = cols.indexOf("identifier");
  const cricinfoCol = cols.indexOf("key_cricinfo");
  const archiveCol = cols.indexOf("key_cricketarchive");
  const byId = new Map<string, string[]>();
  // No field in this file contains commas or quotes, so a plain split is safe
  for (const row of rows) {
    const fields = row.split(",");
    byId.set(fields[idCol], fields);
  }

  let cricinfo = 0;
  let archive = 0;
  for (const player of players.values()) {
    const fields = player.registryId ? byId.get(player.registryId) : undefined;
    if (!fields) continue;
    const ci = parseInt(fields[cricinfoCol], 10);
    const ca = parseInt(fields[archiveCol], 10);
    if (Number.isFinite(ci)) { player.cricinfoId = ci; cricinfo++; }
    if (Number.isFinite(ca)) { player.cricketArchiveId = ca; archive++; }
  }
  console.log(`  Register ids: ${cricinfo} cricinfo, ${archive} cricketarchive (of ${players.size})`);
}

export async function findCricsheetPlayers(): Promise<void> {
  console.log("\n=== Cricsheet Player Finder ===\n");

  // Step 1: Download Cricsheet data
  console.log("Step 1: Downloading Cricsheet T20 data...");
  await downloadCricsheet();

  // Step 2: Extract unique players from 2021+ matches
  console.log("\nStep 2: Extracting players from 2021+ matches...");
  const players = await extractPlayers();
  attachRegisterIds(players);

  // Save cricsheet players
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  const playerArray = [...players.values()];
  writeFileSync(CRICSHEET_PLAYERS_FILE, JSON.stringify(playerArray, null, 2), "utf-8");

  const maleCount = playerArray.filter(p => p.gender === "male").length;
  const femaleCount = playerArray.filter(p => p.gender === "female").length;
  const unknownCount = playerArray.filter(p => p.gender === "unknown").length;
  console.log(`  Saved ${playerArray.length} players (male: ${maleCount}, female: ${femaleCount}, unknown: ${unknownCount})`);

  // Step 3: Match to CricketArchive index
  const matched = await matchToArchive(players);

  // Save matched players — these are the ones we'll scrape profiles for
  writeFileSync(MATCHED_PLAYERS_FILE, JSON.stringify(matched.map(m => ({
    archiveId: m.id,
    name: m.entry.name,
    country: m.entry.country,
    cricsheetName: m.cricsheet.name,
    matchCount: m.cricsheet.matchCount,
    lastMatch: m.cricsheet.lastMatch,
    leagues: m.cricsheet.leagues,
    gender: m.cricsheet.gender,
    links: m.entry.links,
  })), null, 2), "utf-8");

  const matchedMale = matched.filter(m => m.cricsheet.gender === "male").length;
  const matchedFemale = matched.filter(m => m.cricsheet.gender === "female").length;

  console.log(`\n=== Result ===`);
  console.log(`Cricsheet T20 players (2021+): ${players.size} (male: ${maleCount}, female: ${femaleCount})`);
  console.log(`Matched to CricketArchive: ${matched.length} (male: ${matchedMale}, female: ${matchedFemale})`);
  console.log(`Output: ${MATCHED_PLAYERS_FILE}`);
  console.log(`\nNext step: run scrape-profiles to scrape these players from CricketArchive`);
}

// CLI entry point
if (process.argv[1]?.endsWith("cricsheet-players.ts") || process.argv[1]?.endsWith("cricsheet-players.js")) {
  findCricsheetPlayers().catch(console.error);
}
