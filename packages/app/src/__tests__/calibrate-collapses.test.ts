import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import {
  EXTRA_LEAGUES, HUNDRED_FORMAT, MATCH_CONDITIONS, RULE_PRESETS, WICKETS_IN_HAND_NORM, phaseOver, simulateMatch, wicketsInHandBand,
  type BallEvent, type BallOutcome, type RuleSet, type Team,
} from "@ipl-sim/engine";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import type { PlayerActivityFile } from "@ipl-sim/ratings/dist/player-activity.js";
import { createGameState } from "../game-state";
import { createSeries, matchContext, seriesSquads } from "../international";
import { createPoolLoader } from "../extended-pool";

/**
 * Collapses (skipped unless CALIBRATE_COLLAPSES=1): the engine's first innings with and without the wickets-in-hand table
 * (wickets-in-hand.ts; the table from packages/ratings/src/analysis/t20-wickets-in-hand.py), per competition: the game's
 * own squads in each league (random pairings, instant engine, injuries and rain off), the series' national sides on the real
 * T20I fixtures between full members (neutral grounds). For each competition it fits the factors that keep its phase rates
 * and mean first innings where they were (wickets-in-hand-norm-data.ts): each over band's class shares brought back to
 * their values without the table, the run classes' shares scaled together (the dots taking up the difference) by the factor
 * that keeps the mean first innings, over CAL_ITER rounds (default 5) of CAL_MATCHES matches (default 800). The report:
 * all-out share, wickets, under 120 and 200+ (The Hundred: under 100, 167+), sd and mean, against the real leagues. The match
 * conditions are off throughout (fitted on top of the table afterwards by calibrate-spread.test.ts).
 * The table's power per competition (CAL_SCALES, default 0.5 / 0.75 / 1; none, scale 0, if no power helps; each judged on
 * CAL_EVAL_MATCHES matches, default 2,500) is the one whose
 * all-out share, under-120 and 200+ shares (at the engine's mean) are nearest the real league's, a spread above the real one
 * counted as a miss too. CAL_WOMEN=1 adds the women's leagues and T20Is; CAL_ONLY=ipl,bbl limits the competitions;
 * CALIBRATE_WRITE=1 writes the factors (default-male / default-female: the median league's power, the geometric mean of the
 * leagues' factors). CAL_RECENTRE=1 only corrects each competition's mean on 5,000 matches with and without the table.
 *   CALIBRATE_COLLAPSES=1 CALIBRATE_WRITE=1 npx vitest run packages/app/src/__tests__/calibrate-collapses.test.ts --reporter=verbose
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const PUBLIC = join(HERE, "..", "..", "public");
const OUT = join(REPO, "packages", "engine", "src", "wickets-in-hand-norm-data.ts");
const N = Number(process.env.CAL_MATCHES ?? 800);
/** Matches for the evaluation of a power (the shares below 120 and the all-outs need a few thousand) */
const NE = Number(process.env.CAL_EVAL_MATCHES ?? 2500);
const ITER = Number(process.env.CAL_ITER ?? 5);
const CLASSES: BallOutcome[] = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"];
const RUNS = [1, 2, 3, 4, 5];
const BANDS = 5;

interface Inn { teamId: string; runs: number; wickets: number; ballLog: BallEvent[] }
interface Comp { key: string; gender: "male" | "female"; hundred: boolean; matches: (seed0: number, n?: number) => Inn[] }

function classOf(b: BallEvent): number {
  if ((b.wides ?? 0) > 0 || b.outcome === "wide") return 7;
  if ((b.noBalls ?? 0) > 0 || b.outcome === "noball") return 8;
  if (b.isWicket) return 6;
  if ((b.byes ?? 0) + (b.legByes ?? 0) > 0 && b.runs === 0) return 9;
  if (b.runs >= 6) return 5;
  if (b.runs >= 4) return 4;
  return Math.min(b.runs, 3);
}

interface Stats { shares: number[][]; mean: number; sd: number; allOut: number; wickets: number; low: number; high: number; n: number }

