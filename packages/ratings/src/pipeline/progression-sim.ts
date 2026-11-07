/**
 * Progression simulator and generated-player sampler (CLI).
 *
 *   npx tsx src/pipeline/progression-sim.ts --player "Shubman Gill" [--seasons 8] [--runs 500] [--seed 1] [--no-retire]
 *   npx tsx src/pipeline/progression-sim.ts --age 19 --bat 55 --bowl 30 --role batsman [--women]
 *   npx tsx src/pipeline/progression-sim.ts --generate 12 --kind youth [--country India] [--women] [--seed 7]
 *   npx tsx src/pipeline/progression-sim.ts --validate        (simulated vs real 2015 / 2018 cohorts)
 *
 * The projection is exactly what career mode does: Player.progress() with the model fitted on real careers, plus the
 * fitted retirement hazard. Bands are over the careers still playing at each age.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  Player, projectPlayer, generatePlayers, createRNG, validateCohort, formatValidation, createPlayerFromData,
  type PlayerData, type Cohort, type GenerationKind,
} from "@ipl-sim/engine";
import { ALL_PLAYERS } from "../all-players.js";
import { WPL_PLAYERS } from "../wpl-players.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (name: string, dflt: number) => (opt(name) !== undefined ? Number(opt(name)) : dflt);

const gender = flag("women") ? "female" : "male";
const seed = num("seed", 1);

function line(cols: (string | number)[], widths: number[]): string {
  return cols.map((c, i) => String(c).padStart(widths[i])).join("  ");
}

function printProjection(p: PlayerData) {
  const seasons = num("seasons", 8);
  const pts = projectPlayer(p, { seasons, runs: num("runs", 500), seed, gender, retirement: !flag("no-retire") });
  const player = new Player(p);
  console.log(`${p.name} (${p.country}, age ${p.age}, ${p.role}) now: overall ${player.overall}, batting ${player.battingOvr}, bowling ${player.bowlingOvr}`);
  const w = [6, 5, 8, 6, 6, 6, 7, 7];
  console.log(line(["ahead", "age", "playing", "ovr10", "ovr50", "ovr90", "bat50", "bowl50"], w));
  for (const pt of pts) {
    if (pt.active === 0) { console.log(line([pt.season, pt.age, "0%", "-", "-", "-", "-", "-"], w)); continue; }
    console.log(line([pt.season, pt.age, `${Math.round(pt.active * 100)}%`, Math.round(pt.overall.p10), Math.round(pt.overall.p50),
      Math.round(pt.overall.p90), Math.round(pt.batting.p50), Math.round(pt.bowling.p50)], w));
  }
}

function main() {
  if (flag("validate")) {
    const dir = join(import.meta.dirname, "..", "..", "..", "engine", "src", "__tests__", "fixtures", "progression-cohort.json");
    const cohorts = JSON.parse(readFileSync(dir, "utf8")) as Record<"male" | "female", Cohort>;
    for (const g of ["male", "female"] as const) console.log(formatValidation(validateCohort(cohorts[g], { runs: num("runs", 30), seed })) + "\n");
    return;
  }
  if (opt("generate")) {
    const rng = createRNG(seed);
    const kind = (opt("kind") ?? "pool") as GenerationKind;
    const ps = generatePlayers(num("generate", 10), rng, { kind, gender, country: opt("country") }, "gen");
    console.log("name".padEnd(24), "country".padEnd(13), "age role        style                  IQ  tim pow run  WT  eco acc clu | bat bowl ovr pot");
    for (const p of ps) {
      const r = p.ratings;
      console.log(p.name.padEnd(24), p.country.padEnd(13), String(p.age).padStart(3), (p.role + (p.isWicketKeeper ? "+wk" : "")).padEnd(11), p.bowlingStyle.padEnd(22),
        [r.battingIQ, r.timing, r.power, r.running, r.wicketTaking, r.economy, r.accuracy, r.clutch].map(v => String(v).padStart(3)).join(" "), "|",
        String(p.battingOvr).padStart(3), String(p.bowlingOvr).padStart(4), String(p.overall).padStart(3), p.potential ?? "-");
    }
    return;
  }
  const name = opt("player");
  if (name) {
    const hit = [...ALL_PLAYERS, ...WPL_PLAYERS].filter(p => p.name.toLowerCase().includes(name.toLowerCase()));
    if (hit.length === 0) { console.error(`No player matching "${name}"`); process.exit(1); }
    if (hit.length > 1) console.error(`${hit.length} matches, using the first: ${hit.slice(0, 5).map(h => h.name).join(", ")}`);
    const d = hit[0];
    const p = createPlayerFromData({ ...(d as object), ...d.ratings } as never);
    printProjection(p.toJSON());
    return;
  }
  if (opt("age")) {
    const bat = num("bat", 50), bowl = num("bowl", 30);
    const p = createPlayerFromData({
      name: "Custom", age: num("age", 22), country: opt("country") ?? "India", role: opt("role") ?? (bat >= bowl ? "batsman" : "bowler"),
      bowlingStyle: (opt("style") as never) ?? "right-arm-fast-medium", battingIQ: bat, timing: bat, power: bat, running: bat,
      wicketTaking: bowl, economy: bowl, accuracy: bowl, clutch: Math.max(bat, bowl),
    });
    printProjection(p.toJSON());
    return;
  }
  console.log("Usage: --player NAME | --age N --bat N --bowl N [--role R] | --generate N [--kind youth|regen|fill|pool] | --validate   (--women, --seed N, --runs N, --seasons N)");
}

main();
