/**
 * Out-of-sample checks for the ODI / Test level (format-model.ts).
 *
 * Rate every CA player with data up to season Y, then predict how he did in internationals against full members in
 * Y+1..Y+2: his ball-weighted mean adjusted value there (CA cells `ListAI v <full member>` / `FCI v ...`, plus the
 * opponent's fitted strength, so the target is on the ratings' own scale). Candidates are compared with simple
 * baselines, the most important being the T20 rating itself (what the game plays ODIs and Tests on without format
 * ratings). DATA_VAR (how far the format's own record is trusted against the translated prior) is tuned on correlation,
 * pooled over Y = 2014, 2017, 2020 (targets 2015-16, 2018-19, 2021-22); Y = 2023 (target 2024-25) is the held-out check. Caveat, as in docs/CA-RATINGS-REPORT.md: the
 * competition strengths and the CA model's K / half-life were fitted on every year, the target years included.
 */

import { execFileSync } from "child_process";
import {
  DOM_COUNTRIES, fitWls, loadIntlEvidence,
  buildContext, doesSide, estimateFormat, fitTranslations, loadCaFormats, RANK_CONSERVATISM,
  type CaFormat, type CaPlayerFormats, type EstimateContext, type Gender, type Side,
} from "./format-model.js";

const DIR = new URL("../../data/analysis/", import.meta.url).pathname;

/** Target-period balls for a player to enter the check */
export const TARGET_BALLS: Record<"ListA" | "FC", number> = { ListA: 200, FC: 500 };

function duck<T>(sql: string): T[] {
  return JSON.parse(execFileSync("duckdb", ["-json", "-c", sql], { encoding: "utf-8", maxBuffer: 1024 * 1024 * 1024 }) || "[]") as T[];
}

export interface IntlRecord { balls: number; adj: number; raw: number }

/** Per player and side: international (v full members) balls, adjusted and raw value per 100 balls, in [from, to] */
export function intlRecords(gender: Gender, format: "ListA" | "FC", from: number, to: number): Record<Side, Map<number, IntlRecord>> {
  const rows = duck<{ player_id: number; side: Side; balls: number; adj: number; raw: number }>(`
    WITH s AS (SELECT side, format, gender, comp, strength FROM read_csv('${DIR}ca_comp_strength.csv'))
    SELECT c.player_id, c.side, sum(c.balls) AS balls,
           100 * sum(c.value_ms + c.balls * coalesce(s.strength, 0) / 100) / sum(c.balls) AS adj,
           100 * sum(c.value) / sum(c.balls) AS raw
    FROM '${DIR}ca_cells.parquet' c LEFT JOIN s USING (side, format, gender, comp)
    WHERE c.gender = '${gender}' AND c.format = '${format}' AND c.comp_class = 'intl_full' AND c.year BETWEEN ${from} AND ${to} AND c.balls > 0
    GROUP BY ALL`);
  const out: Record<Side, Map<number, IntlRecord>> = { bat: new Map(), bowl: new Map() };
  for (const r of rows) out[r.side].set(Number(r.player_id), { balls: r.balls, adj: r.adj, raw: r.raw });
  return out;
}

export interface Metric { n: number; corr: number; mse: number; bias: number }

export function weightedMetrics(xs: number[], ys: number[], ws: number[]): Metric {
  const sw = ws.reduce((s, w) => s + w, 0);
  if (xs.length < 3 || sw === 0) return { n: xs.length, corr: NaN, mse: NaN, bias: NaN };
  const mx = xs.reduce((s, x, i) => s + x * ws[i], 0) / sw, my = ys.reduce((s, y, i) => s + y * ws[i], 0) / sw;
  let cxy = 0, cxx = 0, cyy = 0, se = 0;
  for (let i = 0; i < xs.length; i++) {
    cxy += ws[i] * (xs[i] - mx) * (ys[i] - my); cxx += ws[i] * (xs[i] - mx) ** 2; cyy += ws[i] * (ys[i] - my) ** 2;
    se += ws[i] * (xs[i] - ys[i]) ** 2;
  }
  return { n: xs.length, corr: cxx > 0 && cyy > 0 ? cxy / Math.sqrt(cxx * cyy) : NaN, mse: se / sw, bias: my - mx };
}

export type Predictor = (id: number, p: CaPlayerFormats) => number | undefined;

export interface FoldResult { predictor: string; all: Metric; common?: Metric }

