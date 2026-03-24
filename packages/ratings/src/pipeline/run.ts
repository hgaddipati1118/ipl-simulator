/**
 * Main pipeline entry point.
 *
 * Usage:
 *   npx tsx src/pipeline/run.ts                        # Full pipeline (cricsheet → scrape matched → ratings)
 *   npx tsx src/pipeline/run.ts --step index           # Only build CricketArchive player index
 *   npx tsx src/pipeline/run.ts --step cricsheet       # Only find players from Cricsheet
 *   npx tsx src/pipeline/run.ts --step scrape          # Scrape matched players from CricketArchive
 *   npx tsx src/pipeline/run.ts --step ratings         # Only generate ratings from scraped data
 *   npx tsx src/pipeline/run.ts --country IND          # Only crawl India index
 *   npx tsx src/pipeline/run.ts --limit 100            # Scrape first 100 players only
 *   npx tsx src/pipeline/run.ts --resume               # Resume from where we left off
 */

import { buildPlayerIndex } from "./build-index.js";
import { scrapeProfiles } from "./scrape-profiles.js";
import { generateAllRatings } from "./generate-ratings.js";
import { findCricsheetPlayers } from "./cricsheet-players.js";

async function main() {
  const args = process.argv.slice(2);
  const step = args.includes("--step") ? args[args.indexOf("--step") + 1] : "all";
  const country = args.includes("--country") ? args[args.indexOf("--country") + 1] : undefined;
  const resume = args.includes("--resume");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : undefined;

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  CricketArchive → IPL Simulator Pipeline     ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`Step: ${step} | Resume: ${resume} | Limit: ${limit ?? "none"}\n`);

  const startTime = Date.now();

  // Step 1: Build CricketArchive player index (crawl country pages)
  if (step === "index") {
    console.log("\n━━━ STEP 1: Building Player Index ━━━");
    await buildPlayerIndex({ countryFilter: country, resume });
  }

  // Step 2: Find T20 players from Cricsheet (2021+)
  if (step === "all" || step === "cricsheet") {
    console.log("\n━━━ STEP 2: Finding T20 Players from Cricsheet ━━━");
    await findCricsheetPlayers();
  }

  // Step 3: Scrape matched players from CricketArchive
  if (step === "all" || step === "scrape") {
    console.log("\n━━━ STEP 3: Scraping Player Profiles (matched only) ━━━");
    await scrapeProfiles({ resume, limit, matched: true });
  }

  // Step 4: Generate ratings
  if (step === "all" || step === "ratings") {
    console.log("\n━━━ STEP 4: Generating Ratings ━━━");
    generateAllRatings();
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n✓ Pipeline complete in ${elapsed} minutes`);
}

main().catch(err => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
