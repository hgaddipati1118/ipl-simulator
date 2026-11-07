/**
 * Balance benchmark for fielding / keeping: simulate many matches between the ten IPL squads (the game's own
 * player data) and print per-innings averages. Run it twice and compare: with the fielding / keeping ratings
 * (default) and without them (NO_FK=1 strips the two fields, so every player gets the engine default); to compare with
 * an older engine, point ENGINE at its dist/index.js.
 *
 *   npx tsx packages/engine/src/__tests__/benchmark-fielding.ts [matches=20000]
 *   NO_FK=1 npx tsx packages/engine/src/__tests__/benchmark-fielding.ts 20000
 *   ENGINE=/path/to/old/dist/index.js NO_FK=1 npx tsx packages/engine/src/__tests__/benchmark-fielding.ts 20000
 *
 * docs/RULES-MATCH.md section 11 has the numbers.
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
  const data: any = { ...d };
  if (process.env.NO_FK) { delete data.fielding; delete data.keeping; }
  team.addPlayer(E.createPlayerFromData(data), d.bid ?? 1);
}

const s = { inns: 0, runs: 0, wkts: 0, fours: 0, sixes: 0, extras: 0, legbyes: 0, caught: 0, runOut: 0, stumped: 0, dropped: 0, great: 0 };
let seed = 12345;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
for (let i = 0; i < N; i++) {
  const a = Math.floor(rnd() * teams.length);
  let b = Math.floor(rnd() * teams.length);
  if (b === a) b = (b + 1) % teams.length;
  const res = E.simulateMatch(teams[a], teams[b], rules, 1000 + i, { countTowardStandings: false });
  for (const inn of res.innings) {
    s.inns++; s.runs += inn.runs; s.wkts += inn.wickets; s.fours += inn.fours; s.sixes += inn.sixes; s.extras += inn.extras;
    for (const e of inn.ballLog) {
      if (e.outcome === "legbye") s.legbyes++;
      if (e.isWicket && e.wicketType === "caught") s.caught++;
      if (e.isWicket && e.wicketType === "run_out") s.runOut++;
      if (e.isWicket && e.wicketType === "stumped") s.stumped++;
      if (e.fieldingNote === "dropped_catch") s.dropped++;
      if (e.fieldingNote === "great_catch") s.great++;
    }
  }
}
const per = (x: number) => (x / s.inns).toFixed(3);
console.log(`${N} matches, ${process.env.NO_FK ? "fielding/keeping ratings stripped" : "with fielding/keeping ratings"}`);
console.log(`per innings: runs ${per(s.runs)}, wickets ${per(s.wkts)}, fours ${per(s.fours)}, sixes ${per(s.sixes)}, extras ${per(s.extras)} (leg byes ${per(s.legbyes)})`);
console.log(`dismissals per innings: caught ${per(s.caught)}, run out ${per(s.runOut)}, stumped ${per(s.stumped)}; dropped catches ${per(s.dropped)}, great catches ${per(s.great)}`);
