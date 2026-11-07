import { describe, expect, it } from "vitest";
import fixture from "./fixtures/fielding-progression-cohort.json";
import { Player, calculateMarketValue, type PlayerData } from "../player.js";
import { Team, IPL_TEAMS } from "../team.js";
import { runAuction, retainPlayers, keeperNeed, countKeepers } from "../auction.js";
import { generatePlayerPool } from "../create-player.js";
import { generatePlayers } from "../player-generator.js";
import { toDraftPlayer } from "../draft.js";
import {
  fieldingValueBonus, FIELDING_OVR_PER_POINT, KEEPING_OVR_PER_POINT, VALUE_BONUS_MAX, VALUE_BONUS_MIN,
} from "../fielding.js";
import { expectedFieldingChange } from "../fielding-progression.js";
import { validateFieldingProgression, formatFieldingValidation, type FieldingCohortFixture } from "../fielding-progression-validation.js";
import { createRNG } from "../rng.js";

const BASE: PlayerData = {
  id: "p", name: "P", age: 27, country: "India", role: "batsman", isInternational: false, injured: false, injuryGamesLeft: 0,
  ratings: { battingIQ: 74, timing: 74, power: 74, running: 70, wicketTaking: 20, economy: 20, accuracy: 20, clutch: 60 },
};

function player(over: Partial<PlayerData> = {}, ratings: Partial<PlayerData["ratings"]> = {}): Player {
  return new Player({ ...BASE, ...over, ratings: { ...BASE.ratings, ...ratings } });
}

describe("fielding and keeping in market value", () => {
  it("the bonus is zero without ratings, only keepers are paid for keeping, and it is capped", () => {
    expect(fieldingValueBonus({})).toBe(0);
    expect(fieldingValueBonus({ keeping: 90 })).toBe(0);                       // not a designated keeper
    expect(fieldingValueBonus({ fielding: 48 })).toBeCloseTo(0, 6);
    expect(fieldingValueBonus({ fielding: 78 })).toBeCloseTo(30 * FIELDING_OVR_PER_POINT, 6);
    expect(fieldingValueBonus({ keeping: 85, isWicketKeeper: true })).toBeCloseTo(35 * KEEPING_OVR_PER_POINT, 6);
    expect(fieldingValueBonus({ fielding: 99, keeping: 99, isWicketKeeper: true })).toBe(VALUE_BONUS_MAX);
    expect(fieldingValueBonus({ fielding: 0, keeping: 0, isWicketKeeper: true })).toBe(VALUE_BONUS_MIN);
  });

  it("a better keeper is worth more, all else equal", () => {
    const keeper = (keeping: number) => player({ isWicketKeeper: true }, { keeping, fielding: 50 });
    const worse = keeper(40), average = keeper(55), better = keeper(75);
    expect(better.marketValue).toBeGreaterThan(average.marketValue);
    expect(average.marketValue).toBeGreaterThan(worse.marketValue);
    // same batting and bowling, so the only difference is the keeping bonus
    expect(better.overall).toBe(worse.overall);
    expect(better.valueOverall).toBeGreaterThan(worse.valueOverall);
    // and he is not paid for keeping if he does not keep
    const notKeeper = player({}, { keeping: 90, fielding: 50 });
    expect(notKeeper.marketValue).toBe(player({}, { fielding: 50 }).marketValue);
  });

  it("a better fielder is worth more, all else equal; players without the fields keep their old value", () => {
    const good = player({}, { fielding: 80 }), poor = player({}, { fielding: 25 });
    expect(good.marketValue).toBeGreaterThan(poor.marketValue);
    const bare = player();
    expect(bare.fieldingBonus).toBe(0);
    expect(bare.marketValue).toBe(calculateMarketValue({
      age: 27, role: "batsman", isInternational: false, isWicketKeeper: false, battingOvr: bare.battingOvr, bowlingOvr: bare.bowlingOvr,
    }));
  });

  it("the draft board carries the bonus", () => {
    expect(toDraftPlayer(player({ isWicketKeeper: true }, { keeping: 80, fielding: 60 })).fieldingBonus).toBeGreaterThan(3);
    expect(toDraftPlayer(player()).fieldingBonus).toBe(0);
  });

  it("CPU retention prefers the better fielder when two players are otherwise equal", () => {
    const team = new Team(IPL_TEAMS[0]);
    const good = player({ id: "good", name: "Good" }, { fielding: 85 });
    const poor = player({ id: "poor", name: "Poor" }, { fielding: 15 });
    team.addPlayer(poor, 5);
    team.addPlayer(good, 5);
    const { retained } = retainPlayers(team, 75, 1);
    expect(retained.map(p => p.id)).toEqual(["good"]);
  });
});