function stats(first: Inn[], hundred: boolean): Stats {
  const counts = Array.from({ length: BANDS }, () => Array(CLASSES.length).fill(0));
  for (const inn of first) for (const b of inn.ballLog) {
    if (b.deadBall) continue;
    counts[wicketsInHandBand(hundred ? phaseOver(b.over, HUNDRED_FORMAT) : b.over)][classOf(b)]++;
  }
  const shares = counts.map(row => { const t = row.reduce((a, c) => a + c, 0); return row.map(c => c / Math.max(1, t)); });
  const runs = first.map(i => i.runs);
  const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
  const sd = Math.sqrt(runs.reduce((a, x) => a + (x - mean) ** 2, 0) / (runs.length - 1));
  const [hi, lo] = hundred ? [(200 * 100) / 120, 100] : [200, 120];
  return {
    shares, mean, sd, n: first.length,
    allOut: (100 * first.filter(i => i.wickets >= 10).length) / first.length, wickets: first.reduce((a, i) => a + i.wickets, 0) / first.length,
    low: (100 * runs.filter(r => r < lo).length) / runs.length, high: (100 * runs.filter(r => r >= hi).length) / runs.length,
  };
}

function leagueComp(key: string, rules0: RuleSet, gender: "male" | "female", hundred: boolean): Comp {
  const rules = { ...rules0, injuriesEnabled: false } as RuleSet;
  return {
    key, gender, hundred,
    matches: (seed0, n = N) => {
      const teams = createGameState(rules).teams;
      const out: Inn[] = [];
      for (let i = 0; i < n; i++) {
        const home = teams[i % teams.length];
        let away = teams[(i * 7 + 3) % teams.length];
        if (away === home) away = teams[(i * 7 + 4) % teams.length];
        out.push(simulateMatch(home, away, rules, seed0 + i, { countTowardStandings: false }).innings[0] as Inn);
      }
      return out;
    },
  };
}

