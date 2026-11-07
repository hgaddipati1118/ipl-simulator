/**
 * Fielding- and keeping-aware playing-XI selection (team.ts autoSelectPlayingXI, xiSelectionValue,
 * keeperSelectionValue; docs/RULES-SQUAD.md "Auto-picked XI").
 */
import { describe, it, expect } from "vitest";
import { Team, IPL_TEAMS, WPL_TEAMS, xiSelectionValue, keeperSelectionValue } from "../team.js";
import { Player, type PlayerData } from "../player.js";
import { pickKeeper, fieldingValueBonus } from "../fielding.js";
import { createPlayerFromData } from "../create-player.js";
import { getRealPlayers, getWPLPlayers } from "@ipl-sim/ratings";

let n = 0;
function mk(role: PlayerData["role"], bat: number, bowl: number, extra: Partial<PlayerData> & { fielding?: number; keeping?: number } = {}): Player {
  const { fielding, keeping, ...rest } = extra;
  return new Player({
    id: `x${++n}`, name: `P${n}`, age: 26, country: "India", role,
    ratings: {
      battingIQ: bat, timing: bat, power: bat, running: 60,
      wicketTaking: bowl, economy: bowl, accuracy: bowl, clutch: 55,
      ...(fielding !== undefined ? { fielding } : {}),
      ...(keeping !== undefined ? { keeping } : {}),
    },
    isInternational: false, injured: false, injuryGamesLeft: 0,
    ...rest,
  });
}

/** Keeper + 4 batters + 2 all-rounders + 4 bowlers = 11; tests add the candidates on top */
function core(team: Team, opts: { keeper?: boolean } = {}): void {
  if (opts.keeper !== false) team.addPlayer(mk("batsman", 72, 25, { isWicketKeeper: true, keeping: 55 }), 1);
  for (let i = 0; i < 4; i++) team.addPlayer(mk("batsman", 80, 25), 1);
  for (let i = 0; i < 2; i++) team.addPlayer(mk("all-rounder", 70, 70), 1);
  for (let i = 0; i < 4; i++) team.addPlayer(mk("bowler", 30, 80), 1);
}

const bowlingOptions = (xi: Player[]) => xi.filter(p => !p.isWicketKeeper && (p.role !== "batsman" || p.effectiveBowlingOvr >= 50)).length;

describe("xiSelectionValue / keeperSelectionValue", () => {
  it("adds the measured worth of fielding, and of keeping only for the keeper value", () => {
    const p = mk("batsman", 75, 25, { fielding: 78, keeping: 70 });
    expect(xiSelectionValue(p)).toBeCloseTo(p.selectionScore + fieldingValueBonus({ fielding: 78 }), 6);
    expect(keeperSelectionValue(p)).toBeCloseTo(p.selectionScore + fieldingValueBonus({ fielding: 78, keeping: 70, isWicketKeeper: true }), 6);
    expect(keeperSelectionValue(p)).toBeGreaterThan(xiSelectionValue(p));
  });

  it("is plain selectionScore for a player with no fielding rating (old saves pick the same XI)", () => {
    const p = mk("batsman", 75, 25);
    expect(xiSelectionValue(p)).toBe(p.selectionScore);
  });
});

describe("auto-picked XI weighs fielding", () => {
  it("between two equal batters, the better fielder plays", () => {
    const team = new Team(IPL_TEAMS[0]);
    core(team);
    // remove one core batter so exactly one of the two candidates gets in
    team.removePlayer(team.roster.find(p => p.role === "batsman" && !p.isWicketKeeper)!.id);
    const slow = mk("batsman", 78, 25, { fielding: 25 });
    const sharp = mk("batsman", 78, 25, { fielding: 80 });
    team.addPlayer(slow, 1); team.addPlayer(sharp, 1);
    const xi = team.autoSelectPlayingXI();
    expect(xi).toContain(sharp);
    expect(xi).not.toContain(slow);
  });

  it("a clearly better batter still beats a better fielder", () => {
    const team = new Team(IPL_TEAMS[0]);
    core(team);
    team.removePlayer(team.roster.find(p => p.role === "batsman" && !p.isWicketKeeper)!.id);
    const bat = mk("batsman", 90, 25, { fielding: 30 });
    const fielder = mk("batsman", 74, 25, { fielding: 85 });
    team.addPlayer(bat, 1); team.addPlayer(fielder, 1);
    const xi = team.autoSelectPlayingXI();
    expect(xi).toContain(bat);
    expect(xi).not.toContain(fielder);
  });

  it("fielding does not displace the bowling core: a poor-fielding front-line bowler keeps his place", () => {
    const team = new Team(IPL_TEAMS[0]);
    core(team);
    // the best bowler in the squad cannot field
    const strike = mk("bowler", 25, 88, { fielding: 15 });
    const fielder = mk("batsman", 76, 25, { fielding: 90 });
    team.addPlayer(strike, 1); team.addPlayer(fielder, 1);
    const xi = team.autoSelectPlayingXI();
    expect(xi).toContain(strike);
    expect(bowlingOptions(xi)).toBeGreaterThanOrEqual(5);
  });
});

