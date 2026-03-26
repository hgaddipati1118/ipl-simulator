import { Player, Team, type BowlingPlan } from "@ipl-sim/engine";

export type BowlingPhase = "powerplay" | "middle" | "death";
type BattingSlot = "opener" | "top-order" | "middle-order" | "finisher" | "lower-order";

export interface FitAssessment {
  score: number;
  tone: "good" | "info" | "warn";
  label: string;
}

export interface LineupInsight {
  title: string;
  detail: string;
}

export interface LineupReport {
  lineupScore: number;
  venueLabel: string;
  averageReadiness: number;
  hotStarters: number;
  tiredStarters: number;
  bowlingOptions: number;
  strengths: LineupInsight[];
  concerns: LineupInsight[];
  recommendations: LineupInsight[];
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isBowlingOption(player: Player): boolean {
  return player.role === "bowler" || player.role === "all-rounder";
}

function isPace(style: Player["bowlingStyle"]): boolean {
  return [
    "right-arm-fast", "right-arm-fast-medium", "right-arm-medium-fast", "right-arm-medium",
    "left-arm-fast", "left-arm-fast-medium", "left-arm-medium-fast", "left-arm-medium",
  ].includes(style);
}

function isSpin(style: Player["bowlingStyle"]): boolean {
  return ["off-spin", "left-arm-orthodox", "leg-spin", "left-arm-wrist-spin"].includes(style);
}

function getBattingSlot(index: number): BattingSlot {
  if (index < 2) return "opener";
  if (index < 5) return "top-order";
  if (index < 7) return "finisher";
  if (index < 9) return "middle-order";
  return "lower-order";
}

function fitLabel(score: number): Pick<FitAssessment, "tone" | "label"> {
  if (score >= 72) return { tone: "good", label: "Strong Fit" };
  if (score >= 62) return { tone: "info", label: "Fit" };
  return { tone: "warn", label: "Risk" };
}

export function getBattingSlotFit(player: Player, index: number): FitAssessment {
  const slot = getBattingSlot(index);
  let score = 0;

  switch (slot) {
    case "opener":
      score =
        player.ratings.battingIQ * 0.35 +
        player.ratings.timing * 0.35 +
        player.ratings.running * 0.1 +
        player.ratings.clutch * 0.2;
      break;
    case "top-order":
      score =
        player.ratings.battingIQ * 0.3 +
        player.ratings.timing * 0.3 +
        player.ratings.power * 0.15 +
        player.ratings.clutch * 0.25;
      break;
    case "middle-order":
      score =
        player.ratings.battingIQ * 0.25 +
        player.ratings.timing * 0.2 +
        player.ratings.power * 0.25 +
        player.ratings.running * 0.1 +
        player.ratings.clutch * 0.2;
      break;
    case "finisher":
      score =
        player.ratings.power * 0.4 +
        player.ratings.clutch * 0.3 +
        player.ratings.battingIQ * 0.15 +
        player.ratings.running * 0.15;
      break;
    case "lower-order":
      score =
        player.ratings.power * 0.3 +
        player.ratings.clutch * 0.25 +
        player.battingOvr * 0.2 +
        player.ratings.running * 0.1 +
        player.ratings.battingIQ * 0.15;
      break;
  }

  return {
    score: Math.round(score),
    ...fitLabel(score),
  };
}

export function getBowlingPhaseFit(player: Player, phase: BowlingPhase): FitAssessment {
  let score = 0;

  switch (phase) {
    case "powerplay":
      score =
        player.bowlingOvr * 0.35 +
        player.ratings.accuracy * 0.25 +
        player.ratings.wicketTaking * 0.2 +
        player.ratings.clutch * 0.2 +
        (isPace(player.bowlingStyle) ? 4 : isSpin(player.bowlingStyle) ? -2 : 0);
      break;
    case "middle":
      score =
        player.bowlingOvr * 0.3 +
        player.ratings.economy * 0.3 +
        player.ratings.wicketTaking * 0.15 +
        player.ratings.accuracy * 0.1 +
        player.ratings.clutch * 0.15 +
        (isSpin(player.bowlingStyle) ? 4 : isPace(player.bowlingStyle) ? -1 : 0);
      break;
    case "death":
      score =
        player.bowlingOvr * 0.3 +
        player.ratings.accuracy * 0.3 +
        player.ratings.clutch * 0.25 +
        player.ratings.wicketTaking * 0.15 +
        (isPace(player.bowlingStyle) ? 4 : isSpin(player.bowlingStyle) ? -2 : 0);
      break;
  }

  return {
    score: Math.round(score),
    ...fitLabel(score),
  };
}

export function getBestBowlingPhaseFit(player: Player): FitAssessment & { phase: BowlingPhase } {
  const phases: BowlingPhase[] = ["powerplay", "middle", "death"];
  let best: FitAssessment & { phase: BowlingPhase } = { ...getBowlingPhaseFit(player, "powerplay"), phase: "powerplay" };

  for (const phase of phases.slice(1)) {
    const current = getBowlingPhaseFit(player, phase);
    if (current.score > best.score) best = { ...current, phase };
  }

  return best;
}

function addIfRoom(list: LineupInsight[], title: string, detail: string, limit = 3): void {
  if (list.length < limit) list.push({ title, detail });
}

export function buildLineupReport(params: {
  team: Team;
  availablePlayers: Player[];
  selectedPlayers: Player[];
  battingOrder: Player[];
  bowlingOrder: Player[];
  bowlingPlan?: BowlingPlan;
}): LineupReport {
  const { team, availablePlayers, selectedPlayers, battingOrder, bowlingOrder, bowlingPlan } = params;

  const strengths: LineupInsight[] = [];
  const concerns: LineupInsight[] = [];
  const recommendations: LineupInsight[] = [];

  const bowlers = selectedPlayers.filter(isBowlingOption);
  const spinCount = bowlers.filter(player => isSpin(player.bowlingStyle)).length;
  const paceCount = bowlers.filter(player => isPace(player.bowlingStyle)).length;
  const topOrder = battingOrder.slice(0, 4);
  const topSix = battingOrder.slice(0, 6);
  const topOrderFit = average(topOrder.map((player, index) => getBattingSlotFit(player, index).score));
  const topSixPower = average(topSix.map(player => player.ratings.power));
  const topSixRunning = average(topSix.map(player => player.ratings.running));
  const averageReadiness = average(selectedPlayers.map(player => player.readiness));
  const hotStarters = selectedPlayers.filter(player => player.form >= 65).length;
  const coldStarters = selectedPlayers.filter(player => player.form <= 35).length;
  const tiredStarters = selectedPlayers.filter(player => player.readiness <= 55).length;
  const hotBench = availablePlayers
    .filter(player => !selectedPlayers.some(selected => selected.id === player.id) && player.form >= 65)
    .sort((a, b) => b.form - a.form || b.overall - a.overall);
  const freshBench = availablePlayers
    .filter(player => !selectedPlayers.some(selected => selected.id === player.id) && player.readiness >= 80)
    .sort((a, b) => b.readiness - a.readiness || b.overall - a.overall);

  const deathCandidates = (bowlingPlan?.death.length ?? 0) > 0
    ? bowlingPlan!.death
        .map(id => selectedPlayers.find(player => player.id === id))
        .filter((player): player is Player => Boolean(player))
    : [...bowlingOrder]
        .sort((a, b) => getBowlingPhaseFit(b, "death").score - getBowlingPhaseFit(a, "death").score)
        .slice(0, 3);
  const deathScore = average(deathCandidates.map(player => getBowlingPhaseFit(player, "death").score));

  if (selectedPlayers.length < 11) {
    addIfRoom(concerns, "XI Incomplete", `Only ${selectedPlayers.length}/11 players are selected.`);
  }

  if (bowlers.length >= 5) {
    addIfRoom(strengths, "Bowling Depth", `${bowlers.length} bowling options should cover the 20 overs cleanly.`);
  } else {
    addIfRoom(concerns, "Thin Bowling Unit", `Only ${bowlers.length} bowling options are selected. That is risky over a full innings.`);
  }

  if (topOrder.length >= 4 && topOrderFit >= 70) {
    addIfRoom(strengths, "Top-Order Stability", `Your first four average a ${Math.round(topOrderFit)} batting-role fit, which is a strong base.`);
  } else if (topOrder.length >= 3 && topOrderFit < 66) {
    addIfRoom(concerns, "Top-Order Risk", `Your first four average only ${Math.round(topOrderFit)} for their batting slots.`);
  }

  if (deathScore >= 70) {
    addIfRoom(strengths, "Death Overs Covered", `Late-innings bowling projects at ${Math.round(deathScore)} across your likely closers.`);
  } else if (deathCandidates.length >= 2) {
    addIfRoom(concerns, "Death Overs Look Soft", `Late-innings bowling projects at only ${Math.round(deathScore)}. Tight finishes could get loose.`);
  }

  switch (team.config.pitchType ?? "balanced") {
    case "turning":
      if (spinCount >= 2) addIfRoom(strengths, "Venue Fit", `${spinCount} spin options suit ${team.config.city}'s turning surface.`);
      else addIfRoom(concerns, "Venue Mismatch", `Only ${spinCount} spin option suits a turning home pitch.`);
      break;
    case "seaming":
      if (paceCount >= 2) addIfRoom(strengths, "New-Ball Fit", `${paceCount} pace options match the seaming conditions.`);
      else addIfRoom(concerns, "New-Ball Concern", `You only have ${paceCount} pace option for a seaming surface.`);
      break;
    case "flat":
      if (topSixPower >= 68) addIfRoom(strengths, "Boundary Threat", `The top six average ${Math.round(topSixPower)} power, which fits a flat batting surface.`);
      else addIfRoom(concerns, "Flat Pitch Ceiling", `Top-six power averages ${Math.round(topSixPower)} on a flat surface.`);
      break;
    case "balanced":
      break;
  }

  if ((team.config.boundarySize ?? "medium") === "large") {
    if (topSixRunning >= 58) addIfRoom(strengths, "Large-Ground Running", `The top six average ${Math.round(topSixRunning)} running for the bigger outfield.`);
    else addIfRoom(concerns, "Large-Ground Fit", `Top-six running averages ${Math.round(topSixRunning)} on a large ground.`);
  }

  if (hotStarters >= 2) addIfRoom(strengths, "In-Form Core", `${hotStarters} starters are in strong recent form.`);
  if (coldStarters >= 2) addIfRoom(concerns, "Cold Picks", `${coldStarters} starters are carrying poor recent form.`);
  if (averageReadiness >= 82) addIfRoom(strengths, "Fresh Squad", `Average readiness is ${Math.round(averageReadiness)}, so the XI should hold intensity late.`);
  if (tiredStarters >= 2) addIfRoom(concerns, "Condition Risk", `${tiredStarters} starters are below 55 readiness. Workload could show up late.`);

  if (hotBench.length > 0) {
    const benchPlayer = hotBench[0];
    const sameRoleSwap = selectedPlayers
      .filter(player => player.role === benchPlayer.role)
      .sort((a, b) => a.form - b.form || a.overall - b.overall)[0];
    if (sameRoleSwap && (benchPlayer.form - sameRoleSwap.form >= 15 || benchPlayer.overall >= sameRoleSwap.overall)) {
      addIfRoom(
        recommendations,
        "Bench Pressure",
        `${benchPlayer.name} is hot (${Math.round(benchPlayer.form)} form) and has a case over ${sameRoleSwap.name}.`,
      );
    }
  }

  if (freshBench.length > 0 && tiredStarters > 0) {
    addIfRoom(
      recommendations,
      "Fresh Legs Available",
      `${freshBench[0].name} is sitting on ${freshBench[0].readiness} readiness if you want to ease the workload.`,
    );
  }

  const openerCandidates = battingOrder
    .map((player, index) => ({ player, index, fit: getBattingSlotFit(player, 0).score }))
    .sort((a, b) => b.fit - a.fit);
  if (openerCandidates.length > 0 && openerCandidates[0].index > 1 && battingOrder.length >= 2) {
    const currentWeakestOpener = Math.min(
      getBattingSlotFit(battingOrder[0], 0).score,
      getBattingSlotFit(battingOrder[1], 1).score,
    );
    if (openerCandidates[0].fit - currentWeakestOpener >= 6) {
      addIfRoom(
        recommendations,
        "Opening Pair",
        `${openerCandidates[0].player.name} grades better as an opener than your current weaker opening option.`,
      );
    }
  }

  const bestDeathBowler = [...bowlers].sort(
    (a, b) => getBowlingPhaseFit(b, "death").score - getBowlingPhaseFit(a, "death").score,
  )[0];
  if (bestDeathBowler && (bowlingPlan?.death.length ?? 0) > 0 && !bowlingPlan!.death.includes(bestDeathBowler.id)) {
    addIfRoom(
      recommendations,
      "Death Plan",
      `${bestDeathBowler.name} is your strongest death-over fit and is not in the current death plan.`,
    );
  }

  const venueBits = [team.config.stadiumName ?? team.config.city];
  if (team.config.pitchType && team.config.pitchType !== "balanced") venueBits.push(team.config.pitchType);
  if (team.config.boundarySize && team.config.boundarySize !== "medium") venueBits.push(`${team.config.boundarySize} boundaries`);

  const lineupScore = Math.round(
    Math.max(
      40,
      Math.min(
        95,
        topOrderFit * 0.35 +
          deathScore * 0.25 +
          average(bowlers.map(player => player.bowlingOvr)) * 0.2 +
          average(selectedPlayers.map(player => player.form)) * 0.1 +
          average(selectedPlayers.map(player => player.overall)) * 0.1,
      ),
    ),
  );

  return {
    lineupScore,
    venueLabel: venueBits.join(" • "),
    averageReadiness: Math.round(averageReadiness),
    hotStarters,
    tiredStarters,
    bowlingOptions: bowlers.length,
    strengths,
    concerns,
    recommendations,
  };
}
