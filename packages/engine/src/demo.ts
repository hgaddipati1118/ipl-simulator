/**
 * Quick demo: simulate a full IPL season from the CLI.
 *
 * Usage: npx tsx packages/engine/src/demo.ts
 */

import { Team, IPL_TEAMS } from "./team.js";
import { generatePlayerPool, createPlayerFromData } from "./create-player.js";
import { runAuction } from "./auction.js";
import { runSeason } from "./schedule.js";

// Create teams
const teams = IPL_TEAMS.map(config => new Team(config));

// Seed a few real star players
const stars = [
  { name: "Virat Kohli",    age: 36, country: "India",       battingIQ: 95, timing: 95, power: 82, running: 80, wicketTaking: 12, economy: 10, accuracy: 15, clutch: 92, teamId: "rcb" },
  { name: "Jasprit Bumrah", age: 31, country: "India",       battingIQ: 18, timing: 15, power: 12, running: 22, wicketTaking: 95, economy: 92, accuracy: 90, clutch: 90, teamId: "mi" },
  { name: "Rashid Khan",    age: 26, country: "Afghanistan", battingIQ: 55, timing: 52, power: 62, running: 48, wicketTaking: 92, economy: 88, accuracy: 85, clutch: 88, teamId: "gt" },
  { name: "Suryakumar Yadav",age: 34,country: "India",      battingIQ: 85, timing: 90, power: 88, running: 72, wicketTaking: 10, economy: 8,  accuracy: 12, clutch: 78, teamId: "mi" },
  { name: "Jos Buttler",    age: 34, country: "England",     battingIQ: 85, timing: 88, power: 90, running: 70, wicketTaking: 10, economy: 8,  accuracy: 10, clutch: 80, teamId: "rr" },
];

for (const star of stars) {
  const player = createPlayerFromData(star);
  const team = teams.find(t => t.id === star.teamId);
  if (team) team.addPlayer(player, Math.min(player.marketValue, 15)); // cap pre-auction bids at 15 Cr
}

// Generate random player pool
console.log("Generating player pool...");
const pool = generatePlayerPool(300);

// Run auction
console.log("Running auction...");
const auctionResult = runAuction(pool, teams);
console.log(`Auction complete: ${auctionResult.bids.length} sold, ${auctionResult.unsold.length} unsold`);

for (const team of teams) {
  console.log(`  ${team.shortName}: ${team.roster.length} players, ${team.totalSpent.toFixed(1)}/${team.salaryCap} Cr`);
}

// Run season
console.log("\nSimulating season...");
const result = runSeason(teams);

console.log("\n=== FINAL STANDINGS ===");
for (const [i, s] of result.standings.entries()) {
  const team = teams.find(t => t.id === s.teamId)!;
  console.log(`  ${i + 1}. ${team.shortName.padEnd(5)} W:${s.wins.toString().padStart(2)} L:${s.losses.toString().padStart(2)} Pts:${s.points.toString().padStart(2)} NRR:${s.nrr >= 0 ? "+" : ""}${s.nrr.toFixed(3)}`);
}

const champion = teams.find(t => t.id === result.champion)!;
console.log(`\nCHAMPION: ${champion.name}`);

const allPlayers = teams.flatMap(t => t.roster);
const orangePlayer = allPlayers.find(p => p.id === result.orangeCap.playerId);
const purplePlayer = allPlayers.find(p => p.id === result.purpleCap.playerId);
console.log(`Orange Cap: ${orangePlayer?.name} (${result.orangeCap.runs} runs)`);
console.log(`Purple Cap: ${purplePlayer?.name} (${result.purpleCap.wickets} wickets)`);

// Top performers
console.log("\n=== TOP 10 RUN SCORERS ===");
const topScorers = [...allPlayers].sort((a, b) => b.stats.runs - a.stats.runs).slice(0, 10);
for (const p of topScorers) {
  const team = teams.find(t => t.roster.includes(p))!;
  console.log(`  ${p.name.padEnd(22)} ${team.shortName.padEnd(5)} ${p.stats.runs.toString().padStart(4)} runs  SR ${p.strikeRate.toFixed(1).padStart(6)}`);
}

console.log("\n=== TOP 10 WICKET TAKERS ===");
const topWicket = [...allPlayers].sort((a, b) => b.stats.wickets - a.stats.wickets).slice(0, 10);
for (const p of topWicket) {
  const team = teams.find(t => t.roster.includes(p))!;
  console.log(`  ${p.name.padEnd(22)} ${team.shortName.padEnd(5)} ${p.stats.wickets.toString().padStart(3)} wkts  Econ ${p.economyRate.toFixed(1).padStart(5)}`);
}
