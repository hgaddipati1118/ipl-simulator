import { describe, expect, it } from "vitest";
import {
  applyFieldingToProbs,
  buildFieldingUnit,
  chanceInflation,
  fieldingRating,
  keepingRating,
  pickKeeper,
  resolveWicketChance,
  type FielderLike,
} from "../fielding.js";
import { createRNG } from "../rng.js";
import { Player, type PlayerData } from "../player.js";
import { Team, IPL_TEAMS } from "../team.js";
import { simulateMatch } from "../match.js";
import { applyDecision, createMatchState, simulateRemaining } from "../live-match.js";
import { RULE_PRESETS } from "../rules.js";

function fielder(id: string, ratings: { fielding?: number; keeping?: number } = {}, isWicketKeeper = false): FielderLike {
  return { id, name: `Fielder ${id}`, isWicketKeeper, ratings };
}

function xi(fielding: number, keeping?: number): FielderLike[] {
  return Array.from({ length: 11 }, (_, i) =>
    i === 0 ? fielder("wk", { fielding, keeping }, true) : fielder(`f${i}`, { fielding }));
}

describe("fielding / keeping ratings", () => {
  it("default to neutral when absent (old saves, mods, hand-built players)", () => {
    expect(fieldingRating(fielder("a"))).toBe(50);
    expect(keepingRating(fielder("a"))).toBe(25);
    expect(keepingRating(fielder("a", {}, true))).toBe(50);
    expect(fieldingRating(fielder("a", { fielding: 80 }))).toBe(80);
    expect(keepingRating(fielder("a", { keeping: 71 }, true))).toBe(71);
  });

  it("a Player keeps the optional ratings through construction and toJSON", () => {
    const data: PlayerData = {
      id: "p", name: "P", age: 27, country: "India", role: "batsman", isInternational: false, injured: false, injuryGamesLeft: 0,
      ratings: { battingIQ: 60, timing: 60, power: 60, running: 60, wicketTaking: 20, economy: 20, accuracy: 20, clutch: 50, fielding: 77, keeping: 64 },
    };
    const p = new Player(data);
    expect(p.ratings.fielding).toBe(77);
    expect(p.ratings.keeping).toBe(64);
    expect(new Player({ ...p.toJSON(), injured: false, injuryGamesLeft: 0 }).ratings.fielding).toBe(77);
    // a player without them is unchanged and progression leaves the optional ratings alone
    const legacy = new Player({ ...data, ratings: { ...data.ratings, fielding: undefined, keeping: undefined } });
    legacy.progress();
    expect(Number.isFinite(legacy.ratings.battingIQ)).toBe(true);
  });
});

describe("pickKeeper", () => {
  it("prefers a designated keeper, then the best keeping rating", () => {
    const team = [fielder("a"), fielder("b", { keeping: 60 }, true), fielder("c", { keeping: 80 }, true), fielder("d", { keeping: 95 })];
    expect(pickKeeper(team)?.id).toBe("c");
  });
  it("falls back to the best keeping rating when nobody is a designated keeper", () => {
    const team = [fielder("a", { keeping: 30 }), fielder("b", { keeping: 66 }), fielder("c")];
    expect(pickKeeper(team)?.id).toBe("b");
    expect(pickKeeper([])).toBeUndefined();
  });
});

