/**
 * Out-of-sample check of Test ratings by country (docs/FORMAT-RATINGS-REPORT.md, "Test ratings by country").
 *
 *   npx tsx src/pipeline/test-country-check.ts      -> data/analysis/test-country-check.md
 *
 * Rate every first-class player with data up to Y (the shipped estimate: format-model.ts estimateFormat with the tuned DATA_VAR
 * and thin-record calibration), then compare it with what he did in Tests v full members in Y+1..Y+2 (opposition-adjusted value
 * per 100 balls, as format-validation.ts), by the country he played for, and with the share of his target balls played at home
 * and the ground's run / wicket factors controlled. Reads the CA outputs and cricket.db; nothing it prints feeds a rating.
 */
import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import {
  buildContext, doesSide, estimateFormat, fitTranslations, loadCaFormats, loadIntlEvidence, fitWls,
  type CaPlayerFormats, type Gender, type Side,
} from "./format-model.js";
import { fitThin, intlRecords, TARGET_BALLS, TUNING_YEARS, HOLDOUT_YEAR } from "./format-validation.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const DIR = `${ROOT}data/analysis/`;
const gender: Gender = "male";
const OUT = `${DIR}test-country-check.md`;
const out: string[] = [];
const p = (s = "") => { out.push(s); console.log(s); };

const CODE: Record<string, string> = {
  Australia: "AUS", England: "ENG", India: "IND", "South Africa": "RSA", "New Zealand": "NZ", Pakistan: "PAK", "Sri Lanka": "SL",
  "West Indies": "WI", Bangladesh: "BDESH", Zimbabwe: "ZIM", Ireland: "IRELAND", Afghanistan: "AFG",
};
const NAME = Object.fromEntries(Object.entries(CODE).map(([n, c]) => [c, n]));

function sqlite<T>(q: string): T[] {
  return JSON.parse(execFileSync("sqlite3", ["-json", `${ROOT}data/cricket.db`, q], { encoding: "utf-8", maxBuffer: 1 << 30 }) || "[]") as T[];
}

/** Per player, side: Test balls in [from, to] by team and whether at home, with the ground's host and venue */
interface TestBalls { team: string; home: boolean; balls: number; venue: string }
function testBalls(side: Side, from: number, to: number): Map<number, TestBalls[]> {
  const tab = side === "bat" ? "batting" : "bowling";
  const ballsExpr = side === "bat" ? "x.balls" : `(coalesce(cast(substr(x.overs, 1, instr(x.overs || '.', '.') - 1) as int), 0) * 6 + coalesce(cast(nullif(substr(x.overs, instr(x.overs || '.', '.') + 1), '') as int), 0))`;
  const rows = sqlite<{ player_id: number; team: string; country: string; venue: string; balls: number }>(`
    SELECT x.player_id, x.team, m.country, m.venue, sum(${ballsExpr}) AS balls
    FROM ${tab} x JOIN matches m ON m.id = x.match_id
    WHERE m.levels LIKE '%"Test"%' AND m.levels NOT LIKE '%Women%' AND cast(substr(m.date, 1, 4) as int) BETWEEN ${from} AND ${to}
    GROUP BY 1, 2, 3, 4`);
  const outM = new Map<number, TestBalls[]>();
  for (const r of rows) {
    if (!r.balls || r.balls <= 0) continue;
    const l = outM.get(Number(r.player_id)) ?? [];
    l.push({ team: r.team, home: CODE[r.team] === r.country, balls: r.balls, venue: r.venue });
    outM.set(Number(r.player_id), l);
  }
  return outM;
}

export interface Row {
  y: number; id: number; side: Side; est: number; tgt: number; w: number; team: string; homeShare: number; thin: boolean; dataBalls: number;
  venueRun: number; venueWkt: number; histHome: number; histVenueRun: number; histVenueWkt: number; histBalls: number; domShare: Record<string, number>; intlBalls: number;
}

const dataVarOf: Record<Side, number> = { bat: 0.5, bowl: 2 };
const validation = JSON.parse(readFileSync(`${DIR}format_ratings_validation.json`, "utf-8").replace(/\bNaN\b/g, "null"));
dataVarOf.bat = validation["male/FC/bat"].dataVar; dataVarOf.bowl = validation["male/FC/bowl"].dataVar;