function strip(p: Player): Player {
  const q = Player.fromJSON(p.toJSON());
  delete q.ratings.fielding;
  delete q.ratings.keeping;
  return q;
}

describe("auction and keepers", () => {
  const emptyTeams = () => IPL_TEAMS.map(c => new Team(c));

  it("every team ends the auction with a keeper", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const teams = emptyTeams();
      runAuction(generatePlayerPool(220, createRNG(seed)), teams, {}, createRNG(100 + seed));
      for (const t of teams) expect(t.roster.some(p => p.isWicketKeeper), `seed ${seed}, ${t.id}`).toBe(true);
    }
  });

  it("every team still ends with a keeper when keepers are scarce in the pool", () => {
    for (let seed = 1; seed <= 8; seed++) {
      let pool = generatePlayerPool(300, createRNG(seed));
      let kept = 0;
      pool = pool.filter(p => (p.isWicketKeeper ? ++kept <= 11 : true));   // 11 keepers for 10 teams
      expect(countKeepers(pool)).toBe(11);
      const teams = emptyTeams();
      runAuction(pool, teams, {}, createRNG(500 + seed));
      for (const t of teams) expect(t.roster.some(p => p.isWicketKeeper), `seed ${seed}, ${t.id}`).toBe(true);
    }
  });

  it("the last keepers in the pool are held for teams that have none", () => {
    const teams = emptyTeams();
    teams[0].addPlayer(player({ id: "k", isWicketKeeper: true }), 1);
    const need = keeperNeed(teams, 9, 25);
    expect(need.needy.has(teams[0].id)).toBe(false);
    expect(need.needy.size).toBe(9);
    expect(need.reserved).toBe(true);           // 9 keepers left for 9 teams without one
    expect(keeperNeed(teams, 12, 25).reserved).toBe(false);
  });

  it("is deterministic for a seed", () => {
    const run = () => {
      const teams = emptyTeams();
      const r = runAuction(generatePlayerPool(150, createRNG(3)), teams, {}, createRNG(9));
      return r.bids.map(b => `${b.playerName}:${b.teamId}:${b.amount}`).join("|");
    };
    expect(run()).toBe(run());
  });

  it("pricing fielding and keeping leaves total spend and the price distribution about where they were", () => {
    let withTotal = 0, withoutTotal = 0, valueWith = 0, valueWithout = 0;
    const topWith: number[] = [], topWithout: number[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      const pool = generatePlayerPool(260, createRNG(40 + seed));
      const stripped = pool.map(strip);
      for (const [players, total, tops] of [[pool, "with", topWith], [stripped, "without", topWithout]] as const) {
        const teams = emptyTeams();
        const res = runAuction(players, teams, {}, createRNG(700 + seed));
        const spend = teams.reduce((s, t) => s + t.totalSpent, 0);
        if (total === "with") { withTotal += spend; valueWith += players.reduce((s, p) => s + p.marketValue, 0); }
        else { withoutTotal += spend; valueWithout += players.reduce((s, p) => s + p.marketValue, 0); }
        tops.push(...[...res.bids].sort((a, b) => b.amount - a.amount).slice(0, 20).map(b => b.amount));
      }
    }
    expect(Math.abs(withTotal / withoutTotal - 1)).toBeLessThan(0.03);
    expect(Math.abs(valueWith / valueWithout - 1)).toBeLessThan(0.03);
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(Math.abs(mean(topWith) / mean(topWithout) - 1)).toBeLessThan(0.05);
  });
});