async function t20iComp(gender: "male" | "female"): Promise<Comp> {
  const VALID = JSON.parse(readFileSync(join(REPO, "docs", "data", "t20i_validation.json"), "utf-8")) as { t20i: Record<string, { fixtures: [string, string, number][] }> };
  const FILE = JSON.parse(readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;
  const ACTIVITY = JSON.parse(readFileSync(join(PUBLIC, "data", "player-activity.json"), "utf-8")) as PlayerActivityFile;
  const g = gender === "male" ? "men" : "women";
  const extended = await createPoolLoader(async f => new Uint8Array(readFileSync(join(PUBLIC, "pool", f)))).players(g, ["senior"]);
  const pairings = VALID.t20i[g].fixtures.map(([a, b, n], i) => {
    const series = createSeries({ format: "t20i", gender: g, nations: [a, b], length: 1, host: "neutral", userSide: null, seed: 1000 + i }, FILE, ACTIVITY, extended);
    return { series, squads: seriesSquads(series, FILE, extended), n };
  });
  return {
    key: `t20i-${gender}`, gender, hundred: false,
    matches: (seed0, total = N) => {
      const out: Inn[] = [];
      const reps = Math.max(1, Math.round(total / pairings.reduce((a, p) => a + p.n, 0)));
      pairings.forEach(({ series, squads, n }, pi) => {
        for (let j = 0; j < n * reps; j++) {
          const m = matchContext(series, 0, squads);
          const [home, away]: [Team, Team] = [m.home, m.away];
          out.push(simulateMatch(home, away, m.rules!, seed0 + 7919 * pi + 104729 * j, { countTowardStandings: false, neutralVenue: true }).innings[0] as Inn);
        }
      });
      return out;
    },
  };
}

const f = (x: number, d = 1) => x.toFixed(d);
const line = (label: string, s: Stats) => `| ${label} | ${f(s.allOut)}% | ${f(s.wickets, 2)} | ${f(s.low)}% | ${f(s.high)}% | ${f(s.sd)} | ${f(s.mean)} |`;

/** The real season-centred first-innings shape at the engine's mean: its under-120 and 200+ shares (calibrate-spread.test.ts) */
function realShares(dev: number[], mean: number, hundred: boolean): { low: number; high: number } {
  const [hi, lo] = hundred ? [(200 * 100) / 120, 100] : [200, 120];
  return { low: (100 * dev.filter(d => d + mean < lo).length) / dev.length, high: (100 * dev.filter(d => d + mean >= hi).length) / dev.length };
}

it.skipIf(!process.env.CALIBRATE_COLLAPSES)("collapses: the wickets-in-hand table per competition", async () => {
  const SPREAD = JSON.parse(readFileSync(join(REPO, "docs", "data", "t20_spread.json"), "utf-8")) as {
    leagues: Record<string, { firstInnings: { allOut: number; centred: { sd: number; deviations: number[] } } }>;
  };
  const women = !!process.env.CAL_WOMEN;
  const comps: Comp[] = [
    leagueComp("ipl", RULE_PRESETS.modern2026 as RuleSet, "male", false),
    ...EXTRA_LEAGUES.filter(l => l.gender === "men").map(l => leagueComp(l.id, l.rules, "male", l.rules.matchFormat === "hundred")),
    await t20iComp("male"),
    ...(women ? [
      leagueComp("wpl", RULE_PRESETS.wpl as RuleSet, "female", false),
      ...EXTRA_LEAGUES.filter(l => l.gender === "women").map(l => leagueComp(l.id, l.rules, "female", l.rules.matchFormat === "hundred")),
      await t20iComp("female"),
    ] : []),
  ].filter(c => !process.env.CAL_ONLY || process.env.CAL_ONLY.split(",").includes(c.key));
  const realKey = (c: Comp) => (c.key.startsWith("t20i") ? (c.gender === "male" ? "t20i-m" : "t20i-w") : c.key);

  // fitted with the match conditions off (calibrate-spread.test.ts refits them on top of the table)
  MATCH_CONDITIONS.male = {}; MATCH_CONDITIONS.female = {};
  const SCALES = (process.env.CAL_SCALES ?? "0.5,0.75,1").split(",").map(Number);
  const NONE = (c: Comp) => ({ scale: 0, gender: c.gender, norm: Array.from({ length: BANDS }, () => Array(CLASSES.length).fill(1)) });
  /** The factors that keep phase shares and the mean first innings at a given power of the table */
  const fitNorm = (c: Comp, before: Stats, scale: number) => {
    const norm = Array.from({ length: BANDS }, () => Array(CLASSES.length).fill(1));
    WICKETS_IN_HAND_NORM[c.key] = { scale, gender: c.gender, norm };
    let k = 1;
    for (let it = 0; it < ITER; it++) {
      const s = stats(c.matches(5000), c.hundred);
      if (it > 0) k *= before.mean / s.mean;
      for (let b = 0; b < BANDS; b++) {
        const goal = [...before.shares[b]];
        let moved = 0;
        for (const r of RUNS) { moved += goal[r] * (1 - k); goal[r] *= k; }
        goal[0] += moved;
        for (let j = 0; j < CLASSES.length; j++) if (s.shares[b][j] > 0 && goal[j] > 0) norm[b][j] *= goal[j] / s.shares[b][j];
      }
    }
    return { scale, gender: c.gender, norm, after: stats(c.matches(9000, NE), c.hundred) };
  };

  console.log("| competition | all out | wickets | under 120 | 200+ | sd | mean |");
  // CAL_RECENTRE=1: keep the fitted powers and factors, only correct the mean on CAL_CENTRE_MATCHES (default 5,000) matches
  // with and without the table (the same matches): the run classes scaled by the ratio
  if (process.env.CAL_RECENTRE) {
    const NC = Number(process.env.CAL_CENTRE_MATCHES ?? 5000);
    for (const c of comps) {
      const fitted = WICKETS_IN_HAND_NORM[c.key];
      if (!fitted || fitted.scale === 0) continue;
      WICKETS_IN_HAND_NORM[c.key] = NONE(c);
      const m0 = stats(c.matches(70000, NC), c.hundred).mean;
      WICKETS_IN_HAND_NORM[c.key] = fitted;
      const m1 = stats(c.matches(70000, NC), c.hundred).mean;
      for (const row of fitted.norm) for (const r of RUNS) row[r] *= m0 / m1;
      console.log(`${c.key}: mean without ${f(m0)}, with ${f(m1)} -> run classes x ${(m0 / m1).toFixed(4)}`);
    }
  }
  for (const c of process.env.CAL_RECENTRE ? [] : comps) {
    WICKETS_IN_HAND_NORM[c.key] = NONE(c);
    const before = stats(c.matches(5000), c.hundred);
    const noTable = stats(c.matches(9000, NE), c.hundred);
    const real = SPREAD.leagues[realKey(c)]?.firstInnings;
    // the power: the all-out share and the shares below 120 and above 200 (at the engine's mean) nearest the real ones, a
    // spread above the real one counted too (the conditions term can widen it, not narrow it)
    const loss = (s: Stats) => {
      if (!real) return 0;
      const r = realShares(real.centred.deviations, s.mean, c.hundred);
      return (s.allOut - real.allOut) ** 2 + 2 * (s.low - r.low) ** 2 + (s.high - r.high) ** 2 + Math.max(0, s.sd - real.centred.sd) ** 2;
    };
    let best = { ...NONE(c), after: noTable, loss: loss(noTable) };
    const lines: string[] = [];
    for (const scale of SCALES) {
      const fit = fitNorm(c, before, scale);
      const l = loss(fit.after);
      lines.push(line(`${c.key} power ${scale}${real ? ` (loss ${f(l)})` : ""}`, fit.after));
      if (l < best.loss) best = { ...fit, loss: l };
    }
    WICKETS_IN_HAND_NORM[c.key] = { scale: best.scale, gender: c.gender, norm: best.norm };
    if (real) {
      const r = realShares(real.centred.deviations, noTable.mean, c.hundred);
      console.log(`| ${c.key} real (2021+, centred at the engine's mean) | ${f(real.allOut)}% | | ${f(r.low)}% | ${f(r.high)}% | ${f(real.centred.sd)} | |`);
    }
    console.log(line(`${c.key} without (loss ${f(loss(noTable))})`, noTable));
    for (const l of lines) console.log(l);
    console.log(`${c.key}: power ${best.scale}`);
  }

  // other competitions of a gender: the median league's power, the delivery-weighted geometric mean of the leagues' factors
  for (const g of process.env.CAL_RECENTRE ? [] : (["male", "female"] as const)) {
    const keys = comps.filter(c => c.gender === g && !c.key.startsWith("t20i") && WICKETS_IN_HAND_NORM[c.key]?.scale > 0).map(c => c.key);
    if (!keys.length) continue;
    const scales = keys.map(k => WICKETS_IN_HAND_NORM[k].scale).sort((a, b) => a - b);
    const norm = Array.from({ length: BANDS }, (_, b) => CLASSES.map((_, j) => Math.exp(keys.reduce((s, key) => s + Math.log(WICKETS_IN_HAND_NORM[key].norm[b][j]), 0) / keys.length)));
    WICKETS_IN_HAND_NORM[`default-${g}`] = { scale: scales[Math.floor(scales.length / 2)], gender: g, norm };
  }

  if (process.env.CALIBRATE_WRITE) {
    const body = Object.entries(WICKETS_IN_HAND_NORM).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, t]) => `  ${/^[a-z]+$/.test(key) ? key : `"${key}"`}: {\n    scale: ${t.scale},\n    gender: "${t.gender}",\n    norm: [\n${t.norm.map(row => `      [${row.map(x => x.toFixed(4)).join(", ")}]`).join(",\n")},\n    ],\n  },`).join("\n");
    writeFileSync(OUT, `/**
 * GENERATED by packages/app/src/__tests__/calibrate-collapses.test.ts (CALIBRATE_COLLAPSES=1 CALIBRATE_WRITE=1). Do not
 * edit by hand.
 *
 * Per competition, the power the wickets-in-hand table is raised to (\`scale\`) and the factor per over band and outcome class
 * that keeps its phase rates and its mean first innings what they were without it (\`norm\`: [band][class]; wickets-in-hand.ts).
 * Keys: a league id, "t20i-male" / "t20i-female", or "default-male" / "default-female" for any other. A competition without
 * a key of its own uses its gender's default (scale 0: none).
 */
export const WICKETS_IN_HAND_NORM: Record<string, { scale: number; gender: "male" | "female"; norm: number[][] }> = {
${body}
};
`);
    console.log(`wrote ${OUT}`);
  }
}, 14_400_000);