// venue factors of Tests (run factor, wicket factor; 100 = average), by the raw venue string of cricket.db
const vf = new Map<string, { run: number; wkt: number }>();
{
  const rows = JSON.parse(execFileSync("duckdb", ["-json", "-c", `SELECT m.raw_venue AS venue, f.run_factor, f.wkt_factor FROM '${DIR}venue_map.csv' m JOIN '${DIR}venue_factors.csv' f USING (vid) WHERE m.source = 'ca' AND f.gender = 'male' AND f.format = 'FC' AND f.scope = 'Test' AND f.era = 'all'`], { encoding: "utf-8", maxBuffer: 1 << 28 })) as { venue: string; run_factor: number; wkt_factor: number }[];
  for (const r of rows) vf.set(r.venue, { run: r.run_factor, wkt: r.wkt_factor });
}

const caches = new Map<number, Map<number, CaPlayerFormats>>();
const load = (y: number) => { if (!caches.has(y)) caches.set(y, loadCaFormats(gender, y)); return caches.get(y)!; };

export function collect(): Row[] {
  const rows: Row[] = [];
  for (const side of ["bat", "bowl"] as Side[]) {
    const folds = [...TUNING_YEARS, HOLDOUT_YEAR].map(y => {
      const players = load(y);
      if (side === "bat" || true) loadIntlEvidence(players, gender, y);
      return { y, players, translations: fitTranslations(players.values(), gender) };
    });
    const thin = fitThin(gender, "FC", side, dataVarOf[side], folds.filter(f => f.y !== HOLDOUT_YEAR));
    for (const f of folds) {
      const ctx = buildContext(f.players, "FC", gender, f.y, dataVarOf[side], f.translations);
      if (thin.kappa > 0) ctx.thin = { [side]: thin };
      const tb = testBalls(side, f.y + 1, f.y + 2);
      const histB = testBalls(side, f.y - 5, f.y);
      for (const [id, t] of intlRecords(gender, "FC", f.y + 1, f.y + 2)[side]) {
        const pl = f.players.get(id);
        if (!pl || t.balls < TARGET_BALLS.FC || !doesSide(pl.FC?.[side])) continue;
        const e = estimateFormat(pl, "FC", side, ctx);
        const b = tb.get(id);
        if (!e || !b) continue;
        const total = b.reduce((s, x) => s + x.balls, 0);
        const byTeam = new Map<string, number>();
        for (const x of b) byTeam.set(x.team, (byTeam.get(x.team) ?? 0) + x.balls);
        const team = [...byTeam].sort((a, c) => c[1] - a[1])[0][0];
        const mine = b.filter(x => x.team === team);
        const mt = mine.reduce((s, x) => s + x.balls, 0);
        let vr = 0, vw = 0, vt = 0;
        for (const x of mine) { const v = vf.get(x.venue); if (v) { vr += x.balls * v.run; vw += x.balls * v.wkt; vt += x.balls; } }
        const hb = histB.get(id) ?? [];
        let hh = 0, hr = 0, hw = 0, ht = 0, hv = 0;
        for (const x of hb) { ht += x.balls; if (x.home) hh += x.balls; const v = vf.get(x.venue); if (v) { hr += x.balls * v.run; hw += x.balls * v.wkt; hv += x.balls; } }
        rows.push({
          histHome: ht ? hh / ht : NaN, histVenueRun: hv ? hr / hv : 100, histVenueWkt: hv ? hw / hv : 100, histBalls: ht,
          y: f.y, id, side, est: e.mean, tgt: t.adj, w: t.balls, team, homeShare: mine.filter(x => x.home).reduce((s, x) => s + x.balls, 0) / mt,
          thin: false, dataBalls: pl.FC![side]!.balls, venueRun: vt ? vr / vt : 100, venueWkt: vt ? vw / vt : 100, domShare: pl.FC![side]!.domShare ?? {}, intlBalls: pl.FC![side]!.intlBalls ?? 0,
        });
      }
    }
  }
  return rows;
}

/** Weighted mean of xs by ws */
const wm = (xs: number[], ws: number[]) => xs.reduce((s, x, i) => s + x * ws[i], 0) / ws.reduce((a, b) => a + b, 0);
function wcorr(xs: number[], ys: number[], ws: number[]): number {
  const mx = wm(xs, ws), my = wm(ys, ws);
  let cxy = 0, cxx = 0, cyy = 0;
  xs.forEach((x, i) => { cxy += ws[i] * (x - mx) * (ys[i] - my); cxx += ws[i] * (x - mx) ** 2; cyy += ws[i] * (ys[i] - my) ** 2; });
  return cxy / Math.sqrt(cxx * cyy);
}

