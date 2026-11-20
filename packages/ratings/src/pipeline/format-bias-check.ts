/**
 * Where the ODI / Test level over-rates, checked against what players did later (docs/FORMAT-RATINGS-REPORT.md, "Bias round"):
 *
 *   npx tsx src/pipeline/format-bias-check.ts      -> data/analysis/format-bias-check.md
 *
 *  A. T20 hitters. The batting translation from T20 over-states a hitter's long-format rating: the residual of his List A / first-class
 *     rating against the T20 line, by hitterness (T20 strike-rate z minus survival z), the hinge fitted on every fold, and held-out
 *     correlation with no term, the shipped hinge and a linear term.
 *  B. Thin records. A high estimate resting on few balls in the format falls short of it in all later cricket of the format (selected
 *     for internationals or not), against the same estimate on a thick record.
 *  C. Teams. Test value in the next two seasons minus the estimate, by team, and the slope of later value on the estimate (1 = calibrated).
 *  D. Conditions. Ground factors by host country (data/analysis/venue_factors.csv): whether a team's records are inflated by home grounds.
 *
 * Reads the CA outputs only; nothing it prints feeds a rating.
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import {
  OPTS, buildContext, doesSide, estimateFormat, fitTranslations, loadCaFormats, loadIntlEvidence, thinBalls,
  type CaFormat, type CaPlayerFormats, type Gender, type Side,
} from "./format-model.js";
import { allRecords, intlRecords, TARGET_BALLS, validate, weightedMetrics } from "./format-validation.js";

const DIR = new URL("../../data/analysis/", import.meta.url).pathname;
const OUT = `${DIR}format-bias-check.md`;
const gender: Gender = "male";
const FOLDS = [2014, 2017, 2020, 2023];
const out: string[] = [];
const p = (s = "") => { out.push(s); console.log(s); };
const caches = new Map<number, Map<number, CaPlayerFormats>>();
const load = (y: number) => { if (!caches.has(y)) caches.set(y, loadCaFormats(gender, y)); return caches.get(y)!; };
const saved = { ...OPTS };
const LONG = [["ListA", "ODI"], ["FC", "Test"]] as const;

// ── A. hitters ────────────────────────────────────────────────────────
p("## A. T20 hitters\n");
for (const [to, label] of LONG) {
  const players = load(2026);
  OPTS.hitterH0 = undefined; OPTS.hitterH0FC = undefined;
  const t = fitTranslations(players.values(), gender)[`bat/T20>${to}`]!;
  const minTo = to === "ListA" ? 600 : 1200;
  const rows: { x: number; res: number; h: number }[] = [];
  for (const q of players.values()) {
    const x = q.T20?.bat, y = q[to]?.bat, st = q.style?.bat;
    if (!st || !doesSide(x, 500) || !doesSide(y, minTo) || Math.abs(x.year - y.year) > 2) continue;
    rows.push({ x: x.rating, res: y.rating - (t.a + t.b * x.rating), h: st[0] - st[1] });
  }
  rows.sort((a, b) => a.h - b.h);
  p(`**${label}**: ${rows.length} players with a real T20 and ${to} record; residual = ${to} rating minus the T20 line (${t.a.toFixed(1)} + ${t.b.toFixed(2)} x T20 rating), by hitterness (T20 strike-rate z minus survival z), eight equal groups\n`);
  p("| hitterness | players | mean residual (runs / 100 balls) |\n|---|---|---|");
  for (let i = 0; i < 8; i++) {
    const sl = rows.slice(Math.floor((i * rows.length) / 8), Math.floor(((i + 1) * rows.length) / 8));
    p(`| ${sl[0].h.toFixed(2)} to ${sl[sl.length - 1].h.toFixed(2)} | ${sl.length} | ${(sl.reduce((s, r) => s + r.res, 0) / sl.length).toFixed(1)} |`);
  }
  p();
}
p("Hinge coefficient (runs / 100 balls per unit of hitterness above the threshold, fitted on that fold's pairs), by fold:\n");
p("| fold | " + LONG.map(([, l]) => `${l} (threshold ${OPTS.hitterH0 ?? saved.hitterH0})`).join(" | ") + " |\n|---|---|---|");
for (const Y of [...FOLDS, 2026]) {
  const cells = LONG.map(([to]) => {
    Object.assign(OPTS, saved);
    const h = fitTranslations(load(Y).values(), gender)[`bat/T20>${to}`]?.hit;
    return h ? h.c.toFixed(2) : "-";
  });
  p(`| ${Y} | ${cells.join(" | ")} |`);
}
p("\nHeld-out correlation (rated with data to 2023, predicting 2024-25 international value; pooled = the four folds), men's batting, by what the T20 -> long-format translation carries:\n");
p("| translation | ODI held out | ODI pooled | ODI derived (record hidden) | Test held out | Test pooled | Test derived |\n|---|---|---|---|---|---|---|");
for (const [name, h] of [["T20 rating only", null], ["+ hinge on hitterness (shipped threshold)", saved.hitterH0 ?? 1.5], ["+ linear hitterness", -5]] as const) {
  OPTS.hitterH0 = h ?? undefined; OPTS.hitterH0FC = h ?? undefined;
  const cells = LONG.flatMap(([to]) => { const v = validate(gender, to, "bat", caches); return [v.holdout[0].all.corr, v.pooled[0].all.corr, v.masked[0].all.corr]; });
  p(`| ${name} | ${cells.map(c => c.toFixed(3)).join(" | ")} |`);
}
Object.assign(OPTS, saved);
p();

// ── B. thin records ───────────────────────────────────────────────────
p("## B. Thin records\n");
p("Later value (all competitions of the format, next two seasons, 300+ balls) minus the estimate, by the estimate's band among all rated players and by how much of a regular's record (the caps' small-sample threshold) the player has; four folds pooled, men's batting.\n");
p("| format | estimate band | thin record: players, later minus estimate | thick record: players, later minus estimate |\n|---|---|---|---|");
for (const [f] of LONG) {
  const rows: { est: number; tgt: number; w: number; thin: boolean }[] = [];
  for (const Y of FOLDS) {
    const players = load(Y);
    const ctx = buildContext(players, f, gender, Y, f === "ListA" ? 1 : 0.5, fitTranslations(players.values(), gender));
    const thr = thinBalls(ctx.params[`bat/${f}`].K);
    for (const [id, t] of allRecords(gender, f, "bat", Y + 1, Y + 2)) {
      const q = players.get(id);
      if (!q || t.balls < 300) continue;
      const e = estimateFormat(q, f, "bat", ctx);
      if (e) rows.push({ est: e.mean, tgt: t.adj, w: t.balls, thin: (q[f]?.bat?.balls ?? 0) < thr });
    }
  }
  const sorted = rows.map(r => r.est).sort((a, b) => a - b);
  const qt = (x: number) => sorted[Math.floor(x * (sorted.length - 1))];
  for (const [lo, hi] of [[0, 0.5], [0.5, 0.8], [0.8, 0.9], [0.9, 1.01]]) {
    const cell = (thin: boolean) => {
      const s = rows.filter(r => r.thin === thin && r.est >= qt(lo) && (hi > 1 || r.est < qt(hi)));
      const sw = s.reduce((a, r) => a + r.w, 0);
      return s.length ? `${s.length}, ${(s.reduce((a, r) => a + r.w * (r.tgt - r.est), 0) / sw).toFixed(1)}` : "-";
    };
    p(`| ${f === "ListA" ? "ODI" : "Test"} | ${Math.round(lo * 100)}-${Math.min(100, Math.round(hi * 100))}% | ${cell(true)} | ${cell(false)} |`);
  }
}
p("\nThe calibration shipped (`EstimateContext.thin`), fitted on the tuning folds by `validate`:\n");
p("| cell | kappa | median estimate m0 | rows |\n|---|---|---|---|");
for (const [f, l] of LONG) for (const side of ["bat", "bowl"] as const) {
  const v = validate(gender, f, side, caches);
  p(`| ${l} ${side === "bat" ? "batting" : "bowling"} | ${v.thin.kappa.toFixed(2)}${side === "bowl" ? " (not applied: unstable)" : ""} | ${v.thin.m0.toFixed(1)} | ${v.thin.n} |`);
}
p();

// ── C. teams ──────────────────────────────────────────────────────────
p("## C. Teams: later Test value against the estimate\n");
const country = new Map<number, string>();
for (const q of (JSON.parse(readFileSync(`${DIR}format_ratings.json`, "utf-8")).male.players as { group: string; caId: number | null; country: string }[])) if (q.group === "espn" && q.caId) country.set(q.caId, q.country);
for (const side of ["bat", "bowl"] as const) {
  const acc = new Map<string, { n: number; w: number; r: number }>();
  const xs: number[] = [], ys: number[] = [], ws: number[] = [];
  for (const Y of [2017, 2020, 2023]) {
    const players = load(Y); loadIntlEvidence(players, gender, Y);
    const ctx = buildContext(players, "FC", gender, Y, side === "bat" ? 0.5 : 2, fitTranslations(players.values(), gender));
    for (const [id, t] of intlRecords(gender, "FC", Y + 1, Y + 2)[side]) {
      const q = players.get(id);
      if (!q || t.balls < TARGET_BALLS.FC || !doesSide(q.FC?.[side])) continue;
      const e = estimateFormat(q, "FC", side, ctx);
      if (!e) continue;
      xs.push(e.mean); ys.push(t.adj); ws.push(t.balls);
      const c = country.get(id);
      if (c) { const a = acc.get(c) ?? { n: 0, w: 0, r: 0 }; acc.set(c, a); a.n++; a.w += t.balls; a.r += t.balls * (t.adj - e.mean); }
    }
  }
  const m = weightedMetrics(xs, ys, ws);
  const sw = ws.reduce((a, b) => a + b, 0), mx = xs.reduce((a, x, i) => a + x * ws[i], 0) / sw, my = ys.reduce((a, y, i) => a + y * ws[i], 0) / sw;
  const slope = xs.reduce((a, x, i) => a + ws[i] * (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x, i) => a + ws[i] * (x - mx) ** 2, 0);
  p(`**${side === "bat" ? "Batting" : "Bowling"}**: ${xs.length} player-folds, later value on estimate: slope ${slope.toFixed(2)} (1 = calibrated), correlation ${m.corr.toFixed(3)}, mean later minus estimate ${m.bias.toFixed(1)} (target scale is offset; read the teams against this mean).\n`);
  p("| team | players | later minus estimate | against the mean |\n|---|---|---|---|");
  for (const [c, a] of [...acc].filter(([, a]) => a.n >= 8).sort((a, b) => b[1].n - a[1].n)) p(`| ${c} | ${a.n} | ${(a.r / a.w).toFixed(1)} | ${(a.r / a.w - m.bias).toFixed(1)} |`);
  p();
}

// ── D. conditions ─────────────────────────────────────────────────────
p("## D. Ground factors by host country (100 = average ground; ball-weighted)\n");
const rowsD = JSON.parse(execFileSync("duckdb", ["-json", "-c", `
  SELECT country, format, scope, sum(matches)::INT AS matches, round(sum(balls * run_factor) / sum(balls), 1) AS run_f, round(sum(balls * wkt_factor) / sum(balls), 1) AS wkt_f
  FROM '${DIR}venue_factors.csv' WHERE gender = 'male' AND era = 'all' AND format = 'FC' AND country IN ('IND', 'AUS', 'ENG', 'RSA', 'NZ', 'PAK', 'SL', 'WI', 'BDESH')
  GROUP BY ALL HAVING sum(matches) > 40 ORDER BY scope, matches DESC`], { encoding: "utf-8" })) as { country: string; scope: string; matches: number; run_f: number; wkt_f: number }[];
p("| host | Tests: matches | run factor | wicket factor | all first-class: matches | run factor | wicket factor |\n|---|---|---|---|---|---|---|");
for (const c of [...new Set(rowsD.map(r => r.country))]) {
  const t = rowsD.find(r => r.country === c && r.scope === "Test"), a = rowsD.find(r => r.country === c && r.scope === "all");
  p(`| ${c} | ${t?.matches ?? "-"} | ${t?.run_f ?? "-"} | ${t?.wkt_f ?? "-"} | ${a?.matches ?? "-"} | ${a?.run_f ?? "-"} | ${a?.wkt_f ?? "-"} |`);
}
writeFileSync(OUT, out.join("\n") + "\n");
console.log(`\nwritten ${OUT}`);
