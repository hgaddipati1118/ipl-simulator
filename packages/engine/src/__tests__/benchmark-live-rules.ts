/**
 * Balance benchmark for the LIVE engine (live-match.ts): CPU-vs-CPU matches played ball by ball, same per-innings
 * metrics as benchmark-rules.ts (which measures the instant engine).
 *
 *   npx tsx packages/engine/src/__tests__/benchmark-live-rules.ts [matches=20000]
 *   ENGINE=/path/to/old/dist/index.js npx tsx packages/engine/src/__tests__/benchmark-live-rules.ts 20000
 */
import { pathToFileURL } from "node:url";
import { getRealPlayers } from "../../../ratings/src/real-players.js";

const N = Number(process.argv[2] ?? 20000);
const E: any = await import(process.env.ENGINE ? pathToFileURL(process.env.ENGINE).href : "../index.js");
const rules = { ...E.RULE_PRESETS.modern, injuriesEnabled: false };
const teams = E.IPL_TEAMS.map((c: any) => new E.Team(c, rules.salaryCap));
for (const d of getRealPlayers()) {
  const team = teams.find((t: any) => t.id === d.teamId);
  if (!team) continue;
  team.addPlayer(E.createPlayerFromData({ ...d }), d.bid ?? 1);
}

const s: Record<string, number> = { inns: 0, matches: 0, runs: 0, wkts: 0, fours: 0, sixes: 0, extras: 0, legalBalls: 0, wideBalls: 0, noBalls: 0, byeBalls: 0, freeHits: 0, chaseWins: 0, superOvers: 0 };
const kinds: Record<string, number> = {};
let seed = 12345;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
for (let i = 0; i < N; i++) {
  const a = Math.floor(rnd() * teams.length);
  let b = Math.floor(rnd() * teams.length);
  if (b === a) b = (b + 1) % teams.length;
  const { state } = E.simulateRemaining(E.createMatchState(teams[a], teams[b], rules, null, 1000 + i));
  s.matches++;
  if (state.winnerId && state.winnerId !== state._internal.battingFirstId) s.chaseWins++;
  if (state.superOvers) s.superOvers++;
  for (const raw of [state._internal.innings1Raw, state._internal.currentInningsRaw]) {
    s.inns++; s.runs += raw.runs; s.wkts += raw.wickets; s.fours += raw.fours; s.sixes += raw.sixes; s.extras += raw.extras; s.legalBalls += raw.totalBalls;
    let prevNoBall = false;
    for (const e of raw.ballLog) {
      if (e.outcome === "wide") s.wideBalls++;
      else if (e.outcome === "noball") s.noBalls++;
      else if (e.outcome === "legbye") s.byeBalls++;
      if (e.freeHit || prevNoBall) s.freeHits++;
      prevNoBall = e.outcome === "noball" || (prevNoBall && e.outcome === "wide");
      if (e.isWicket) kinds[e.wicketType ?? "?"] = (kinds[e.wicketType ?? "?"] ?? 0) + 1;
    }
  }
}
const per = (x: number) => (x / s.inns).toFixed(3);
console.log(`LIVE engine: ${N} matches (${s.inns} innings)`);
console.log(`per innings: runs ${per(s.runs)}, wickets ${per(s.wkts)}, fours ${per(s.fours)}, sixes ${per(s.sixes)}, extras ${per(s.extras)}, legal balls ${per(s.legalBalls)}`);
console.log(`per innings balls: wides ${per(s.wideBalls)}, no-balls ${per(s.noBalls)}, bye/leg-bye ${per(s.byeBalls)}, free hits ${per(s.freeHits)}`);
console.log(`chasing side wins ${(100 * s.chaseWins / s.matches).toFixed(1)}%, super overs ${(100 * s.superOvers / s.matches).toFixed(2)}% of matches`);
const tot = Object.values(kinds).reduce((a, b) => a + b, 0);
console.log("dismissal mix: " + Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(100 * v / tot).toFixed(2)}%`).join(", "));