/**
 * Terms that pass the player-level check (z >= TERM_MIN_Z on the tuning folds) and are not shipped, with the reason: the actual-XI
 * replays of the side's own Tests must not contradict them (docs/FORMAT-RATINGS-REPORT.md, "Test ratings by country").
 */
export const NOT_SHIPPED: Record<string, string> = {
  Bangladesh: "player-level only: replays of its 24 Tests are unchanged (paired +0.000 +- 0.038), and its win rate falls from 0.41 to 0.33 against a real 0.46",
};

/** Smallest number of rows of a team for it to get a term; shrinkage (rows of evidence worth as much as the prior of no effect); evidence needed (standard errors) */
export const MIN_TEAM_ROWS = 8;
export const TERM_MIN_Z = 2;
/**
 * National-side effect of a side's players: for each team, the mean of (later value - estimate) over the fit rows, minus the mean over all
 * teams, times n / (n + K); and kept only where the raw effect is at least `minZ` standard errors from zero (SE over the team's
 * player-folds), so a side's term is a measured one rather than the largest of a dozen noisy ones. Fitted on `rows` (the tuning folds,
 * for a clean check on the held-out fold).
 */
export function fitTeamEffects(rows: Row[], K: number, minZ = 0): Record<string, { effect: number; n: number; raw: number; se: number }> {
  if (rows.length === 0) return {};
  const m = wm(rows.map(r => r.tgt - r.est), rows.map(r => r.w));
  const out: Record<string, { effect: number; n: number; raw: number; se: number }> = {};
  for (const t of new Set(rows.map(r => r.team))) {
    const S = rows.filter(r => r.team === t);
    if (S.length < MIN_TEAM_ROWS) continue;
    const raw = wm(S.map(r => r.tgt - r.est), S.map(r => r.w)) - m;
    const sw = S.reduce((a, r) => a + r.w, 0);
    const se = Math.sqrt(S.reduce((a, r) => a + (r.w / sw) ** 2 * (r.tgt - r.est - m - raw) ** 2, 0));
    out[t] = { effect: Math.abs(raw) >= minZ * se ? raw * (S.length / (S.length + K)) : 0, n: S.length, raw, se };
  }
  return out;
}

/** Held-out correlation of the estimate (+ the term of the player's team fitted on the other folds) with the later value, per held-out fold */
function leaveOneFoldOut(rows: Row[], side: Side, K: number, minZ: number): { y: number; base: number; withTerm: number }[] {
  return [...TUNING_YEARS, HOLDOUT_YEAR].map(y => {
    const H = rows.filter(r => r.side === side && r.y === y);
    const eff = fitTeamEffects(rows.filter(r => r.side === side && r.y !== y), K, minZ);
    const ys = H.map(r => r.tgt), ws = H.map(r => r.w);
    return { y, base: wcorr(H.map(r => r.est), ys, ws), withTerm: wcorr(H.map(r => r.est + (eff[r.team]?.effect ?? 0)), ys, ws) };
  });
}

