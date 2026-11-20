import { expect, it } from "vitest";
import {
  EXTRA_LEAGUES, RULE_PRESETS, simulateMatch, createMatchState, simulateRemaining, setAggression,
  type BallEvent, type RuleSet, type Team,
} from "@ipl-sim/engine";
import { createGameState } from "../game-state";

/**
 * Live v instant parity (skipped unless LIVE_PARITY=1): the same squads (the game's own, built by createGameState), the same
 * pairings and seeds, played by the instant engine (simulateMatch) and the live one (createMatchState + simulateRemaining:
 * CPU v CPU, and with a user side on default settings whose decisions the CPU takes). Per innings: runs, wickets, 4s, 6s,
 * extras, run rate by phase, all-out share; batting-first wins. docs/RULES-MATCH.md 12.4 / 13.8 has the table.
 *   LIVE_PARITY=1 PARITY_MATCHES=400 npx vitest run packages/app/src/__tests__/live-parity.test.ts --reporter=verbose
 * A second table plays the IPL with the user side batting DEF / BAL / ATK (the live page's buttons: 20 / 50 / 80) all match.
 * PARITY_ONLY=ipl,wpl limits the leagues. No rain in either engine (both take it only when asked: the rain option).
 */
const N = Number(process.env.PARITY_MATCHES ?? 300);

interface Acc { inns: number; runs: number; wkts: number; fours: number; sixes: number; extras: number; allOut: number; matches: number; bfWins: number; decided: number; ph: number[][] }
const acc = (): Acc => ({ inns: 0, runs: 0, wkts: 0, fours: 0, sixes: 0, extras: 0, allOut: 0, matches: 0, bfWins: 0, decided: 0, ph: [[0, 0], [0, 0], [0, 0]] });

function addInnings(a: Acc, inn: { runs: number; wickets: number; fours: number; sixes: number; extras: number; ballLog: BallEvent[] }) {
  a.inns++; a.runs += inn.runs; a.wkts += inn.wickets; a.fours += inn.fours; a.sixes += inn.sixes; a.extras += inn.extras;
  if (inn.wickets >= 10) a.allOut++;
  for (const b of inn.ballLog) {
    if (b.deadBall) continue;
    const p = b.over < 6 ? 0 : b.over < 15 ? 1 : 2;
    a.ph[p][0] += b.runs + b.extras;
    if (b.outcome !== "wide" && b.outcome !== "noball") a.ph[p][1]++;
  }
}

function row(label: string, a: Acc): string {
  const f = (x: number, d = 1) => x.toFixed(d);
  return `| ${label.padEnd(16)} | ${f(a.runs / a.inns)} | ${f(a.wkts / a.inns, 2)} | ${f(a.fours / a.inns)} | ${f(a.sixes / a.inns)} | ${f(a.extras / a.inns)} | ${a.ph.map(p => f((6 * p[0]) / Math.max(1, p[1]), 2)).join(" / ")} | ${f((100 * a.allOut) / a.inns)}% | ${f((100 * a.bfWins) / Math.max(1, a.decided))}% |`;
}

it.skipIf(!process.env.LIVE_PARITY)("live v instant parity", () => {
  const leagues: Array<{ id: string; rules: RuleSet }> = [
    { id: "ipl", rules: RULE_PRESETS.modern2026 }, { id: "wpl", rules: RULE_PRESETS.wpl },
    ...EXTRA_LEAGUES.filter(l => ["bbl", "psl", "wbbl"].includes(l.id as string)).map(l => ({ id: l.id as string, rules: l.rules })),
  ].filter(l => !process.env.PARITY_ONLY || process.env.PARITY_ONLY.split(",").includes(l.id));
  console.log("| league / engine  | runs | wkts | 4s | 6s | extras | RR 1-6 / 7-15 / 16-20 | all out | bat 1st wins |");
  for (const { id, rules0 } of leagues.map(l => ({ id: l.id, rules0: l.rules }))) {
    const rules = { ...rules0, injuriesEnabled: false } as RuleSet;
    const teamsFor = (): Team[] => createGameState(rules).teams;
    const pairs = Array.from({ length: N }, (_, i) => [i % 1000, (i * 7 + 3) % 1000]);
    const runEngine = (kind: "instant" | "live" | "live-user") => {
      const teams = teamsFor();
      const a = acc();
      pairs.forEach(([x, y], i) => {
        const home = teams[x % teams.length];
        let away = teams[y % teams.length];
        if (away === home) away = teams[(y + 1) % teams.length];
        if (kind === "instant") {
          const r = simulateMatch(home, away, rules, 5000 + i, { countTowardStandings: false });
          for (const inn of r.innings) addInnings(a, inn);
          a.matches++;
          if (r.winnerId && r.margin !== "Super Over") { a.decided++; if (r.winnerId === r.innings[0].teamId) a.bfWins++; }
        } else {
          const { state } = simulateRemaining(createMatchState(home, away, rules, kind === "live-user" ? home.id : null, 5000 + i));
          const raws = [state._internal.innings1Raw, state._internal.currentInningsRaw].filter(Boolean);
          for (const raw of raws) addInnings(a, raw!);
          a.matches++;
          if (state.winnerId && !state.superOvers) { a.decided++; if (state.winnerId === state._internal.battingFirstId) a.bfWins++; }
        }
      });
      return a;
    };
    console.log(row(`${id} instant`, runEngine("instant")));
    console.log(row(`${id} live CPU`, runEngine("live")));
    console.log(row(`${id} live user`, runEngine("live-user")));
  }
}, 3_600_000);

