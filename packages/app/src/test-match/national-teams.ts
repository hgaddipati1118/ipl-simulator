/**
 * National Test sides from the game's shipped player pool, for the dev route (the International series page brings its own
 * squads): a country's men, with their Test ratings attached from format-ratings.json, the 16 best on Test ratings.
 */

import { Team, createPlayerFromData, type Player } from "@ipl-sim/engine";
import { getRealPlayers, getPoolPlayers } from "@ipl-sim/ratings/dist/real-players.js";
import { attachFormatRatings, type FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";

export interface Nation { name: string; short: string; country: string; color: string }

export const TEST_NATIONS: Nation[] = [
  { name: "India", short: "IND", country: "IND", color: "#3b82f6" },
  { name: "England", short: "ENG", country: "ENG", color: "#ef4444" },
  { name: "Australia", short: "AUS", country: "AUS", color: "#facc15" },
  { name: "South Africa", short: "SA", country: "RSA", color: "#22c55e" },
  { name: "New Zealand", short: "NZ", country: "NZ", color: "#e5e7eb" },
  { name: "Pakistan", short: "PAK", country: "PAK", color: "#10b981" },
  { name: "Sri Lanka", short: "SL", country: "SL", color: "#6366f1" },
  { name: "West Indies", short: "WI", country: "WI", color: "#be123c" },
  { name: "Bangladesh", short: "BAN", country: "BDESH", color: "#16a34a" },
  { name: "Zimbabwe", short: "ZIM", country: "ZIM", color: "#f97316" },
];

/** The 16 best Test players of a country (at least one keeper), as a Team */
export function buildNationalTeam(nation: Nation, formatFile: FormatRatingsFile | null): Team {
  const pool = [...getRealPlayers(), ...getPoolPlayers()].filter(d => d.country === nation.name);
  const players: Player[] = pool.map(d => createPlayerFromData(d));
  attachFormatRatings(players, formatFile);
  const value = (p: Player) => p.forFormat("test").overall;
  const sorted = [...players].sort((a, b) => value(b) - value(a));
  const squad = sorted.slice(0, 16);
  if (!squad.some(p => p.isWicketKeeper)) {
    const keeper = sorted.find(p => p.isWicketKeeper);
    if (keeper) squad[squad.length - 1] = keeper;
  }
  const team = new Team({
    id: `test-${nation.short.toLowerCase()}`, name: nation.name, shortName: nation.short, city: nation.name,
    primaryColor: nation.color, secondaryColor: "#111827",
  });
  for (const p of squad) team.addPlayer(p, 0);
  return team;
}
