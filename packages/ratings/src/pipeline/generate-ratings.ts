/**
 * Phase 3: Convert scraped player stats into 8-attribute ratings.
 *
 * Reads player-stats.json (from scrape-profiles.ts),
 * feeds stats through calculator.ts,
 * outputs all-players.ts as a TypeScript module.
 *
 * Usage: npx tsx src/pipeline/generate-ratings.ts
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { calculateRatings, inferRole } from "../calculator.js";
import { OUTPUT_DIR } from "./config.js";
import type { ScrapedPlayer } from "./scrape-profiles.js";

const STATS_FILE = join(OUTPUT_DIR, "player-stats.json");
const OUTPUT_TS = join(dirname(OUTPUT_DIR), "..", "src", "all-players.ts");
const OUTPUT_JSON = join(OUTPUT_DIR, "all-players-ratings.json");

interface RatedPlayer {
  id: string;
  name: string;
  fullName: string;
  age: number;
  country: string;
  countryCode: string;
  battingHand: string;
  bowlingStyle: string;
  role: "batsman" | "bowler" | "all-rounder";
  isInternational: boolean;
  ratings: {
    battingIQ: number;
    timing: number;
    power: number;
    running: number;
    wicketTaking: number;
    economy: number;
    accuracy: number;
    clutch: number;
  };
  overalls: {
    battingOvr: number;
    bowlingOvr: number;
    overall: number;
  };
  /** Source stats used to generate ratings (for debugging/validation) */
  sourceStats: {
    t20Matches: number;
    t20Runs: number;
    t20Average: number;
    t20StrikeRate: number;
    t20Wickets: number;
    t20Economy: number;
    iplMatches: number;
    iplRuns: number;
  };
  /** Links to CricketArchive pages for future detailed scraping */
  cricketArchiveLinks: ScrapedPlayer["links"];
}

/**
 * Calculate age from a born string like "5th November 1988, Delhi, India"
 */
function calculateAge(born: string): number {
  const months: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };
  const match = born.match(/(\d+)\w*\s+(\w+)\s+(\d{4})/);
  if (!match) return 28; // default age if unparseable
  const day = parseInt(match[1], 10);
  const month = months[match[2].toLowerCase()] ?? 0;
  const year = parseInt(match[3], 10);
  const dob = new Date(year, month, day);
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  if (now.getMonth() < dob.getMonth() ||
    (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate())) {
    age--;
  }
  return Math.max(16, Math.min(55, age));
}

/**
 * Convert a scraped player's stats to calculator input.
 */
function toCalculatorInput(player: ScrapedPlayer) {
  const bat = player.t20Batting;
  const bowl = player.t20Bowling;

  // Derive ballsFaced from runs and strikeRate
  const ballsFaced = bat && bat.strikeRate > 0
    ? Math.round(bat.runs / (bat.strikeRate / 100))
    : 0;

  // Estimate 4s and 6s from strike rate (CricketArchive career view doesn't show these)
  // Average T20: ~55-65% of runs from boundaries
  const boundaryPct = bat && bat.strikeRate > 0
    ? Math.min(0.75, 0.3 + (bat.strikeRate - 100) * 0.003)
    : 0.55;
  const boundaryRuns = (bat?.runs ?? 0) * boundaryPct;
  const estimatedSixes = Math.round(boundaryRuns * 0.35 / 6);
  const estimatedFours = Math.round(boundaryRuns * 0.65 / 4);

  return {
    name: player.fullName || player.name,
    age: calculateAge(player.born),
    country: player.country,
    matches: bat?.matches ?? 0,
    battingInnings: bat?.innings ?? 0,
    notOuts: bat?.notOuts ?? 0,
    runs: bat?.runs ?? 0,
    ballsFaced,
    fours: estimatedFours,
    sixes: estimatedSixes,
    bowlingInnings: bowl && bowl.balls > 0 ? (bat?.matches ?? 0) : 0,
    ballsBowled: bowl?.balls ?? 0,
    runsConceded: bowl?.runs ?? 0,
    wickets: bowl?.wickets ?? 0,
    catches: bat?.catches ?? 0,
  };
}

/**
 * Generate ratings for all scraped players.
 */
