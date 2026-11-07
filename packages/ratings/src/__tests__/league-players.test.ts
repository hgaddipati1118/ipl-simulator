import { describe, it, expect } from "vitest";
import {
  getLeaguePlayers, getLeagueMatchStats, getLeagueSeason, registerCaPlayerSource, EXTRA_LEAGUE_IDS, LEAGUE_ROSTERS,
} from "../index.js";
import { EXTRA_LEAGUES as LEAGUE_DEFS } from "@ipl-sim/engine";

const MIN_POOL_MATCH_RATE: Record<string, number> = {
  bbl: 0.95, psl: 0.85, sa20: 0.9, "hundred-m": 0.95, cpl: 0.85, ilt20: 0.9, mlc: 0.9, bpl: 0.8, lpl: 0.9,
  // women's leagues: the pool holds women with 10+ WT20I matches, so domestic-only players are generated
  wbbl: 0.4, "hundred-w": 0.55,
};

describe("league rosters", () => {
  it("covers every extra league defined in the engine", () => {
    expect(EXTRA_LEAGUE_IDS.sort()).toEqual(LEAGUE_DEFS.map(l => l.id).sort());
  });

  it.each(LEAGUE_DEFS.map(l => [l.id, l] as const))("%s: squads fit the league's rules", (id, def) => {
    const rosters = LEAGUE_ROSTERS[id];
    expect(rosters.teams.map(t => t.teamId)).toEqual(def.teams.map(t => t.id));
    expect(getLeagueSeason(id)).toBe(def.season);
    const seenCa = new Set<number>();
    for (const team of rosters.teams) {
      expect(team.players.length, `${team.teamId} squad size`).toBeLessThanOrEqual(def.rules.maxSquadSize);
      expect(team.players.length, `${team.teamId} squad size`).toBeGreaterThanOrEqual(11);
      expect(team.players.some(p => p.keeper), `${team.teamId} has a keeper`).toBe(true);
      let overseas = 0;
      for (const p of team.players) {
        expect(seenCa.has(p.ca), `${p.name} appears on two teams`).toBe(false);
        seenCa.add(p.ca);
        const home = def.homeCountry;
        const isOver = home === "England" ? p.country !== "England" && p.country !== "Wales" : p.country !== home;
        if (isOver) overseas++;
        // unmatched players carry a fallback; matched ones must not
        if (p.fb) {
          expect(p.fb).toHaveLength(8);
          for (const v of p.fb) { expect(v).toBeGreaterThanOrEqual(15); expect(v).toBeLessThanOrEqual(99); }
        }
      }
      expect(overseas, `${team.teamId} overseas in squad`).toBeLessThanOrEqual(def.rules.maxOverseasInSquad);
    }
  });

  it.each(LEAGUE_DEFS.map(l => l.id))("%s: players resolve to pool ids or CricketArchive ids, with sane ratings", (id) => {
    const players = getLeaguePlayers(id);
    const ids = new Set(players.map(p => p.id));
    expect(ids.size).toBe(players.length);
    for (const p of players) {
      expect(p.id).toMatch(/^(espn|ca)_\d+$/);
      expect(p.source === "pool" ? p.id.startsWith("espn_") : p.id.startsWith("ca_")).toBe(true);
      for (const v of [p.battingIQ, p.timing, p.power, p.running, p.wicketTaking, p.economy, p.accuracy, p.clutch]) {
        expect(v).toBeGreaterThanOrEqual(p.source === "fallback" ? 15 : 1); // pool ratings are not floored at 15
        expect(v).toBeLessThanOrEqual(99);
      }
      expect(p.age).toBeGreaterThan(14);
      expect(p.age).toBeLessThan(50);
    }
  });

  it.each(Object.entries(MIN_POOL_MATCH_RATE))("%s: pool match rate is at least %f", (id, min) => {
    const s = getLeagueMatchStats(id);
    expect(s.pool + s.caPool + s.generated).toBe(s.players);
    expect(s.pool / s.players).toBeGreaterThanOrEqual(min);
  });

  it("a registered CricketArchive pool takes over from the generated fallback", () => {
    const before = getLeagueMatchStats("wbbl");
    expect(before.generated).toBeGreaterThan(0);
    try {
      registerCaPlayerSource(({ ca }) => ({
        id: `ca_${ca}`, name: "CA pool player", age: 24, country: "Australia", role: "batsman",
        battingIQ: 60, timing: 60, power: 60, running: 60, wicketTaking: 20, economy: 20, accuracy: 20, clutch: 50,
      }));
      const after = getLeagueMatchStats("wbbl");
      expect(after.generated).toBe(0);
      expect(after.caPool).toBe(before.generated);
    } finally {
      registerCaPlayerSource(null);
    }
    expect(getLeagueMatchStats("wbbl").generated).toBe(before.generated);
  });
});
