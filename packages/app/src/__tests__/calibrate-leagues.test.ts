import { it } from "vitest";
import { EXTRA_LEAGUES, RULE_PRESETS, type RuleSet } from "@ipl-sim/engine";
import { createGameState, initSeason, playNextMatch, isSeasonComplete } from "../game-state";

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
it.skipIf(!process.env.CALIBRATE_LEAGUES)("calibrate", () => {
  const leagues = process.env.CAL_ONLY ? EXTRA_LEAGUES.filter(l => process.env.CAL_ONLY!.split(",").includes(l.id)) : EXTRA_LEAGUES;
  const list: Array<{ id: string; rules: RuleSet }> = [{ id: "ipl", rules: RULE_PRESETS.modern2026 }, { id: "wpl", rules: RULE_PRESETS.wpl }, ...leagues];
  for (const { id, rules } of list) {
    let runs = 0, wkts = 0, balls = 0, inns = 0, first = 0, second = 0, wins2 = 0, n = 0;
    for (let s = 0; s < SEASONS; s++) {
      let st = initSeason({ ...createGameState({ ...rules, injuriesEnabled: false } as RuleSet), phase: "season" });
      let guard = 0;
      while (!isSeasonComplete(st) && guard++ < 300) {
        const r = playNextMatch(st); st = r.state;
        if (r.result.margin === "Super Over") continue;
        const [a, b] = r.result.innings;
        for (const i of [a, b]) { runs += i.runs; wkts += i.wickets; balls += i.totalBalls; inns++; }
        first += a.runs; second += b.runs; n++;
        if (r.result.winnerId === b.teamId) wins2++;
      }
    }
    const t = TARGET[id];
    console.log(`${id.padEnd(10)} runs/inn ${(runs / inns).toFixed(1)} (real ${t.runs})  wkts/inn ${(wkts / inns).toFixed(2)} (${t.wkts})  balls/inn ${(balls / inns).toFixed(1)} (${t.balls})  1st ${(first / n).toFixed(1)} 2nd ${(second / n).toFixed(1)} chase-win ${(100 * wins2 / n).toFixed(0)}%  mult ${rules.scoringMultiplier}`);
  }
}, 900_000);
