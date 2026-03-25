import { clamp, type Player, type Team } from "@ipl-sim/engine";

export interface ScoutingReport {
  playerId: string;
  confidence: number;
  exposures: number;
  lastUpdatedSeason: number;
}

export interface ScoutingState {
  reports: Record<string, ScoutingReport>;
}

export interface ScoutedNumericView {
  actual: number;
  exact: boolean;
  estimate: number;
  min: number;
  max: number;
  display: string;
  compactDisplay: string;
  sortValue: number;
  barValue: number;
}

export interface ScoutedMarketValueView {
  exact: boolean;
  estimate: number;
  min: number;
  max: number;
  display: string;
  compactDisplay: string;
  sortValue: number;
}

export interface PlayerScoutingView {
  confidence: number;
  confidenceLabel: string;
  summary: string;
  qualityLabel: string;
  exactRatings: boolean;
  showStyleDetails: boolean;
  showConditioning: boolean;
  showDevelopment: boolean;
  showAcquisitionCost: boolean;
  overall: ScoutedNumericView;
  batting: ScoutedNumericView;
  bowling: ScoutedNumericView;
  ageDisplay: string;
  ageSortValue: number;
  marketValue: ScoutedMarketValueView;
  strengths: string[];
  concerns: string[];
  attributes: {
    battingIQ: ScoutedNumericView;
    timing: ScoutedNumericView;
    power: ScoutedNumericView;
    running: ScoutedNumericView;
    wicketTaking: ScoutedNumericView;
    economy: ScoutedNumericView;
    accuracy: ScoutedNumericView;
    clutch: ScoutedNumericView;
  };
}

const FULL_REPORT_CONFIDENCE = 92;
const STYLE_REPORT_CONFIDENCE = 68;
const COST_REPORT_CONFIDENCE = 86;
const RATING_KEYS = [
  "battingIQ",
  "timing",
  "power",
  "running",
  "wicketTaking",
  "economy",
  "accuracy",
  "clutch",
] as const;

type RatingKey = typeof RATING_KEYS[number];

interface PlayerEntry {
  player: Player;
  teamId?: string;
}

function trackedPlayers(teams: Team[], playerPool: Player[]): PlayerEntry[] {
  const rostered = teams.flatMap(team =>
    team.roster.map(player => ({ player, teamId: team.id })),
  );
  const pooled = playerPool.map(player => ({ player, teamId: player.teamId }));
  return [...rostered, ...pooled];
}

function baseConfidence(player: Player, teamId: string | undefined, userTeamId: string | null): number {
  if (userTeamId && teamId === userTeamId) return 100;

  let confidence = teamId ? 36 : 50;
  if (!userTeamId) confidence -= 6;
  if (player.isInternational) confidence += 10;
  if (player.stats.matches >= 8) confidence += 6;
  if (player.stats.runs >= 250 || player.stats.wickets >= 10) confidence += 8;
  if (player.overall >= 82) confidence += 6;
  if (player.age <= 23) confidence += 4;

  return clamp(Math.round(confidence), 18, 100);
}

function stableUnit(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 2001) / 1000 - 1;
}

function uncertaintyMargin(confidence: number): number {
  if (confidence >= FULL_REPORT_CONFIDENCE) return 0;
  return clamp(Math.round((100 - confidence) / 4), 2, 18);
}

function buildNumericView(
  actual: number,
  confidence: number,
  seed: string,
  minValue = 15,
  maxValue = 99,
): ScoutedNumericView {
  if (confidence >= FULL_REPORT_CONFIDENCE) {
    return {
      actual,
      exact: true,
      estimate: actual,
      min: actual,
      max: actual,
      display: String(actual),
      compactDisplay: String(actual),
      sortValue: actual,
      barValue: actual,
    };
  }

  const margin = uncertaintyMargin(confidence);
  const estimate = clamp(Math.round(actual + stableUnit(seed) * margin), minValue, maxValue);
  const padding = Math.max(2, Math.round(margin * 0.6));
  const min = clamp(Math.min(actual, estimate) - padding, minValue, maxValue);
  const max = clamp(Math.max(actual, estimate) + padding, minValue, maxValue);
  const display = confidence >= 74 ? `~${estimate}` : `${min}-${max}`;

  return {
    actual,
    exact: false,
    estimate,
    min,
    max,
    display,
    compactDisplay: display,
    sortValue: estimate,
    barValue: estimate,
  };
}