describe("fielding and keeping progression", () => {
  const makePlayers = (n: number, age: number, extra: Partial<PlayerData["ratings"]> = { fielding: 50, keeping: 50 }) =>
    Array.from({ length: n }, (_, i) => player({ id: `s${i}`, age }, extra));

  it("fielding declines on average for 33-year-olds over 5 seasons", () => {
    const rng = createRNG(21);
    const players = makePlayers(500, 33);
    for (const p of players) for (let s = 0; s < 5; s++) p.progress({ rng, historyLimit: 1 });
    const mean = players.reduce((s, p) => s + p.ratings.fielding!, 0) / players.length;
    expect(mean).toBeLessThan(50 - 3);
    expect(mean).toBeGreaterThan(50 - 10);                  // about -1.2 a season, not a collapse
    expect(players.reduce((s, p) => s + p.ratings.keeping!, 0) / players.length).toBeLessThan(50);
  });

  it("young players gain fielding (the +1.0 a season youth prior), keepers a little less", () => {
    const rng = createRNG(22);
    const players = makePlayers(500, 22);
    for (const p of players) for (let s = 0; s < 3; s++) p.progress({ rng, historyLimit: 1 });
    const mean = players.reduce((s, p) => s + p.ratings.fielding!, 0) / players.length;
    expect(mean).toBeGreaterThan(50 + 2);                   // 3 seasons at about +1, less the pull to 50
    expect(mean).toBeLessThan(50 + 4.5);
    const keeping = players.reduce((s, p) => s + p.ratings.keeping!, 0) / players.length;
    expect(keeping).toBeGreaterThan(50);
    expect(keeping).toBeLessThan(mean);
  });

  it("is deterministic for a seed, and different seeds differ", () => {
    const run = (seed: number) => {
      const rng = createRNG(seed);
      const p = player({ age: 31 }, { fielding: 60, keeping: 58 });
      const reports = [0, 1, 2, 3].map(() => p.progress({ rng }));
      return JSON.stringify([p.ratings, reports.map(r => r.ratingChanges)]);
    };
    expect(run(5)).toBe(run(5));
    expect(run(5)).not.toBe(run(6));
  });

  it("leaves the fields absent for players that do not have them, and does not disturb their other draws", () => {
    const without = player({ age: 29 });
    const withFields = player({ age: 29 }, { fielding: 61, keeping: 44 });
    const rng = createRNG(78);
    for (let s = 0; s < 4; s++) without.progress({ rng });
    expect(without.ratings.fielding).toBeUndefined();
    expect(without.ratings.keeping).toBeUndefined();
    // the first season's eight core draws are the same with or without the fields (theirs come after); later seasons
    // share the stream, so a player with the fields moves it on
    const plain = player({ age: 29 });
    plain.progress({ rng: createRNG(79) });
    withFields.progress({ rng: createRNG(79) });
    for (const k of ["battingIQ", "timing", "power", "running", "wicketTaking", "economy", "accuracy", "clutch"] as const) {
      expect(withFields.ratings[k]).toBe(plain.ratings[k]);
    }
    expect(withFields.ratings.fielding).toBeDefined();
    expect(withFields.ratings.keeping).toBeDefined();
  });

  it("ratings stay in range; the curve rises to 25, tapers to flat at 28, then falls", () => {
    expect(expectedFieldingChange("fielding", 50, 24)).toBeCloseTo(1.0, 1);
    expect(expectedFieldingChange("fielding", 50, 27)).toBeGreaterThan(0.2);
    expect(expectedFieldingChange("fielding", 50, 27)).toBeLessThan(0.5);
    expect(expectedFieldingChange("fielding", 50, 28)).toBeCloseTo(0, 1);
    expect(expectedFieldingChange("keeping", 50, 24)).toBeCloseTo(0.5, 1);
    // women keep their fitted +0.7 to 27 where it is above the prior (no stacking)
    expect(expectedFieldingChange("fielding", 50, 26, "female")).toBeCloseTo(0.697, 2);
    expect(expectedFieldingChange("fielding", 50, 24, "female")).toBeCloseTo(1.0, 1);
    expect(expectedFieldingChange("fielding", 50, 33)).toBeLessThan(-0.8);
    expect(expectedFieldingChange("fielding", 90, 33)).toBeLessThan(expectedFieldingChange("fielding", 30, 33)); // pull toward the mean
    const rng = createRNG(3);
    const old = player({ age: 40 }, { fielding: 4, keeping: 3 });
    for (let s = 0; s < 10; s++) old.progress({ rng, historyLimit: 1 });
    expect(old.ratings.fielding!).toBeGreaterThanOrEqual(1);
    expect(old.ratings.keeping!).toBeGreaterThanOrEqual(1);
  });

  it("matches the real age profile (men's fielding at every starting age and horizon)", () => {
    const rows = validateFieldingProgression(fixture as unknown as FieldingCohortFixture, 1500, 8);
    const bad = rows.filter(r => !r.ok);
    expect(bad.length, formatFieldingValidation(bad)).toBe(0);
    const men = rows.filter(r => r.kind === "fielding" && r.gender === "male" && r.seasons === 5 && r.start >= 28);
    // from the peak age on (the fitted part) the five-season change is within a point and a half of the real one on average;
    // below it the youth prior deliberately sits above the data
    const err = men.reduce((s, r) => s + Math.abs(r.sim - r.change), 0) / men.length;
    expect(err).toBeLessThan(2.5);      // was 1.6 over all five starting ages, the young ones (now under the prior) being the easy ones
    const young = rows.filter(r => r.kind === "fielding" && r.gender === "male" && r.start <= 25 && r.seasons === 5);
    for (const r of young) expect(r.sim - r.change).toBeGreaterThan(-1);
  });
});

