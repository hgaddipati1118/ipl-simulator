import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import {
  EXTRA_LEAGUES, MATCH_CONDITIONS, RULE_PRESETS, WICKETS_IN_HAND_NORM, simulateMatch,
  type BallEvent, type ConditionsShape, type RuleSet, type Team,
} from "@ipl-sim/engine";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import type { PlayerActivityFile } from "@ipl-sim/ratings/dist/player-activity.js";
import { createGameState } from "../game-state";
import { createSeries, matchContext, seriesSquads, type SeriesGender } from "../international";
import { createPoolLoader } from "../extended-pool";

/**
 * The spread of innings totals (skipped unless CALIBRATE_SPREAD=1): each league played by the game's own squads (random
 * pairings at the home side's ground, injuries and rain off, instant engine) against the real first innings since 2021
 * (docs/data/t20_spread.json, from t20-spread.py). The real totals are centred on their season's mean (seasons drift by up
 * to 30 runs; the engine plays one era) and compared as a shape: sd, the 10th / 25th / 50th / 75th / 90th percentiles of the
 * deviation, and the 200+ and under-120 shares the real shape gives at the engine's league mean (The Hundred: 167+ and
 * under 100), the mean being the league calibration's. The report also shows the first-ten-overs decomposition and the
 * within-match covariance (the match term), and all-out shares (how much of the low tail is collapses).
 *
 * CAL_FIT=1 fits the conditions term (match-conditions.ts): each men's league is played at a grid of fixed run multipliers
 * (log -0.6 .. 0.8, CAL_GRID_MATCHES matches each, default 800); a candidate term (two-piece normal log multiplier) is the
 * mixture of the grid's totals weighted by its density, its centre solved so the mean total is the one without a term.
 * The shape (the ratio of the spread above the centre to the spread below) is pooled over the men's leagues, the scale is
 * per league, both chosen to minimise the squared distance of the percentiles plus four times that of the shares (in
 * points); a league fits better with no term keeps none. CALIBRATE_WRITE=1 writes match-conditions-data.ts (default:
 * the median league's scale and centre). The women's leagues get none (their real match term is the engine's own).
 *   CALIBRATE_SPREAD=1 npx vitest run packages/app/src/__tests__/calibrate-spread.test.ts --reporter=verbose
 *   CALIBRATE_SPREAD=1 CAL_FIT=1 CALIBRATE_WRITE=1 npx vitest run packages/app/src/__tests__/calibrate-spread.test.ts --reporter=verbose
 * CAL_MATCHES (default 1500) matches per league in the report; CAL_ONLY=ipl,bbl limits the leagues.
 *
 * The T20I (skipped unless CAL_T20I=1): the same fit for a series' T20Is, men and women (CAL_GENDER=men|women), on the real
 * fixtures between full members since 2019 (docs/data/t20i_validation.json) replayed CAL_REPLAYS times (default 2) with the
 * series' own sides, against the season-centred real first innings (t20_spread.json "t20i-m" / "t20i-w"). Grid of fixed run
 * multipliers (log -0.9 .. 1.0), the shape ratio and scale chosen as above, the centre set so the mean first innings stays
 * where it was. CALIBRATE_WRITE=1 writes the `t20i` entries of match-conditions-data.ts (the leagues' entries are kept).
 *   CAL_T20I=1 CALIBRATE_WRITE=1 npx vitest run packages/app/src/__tests__/calibrate-spread.test.ts -t "T20I" --reporter=verbose
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const OUT = join(REPO, "packages", "engine", "src", "match-conditions-data.ts");
const N = Number(process.env.CAL_MATCHES ?? 1500);

interface Inn { teamId: string; runs: number; wickets: number; ballLog: BallEvent[] }
interface Row { lg: string; match: string; innings: 1 | 2; bat: string; bowl: string; ground: string; runs: number; wk: number; r10: number; w10: number; lastOver: number }
interface RealLeague {
  gender: "men" | "women"; hundred: boolean;
  firstInnings: {
    matches: number; mean: number; sd: number; p200: number; under120: number; allOut: number; under120AllOut: number;
    centred: { sd: number; skew: number; quantiles: number[]; deviations: number[] };
  };
  r10: Record<string, number>; w10: Record<string, number>; match: { run: number; wicket: number; corr: number };
}
interface Real {
  leagues: Record<string, RealLeague>;
  pooled: Record<"men" | "women", { r10: Record<string, number>; match: { run: number; wicket: number; corr: number } }>;
}

const TERMS = ["bat", "bowl", "ground"] as const;

/** The variance components and residuals of y (t20-spread.py decompose, the same EM) */
function decompose(rows: Row[], y: (r: Row) => number, sweeps = 200) {
  const key: Record<(typeof TERMS)[number], (r: Row) => string> = {
    bat: r => `${r.lg}|${r.bat}`, bowl: r => `${r.lg}|${r.bowl}`, ground: r => `${r.lg}|${r.ground}`,
  };
  const ys = rows.map(y);
  const n = ys.length;
  const lv = Object.fromEntries(TERMS.map(t => [t, rows.map(key[t])])) as Record<(typeof TERMS)[number], string[]>;
  const mk = rows.map(r => r.lg);
  const u = Object.fromEntries(TERMS.map(t => [t, new Map<string, number>()])) as Record<(typeof TERMS)[number], Map<string, number>>;
  const tot = ys.reduce((a, b) => a + b, 0) / n;
  let varE = ys.reduce((a, v) => a + (v - tot) ** 2, 0) / n;
  const v = Object.fromEntries(TERMS.map(t => [t, 0.1 * varE])) as Record<(typeof TERMS)[number], number>;
  let mu = new Map<string, number>();
  const fitOf = (i: number, skip?: string) => TERMS.reduce((s, t) => (t === skip ? s : s + (u[t].get(lv[t][i]) ?? 0)), 0);
  for (let it = 0; it < sweeps; it++) {
    const accM = new Map<string, [number, number]>();
    for (let i = 0; i < n; i++) { const a = accM.get(mk[i]) ?? [0, 0]; a[0] += ys[i] - fitOf(i); a[1]++; accM.set(mk[i], a); }
    mu = new Map([...accM].map(([k, [s, c]]) => [k, s / c]));
    let condSum = 0;
    for (const t of TERMS) {
      const acc = new Map<string, [number, number]>();
      for (let i = 0; i < n; i++) { const a = acc.get(lv[t][i]) ?? [0, 0]; a[0] += ys[i] - mu.get(mk[i])! - fitOf(i, t); a[1]++; acc.set(lv[t][i], a); }
      let sq = 0;
      const next = new Map<string, number>();
      for (const [k, [s, c]] of acc) {
        const pv = 1 / (c / varE + 1 / v[t]);
        const e = (pv * s) / varE;
        next.set(k, e);
        sq += e * e + pv;
        condSum += c * pv;
      }
      u[t] = next;
      v[t] = Math.max(sq / acc.size, 1e-6);
    }
    let rss = 0;
    for (let i = 0; i < n; i++) rss += (ys[i] - mu.get(mk[i])! - fitOf(i)) ** 2;
    varE = (rss + condSum) / n;
  }
  const res = new Map<string, number>();
  rows.forEach((r, i) => res.set(`${r.match}|${r.innings}`, ys[i] - mu.get(mk[i])! - fitOf(i)));
  return { v, varE, res };
}

