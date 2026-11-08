import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { calculateBattingOverall, calculateBowlingOverall, createPlayerFromData, Player } from "@ipl-sim/engine";
import { ALL_PLAYERS } from "../all-players.js";
import { WPL_PLAYERS } from "../wpl-players.js";
import { getRealPlayers } from "../real-players.js";
import { EXTRA_LEAGUE_IDS, getLeaguePlayers } from "../league-players.js";
import {
  attachFormatRatings, CORE_KEYS, decodeFormatSets, decodeSet, encodeSet, formatRatingsFor, FORMAT_RATINGS_VERSION, type FormatRatingsFile,
} from "../format-ratings.js";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "app", "public", "data", "format-ratings.json");
const file = JSON.parse(readFileSync(FILE, "utf-8")) as FormatRatingsFile;
const byName = (list: typeof ALL_PLAYERS, name: string) => list.find(p => p.name === name)!;
const sets = (id: string) => formatRatingsFor(file, id)!;
const bat = (r: Parameters<typeof calculateBattingOverall>[0]) => calculateBattingOverall(r);
const bowl = (r: Parameters<typeof calculateBowlingOverall>[0]) => calculateBowlingOverall(r);

describe("format ratings: encoding and attaching", () => {
  const ratings = { battingIQ: 90, timing: 85, power: 60, running: 55, wicketTaking: 20, economy: 25, accuracy: 30, clutch: 70 };

  it("round-trips a set and takes fielding / keeping from the player's T20 ratings", () => {
    const enc = encodeSet(ratings, "derived");
    expect(enc).toEqual([90, 85, 60, 55, 20, 25, 30, 70, 0]);
    expect(decodeSet(enc)).toEqual({ ratings, source: "derived" });
    expect(decodeSet(encodeSet(ratings, "data"), { fielding: 61, keeping: 40 })).toEqual({ ratings: { ...ratings, fielding: 61, keeping: 40 }, source: "data" });
    expect(Object.keys(decodeFormatSets([enc, enc]))).toEqual(["odi", "test"]);
    expect(decodeFormatSets([enc, []])).toEqual({ odi: { ratings, source: "derived" } });
  });

  it("attaches by sourceId, keeps sets a player already has, and ignores other file versions", () => {
    const f: FormatRatingsFile = { v: FORMAT_RATINGS_VERSION, generated: "", players: { espn_1: [encodeSet(ratings, "data"), encodeSet(ratings, "derived")] } };
    const a = new Player({ ...createPlayerFromData({ name: "A", age: 25, country: "India", ...ratings, fielding: 55 }), sourceId: "espn_1" });
    const had = { ratings: { ...ratings, battingIQ: 10 }, source: "data" as const };
    const b = new Player({ ...createPlayerFromData({ name: "B", age: 25, country: "India", ...ratings }), sourceId: "espn_1", formatRatings: { odi: had } });
    const c = new Player({ ...createPlayerFromData({ name: "C", age: 25, country: "India", ...ratings }), sourceId: "espn_2" });
    expect(attachFormatRatings([a, b, c], f)).toBe(1);
    expect(a.formatRatings?.odi).toEqual({ ratings: { ...ratings, fielding: 55 }, source: "data" });
    expect(a.forFormat("test").ratings.battingIQ).toBe(90);
    expect(b.formatRatings).toEqual({ odi: had });
    expect(c.formatRatings).toBeUndefined();
    expect(c.forFormat("odi")).toBe(c);
    expect(attachFormatRatings([c], { ...f, v: 99 })).toBe(0);
    expect(attachFormatRatings([c], null)).toBe(0);
  });
});

