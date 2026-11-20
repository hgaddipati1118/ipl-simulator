/**
 * Fits the two relations that keep ODI / Test ratings alive in career mode and writes them to
 * `packages/engine/src/format-career-data.ts`:
 *
 *  1. DERIVED sets (generated players: regens, youth, generated pools): per gender, format and attribute, the format
 *     attribute of the ESPN-pool players whose ODI / Test set is "derived" (no usable record in the format; the pipeline's
 *     translation shrunk to a below-average prior and capped, format-model.ts) regressed on the player's T20 attribute and
 *     his T20 batting and bowling overalls. A generated player has no record in any format, so he gets what the pipeline
 *     gives a real player in that position.
 *  2. PROGRESSION coupling: how much of a player's T20 rating change shows up in his ODI (List A) / Test (first-class)
 *     rating, per side. CricketArchive's per-year ratings (ca_ratings_by_year.parquet): for players rated in both formats
 *     in two seasons L apart (L = 3..5), the slope of the format's overall change on the T20 overall change, divided by
 *     the reliability of the T20 change (its measurement noise, from each rating's posterior sd) so the noise in a
 *     measured T20 change does not shrink the slope (errors-in-variables).
 *
 *     npx tsx packages/ratings/src/pipeline/fit-format-career.ts
 *
 * Needs the engine built and `data/analysis/ca_ratings_by_year.parquet`; `duckdb` on the PATH.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createPlayerFromData } from "@ipl-sim/engine";
import { getRealPlayers, getPoolPlayers } from "../real-players.js";
import { WPL_PLAYERS } from "../wpl-players.js";
import { attachFormatRatings, CORE_KEYS } from "../format-ratings.js";

const PARQUET = new URL("../../data/analysis/ca_ratings_by_year.parquet", import.meta.url).pathname;
const FILE = new URL("../../../app/public/data/format-ratings.json", import.meta.url).pathname;
const OUT = new URL("../../../engine/src/format-career-data.ts", import.meta.url).pathname;

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = i + 1; r < n; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  }
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
  return x;
}
function ols(X: number[][], y: number[], ridge = 1e-3): { c: number[]; sd: number } {
  const n = X[0].length;
  const A = Array.from({ length: n }, () => Array(n).fill(0)); const b = Array(n).fill(0);
  for (let r = 0; r < X.length; r++) for (let i = 0; i < n; i++) { b[i] += X[r][i] * y[r]; for (let j = 0; j < n; j++) A[i][j] += X[r][i] * X[r][j]; }
  for (let i = 1; i < n; i++) A[i][i] += ridge * X.length;
  const c = solve(A, b);
  let se = 0;
  for (let r = 0; r < X.length; r++) { let p = 0; for (let i = 0; i < n; i++) p += c[i] * X[r][i]; se += (y[r] - p) ** 2; }
  return { c, sd: Math.sqrt(se / X.length) };
}

// ---- 1. derived sets ------------------------------------------------------------------------------------------------
const file = JSON.parse(readFileSync(FILE, "utf8"));
type Gender = "male" | "female";
const flat: { g: Gender; r: any }[] = [...getRealPlayers(), ...getPoolPlayers()].map(r => ({ g: "male" as Gender, r }));
for (const p of WPL_PLAYERS) flat.push({ g: "female", r: { id: p.id, name: p.name, age: p.age, country: p.country, role: p.role, isWicketKeeper: p.isWicketKeeper, bowlingStyle: p.bowlingStyle, battingHand: p.battingHand, ...p.ratings } });
const players = flat.map(({ g, r }) => { const p = createPlayerFromData(r); attachFormatRatings([p], file); return { g, p }; });

const derive: Record<string, Record<string, Record<string, number[]>>> = {};
const report: string[] = [];
for (const g of ["male", "female"] as Gender[]) {
  derive[g] = {};
  for (const fmt of ["odi", "test"] as const) {
    derive[g][fmt] = {};
    const rs = players.filter(x => x.g === g && x.p.formatRatings?.[fmt]?.source === "derived");
    for (const k of CORE_KEYS) {
      const X = rs.map(({ p }) => [1, p.ratings[k], p.battingOvr, p.bowlingOvr]);
      const y = rs.map(({ p }) => p.formatRatings![fmt]!.ratings[k]);
      const f = ols(X, y);
      const ident = Math.sqrt(rs.reduce((a, { p }) => a + (p.formatRatings![fmt]!.ratings[k] - p.ratings[k]) ** 2, 0) / rs.length);
      derive[g][fmt][k] = f.c.map(c => Math.round(c * 1000) / 1000);
      report.push(`${g} ${fmt} ${k.padEnd(12)} n=${rs.length} rmse ${f.sd.toFixed(2)} (T20 value as-is: ${ident.toFixed(2)})  coef ${derive[g][fmt][k].join(" ")}`);
    }
  }
}

// ---- 2. progression coupling ----------------------------------------------------------------------------------------
function duck<T>(sql: string): T[] {
  return JSON.parse((execFileSync("duckdb", ["-json", "-c", sql], { encoding: "utf-8", maxBuffer: 1 << 30 }) || "[]").replace(/\bNaN\b/g, "null")) as T[];
}
interface Cell { gender: string; fx: string; side: string; lag: number; n: number; slope: number; var_dt: number; noise: number }
const cells: Cell[] = [];
for (const side of ["bat", "bowl"] as const) {
  const rows = duck<Cell>(`
    WITH r AS (SELECT * FROM '${PARQUET}'),
    scale AS (SELECT stddev(${side}_ovr) / stddev(${side}_rating) AS f FROM r WHERE format='T20' AND ${side}_balls >= 300),
    d AS (
      SELECT a.gender, a.format fx, (a.year - a0.year) AS lag,
             a.${side}_ovr - a0.${side}_ovr AS dx, t.${side}_ovr - t0.${side}_ovr AS dt,
             t.${side}_sd * t.${side}_sd + t0.${side}_sd * t0.${side}_sd AS nz
      FROM r a JOIN r a0 ON a.player_id = a0.player_id AND a.format = a0.format AND a.year - a0.year BETWEEN 3 AND 5
      JOIN r t ON t.player_id = a.player_id AND t.format = 'T20' AND t.year = a.year
      JOIN r t0 ON t0.player_id = a.player_id AND t0.format = 'T20' AND t0.year = a0.year
      WHERE a.format IN ('ListA', 'FC') AND a.${side}_balls >= 300 AND t.${side}_balls >= 300 AND a0.${side}_balls >= 100 AND t0.${side}_balls >= 100
        AND a.${side}_ovr IS NOT NULL AND a0.${side}_ovr IS NOT NULL AND t.${side}_ovr IS NOT NULL AND t0.${side}_ovr IS NOT NULL)
    SELECT gender, fx, '${side}' AS side, 0 AS lag, count(*) AS n, regr_slope(dx, dt) AS slope, var_samp(dt) AS var_dt,
           avg(nz) * (SELECT f * f FROM scale) AS noise
    FROM d GROUP BY 1, 2 HAVING count(*) >= 5`);
  cells.push(...rows);
}
// The posterior sds overstate the noise in a rating change (the implied reliability is 0.2-0.3, a change of three to five seasons
// being mostly real), so the correction is capped at a reliability of 0.5: the slope on the measured change (a lower bound) and
// the slope on the true change (what the game's T20 change is, an upper bound) bracket the coupling and this takes the stated point.
const RELIABILITY_FLOOR = 0.5;
const coupling: Record<string, Record<string, Record<string, number>>> = {};
for (const g of ["male", "female"]) coupling[g] = { odi: {}, test: {} };
for (const c of cells) {
  const g = c.gender === "female" ? "female" : "male";
  const fmt = c.fx === "ListA" ? "odi" : "test";
  const reliability = Math.max(RELIABILITY_FLOOR, 1 - c.noise / c.var_dt);
  const raw = c.slope;
  const corrected = Math.max(0, Math.min(1, raw / reliability));
  coupling[g][fmt][c.side] = c.n >= 200 ? Math.round(corrected * 100) / 100 : NaN;
  report.push(`coupling ${g} ${fmt} ${c.side}: n=${c.n} slope ${raw.toFixed(3)} reliability ${reliability.toFixed(2)} -> ${corrected.toFixed(2)}${c.n < 200 ? " (too thin, uses men's)" : ""}`);
}
for (const fmt of ["odi", "test"]) for (const side of ["bat", "bowl"]) {
  if (!Number.isFinite(coupling.female[fmt][side])) coupling.female[fmt][side] = coupling.male[fmt][side];
}

const body = `/**
 * AUTO-GENERATED by packages/ratings/src/pipeline/fit-format-career.ts. Do not edit by hand.
 *
 * DERIVE: per gender / format / core attribute, [intercept, own T20 attribute, T20 batting overall, T20 bowling overall]
 * fitted on the ESPN-pool players whose ODI / Test set is "derived".
 * COUPLING: share of a T20 rating change that carries over to the format's rating, per side (fitted on CricketArchive
 * per-year ratings, corrected for the noise in the T20 change).
 */
export const FORMAT_DERIVE_COEF = ${JSON.stringify(derive, null, 2)} as const;

export const FORMAT_COUPLING = ${JSON.stringify(coupling, null, 2)} as const;
`;
writeFileSync(OUT, body);
console.log(report.join("\n"));
console.log(`wrote ${OUT}`);
