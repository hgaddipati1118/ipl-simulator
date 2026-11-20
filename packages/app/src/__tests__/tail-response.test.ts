import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { EXTRA_LEAGUES, RULE_PRESETS, createMatchState, simulateMatch, simulateRemaining, type BallEvent, type BallOutcome, type RuleSet, type Team, type Player } from "@ipl-sim/engine";
import { createGameState } from "../game-state";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import type { PlayerActivityFile } from "@ipl-sim/ratings/dist/player-activity.js";
import { createSeries, matchContext, seriesSquads, type SeriesGender } from "../international";
import { createPoolLoader } from "../extended-pool";

/**
 * The batter-rating response of the T20 ball model, measured (skipped unless TAIL_COLLECT=1): the simulated deliveries of the
 * T20Is (men, women; the real full-member fixtures) and of every league, counted by competition group x phase (powerplay, middle,
 * death on the T20 timeline) x the striker's batting rating bin ((battingOvr + timing) / 200 in steps of 0.05 from 0.20) x outcome
 * class, written as json for packages/ratings/src/analysis/t20-batter-response.py, which sets the same counts from real Cricsheet
 * balls (batters on the game's own ratings) side by side and fits the response.
 *   TAIL_COLLECT=1 TAIL_OUT=sim.json [TAIL_MATCHES=1500] [TAIL_REPLAYS=2] [TAIL_ONLY=t20i-men,ipl,...] npx vitest run packages/app/src/__tests__/tail-response.test.ts
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const PUBLIC = join(HERE, "..", "..", "public");

type Phase = "powerplay" | "middle" | "death";
const PHASES: Phase[] = ["powerplay", "middle", "death"];
const CLASSES: BallOutcome[] = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"];
const BIN0 = 0.2, BINW = 0.05, NBIN = 16;
const phaseOf = (over: number, hundred: boolean, odi = false): Phase => (odi ? (over < 10 ? "powerplay" : over < 40 ? "middle" : "death") : over <= (hundred ? 4 : 5) ? "powerplay" : over <= 14 ? "middle" : "death");
const binOf = (r: number) => Math.min(NBIN - 1, Math.max(0, Math.floor((r - BIN0) / BINW + 1e-9)));

function classOf(b: BallEvent): BallOutcome {
  if ((b.wides ?? 0) > 0 || b.outcome === "wide") return "wide";
  if ((b.noBalls ?? 0) > 0 || b.outcome === "noball") return "noball";
  if (b.isWicket) return "wicket";
  if ((b.byes ?? 0) + (b.legByes ?? 0) > 0 && b.runs === 0) return "legbye";
  if (b.runs >= 6) return "6";
  if (b.runs >= 4) return "4";
  return b.runs === 0 ? "dot" : (String(b.runs) as BallOutcome);
}

type Cells = number[][][]; // phase x bin x class
const newCells = (): Cells => PHASES.map(() => Array.from({ length: NBIN }, () => CLASSES.map(() => 0)));

interface Inn { teamId: string; ballLog: BallEvent[] }
function addInnings(cells: Cells, inn: Inn, roster: readonly Player[], hundred: boolean, odi = false) {
  const byId = new Map(roster.map(p => [p.id, p]));
  for (const b of inn.ballLog) {
    if (b.deadBall) continue;
    const p = byId.get(b.batter);
    if (!p) continue;
    const r = (p.battingOvr + p.ratings.timing) / 200;
    const c = CLASSES.indexOf(classOf(b));
    const ph = PHASES.indexOf(phaseOf(b.over, hundred, odi));
    cells[ph][binOf(r)][c]++;
  }
}

it.skipIf(!process.env.TAIL_COLLECT)("batter response: simulated cells", async () => {
  const N = Number(process.env.TAIL_MATCHES ?? 1500);
  const replays = Number(process.env.TAIL_REPLAYS ?? 2);
  const only = process.env.TAIL_ONLY?.split(",");
  const out: Record<string, { cells: Cells; matches: number }> = {};
  const want = (id: string) => !only || only.includes(id);

  // leagues (the game's squads, random pairings, instant engine)
  const extra = EXTRA_LEAGUES.map(l => [l.id, l.rules] as [string, RuleSet]);
  const leagues: Array<[string, RuleSet]> = [["ipl", RULE_PRESETS.modern2026 as RuleSet], ["wpl", RULE_PRESETS.wpl as RuleSet], ...extra];
  for (const [id, r0] of leagues) {
    if (!want(id)) continue;
    const rules = { ...r0, injuriesEnabled: false } as RuleSet;
    const hundred = rules.matchFormat === "hundred";
    const teams = createGameState(rules).teams;
    const cells = newCells();
    for (let i = 0; i < N; i++) {
      const home = teams[i % teams.length];
      let away = teams[(i * 7 + 3) % teams.length];
      if (away === home) away = teams[(i * 7 + 4) % teams.length];
      const r = simulateMatch(home, away, rules, 5000 + i, { countTowardStandings: false });
      r.innings.forEach(inn => {
        const t = inn.teamId === home.id ? home : away;
        addInnings(cells, inn as Inn, t.roster, hundred);
      });
    }
    out[id] = { cells, matches: N };
    console.log(`${id}: ${N} matches`);
  }

  // T20Is
  const VALID = JSON.parse(readFileSync(join(REPO, "docs", "data", "t20i_validation.json"), "utf-8")) as { t20i: Record<SeriesGender, { fixtures: [string, string, number][] }> };
  const FILE = JSON.parse(readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;
  const ACTIVITY = JSON.parse(readFileSync(join(PUBLIC, "data", "player-activity.json"), "utf-8")) as PlayerActivityFile;
  for (const gender of ["men", "women"] as SeriesGender[]) {
    const id = `t20i-${gender}`;
    if (!want(id)) continue;
    const extended = await createPoolLoader(async f => new Uint8Array(readFileSync(join(PUBLIC, "pool", f)))).players(gender, ["senior"]);
    const cells = newCells();
    let n = 0;
    VALID.t20i[gender].fixtures.forEach(([a, b, k], i) => {
      const series = createSeries({ format: "t20i", gender, nations: [a, b], length: 1, host: "neutral", userSide: null, seed: 1000 + i }, FILE, ACTIVITY, extended);
      const squads = seriesSquads(series, FILE, extended);
      for (let j = 0; j < k * replays; j++) {
        const m = matchContext(series, 0, squads);
        const [home, away]: [Team, Team] = [m.home, m.away];
        const r = simulateMatch(home, away, m.rules!, 7919 * i + 104729 * j + 17, { countTowardStandings: false, neutralVenue: true });
        r.innings.forEach(inn => addInnings(cells, inn as Inn, (inn.teamId === home.id ? home : away).roster, false));
        n++;
      }
    });
    out[id] = { cells, matches: n };
    console.log(`${id}: ${n} matches`);
  }
  void createMatchState; void simulateRemaining;
  writeFileSync(process.env.TAIL_OUT ?? "tail-sim.json", JSON.stringify({ bin0: BIN0, binw: BINW, nbin: NBIN, phases: PHASES, classes: CLASSES, groups: out }));
}, 7_200_000);