it.skipIf(!process.env.LIVE_PARITY)("live batting approach (IPL, the user side's innings)", () => {
  const rules = { ...RULE_PRESETS.modern2026, injuriesEnabled: false } as RuleSet;
  console.log("| approach | runs | wkts | RR | 4s | 6s | all out |");
  for (const [label, level] of [["DEF (20)", 20], ["BAL (50)", 50], ["ATK (80)", 80]] as const) {
    const teams = createGameState(rules).teams;
    const a = acc();
    let legal = 0;
    for (let i = 0; i < N; i++) {
      const home = teams[i % teams.length];
      let away = teams[(i * 7 + 3) % teams.length];
      if (away === home) away = teams[(i * 7 + 4) % teams.length];
      const start = setAggression(createMatchState(home, away, rules, home.id, 5000 + i), home.id, level);
      const { state } = simulateRemaining(start);
      for (const raw of [state._internal.innings1Raw, state._internal.currentInningsRaw]) {
        if (!raw || raw.teamId !== home.id) continue;
        addInnings(a, raw);
        legal += raw.totalBalls;
      }
    }
    const f = (x: number, d = 1) => x.toFixed(d);
    console.log(`| ${label} | ${f(a.runs / a.inns)} | ${f(a.wkts / a.inns, 2)} | ${f((6 * a.runs) / legal, 2)} | ${f(a.fours / a.inns)} | ${f(a.sixes / a.inns)} | ${f((100 * a.allOut) / a.inns)}% |`);
  }
}, 3_600_000);

/**
 * The last pair (nine down; docs/TACTICS.md section 5): the same term in both engines (match.ts ballProbabilities, with the non-striker's rating
 * and the ball of the over). Per innings that reached nine down, in the IPL: the share of the pair's balls the weaker batter (by batting rating) faced,
 * the stand's balls and runs, how often it ended in the tenth wicket. The instant and the live CPU engine must read alike.
 */
it.skipIf(!process.env.LIVE_PARITY)("live v instant parity: the last pair", () => {
  const rules = { ...RULE_PRESETS.modern2026, injuriesEnabled: false } as RuleSet;
  const M = Number(process.env.PARITY_LAST_PAIR_MATCHES ?? 800);
  const stat = (kind: "instant" | "live") => {
    const teams = createGameState(rules).teams;
    const byId = new Map(teams.flatMap(t => t.roster).map(p => [p.id, p]));
    const rating = (id: string) => { const p = byId.get(id); return p ? (p.battingOvr + p.ratings.timing) / 200 : 0; };
    let stands = 0, balls = 0, runs = 0, ended = 0, weakBalls = 0, rated = 0;
    const add = (log: BallEvent[]) => {
      let wk = 0, inStand = false;
      for (const b of log) {
        if (b.deadBall) { if (b.isWicket) wk++; continue; }
        if (wk === 9) {
          if (!inStand) { inStand = true; stands++; }
          runs += b.runs + b.extras;
          if (b.outcome !== "wide") {
            balls++;
            const [s, n] = [rating(b.batter), rating(b.nonStriker ?? "")];
            if (s !== n) { rated++; if (s < n) weakBalls++; }
          }
          if (b.isWicket) ended++;
        }
        if (b.isWicket) wk++;
      }
    };
    for (let i = 0; i < M; i++) {
      const home = teams[i % teams.length];
      let away = teams[(i * 7 + 3) % teams.length];
      if (away === home) away = teams[(i * 7 + 4) % teams.length];
      if (kind === "instant") for (const inn of simulateMatch(home, away, rules, 5000 + i, { countTowardStandings: false }).innings) add(inn.ballLog);
      else {
        const { state } = simulateRemaining(createMatchState(home, away, rules, null, 5000 + i));
        for (const raw of [state._internal.innings1Raw, state._internal.currentInningsRaw]) if (raw) add(raw.ballLog);
      }
    }
    return { stands, balls: balls / stands, runs: runs / stands, ended: ended / stands, weak: weakBalls / rated };
  };
  const a = stat("instant"), b = stat("live");
  console.log("| engine  | innings at nine down | balls | runs | tenth wicket | weaker partner's share of balls |");
  for (const [l, x] of [["instant", a], ["live CPU", b]] as const) console.log(`| ${l.padEnd(7)} | ${x.stands} | ${x.balls.toFixed(2)} | ${x.runs.toFixed(2)} | ${(100 * x.ended).toFixed(1)}% | ${(100 * x.weak).toFixed(1)}% |`);
  expect(Math.abs(a.weak - b.weak)).toBeLessThan(0.1);
  expect(Math.abs(a.balls - b.balls)).toBeLessThan(2);
}, 3_600_000);