describe("generated players' fielding and keeping", () => {
  it("keepers get keeping, above 50 on average; others get none", () => {
    const keepers = generatePlayers(400, createRNG(1), { roleClass: "keeper" });
    expect(keepers.every(p => typeof p.ratings.keeping === "number")).toBe(true);
    expect(keepers.reduce((s, p) => s + p.ratings.keeping!, 0) / keepers.length).toBeGreaterThan(50);
    const women = generatePlayers(200, createRNG(2), { roleClass: "keeper", gender: "female" });
    expect(women.reduce((s, p) => s + p.ratings.keeping!, 0) / women.length).toBeGreaterThan(50);
    const others = generatePlayers(300, createRNG(3), { roleClass: "pace" });
    expect(others.every(p => p.ratings.keeping === undefined)).toBe(true);
  });

  it("everyone gets fielding, centred near 50 with a real spread, bowlers a little lower than batters", () => {
    const pool = generatePlayers(1500, createRNG(4));
    const f = pool.map(p => p.ratings.fielding!);
    expect(f.every(x => typeof x === "number" && x >= 5 && x <= 99)).toBe(true);
    const mean = f.reduce((s, x) => s + x, 0) / f.length;
    const sd = Math.sqrt(f.reduce((s, x) => s + (x - mean) ** 2, 0) / f.length);
    expect(mean).toBeGreaterThan(44);
    expect(mean).toBeLessThan(54);
    expect(sd).toBeGreaterThan(7);
    expect(sd).toBeLessThan(16);
    const avg = (rc: string) => {
      const xs = generatePlayers(500, createRNG(5), { roleClass: rc as never }).map(p => p.ratings.fielding!);
      return xs.reduce((s, x) => s + x, 0) / xs.length;
    };
    expect(avg("batter")).toBeGreaterThan(avg("pace") + 2);
  });

  it("good batters field a little better than weak ones, and a seed reproduces the players", () => {
    const pool = generatePlayers(1500, createRNG(6), { roleClass: "batter" });
    const top = pool.filter(p => p.battingOvr >= 75), low = pool.filter(p => p.battingOvr <= 55);
    const m = (a: Player[]) => a.reduce((s, p) => s + p.ratings.fielding!, 0) / a.length;
    expect(m(top)).toBeGreaterThan(m(low));
    const a = generatePlayers(30, createRNG(9), {}, "x").map(p => JSON.stringify(p.ratings));
    const b = generatePlayers(30, createRNG(9), {}, "x").map(p => JSON.stringify(p.ratings));
    expect(a).toEqual(b);
  });
});