/**
 * One fold: players rated up to Y with a target in Y+1..Y+2. `rows` holds every predictor's metric on the players it
 * covers, and on the players every predictor covers (`common`), so the comparison is like for like.
 */
export function evaluate(
  players: Map<number, CaPlayerFormats>, target: Map<number, IntlRecord>, minBalls: number,
  predictors: Record<string, Predictor>, filter: (id: number, p: CaPlayerFormats) => boolean = () => true,
): FoldResult[] {
  const ids = [...target.entries()].filter(([id, t]) => t.balls >= minBalls && players.has(id) && filter(id, players.get(id)!)).map(([id]) => id);
  const preds: Record<string, Map<number, number>> = {};
  for (const [name, f] of Object.entries(predictors)) {
    const m = new Map<number, number>();
    for (const id of ids) { const v = f(id, players.get(id)!); if (v !== undefined && Number.isFinite(v)) m.set(id, v); }
    preds[name] = m;
  }
  const common = ids.filter(id => Object.values(preds).every(m => m.has(id)));
  const metric = (m: Map<number, number>, list: number[]) => {
    const use = list.filter(id => m.has(id));
    return weightedMetrics(use.map(id => m.get(id)!), use.map(id => target.get(id)!.adj), use.map(id => target.get(id)!.balls));
  };
  return Object.entries(preds).map(([predictor, m]) => ({ predictor, all: metric(m, ids), common: metric(m, common) }));
}

/** Raw (unadjusted) value per 100 balls in internationals up to Y, career and last season: the naive baselines */
export function intlHistory(gender: Gender, format: "ListA" | "FC", asOf: number): { career: Record<Side, Map<number, IntlRecord>>; last: Record<Side, Map<number, IntlRecord>> } {
  return { career: intlRecords(gender, format, 2000, asOf), last: intlRecords(gender, format, asOf, asOf) };
}

export interface FormatValidation {
  gender: Gender; format: "ListA" | "FC"; side: Side;
  dataVar: number;
  /** Pooled over the tuning folds, per DATA_VAR */
  tuning: { dataVar: number; corr: number; mse: number; n: number }[];
  holdout: FoldResult[];
  /**
   * Derived ratings, checked by hiding: the same held-out players rated as if they had no record in the format (the
   * translated prior shrunk toward the below-average prior). `bias` > 0: they did better than the derived rating said.
   */
  masked: FoldResult[];
  /** All four folds pooled (the tuning folds chose DATA_VAR from a flat grid, so mildly in-sample): more players */
  pooled: FoldResult[];
}

const DATA_VAR_GRID = [0.25, 0.5, 1, 2, 4, 1e9];
const MIN_TUNING_PLAYERS = 30;
/** Tuning folds (rate through Y, target Y+1..Y+2; non-overlapping) and the held-out fold */
export const TUNING_YEARS = [2014, 2017, 2020];
export const HOLDOUT_YEAR = 2023;

/** The player as he would look with no record in `format` for `side` */
function withoutFormat(p: CaPlayerFormats, format: CaFormat, side: Side): CaPlayerFormats {
  const q: CaPlayerFormats = { ...p };
  const f = { ...(p[format] ?? {}) };
  delete f[side];
  q[format] = f;
  return q;
}

