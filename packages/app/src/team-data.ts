import { Player, Team } from "@ipl-sim/engine";

/**
 * A team as plain data: what a save keeps of it (storage.ts writes and reads teams with these), so a team rebuilt
 * from it is the team a reload would give.
 */
export function teamToData(t: Team) {
  return {
    config: t.config,
    roster: t.roster.map(p => p.toJSON()),
    salaryCap: t.salaryCap,
    totalSpent: t.totalSpent,
    wins: t.wins, losses: t.losses, ties: t.ties,
    nrr: t.nrr, runsFor: t.runsFor, ballsFacedFor: t.ballsFacedFor,
    runsAgainst: t.runsAgainst, ballsFacedAgainst: t.ballsFacedAgainst,
    isUserControlled: t.isUserControlled,
    userPlayingXI: t.userPlayingXI,
    userBattingOrder: t.userBattingOrder,
    userBowlingOrder: t.userBowlingOrder,
    trainingIntensity: t.trainingIntensity,
    bowlingPlan: t.bowlingPlan,
    batterAggression: t.batterAggression,
    bowlerFieldSettings: t.bowlerFieldSettings,
  };
}

export type TeamData = ReturnType<typeof teamToData>;

export function teamFromData(t: any): Team {
  const team = new Team(t.config, t.salaryCap);
  team.roster = t.roster.map((p: any) => Player.fromJSON(p));
  team.totalSpent = t.totalSpent ?? 0;
  team.wins = t.wins ?? 0;
  team.losses = t.losses ?? 0;
  team.ties = t.ties ?? 0;
  team.nrr = t.nrr ?? 0;
  team.runsFor = t.runsFor ?? 0;
  team.ballsFacedFor = t.ballsFacedFor ?? 0;
  team.runsAgainst = t.runsAgainst ?? 0;
  team.ballsFacedAgainst = t.ballsFacedAgainst ?? 0;
  team.isUserControlled = t.isUserControlled ?? false;
  team.userPlayingXI = t.userPlayingXI;
  team.userBattingOrder = t.userBattingOrder;
  team.userBowlingOrder = t.userBowlingOrder;
  team.trainingIntensity = t.trainingIntensity ?? "balanced";
  team.bowlingPlan = t.bowlingPlan;
  team.batterAggression = t.batterAggression;
  team.bowlerFieldSettings = t.bowlerFieldSettings;
  return team;
}

/** An independent copy of a team (and its players): changing it leaves the original as it was */
export function cloneTeam(t: Team): Team {
  return teamFromData(JSON.parse(JSON.stringify(teamToData(t))));
}
