/**
 * Dry run of model-ratings.ts: re-rank the generator's pre-model ratings (data/scraped/espn-ratings*-base.json)
 * with the ratings model and write a before/after review to data/analysis/game-ratings-comparison.md.
 * Changes no game file; `generate-ratings-espn.ts --model` is what applies it.
 *
 * Usage: npx tsx src/pipeline/compare-model-ratings.ts
 */

import { readFileSync, writeFileSync } from "fs";
import { applyModelRatings, battingOvr, bowlingOvr, loadModel, type GameRatings } from "./model-ratings.js";

const DATA = new URL("../../data", import.meta.url).pathname;
const OUT = `${DATA}/analysis/game-ratings-comparison.md`;
const SPOT = {
  male: ["Jasprit Bumrah", "Rashid Khan", "Sunil Narine", "Usman Tariq", "Virat Kohli", "Jos Buttler", "Suryakumar Yadav", "Travis Head",
    "Abhishek Sharma", "Heinrich Klaasen", "Vaibhav Sooryavanshi", "Harry Brook", "Rajat Patidar", "Tilak Varma", "Andre Russell",
    "Kieron Pollard", "MS Dhoni", "Virandeep Singh", "Hardik Pandya", "Imran Tahir"],
  female: ["Smriti Mandhana", "Beth Mooney", "Nat Sciver-Brunt", "Sophie Ecclestone", "Marizanne Kapp", "Ellyse Perry", "Shafali Verma", "Amelia Kerr"],
};

interface Rated {
  id: string; name: string; country: string; role: string; teamId?: string;
  ratings: GameRatings;
}

function overall(r: GameRatings): number {
  const bat = battingOvr(r), bowl = bowlingOvr(r);
  const stronger = Math.max(bat, bowl), weaker = Math.min(bat, bowl);
  return Math.round(stronger + (100 - stronger) * Math.pow(weaker / 100, 4));
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}
function sd(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map(x => (x - m) ** 2)));
}

function section(gender: "male" | "female", file: string): string[] {
  const before: Rated[] = JSON.parse(readFileSync(file, "utf-8"));
  const after: Rated[] = JSON.parse(JSON.stringify(before));
  const report = applyModelRatings(after, loadModel(gender));
  const byId = new Map(before.map(p => [p.id, p]));
  const rows = after.map(a => {
    const b = byId.get(a.id)!;
    return { id: a.id, name: a.name, country: a.country, role: a.role, teamId: a.teamId, before: overall(b.ratings), after: overall(a.ratings),
      batB: battingOvr(b.ratings), batA: battingOvr(a.ratings), bowlB: bowlingOvr(b.ratings), bowlA: bowlingOvr(a.ratings) };
  });
  const rank = (key: "before" | "after") => new Map([...rows].sort((x, y) => y[key] - x[key]).map((r, i) => [r.id, i + 1]));
  const rankB = rank("before"), rankA = rank("after");

  const out: string[] = [];
  out.push(`## ${gender === "male" ? "Men" : "Women"}`, "");
  out.push(`${after.length} players; re-ranked batting ${report.batting}, bowling ${report.bowling}; not in the model (unchanged) ${report.unmatched}.`, "");

  out.push("**Attribute spread is preserved** (mean / SD before → after):", "");
  out.push("| attribute | before | after |", "|---|---|---|");
  for (const k of ["battingIQ", "timing", "power", "running", "wicketTaking", "economy", "accuracy", "clutch"] as (keyof GameRatings)[]) {
    const b = before.map(p => p.ratings[k]), a = after.map(p => p.ratings[k]);
    out.push(`| ${k} | ${mean(b).toFixed(1)} / ${sd(b).toFixed(1)} | ${mean(a).toFixed(1)} / ${sd(a).toFixed(1)} |`);
  }
  out.push("");

  out.push("**Top 25 overall, after** (before in brackets):", "");
  out.push("| # | player | country | role | overall | bat | bowl |", "|---|---|---|---|---|---|---|");
  for (const r of [...rows].sort((x, y) => y.after - x.after).slice(0, 25)) {
    out.push(`| ${rankA.get(r.id)} (${rankB.get(r.id)}) | ${r.name} | ${r.country} | ${r.role} | ${r.after} (${r.before}) | ${r.batA} (${r.batB}) | ${r.bowlA} (${r.bowlB}) |`);
  }
  out.push("");

  const spot = rows.filter(r => SPOT[gender].includes(r.name));
  if (spot.length) {
    out.push("**Spot checks**:", "");
    out.push("| player | overall | rank | bat | bowl |", "|---|---|---|---|---|");
    for (const r of spot.sort((x, y) => y.after - x.after)) {
      out.push(`| ${r.name} | ${r.before} → ${r.after} | ${rankB.get(r.id)} → ${rankA.get(r.id)} | ${r.batB} → ${r.batA} | ${r.bowlB} → ${r.bowlA} |`);
    }
    out.push("");
  }

  const movers = [...rows].filter(r => r.teamId).sort((x, y) => Math.abs(y.after - y.before) - Math.abs(x.after - x.before)).slice(0, 15);
  out.push("**Biggest moves among squad players**:", "");
  out.push("| player | team | overall |", "|---|---|---|");
  for (const r of movers) out.push(`| ${r.name} | ${r.teamId} | ${r.before} → ${r.after} |`);
  out.push("");

  const teams = [...new Set(rows.map(r => r.teamId).filter(Boolean))] as string[];
  if (teams.length) {
    const xi = (team: string, key: "before" | "after") =>
      mean(rows.filter(r => r.teamId === team).map(r => r[key]).sort((a, b) => b - a).slice(0, 11));
    out.push("**Squad strength (mean overall of the best 11)**:", "");
    out.push("| team | before | after |", "|---|---|---|");
    for (const t of teams.sort((a, b) => xi(b, "after") - xi(a, "after"))) out.push(`| ${t} | ${xi(t, "before").toFixed(1)} | ${xi(t, "after").toFixed(1)} |`);
    out.push("");
  }
  return out;
}

const lines = [
  "# Game ratings: current vs re-ranked by the ratings model",
  "",
  `Generated ${new Date().toISOString()} by src/pipeline/compare-model-ratings.ts (dry run; no game file changed).`,
  "Attribute values keep the game's current spread (the engine is calibrated to it); only who holds which value changes.",
  "",
  ...section("male", `${DATA}/scraped/espn-ratings-base.json`),
  ...section("female", `${DATA}/scraped/espn-ratings-women-base.json`),
];
writeFileSync(OUT, lines.join("\n"));
console.log(`Wrote ${OUT}`);
