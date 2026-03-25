/**
 * Player morale system — FM-style dressing room dynamics.
 *
 * Morale (0-100, default 70) affects clutch performance and player satisfaction.
 * Updates after each match based on results, selection, and team momentum.
 */

import { clamp } from "./math.js";
import type { Player } from "./player.js";
import type { Team } from "./team.js";

/** Apply morale changes after a match result for a team */
export function updateTeamMorale(
  team: Team,
  params: {
    won: boolean;
    marginText: string; // e.g. "87 runs", "8 wickets"
    motmPlayerId?: string;
    playingXIIds: Set<string>;
    consecutiveWins: number;
    consecutiveLosses: number;
  },
): void {
  const { won, marginText, motmPlayerId, playingXIIds, consecutiveWins, consecutiveLosses } = params;
  const isBigMargin = isBigLoss(marginText);

  for (const player of team.roster) {
    let delta = 0;
    const inXI = playingXIIds.has(player.id);

    if (won) {
      delta += 3; // base win bonus
      if (player.id === motmPlayerId) delta += 5; // MoM bonus
    } else {
      delta -= 2; // base loss penalty
      if (isBigMargin) delta -= 5; // big margin penalty
    }

    // Selection effects
    if (inXI) {
      delta += 1; // selected
    } else if (!player.injured) {
      delta -= 5; // dropped (not injured, just not selected)
    }

    // Streak effects
    if (consecutiveWins >= 3) delta += 5;
    if (consecutiveLosses >= 3) delta -= 8;

    player.morale = clamp(player.morale + delta, 0, 100);
  }
}

/** Get morale modifier for match probability adjustments (±3% range) */
export function getMoraleModifier(player: Player): number {
  if (player.morale > 80) return 1.03;
  if (player.morale > 60) return 1.01;
  if (player.morale < 30) return 0.93;
  if (player.morale < 40) return 0.97;
  return 1.0; // neutral zone (40-60)
}

/** Get clutch rating modifier from morale */
export function getClutchMoraleModifier(player: Player): number {
  if (player.morale > 80) return 1.05;
  if (player.morale < 40) return 0.90;
  return 1.0;
}

/** Apply season-start morale resets */
export function initSeasonMorale(team: Team, retainedPlayerIds: Set<string>): void {
  for (const player of team.roster) {
    if (retainedPlayerIds.has(player.id)) {
      // Retained players feel valued
      player.morale = clamp(player.morale + 10, 0, 100);
    } else {
      // New signings start cautious
      player.morale = 65;
    }
  }
}

/** Get morale label for UI display */
export function getMoraleLabel(morale: number): { label: string; color: "green" | "yellow" | "red" } {
  if (morale >= 70) return { label: "Happy", color: "green" };
  if (morale >= 40) return { label: "Content", color: "yellow" };
  return { label: "Unhappy", color: "red" };
}

/** Get IDs of players who might request a trade due to low morale */
export function getDisgruntledPlayers(team: Team): Player[] {
  return team.roster.filter(p => p.morale < 30 && !p.injured);
}

/** Calculate the team's consecutive wins from recent match history */
export function getConsecutiveResults(
  results: Array<{ winnerId: string | null; homeTeamId: string; awayTeamId: string }>,
  teamId: string,
): { consecutiveWins: number; consecutiveLosses: number } {
  let consecutiveWins = 0;
  let consecutiveLosses = 0;

  // Walk backwards through results
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i];
    if (r.homeTeamId !== teamId && r.awayTeamId !== teamId) continue;

    const won = r.winnerId === teamId;
    const lost = r.winnerId !== null && r.winnerId !== teamId;

    if (consecutiveWins === 0 && consecutiveLosses === 0) {
      // First relevant result
      if (won) consecutiveWins = 1;
      else if (lost) consecutiveLosses = 1;
    } else if (consecutiveWins > 0 && won) {
      consecutiveWins++;
    } else if (consecutiveLosses > 0 && lost) {
      consecutiveLosses++;
    } else {
      break; // streak ended
    }
  }

  return { consecutiveWins, consecutiveLosses };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function isBigLoss(marginText: string): boolean {
  // "87 runs" → big if > 50 runs
  // "8 wickets" → big if >= 7 wickets remaining
  const runsMatch = marginText.match(/(\d+)\s+runs?/i);
  if (runsMatch && parseInt(runsMatch[1]) > 50) return true;

  const wicketsMatch = marginText.match(/(\d+)\s+wickets?/i);
  if (wicketsMatch && parseInt(wicketsMatch[1]) >= 7) return true;

  return false;
}
