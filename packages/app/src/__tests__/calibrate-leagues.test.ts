import { readFileSync } from "node:fs";
import { it } from "vitest";
import { ATTACK_MODEL, IMPACT_MODEL, EXTRA_LEAGUES, INNINGS_CLOCK, INNINGS_CLOCK_SWITCH, IN_MATCH_INJURY_SWITCH, LEAGUE_LEVELS, LEAGUE_XI_SWITCH, LAST_PAIR_SWITCH, RULE_PRESETS, type RuleSet } from "@ipl-sim/engine";
import { createGameState, initSeason, playNextMatch, isSeasonComplete } from "../game-state";
import { applyStateWicketsEnv } from "./state-wickets-env";
// SW_OFF / SW_FIRST_OFF / SW_CHASE_OFF / SW_FILE: the state-wickets term switched or replaced (docs/TACTICS.md section 11)
applyStateWicketsEnv();

/**
 * League scoring calibration (skipped unless CALIBRATE_LEAGUES=1): simulated innings scoring per league against the real
 * 2024-26 averages from the Cricsheet data (runs, wickets and balls per innings). The engine's LEAGUE_LEVELS (venues.ts) were
 * fitted with this. Usage:
 *   CALIBRATE_LEAGUES=1 CAL_SEASONS=16 npx vitest run packages/app/src/__tests__/calibrate-leagues.test.ts --reporter=verbose
 * (CAL_ONLY=bbl,psl limits the leagues). Real averages, from data/analysis/{deliveries,matches}.parquet:
 *   select event, sum(runs_total)/count(distinct match_id||innings), sum(is_wicket)/count(distinct match_id||innings), ...
 *   where date >= '2024-01-01' and super_over = 0.
 */