/** Match term from the residuals' within-match covariance (t20-spread.py match_terms) */
function matchTerm(rows: Row[]) {
  const dr = decompose(rows, r => r.r10), dw = decompose(rows, r => r.w10);
  const ids = [...new Set(rows.map(r => r.match))];
  let cr = 0, cw = 0, x = 0, k = 0;
  for (const m of ids) {
    const a = dr.res.get(`${m}|1`), b = dr.res.get(`${m}|2`), c = dw.res.get(`${m}|1`), d = dw.res.get(`${m}|2`);
    if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
    cr += a * b; cw += c * d; x += (a * d + b * c) / 2; k++;
  }
  cr /= k; cw /= k; x /= k;
  return { run: cr, wicket: cw, cross: x, dr, dw };
}

/** Both innings of the matches whose chase lasted the ten-over window (t20-spread.py window_rows) */
function windowRows(rows: Row[]): Row[] {
  const by = new Map<string, Row[]>();
  for (const r of rows) by.set(r.match, [...(by.get(r.match) ?? []), r]);
  return [...by.values()].filter(x => x.length === 2 && !(x[1].lastOver < 9 && x[1].wk < 10)).flat();
}

function inningsRows(lg: string, match: string, inns: Inn[], ground: string): Row[] {
  return inns.slice(0, 2).map((inn, k) => {
    const w = inn.ballLog.filter(b => b.over < 10);
    return {
      lg, match, innings: (k + 1) as 1 | 2, bat: inn.teamId, bowl: inns[1 - k]?.teamId ?? "", ground, runs: inn.runs, wk: inn.wickets,
      r10: w.reduce((s, b) => s + b.runs + b.extras, 0), w10: w.filter(b => b.isWicket).length,
      lastOver: inn.ballLog.length ? inn.ballLog[inn.ballLog.length - 1].over : 0,
    };
  });
}