/** Tune DATA_VAR on the pooled tuning folds and report the held-out fold, for one gender, format and side */
export function validate(gender: Gender, format: "ListA" | "FC", side: Side, cache: Map<number, Map<number, CaPlayerFormats>>): FormatValidation {
  const load = (y: number) => { if (!cache.has(y)) cache.set(y, loadCaFormats(gender, y)); return cache.get(y)!; };
  const minBalls = TARGET_BALLS[format];
  const hasData = (_id: number, p: CaPlayerFormats) => doesSide(p[format]?.[side]);

  // tuning: pool the folds' (prediction, target) pairs per DATA_VAR
  const folds = TUNING_YEARS.map(y => {
    const players = load(y);
    return { y, players, target: intlRecords(gender, format, y + 1, y + 2)[side], translations: fitTranslations(players.values(), gender) };
  });
  const tuning = DATA_VAR_GRID.map(dataVar => {
    const xs: number[] = [], ys: number[] = [], ws: number[] = [];
    for (const f of folds) {
      const ctx = buildContext(f.players, format, gender, f.y, dataVar, f.translations);
      for (const [id, t] of f.target) {
        const p = f.players.get(id);
        if (t.balls < minBalls || !p || !hasData(id, p)) continue;
        const est = estimateFormat(p, format, side, ctx);
        if (!est) continue;
        xs.push(est.mean); ys.push(t.adj); ws.push(t.balls);
      }
    }
    const m = weightedMetrics(xs, ys, ws);
    return { dataVar, corr: m.corr, mse: m.mse, n: m.n };
  });
  // Ranks are what the game keeps (format ratings are a percentile map of the score), so tune on correlation
  // Too few players to tune (women's Tests): the CA sd as it is
  const best = tuning.filter(t => Number.isFinite(t.corr) && t.n >= MIN_TUNING_PLAYERS).sort((a, b) => b.corr - a.corr)[0] ?? { dataVar: 1 };

  // held-out fold
  const players = load(HOLDOUT_YEAR);
  const target = intlRecords(gender, format, HOLDOUT_YEAR + 1, HOLDOUT_YEAR + 2)[side];
  const hist = intlHistory(gender, format, HOLDOUT_YEAR);
  const translations = fitTranslations(players.values(), gender);
  const ctx: EstimateContext = buildContext(players, format, gender, HOLDOUT_YEAR, best.dataVar, translations);
  const t20 = translations[`${side}/T20>${format}`];
  const t20Rating: Predictor = (_id, p) => doesSide(p.T20?.[side]) ? p.T20![side]!.rating : undefined;
  const holdout = evaluate(players, target, minBalls, {
    "format rating (own record + translated prior)": (_id, p) => estimateFormat(p, format, side, ctx)?.mean,
    "format rating, ranked conservatively (mean - 0.5 sd, as shipped)": (_id, p) => {
      const e = estimateFormat(p, format, side, ctx);
      return e ? e.mean - RANK_CONSERVATISM * e.sd : undefined;
    },
    "format rating, own record only": (_id, p) => doesSide(p[format]?.[side]) ? p[format]![side]!.rating : undefined,
    "T20 rating (no format ratings)": t20Rating,
    [side === "bowl" ? "T20 rating translated (with T20 style)" : "T20 rating translated"]: (_id, p) => {
      if (!doesSide(p.T20?.[side]) || !t20) return undefined;
      const st = t20.c && p.style?.[side];
      return t20.a + t20.b * p.T20![side]!.rating + (st ? t20.c![0] * st[0] + t20.c![1] * st[1] : 0);
    },
    "naive: career international value": id => { const h = hist.career[side].get(id); return h && h.balls >= 100 ? h.raw : undefined; },
    "naive: last season international value": id => { const h = hist.last[side].get(id); return h && h.balls >= 60 ? h.raw : undefined; },
  }, hasData);

  const noShrink = { ...ctx, prior: { bat: { mean: 0, sd: 1e6 }, bowl: { mean: 0, sd: 1e6 } } };
  const masked = evaluate(players, target, minBalls, {
    "derived (translated, shrunk to the below-average prior)": (_id, p) => estimateFormat(withoutFormat(p, format, side), format, side, ctx)?.mean,
    "translated, not shrunk": (_id, p) => estimateFormat(withoutFormat(p, format, side), format, side, noShrink)?.mean,
    "T20 rating (no format ratings)": t20Rating,
  }, hasData);
  // Pooled over every fold with the chosen DATA_VAR
  const pooledPlayers = new Map<number, CaPlayerFormats>(), pooledTarget = new Map<number, IntlRecord>();
  const preds: Record<string, Map<number, number>> = { final: new Map(), own: new Map(), t20: new Map() };
  for (const f of [...folds, { y: HOLDOUT_YEAR, players, target, translations }]) {
    const c = buildContext(f.players, format, gender, f.y, best.dataVar, f.translations);
    for (const [id, t] of f.target) {
      const p = f.players.get(id);
      if (t.balls < minBalls || !p || !hasData(id, p)) continue;
      const key = f.y * 10_000_000 + id; // a player in two folds counts twice, once per fold
      pooledPlayers.set(key, p); pooledTarget.set(key, t);
      const e = estimateFormat(p, format, side, c);
      if (e) preds.final.set(key, e.mean);
      preds.own.set(key, p[format]![side]!.rating);
      if (doesSide(p.T20?.[side])) preds.t20.set(key, p.T20![side]!.rating);
    }
  }
  const pooled = evaluate(pooledPlayers, pooledTarget, minBalls, {
    "format rating (own record + translated prior)": key => preds.final.get(key),
    "format rating, own record only": key => preds.own.get(key),
    "T20 rating (no format ratings)": key => preds.t20.get(key),
  });
  return { gender, format, side, dataVar: best.dataVar, tuning, holdout, masked, pooled };
}

