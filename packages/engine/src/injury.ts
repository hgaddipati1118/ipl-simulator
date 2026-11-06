/**
 * Injury system for the IPL simulator.
 * Handles injury checks after matches, healing, and availability tracking.
 *
 * Rates come from the injury analysis (docs/INJURY-RISK-REPORT.md, data in injury-data.ts):
 * per-match chance by player type and age band, x previous-injury, gender and format multipliers.
 * The measured rates are absences (confirmed + likely injuries, which still include some rest and
 * rotation), so they are scaled by INJURY_SCALE to real injuries: calibrated with
 * benchmark-season.ts so that the share of IPL squad-seasons with an injury of 3+ matches matches
 * the share of IPL squad-seasons that end in an injury replacement (5.3%, 192 of 3,633).
 */

import { Player } from "./player.js";
import { Team } from "./team.js";
import { INJURY_DATA } from "./injury-data.js";

export type InjurySeverity = "minor" | "moderate" | "severe";

export interface InjuryStatus {
  isInjured: boolean;
  injuryType: string;
  matchesRemaining: number;
  severity: InjurySeverity;
}

export type InjuryArchetype = keyof typeof INJURY_DATA.base;

export interface InjuryCheckOptions {
  /** Women's cricket: measured absence rate is 0.58x the men's */
  gender?: "men" | "women" | "combined";
  /** Match format multiplier (only T20 is played in the game today) */
  format?: "T20" | "ODI/List A" | "Test/FC";
}

/** Possible injury types */
const INJURY_TYPES = [
  "hamstring",
  "shoulder",
  "back",
  "finger",
  "ankle",
  "side strain",
];

/**
 * Measured absences -> real injuries. The absence data's confirmed-only floor is 0.039x and the
 * full confirmed + likely count is 1.0x; the IPL replacement anchor puts real injuries at this
 * share. See benchmark-season.ts for the check.
 */
export const INJURY_SCALE = 0.385;

/** Fatigue above this adds risk (a game-design choice; scorecard data can't measure workload) */
const FATIGUE_THRESHOLD = 55;
/** At fatigue 100 the per-match chance is this much higher */
const MAX_FATIGUE_UPLIFT = 0.5;

/** Severity buckets for the measured 1-2 / 3-5 / 6+ match durations */
const SEVERITY_BUCKETS: { severity: InjurySeverity; key: "1-2" | "3-5" | "6+"; minMatches: number; maxMatches: number }[] = [
  { severity: "minor", key: "1-2", minMatches: 1, maxMatches: 2 },
  { severity: "moderate", key: "3-5", minMatches: 3, maxMatches: 5 },
  { severity: "severe", key: "6+", minMatches: 6, maxMatches: 10 },
];

/** Map a game player to the injury analysis's player types. */
export function getInjuryArchetype(player: Pick<Player, "role" | "isWicketKeeper" | "bowlingStyle" | "battingOvr" | "bowlingOvr">): InjuryArchetype {
  if (player.isWicketKeeper) return "wicketkeeper";
  if (player.role === "batsman" || player.role === "wicket-keeper") return "batter";
  if (player.role === "all-rounder") {
    return player.battingOvr >= player.bowlingOvr ? "batting all-rounder" : "bowling all-rounder";
  }
  const style = player.bowlingStyle ?? "unknown";
  if (style === "off-spin" || style === "left-arm-orthodox") return "finger spin";
  if (style === "leg-spin" || style === "left-arm-wrist-spin") return "wrist spin";
  // Express and fast-medium can't be told apart in the data (both 1.8x batters): one pace group
  if (style.includes("fast")) return "pace";
  return "medium";
}

function ageBand(age: number): (typeof INJURY_DATA.bands)[number] {
  if (age <= 22) return "<=22";
  if (age <= 26) return "23-26";
  if (age <= 30) return "27-30";
  if (age <= 33) return "31-33";
  return "34+";
}

/** Injuries in the current and previous season (the analysis looks back two years). */
export function recentInjuryCount(player: Pick<Player, "injuryHistory">): number {
  const h = player.injuryHistory ?? [];
  return (h[0] ?? 0) + (h[1] ?? 0);
}

/** Per-match injury chance for a player in the playing XI. */
export function getInjuryChance(player: Player, options: InjuryCheckOptions = {}): number {
  const type = getInjuryArchetype(player);
  const base = INJURY_DATA.base[type][ageBand(player.age)];
  const tilt = INJURY_DATA.tilt[type] ?? 1;
  const prior = recentInjuryCount(player);
  const priorMult = prior >= 2 ? INJURY_DATA.previousInjury["2+"] : prior === 1 ? INJURY_DATA.previousInjury["1"] : 1;
  const genderMult = options.gender === "women" ? INJURY_DATA.women : 1;
  const formatMult = INJURY_DATA.format[options.format ?? "T20"] ?? 1;
  let chance = INJURY_SCALE * base * tilt * priorMult * genderMult * formatMult;

  // Heavy workload adds risk; it never lowers it (the data's "protective" workload is selection)
  if (player.fatigue > FATIGUE_THRESHOLD) {
    chance *= 1 + ((player.fatigue - FATIGUE_THRESHOLD) / (100 - FATIGUE_THRESHOLD)) * MAX_FATIGUE_UPLIFT;
  }
  return chance;
}

