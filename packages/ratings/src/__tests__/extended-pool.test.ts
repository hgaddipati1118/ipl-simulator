import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createPlayerFromData } from "@ipl-sim/engine";
import { ALL_PLAYERS } from "../all-players.js";
import { WPL_PLAYERS } from "../wpl-players.js";
import {
  decodeShard, encodeShard, overallsOf, searchPlayers, toRealPlayerData, topActive, POOL_VERSION,
  type ExtendedPlayer, type PoolManifest, type PoolRow, type PoolShard,
} from "../extended-pool.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "app", "public", "pool");
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf-8")) as PoolManifest;
const loadShard = (file: string): ExtendedPlayer[] => decodeShard(JSON.parse(gunzipSync(readFileSync(join(DIR, file))).toString()) as PoolShard);

const byGenderTier = new Map<string, ExtendedPlayer[]>();
for (const s of manifest.shards) {
  const key = `${s.gender}/${s.tier}`;
  byGenderTier.set(key, [...(byGenderTier.get(key) ?? []), ...loadShard(s.file)]);
}
const all = [...byGenderTier.values()].flat();
const group = (gender: string, tier: string) => byGenderTier.get(`${gender}/${tier}`) ?? [];
const ovr = (p: ExtendedPlayer) => overallsOf(p).overall;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))];

