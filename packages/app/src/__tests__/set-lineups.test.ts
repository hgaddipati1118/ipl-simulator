/**
 * XIs set for either side of a series (IntlSeries.lineups, the path the user's own XI takes): the engines play exactly these
 * eleven in this batting order, a realistic series does not sample a side that has one, the user's own `lineup` wins, and
 * every format plays them.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import { createSeries, matchContext, seriesFormat, seriesSquads, teamsForMatch, venueFor, type IntlSeries, type SeriesLineup } from "../international";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const FILE = JSON.parse(readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;

const make = (format: "t20i" | "odi" | "test", extra: Partial<Parameters<typeof createSeries>[0]> = {}) =>
  createSeries({ format, gender: "men", nations: ["India", "Australia"], length: 1, host: "a", userSide: null, seed: 5, ...extra }, FILE);

/** An XI of the squad (the last eleven, so it is not the engine's own pick) in reversed batting order */
function oddXI(s: IntlSeries, side: 0 | 1): SeriesLineup {
  const squad = seriesSquads(s, FILE)[side];
  const xi = squad.slice(-11).map(p => p.id);
  if (!squad.slice(-11).some(p => p.isWicketKeeper)) xi[0] = squad.find(p => p.isWicketKeeper)!.id;
  return { xi, order: [...xi].reverse() };
}

describe("XIs set for either side", () => {
  it("a watched side with a set XI fields exactly it, in the set batting order", () => {
    const s0 = make("t20i");
    const l = oddXI(s0, 1);
    const s = { ...s0, lineups: [null, l] as [null, SeriesLineup] };
    const { home, away } = teamsForMatch(s, 0, seriesSquads(s, FILE));
    expect(away.isUserControlled).toBe(true);
    expect(home.isUserControlled).toBe(false);
    expect(away.getPlayingXI().map(p => p.id).sort()).toEqual([...l.xi].sort());
    expect(away.getBattingOrder(away.getPlayingXI()).map(p => p.id)).toEqual(l.order);
  });

  it("the engine plays the set order: the first innings' batters appear in the set order", () => {
    const s0 = make("t20i");
    const l = oddXI(s0, 0);
    const s = { ...s0, lineups: [l, null] as [SeriesLineup, null] };
    const squads = seriesSquads(s, FILE);
    const ctx = matchContext(s, 0, squads);
    const rec = seriesFormat("t20i").simulate(ctx);
    const inn = rec.innings.find(i => i.battingTeamId === s.sides[0].id)!;
    const played = inn.batters.map(b => b.playerId);
    expect(played).toEqual(l.order.slice(0, played.length));
  });

  it("every format plays a set XI (the Test engine too)", () => {
    for (const f of ["odi", "test"] as const) {
      const s0 = make(f);
      const l = oddXI(s0, 0);
      const s = { ...s0, lineups: [l, null] as [SeriesLineup, null] };
      const ctx = matchContext(s, 0, seriesSquads(s, FILE));
      const rec = seriesFormat(f).simulate(ctx);
      const ids = new Set(rec.innings.filter(i => i.battingTeamId === s.sides[0].id).flatMap(i => i.batters.map(b => b.playerId)));
      expect(ids.size).toBeGreaterThan(0);
      for (const id of ids) expect(l.xi).toContain(id);
    }
  });

  it("a realistic series does not sample a side that has a set XI; the other side is still sampled", () => {
    const s0 = make("t20i", { realistic: true });
    expect(s0.realistic).toBe(true);
    const l = oddXI(s0, 0);
    const s = { ...s0, lineups: [l, null] as [SeriesLineup, null] };
    const squads = seriesSquads(s, FILE);
    const { home, away } = teamsForMatch(s, 0, squads);
    expect(home.roster.length).toBe(squads[0].length);
    expect(home.getPlayingXI().map(p => p.id).sort()).toEqual([...l.xi].sort());
    expect(away.roster).toHaveLength(11);
  });

  it("the user's own lineup wins over a lineups entry for his side", () => {
    const s0 = make("t20i", { userSide: 0 });
    const mine = oddXI(s0, 0);
    const other = { xi: seriesSquads(s0, FILE)[0].slice(0, 11).map(p => p.id), order: [] as string[] };
    other.order = other.xi;
    const s = { ...s0, lineup: mine, lineups: [other, null] as [SeriesLineup, null] };
    const { home } = teamsForMatch(s, 0, seriesSquads(s, FILE));
    expect(home.getPlayingXI().map(p => p.id).sort()).toEqual([...mine.xi].sort());
  });

  it("a ground named by the series is the one played at when the host has it", () => {
    const s = make("odi");
    const second = venueFor({ ...s, ground: "x" }, 0);
    expect(second.name).toBe(venueFor(s, 0).name); // no such ground: the busiest one
    const names = [venueFor({ ...s, seedBase: 1 }, 0), venueFor({ ...s, seedBase: 1 }, 1)].map(v => v.name);
    const named = venueFor({ ...s, ground: names[1] }, 0);
    expect(named.name).toBe(names[1]);
  });

  it("an ODI side's tuning and opposition adjust move the ratings the ODI engine reads (Player.forFormat)", () => {
    const s = make("odi");
    const { home, away } = teamsForMatch(s, 0, seriesSquads(s, FILE));
    for (const p of [...home.roster, ...away.roster]) {
      expect(p.forFormat("odi").ratings).toEqual(p.ratings);
      expect(p.forFormat("odi").battingOvr).toBe(p.battingOvr);
    }
  });
});