function leagueList(): Array<{ id: string; rules: RuleSet; hundred: boolean }> {
  const all = [
    { id: "ipl", rules: RULE_PRESETS.modern2026 as RuleSet, hundred: false }, { id: "wpl", rules: RULE_PRESETS.wpl as RuleSet, hundred: false },
    ...EXTRA_LEAGUES.map(l => ({ id: l.id as string, rules: l.rules, hundred: l.rules.matchFormat === "hundred" })),
  ];
  const only = process.env.CAL_ONLY?.split(",");
  return all.filter(l => !only || only.includes(l.id));
}

function play(lg: { id: string; rules: RuleSet; hundred: boolean }, n = N, seed0 = 9100): Row[] {
  const rules = { ...lg.rules, injuriesEnabled: false } as RuleSet;
  const teams = createGameState(rules).teams;
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const home = teams[i % teams.length];
    let away = teams[(i * 7 + 3) % teams.length];
    if (away === home) away = teams[(i * 7 + 4) % teams.length];
    const r = simulateMatch(home, away, rules, seed0 + i, { countTowardStandings: false });
    rows.push(...inningsRows(lg.id, `${lg.id}-${seed0 + i}`, r.innings as Inn[], home.id));
  }
  return rows;
}

/** Write match-conditions-data.ts (one writer for the league fit and the T20I fit) */
function writeConditions(male: Record<string, ConditionsShape | null>, female: Record<string, ConditionsShape | null>) {
  const body = (m: Record<string, ConditionsShape | null>) => Object.entries(m).map(([k, v]) => `    ${/^[a-z]+$/.test(k) ? k : `"${k}"`}: ${v ? `{ lo: ${v.lo}, hi: ${v.hi}, center: ${v.center} }` : "null"},`).join("\n");
  writeFileSync(OUT, `/**
 * GENERATED by packages/app/src/__tests__/calibrate-spread.test.ts (CALIBRATE_SPREAD=1 CAL_FIT=1 CALIBRATE_WRITE=1 for the
 * leagues, CAL_T20I=1 CALIBRATE_WRITE=1 for the T20I) from docs/data/t20_spread.json. Do not edit by hand.
 *
 * A T20 / Hundred match's own conditions (match-conditions.ts): the log run multiplier is two-piece normal around
 * \`center\`, with sd \`lo\` below it and \`hi\` above it. Per gender, per league (\`default\`: any other league of that gender;
 * \`t20i\`: a series' T20Is, fitted on real T20Is between full members; null: none); a gender with no entries has none.
 */
export interface ConditionsShape { lo: number; hi: number; center: number }

export const MATCH_CONDITIONS: Record<"male" | "female", Record<string, ConditionsShape | null>> = {
  male: {
${body(male)}
  },
  female: {
${body(female)}
  },
};
`);
  console.log(`wrote ${OUT}`);
}

const f = (x: number, d = 1) => x.toFixed(d);
const QS = [0.1, 0.25, 0.5, 0.75, 0.9];
const thresholds = (hundred: boolean) => (hundred ? [(200 * 100) / 120, 100] : [200, 120]);

/** Weighted quantile of sorted values (linear between order statistics) */
function wQuantile(xs: number[], ws: number[], q: number): number {
  const tot = ws.reduce((a, b) => a + b, 0);
  let c = 0;
  for (let i = 0; i < xs.length; i++) {
    c += ws[i];
    if (c >= q * tot) return xs[i];
  }
  return xs[xs.length - 1];
}

