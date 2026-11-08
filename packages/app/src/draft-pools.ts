/**
 * Player pools and helpers shared by the season draft and Draft Match
 * (single-player and multiplayer).
 */

import {
  type Player, type RuleSet, type DraftConfig, type DraftPlayer, type TeamConfig,
  type MatchState, type DetailedMatchResult,
  Player as PlayerClass, Team, IPL_TEAMS, WPL_TEAMS, RULE_PRESETS, EXTRA_LEAGUES, isOverseasIn, isWomenLeague,
  type ExtraLeagueId,
  createPlayerFromData, generatePlayerPool, toDraftPlayer, isDraftBowlingOption,
  createMatchState, simulateRemaining, buildDetailedResultFromState, odiRules,
} from "@ipl-sim/engine";
import { attachFormatRatings, type FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import { getRealPlayers, getPoolPlayers } from "@ipl-sim/ratings/dist/real-players.js";
import { getWPLPlayers } from "@ipl-sim/ratings/dist/wpl-players.js";
import { getLeaguePlayers } from "@ipl-sim/ratings/dist/league-players.js";

// ── Season draft ────────────────────────────────────────────────────────

export function seasonDraftConfig(rules: RuleSet, seed: number, careerMode = true): DraftConfig {
  const women = isWomenLeague(rules);
  const rounds = Math.min(rules.maxSquadSize, women ? 15 : 18);
  return {
    type: rules.draftType ?? "snake",
    rounds,
    maxOverseas: rules.maxOverseasInSquad,
    maxOverseasInXI: rules.maxOverseasInXI,
    minWicketKeepers: 2,
    minBowlingOptions: women ? 6 : 7,
    pickSeconds: rules.draftPickSeconds ?? 45,
    careerMode,
    seed,
  };
}

/** Contract price for a drafted player, by round (keeps every squad well under the salary cap). */
export function draftRoundPrice(round: number, salaryCap: number): number {
  const top = salaryCap * 0.12;
  return Math.max(0.2, Math.round(top * Math.pow(0.82, round - 1) * 100) / 100);
}

// ── Draft Match pools ───────────────────────────────────────────────────

/** `league:<id>`: the current squads of one of the extra leagues (BBL, PSL, The Hundred, ...) */
export type LeagueDraftPoolId = `league:${ExtraLeagueId}`;
export type DraftMatchPoolId = "ipl-current" | "wpl-current" | "top-stars" | "nations" | "full" | LeagueDraftPoolId;

export const DRAFT_MATCH_POOLS: { id: DraftMatchPoolId; label: string; desc: string }[] = [
  { id: "ipl-current", label: "IPL 2026 squads", desc: "Everyone on a current IPL roster. 4 overseas max per XI." },
  { id: "top-stars", label: "Top 150 stars", desc: "The 150 highest-rated men's T20 players in the database." },
  { id: "nations", label: "Nation vs nation", desc: "Two countries' players in one pool." },
  { id: "wpl-current", label: "WPL squads", desc: "Everyone on a current WPL roster. 5 overseas max per XI." },
  { id: "full", label: "Full database", desc: "The top 500 men's players from the whole database." },
  ...EXTRA_LEAGUES.map(l => ({
    id: `league:${l.id}` as LeagueDraftPoolId,
    label: `${l.short} ${l.season} squads`,
    desc: `Everyone on a current ${l.name} roster. ${l.rules.maxOverseasInXI} overseas max per XI.`,
  })),
];

/** The extra league a Draft Match pool is drawn from, if any */
export function draftPoolLeague(id: DraftMatchPoolId) {
  return id.startsWith("league:") ? EXTRA_LEAGUES.find(l => `league:${l.id}` === id) : undefined;
}

function realMen(): Player[] {
  try {
    return [...getRealPlayers(), ...getPoolPlayers()].map(d => createPlayerFromData(d));
  } catch {
    return [];
  }
}

function dedupeByName(players: Player[]): Player[] {
  const seen = new Set<string>();
  return players.filter(p => {
    const key = `${p.name}|${p.country}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Countries with enough players for a nation-vs-nation pool (an XI's worth, a keeper, 5 bowlers). */
export function draftMatchCountries(): { country: string; players: number }[] {
  const byCountry = new Map<string, Player[]>();
  for (const p of dedupeByName(realMen())) {
    const list = byCountry.get(p.country) ?? [];
    list.push(p);
    byCountry.set(p.country, list);
  }
  return [...byCountry.entries()]
    .filter(([, list]) => list.length >= 15 && list.some(p => p.isWicketKeeper) && list.filter(p => !p.isWicketKeeper && (p.role === "bowler" || p.role === "all-rounder")).length >= 6)
    .map(([country, list]) => ({ country, players: list.length }))
    .sort((a, b) => b.players - a.players);
}

export interface DraftMatchPoolResult {
  players: Player[];
  /** Overseas cap per XI (undefined = none) */
  maxOverseasInXI?: number;
  label: string;
}

/** Build the shared pool for a Draft Match. Falls back to generated players if real data is missing. */
export function buildDraftMatchPool(id: DraftMatchPoolId, nations?: [string, string]): DraftMatchPoolResult {
  let players: Player[] = [];
  let maxOverseasInXI: number | undefined;
  let label = DRAFT_MATCH_POOLS.find(p => p.id === id)?.label ?? id;

  const league = draftPoolLeague(id);
  if (league) {
    try {
      players = getLeaguePlayers(league.id).map(d => {
        const p = createPlayerFromData(d);
        p.isInternational = isOverseasIn(league.id, d.country);
        return p;
      });
    } catch { players = []; }
    maxOverseasInXI = league.rules.maxOverseasInXI;
  } else if (id === "ipl-current") {
    try { players = getRealPlayers().map(d => createPlayerFromData(d)); } catch { players = []; }
    maxOverseasInXI = 4;
  } else if (id === "wpl-current") {
    try { players = getWPLPlayers().map(d => createPlayerFromData(d)); } catch { players = []; }
    maxOverseasInXI = 5;
  } else if (id === "top-stars") {
    players = dedupeByName(realMen()).sort((a, b) => b.overall - a.overall).slice(0, 150);
  } else if (id === "nations") {
    const [a, b] = nations ?? ["India", "Australia"];
    players = dedupeByName(realMen()).filter(p => p.country === a || p.country === b);
    label = `${a} vs ${b}`;
  } else {
    players = dedupeByName(realMen()).sort((a, b) => b.overall - a.overall).slice(0, 500);
  }

  if (players.length < 40) {
    players = generatePlayerPool(80);
    label = `${label} (generated players)`;
  }
  return { players: dedupeByName(players), maxOverseasInXI, label };
}

/**
 * Make sure a pool can give every side a keeper and five bowling options (plus spares):
 * thin pools (a small nation pair, generated fallbacks) are topped up with generated players.
 */
export function ensurePoolCoverage(players: Player[], sides: number, maxOverseasInXI = 11): Player[] {
  const out = [...players];
  const wk = () => out.filter(p => p.isWicketKeeper).length;
  const bowl = () => out.filter(p => !p.isWicketKeeper && (p.role === "bowler" || p.role === "all-rounder")).length;
  // With an overseas cap in the XI a side may need its keeper and bowlers to be domestic, so cover those too
  const capped = maxOverseasInXI < 11;
  const domWk = () => out.filter(p => p.isWicketKeeper && !p.isInternational).length;
  const domBowl = () => out.filter(p => !p.isInternational && !p.isWicketKeeper && (p.role === "bowler" || p.role === "all-rounder")).length;
  let guard = 40;
  while ((wk() < sides * 2 || bowl() < sides * 7 || out.length < sides * 16
    || (capped && (domWk() < sides * 2 || domBowl() < sides * 5))) && guard-- > 0) {
    for (const p of generatePlayerPool(20)) {
      const needWK = wk() < sides * 2;
      const needBowl = bowl() < sides * 7;
      const isBowl = !p.isWicketKeeper && (p.role === "bowler" || p.role === "all-rounder");
      const needDomWK = capped && domWk() < sides * 2 && p.isWicketKeeper && !p.isInternational;
      const needDomBowl = capped && domBowl() < sides * 5 && isBowl && !p.isInternational;
      if ((needWK && p.isWicketKeeper) || (needBowl && isBowl) || needDomWK || needDomBowl || out.length < sides * 16) out.push(p);
    }
  }
  return out;
}

// ── Draft Match: lineups, venue and the match itself ────────────────────

export interface DraftMatchLineup {
  battingOrder: string[];
  captainId: string;
}

/** AI lineup: engine's auto batting order; captain = highest-rated player. */
export function autoLineup(players: DraftPlayer[]): DraftMatchLineup {
  const order = [...players].sort((a, b) => {
    if (a.isWicketKeeper && !b.isWicketKeeper && a.battingOvr >= 60) return -1;
    if (b.isWicketKeeper && !a.isWicketKeeper && b.battingOvr >= 60) return 1;
    const aB = a.role === "bowler", bB = b.role === "bowler";
    if (aB && !bB) return 1;
    if (bB && !aB) return -1;
    return b.battingOvr - a.battingOvr;
  });
  const captain = [...players].sort((a, b) => b.overall - a.overall)[0];
  return { battingOrder: order.map(p => p.id), captainId: captain?.id ?? "" };
}

const ALL_FRANCHISES = (): TeamConfig[] => [...IPL_TEAMS, ...WPL_TEAMS, ...EXTRA_LEAGUES.flatMap(l => l.teams)];

/** Grounds available for a Draft Match: every franchise home ground in the game (IPL, WPL, then the extra leagues). */
export function draftMatchVenues(): { teamId: string; stadiumName: string; city: string }[] {
  return ALL_FRANCHISES()
    .filter(c => c.stadiumName)
    .filter((c, i, all) => all.findIndex(x => x.stadiumName === c.stadiumName) === i)
    .map(c => ({ teamId: c.id, stadiumName: c.stadiumName!, city: c.city }));
}

const isWplGround = (teamId: string) => /-w$|^upw$/.test(teamId);

/** Grounds a random Draft Match venue is drawn from: the pool's league (WPL for the WPL pool, IPL grounds otherwise). */
export function draftPoolVenues(id: DraftMatchPoolId): { teamId: string; stadiumName: string; city: string }[] {
  const all = draftMatchVenues();
  const league = draftPoolLeague(id);
  if (league) {
    const ids = new Set(league.teams.map(t => t.id));
    const own = all.filter(v => ids.has(v.teamId));
    // a ground shared with another league keeps the first franchise's id; match by name too
    const names = new Set(league.teams.map(t => t.stadiumName));
    return own.length ? own : all.filter(v => names.has(v.stadiumName));
  }
  const ipl = new Set(IPL_TEAMS.map(t => t.id));
  return all.filter(v => (id === "wpl-current" ? isWplGround(v.teamId) : ipl.has(v.teamId)));
}

const SIDE_COLORS: [string, string][] = [
  ["#f97316", "#1f2937"], ["#2563eb", "#f8fafc"], ["#16a34a", "#111827"], ["#9333ea", "#f5f3ff"],
];

export interface DraftMatchSide {
  id: string;
  name: string;
  shortName: string;
}

/** Build a playable Team for one side. Venue fields come from the chosen ground's franchise config. */
export function buildDraftMatchTeam(
  side: DraftMatchSide,
  sideIndex: number,
  players: Player[],
  lineup: DraftMatchLineup,
  venueTeamId: string | null,
  /**
   * Use this lineup as an explicit, user-controlled XI. Set false for a CPU side when a human is
   * playing the match (the engine treats user-controlled teams as decision-makers).
   */
  explicitLineup = true,
): Team {
  const venue = ALL_FRANCHISES().find(c => c.id === venueTeamId);
  const [primaryColor, secondaryColor] = SIDE_COLORS[sideIndex % SIDE_COLORS.length];
  const config: TeamConfig = {
    id: side.id,
    name: side.name,
    shortName: side.shortName,
    city: venue?.city ?? "Neutral",
    primaryColor,
    secondaryColor,
    stadiumBowlingRating: venue?.stadiumBowlingRating,
    stadiumName: venue?.stadiumName,
    pitchType: venue?.pitchType,
    boundarySize: venue?.boundarySize,
    dewFactor: venue?.dewFactor,
    // Measured conditions (run/six/wicket factors, pace-vs-spin edges, chase edge) for that ground
    venueTeamId: venue?.id,
  };
  const team = new Team(config, 999);
  for (const p of players) {
    const copy = PlayerClass.fromJSON(p.toJSON());
    copy.injured = false;
    copy.injuryGamesLeft = 0;
    copy.fatigue = 0;
    team.addPlayer(copy, 0);
  }
  // The roster is exactly the drafted XI, so auto-selection picks the same 11 either way;
  // an explicit lineup also fixes the batting order.
  if (explicitLineup) {
    team.isUserControlled = true;
    team.userPlayingXI = team.roster.map(p => p.id);
    team.userBattingOrder = lineup.battingOrder.filter(id => team.roster.some(p => p.id === id));
  }
  return team;
}

export type DraftMatchFormat = "t20" | "odi";

export function draftMatchRules(maxOverseasInXI?: number, format: DraftMatchFormat = "t20", women = false): RuleSet {
  if (format === "odi") {
    return { ...odiRules(women ? "women" : "men"), name: "Draft Match ODI", injuriesEnabled: false, maxOverseasInXI: maxOverseasInXI ?? 11 };
  }
  return {
    ...RULE_PRESETS.modern2026,
    name: "Draft Match",
    impactPlayer: false,
    injuriesEnabled: false,
    maxOverseasInXI: maxOverseasInXI ?? 11,
  };
}

/** A women's pool (WPL, the women's leagues): its ODI plays on the women's ODI model */
export function draftPoolIsWomen(id: DraftMatchPoolId): boolean {
  return id === "wpl-current" || draftPoolLeague(id)?.gender === "women";
}

/**
 * The pool as an ODI pool: each player on his ODI ratings (`ratings` becomes the ODI set, so the draft board, lineups and
 * the match all read it). Players without an ODI set keep their T20 ratings. `file` = the format ratings file.
 */
export function toOdiPool(players: Player[], file: FormatRatingsFile | null): Player[] {
  attachFormatRatings(players, file);
  for (const p of players) {
    const set = p.formatRatings?.odi;
    if (set) p.ratings = { ...set.ratings };
  }
  return players;
}

export interface DraftMatchResultSummary {
  winnerSideId: string | null;
  result: string;
  homeSideId: string;
  awaySideId: string;
  innings1: DetailedMatchResult["innings1"];
  innings2: DetailedMatchResult["innings2"];
  manOfTheMatch: DetailedMatchResult["manOfTheMatch"];
  venue: string;
  tossWinnerName: string;
  tossDecision: "bat" | "bowl";
}

export function summarizeMatch(state: MatchState): DraftMatchResultSummary {
  const d = buildDetailedResultFromState(state);
  return {
    winnerSideId: state.winnerId ?? null,
    result: d.result,
    homeSideId: d.homeTeamId,
    awaySideId: d.awayTeamId,
    innings1: d.innings1,
    innings2: d.innings2,
    manOfTheMatch: d.manOfTheMatch,
    venue: d.venue,
    tossWinnerName: d.tossWinnerName,
    tossDecision: d.tossDecision,
  };
}

/** Run a whole match with no user decisions (official result for multiplayer, or quick sim). */
export function simulateDraftMatch(home: Team, away: Team, rules: RuleSet, seed: number): { state: MatchState; summary: DraftMatchResultSummary } {
  const start = createMatchState(home, away, rules, null, seed);
  const { state } = simulateRemaining(start);
  return { state, summary: summarizeMatch(state) };
}

/** Plain-text result card for sharing (clipboard / chat). */
export function shareableResult(opts: {
  sides: { id: string; name: string; xi: string[]; captain?: string }[];
  summary: DraftMatchResultSummary;
  series?: string;
}): string {
  const { summary } = opts;
  const lines: string[] = [];
  lines.push(`🏏 Draft Match — ${summary.venue}`);
  if (opts.series) lines.push(opts.series);
  for (const inn of [summary.innings1, summary.innings2]) {
    lines.push(`${inn.battingTeamName}: ${inn.totalRuns}/${inn.totalWickets} (${inn.totalOvers})`);
    const top = [...inn.batters].sort((a, b) => b.runs - a.runs).slice(0, 2)
      .map(b => `${b.playerName} ${b.runs}${b.howOut === "not out" ? "*" : ""} (${b.balls})`);
    const bowl = [...inn.bowlers].sort((a, b) => b.wickets - a.wickets || a.runs - b.runs).slice(0, 2)
      .map(b => `${b.playerName} ${b.wickets}/${b.runs}`);
    lines.push(`  ${top.join(", ")}  |  ${bowl.join(", ")}`);
  }
  lines.push(summary.result);
  lines.push(`Player of the match: ${summary.manOfTheMatch.playerName}`);
  for (const side of opts.sides) {
    lines.push("");
    lines.push(`${side.name} XI: ${side.xi.map(n => (n === side.captain ? `${n} (c)` : n)).join(", ")}`);
  }
  return lines.join("\n");
}

/** Checks for a Draft Match XI (keeper, 5 bowling options, overseas cap). */
export function draftMatchXIProblems(players: DraftPlayer[], maxOverseasInXI?: number): string[] {
  const issues: string[] = [];
  if (players.length !== 11) issues.push(`${players.length}/11 players`);
  if (!players.some(p => p.isWicketKeeper)) issues.push("No wicket-keeper");
  const bowl = players.filter(isDraftBowlingOption).length;
  if (bowl < 5) issues.push(`${bowl}/5 bowling options`);
  if (maxOverseasInXI !== undefined) {
    const os = players.filter(p => p.isInternational).length;
    if (os > maxOverseasInXI) issues.push(`${os} overseas (max ${maxOverseasInXI})`);
  }
  return issues;
}
