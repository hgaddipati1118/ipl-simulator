/**
 * Board expectations system — FM-style management pressure.
 *
 * The board sets objectives at season start based on team strength and history.
 * Meeting or failing objectives affects satisfaction, budget, and job security.
 */

import { clamp } from "./math.js";

export type BoardObjectiveType =
  | "playoff"
  | "title"
  | "top_4"
  | "develop_youth"
  | "improve_nrr";

export interface BoardObjective {
  type: BoardObjectiveType;
  description: string;
  count?: number; // for develop_youth: number of young players needing 5+ matches
}

export interface BoardState {
  objectives: BoardObjective[];
  satisfaction: number; // 0-100, starts at 50
  budgetModifier: number; // multiplier for next season's salary cap (0.9 to 1.1)
  warnings: number; // 0-3, fired at 3
  message?: string; // "Board is pleased with your progress"
}

/** Generate board objectives based on team context */
export function generateBoardObjectives(params: {
  seasonNumber: number;
  previousPosition?: number;
  teamPower: number;
}): BoardObjective[] {
  const { seasonNumber, previousPosition, teamPower } = params;
  const objectives: BoardObjective[] = [];

  // Primary competitive objective based on team strength
  if (teamPower >= 85) {
    objectives.push({ type: "title", description: "Win the championship" });
  } else if (teamPower >= 80) {
    objectives.push({ type: "top_4", description: "Finish in top 4" });
  } else if (teamPower >= 73) {
    objectives.push({ type: "playoff", description: "Qualify for playoffs" });
  } else {
    // Weaker teams: stay competitive
    objectives.push({ type: "playoff", description: "Qualify for playoffs" });
  }

  // Season 1 override: reasonable expectations
  if (seasonNumber === 1 && teamPower < 82) {
    objectives[0] = { type: "playoff", description: "Qualify for playoffs" };
  }

  // Development objective (always include one)
  const youthCount = teamPower >= 82 ? 1 : 2;
  objectives.push({
    type: "develop_youth",
    count: youthCount,
    description: `Give ${youthCount} young player${youthCount > 1 ? "s" : ""} 5+ matches`,
  });

  // NRR improvement if coming off a poor previous season
  if (previousPosition !== undefined && previousPosition > 6) {
    objectives.push({ type: "improve_nrr", description: "Improve net run rate from last season" });
  }

  return objectives;
}

/** Evaluate board objectives at season end */
export function evaluateBoardObjectives(params: {
  objectives: BoardObjective[];
  finalPosition: number;
  isChampion: boolean;
  youthMatchesGiven: number; // number of U23 players with 5+ matches
  currentNRR: number;
  previousNRR?: number;
  totalTeams: number;
}): { satisfaction: number; budgetModifier: number; message: string; metCount: number; totalCount: number } {
  const {
    objectives, finalPosition, isChampion, youthMatchesGiven,
    currentNRR, previousNRR, totalTeams,
  } = params;

  let metCount = 0;
  const totalCount = objectives.length;
  const playoffCutoff = Math.min(4, Math.floor(totalTeams / 2));

  for (const obj of objectives) {
    switch (obj.type) {
      case "title":
        if (isChampion) metCount++;
        break;
      case "top_4":
        if (finalPosition <= 4) metCount++;
        break;
      case "playoff":
        if (finalPosition <= playoffCutoff) metCount++;
        break;
      case "develop_youth":
        if (youthMatchesGiven >= (obj.count ?? 2)) metCount++;
        break;
      case "improve_nrr":
        if (previousNRR !== undefined && currentNRR > previousNRR) metCount++;
        break;
    }
  }

  const ratio = totalCount > 0 ? metCount / totalCount : 0.5;

  let satisfaction: number;
  let budgetModifier: number;
  let message: string;

  if (ratio >= 1.0) {
    satisfaction = 10;
    budgetModifier = 1.08;
    message = "The board is delighted. Every objective has been met. Excellent work.";
  } else if (ratio >= 0.75) {
    satisfaction = 6;
    budgetModifier = 1.05;
    message = "The board is pleased with this season's performance.";
  } else if (ratio >= 0.5) {
    satisfaction = 0;
    budgetModifier = 1.0;
    message = "A mixed season. The board expects better next time.";
  } else if (ratio >= 0.25) {
    satisfaction = -10;
    budgetModifier = 0.95;
    message = "The board is disappointed. Significant improvement is expected.";
  } else {
    satisfaction = -20;
    budgetModifier = 0.92;
    message = "A dismal season. The board is losing patience.";
  }

  // Champion bonus always positive regardless of other objectives
  if (isChampion) {
    satisfaction = Math.max(satisfaction, 15);
    budgetModifier = Math.max(budgetModifier, 1.10);
    message = "Champions! The board couldn't be happier.";
  }

  return { satisfaction, budgetModifier, message, metCount, totalCount };
}

/** Create initial board state */
export function createBoardState(objectives: BoardObjective[]): BoardState {
  return {
    objectives,
    satisfaction: 50,
    budgetModifier: 1.0,
    warnings: 0,
    message: "A new season begins. The board has set their expectations.",
  };
}

/** Update board state after season evaluation */
export function updateBoardState(
  current: BoardState,
  evaluation: ReturnType<typeof evaluateBoardObjectives>,
): BoardState {
  const newSatisfaction = clamp(current.satisfaction + evaluation.satisfaction, 0, 100);
  let warnings = current.warnings;
  let message = evaluation.message;

  if (newSatisfaction < 20) {
    warnings++;
    if (warnings >= 3) {
      message = "You have been relieved of your duties.";
    } else if (warnings === 2) {
      message += " This is your final warning.";
    } else {
      message += " The board is losing patience.";
    }
  } else if (newSatisfaction >= 70) {
    // Good performance can reduce warnings
    warnings = Math.max(0, warnings - 1);
  }

  return {
    objectives: current.objectives,
    satisfaction: newSatisfaction,
    budgetModifier: evaluation.budgetModifier,
    warnings,
    message,
  };
}

/** Check if the manager has been fired */
export function isFired(boardState: BoardState): boolean {
  return boardState.warnings >= 3 && boardState.satisfaction < 20;
}