interface Shape { mean: number; sd: number; q: number[]; p200: number; u120: number; allOut?: number; u120AllOut?: number; wickets?: number }

function shapeOf(xs: number[], ws: number[] | null, hundred: boolean, mean?: number): Shape {
  const order = xs.map((x, i) => i).sort((a, b) => xs[a] - xs[b]);
  const v = order.map(i => xs[i]), w = order.map(i => (ws ? ws[i] : 1));
  const W = w.reduce((a, b) => a + b, 0);
  const m = mean ?? v.reduce((s, x, i) => s + x * w[i], 0) / W;
  const sd = Math.sqrt(v.reduce((s, x, i) => s + w[i] * (x - m) ** 2, 0) / W);
  const [hi, lo] = thresholds(hundred);
  return {
    mean: m, sd, q: QS.map(q => wQuantile(v, w, q) - m),
    p200: (100 * v.reduce((s, x, i) => s + (x >= hi ? w[i] : 0), 0)) / W, u120: (100 * v.reduce((s, x, i) => s + (x < lo ? w[i] : 0), 0)) / W,
  };
}

/** The real season-centred shape, its shares taken at the engine's mean */
function realShape(real: RealLeague, engineMean: number, hundred: boolean): Shape {
  const dev = real.firstInnings.centred.deviations;
  const s = shapeOf(dev.map(d => d + engineMean), null, hundred, engineMean);
  return { ...s, sd: real.firstInnings.centred.sd };
}

const fq = (s: Shape) => s.q.map(x => f(x, 0)).join(" / ");
const shapeRow = (label: string, s: Shape) =>
  `| ${label} | ${f(s.mean)} | ${f(s.sd)} | ${fq(s)} | ${f(s.p200)}% | ${f(s.u120)}% |${s.allOut !== undefined ? ` ${f(s.allOut)}% / ${f(s.u120AllOut!)}% |` : " |"}${s.wickets !== undefined ? ` ${f(s.wickets, 2)} |` : ""}`;