if (process.argv[1].endsWith("test-country-check.ts")) {
  const cache = process.env.ROWS_CACHE;
  const rows: Row[] = cache && existsSync(cache) ? JSON.parse(readFileSync(cache, "utf-8")) : collect();
  if (cache && !existsSync(cache)) writeFileSync(cache, JSON.stringify(rows));
  for (const side of ["bowl", "bat"] as Side[]) {
    const R = rows.filter(r => r.side === side);
    const mean = wm(R.map(r => r.tgt - r.est), R.map(r => r.w));
    p(`\n## ${side === "bat" ? "Batting" : "Bowling"}: ${R.length} player-folds, mean later - estimate ${mean.toFixed(1)}\n`);
    p("Later value minus estimate against the mean of all teams, by the side he played for: all four folds (SE over players), then each fold (players in brackets).\n");
    p("| team | n | all folds | SE | 2014 | 2017 | 2020 | 2023 | home share |\n|---|---|---|---|---|---|---|---|---|");
    const teams = [...new Set(R.map(r => r.team))].filter(t => R.filter(r => r.team === t).length >= MIN_TEAM_ROWS);
    for (const t of teams.sort()) {
      const S = R.filter(r => r.team === t);
      const m = wm(S.map(r => r.tgt - r.est - mean), S.map(r => r.w));
      const sw = S.reduce((a, r) => a + r.w, 0);
      const se = Math.sqrt(S.reduce((a, r) => a + (r.w / sw) ** 2 * (r.tgt - r.est - mean - m) ** 2, 0));
      const fold = [...TUNING_YEARS, HOLDOUT_YEAR].map(y => {
        const F = R.filter(r => r.y === y), mf = wm(F.map(r => r.tgt - r.est), F.map(r => r.w)), H = F.filter(r => r.team === t);
        return H.length >= 3 ? `${(wm(H.map(r => r.tgt - r.est), H.map(r => r.w)) - mf).toFixed(1)} (${H.length})` : "-";
      });
      p(`| ${t} | ${S.length} | ${m.toFixed(1)} | ${se.toFixed(1)} | ${fold.join(" | ")} | ${wm(S.map(r => r.homeShare), S.map(r => r.w)).toFixed(2)} |`);
    }
  }
  p("\n## Does a team term hold out? Correlation of (estimate + team term fitted on the other three folds) with the later value\n");
  p("| side | K (rows), terms kept at z of | 2014 | 2017 | 2020 | 2023 | mean gain |\n|---|---|---|---|---|---|---|");
  for (const side of ["bowl", "bat"] as Side[]) {
    const L = leaveOneFoldOut(rows, side, 0, 1e9);
    p(`| ${side === "bat" ? "batting" : "bowling"} | none (the estimate) | ${L.map(l => l.base.toFixed(3)).join(" | ")} | - |`);
    for (const [K, z] of [[0, 0], [8, 0], [8, 1], [8, 2], [16, 2], [0, 2]]) {
      const M = leaveOneFoldOut(rows, side, K, z);
      p(`| ${side === "bat" ? "batting" : "bowling"} | ${K}, z ${z} | ${M.map(l => `${l.withTerm.toFixed(3)} (${(l.withTerm - l.base >= 0 ? "+" : "") + (l.withTerm - l.base).toFixed(3)})`).join(" | ")} | ${(M.reduce((a, l) => a + l.withTerm - l.base, 0) / M.length).toFixed(3)} |`);
    }
  }
  // The shipped term: bowling, fitted on the tuning folds only (2014, 2017, 2020), so the 2023 fold and the 2025+ Tests stay held out
  const K = Number(process.env.TERM_K ?? 8);
  const tune = rows.filter(r => r.side === "bowl" && r.y !== HOLDOUT_YEAR);
  const eff = fitTeamEffects(tune, K, TERM_MIN_Z);
  p(`\n## Fitted bowling terms (tuning folds ${TUNING_YEARS.join(", ")}, K ${K}, kept at ${TERM_MIN_Z} standard errors; first-class rating units, runs per 100 balls)\n`);
  p("| team | rows | raw | SE | term |\n|---|---|---|---|---|");
  for (const [t, e] of Object.entries(eff).sort((a, b) => b[1].effect - a[1].effect)) p(`| ${t} | ${e.n} | ${e.raw.toFixed(1)} | ${e.se.toFixed(1)} | ${e.effect >= 0 ? "+" : ""}${e.effect.toFixed(1)}${NOT_SHIPPED[t] && e.effect !== 0 ? " (not shipped)" : ""} |`);
  writeFileSync(OUT, out.join("\n") + "\n");
  if (process.argv.includes("--write")) {
    const body = Object.entries(eff).filter(([t, e]) => e.effect !== 0 && !NOT_SHIPPED[t]).sort().map(([t, e]) => `  ${JSON.stringify(t)}: ${e.effect.toFixed(1)},`).join("\n");
    writeFileSync(`${new URL("./test-bowling-terms.ts", import.meta.url).pathname}`, `/**
 * GENERATED by test-country-check.ts --write (docs/FORMAT-RATINGS-REPORT.md, "Test ratings by country"). Do not edit by hand.
 *
 * National-side term on men's Test bowling, first-class rating units (runs per 100 balls): how far the later Test value of a country's
 * bowlers ran above (below) their estimate, against the mean of all sides. Fitted on the folds 2014 / 2017 / 2020 (later value in the
 * next two seasons), shrunk by n / (n + ${K}), kept for the sides whose effect is ${TERM_MIN_Z} standard errors from zero and whose own
 * replays do not contradict it (NOT_SHIPPED); the 2023 fold and the Tests since 2025 stay held out. Added where a player's score is read
 * off the link to the game's scale (generate-format-ratings.ts); the curve is made from the scores as they are, so no other player's
 * rating moves. TEST_BOWLING_TERMS=off in the environment switches it off.
 */
export const TEST_BOWLING_TERMS: Record<string, number> = {
${body}
};
`);
    console.log("wrote test-bowling-terms.ts");
  }
}