function durationGroup(type: InjuryArchetype): "pace" | "spin" | "other" {
  if (type === "pace" || type === "medium") return "pace";
  if (type === "finger spin" || type === "wrist spin") return "spin";
  return "other";
}

/**
 * Roll an injury check for a player after a match.
 * Returns an InjuryStatus if the player gets injured, or null if not.
 */
export function checkForInjury(player: Player, options: InjuryCheckOptions = {}): InjuryStatus | null {
  if (player.injured) return null; // already injured

  const chance = getInjuryChance(player, options);
  if (Math.random() >= chance) return null;

  // Player is injured: how long for (measured split by player type group)
  const split = INJURY_DATA.duration[durationGroup(getInjuryArchetype(player))];
  const sevRoll = Math.random();
  let cumulative = 0;
  let bucket = SEVERITY_BUCKETS[0];
  for (const b of SEVERITY_BUCKETS) {
    cumulative += split[b.key];
    bucket = b;
    if (sevRoll <= cumulative) break;
  }

  const matchesRemaining = bucket.minMatches + Math.floor(Math.random() * (bucket.maxMatches - bucket.minMatches + 1));
  const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];

  return {
    isInjured: true,
    injuryType,
    matchesRemaining,
    severity: bucket.severity,
  };
}

/**
 * Apply injury to a player from an InjuryStatus.
 */
export function applyInjury(player: Player, injury: InjuryStatus): void {
  player.injured = true;
  player.injuryGamesLeft = injury.matchesRemaining;
  player.injuryType = injury.injuryType;
  player.injurySeverity = injury.severity;
  const history = player.injuryHistory ?? [];
  history[0] = (history[0] ?? 0) + 1;
  player.injuryHistory = history;
}

/**
 * Run injury checks for all players in a playing XI after a match.
 * Returns an array of newly injured players with their injury details.
 * If injuriesEnabled is false, skips all checks and returns empty array.
 */
export function runPostMatchInjuryChecks(
  playingXI: Player[],
  injuriesEnabled = true,
  options: InjuryCheckOptions = {},
): { player: Player; injury: InjuryStatus }[] {
  if (!injuriesEnabled) return [];

  const newInjuries: { player: Player; injury: InjuryStatus }[] = [];

  for (const player of playingXI) {
    const injury = checkForInjury(player, options);
    if (injury) {
      applyInjury(player, injury);
      newInjuries.push({ player, injury });
    }
  }

  return newInjuries;
}

/**
 * Heal injuries for a team that has just played (one of its matches has passed).
 * Decrements matchesRemaining by 1 and clears injury status when it reaches 0.
 * Players injured in the match just played are skipped, so an injury of N matches
 * keeps the player out of the team's next N matches.
 */
export function healInjuries(team: Team, skipPlayerIds?: ReadonlySet<string>): Player[] {
  const healed: Player[] = [];

  for (const player of team.roster) {
    if (player.injured) {
      if (skipPlayerIds?.has(player.id)) continue;
      player.injuryGamesLeft--;
      if (player.injuryGamesLeft <= 0) {
        player.injured = false;
        player.injuryGamesLeft = 0;
        player.injuryType = undefined;
        player.injurySeverity = undefined;
        healed.push(player);
      }
    }
  }

  return healed;
}

/** Season rollover: this season's injury count becomes last season's. */
export function rollInjuryHistory(player: Player): void {
  const h = player.injuryHistory ?? [];
  player.injuryHistory = [0, h[0] ?? 0];
}

/**
 * Get all available (non-injured) players from a team's roster.
 */
export function getAvailablePlayers(team: Team): Player[] {
  return team.roster.filter(p => !p.injured);
}

/**
 * Check if any players in a proposed playing XI are injured.
 * Returns the list of injured players found in the XI.
 */
export function getInjuredPlayersInXI(playingXI: Player[]): Player[] {
  return playingXI.filter(p => p.injured);
}

/**
 * Get the injury summary for a team (for UI display).
 */
export function getTeamInjuryReport(team: Team): { player: Player; matchesLeft: number; type: string; severity: InjurySeverity }[] {
  return team.roster
    .filter(p => p.injured)
    .map(p => ({
      player: p,
      matchesLeft: p.injuryGamesLeft,
      type: p.injuryType ?? "unknown",
      severity: (p.injurySeverity ?? "minor") as InjurySeverity,
    }));
}
