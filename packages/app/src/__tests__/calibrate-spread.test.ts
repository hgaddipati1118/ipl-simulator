import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import {
  EXTRA_LEAGUES, MATCH_CONDITIONS, RULE_PRESETS, createMatchState, simulateMatch, simulateRemaining,
  type BallEvent, type RuleSet,
} from "@ipl-sim/engine";
import { createGameState } from "../game-state";

/**
 * The spread of innings totals (skipped unless CALIBRATE_SPREAD=1): each league played by the game's own squads (random
 * pairings at the home side's ground, injuries and rain off, instant engine), its first-innings distribution next to the
 * real one, and the same decomposition t20-spread.py makes of the real matches (docs/data/t20_spread.json): the first ten
 * overs' runs (r10) and wickets (w10) into the batting side, the bowling side, the ground and the rest, then the match term
 * as the within-match covariance of the two innings' residuals. The engine's match conditions (match-conditions.ts) are
 * fitted to it, pooled per gender over the T20 leagues: the match multiplier's spread so the simulated match term equals
 * the real one (a chase's response to its target makes some covariance in both), and its centre so the mean total stays
 * where it was. CAL_FIT=1 measures at zero and at a trial
 * spread, solves (the term grows with the spread's square), then the centre, and with CALIBRATE_WRITE=1 writes
 * match-conditions-data.ts.
 *   CALIBRATE_SPREAD=1 npx vitest run packages/app/src/__tests__/calibrate-spread.test.ts --reporter=verbose
 *   CALIBRATE_SPREAD=1 CAL_FIT=1 CALIBRATE_WRITE=1 npx vitest run packages/app/src/__tests__/calibrate-spread.test.ts --reporter=verbose
 * CAL_MATCHES (default 1500) matches per league; CAL_ONLY=ipl,bbl limits the leagues; CAL_LIVE=1 adds the live engine's IPL.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const OUT = join(REPO, "packages", "engine", "src", "match-conditions-data.ts");
const N = Number(process.env.CAL_MATCHES ?? 1500);

interface Inn { teamId: string; runs: number; wickets: number; ballLog: BallEvent[] }
interface Row { lg: string; match: string; innings: 1 | 2; bat: string; bowl: string; ground: string; runs: number; wk: number; r10: number; w10: number; lastOver: number }
interface RealLeague {
  gender: "men" | "women"; hundred: boolean;
  firstInnings: { matches: number; mean: number; sd: number; p200: number; under120: number };
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

function play(lg: { id: string; rules: RuleSet; hundred: boolean }, live = false): Row[] {
  const rules = { ...lg.rules, injuriesEnabled: false } as RuleSet;
  const teams = createGameState(rules).teams;
  const rows: Row[] = [];
  for (let i = 0; i < N; i++) {
    const home = teams[i % teams.length];
    let away = teams[(i * 7 + 3) % teams.length];
    if (away === home) away = teams[(i * 7 + 4) % teams.length];
    if (!live) {
      const r = simulateMatch(home, away, rules, 9100 + i, { countTowardStandings: false });
      rows.push(...inningsRows(lg.id, `${lg.id}-${i}`, r.innings as Inn[], home.id));
    } else {
      const { state } = simulateRemaining(createMatchState(home, away, rules, null, 9100 + i));
      const inns = [state._internal.innings1Raw, state._internal.currentInningsRaw].filter(Boolean) as Inn[];
      rows.push(...inningsRows(lg.id, `${lg.id}-${i}`, inns, home.id));
    }
  }
  return rows;
}

function distribution(rows: Row[], hundred: boolean) {
  const first = rows.filter(r => r.innings === 1).map(r => r.runs);
  const [hi, lo] = hundred ? [(200 * 100) / 120, 100] : [200, 120];
  const m = first.reduce((a, b) => a + b, 0) / first.length;
  const sd = Math.sqrt(first.reduce((a, x) => a + (x - m) ** 2, 0) / (first.length - 1));
  return { mean: m, sd, p200: (100 * first.filter(x => x >= hi).length) / first.length, under120: (100 * first.filter(x => x < lo).length) / first.length };
}

const f = (x: number, d = 1) => x.toFixed(d);

it.skipIf(!process.env.CALIBRATE_SPREAD)("T20 innings spread", () => {
  const REAL = JSON.parse(readFileSync(join(REPO, "docs", "data", "t20_spread.json"), "utf-8")) as Real;
  const leagues = leagueList();
  const report = (label: string) => {
    console.log(`| ${label} | real: 1st inns mean (sd) / 200+ / <120 | sim | real r10 bat / bowl / ground / rest | sim | real match run / wkt / corr | sim |`);
    const pooled: Record<"men" | "women", Row[]> = { men: [], women: [] };
    for (const lg of leagues) {
      const rows = play(lg);
      const real = REAL.leagues[lg.id];
      const g = real?.gender ?? (lg.rules.gender === "women" ? "women" : "men");
      const win = windowRows(rows);
      if (!lg.hundred) pooled[g].push(...win);
      const d = distribution(rows, lg.hundred);
      const mt = matchTerm(win);
      const simCorr = mt.cross / Math.sqrt(Math.max(1e-9, (mt.run - 0) * Math.max(1e-9, mt.wicket)));
      const realD = real?.firstInnings;
      console.log(`| ${lg.id} | ${realD ? `${f(realD.mean)} (${f(realD.sd)}) / ${f(realD.p200)}% / ${f(realD.under120)}%` : "-"} | ${f(d.mean)} (${f(d.sd)}) / ${f(d.p200)}% / ${f(d.under120)}% | `
        + `${real ? `${f(real.r10.bat)} / ${f(real.r10.bowl)} / ${f(real.r10.ground)} / ${f(real.r10.residual)}` : "-"} | ${f(mt.dr.v.bat)} / ${f(mt.dr.v.bowl)} / ${f(mt.dr.v.ground)} / ${f(mt.dr.varE)} | `
        + `${real ? `${f(real.match.run)} / ${f(real.match.wicket, 3)} / ${f(real.match.corr, 2)}` : "-"} | ${f(mt.run)} / ${f(mt.wicket, 3)} / ${f(Number.isFinite(simCorr) ? simCorr : 0, 2)} |`);
    }
    const out: Record<"men" | "women", (ReturnType<typeof matchTerm> & { mean: number }) | null> = { men: null, women: null };
    for (const g of ["men", "women"] as const) {
      if (!pooled[g].length) continue;
      const firsts = pooled[g].filter(r => r.innings === 1);
      out[g] = { ...matchTerm(pooled[g]), mean: firsts.reduce((s, r) => s + r.runs, 0) / firsts.length };
      const r = REAL.pooled[g].match;
      console.log(`| pooled ${g} (T20) | | 1st inns mean ${f(out[g]!.mean, 2)} | | | ${f(r.run)} / ${f(r.wicket, 3)} / ${f(r.corr, 2)} | ${f(out[g]!.run)} / ${f(out[g]!.wicket, 3)} / cross ${f(out[g]!.cross, 2)} |`);
    }
    return out;
  };

  if (!process.env.CAL_FIT) {
    report(`spread ${JSON.stringify(MATCH_CONDITIONS)}`);
    if (process.env.CAL_LIVE) {
      const ipl = leagueList().find(l => l.id === "ipl")!;
      const d = distribution(play(ipl, true), false);
      console.log(`live IPL 1st inns ${f(d.mean)} (${f(d.sd)}) / ${f(d.p200)}% / ${f(d.under120)}%`);
    }
    return;
  }

  // Fit: the simulated match term c(s) = c0 + k s^2 in the match spread; measure at zero and at a trial, solve for the real
  // one; then the centre: the pooled mean first innings at the fitted spread with no centre and with a trial centre, solved
  // for the mean at zero spread. (The innings' own spread stays zero: fitted to the innings' own variance of the first ten
  // overs it widened totals far past the real ones; RULES-MATCH.md 12.8.)
  const g2 = { men: "male", women: "female" } as const;
  const trial = 0.12, trialCenter = 0.02;
  for (const g of ["men", "women"] as const) MATCH_CONDITIONS[g2[g]] = { match: 0, innings: 0, center: 0 };
  const zero = report("spread 0");
  for (const g of ["men", "women"] as const) MATCH_CONDITIONS[g2[g]] = { match: trial, innings: 0, center: 0 };
  const at = report(`trial ${trial}`);
  for (const g of ["men", "women"] as const) {
    const z = zero[g], t = at[g];
    if (!z || !t) continue;
    const km = (t.run - z.run) / trial ** 2;
    const sm = Math.sqrt(Math.max(0, (REAL.pooled[g].match.run - z.run) / km));
    MATCH_CONDITIONS[g2[g]] = { match: Number(sm.toFixed(4)), innings: 0, center: 0 };
    console.log(`${g}: match term zero ${f(z.run)} trial ${f(t.run)} real ${f(REAL.pooled[g].match.run)} -> spread ${sm.toFixed(4)}`);
  }
  const uncentred = report(`fitted, no centre ${JSON.stringify(MATCH_CONDITIONS)}`);
  for (const g of ["men", "women"] as const) MATCH_CONDITIONS[g2[g]].center = trialCenter;
  const centred = report(`trial centre ${trialCenter}`);
  for (const g of ["men", "women"] as const) {
    const z = zero[g], u = uncentred[g], c = centred[g];
    if (!z || !u || !c) continue;
    const slope = (c.mean - u.mean) / trialCenter;
    MATCH_CONDITIONS[g2[g]].center = Number(((z.mean - u.mean) / slope).toFixed(4));
    console.log(`${g}: mean at zero ${f(z.mean, 2)}, fitted ${f(u.mean, 2)}, centre ${trialCenter} ${f(c.mean, 2)} -> centre ${MATCH_CONDITIONS[g2[g]].center}`);
  }
  report(`fitted ${JSON.stringify(MATCH_CONDITIONS)}`);

  if (process.env.CALIBRATE_WRITE) {
    const m = MATCH_CONDITIONS.male, w = MATCH_CONDITIONS.female;
    writeFileSync(OUT, `/**
 * GENERATED by packages/app/src/__tests__/calibrate-spread.test.ts (CALIBRATE_SPREAD=1 CAL_FIT=1 CALIBRATE_WRITE=1) from
 * docs/data/t20_spread.json. Do not edit by hand.
 *
 * The spread of a T20 / Hundred match's own conditions per gender (match-conditions.ts): sd of the log run multiplier the
 * match draws (shared by both innings) and of the one each innings draws, and the log shift of the match multiplier that
 * keeps the mean total where it was without them. 0 = none.
 */
export const MATCH_CONDITIONS: Record<"male" | "female", { match: number; innings: number; center: number }> = {
  male: { match: ${m.match}, innings: ${m.innings}, center: ${m.center} },
  female: { match: ${w.match}, innings: ${w.innings}, center: ${w.center} },
};
`);
    console.log(`wrote ${OUT}`);
  }
}, 3_600_000);