function engineShape(rows: Row[], hundred: boolean): Shape {
  const first = rows.filter(r => r.innings === 1);
  const s = shapeOf(first.map(r => r.runs), null, hundred);
  const [, lo] = thresholds(hundred);
  return {
    ...s, allOut: (100 * first.filter(r => r.wk >= 10).length) / first.length, u120AllOut: (100 * first.filter(r => r.wk >= 10 && r.runs < lo).length) / first.length,
    wickets: first.reduce((a, r) => a + r.wk, 0) / first.length,
  };
}
it.skipIf(!process.env.CALIBRATE_SPREAD)("T20 innings spread", () => {
  const REAL = JSON.parse(readFileSync(join(REPO, "docs", "data", "t20_spread.json"), "utf-8")) as Real;
  const leagues = leagueList();
  const men = leagues.filter(l => REAL.leagues[l.id]?.gender === "men");
  // CAL_NO_WIH=1: without the first innings' wickets-in-hand table (wickets-in-hand.ts), for a before / after
  if (process.env.CAL_NO_WIH) for (const k of Object.keys(WICKETS_IN_HAND_NORM)) delete WICKETS_IN_HAND_NORM[k];

  const report = (label: string) => {
    console.log(`\n${label}`);
    console.log("| league | mean | sd | deviation at 10 / 25 / 50 / 75 / 90% | 200+ | under 120 | all out / all out under 120 | wickets |");
    for (const lg of leagues) {
      const real = REAL.leagues[lg.id];
      if (!real) continue;
      const rows = play(lg);
      const e = engineShape(rows, lg.hundred);
      const r = realShape(real, e.mean, lg.hundred);
      const mt = matchTerm(windowRows(rows));
      console.log(shapeRow(`${lg.id} real (centred, at the engine's mean)`, { ...r, allOut: real.firstInnings.allOut, u120AllOut: real.firstInnings.under120AllOut }));
      console.log(shapeRow(`${lg.id} engine`, e) + ` match term ${f(mt.run)} (real ${f(real.match.run)})`);
    }
  };

  if (!process.env.CAL_FIT) { report(`conditions ${JSON.stringify(MATCH_CONDITIONS)}`); return; }

  // ── Fit: each men's league at a grid of fixed run multipliers ──
  const GRID = Array.from({ length: Number(process.env.CAL_GRID_LEN ?? 29) }, (_, k) => Number((-0.6 + 0.05 * k).toFixed(2)));
  const NG = Number(process.env.CAL_GRID_MATCHES ?? 800);
  const saved = { male: { ...MATCH_CONDITIONS.male }, female: { ...MATCH_CONDITIONS.female } };
  const grids = new Map<string, { totals: number[][]; means: number[]; real: RealLeague; hundred: boolean }>();
  for (const lg of men) {
    const totals: number[][] = [];
    for (const g of GRID) {
      MATCH_CONDITIONS.male = { [lg.id]: { lo: 0, hi: 0, center: g } };
      totals.push(play(lg, NG, 20000 + Math.round(g * 1000) * 37).filter(r => r.innings === 1).map(r => r.runs));
    }
    grids.set(lg.id, { totals, means: totals.map(t => t.reduce((a, b) => a + b, 0) / t.length), real: REAL.leagues[lg.id], hundred: lg.hundred });
  }
  MATCH_CONDITIONS.male = saved.male; MATCH_CONDITIONS.female = saved.female;

  const g0 = GRID.findIndex(g => Math.abs(g) < 1e-9);
  /** The mixture for a two-piece normal term (lo, hi; centre solved for the mean at no term) */
  const mixture = (id: string, lo: number, hi: number) => {
    const G = grids.get(id)!;
    const base = G.means[g0];
    const weightsAt = (c: number) => GRID.map(g => {
      if (lo === 0 && hi === 0) return Math.abs(g - c) < 0.025 ? 1 : 0;
      if (g < c && lo === 0) return 0;
      const sd = g < c ? Math.max(lo, 1e-3) : Math.max(hi, 1e-3);
      return Math.exp(-((g - c) ** 2) / (2 * sd * sd)) / ((lo + hi) / 2 || 1);
    });
    const meanAt = (c: number) => { const w = weightsAt(c); const W = w.reduce((a, b) => a + b, 0); return w.reduce((s, x, k) => s + x * G.means[k], 0) / W; };
    let a = -0.5, b = 0.3;
    for (let it = 0; it < 30; it++) { const c = (a + b) / 2; if (meanAt(c) < base) a = c; else b = c; }
    const center = lo === 0 && hi === 0 ? 0 : (a + b) / 2;
    const w = weightsAt(center);
    const xs: number[] = [], ws: number[] = [];
    G.totals.forEach((t, k) => { if (w[k] > 0) for (const x of t) { xs.push(x); ws.push(w[k] / t.length); } });
    return { center, shape: shapeOf(xs, ws, G.hundred, base), base };
  };
  const loss = (id: string, sh: Shape) => {
    const G = grids.get(id)!;
    const r = realShape(G.real, sh.mean, G.hundred);
    return QS.reduce((s, _, k) => s + (sh.q[k] - r.q[k]) ** 2, 0) + 4 * ((sh.p200 - r.p200) ** 2 + (sh.u120 - r.u120) ** 2);
  };
  // shapes: hi = ratio x lo (ratio Infinity: one-sided, a "batting paradise" term above the centre only); a candidate whose
  // tails (2.5 sd) leave the grid is skipped
  const SCALES = Array.from({ length: Number(process.env.CAL_SCALE_LEN ?? 31) }, (_, k) => 0.01 * k);
  const RATIOS = [0.5, 1, 1.5, 2, 3, 4, 6, Infinity];
  let best = { ratio: 1, total: Infinity, per: new Map<string, { lo: number; hi: number; center: number; loss: number }>() };
  for (const ratio of RATIOS) {
    const per = new Map<string, { lo: number; hi: number; center: number; loss: number }>();
    let total = 0;
    for (const id of grids.keys()) {
      let pick = { lo: 0, hi: 0, center: 0, loss: Infinity };
      for (const s of SCALES) {
        const [lo, hi] = ratio === Infinity ? [0, s] : [s, s * ratio];
        const m = mixture(id, lo, hi);
        if (m.center + 2.5 * hi > GRID[GRID.length - 1] || m.center - 2.5 * lo < GRID[0]) continue;
        const l = loss(id, m.shape);
        if (l < pick.loss) pick = { lo, hi, center: m.center, loss: l };
      }
      per.set(id, pick);
      total += pick.loss;
    }
    console.log(`ratio ${ratio}: total loss ${f(total)} | ` + [...per].map(([id, p]) => `${id} ${p.lo.toFixed(2)}/${p.hi.toFixed(2)}`).join(", "));
    if (total < best.total) best = { ratio, total, per };
  }
  console.log(`\nbest ratio ${best.ratio}`);
  console.log("| league | mean | sd | deviation at 10 / 25 / 50 / 75 / 90% | 200+ | under 120 |");
  const shapes: Record<string, ConditionsShape | null> = {};
  for (const [id, p] of best.per) {
    const G = grids.get(id)!;
    const none = mixture(id, 0, 0), fit = mixture(id, p.lo, p.hi);
    console.log(shapeRow(`${id} real`, realShape(G.real, none.base, G.hundred)));
    console.log(shapeRow(`${id} no term (grid)`, none.shape));
    console.log(shapeRow(`${id} fitted ${p.lo.toFixed(2)}/${p.hi.toFixed(2)} centre ${p.center.toFixed(3)} (mixture)`, fit.shape));
    shapes[id] = p.lo > 0 || p.hi > 0 ? { lo: p.lo, hi: Number(p.hi.toFixed(3)), center: Number(p.center.toFixed(4)) } : null;
  }
  // the centre again, from drawn matches (the grid's means are noisy): the mean first innings with the term against the
  // same matches without it (CAL_CENTRE_MATCHES, default 5,000: about half a run of noise), moved by the grid's slope of the
  // mean on the log multiplier near 1
  const NC = Number(process.env.CAL_CENTRE_MATCHES ?? 5000);
  const meanOf = (lg: (typeof men)[number]) => { const r = play(lg, NC, 70000).filter(x => x.innings === 1); return r.reduce((a, x) => a + x.runs, 0) / r.length; };
  MATCH_CONDITIONS.male = {}; MATCH_CONDITIONS.female = {};
  const noTermMean = new Map(men.map(lg => [lg.id, meanOf(lg)]));
  MATCH_CONDITIONS.male = { ...shapes };
  for (const lg of men) {
    const sh = shapes[lg.id];
    if (!sh) continue;
    const G = grids.get(lg.id)!;
    const near = GRID.map((g, k) => [g, G.means[k]] as const).filter(([g]) => Math.abs(g) <= 0.15);
    const mg = near.reduce((a, [g]) => a + g, 0) / near.length, mm = near.reduce((a, [, m]) => a + m, 0) / near.length;
    const slope = near.reduce((a, [g, m]) => a + (g - mg) * (m - mm), 0) / near.reduce((a, [g]) => a + (g - mg) ** 2, 0);
    const drawn = meanOf(lg);
    sh.center = Number((sh.center + (noTermMean.get(lg.id)! - drawn) / slope).toFixed(4));
    console.log(`${lg.id}: mean without ${f(noTermMean.get(lg.id)!)}, with ${f(drawn)}, slope ${f(slope)} -> centre ${sh.center}`);
  }
  const fitted = Object.values(shapes).filter((x): x is ConditionsShape => !!x).sort((a, b) => a.lo - b.lo);
  if (fitted.length) shapes.default = fitted[Math.floor(fitted.length / 2)];
  MATCH_CONDITIONS.male = shapes;
  MATCH_CONDITIONS.female = {};
  report(`fitted, drawn ${JSON.stringify(MATCH_CONDITIONS)}`);

  // the T20I shapes (CAL_T20I fit below) are kept as they are
  const kept = (g: "male" | "female"): Record<string, ConditionsShape | null> => (saved[g].t20i ? { t20i: saved[g].t20i } : {});
  if (process.env.CALIBRATE_WRITE) {
    writeConditions({ ...shapes, ...kept("male") }, kept("female"));
  }
}, 7_200_000);