describe("extended pool: shards and manifest", () => {
  it("manifest matches the shards", () => {
    expect(manifest.version).toBe(POOL_VERSION);
    for (const s of manifest.shards) {
      expect(loadShard(s.file)).toHaveLength(s.count);
      expect(s.minOverall).toBeLessThanOrEqual(s.topOverall);
    }
  });

  it("has senior CricketArchive-only players of both genders, far beyond the bundled ESPN pool", () => {
    expect(group("men", "senior").length).toBeGreaterThan(15000);
    expect(group("women", "senior").length).toBeGreaterThan(10000);
    // together with the bundled pool, nearly every senior CricketArchive player (37k+) is in the game
    expect(group("men", "senior").length + group("women", "senior").length + ALL_PLAYERS.length + WPL_PLAYERS.length).toBeGreaterThan(37000);
  });

  it("has lower-level players (second XI and below) as separate tiers", () => {
    expect(group("men", "tier0").length).toBeGreaterThan(50000);
    expect(group("men", "tier2").length).toBeGreaterThan(100);
    expect(group("women", "tier0").length).toBeGreaterThan(1000);
  });

  it("every player has a unique ca_<id> id across the whole pool", () => {
    const ids = new Set<string>();
    const bad = all.filter(p => !/^ca_\d+$/.test(p.id));
    for (const p of all) ids.add(p.id);
    expect(bad).toHaveLength(0);
    expect(ids.size).toBe(all.length);
  });

  it("does not duplicate players already in the bundled ESPN pools (same name, country and age)", () => {
    const bundled = new Set([...ALL_PLAYERS, ...WPL_PLAYERS].map(p => `${p.name}|${p.country}|${p.age}`));
    const dupes = all.filter(p => bundled.has(`${p.name}|${p.country}|${p.age}`));
    // two different people can share name, country and age; a real duplicate would show up in the hundreds
    expect(dupes.length).toBeLessThan(25);
  });

  it("ratings are integers in range, ages and roles valid", () => {
    const problems: string[] = [];
    for (const p of all) {
      for (const v of Object.values(p.ratings)) if (!Number.isInteger(v) || v < 1 || v > 99) problems.push(`${p.id} rating ${v}`);
      if (p.age < 15 || p.age > 55) problems.push(`${p.id} age ${p.age}`);
      if (!["batsman", "bowler", "all-rounder"].includes(p.role)) problems.push(`${p.id} role ${p.role}`);
      if (p.lastYear < 2000 || p.lastYear > 2026) problems.push(`${p.id} lastYear ${p.lastYear}`);
      if (!p.country) problems.push(`${p.id} country`);
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it("an all-rounder can both bat and bowl", () => {
    const bad = all.filter(p => {
      if (p.role !== "all-rounder") return false;
      const o = overallsOf(p);
      return Math.abs(o.batting - o.bowling) > 25;
    });
    expect(bad).toHaveLength(0);
  });

  it("decoded players build engine players", () => {
    const sample = [...group("men", "senior").slice(0, 20), ...group("men", "tier2").slice(0, 5), ...group("women", "senior").slice(0, 20)];
    for (const p of sample) {
      const player = createPlayerFromData(toRealPlayerData(p));
      expect(player.name).toBe(p.name);
      expect(player.overall).toBeGreaterThan(0);
    }
  });

  it("encode/decode round-trips", () => {
    const rows: PoolRow[] = [
      { id: 7, name: "A B", age: 30, country: "India", role: "bowler", ratings: [20, 20, 20, 25, 80, 70, 60, 50], bowlingStyle: "off-spin", battingHand: "left", isWicketKeeper: false, matches: 5, runs: 10, average: 2.5, strikeRate: 80, wickets: 9, economy: 5.5, lastYear: 2024 },
      { id: 8, name: "C D", age: 22, country: "England", role: "batsman", ratings: [70, 70, 70, 60, 20, 20, 25, 40], bowlingStyle: "unknown", battingHand: "right", isWicketKeeper: true, matches: 50, runs: 900, average: 30, strikeRate: 120, wickets: 0, economy: 0, lastYear: 2026 },
    ];
    const players = decodeShard(JSON.parse(JSON.stringify(encodeShard("men", "senior", rows))));
    expect(players.map(p => p.id)).toEqual(["ca_7", "ca_8"]);
    expect(players[0]).toMatchObject({ name: "A B", country: "India", isInternational: false, bowlingStyle: "off-spin", battingHand: "left", gender: "men", tier: "senior", lastYear: 2024 });
    expect(players[1]).toMatchObject({ isWicketKeeper: true, isInternational: true, ratings: { battingIQ: 70, clutch: 40 } });
    expect(players[0].isWicketKeeper).toBeUndefined();
  });
});

describe("extended pool: ODI / Test sets (shard version 2)", () => {
  it("every row carries both sets, and they reach the game player", () => {
    expect(manifest.version).toBe(2);
    for (const p of all) {
      expect(p.formatRatings?.odi, p.id).toBeDefined();
      expect(p.formatRatings?.test, p.id).toBeDefined();
    }
    const best = [...group("men", "senior")].sort((a, b) => ovr(b) - ovr(a))[0];
    const player = createPlayerFromData(toRealPlayerData(best));
    expect(player.formatRatings).toEqual(best.formatRatings);
    expect(player.forFormat("test").ratings).toEqual(best.formatRatings!.test!.ratings);
  });

  it("lower-level players are mostly derived and never out-rate the senior extended pool's best", () => {
    const share = (list: ExtendedPlayer[], k: "odi" | "test") => list.filter(p => p.formatRatings![k]!.source === "data").length / list.length;
    expect(share(group("men", "senior"), "test")).toBeGreaterThan(share(group("men", "tier2"), "test"));
    const top = (list: ExtendedPlayer[], k: "odi" | "test") => Math.max(...list.map(p => overallsOf({ ratings: p.formatRatings![k]!.ratings }).overall));
    for (const k of ["odi", "test"] as const) expect(top(group("men", "tier2"), k)).toBeLessThanOrEqual(top(group("men", "senior"), k));
  });

  it("version 1 rows (no format sets) still decode", () => {
    const row: PoolRow = { id: 9, name: "E F", age: 28, country: "Kenya", role: "batsman", ratings: [50, 50, 50, 50, 20, 20, 20, 40], bowlingStyle: "unknown", battingHand: "right", isWicketKeeper: false, matches: 3, runs: 60, average: 20, strikeRate: 90, wickets: 0, economy: 0, lastYear: 2020 };
    const shard = { ...encodeShard("men", "tier2", [row]), v: 1 };
    const [p] = decodeShard(JSON.parse(JSON.stringify(shard)));
    expect(p.formatRatings).toBeUndefined();
    expect(createPlayerFromData(toRealPlayerData(p)).formatRatings).toBeUndefined();
    const withSets = decodeShard(encodeShard("men", "tier2", [{ ...row, formats: [[60, 60, 40, 50, 20, 20, 20, 40, 1], [55, 58, 35, 45, 20, 20, 20, 40, 0]] }]))[0];
    expect(withSets.formatRatings).toEqual({
      odi: { ratings: { battingIQ: 60, timing: 60, power: 40, running: 50, wicketTaking: 20, economy: 20, accuracy: 20, clutch: 40 }, source: "data" },
      test: { ratings: { battingIQ: 55, timing: 58, power: 35, running: 45, wicketTaking: 20, economy: 20, accuracy: 20, clutch: 40 }, source: "derived" },
    });
  });
});

describe("extended pool: sanity of the ratings", () => {
  const espnOvr = (g: "men" | "women") => (g === "men" ? ALL_PLAYERS : WPL_PLAYERS).map(p => overallsOf(p).overall);

  it("senior CricketArchive-only players rate below the bundled ESPN stars, with a believable spread", () => {
    for (const g of ["men", "women"] as const) {
      const senior = group(g, "senior").map(ovr);
      expect(median(senior)).toBeLessThan(median(espnOvr(g)));
      expect(pct(senior, 0.99)).toBeLessThan(pct(espnOvr(g), 1));
      expect(pct(senior, 0.99)).toBeGreaterThan(70);
      expect(pct(senior, 0.1)).toBeLessThan(pct(senior, 0.9));
    }
  });

  it("known senior spot checks", () => {
    const find = (name: string, country: string) => {
      const hits = group("men", "senior").filter(p => p.name === name && p.country === country);
      expect(hits.length).toBeGreaterThanOrEqual(1);
      return hits[0];
    };
    const kumble = find("Anil Kumble", "India");
    expect(overallsOf(kumble).bowling).toBeGreaterThan(70);
    expect(["bowler", "all-rounder"]).toContain(kumble.role);
    const kallis = find("Jacques Kallis", "South Africa");
    expect(kallis.role).toBe("all-rounder");
    expect(ovr(kallis)).toBeGreaterThan(80);
    const watson = find("Shane Watson", "Australia");
    expect(ovr(watson)).toBeGreaterThan(80);
  });

  it("lower-level players rate below senior ones, tier by tier", () => {
    for (const g of ["men", "women"] as const) {
      const senior = median(group(g, "senior").map(ovr));
      for (const tier of ["tier0", "tier2", "tier3", "tier4"]) {
        const ps = group(g, tier);
        if (ps.length < 20) continue;
        expect(median(ps.map(ovr))).toBeLessThan(senior);
      }
    }
  });

  it("a club or lower player never outrates an international: tier ceilings hold", () => {
    const intl = ALL_PLAYERS.filter(p => (p.careerStats?.m ?? 0) >= 100).map(p => overallsOf(p).overall);
    const internationalMedian = median(intl);
    for (const g of ["men", "women"] as const) {
      const bundled = (g === "men" ? ALL_PLAYERS : WPL_PLAYERS).map(e => overallsOf(e)).map(o => Math.max(o.batting, o.bowling));
      const bar = pct(bundled, 0.8);
      const offenders = ["tier2", "tier3", "tier4"].flatMap(t => group(g, t)).filter(p => {
        const o = overallsOf(p);
        return o.overall >= internationalMedian || Math.max(o.batting, o.bowling) >= bar;
      });
      expect(offenders.map(p => p.id)).toEqual([]);
    }
  });

  it("second-XI tier is capped below the senior pool's own best", () => {
    const seniorTop = pct(group("men", "senior").map(ovr), 0.99);
    expect(pct(group("men", "tier0").map(ovr), 0.99)).toBeLessThanOrEqual(seniorTop);
  });
});

describe("extended pool: search and auction extras", () => {
  const seniorMen = group("men", "senior");

  it("search ranks prefix matches first and ignores case and accents", () => {
    const hits = searchPlayers(seniorMen, "shane wat", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].name.toLowerCase().startsWith("shane wat")).toBe(true);
    expect(searchPlayers(seniorMen, "SHANE WAT", 5).map(p => p.id)).toEqual(hits.map(p => p.id));
    expect(searchPlayers(seniorMen, "", 5)).toEqual([]);
  });

  it("topActive returns only active, non-veteran players, best first, and respects the count", () => {
    const top = topActive(seniorMen, 300, 2022, 40);
    expect(top.length).toBe(300);
    for (const p of top) {
      expect(p.lastYear).toBeGreaterThanOrEqual(2022);
      expect(p.age).toBeLessThanOrEqual(40);
    }
    const overalls = top.map(ovr);
    expect([...overalls].sort((a, b) => b - a)).toEqual(overalls);
  });
});