export function generateAllRatings(): RatedPlayer[] {
  if (!existsSync(STATS_FILE)) {
    throw new Error(`Stats file not found at ${STATS_FILE}. Run scrape-profiles.ts first.`);
  }

  const allScraped: ScrapedPlayer[] = JSON.parse(readFileSync(STATS_FILE, "utf-8"));

  // Separate men's and women's
  const menPlayers = allScraped.filter(p => p.gender === "male" || p.gender === "unknown");
  const womenPlayers = allScraped.filter(p => p.gender === "female");

  console.log(`\n=== Generating Ratings ===`);
  console.log(`Total scraped: ${allScraped.length} (men: ${menPlayers.length}, women: ${womenPlayers.length})`);

  // Generate men's ratings (primary output for IPL simulator)
  const players = menPlayers;
  console.log(`Input players: ${players.length}`);

  const rated: RatedPlayer[] = [];

  for (const player of players) {
    // Skip players with very few matches (unreliable stats)
    const matches = player.t20Batting?.matches ?? 0;
    if (matches < 5) continue;

    const input = toCalculatorInput(player);
    const ratings = calculateRatings(input);
    const role = inferRole(ratings);
    const age = calculateAge(player.born);

    rated.push({
      id: `ca_${player.id}`,
      name: player.fullName || player.name,
      fullName: player.fullName,
      age,
      country: player.country,
      countryCode: player.countryCode,
      battingHand: player.battingHand,
      bowlingStyle: player.bowlingStyle,
      role,
      isInternational: player.country !== "India",
      ratings: {
        battingIQ: ratings.battingIQ,
        timing: ratings.timing,
        power: ratings.power,
        running: ratings.running,
        wicketTaking: ratings.wicketTaking,
        economy: ratings.economy,
        accuracy: ratings.accuracy,
        clutch: ratings.clutch,
      },
      overalls: {
        battingOvr: ratings.battingOvr,
        bowlingOvr: ratings.bowlingOvr,
        overall: ratings.overall,
      },
      sourceStats: {
        t20Matches: player.t20Batting?.matches ?? 0,
        t20Runs: player.t20Batting?.runs ?? 0,
        t20Average: player.t20Batting?.average ?? 0,
        t20StrikeRate: player.t20Batting?.strikeRate ?? 0,
        t20Wickets: player.t20Bowling?.wickets ?? 0,
        t20Economy: player.t20Bowling?.economy ?? 0,
        iplMatches: player.iplBatting?.matches ?? 0,
        iplRuns: player.iplBatting?.runs ?? 0,
      },
      cricketArchiveLinks: player.links,
    });
  }

  // Sort by overall rating descending
  rated.sort((a, b) => b.overalls.overall - a.overalls.overall);

  console.log(`Rated players (3+ T20 matches): ${rated.length}`);
  console.log(`Top 10:`);
  for (const p of rated.slice(0, 10)) {
    console.log(`  ${p.overalls.overall} ${p.name} (${p.country}) - ${p.role}`);
  }

  // Save as JSON
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_JSON, JSON.stringify(rated, null, 2), "utf-8");
  console.log(`\nJSON output: ${OUTPUT_JSON}`);

  // Generate TypeScript module
  generateTypeScriptModule(rated);

  return rated;
}

/**
 * Write all-players.ts as a const array.
 */
function generateTypeScriptModule(players: RatedPlayer[]): void {
  const dir = dirname(OUTPUT_TS);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const entries = players.map(p => `  {
    id: ${JSON.stringify(p.id)},
    name: ${JSON.stringify(p.name)},
    age: ${p.age},
    country: ${JSON.stringify(p.country)},
    role: ${JSON.stringify(p.role)},
    ratings: { battingIQ: ${p.ratings.battingIQ}, timing: ${p.ratings.timing}, power: ${p.ratings.power}, running: ${p.ratings.running}, wicketTaking: ${p.ratings.wicketTaking}, economy: ${p.ratings.economy}, accuracy: ${p.ratings.accuracy}, clutch: ${p.ratings.clutch} },
    isInternational: ${p.isInternational},
  }`).join(",\n");

  const content = `/**
 * AUTO-GENERATED — Do not edit manually.
 * Generated by: npx tsx src/pipeline/generate-ratings.ts
 * Source: CricketArchive T20 career stats
 * Players: ${players.length} (T20 active since 2021, 3+ matches)
 * Generated: ${new Date().toISOString()}
 */

import type { PlayerData } from "@ipl-sim/engine";

export const ALL_PLAYERS: Omit<PlayerData, "injured" | "injuryGamesLeft">[] = [
${entries}
];

export const PLAYER_COUNT = ${players.length};
`;

  writeFileSync(OUTPUT_TS, content, "utf-8");
  console.log(`TypeScript output: ${OUTPUT_TS} (${players.length} players)`);
}

// CLI entry point
if (process.argv[1]?.endsWith("generate-ratings.ts") || process.argv[1]?.endsWith("generate-ratings.js")) {
  generateAllRatings();
}