describe("format ratings: the shipped file", () => {
  it("covers every player the bundled pools and the league squads ship", () => {
    expect(file.v).toBe(FORMAT_RATINGS_VERSION);
    for (const p of [...ALL_PLAYERS, ...WPL_PLAYERS]) expect(file.players[p.id], p.id).toBeDefined();
    for (const league of EXTRA_LEAGUE_IDS) for (const p of getLeaguePlayers(league)) expect(file.players[p.id], `${league} ${p.id}`).toBeDefined();
  });

  it("holds well-formed sets on the 10-99 scale", () => {
    for (const [id, pair] of Object.entries(file.players)) {
      for (const set of pair) {
        expect(set.length, id).toBe(9);
        for (const v of set.slice(0, 8)) expect(v >= 10 && v <= 99, `${id} ${set}`).toBe(true);
        expect([0, 1]).toContain(set[8]);
      }
    }
  });

  it("reaches game players: a real squad player plays ODIs and Tests on his own sets", () => {
    const data = getRealPlayers().find(p => p.name === "Virat Kohli")!;
    const kohli = createPlayerFromData(data);
    expect(attachFormatRatings([kohli], file)).toBe(1);
    expect(kohli.formatRatings?.odi?.source).toBe("data");
    expect(kohli.forFormat("odi").ratings).not.toEqual(kohli.ratings);
    expect(kohli.forFormat("test").ratings.fielding).toBe(kohli.ratings.fielding);
    const restored = Player.fromJSON(JSON.parse(JSON.stringify(kohli.toJSON())));
    expect(restored.formatRatings).toEqual(kohli.formatRatings);
  });

  it("Test specialists rate higher in Tests than in T20; white-ball specialists lower, and derived", () => {
    for (const [name, min] of [["Joe Root", 15], ["Cheteshwar Pujara", 3], ["Marnus Labuschagne", 10], ["Kane Williamson", 5]] as const) {
      const p = byName(ALL_PLAYERS, name);
      expect(bat(sets(p.id).test!.ratings) - bat(p.ratings), name).toBeGreaterThanOrEqual(min);
      expect(sets(p.id).test!.source).toBe("data");
    }
    const lyon = sets(byName(ALL_PLAYERS, "Nathan Lyon").id).test!;
    expect(bowl(lyon.ratings)).toBeGreaterThanOrEqual(75);
    expect(bat(lyon.ratings)).toBeLessThan(45);
    for (const name of ["Andre Russell", "Tim David", "Rovman Powell", "Sherfane Rutherford"]) {
      const p = byName(ALL_PLAYERS, name);
      const t = sets(p.id).test!;
      expect(t.source, name).toBe("derived");
      expect(Math.max(bat(t.ratings), bowl(t.ratings)), name).toBeLessThan(Math.max(bat(p.ratings), bowl(p.ratings)) - 10);
    }
  });

  it("the best ODI and Test bowlers and batters are the established internationals", () => {
    const men = ALL_PLAYERS.map(p => ({ p, s: sets(p.id) }));
    const top = (k: "odi" | "test", f: typeof bat) => men.sort((a, b) => f(b.s[k]!.ratings) - f(a.s[k]!.ratings)).slice(0, 15).map(x => x.p.name);
    expect(top("test", bowl)).toEqual(expect.arrayContaining(["Jasprit Bumrah", "Mitchell Starc", "Pat Cummins"]));
    expect(top("test", bat)).toEqual(expect.arrayContaining(["Joe Root", "Harry Brook", "Steven Smith"]));
    expect(top("odi", bat)).toEqual(expect.arrayContaining(["Shubman Gill", "Virat Kohli"]));
    expect(top("odi", bowl)).toEqual(expect.arrayContaining(["Jasprit Bumrah"]));
  });

  it("keeps the T20 spread: among players rated from data the format overall's median and range match T20's", () => {
    for (const k of ["odi", "test"] as const) {
      const rated = ALL_PLAYERS.filter(p => sets(p.id)[k]!.source === "data");
      const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      const fmt = rated.map(p => Math.max(bat(sets(p.id)[k]!.ratings), bowl(sets(p.id)[k]!.ratings)));
      const t20 = rated.map(p => Math.max(bat(p.ratings), bowl(p.ratings)));
      expect(Math.abs(med(fmt) - med(t20)), k).toBeLessThan(6);
      expect(Math.max(...fmt)).toBeGreaterThanOrEqual(90);
    }
    // every set uses all eight attributes
    for (const p of ALL_PLAYERS.slice(0, 200)) for (const k of CORE_KEYS) expect(typeof sets(p.id).odi!.ratings[k]).toBe("number");
  });
});