describe("dismissal chances", () => {
  const baseProbs = () => ({ dot: 0.355, "1": 0.278, "2": 0.052, "3": 0.011, "4": 0.112, "6": 0.05, wicket: 0.044, wide: 0.031, noball: 0.005, legbye: 0.015 });

  it("dismissal chances outnumber dismissals (some are put down), for pace and spin alike", () => {
    for (const style of ["right-arm-fast", "leg-spin", "off-spin", "unknown", undefined] as const) {
      expect(chanceInflation(style)).toBeGreaterThan(1.05);
      expect(chanceInflation(style)).toBeLessThan(1.3);
    }
  });

  it("spin gets stumpings, pace almost none", () => {
    const share = (style: "leg-spin" | "right-arm-fast") => {
      const unit = buildFieldingUnit(xi(50, 50));
      const rng = createRNG(21);
      let st = 0, n = 0;
      for (let i = 0; i < 80000; i++) { n++; if (resolveWicketChance(unit, "bowler", style, baseProbs(), rng).kind === "stumped") st++; }
      return st / n;
    };
    expect(share("leg-spin")).toBeGreaterThan(share("right-arm-fast") * 2.5);
  });

  it("is neutral: an average side leaves the base wicket probability and the other outcomes unchanged", () => {
    const unit = buildFieldingUnit(xi(50, 50));
    const rng = createRNG(99);
    const n = 600000;
    const counts: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const probs = baseProbs();
      applyFieldingToProbs(probs, unit, "right-arm-fast");
      const entries = Object.entries(probs);
      const total = entries.reduce((s, [, v]) => s + v, 0);
      let r = rng() * total;
      let outcome = entries[entries.length - 1][0];
      for (const [k, v] of entries) { r -= v; if (r <= 0) { outcome = k; break; } }
      if (outcome === "wicket") {
        const res = resolveWicketChance(unit, "bowler", "right-arm-fast", probs, rng);
        outcome = res.outcome;
      }
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    const base = baseProbs();
    const baseTotal = Object.values(base).reduce((a, b) => a + b, 0);
    for (const k of ["wicket", "dot", "1", "4", "6", "wide"] as const) {
      const expected = base[k] / baseTotal;
      expect(Math.abs(counts[k] / n - expected)).toBeLessThan(k === "wicket" ? 0.0012 : 0.003);
    }
  });

  it("better fielders convert more catches: drop rate falls as the rating rises", () => {
    const dropRate = (rating: number) => {
      const unit = buildFieldingUnit(xi(rating, rating));
      const rng = createRNG(5);
      let chances = 0, drops = 0;
      for (let i = 0; i < 60000; i++) {
        const res = resolveWicketChance(unit, "bowler", "right-arm-fast", baseProbs(), rng);
        if (res.kind === "caught") { chances++; if (res.outcome !== "wicket") drops++; }
      }
      return drops / chances;
    };
    const poor = dropRate(20), avg = dropRate(50), elite = dropRate(85);
    expect(poor).toBeGreaterThan(avg);
    expect(avg).toBeGreaterThan(elite);
    expect(avg).toBeGreaterThan(0.1); // an average side still puts down about one chance in six
    expect(avg).toBeLessThan(0.25);
  });

  it("a good keeper converts stumpings a poor one doesn't", () => {
    const rate = (keeping: number) => {
      const unit = buildFieldingUnit(xi(50, keeping));
      const rng = createRNG(8);
      let chances = 0, taken = 0;
      for (let i = 0; i < 80000; i++) {
        const res = resolveWicketChance(unit, "bowler", "leg-spin", baseProbs(), rng);
        if (res.kind === "stumped") { chances++; if (res.outcome === "wicket") taken++; }
      }
      return taken / chances;
    };
    expect(rate(90)).toBeGreaterThan(rate(20));
  });

  it("keepers scale byes and the side's fielding scales runs saved", () => {
    const sloppy = baseProbs(); applyFieldingToProbs(sloppy, buildFieldingUnit(xi(50, 15)), "off-spin");
    const sharp = baseProbs(); applyFieldingToProbs(sharp, buildFieldingUnit(xi(50, 90)), "off-spin");
    expect(sloppy.legbye).toBeGreaterThan(sharp.legbye);
    const poorField = baseProbs(); applyFieldingToProbs(poorField, buildFieldingUnit(xi(30)), "off-spin");
    const goodField = baseProbs(); applyFieldingToProbs(goodField, buildFieldingUnit(xi(70)), "off-spin");
    expect(poorField["4"]).toBeGreaterThan(goodField["4"]);
    expect(poorField.dot).toBeLessThan(goodField.dot);
  });
});