it.skipIf(!process.env.CAL_T20I)("T20I innings spread", async () => {
  const REAL = JSON.parse(readFileSync(join(REPO, "docs", "data", "t20_spread.json"), "utf-8")) as Real;
  const VALID = JSON.parse(readFileSync(join(REPO, "docs", "data", "t20i_validation.json"), "utf-8")) as { t20i: Record<SeriesGender, { fixtures: [string, string, number][] }> };
  const PUBLIC = join(HERE, "..", "..", "public");
  const FILE = JSON.parse(readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;
  const ACTIVITY = JSON.parse(readFileSync(join(PUBLIC, "data", "player-activity.json"), "utf-8")) as PlayerActivityFile;
  const replays = Number(process.env.CAL_REPLAYS ?? 2);
  const genders = (process.env.CAL_GENDER ? [process.env.CAL_GENDER] : ["men", "women"]) as SeriesGender[];
  const saved = { male: { ...MATCH_CONDITIONS.male }, female: { ...MATCH_CONDITIONS.female } };
  const GRID = Array.from({ length: 39 }, (_, k) => Number((-0.9 + 0.05 * k).toFixed(2)));
  const g0 = GRID.findIndex(g => Math.abs(g) < 1e-9);
  const out: Record<"male" | "female", ConditionsShape | null> = { male: saved.male.t20i ?? null, female: saved.female.t20i ?? null };

  for (const gender of genders) {
    const mg = gender === "women" ? "female" : "male";
    const real = REAL.leagues[gender === "women" ? "t20i-w" : "t20i-m"];
    const extended = await createPoolLoader(async f => new Uint8Array(readFileSync(join(PUBLIC, "pool", f)))).players(gender, ["senior"]);
    const pairings = VALID.t20i[gender].fixtures.map(([a, b, n], i) => {
      const series = createSeries({ format: "t20i", gender, nations: [a, b], length: 1, host: "neutral", userSide: null, seed: 1000 + i }, FILE, ACTIVITY, extended);
      return { series, squads: seriesSquads(series, FILE, extended), n };
    });
    /** First-innings totals of the replayed fixtures (reps replays each) */
    const play = (reps: number, seed0: number): number[] => {
      const totals: number[] = [];
      pairings.forEach(({ series, squads, n }, pi) => {
        for (let j = 0; j < n * reps; j++) {
          const m = matchContext(series, 0, squads);
          const [home, away]: [Team, Team] = [m.home, m.away];
          const r = simulateMatch(home, away, m.rules!, seed0 + 7919 * pi + 104729 * j, { countTowardStandings: false, neutralVenue: true });
          totals.push(r.innings[0].runs);
        }
      });
      return totals;
    };
    const setCond = (s: ConditionsShape | null) => { MATCH_CONDITIONS[mg] = { ...saved[mg], t20i: s }; };
    const grid: number[][] = [];
    for (const g of GRID) { setCond({ lo: 0, hi: 0, center: g }); grid.push(play(replays, 20000 + Math.round(g * 1000) * 37)); }
    const means = grid.map(t => t.reduce((a, b) => a + b, 0) / t.length);
    const base = means[g0];
    const weightsAt = (lo: number, hi: number, c: number) => GRID.map(g => {
      if (lo === 0 && hi === 0) return Math.abs(g - c) < 0.025 ? 1 : 0;
      if (g < c && lo === 0) return 0;
      const sd = g < c ? Math.max(lo, 1e-3) : Math.max(hi, 1e-3);
      return Math.exp(-((g - c) ** 2) / (2 * sd * sd)) / ((lo + hi) / 2 || 1);
    });
    const mixture = (lo: number, hi: number) => {
      const meanAt = (c: number) => { const w = weightsAt(lo, hi, c); const W = w.reduce((a, b) => a + b, 0); return w.reduce((s, x, k) => s + x * means[k], 0) / W; };
      let a = -0.9, b = 0.6;
      for (let it = 0; it < 30; it++) { const c = (a + b) / 2; if (meanAt(c) < base) a = c; else b = c; }
      const center = lo === 0 && hi === 0 ? 0 : (a + b) / 2;
      const w = weightsAt(lo, hi, center);
      const xs: number[] = [], ws: number[] = [];
      grid.forEach((t, k) => { if (w[k] > 0) for (const x of t) { xs.push(x); ws.push(w[k] / t.length); } });
      return { center, shape: shapeOf(xs, ws, false, base) };
    };
    const loss = (sh: Shape) => {
      const r = realShape(real, sh.mean, false);
      return QS.reduce((s, _, k) => s + (sh.q[k] - r.q[k]) ** 2, 0) + 4 * ((sh.p200 - r.p200) ** 2 + (sh.u120 - r.u120) ** 2);
    };
    const SCALES = Array.from({ length: 41 }, (_, k) => 0.01 * k);
    const RATIOS = [0.5, 1, 1.5, 2, 3, 4, 6, Infinity];
    let best = { ratio: 1, lo: 0, hi: 0, center: 0, loss: Infinity };
    for (const ratio of RATIOS) {
      let pick = { lo: 0, hi: 0, center: 0, loss: Infinity };
      for (const s of SCALES) {
        const [lo, hi] = ratio === Infinity ? [0, s] : [s, s * ratio];
        const m = mixture(lo, hi);
        if (m.center + 2.5 * hi > GRID[GRID.length - 1] || m.center - 2.5 * lo < GRID[0]) continue;
        const l = loss(m.shape);
        if (l < pick.loss) pick = { lo, hi, center: m.center, loss: l };
      }
      console.log(`${gender} ratio ${ratio}: loss ${f(pick.loss)} | ${pick.lo.toFixed(2)}/${pick.hi.toFixed(2)} centre ${pick.center.toFixed(3)}`);
      if (pick.loss < best.loss) best = { ratio, ...pick };
    }
    const none = mixture(0, 0), fit = mixture(best.lo, best.hi);
    console.log("| T20I | mean | sd | deviation at 10 / 25 / 50 / 75 / 90% | 200+ | under 120 |");
    console.log(shapeRow(`${gender} real`, realShape(real, none.shape.mean, false)));
    console.log(shapeRow(`${gender} no term (grid)`, none.shape));
    console.log(shapeRow(`${gender} fitted ${best.lo.toFixed(2)}/${best.hi.toFixed(2)} centre ${best.center.toFixed(3)} (mixture)`, fit.shape));
    // the centre again, from drawn matches: the mean first innings with the term against the same matches without it
    const sh: ConditionsShape = { lo: best.lo, hi: Number(best.hi.toFixed(3)), center: Number(best.center.toFixed(4)) };
    const near = GRID.map((g, k) => [g, means[k]] as const).filter(([g]) => Math.abs(g) <= 0.15);
    const mgm = near.reduce((a, [g]) => a + g, 0) / near.length, mmm = near.reduce((a, [, m]) => a + m, 0) / near.length;
    const slope = near.reduce((a, [g, m]) => a + (g - mgm) * (m - mmm), 0) / near.reduce((a, [g]) => a + (g - mgm) ** 2, 0);
    const NC = Math.max(replays, Number(process.env.CAL_CENTRE_REPLAYS ?? 6));
    const avg = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
    // no term at all for the base mean: no t20i shape, and no default either (the men's T20I fell back to it)
    MATCH_CONDITIONS[mg] = { ...saved[mg], t20i: null, default: null };
    const noTerm = avg(play(NC, 70000));
    setCond(sh);
    const drawn = avg(play(NC, 70000));
    sh.center = Number((sh.center + (noTerm - drawn) / slope).toFixed(4));
    console.log(`${gender}: mean without ${f(noTerm)}, with ${f(drawn)}, slope ${f(slope)} -> centre ${sh.center}`);
    setCond(sh);
    const fin = play(NC, 80000);
    console.log(shapeRow(`${gender} drawn (${fin.length} matches)`, shapeOf(fin, null, false)));
    out[mg] = sh.lo > 0 || sh.hi > 0 ? sh : null;
  }
  MATCH_CONDITIONS.male = saved.male; MATCH_CONDITIONS.female = saved.female;
  console.log(JSON.stringify(out));
  if (process.env.CALIBRATE_WRITE) {
    writeConditions({ ...saved.male, t20i: out.male }, { ...saved.female, t20i: out.female });
  }
}, 7_200_000);
