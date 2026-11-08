/**
 * Report on the ODI / Test ratings (generate-format-ratings.ts): out-of-sample validation, distributions against T20,
 * top-25 tables, specialists, attribute-mix check, and the ICC rankings as a check only (never an input).
 *
 *   npx tsx src/pipeline/format-ratings-report.ts     (after generate-format-ratings.ts)
 *
 * Reads data/analysis/format_ratings.json + format_ratings_validation.json, Cricsheet ODIs / Tests for the attribute-mix
 * check, data/external-rankings-format/icc_odi_test_player_rankings.csv. Writes data/analysis/format-ratings-report.md
 * (the tables of docs/FORMAT-RATINGS-REPORT.md). Exits 1 if a sanity check fails.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import type { FormatValidation, IntlEvidenceCheck, Metric } from "./format-validation.js";
import { fitWls } from "./format-model.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const DIR = `${ROOT}data/analysis/`;
const ICC_FILE = `${ROOT}data/external-rankings-format/icc_odi_test_player_rankings.csv`;
const OUT = `${DIR}format-ratings-report.md`;

type Fmt = "odi" | "test";
type Side = "bat" | "bowl";
interface SideDiag { matches: number; t20Balls: number; mean: number | null; sd: number | null; w: number; from: string | null; balls: number; raw: number; overall: number; source: "data" | "derived"; capped: string | null; mix: string }
interface FmtDiag { bat: SideDiag; bowl: SideDiag; batOvr: number; bowlOvr: number; overall: number; source: "data" | "derived"; role: string; ratings: Record<string, number> }
interface PlayerDiag {
  id: string; name: string; country: string; age: number; group: "espn" | "league" | "extended"; tier: string | null; caId: number | null; role: string;
  t20: { batOvr: number; bowlOvr: number; overall: number; ratings: Record<string, number> }; odi: FmtDiag; test: FmtDiag;
}
type Quantiles = number[];
interface SideSummary {
  regulars: number; linkPlayers: number; t20Regulars: number;
  distribution: { format: Quantiles; t20: Quantiles; formatAttrs: Record<string, Quantiles>; t20Attrs: Record<string, Quantiles> };
}
interface GenderDiag { summary: Record<string, SideSummary> & { sources?: unknown }; players: PlayerDiag[] }

const diag = JSON.parse(readFileSync(`${DIR}format_ratings.json`, "utf-8")) as Record<"male" | "female", GenderDiag>;
const validation = JSON.parse(readFileSync(`${DIR}format_ratings_validation.json`, "utf-8").replace(/\bNaN\b/g, "null")) as Record<string, FormatValidation>;
const lines: string[] = [];
const failures: string[] = [];
const out = (s = "") => lines.push(s);
const f3 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "" : x.toFixed(3));
const f0 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "" : x.toFixed(0));
const table = (head: string[], rows: (string | number)[][]) => {
  out(`| ${head.join(" | ")} |`);
  out(`|${head.map(() => "---").join("|")}|`);
  for (const r of rows) out(`| ${r.join(" | ")} |`);
  out();
};
const FMT_NAME: Record<Fmt, string> = { odi: "ODI", test: "Test" };
const CA_NAME: Record<string, Fmt> = { ListA: "odi", FC: "test" };
const ovrOf = (p: PlayerDiag, f: Fmt | "t20", side: Side) => (f === "t20" ? (side === "bat" ? p.t20.batOvr : p.t20.bowlOvr) : (side === "bat" ? p[f].batOvr : p[f].bowlOvr));

// ── 1. validation ─────────────────────────────────────────────────────

out("## Out-of-sample validation");
out();
out("Rated with data up to 2023, target = ball-weighted adjusted value per 100 balls in internationals against full members in 2024-25 " +
  "(ODI 200+ balls, Test 500+). `corr` = ball-weighted correlation (what the game keeps: ratings are a percentile map of the score), " +
  "`mse` in (runs per 100 balls)^2 on the CA scale (T20-scale predictors are on another scale, compare their corr only). " +
  "`common` = the players every predictor covers. DATA_VAR was tuned on the pooled 2014 / 2017 / 2020 folds.");
out();
for (const key of Object.keys(validation)) {
  const v = validation[key];
  if (!("holdout" in v)) continue;
  const [gender, fmt, side] = key.split("/");
  if (!v.holdout?.length || !(v.holdout[0].all.n >= 20)) { out(`**${gender} ${FMT_NAME[CA_NAME[fmt]]} ${side === "bat" ? "batting" : "bowling"}**: too few players to validate (${v.holdout?.[0]?.all.n ?? 0}).`); out(); continue; }
  out(`**${gender} ${FMT_NAME[CA_NAME[fmt]]} ${side === "bat" ? "batting" : "bowling"}** (DATA_VAR ${v.dataVar}; tuning corr by DATA_VAR: ${v.tuning.map(t => `${t.dataVar >= 1e8 ? "own only" : t.dataVar} ${f3(t.corr)}`).join(", ")}; n ${v.tuning[0].n})`);
  out();
  const m = (x?: Metric) => (x ? [x.n, f3(x.corr), f0(x.mse)] : ["", "", ""]);
  table(["predictor", "players", "corr", "mse", "common players", "corr", "mse"], v.holdout.map(h => [h.predictor, ...m(h.all), ...m(h.common)]));
  if (v.pooled?.length) {
    out(`All four folds pooled (rated through 2014, 2017, 2020, 2023; ${v.pooled[0].all.n} player-folds): ` +
      v.pooled.map(h => `${h.predictor} ${f3(h.all.corr)}`).join("; ") + ".");
    out();
  }
  out(`Derived ratings, checked by hiding each player's ${FMT_NAME[CA_NAME[fmt]]} record (same players):`);
  out();
  table(["predictor", "players", "corr", "mse", "mean target - prediction"], v.masked.map(h => [h.predictor, h.all.n, f3(h.all.corr), f0(h.all.mse), h.all.bias.toFixed(1)]));
}

// ── 1b. international record vs domestic ──────────────────────────────

const intlChecks = Object.values(JSON.parse(readFileSync(`${DIR}format_ratings_validation.json`, "utf-8").replace(/\bNaN\b/g, "null")) as Record<string, unknown>)
  .filter((x): x is IntlEvidenceCheck => !!x && typeof x === "object" && "byK" in x);
if (intlChecks.length) {
  out("## International record against domestic cricket (checked, not applied)");
  out();
  out("Same folds and target. `+ intl residual`: the estimate plus his ODI / Test-only adjusted value minus his List A / first-class " +
    "rating, shrunk by balls / (balls + K), weight fitted on the tuning folds. `+ countries`: a term per domestic country on his share of " +
    "balls there (runs per 100 balls for a player whose balls were all there, against international-only players), fitted on the tuning folds. " +
    "Held-out correlation.");
  out();
  table(["", "players (tune / held out)", "shipped estimate", "+ intl residual, K 250 / 1000 / 4000 (fitted weight)", "+ countries", "+ both (K 1000)", "country terms"],
    intlChecks.map(c => [`men ${FMT_NAME[CA_NAME[c.format]]} ${c.side === "bat" ? "batting" : "bowling"}`, `${c.tuneN} / ${c.holdN}`, f3(c.base.hold),
      c.byK.map(k => `${f3(k.holdIntl)} (${k.beta.toFixed(2)})`).join(" / "), f3(c.holdCountries), f3(c.byK[1].holdBoth),
      Object.entries(c.countries).map(([k, v]) => `${k} ${v}`).join(", ")]));
}

// ── 2. distributions ──────────────────────────────────────────────────

out("## Distributions against T20 (ESPN pool)");
out();
out("Final discipline overall (after attributes and normalisation) among each format's regulars (rated from data, a regular's balls, rated " +
  "within 3 seasons), against the T20 overall among T20 regulars (240+ CA T20 balls in the discipline). The link is made on the players " +
  "who are regulars of both, so the format rows sit where those players' T20 ratings sit; T20 regulars include many players who never play the longer formats.");
out();
for (const gender of ["male", "female"] as const) {
  const g = diag[gender];
  const rows: (string | number)[][] = [];
  for (const side of ["bat", "bowl"] as const) {
    for (const f of ["odi", "test"] as const) {
      const s = g.summary[`${f}/${side}`];
      rows.push([`${FMT_NAME[f]} ${side === "bat" ? "batting" : "bowling"}`, s.regulars, s.linkPlayers, ...s.distribution.format]);
    }
    const s = g.summary[`odi/${side}`];
    rows.push([`T20 ${side === "bat" ? "batting" : "bowling"}`, s.t20Regulars, "", ...s.distribution.t20]);
  }
  out(`**${gender === "male" ? "Men" : "Women"}**`);
  out();
  table(["", "regulars", "linked", "p10", "p25", "p50", "p75", "p90", "max"], rows);
  const arows: (string | number)[][] = [];
  for (const side of ["bat", "bowl"] as const) {
    for (const k of Object.keys(g.summary[`odi/${side}`].distribution.formatAttrs)) {
      arows.push([k, ...(["odi", "test"] as const).map(f => g.summary[`${f}/${side}`].distribution.formatAttrs[k].slice(1, 4).join(" / ")), g.summary[`odi/${side}`].distribution.t20Attrs[k].slice(1, 4).join(" / ")]);
    }
  }
  out(`Attributes, p25 / p50 / p75 among the same regulars (${gender === "male" ? "men" : "women"}):`);
  out();
  table(["attribute", "ODI", "Test", "T20"], arows);
}

// ── 3. sanity tables ──────────────────────────────────────────────────

out("## Top 25 (ESPN pool)");
out();
out("`~` = derived (no usable record in the format), `*` = capped. T20 = the same player's T20 discipline overall.");
out();
for (const gender of ["male", "female"] as const) {
  const espn = diag[gender].players.filter(p => p.group === "espn");
  for (const f of ["odi", "test"] as const) {
    for (const side of ["bat", "bowl"] as const) {
      const top = [...espn].sort((a, b) => ovrOf(b, f, side) - ovrOf(a, f, side) || b[f][side].raw - a[f][side].raw).slice(0, 25);
      out(`**${gender === "male" ? "Men" : "Women"}, ${FMT_NAME[f]} ${side === "bat" ? "batting" : "bowling"}**: ` +
        top.map(p => `${p.name} (${p.country.replace(/ Women$/, "")}) ${ovrOf(p, f, side)}${p[f][side].source === "derived" ? "~" : ""}${p[f][side].capped ? "*" : ""} [T20 ${ovrOf(p, "t20", side)}]`).join(", "));
      out();
    }
  }
}

// ── 4. specialists ────────────────────────────────────────────────────

out("## Specialists");
out();
const NAMED = {
  male: ["Cheteshwar Pujara", "Nathan Lyon", "Joe Root", "Steven Smith", "Kane Williamson", "Marnus Labuschagne", "Usman Khawaja", "Ajinkya Rahane", "Dimuth Karunaratne", "Tom Latham", "Scott Boland", "Josh Hazlewood",
    "Andre Russell", "Sunil Narine", "Kieron Pollard", "Nicholas Pooran", "Tim David", "Rovman Powell", "Sherfane Rutherford", "Romario Shepherd", "Abhishek Sharma", "Rinku Singh", "Varun Chakravarthy", "Liam Livingstone"],
  female: ["Ellyse Perry", "Nat Sciver-Brunt", "Smriti Mandhana", "Beth Mooney", "Meg Lanning", "Heather Knight", "Sophie Ecclestone", "Deepti Sharma", "Chinelle Henry", "Deandra Dottin"],
};
for (const gender of ["male", "female"] as const) {
  const by = new Map<string, PlayerDiag>();
  for (const p of diag[gender].players.filter(x => x.group === "espn")) if (!by.has(p.name) || p.t20.overall > by.get(p.name)!.t20.overall) by.set(p.name, p);
  const rows = NAMED[gender].map(n => by.get(n)).filter((p): p is PlayerDiag => !!p).map(p => {
    const cell = (f: Fmt) => `${p[f].batOvr} / ${p[f].bowlOvr} (${p[f].overall}${p[f].source === "derived" ? ", derived" : ""})`;
    return [p.name, `${p.t20.batOvr} / ${p.t20.bowlOvr} (${p.t20.overall})`, cell("odi"), cell("test")];
  });
  table(["player", "T20 bat / bowl (overall)", "ODI", "Test"], rows);
}
// Systematic: Test specialists (top-order first-class batters with a thin T20 record) and white-ball-only players
for (const gender of ["male"] as const) {
  const espn = diag[gender].players.filter(p => p.group === "espn");
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
  const perMatch = (s: SideDiag) => (s.matches > 0 ? s.balls / s.matches : 0);
  const testBat = espn.filter(p => p.test.bat.source === "data" && p.test.bat.balls >= 4000 && perMatch(p.test.bat) >= 40 && p.test.bat.t20Balls < 1500);
  const testBowl = espn.filter(p => p.test.bowl.source === "data" && p.test.bowl.balls >= 6000 && p.test.bowl.t20Balls < 1200);
  const whiteOnly = espn.filter(p => p.test.bat.balls === 0 && p.test.bowl.balls === 0 && p.t20.overall >= 75);
  const t20Only = espn.filter(p => p.odi.bat.balls + p.odi.bowl.balls === 0 && p.test.bat.balls + p.test.bowl.balls === 0 && p.t20.overall >= 75);
  const rows = [
    ["Test batting specialists: 4000+ first-class balls at 40+ a match, under 1500 T20 balls", testBat.length,
      mean(testBat.map(p => p.t20.batOvr)).toFixed(1), mean(testBat.map(p => p.odi.batOvr)).toFixed(1), mean(testBat.map(p => p.test.batOvr)).toFixed(1), "batting"],
    ["Test bowling specialists: 6000+ first-class balls bowled, under 1200 T20 balls", testBowl.length,
      mean(testBowl.map(p => p.t20.bowlOvr)).toFixed(1), mean(testBowl.map(p => p.odi.bowlOvr)).toFixed(1), mean(testBowl.map(p => p.test.bowlOvr)).toFixed(1), "bowling"],
    [`White-ball only: T20 overall 75+, no first-class ball (${whiteOnly.filter(p => p.test.source === "derived").length} derived in Tests)`, whiteOnly.length,
      mean(whiteOnly.map(p => p.t20.overall)).toFixed(1), mean(whiteOnly.map(p => p.odi.overall)).toFixed(1), mean(whiteOnly.map(p => p.test.overall)).toFixed(1), "overall"],
    [`T20 only: T20 overall 75+, no List A or first-class ball (${t20Only.filter(p => p.odi.source === "derived").length} derived in ODIs)`, t20Only.length,
      mean(t20Only.map(p => p.t20.overall)).toFixed(1), mean(t20Only.map(p => p.odi.overall)).toFixed(1), mean(t20Only.map(p => p.test.overall)).toFixed(1), "overall"],
  ];
  // Batsmen's part-time bowling (the engines pick bowlers by bowling overall)
  const q = (xs: number[]) => [0.1, 0.25, 0.5, 0.75, 0.9, 1].map(f => [...xs].sort((a, b) => a - b)[Math.round(f * (xs.length - 1))]);
  const batsmen = espn.filter(p => p.role === "batsman");
  const est = batsmen.filter(p => p.t20.batOvr >= 75);
  out(`Bowling overall of specialist batsmen (T20 role batsman; ${batsmen.length} men, ${est.length} of them with a T20 batting overall of 75+), p10 / p25 / p50 / p75 / p90 / max. ` +
    "A side the player doesn't do in the format (under 6 balls a match over his career or his last three seasons of it) keeps his T20 level; " +
    "batsmen who do bowl part-time in the format sit at the batsman's secondary-discipline ceiling (about 44-46), as part-timers do in T20.");
  out();
  table(["", "T20", "ODI", "Test"], [
    ["all specialist batsmen", ...(["t20", "odi", "test"] as const).map(k => q(batsmen.map(p => ovrOf(p, k, "bowl"))).join(" / "))],
    ["T20 batting 75+", ...(["t20", "odi", "test"] as const).map(k => q(est.map(p => ovrOf(p, k, "bowl"))).join(" / "))],
  ]);
  for (const k of ["odi", "test"] as const) {
    if (q(batsmen.map(p => ovrOf(p, k, "bowl")))[2] > q(batsmen.map(p => ovrOf(p, "t20", "bowl")))[2] + 3) failures.push(`specialist batsmen bowl better in ${FMT_NAME[k]}s than in T20`);
  }
  for (const name of ["Cheteshwar Pujara", "Virat Kohli", "Shubman Gill", "Steven Smith"]) {
    const p = espn.find(x => x.name === name);
    if (p && Math.max(p.odi.bowlOvr, p.test.bowlOvr) > p.t20.bowlOvr + 2) failures.push(`${name}: part-time bowling lifted above T20`);
  }
  out("Men, by group (mean rating of the group in each format). The T20 ratings of first-class specialists with a thin T20 record were " +
    "themselves rated from their first-class cricket by the T20 pipeline (T20-unproven sides), so those groups' T20 and Test means coincide; " +
    "the players above show the movement for specialists with a real T20 record.");
  out();
  table(["group", "players", "T20", "ODI", "Test", "rating"], rows);
  if (whiteOnly.some(p => p.test.source !== "derived")) failures.push("white-ball-only player rated as data in Tests");
  if (mean(testBat.map(p => p.test.batOvr - p.t20.batOvr)) < -1) failures.push("Test batting specialists rate lower in Tests than in T20");
  for (const [name, f, side, min] of [["Cheteshwar Pujara", "test", "bat", 5], ["Joe Root", "test", "bat", 15], ["Marnus Labuschagne", "test", "bat", 10]] as const) {
    const p = espn.find(x => x.name === name);
    if (p && ovrOf(p, f, side) - ovrOf(p, "t20", side) < min) failures.push(`${name}: ${FMT_NAME[f]} ${side} not ${min}+ above T20`);
  }
  if (mean(whiteOnly.map(p => p.test.overall - p.t20.overall)) >= 0) failures.push("white-ball-only players do not rate lower in Tests than in T20");
}

// ── 5. attribute mix ──────────────────────────────────────────────────

function duck<T>(sql: string): T[] {
  return JSON.parse(execFileSync("duckdb", ["-json", "-c", sql], { encoding: "utf-8", cwd: ROOT, maxBuffer: 512 * 1024 * 1024 }) || "[]") as T[];
}
interface CsBat { ca: number; fmt: string; balls: number; runs: number; outs: number; bnd: number; four: number; six: number; dots: number }
const csBat = duck<CsBat>(`
  WITH m AS (SELECT match_id, match_type AS fmt FROM 'data/analysis/matches.parquet' WHERE match_type IN ('ODI', 'Test') AND gender = 'male'),
  d AS (SELECT d.*, m.fmt FROM 'data/analysis/deliveries.parquet' d JOIN m USING (match_id) WHERE coalesce(d.wides, 0) = 0 AND coalesce(d.super_over, 0) = 0),
  ppl AS (SELECT cricsheet_id, any_value(cricketarchive_id) AS ca FROM 'data/analysis/people.parquet' WHERE cricketarchive_id IS NOT NULL GROUP BY ALL)
  SELECT try_cast(ppl.ca AS BIGINT) AS ca, fmt, count(*) AS balls, sum(runs_batter) AS runs, sum((player_out_id = batter_id)::INT) AS outs,
         sum((runs_batter IN (4, 6) AND coalesce(non_boundary, 0) = 0)::INT) AS bnd, sum((runs_batter = 4 AND coalesce(non_boundary, 0) = 0)::INT) AS four,
         sum((runs_batter = 6)::INT) AS six, sum((runs_batter = 0)::INT) AS dots
  FROM d JOIN ppl ON ppl.cricsheet_id = d.batter_id GROUP BY ALL HAVING count(*) >= 1000`);
const corr = (xs: number[], ys: number[]) => {
  const n = xs.length, mx = xs.reduce((s, x) => s + x, 0) / n, my = ys.reduce((s, y) => s + y, 0) / n;
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < n; i++) { a += (xs[i] - mx) * (ys[i] - my); b += (xs[i] - mx) ** 2; c += (ys[i] - my) ** 2; }
  return a / Math.sqrt(b * c);
};
out("## Attribute mix");
out();
out("Men with 1,000+ Cricsheet balls in the format (career, so in-sample: a consistency check, not a validation): correlation of a batting attribute with " +
  "the stat it stands for in that format, for the format's own set and for the player's T20 set.");
out();
{
  const byCa = new Map(diag.male.players.filter(p => p.group === "espn" && p.caId).map(p => [p.caId!, p]));
  const rows: (string | number)[][] = [];
  const stat: Record<string, (r: CsBat) => number> = {
    "six %": r => r.six / r.balls, "four %": r => r.four / r.balls, "boundary %": r => r.bnd / r.balls, "balls per dismissal": r => r.balls / Math.max(1, r.outs),
    "average": r => r.runs / Math.max(1, r.outs), "strike rate": r => r.runs / r.balls, "dot %": r => -r.dots / r.balls,
  };
  const checks: [string, string][] = [["power", "six %"], ["timing", "four %"], ["timing", "boundary %"], ["battingIQ", "balls per dismissal"], ["battingIQ", "average"], ["running", "dot %"]];
  for (const f of ["ODI", "Test"] as const) {
    const k: Fmt = f === "ODI" ? "odi" : "test";
    const pairs = csBat.filter(r => r.fmt === f && byCa.has(Number(r.ca))).map(r => ({ r, p: byCa.get(Number(r.ca))! }));
    for (const [attr, s] of checks) {
      const ys = pairs.map(x => stat[s](x.r));
      rows.push([f, pairs.length, attr, s === "dot %" ? "fewer dot balls" : s, f3(corr(pairs.map(x => x.p[k].ratings[attr]), ys)), f3(corr(pairs.map(x => x.p.t20.ratings[attr]), ys))]);
    }
    const ovr = pairs.map(x => x.p[k].batOvr), t20 = pairs.map(x => x.p.t20.batOvr), avg = pairs.map(x => stat.average(x.r));
    rows.push([f, pairs.length, "batting overall", "average", f3(corr(ovr, avg)), f3(corr(t20, avg))]);
  }
  table(["format", "players", "attribute", "stat in the format", "format set", "T20 set"], rows);

  // Jointly, as the Test engine fits its scoring terms: each rate on the four batting attributes, standardised weights
  out("The same players, each rate regressed on the four batting attributes together (ball-weighted, z-scored attributes, " +
    "weights in SDs of the rate per SD of the attribute), as the Test engine fits its scoring terms. A format set's battingIQ carries " +
    "its level, so timing, power and running carry the style given the level: fours through timing, sixes through power, singles through running.");
  out();
  const keys = ["battingIQ", "timing", "power", "running"];
  const jrows: (string | number)[][] = [];
  for (const f of ["ODI", "Test"] as const) {
    const k: Fmt = f === "ODI" ? "odi" : "test";
    const pairs = csBat.filter(r => r.fmt === f && byCa.has(Number(r.ca))).map(r => ({ r, p: byCa.get(Number(r.ca))! }));
    for (const set of [k, "t20"] as const) {
      const X = pairs.map(x => keys.map(a => (set === "t20" ? x.p.t20.ratings : x.p[k].ratings)[a]));
      const mu = keys.map((_, j) => X.reduce((t, x) => t + x[j], 0) / X.length);
      const sd = keys.map((_, j) => Math.sqrt(X.reduce((t, x) => t + (x[j] - mu[j]) ** 2, 0) / X.length) || 1);
      const cells = (["four %", "six %"] as const).map(name => {
        const ys = pairs.map(x => stat[name](x.r));
        const my = ys.reduce((t, y) => t + y, 0) / ys.length, sy = Math.sqrt(ys.reduce((t, y) => t + (y - my) ** 2, 0) / ys.length) || 1;
        const fit = fitWls(X.map((x, i) => ({ xs: x.map((v, j) => (v - mu[j]) / sd[j]), y: (ys[i] - my) / sy, w: pairs[i].r.balls })));
        return fit ? keys.map((_, j) => fit.coef[j + 1]).concat(1 - fit.residVar) : [NaN, NaN, NaN, NaN, NaN];
      });
      jrows.push([f, set === "t20" ? "T20 set" : `${f} set`, pairs.length,
        cells[0].slice(0, 4).map(v => v.toFixed(2)).join(" / ") + ` (R2 ${cells[0][4].toFixed(2)})`,
        cells[1].slice(0, 4).map(v => v.toFixed(2)).join(" / ") + ` (R2 ${cells[1][4].toFixed(2)})`]);
      if (set !== "t20" && !(cells[0][1] >= 0.3)) failures.push(`${f} timing does not carry the four rate (${cells[0][1].toFixed(2)} per SD)`);
      if (set !== "t20" && !(cells[1][2] >= 0.3)) failures.push(`${f} power does not carry the six rate (${cells[1][2].toFixed(2)} per SD)`);
    }
  }
  table(["format", "ratings", "players", "four %: battingIQ / timing / power / running", "six %: battingIQ / timing / power / running"], jrows);
}

// ── 6. ICC rankings (check only) ──────────────────────────────────────

out("## ICC rankings (validation only)");
out();
if (existsSync(ICC_FILE)) {
  const norm = (s: string) => s.normalize("NFKD").replace(/[^\p{L} ]/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
  const rows = readFileSync(ICC_FILE, "utf-8").trim().split("\n").slice(1).map(l => l.split(","));
  const res: (string | number)[][] = [];
  for (const gender of ["male", "female"] as const) {
    const espn = diag[gender].players.filter(p => p.group === "espn");
    const byName = new Map<string, PlayerDiag[]>();
    for (const p of espn) { const k = norm(p.name); byName.set(k, [...(byName.get(k) ?? []), p]); }
    for (const f of ["odi", "test"] as const) {
      for (const cat of ["batting", "bowling"] as const) {
        const icc = rows.filter(r => r[0] === gender && r[1] === f && r[2] === cat);
        if (!icc.length) continue;
        const side: Side = cat === "batting" ? "bat" : "bowl";
        const matched = icc.flatMap(r => {
          const cands = (byName.get(norm(r[5])) ?? []).filter(p => norm(p.country.replace(/ Women$/, "")) === norm(r[7]) || (byName.get(norm(r[5]))?.length ?? 0) === 1);
          return cands.length === 1 ? [{ points: Number(r[8]), p: cands[0] }] : [];
        });
        const rank = (xs: number[]) => { const s = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]); const r = new Array(xs.length); s.forEach(([, i], j) => { r[i] = j; }); return r as number[]; };
        const pts = matched.map(m => m.points);
        const ours = matched.map(m => ovrOf(m.p, f, side) + m.p[f][side].raw / 1000);
        const t20 = matched.map(m => ovrOf(m.p, "t20", side) + m.p[f][side].raw / 1e6);
        const top25ours = new Set([...espn].sort((a, b) => ovrOf(b, f, side) - ovrOf(a, f, side) || b[f][side].raw - a[f][side].raw).slice(0, 25).map(p => p.id));
        const top25icc = matched.filter((_, i) => i < 25).map(m => m.p.id);
        res.push([`${gender} ${FMT_NAME[f]} ${cat}`, icc.length, matched.length, f3(corr(rank(pts), rank(ours))), f3(corr(rank(pts), rank(t20))),
          `${top25icc.filter(id => top25ours.has(id)).length} / ${top25icc.length}`]);
      }
    }
  }
  out("Latest ICC top 100 (2026-11-02/03) matched to the ESPN pool by name (and team where names repeat). Spearman correlation of ICC points with our format overall and with the same players' T20 overall; " +
    "`top 25 overlap` = ICC top 25 players (matched) who are also in our top 25 for the format. Rankings weigh recent international form only and cover the top 100 only, so a modest correlation is expected.");
  out();
  table(["ranking", "ICC players", "matched", "Spearman (format rating)", "Spearman (T20 rating)", "top 25 overlap"], res);
}

// ── 7. sources ────────────────────────────────────────────────────────

out("## Sources");
out();
for (const gender of ["male", "female"] as const) out(`${gender}: ${JSON.stringify(diag[gender].summary.sources)}`);
out();

writeFileSync(OUT, lines.join("\n"));
console.log(`${OUT}: ${lines.length} lines`);
if (failures.length) { console.error("FAILED:", failures.join("; ")); process.exit(1); }