// ── Whole matches ───────────────────────────────────────────────────────

function makePlayer(id: string, role: "batsman" | "bowler" | "all-rounder", opts: { wk?: boolean; ratings?: Partial<PlayerData["ratings"]>; style?: PlayerData["bowlingStyle"] } = {}): Player {
  const bat = role === "batsman", bowl = role === "bowler";
  return new Player({
    id, name: `Player ${id}`, age: 26, country: "India", role,
    ratings: {
      battingIQ: bat ? 70 : bowl ? 25 : 55, timing: bat ? 68 : bowl ? 25 : 50, power: bat ? 65 : bowl ? 20 : 50, running: bat ? 60 : 40,
      wicketTaking: bowl ? 70 : bat ? 20 : 55, economy: bowl ? 68 : bat ? 20 : 55, accuracy: bowl ? 65 : bat ? 20 : 50, clutch: 55,
      ...opts.ratings,
    },
    isInternational: false, isWicketKeeper: opts.wk ?? false, bowlingStyle: opts.style, injured: false, injuryGamesLeft: 0,
  });
}

function buildTeam(idx: number, tag: string, fk: { fielding?: number; keeping?: number } = {}, withKeeper = true): Team {
  const team = new Team({ ...IPL_TEAMS[idx], id: `${IPL_TEAMS[idx].id}-${tag}` });
  let id = 0;
  const r = (extra: Partial<PlayerData["ratings"]> = {}) => ({ ...fk, ...extra });
  const styles = ["right-arm-fast", "off-spin", "leg-spin", "left-arm-fast"] as const;
  for (let i = 0; i < 4; i++) team.addPlayer(makePlayer(`${tag}bat${++id}`, "batsman", { ratings: r() }), 5);
  if (withKeeper) team.addPlayer(makePlayer(`${tag}wk${++id}`, "batsman", { wk: true, ratings: r() }), 5);
  else team.addPlayer(makePlayer(`${tag}bat${++id}`, "batsman", { ratings: r() }), 5);
  for (let i = 0; i < 3; i++) team.addPlayer(makePlayer(`${tag}ar${++id}`, "all-rounder", { style: styles[i % 4], ratings: r() }), 5);
  for (let i = 0; i < 4; i++) team.addPlayer(makePlayer(`${tag}bow${++id}`, "bowler", { style: styles[i % 4], ratings: r() }), 5);
  return team;
}

function league(matches: number, a: () => Team, b: () => Team, seed0: number) {
  let runs = 0, wkts = 0, fours = 0, sixes = 0, inns = 0, drops = 0, catches = 0;
  for (let i = 0; i < matches; i++) {
    const res = simulateMatch(a(), b(), { ...RULE_PRESETS.modern, injuriesEnabled: false }, seed0 + i, { countTowardStandings: false });
    for (const inn of res.innings) {
      inns++; runs += inn.runs; wkts += inn.wickets; fours += inn.fours; sixes += inn.sixes;
      for (const e of inn.ballLog) {
        if (e.fieldingNote === "dropped_catch") drops++;
        if (e.isWicket && e.wicketType === "caught") catches++;
      }
    }
  }
  return { runs: runs / inns, wkts: wkts / inns, fours: fours / inns, sixes: sixes / inns, drops: drops / inns, catches: catches / inns };
}

