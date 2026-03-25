import { type Player, type Team } from "@ipl-sim/engine";

export type RecruitmentTier = "shortlist" | "watchlist";

export interface RecruitmentTarget {
  tier: RecruitmentTier;
  addedAtSeason: number;
}

export interface RecruitmentState {
  targets: Record<string, RecruitmentTarget>;
}

export function createRecruitmentState(): RecruitmentState {
  return { targets: {} };
}

function activePlayerIds(teams: Team[], playerPool: Player[]): Set<string> {
  return new Set([
    ...teams.flatMap(team => team.roster.map(player => player.id)),
    ...playerPool.map(player => player.id),
  ]);
}

export function syncRecruitmentState(
  recruitment: RecruitmentState | undefined,
  teams: Team[],
  playerPool: Player[],
): RecruitmentState {
  const validIds = activePlayerIds(teams, playerPool);
  const targets = Object.fromEntries(
    Object.entries(recruitment?.targets ?? {}).filter(([playerId]) => validIds.has(playerId)),
  );

  return { targets };
}

export function setRecruitmentTier(
  recruitment: RecruitmentState,
  playerId: string,
  tier: RecruitmentTier | null,
  seasonNumber: number,
): RecruitmentState {
  const targets = { ...recruitment.targets };
  const existing = targets[playerId];

  if (!tier) {
    delete targets[playerId];
    return { targets };
  }

  targets[playerId] = {
    tier,
    addedAtSeason: existing?.addedAtSeason ?? seasonNumber,
  };

  return { targets };
}

export function toggleRecruitmentTarget(
  recruitment: RecruitmentState,
  playerId: string,
  tier: RecruitmentTier,
  seasonNumber: number,
): RecruitmentState {
  return recruitment.targets[playerId]?.tier === tier
    ? setRecruitmentTier(recruitment, playerId, null, seasonNumber)
    : setRecruitmentTier(recruitment, playerId, tier, seasonNumber);
}

export function getRecruitmentTag(
  recruitment: RecruitmentState,
  playerId: string,
): RecruitmentTier | null {
  return recruitment.targets[playerId]?.tier ?? null;
}

export function isRecruitmentTarget(
  recruitment: RecruitmentState,
  playerId: string,
  tier: RecruitmentTier,
): boolean {
  return recruitment.targets[playerId]?.tier === tier;
}

export function getRecruitmentCounts(recruitment: RecruitmentState): {
  shortlist: number;
  watchlist: number;
} {
  let shortlist = 0;
  let watchlist = 0;

  for (const target of Object.values(recruitment.targets)) {
    if (target.tier === "shortlist") shortlist += 1;
    if (target.tier === "watchlist") watchlist += 1;
  }

  return { shortlist, watchlist };
}
