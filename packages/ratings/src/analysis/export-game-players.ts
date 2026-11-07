/**
 * Dump the game's rated players (men: all-players.ts, women: wpl-players.ts) as one JSON file for the Python
 * analysis scripts (player-generation.py): data/analysis/game_players.json.
 * Run from packages/ratings:  npx tsx src/analysis/export-game-players.ts
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { ALL_PLAYERS } from "../all-players.js";
import { WPL_PLAYERS } from "../wpl-players.js";

const rows = (gender: string, players: typeof ALL_PLAYERS) => players.map(p => ({
  id: p.id, name: p.name, g: gender, age: p.age, country: p.country, role: p.role, wk: !!p.isWicketKeeper,
  bs: p.bowlingStyle, bh: p.battingHand, r: p.ratings, m: p.careerStats?.m ?? 0, team: p.teamId ?? null,
}));
const out = join(import.meta.dirname, "..", "..", "data", "analysis", "game_players.json");
writeFileSync(out, JSON.stringify([...rows("male", ALL_PLAYERS), ...rows("female", WPL_PLAYERS)]));
console.log("wrote", out);