describe("auto-picked XI chooses its keeper by keeping", () => {
  it("prefers a specialist gloveman over a slightly better batter who keeps badly", () => {
    const team = new Team(IPL_TEAMS[0]);
    core(team, { keeper: false });
    const batterKeeper = mk("batsman", 76, 25, { isWicketKeeper: true, keeping: 25, fielding: 48 });
    const gloveman = mk("batsman", 73, 25, { isWicketKeeper: true, keeping: 80, fielding: 48 });
    team.addPlayer(batterKeeper, 1); team.addPlayer(gloveman, 1);
    const xi = team.autoSelectPlayingXI();
    expect(xi).toContain(gloveman);
    expect(pickKeeper(xi)).toBe(gloveman);
  });

  it("still picks the batter-keeper when the batting gap is large", () => {
    const team = new Team(IPL_TEAMS[0]);
    core(team, { keeper: false });
    const batterKeeper = mk("batsman", 92, 25, { isWicketKeeper: true, keeping: 40 });
    const gloveman = mk("batsman", 66, 25, { isWicketKeeper: true, keeping: 75 });
    team.addPlayer(batterKeeper, 1); team.addPlayer(gloveman, 1);
    const xi = team.autoSelectPlayingXI();
    expect(xi).toContain(batterKeeper);
    expect(pickKeeper(xi)).toBe(batterKeeper);
  });

  it("a squad with no designated keeper fit brings in the best stand-in by keeping rating", () => {
    const team = new Team(IPL_TEAMS[0]);
    core(team, { keeper: false });
    team.addPlayer(mk("batsman", 70, 25), 1);
    const standIn = mk("batsman", 68, 25, { keeping: 62 });
    team.addPlayer(standIn, 1);
    const xi = team.autoSelectPlayingXI();
    expect(xi).toHaveLength(11);
    expect(pickKeeper(xi)).toBe(standIn);
  });
});

function realTeams(configs: typeof IPL_TEAMS, data: { teamId?: string }[]): Team[] {
  const teams = configs.map(c => new Team(c));
  for (const d of data) {
    const t = teams.find(x => x.id === d.teamId);
    if (t) t.addPlayer(createPlayerFromData(d as never), 1);
  }
  return teams;
}

describe("auto-picked XIs of the real squads", () => {
  for (const [label, configs, data, cap] of [
    ["IPL", IPL_TEAMS, getRealPlayers(), 4],
    ["WPL", WPL_TEAMS, getWPLPlayers(), 5],
  ] as const) {
    it(`${label}: keeper, five bowlers and the overseas cap hold; batting/bowling quality stays, fielding improves`, () => {
      const rated = realTeams(configs, data as never);
      // the same squads with fielding/keeping stripped: the selection the game made before it weighed them
      const blind = realTeams(configs, (data as Record<string, unknown>[]).map(({ fielding: _f, keeping: _k, ...rest }) => rest) as never);
      let fieldGain = 0;
      for (let i = 0; i < rated.length; i++) {
        if (rated[i].roster.length < 11) continue;
        const xi = rated[i].autoSelectPlayingXI(cap);
        expect(xi).toHaveLength(11);
        expect(xi.some(p => p.isWicketKeeper)).toBe(true);
        expect(bowlingOptions(xi)).toBeGreaterThanOrEqual(5);
        expect(xi.filter(p => p.isInternational).length).toBeLessThanOrEqual(cap);
        const oldIds = new Set(blind[i].autoSelectPlayingXI(cap).map(p => p.name));
        const oldXI = rated[i].roster.filter(p => oldIds.has(p.name));
        expect(oldXI).toHaveLength(11);
        const mean = (ps: Player[], f: (p: Player) => number) => ps.reduce((s, p) => s + f(p), 0) / ps.length;
        // batting / bowling quality: within a point of mean overall, and the five best bowlers unchanged in strength
        expect(mean(xi, p => p.overall)).toBeGreaterThan(mean(oldXI, p => p.overall) - 1);
        const top5Bowl = (ps: Player[]) => mean([...ps].sort((a, b) => b.bowlingOvr - a.bowlingOvr).slice(0, 5), p => p.bowlingOvr);
        expect(top5Bowl(xi)).toBeGreaterThan(top5Bowl(oldXI) - 1);
        // value selection maximises (overall + fielding worth) never ends up below the blind pick
        const value = (ps: Player[]) => ps.reduce((s, p) => s + xiSelectionValue(p), 0) + keeperSelectionValue(pickKeeper(ps)!) - xiSelectionValue(pickKeeper(ps)!);
        expect(value(xi)).toBeGreaterThanOrEqual(value(oldXI) - 1e-9);
        fieldGain += mean(xi, p => p.ratings.fielding ?? 50) - mean(oldXI, p => p.ratings.fielding ?? 50);
      }
      expect(fieldGain).toBeGreaterThanOrEqual(0);
    });
  }
});
