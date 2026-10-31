/** Deterministic teams and result digests shared by the mod-hook tests (engine and packages/mods). */
import { Team, IPL_TEAMS } from "../team.js";
import { Player, type PlayerData } from "../player.js";
import type { MatchResult } from "../match.js";
import { createRNG } from "../rng.js";

function makePlayer(
  id: string,
  role: "batsman" | "bowler" | "all-rounder",
  options: { isWicketKeeper?: boolean; bowlingStyle?: PlayerData["bowlingStyle"]; battingHand?: PlayerData["battingHand"] } = {},
): Player {
  const batHeavy = role === "batsman";
  const bowlHeavy = role === "bowler";
  return new Player({
    id,
    name: `Player ${id}`,
    age: 25,
    country: "India",
    role,
    ratings: {
      battingIQ: batHeavy ? 70 : bowlHeavy ? 25 : 55,
      timing: batHeavy ? 68 : bowlHeavy ? 25 : 50,
      power: batHeavy ? 65 : bowlHeavy ? 20 : 50,
      running: batHeavy ? 60 : 40,
      wicketTaking: bowlHeavy ? 70 : batHeavy ? 20 : 55,
      economy: bowlHeavy ? 68 : batHeavy ? 20 : 55,
      accuracy: bowlHeavy ? 65 : batHeavy ? 20 : 50,
      clutch: 55,
    },
    isInternational: false,
    isWicketKeeper: options.isWicketKeeper ?? false,
    bowlingStyle: options.bowlingStyle,
    battingHand: options.battingHand ?? "right",
    injured: false,
    injuryGamesLeft: 0,
  });
}

const STYLES = ["off-spin", "leg-spin", "left-arm-orthodox", "right-arm-fast"] as const;

/** A team with four specialist bowlers (three spin, one pace) and spinning all-rounders. */
export function buildFixtureTeam(configIdx: number): Team {
  const team = new Team({ ...IPL_TEAMS[configIdx] });
  let id = (configIdx + 1) * 1000;
  for (let i = 0; i < 4; i++) team.addPlayer(makePlayer(`bat_${++id}`, "batsman"), 5);
  team.addPlayer(makePlayer(`wk_${++id}`, "batsman", { isWicketKeeper: true }), 5);
  for (let i = 0; i < 3; i++) team.addPlayer(makePlayer(`ar_${++id}`, "all-rounder", { bowlingStyle: "off-spin" }), 5);
  for (let i = 0; i < 4; i++) team.addPlayer(makePlayer(`bow_${++id}`, "bowler", { bowlingStyle: STYLES[i] }), 5);
  return team;
}

/** CSK (home ground "chepauk") and MI. */
export function chennaiVsMumbai(): { home: Team; away: Team } {
  const csk = IPL_TEAMS.findIndex(t => t.id === "csk");
  const mi = IPL_TEAMS.findIndex(t => t.id === "mi");
  return { home: buildFixtureTeam(csk), away: buildFixtureTeam(mi) };
}

/**
 * Run `fn` with Math.random replaced by a seeded stream. Player construction (form, morale) and
 * parts of the live engine still read Math.random, so whole-match digests need this to be stable.
 */
export function withSeededRandom<T>(seed: number, fn: () => T): T {
  const original = Math.random;
  Math.random = createRNG(seed);
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

/** FNV-1a over the ball-by-ball outcomes of both innings: a compact digest of an entire simulation. */
export function digestOutcomes(outcomes: string[]): string {
  let h = 0x811c9dc5;
  for (const o of outcomes.join("|")) {
    h ^= o.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

export function digestMatch(r: MatchResult): string {
  const balls = [...r.innings[0].ballLog, ...r.innings[1].ballLog, ...(r.superOver?.flatMap(i => i.ballLog) ?? [])].map(b => `${b.bowler}:${b.batter}:${b.outcome}`);
  return `${r.innings[0].runs}/${r.innings[0].wickets}-${r.innings[1].runs}/${r.innings[1].wickets}-${digestOutcomes(balls)}-${r.winnerId}-${r.margin}`;
}

/** Digest of live-match ball events.. */
export function digestLive(balls: { eventType: string; batterName: string; bowlerName: string; runs: number }[]): string {
  return digestOutcomes(balls.map(b => `${b.bowlerName}:${b.batterName}:${b.eventType}:${b.runs}`));
}