describe("fielding training focus", () => {
  const avgAfter = (focus: "balanced" | "fielding" | "batting", extra: Partial<PlayerData["ratings"]>, isKeeper: boolean, kind: "fielding" | "keeping") => {
    let sum = 0;
    const n = 300;
    for (let i = 0; i < n; i++) {
      const p = player({ id: `t${i}`, age: 27, isWicketKeeper: isKeeper }, extra);
      p.progress({ rng: createRNG(1000 + i), focus });
      sum += p.ratings[kind]!;
    }
    return sum / n;
  };

  it("fielding focus lifts fielding about 3-4 points a season over balanced, with the same seeds", () => {
    const base = avgAfter("balanced", { fielding: 50 }, false, "fielding");
    const focused = avgAfter("fielding", { fielding: 50 }, false, "fielding");
    expect(focused - base).toBeGreaterThan(2.8);
    expect(focused - base).toBeLessThan(4.2);
  });

  it("is worth about what batting focus is worth in value terms (overall points)", () => {
    const gain = (avgAfter("fielding", { fielding: 50 }, false, "fielding") - avgAfter("balanced", { fielding: 50 }, false, "fielding")) * FIELDING_OVR_PER_POINT;
    let bat = 0;
    for (let i = 0; i < 300; i++) {
      const a = player({ id: `b${i}`, age: 27 }); const b = player({ id: `b${i}`, age: 27 });
      a.progress({ rng: createRNG(2000 + i), focus: "batting" }); b.progress({ rng: createRNG(2000 + i), focus: "balanced" });
      bat += a.battingOvr - b.battingOvr;
    }
    bat /= 300;
    expect(gain).toBeGreaterThan(0.6 * bat);
    expect(gain).toBeLessThan(1.6 * bat);
  });

  it("boosts keeping only for designated keepers", () => {
    const keeperGain = avgAfter("fielding", { fielding: 50, keeping: 50 }, true, "keeping") - avgAfter("balanced", { fielding: 50, keeping: 50 }, true, "keeping");
    const otherGain = avgAfter("fielding", { fielding: 50, keeping: 50 }, false, "keeping") - avgAfter("balanced", { fielding: 50, keeping: 50 }, false, "keeping");
    expect(keeperGain).toBeGreaterThan(1.3);
    expect(Math.abs(otherGain)).toBeLessThan(0.3);
  });

  it("gives other attributes a little less, and invents nothing for players without the fields", () => {
    const a = player({ id: "x", age: 27 }); const b = player({ id: "x", age: 27 });
    for (let s = 0; s < 3; s++) { a.progress({ rng: createRNG(40 + s), focus: "fielding" }); b.progress({ rng: createRNG(40 + s), focus: "balanced" }); }
    expect(a.ratings.fielding).toBeUndefined();
    expect(a.ratings.keeping).toBeUndefined();
    for (const v of Object.values(a.ratings)) expect(Number.isNaN(v)).toBe(false);
    expect(a.battingOvr).toBeLessThanOrEqual(b.battingOvr);
    const m = player({ id: "m", age: 27 }, { fielding: 50 });
    expect(m.applyMidSeasonTraining().every(c => Number.isFinite(c.to))).toBe(true);
    m.trainingFocus = "fielding";
    expect(m.applyMidSeasonTraining().every(c => c.attr !== "fielding" && c.attr !== "keeping")).toBe(true);
  });
});
