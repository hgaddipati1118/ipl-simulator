/**
 * Balance benchmark for the match rules (extras, dismissal kinds, free hits ...): simulate many matches between the ten
 * IPL squads and print per-innings averages and the dismissal-kind mix. Works on any engine build that has the BallEvent
 * shape (outcome / runs / extras / isWicket / wicketType), so the same script measures "before" and "after".
 *
 *   npx tsx packages/engine/src/__tests__/benchmark-rules.ts [matches=20000]
 *   ENGINE=/path/to/old/dist/index.js npx tsx packages/engine/src/__tests__/benchmark-rules.ts 60000
 *   RAIN=1 ...   play with rain / DLS / no results (default off, so innings compare like for like)
 *   GENDER=women ...   the same squads under the women's rates (extras, dismissal mix)
 *
 * docs/RULES-MATCH.md section 12 has the numbers.
 */
import { pathToFileURL } from "node:url";
import { getRealPlayers } from "../../../ratings/src/real-players.js";

const N = Number(process.argv[2] ?? 20000);
const E: any = await import(process.env.ENGINE ? pathToFileURL(process.env.ENGINE).href : "../index.js");
const rules = { ...E.RULE_PRESETS.modern, injuriesEnabled: false, ...(process.env.GENDER ? { gender: process.env.GENDER } : {}) };
const teams = E.IPL_TEAMS.map((c: any) => new E.Team(c, rules.salaryCap));
for (const d of getRealPlayers()) {
  const team = teams.find((t: any) => t.id === d.teamId);
  if (!team) continue;
  team.addPlayer(E.createPlayerFromData({ ...d }), d.bid ?? 1);
}

const s: Record<string, number> = { inns: 0, matches: 0, runs: 0, wkts: 0, fours: 0, sixes: 0, extras: 0, legalBalls: 0, wideBalls: 0, noBalls: 0, byeBalls: 0, freeHits: 0, chaseWins: 0, ties: 0 };
const ev: Record<string, number> = {};
const bump = (k: string, n = 1) => { ev[k] = (ev[k] ?? 0) + n; };
const kinds: Record<string, number> = {};
let seed = 12345;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
for (let i = 0; i < N; i++) {
  const a = Math.floor(rnd() * teams.length);
  let b = Math.floor(rnd() * teams.length);
  if (b === a) b = (b + 1) % teams.length;
  const res = E.simulateMatch(teams[a], teams[b], rules, 1000 + i, { countTowardStandings: false, rain: !!process.env.RAIN });
  s.matches++;
  if (res.rain) bump(`rain ${res.rain.kind}`);
  const bf = res.innings[0].teamId;
  if (res.winnerId && res.winnerId !== bf) s.chaseWins++;
  if (res.superOver) s.ties++;
  for (const inn of res.innings) {
    s.inns++; s.runs += inn.runs; s.wkts += inn.wickets; s.fours += inn.fours; s.sixes += inn.sixes; s.extras += inn.extras;
    let prevNoBall = false;
    for (const e of inn.ballLog) {
      if (e.outcome === "wide") s.wideBalls++;
      else if (e.outcome === "noball") s.noBalls++;
      else if (e.outcome === "legbye") s.byeBalls++;
      if (e.freeHit || prevNoBall) s.freeHits++;
      prevNoBall = e.outcome === "noball" || (prevNoBall && e.outcome === "wide");
      if (e.isWicket) kinds[e.wicketType ?? "?"] = (kinds[e.wicketType ?? "?"] ?? 0) + 1;
      if (e.fieldingNote) bump(e.fieldingNote + (e.deepChance ? " (deep)" : ""));
      if (e.boundaryCatch) bump("boundary catch");
      if (e.review) { bump("review"); bump(`review ${e.review.by} ${e.review.kind} ${e.review.result}`); }
      if (e.shortRun) bump("short run");
      if (e.lodged) bump("lodged dead ball");
      if (e.beamer) bump("beamer");
      if (e.noBallKind) bump(`no-ball ${e.noBallKind}`);
      if (e.penaltyRuns) bump(`penalty ${e.penaltyReason ?? "?"}`);
    }
    if (inn.overRatePenaltyFrom !== undefined) bump("over-rate penalty innings");
    if (inn.suspendedBowlers?.length) bump("bowler removed (beamers)", inn.suspendedBowlers.length);
    s.legalBalls += inn.totalBalls;
  }
}
const per = (x: number) => (x / s.inns).toFixed(3);
console.log(`${N} matches (${s.inns} innings)`);
console.log(`per innings: runs ${per(s.runs)}, wickets ${per(s.wkts)}, fours ${per(s.fours)}, sixes ${per(s.sixes)}, extras ${per(s.extras)}, legal balls ${per(s.legalBalls)}`);
console.log(`per innings balls: wides ${per(s.wideBalls)}, no-balls ${per(s.noBalls)}, bye/leg-bye ${per(s.byeBalls)}, free hits ${per(s.freeHits)}`);
console.log(`chasing side wins ${(100 * s.chaseWins / s.matches).toFixed(1)}%, super overs ${(100 * s.ties / s.matches).toFixed(2)}% of matches`);
const tot = Object.values(kinds).reduce((a, b) => a + b, 0);
console.log("dismissal mix: " + Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(100 * v / tot).toFixed(2)}%`).join(", "));
console.log("events per innings: " + Object.entries(ev).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / s.inns).toFixed(4)}`).join(", "));
console.log("dismissals per innings: " + Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${per(v)}`).join(", "));