function buildMarketValueView(actual: number, confidence: number, seed: string): ScoutedMarketValueView {
  if (confidence >= COST_REPORT_CONFIDENCE) {
    return {
      exact: true,
      estimate: actual,
      min: actual,
      max: actual,
      display: `${actual.toFixed(1)} Cr`,
      compactDisplay: actual.toFixed(1),
      sortValue: actual,
    };
  }

  const variance = Math.max(0.08, (100 - confidence) / 120);
  const estimate = Math.max(0.1, Math.round(actual * (1 + stableUnit(seed) * variance) * 10) / 10);

  if (confidence >= 68) {
    return {
      exact: false,
      estimate,
      min: estimate,
      max: estimate,
      display: `~${estimate.toFixed(1)} Cr`,
      compactDisplay: `~${estimate.toFixed(1)}`,
      sortValue: estimate,
    };
  }

  const spread = Math.max(0.2, Math.round(estimate * Math.max(0.18, variance * 0.9) * 10) / 10);
  const min = Math.max(0.1, Math.round((estimate - spread) * 10) / 10);
  const max = Math.max(min, Math.round((estimate + spread) * 10) / 10);

  return {
    exact: false,
    estimate,
    min,
    max,
    display: `${min.toFixed(1)}-${max.toFixed(1)} Cr`,
    compactDisplay: `${min.toFixed(1)}-${max.toFixed(1)}`,
    sortValue: estimate,
  };
}

function ageBand(age: number, confidence: number): { display: string; sortValue: number } {
  if (confidence >= 72) {
    return { display: String(age), sortValue: age };
  }
  if (age <= 21) return { display: "U22", sortValue: 21 };
  if (age <= 24) return { display: "22-24", sortValue: 23 };
  if (age <= 27) return { display: "25-27", sortValue: 26 };
  if (age <= 30) return { display: "28-30", sortValue: 29 };
  if (age <= 33) return { display: "31-33", sortValue: 32 };
  return { display: "34+", sortValue: 34 };
}

function confidenceLabel(confidence: number): string {
  if (confidence >= FULL_REPORT_CONFIDENCE) return "Full dossier";
  if (confidence >= 78) return "Strong report";
  if (confidence >= 60) return "Partial report";
  if (confidence >= 40) return "Limited report";
  return "Background note";
}

function qualityLabel(estimate: number): string {
  if (estimate >= 87) return "Elite";
  if (estimate >= 79) return "Core";
  if (estimate >= 71) return "Starter";
  if (estimate >= 63) return "Squad";
  return "Depth";
}

function roleSummary(role: Player["role"]): string {
  switch (role) {
    case "bowler": return "bowling-first option";
    case "all-rounder": return "two-way option";
    default: return "batting-first option";
  }
}

function buildStrengths(
  player: Player,
  overall: ScoutedNumericView,
  batting: ScoutedNumericView,
  bowling: ScoutedNumericView,
  attributes: PlayerScoutingView["attributes"],
  confidence: number,
): string[] {
  if (confidence < 52) {
    return ["Reports are thin. Treat this read as a rough market impression only."];
  }

  const notes: { label: string; value: number }[] = [
    { label: "Power looks real on tape.", value: attributes.power.sortValue },
    { label: "Times the ball well and builds innings cleanly.", value: Math.round((attributes.battingIQ.sortValue + attributes.timing.sortValue) / 2) },
    { label: "Can create wickets, not just hold an end.", value: attributes.wicketTaking.sortValue },
    { label: "Control profile looks reliable.", value: Math.round((attributes.economy.sortValue + attributes.accuracy.sortValue) / 2) },
    { label: "Moves well and adds value between wickets.", value: attributes.running.sortValue },
    { label: "Handles pressure moments well.", value: attributes.clutch.sortValue },
    { label: `Projects as a ${qualityLabel(overall.sortValue).toLowerCase()} ${roleSummary(player.role)}.`, value: overall.sortValue },
    { label: batting.sortValue >= bowling.sortValue ? "Batting output is the bigger carrying tool." : "Bowling output is the bigger carrying tool.", value: Math.max(batting.sortValue, bowling.sortValue) },
  ];

  return notes
    .filter(note => note.value >= 66)
    .sort((left, right) => right.value - left.value)
    .slice(0, 3)
    .map(note => note.label);
}

function buildConcerns(player: Player, confidence: number, batting: ScoutedNumericView, bowling: ScoutedNumericView): string[] {
  const notes: string[] = [];
  if (confidence < 52) {
    notes.push("The scouting sample is still thin enough that role fit could move.");
  }
  if (player.isInternational) {
    notes.push("Any move still burns an overseas slot.");
  }
  if (player.age >= 33) {
    notes.push("Short-window veteran profile.");
  }
  if (player.role !== "bowler" && batting.sortValue < 58) {
    notes.push("Batting floor does not look especially safe right now.");
  }
  if (player.role !== "batsman" && bowling.sortValue < 58) {
    notes.push("Bowling floor still looks volatile.");
  }

  return notes.slice(0, 3);
}

