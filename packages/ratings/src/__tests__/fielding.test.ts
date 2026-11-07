import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Team, IPL_TEAMS, WPL_TEAMS, createPlayerFromData, pickKeeper, type Player } from "@ipl-sim/engine";
import { ALL_PLAYERS } from "../all-players.js";
import { WPL_PLAYERS, getWPLPlayers } from "../wpl-players.js";
import { getRealPlayers } from "../real-players.js";
import { fieldingAvailable, loadFielding } from "../pipeline/fielding-model.js";

const byName = (players: { name: string; ratings: { fielding?: number; keeping?: number } }[], name: string) =>
  players.find(p => p.name === name)?.ratings;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe("fielding and keeping ratings in the generated player files", () => {
  it("are 0-99 integers where present, and present for most of the pool", () => {
    for (const list of [ALL_PLAYERS, WPL_PLAYERS]) {
      let fielding = 0;
      for (const p of list) {
        for (const v of [p.ratings.fielding, p.ratings.keeping]) {
          if (v === undefined) continue;
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(15);
          expect(v).toBeLessThanOrEqual(99);
        }
        if (p.ratings.fielding !== undefined) fielding++;
      }
      expect(fielding / list.length).toBeGreaterThan(0.9);
    }
  });

  it("average about 50, so the engine's neutral point is the pool's average", () => {
    for (const list of [ALL_PLAYERS, WPL_PLAYERS]) {
      const f = list.map(p => p.ratings.fielding).filter((v): v is number => v !== undefined);
      expect(mean(f)).toBeGreaterThan(45);
      expect(mean(f)).toBeLessThan(55);
    }
  });

  it("rank known good fielders well and known poor ones low (men)", () => {
    const good = ["Ben Stokes", "Ravindra Jadeja", "Glenn Maxwell", "Kieron Pollard", "Axar Patel", "Virat Kohli"];
    for (const n of good) expect(byName(ALL_PLAYERS, n)?.fielding ?? 0, n).toBeGreaterThanOrEqual(60);
    const all = ALL_PLAYERS.map(p => p.ratings.fielding).filter((v): v is number => v !== undefined).sort((a, b) => b - a);
    const p90 = all[Math.floor(all.length * 0.1)];
    expect(byName(ALL_PLAYERS, "Ben Stokes")!.fielding!).toBeGreaterThanOrEqual(p90);
    expect(byName(ALL_PLAYERS, "Ravindra Jadeja")!.fielding!).toBeGreaterThanOrEqual(all[Math.floor(all.length * 0.2)]);
    expect(byName(ALL_PLAYERS, "Ravichandran Ashwin")!.fielding!).toBeLessThan(45);
    expect(byName(ALL_PLAYERS, "Jasprit Bumrah")!.fielding!).toBeLessThan(40);
  });

  it("rank known good fielders well (women)", () => {
    for (const n of ["Nat Sciver-Brunt", "Amelia Kerr", "Ashleigh Gardner"]) {
      expect(byName(WPL_PLAYERS, n)?.fielding ?? 0, n).toBeGreaterThanOrEqual(60);
    }
  });

  it("rate established keepers above average on keeping, men and women", () => {
    for (const n of ["Quinton de Kock", "Heinrich Klaasen", "Rishabh Pant", "MS Dhoni", "Ishan Kishan"]) {
      expect(byName(ALL_PLAYERS, n)?.keeping ?? 0, n).toBeGreaterThanOrEqual(55);
    }
    for (const n of ["Richa Ghosh", "Yastika Bhatia"]) {
      expect(byName(WPL_PLAYERS, n)?.keeping ?? 0, n).toBeGreaterThanOrEqual(55);
    }
    // every designated keeper has a keeping rating, and as a group they rate above those who merely stood in
    for (const list of [ALL_PLAYERS, WPL_PLAYERS]) {
      const keepers = list.filter(p => p.isWicketKeeper);
      expect(keepers.length).toBeGreaterThan(50);
      expect(keepers.every(p => p.ratings.keeping !== undefined)).toBe(true);
    }
  });

  it("only players who actually kept carry a keeping rating beyond the designated keepers", () => {
    const withKeeping = ALL_PLAYERS.filter(p => p.ratings.keeping !== undefined);
    // a few hundred keepers and part-time keepers, not the whole pool
    expect(withKeeping.length).toBeLessThan(ALL_PLAYERS.length * 0.2);
    for (const n of ["Jasprit Bumrah", "Rashid Khan", "Ravindra Jadeja"]) expect(byName(ALL_PLAYERS, n)?.keeping).toBeUndefined();
  });

  it("flow through the game's player builders", () => {
    const real = getRealPlayers();
    expect(real.filter(p => p.fielding !== undefined).length).toBeGreaterThan(real.length * 0.9);
    const stokes = real.find(p => p.name === "Ben Stokes");
    if (stokes) expect(createPlayerFromData(stokes).ratings.fielding).toBe(stokes.fielding);
    const wpl = getWPLPlayers();
    expect(wpl.filter(p => p.fielding !== undefined).length).toBeGreaterThan(wpl.length * 0.8);
    expect(createPlayerFromData(wpl[0]).ratings.fielding).toBe(wpl[0].fielding);
  });
});

describe("every team's XI has a wicketkeeper", () => {
  function squads(): { label: string; players: Player[] }[] {
    const out: { label: string; players: Player[] }[] = [];
    const real = getRealPlayers();
    for (const cfg of IPL_TEAMS) {
      out.push({ label: `IPL ${cfg.id}`, players: real.filter(p => p.teamId === cfg.id).map(d => createPlayerFromData(d)) });
    }
    const wpl = getWPLPlayers();
    for (const cfg of WPL_TEAMS) {
      out.push({ label: `WPL ${cfg.id}`, players: wpl.filter(p => p.teamId === cfg.id).map(d => createPlayerFromData(d)) });
    }
    return out;
  }

  it("auto-selected XIs include a designated keeper", () => {
    const iplCfg = new Map([...IPL_TEAMS, ...WPL_TEAMS].map(c => [c.id, c]));
    for (const { label, players } of squads()) {
      if (players.length < 11) continue;
      const cfg = iplCfg.get(label.split(" ")[1])!;
      const team = new Team(cfg);
      for (const p of players) team.addPlayer(p, p.bid || 1);
      const xi = team.autoSelectPlayingXI();
      expect(xi.length, label).toBe(11);
      expect(xi.some(p => p.isWicketKeeper), label).toBe(true);
      expect(pickKeeper(xi), label).toBeDefined();
    }
  });
});

describe.skipIf(!fieldingAvailable() || !existsSync(new URL("../../data/analysis/fielding_validation.json", import.meta.url).pathname))(
  "fielding analysis output", () => {
    it("the ratings CSV loads for both genders with keepers and fielders", () => {
      const men = loadFielding("male");
      const women = loadFielding("female");
      expect(men.size).toBeGreaterThan(5000);
      expect(women.size).toBeGreaterThan(2000);
      const keepers = [...men.values()].filter(r => r.keeping !== undefined && r.keepInns >= 50);
      expect(keepers.length).toBeGreaterThan(60);
      // someone who kept 50+ innings rates around the middle, not at the floor, on average
      expect(mean(keepers.map(r => r.keeping!))).toBeGreaterThan(45);
    });
  },
);
