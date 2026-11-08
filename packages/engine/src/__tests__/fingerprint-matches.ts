/**
 * Seeded fingerprint of the T20 and Hundred engines: plays a fixed set of matches (instant engine: men, women, The
 * Hundred, rain on; live engine: CPU v CPU and a user side resolved by the CPU) and prints one hash per group plus a
 * combined hash. Run it before and after an engine change that must not move T20 / Hundred play (e.g. adding a format):
 *
 *   npx tsx packages/engine/src/__tests__/fingerprint-matches.ts [matches=300]
 *
 * Equal hashes = every ball of every match came out the same (outcome, runs, extras, kind, players, commentary).
 */
import { createHash } from "node:crypto";
import { getRealPlayers } from "../../../ratings/src/real-players.js";
import * as E from "../index.js";

const nativeRandom = Math.random;

const N = Number(process.argv[2] ?? 300);

function squads(rules: E.RuleSet): E.Team[] {
  const teams = E.IPL_TEAMS.map(c => new E.Team(c, rules.salaryCap));
  for (const d of getRealPlayers()) {
    const team = teams.find(t => t.id === d.teamId);
    if (team) team.addPlayer(E.createPlayerFromData({ ...d } as never), d.bid ?? 1);
  }
  return teams;
}

const ballKey = (b: E.BallEvent) =>
  [b.over, b.ball, b.bowler, b.batter, b.outcome, b.runs, b.extras, b.wicketType ?? "", b.fielderId ?? "", b.fieldingNote ?? "", b.review?.result ?? "", b.commentary].join("|");

function instant(label: string, rules: E.RuleSet, rain: boolean): string {
  const h = createHash("sha256");
  const teams = squads(rules);
  for (let i = 0; i < N; i++) {
    const a = teams[i % teams.length];
    const b = teams[(i * 7 + 3) % teams.length === i % teams.length ? (i + 1) % teams.length : (i * 7 + 3) % teams.length];
    const r = E.simulateMatch(a, b, rules, 5000 + i, { countTowardStandings: false, rain });
    h.update(`${r.winnerId}|${r.margin}|${r.rain?.kind ?? ""}|${r.rain?.target ?? ""}`);
    for (const inn of r.innings) for (const ev of inn.ballLog) h.update(ballKey(ev));
    for (const [x, y] of r.superOverRounds ?? []) for (const ev of [...x.ballLog, ...y.ballLog]) h.update(ballKey(ev));
  }
  const d = h.digest("hex").slice(0, 16);
  console.log(`${label.padEnd(28)} ${d}`);
  return d;
}

function live(label: string, rules: E.RuleSet, user: boolean): string {
  const h = createHash("sha256");
  const teams = squads(rules);
  const n = Math.max(1, Math.floor(N / 3));
  for (let i = 0; i < n; i++) {
    const a = teams[i % teams.length];
    const b = teams[(i + 1) % teams.length];
    // a few live paths (e.g. the next bowler after a user decision) still draw from Math.random: seed it per match
    Math.random = E.createRNG(70000 + i);
    const { state } = E.simulateRemaining(E.createMatchState(a, b, rules, user ? a.id : null, 9000 + i));
    h.update(`${state.winnerId}|${state.result}`);
    for (const ev of state.ballLog) h.update([ev.over, ev.ball, ev.batterName, ev.bowlerName, ev.eventType, ev.runs, ev.extras, ev.wicketType ?? "", ev.commentary].join("|"));
  }
  Math.random = nativeRandom;
  const d = h.digest("hex").slice(0, 16);
  console.log(`${label.padEnd(28)} ${d}`);
  return d;
}

const men = { ...E.RULE_PRESETS.modern2026, injuriesEnabled: false } as E.RuleSet;
const women = { ...men, gender: "women" } as E.RuleSet;
const hundred = { ...men, matchFormat: "hundred", impactPlayer: false } as E.RuleSet;
const parts = [
  instant("instant T20 men", men, false),
  instant("instant T20 men, rain", men, true),
  instant("instant T20 women", women, false),
  instant("instant Hundred, rain", hundred, true),
  live("live T20 CPU v CPU", men, false),
  live("live T20 user side", men, true),
];
console.log(`${"combined".padEnd(28)} ${createHash("sha256").update(parts.join("")).digest("hex").slice(0, 16)}`);
