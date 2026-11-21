/**
 * In-match injuries benchmark (in-match-injury.ts): concussion substitutes per 1,000 matches by format against the Cricsheet fit
 * years, who is hit (batting / fielding), the replacement's role against the replaced player's, and what the in-match injuries
 * cost after the match (share that miss the next match, mean matches missed when they do).
 *
 *   npx tsx packages/engine/src/__tests__/benchmark-concussion.ts [t20=20000] [odi=6000] [tests=1500]
 *   LIVE=1 ...   the live engine for the T20 (CPU v CPU, simulateRemaining)
 *
 * docs/RULES-MATCH.md section 13.9 has the numbers.
 */
import { getRealPlayers } from "../../../ratings/src/real-players.js";
import * as E from "../index.js";
import { simulateTestMatch } from "../test-match.js";
import { TEST_SQUADS } from "./test-squads.js";
import { poolTestTeam } from "./test-pool-squads.js";

const [NT20, NODI, NTEST] = [Number(process.argv[2] ?? 20000), Number(process.argv[3] ?? 6000), Number(process.argv[4] ?? 1500)];
const D = E.IN_MATCH_INJURY_DATA;

function iplTeams(rules: E.RuleSet): E.Team[] {
  const teams = E.IPL_TEAMS.map(c => new E.Team(c, rules.salaryCap));
  for (const d of getRealPlayers()) {
    const t = teams.find(x => x.id === d.teamId);
    if (t) t.addPlayer(E.createPlayerFromData({ ...d }), d.bid ?? 1);
  }
  return teams;
}

type Tally = { matches: number; conc: number; bat: number; noSub: number; like: number; pairs: Record<string, number>; hurt: Record<string, [number, number, number]> };
const tally = (): Tally => ({ matches: 0, conc: 0, bat: 0, noSub: 0, like: 0, pairs: {}, hurt: {} });
const roleOf = (teams: E.Team[], id: string) => teams.flatMap(t => t.roster).find(p => p.id === id)?.role ?? "?";

function count(t: Tally, teams: E.Team[], events: readonly E.InMatchInjury[], injuries: readonly E.MatchInjuryEvent[]) {
  t.matches++;
  for (const e of events) {
    if (e.kind !== "concussion") continue;
    t.conc++;
    if (e.side === "batting") t.bat++;
    if (!e.subId) { t.noSub++; continue; }
    const a = roleOf(teams, e.playerId), b = roleOf(teams, e.subId);
    if (E.isLikeForLikeReplacement(a, b)) t.like++;
    t.pairs[`${a} -> ${b}`] = (t.pairs[`${a} -> ${b}`] ?? 0) + 1;
  }
  for (const i of injuries) {
    if (!i.inMatch) continue;
    const h = (t.hurt[i.inMatch] ??= [0, 0, 0]);
    h[0]++;
    if (i.injury.matchesRemaining > 0) { h[1]++; h[2] += i.injury.matchesRemaining; }
  }
}

function heal(teams: E.Team[]) {
  for (const t of teams) for (const p of t.roster) { p.injured = false; p.injuryGamesLeft = 0; p.injuryHistory = [0, 0]; }
}

function report(name: string, fmt: E.InMatchFormat, t: Tally) {
  const real = E.concussionFitPer1000(fmt);
  const se = Math.sqrt(t.conc) / t.matches * 1000;
  console.log(`\n${name}: ${t.matches} matches, ${t.conc} concussions = ${(1000 * t.conc / t.matches).toFixed(2)} per 1,000 (+-${se.toFixed(2)}); real fit ${real.toFixed(2)}`);
  console.log(`  hit batting ${(100 * t.bat / Math.max(1, t.conc)).toFixed(0)}% (real ${(100 * D.concussion.battingShare).toFixed(0)}%), no sub ${t.noSub}, like for like ${(100 * t.like / Math.max(1, t.conc - t.noSub)).toFixed(0)}%`);
  console.log(`  pairs ${JSON.stringify(Object.fromEntries(Object.entries(t.pairs).sort((a, b) => b[1] - a[1]).slice(0, 8)))}`);
  for (const [k, [n, miss, m]] of Object.entries(t.hurt)) console.log(`  ${k}: ${n}, miss next ${(100 * miss / n).toFixed(0)}%, mean missed when out ${(m / Math.max(1, miss)).toFixed(2)}`);
}

// T20: the IPL squads
{
  const rules = { ...E.RULE_PRESETS.modern, injuriesEnabled: true };
  const teams = iplTeams(rules);
  const t = tally();
  let seed = 77;
  for (let i = 0; i < NT20; i++) {
    const a = i % 10, b = (a + 1 + (i % 9)) % 10;
    if (process.env.LIVE) {
      const st = E.simulateRemaining(E.createMatchState(teams[a], teams[b], rules, null, ++seed)).state;
      count(t, teams, st.inMatchInjuries ?? [], E.applyInMatchInjuries(st.inMatchInjuries ?? [], id => teams.flatMap(x => x.roster).find(p => p.id === id), { enabled: true, format: "T20", rng: Math.random }));
    } else {
      const r = E.simulateMatch(teams[a], teams[b], rules, ++seed, { countTowardStandings: false });
      count(t, teams, r.innings.flatMap(x => x.inMatchInjuries ?? []), r.injuries);
    }
    heal(teams);
  }
  report(process.env.LIVE ? "T20 (live)" : "T20", "T20", t);
}

// ODI: the IPL squads under the men's ODI rules (their ODI ratings where they have them)
{
  const rules = E.odiRules("men", { ...E.DEFAULT_RULES, injuriesEnabled: true });
  const teams = iplTeams(rules);
  const t = tally();
  let seed = 991;
  for (let i = 0; i < NODI; i++) {
    const a = i % 10, b = (a + 1 + (i % 9)) % 10;
    const r = E.simulateMatch(teams[a], teams[b], rules, ++seed, { countTowardStandings: false, neutralVenue: true });
    count(t, teams, r.innings.flatMap(x => x.inMatchInjuries ?? []), r.injuries);
    heal(teams);
  }
  report("ODI", "ODI", t);
}

// Tests: the men's national squads
{
  const squads = TEST_SQUADS.filter(s => s.gender === "male");
  const teams = squads.map(s => poolTestTeam(s.team, "male", {}).team);
  const t = tally();
  for (let i = 0; i < NTEST; i++) {
    const a = i % teams.length, b = (a + 1 + (i % (teams.length - 1))) % teams.length;
    const r = simulateTestMatch(teams[a], teams[b], { seed: 3000 + i, injuries: true });
    count(t, teams, r.state.inMatchInjuries ?? [], r.injuries);
    heal(teams);
  }
  report("Test", "Test", t);
}