const TARGET: Record<string, { runs: number; wkts: number; balls: number }> = {
  ipl: { runs: 183.7, wkts: 6.05, balls: 113.7 }, wpl: { runs: 157.8, wkts: 6.2, balls: 114.6 },
  bbl: { runs: 158.3, wkts: 6.47, balls: 111.9 }, psl: { runs: 169.2, wkts: 6.47, balls: 112.9 }, sa20: { runs: 153.4, wkts: 6.21, balls: 110.2 },
  "hundred-m": { runs: 137.3, wkts: 5.88, balls: 92.8 }, "hundred-w": { runs: 120.5, wkts: 5.97, balls: 94.8 },
  cpl: { runs: 158.0, wkts: 6.27, balls: 111.8 }, ilt20: { runs: 154.9, wkts: 6.18, balls: 113.2 }, mlc: { runs: 164.9, wkts: 6.38, balls: 111.6 },
  bpl: { runs: 152.4, wkts: 6.4, balls: 113.6 }, lpl: { runs: 175.7, wkts: 6.64, balls: 114.5 }, wbbl: { runs: 141.0, wkts: 6.37, balls: 108.7 },
};
const SEASONS = Number(process.env.CAL_SEASONS ?? 6);
// CAL_LP_OFF=1: without the last-pair term (docs/TACTICS.md section 5): the engine as it was
if (process.env.CAL_LP_OFF) LAST_PAIR_SWITCH.off.t20 = true;
// LP_WICKET=t20:-0.1: a log offset added to the last-pair wicket class (the all-out calibration of docs/TACTICS.md sections 5 and 6)
for (const kv of (process.env.LP_WICKET ?? "").split(",").filter(Boolean)) { const [f, v] = kv.split(":"); LAST_PAIR_SWITCH.wicket[f as "t20" | "odi" | "test"] = Number(v); }
// WT_OFF=1: without the innings clock (docs/TACTICS.md section 6); WT_FILE=table.json: its tables from a t20-wicket-timing.py fit
// LXI_OFF=1: every side with the former best-XI selection, not the fitted league selection (docs/TACTICS.md section 7)
if (process.env.LXI_OFF) LEAGUE_XI_SWITCH.off = true;
// LEVELS_FILE=levels.json: LEAGUE_LEVELS entries replaced ({ "bbl": { "run": 1, "wicket": 0.9, "dot": 1.1 }, ... }), to refit them without a rebuild
if (process.env.LEVELS_FILE) Object.assign(LEAGUE_LEVELS, JSON.parse(readFileSync(process.env.LEVELS_FILE, "utf-8")));
if (process.env.WT_OFF) INNINGS_CLOCK_SWITCH.off = true;
// ATTACK_OFF=1: the bowling attack as before the attack table (docs/TACTICS.md section 8): the section-1 model over Team.autoBowlingOrder
if (process.env.ATTACK_OFF) ATTACK_MODEL.league = false;
// IMPACT_OFF=1: the former impact player (docs/TACTICS.md section 9); ATTACK_EXCEPT=ipl: leagues kept on the former attack
if (process.env.IMPACT_OFF) IMPACT_MODEL.off = true;
// IMI_OFF=1: no concussion substitutes, in-match injuries cost nothing after the match (in-match-injury.ts; the engine before them)
if (process.env.IMI_OFF) IN_MATCH_INJURY_SWITCH.off = true;
if (process.env.ATTACK_EXCEPT) ATTACK_MODEL.except = process.env.ATTACK_EXCEPT.split(",");
if (process.env.WT_FILE) { const t = JSON.parse(readFileSync(process.env.WT_FILE, "utf-8")).tables; for (const k of Object.keys(INNINGS_CLOCK)) delete INNINGS_CLOCK[k]; Object.assign(INNINGS_CLOCK, t); }
it.skipIf(!process.env.CALIBRATE_LEAGUES)("calibrate", () => {
  const leagues = process.env.CAL_ONLY ? EXTRA_LEAGUES.filter(l => process.env.CAL_ONLY!.split(",").includes(l.id)) : EXTRA_LEAGUES;
  const list: Array<{ id: string; rules: RuleSet }> = [{ id: "ipl", rules: RULE_PRESETS.modern2026 }, { id: "wpl", rules: RULE_PRESETS.wpl }, ...leagues];
  for (const { id, rules } of list) {
    let runs = 0, wkts = 0, balls = 0, inns = 0, first = 0, second = 0, wins2 = 0, n = 0, allOut1 = 0, wk1 = 0, allOut2 = 0;
    // the innings shape (docs/TACTICS.md section 11): extras by kind, and bowlers used in innings of 19+ overs
    const ex = { total: 0, wides: 0, noBalls: 0, byes: 0, legByes: 0 }; let bInns = 0, used = 0, six = 0, seven = 0;
    for (let s = 0; s < SEASONS; s++) {
      let st = initSeason({ ...createGameState({ ...rules, injuriesEnabled: false } as RuleSet), phase: "season" });
      let guard = 0;
      while (!isSeasonComplete(st) && guard++ < 300) {
        const r = playNextMatch(st); st = r.state;
        if (r.result.margin === "Super Over") continue;
        const [a, b] = r.result.innings;
        for (const i of [a, b]) { runs += i.runs; wkts += i.wickets; balls += i.totalBalls; inns++; }
        first += a.runs; second += b.runs; n++; wk1 += a.wickets; if (a.wickets >= 10) allOut1++; if (b.wickets >= 10) allOut2++;
        for (const c of r.detailed ? [r.detailed.innings1, r.detailed.innings2] : []) {
          ex.total += c.extras.total; ex.wides += c.extras.wides; ex.noBalls += c.extras.noBalls; ex.byes += c.extras.byes ?? 0; ex.legByes += c.extras.legByes;
          if (Number(c.totalOvers) >= 19) { const k = c.bowlers.length; bInns++; used += k; six += +(k >= 6); seven += +(k >= 7); }
        }
        if (r.result.winnerId === b.teamId) wins2++;
      }
    }
    const t = TARGET[id];
    console.log(`${id.padEnd(10)} runs/inn ${(runs / inns).toFixed(1)} (real ${t.runs})  wkts/inn ${(wkts / inns).toFixed(2)} (${t.wkts})  balls/inn ${(balls / inns).toFixed(1)} (${t.balls})  1st ${(first / n).toFixed(1)} 2nd ${(second / n).toFixed(1)} chase-win ${(100 * wins2 / n).toFixed(0)}%  1st all out ${(100 * allOut1 / n).toFixed(1)}% 1st wkts ${(wk1 / n).toFixed(2)}  mult ${rules.scoringMultiplier}`);
    const d = Math.max(1, ex.total ? inns : 1), m = Math.max(1, bInns);
    console.log(`${id.padEnd(10)} shape: 2nd all out ${(100 * allOut2 / n).toFixed(1)}%  extras/inn ${(ex.total / d).toFixed(2)} (wides ${(ex.wides / d).toFixed(2)} nb ${(ex.noBalls / d).toFixed(2)} byes ${(ex.byes / d).toFixed(2)} lb ${(ex.legByes / d).toFixed(2)})  bowlers ${(used / m).toFixed(2)} 6+ ${(100 * six / m).toFixed(1)}% 7+ ${(100 * seven / m).toFixed(1)}% (${bInns} inns of 19+ overs)`);
  }
}, 3_600_000);