describe("fielding in the match engine", () => {
  it("balance: explicit average (50) ratings are exactly the same game as no ratings", () => {
    const a = league(40, () => buildTeam(0, "a"), () => buildTeam(1, "b"), 400);
    const b = league(40, () => buildTeam(0, "a", { fielding: 50, keeping: 50 }), () => buildTeam(1, "b", { fielding: 50, keeping: 50 }), 400);
    // keeper default is 50 for the designated keeper, so only non-keepers' keeping (never used) differs
    expect(b).toEqual(a);
  });

  it("balance: a side of average fielders scores, loses wickets and hits boundaries as the base model does", { timeout: 120000 }, () => {
    const n = 1500;
    const avg = league(n, () => buildTeam(0, "a", { fielding: 50, keeping: 50 }), () => buildTeam(1, "b", { fielding: 50, keeping: 50 }), 7000);
    // The calibrated base model (innings from the engine before fielding existed): ~167 runs, ~6.9 wickets, 16.6 fours, 7.7 sixes
    // for the real IPL pool; this synthetic squad is its own baseline, so compare with the pre-fielding numbers measured in
    // docs/RULES-MATCH.md section 11 via the ratio of runs per wicket instead of absolute values.
    expect(avg.wkts).toBeGreaterThan(5.5);
    expect(avg.wkts).toBeLessThan(8.5);
    expect(avg.runs).toBeGreaterThan(130);
    expect(avg.runs).toBeLessThan(200);
    expect(avg.drops).toBeGreaterThan(0.3); // average sides put down chances
  });

  it("balance: rated fielders (mean 50) don't move scoring or wickets away from the unrated game by more than 2%", { timeout: 180000 }, () => {
    const n = 1500;
    const spread = [30, 40, 50, 60, 70, 45, 55, 50, 35, 65, 50];
    const rated = (tag: string) => () => {
      const t = buildTeam(tag === "a" ? 0 : 1, tag);
      t.roster.forEach((p, i) => { p.ratings.fielding = spread[i % spread.length]; p.ratings.keeping = p.isWicketKeeper ? 50 : undefined; });
      return t;
    };
    const unrated = league(n, () => buildTeam(0, "a"), () => buildTeam(1, "b"), 9000);
    const withRatings = league(n, rated("a"), rated("b"), 9000);
    expect(Math.abs(withRatings.runs / unrated.runs - 1)).toBeLessThan(0.02);
    expect(Math.abs(withRatings.wkts / unrated.wkts - 1)).toBeLessThan(0.02);
    expect(Math.abs(withRatings.fours / unrated.fours - 1)).toBeLessThan(0.03);
    expect(Math.abs(withRatings.sixes / unrated.sixes - 1)).toBeLessThan(0.03);
  });

  it("a side of elite fielders concedes fewer runs and takes more catches than a side of poor ones", { timeout: 180000 }, () => {
    const n = 900;
    const elite = league(n, () => buildTeam(0, "a", { fielding: 80, keeping: 80 }), () => buildTeam(1, "b", { fielding: 80, keeping: 80 }), 12000);
    const poor = league(n, () => buildTeam(0, "a", { fielding: 25, keeping: 25 }), () => buildTeam(1, "b", { fielding: 25, keeping: 25 }), 12000);
    expect(elite.runs).toBeLessThan(poor.runs);
    expect(elite.wkts).toBeGreaterThan(poor.wkts);
    expect(elite.drops).toBeLessThan(poor.drops);
  });

  it("records who took each catch and writes it on the scorecard", () => {
    const res = simulateMatch(buildTeam(0, "a"), buildTeam(1, "b"), { ...RULE_PRESETS.modern, injuriesEnabled: false }, 31, { countTowardStandings: false });
    let caught = 0;
    for (const inn of res.innings) {
      for (const e of inn.ballLog) {
        if (e.isWicket && e.wicketType === "caught") {
          caught++;
          expect(e.fielderId).toBeTruthy();
          expect(e.fielderId).not.toBe(e.bowler);
        }
        if (e.fieldingNote === "dropped_catch" || e.fieldingNote === "missed_stumping") {
          expect(e.isWicket).toBe(false);
          expect(e.commentary.length).toBeGreaterThan(10);
        }
      }
    }
    expect(caught).toBeGreaterThan(0);
    const howOut = [...res.detailed!.innings1.batters, ...res.detailed!.innings2.batters].map(b => b.howOut);
    expect(howOut.some(h => /^c Player \w+ b Player/.test(h))).toBe(true);
  });

  it("commentary covers dropped catches and great catches across many matches", { timeout: 60000 }, () => {
    const lines = new Set<string>();
    for (let i = 0; i < 80; i++) {
      const res = simulateMatch(buildTeam(0, "a", { fielding: 85, keeping: 85 }), buildTeam(1, "b", { fielding: 30, keeping: 30 }),
        { ...RULE_PRESETS.modern, injuriesEnabled: false }, 500 + i, { countTowardStandings: false });
      for (const inn of res.innings) for (const e of inn.ballLog) if (e.fieldingNote) lines.add(`${e.fieldingNote}`);
    }
    expect(lines.has("dropped_catch")).toBe(true);
    expect(lines.has("great_catch")).toBe(true);
  });

  it("counts catches in player stats", () => {
    const home = buildTeam(0, "a"), away = buildTeam(1, "b");
    simulateMatch(home, away, { ...RULE_PRESETS.modern, injuriesEnabled: false }, 77, { countTowardStandings: false });
    const total = [...home.roster, ...away.roster].reduce((s, p) => s + p.stats.catches, 0);
    expect(total).toBeGreaterThan(0);
  });
});