/**
 * Is the format's own international record weighted enough against domestic cricket, and is any country's domestic
 * cricket translated too generously? Out of sample on the same folds: the shipped estimate, then the estimate plus
 * (a) the player's international-only residual (his ODI / Test adjusted value minus his List A / first-class rating,
 * shrunk by balls / (balls + K)), (b) a term per domestic country on his share of balls there, fitted on the tuning
 * folds (weighted least squares on target minus estimate) and scored on the held-out fold.
 */
export interface IntlEvidenceCheck {
  gender: Gender; format: "ListA" | "FC"; side: Side;
  tuneN: number; holdN: number;
  base: { tune: number; hold: number };
  /** Per K: the fitted weight on the shrunk international residual and the held-out correlation with it alone, and with the country terms */
  byK: { K: number; beta: number; holdIntl: number; holdBoth: number }[];
  /** The domestic-country terms (runs per 100 balls for a player whose balls were all there) and the held-out correlation with them alone */
  countries: Record<string, number>;
  holdCountries: number;
}

export function checkIntlEvidence(gender: Gender, format: "ListA" | "FC", side: Side, dataVar: number): IntlEvidenceCheck {
  const COUNTRIES = [...DOM_COUNTRIES, "other"];
  type R = { y: number; nI: number; dI: number; shares: number[]; t: number; w: number; est: number };
  const rows: R[] = [];
  for (const Y of [...TUNING_YEARS, HOLDOUT_YEAR]) {
    const players = loadCaFormats(gender, Y);
    loadIntlEvidence(players, gender, Y);
    const ctx = buildContext(players, format, gender, Y, dataVar);
    for (const [id, t] of intlRecords(gender, format, Y + 1, Y + 2)[side]) {
      const p = players.get(id), r = p?.[format]?.[side];
      if (t.balls < TARGET_BALLS[format] || !p || !doesSide(r)) continue;
      const e = estimateFormat(p, format, side, ctx);
      if (!e) continue;
      rows.push({ y: Y, nI: r.intlBalls ?? 0, dI: r.intlAdj !== undefined ? r.intlAdj - r.rating : 0, shares: COUNTRIES.map(c => r.domShare?.[c] ?? 0), t: t.adj, w: t.balls, est: e.mean });
    }
  }
  const tune = rows.filter(r => r.y !== HOLDOUT_YEAR), hold = rows.filter(r => r.y === HOLDOUT_YEAR);
  const corr = (f: (r: R) => number, set: R[]) => weightedMetrics(set.map(f), set.map(r => r.t), set.map(r => r.w)).corr;
  const byK = [250, 1000, 4000].map(K => {
    const g = (r: R) => (r.nI / (r.nI + K)) * r.dI;
    const fi = fitWls(tune.map(r => ({ xs: [g(r)], y: r.t - r.est, w: r.w })));
    const fb = fitWls(tune.map(r => ({ xs: [g(r), ...r.shares], y: r.t - r.est, w: r.w })));
    return {
      K, beta: fi?.coef[1] ?? 0,
      holdIntl: fi ? corr(r => r.est + fi.coef[1] * g(r), hold) : NaN,
      holdBoth: fb ? corr(r => r.est + fb.coef[1] * g(r) + r.shares.reduce((t, x, i) => t + fb.coef[2 + i] * x, 0), hold) : NaN,
    };
  });
  const fc = fitWls(tune.map(r => ({ xs: r.shares, y: r.t - r.est, w: r.w })));
  return {
    gender, format, side, tuneN: tune.length, holdN: hold.length,
    base: { tune: corr(r => r.est, tune), hold: corr(r => r.est, hold) },
    byK,
    countries: Object.fromEntries(COUNTRIES.map((c, i) => [c, +(fc?.coef[1 + i] ?? 0).toFixed(1)])),
    holdCountries: fc ? corr(r => r.est + r.shares.reduce((t, x, i) => t + fc.coef[1 + i] * x, 0), hold) : NaN,
  };
}