export function createScoutingState(
  teams: Team[],
  playerPool: Player[],
  userTeamId: string | null,
  seasonNumber: number,
): ScoutingState {
  return syncScoutingState({ reports: {} }, teams, playerPool, userTeamId, seasonNumber);
}

export function syncScoutingState(
  scouting: ScoutingState | undefined,
  teams: Team[],
  playerPool: Player[],
  userTeamId: string | null,
  seasonNumber: number,
): ScoutingState {
  const reports: Record<string, ScoutingReport> = {};

  for (const entry of trackedPlayers(teams, playerPool)) {
    const base = baseConfidence(entry.player, entry.teamId, userTeamId);
    const previous = scouting?.reports[entry.player.id];
    const confidence = entry.teamId === userTeamId ? 100 : Math.max(previous?.confidence ?? 0, base);

    reports[entry.player.id] = {
      playerId: entry.player.id,
      confidence,
      exposures: previous?.exposures ?? 0,
      lastUpdatedSeason: entry.teamId === userTeamId
        ? seasonNumber
        : previous?.lastUpdatedSeason ?? seasonNumber,
    };
  }

  return { reports };
}

export function boostPlayerScouting(
  scouting: ScoutingState | undefined,
  teams: Team[],
  playerPool: Player[],
  userTeamId: string | null,
  seasonNumber: number,
  playerIds: string[],
  amount: number,
): ScoutingState {
  const synced = syncScoutingState(scouting, teams, playerPool, userTeamId, seasonNumber);
  const nextReports = { ...synced.reports };

  for (const playerId of new Set(playerIds)) {
    const report = nextReports[playerId];
    if (!report) continue;
    nextReports[playerId] = {
      ...report,
      confidence: clamp(report.confidence + amount, 18, 100),
      exposures: report.exposures + 1,
      lastUpdatedSeason: seasonNumber,
    };
  }

  return { reports: nextReports };
}

export function boostTeamScouting(
  scouting: ScoutingState | undefined,
  teams: Team[],
  playerPool: Player[],
  userTeamId: string | null,
  seasonNumber: number,
  teamId: string,
  amount: number,
): ScoutingState {
  const team = teams.find(entry => entry.id === teamId);
  if (!team) {
    return syncScoutingState(scouting, teams, playerPool, userTeamId, seasonNumber);
  }

  return boostPlayerScouting(
    scouting,
    teams,
    playerPool,
    userTeamId,
    seasonNumber,
    team.roster.map(player => player.id),
    amount,
  );
}

export function getPlayerScoutingView(
  player: Player,
  teamId: string | undefined,
  scouting: ScoutingState | undefined,
  userTeamId: string | null,
): PlayerScoutingView {
  const confidence = teamId === userTeamId
    ? 100
    : scouting?.reports[player.id]?.confidence ?? baseConfidence(player, teamId, userTeamId);
  const exactRatings = teamId === userTeamId || confidence >= FULL_REPORT_CONFIDENCE;
  const attributes = Object.fromEntries(
    RATING_KEYS.map(key => [
      key,
      buildNumericView(player.ratings[key], confidence, `${player.id}:${key}`),
    ]),
  ) as PlayerScoutingView["attributes"];
  const overall = buildNumericView(player.overall, confidence, `${player.id}:overall`);
  const batting = buildNumericView(player.battingOvr, confidence, `${player.id}:batting`);
  const bowling = buildNumericView(player.bowlingOvr, confidence, `${player.id}:bowling`);
  const age = ageBand(player.age, confidence);
  const quality = qualityLabel(overall.sortValue);
  const marketValue = buildMarketValueView(player.marketValue, confidence, `${player.id}:market`);
  const strengths = buildStrengths(player, overall, batting, bowling, attributes, confidence);
  const concerns = buildConcerns(player, confidence, batting, bowling);
  const label = confidenceLabel(confidence);
  const summary = exactRatings
    ? `${quality} ${roleSummary(player.role)}. Internal staff have a complete read on this player.`
    : `${label}. Projects as a ${quality.toLowerCase()} ${roleSummary(player.role)} based on current reports.`;

  return {
    confidence,
    confidenceLabel: label,
    summary,
    qualityLabel: quality,
    exactRatings,
    showStyleDetails: teamId === userTeamId || confidence >= STYLE_REPORT_CONFIDENCE,
    showConditioning: teamId === userTeamId,
    showDevelopment: teamId === userTeamId,
    showAcquisitionCost: teamId === userTeamId || confidence >= COST_REPORT_CONFIDENCE,
    overall,
    batting,
    bowling,
    ageDisplay: age.display,
    ageSortValue: age.sortValue,
    marketValue,
    strengths,
    concerns,
    attributes,
  };
}