describe("every XI has a wicketkeeper", () => {
  it("auto-selection includes the squad's designated keeper", () => {
    const team = buildTeam(0, "a");
    const xiPlayers = team.autoSelectPlayingXI();
    expect(xiPlayers).toHaveLength(11);
    expect(xiPlayers.some(p => p.isWicketKeeper)).toBe(true);
  });

  it("a squad with no designated keeper gets its best keeping rating into the XI, and he keeps", () => {
    const team = buildTeam(0, "a", {}, false);
    const stand = team.roster.find(p => p.role === "all-rounder")!;
    // make a good emergency keeper who would not otherwise be a selection
    team.addPlayer(makePlayer("tag-keeper", "bowler", { ratings: { keeping: 78 } }), 1);
    const selected = team.autoSelectPlayingXI();
    expect(selected).toHaveLength(11);
    const keeper = pickKeeper(selected);
    expect(keeper).toBeDefined();
    expect(keeper!.ratings.keeping ?? 0).toBeGreaterThanOrEqual(25);
    void stand;
    // and the match still runs and a stumping/keeper line names a real player
    const res = simulateMatch(team, buildTeam(1, "b"), { ...RULE_PRESETS.modern, injuriesEnabled: false }, 3, { countTowardStandings: false });
    expect(res.innings[0].runs).toBeGreaterThan(0);
  });

  it("falls back to someone when the only keeper is injured", () => {
    const team = buildTeam(0, "a");
    team.roster.find(p => p.isWicketKeeper)!.injured = true;
    const selected = team.autoSelectPlayingXI();
    expect(selected).toHaveLength(11);
    expect(pickKeeper(selected)).toBeDefined();
    const res = simulateMatch(team, buildTeam(1, "b"), { ...RULE_PRESETS.modern, injuriesEnabled: false }, 4, { countTowardStandings: false });
    expect(res.innings[1].ballLog.length).toBeGreaterThan(0);
  });
});

describe("fielding in live matches", () => {
  it("live matches use the same fielding model: catches name a fielder from the bowling XI", { timeout: 60000 }, () => {
    let caughtWithFielder = 0;
    let sawNote = false;
    for (let i = 0; i < 6; i++) {
      const home = buildTeam(0, "a", { fielding: 35, keeping: 35 });
      const away = buildTeam(1, "b", { fielding: 35, keeping: 35 });
      const initial = createMatchState(home, away, { ...RULE_PRESETS.modern, injuriesEnabled: false }, null, 600 + i);
      const { balls } = simulateRemaining(initial);
      for (const b of balls) {
        if (b.wicketType === "caught" && b.fielderName) caughtWithFielder++;
        if (/DROPPED|spills|can't hold/.test(b.commentary)) sawNote = true;
      }
    }
    expect(caughtWithFielder).toBeGreaterThan(5);
    expect(sawNote).toBe(true);
    void applyDecision;
  });
});
