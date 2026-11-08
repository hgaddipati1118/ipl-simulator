/**
 * The national Test squads built the way the game builds its players: the squad members (fixtures/test-squads.json, the
 * most-capped Test players since 2023, women 2021) taken from the shipped pools (ALL_PLAYERS / WPL_PLAYERS) through
 * createPlayerFromData, with their ODI / Test ratings attached from packages/app/public/data/format-ratings.json
 * (attachFormatRatings), as the app does. For the benchmark; unit tests use the fixture's own ratings (test-squads.ts).
 */
import { readFileSync, existsSync } from "node:fs";
import { Team } from "../team.js";
import { createPlayerFromData } from "../create-player.js";
import type { Player } from "../player.js";
import { ALL_PLAYERS } from "../../../ratings/src/all-players.js";
import { WPL_PLAYERS } from "../../../ratings/src/wpl-players.js";
import { attachFormatRatings, type FormatRatingsFile } from "../../../ratings/src/format-ratings.js";
import { TEST_SQUADS } from "./test-squads.js";

const FILE = new URL("../../../app/public/data/format-ratings.json", import.meta.url);
const formatFile: FormatRatingsFile | null = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : null;
type Entry = (typeof ALL_PLAYERS)[number];
const pool = new Map<string, Entry>([...ALL_PLAYERS, ...(WPL_PLAYERS as unknown as Entry[])].map(p => [p.id, p]));

/** A national side from the shipped pool; `t20Only` leaves the Test ratings off (every player on his T20 ratings) */
export function poolTestTeam(name: string, gender: "male" | "female" = "male", opts: { t20Only?: boolean } = {}): { team: Team; missing: string[] } {
  const s = TEST_SQUADS.find(x => x.team === name && x.gender === gender);
  if (!s) throw new Error(`No ${gender} squad for ${name}`);
  const id = `${name.toLowerCase().replace(/ /g, "-")}${gender === "female" ? "-w" : ""}`;
  const team = new Team({ id, name: gender === "female" ? `${name} Women` : name, shortName: name.slice(0, 3).toUpperCase(), city: name, primaryColor: "#000000", secondaryColor: "#ffffff" });
  const players: Player[] = [];
  const missing: string[] = [];
  for (const m of s.players) {
    const e = pool.get(m.id);
    if (!e) { missing.push(m.name); continue; }
    const p = createPlayerFromData({ ...e, ...e.ratings, country: name, isWicketKeeper: e.isWicketKeeper ?? m.isWicketKeeper } as Parameters<typeof createPlayerFromData>[0]);
    if (gender === "female") p.isFemale = true;
    players.push(p);
  }
  if (!opts.t20Only) attachFormatRatings(players, formatFile);
  for (const p of players) team.addPlayer(p, 0);
  return { team, missing };
}

export const HAS_FORMAT_RATINGS = !!formatFile;
