/**
 * National Test squads for the Test engine's tests and benchmark: the most-capped Test players since 2023 (women 2021) with
 * their game ratings (fixtures/test-squads.json, written by packages/ratings/src/analysis/test-match-model.py).
 */
import { readFileSync } from "node:fs";
import { Team } from "../team.js";
import { Player, type PlayerData } from "../player.js";

export interface SquadFixture {
  team: string;
  gender: "male" | "female";
  country: string;
  players: (Partial<PlayerData> & { id: string; name: string; tests: number })[];
}

export const TEST_SQUADS: SquadFixture[] = JSON.parse(readFileSync(new URL("./fixtures/test-squads.json", import.meta.url), "utf8")).squads;

/** A Team for one national squad (gender "female" builds the women's side); `t20Only` drops the players' Test ratings */
export function testTeam(name: string, gender: "male" | "female" = "male", opts: { t20Only?: boolean } = {}): Team {
  const s = TEST_SQUADS.find(x => x.team === name && x.gender === gender);
  if (!s) throw new Error(`No ${gender} squad for ${name}`);
  const id = `${name.toLowerCase().replace(/ /g, "-")}${gender === "female" ? "-w" : ""}`;
  const t = new Team({ id, name: gender === "female" ? `${name} Women` : name, shortName: name.slice(0, 3).toUpperCase(), city: name, primaryColor: "#000000", secondaryColor: "#ffffff" });
  for (const p of s.players) {
    const { formatRatings, ...rest } = p;
    t.addPlayer(new Player({
      ...rest, ...(formatRatings && !opts.t20Only ? { formatRatings } : {}), age: p.age ?? 28, country: name, isInternational: true, injured: false, injuryGamesLeft: 0, ...(gender === "female" ? { isFemale: true } : {}),
    } as PlayerData), 0);
  }
  return t;
}
