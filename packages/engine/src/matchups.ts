/**
 * Bowling type vs batting hand matchup modifiers.
 *
 * These modify base outcome probabilities in the match engine based on:
 * - Bowling style (pace/spin/type)
 * - Batting hand (left/right)
 * - Match phase (powerplay/middle/death)
 * - Pitch conditions (seaming/turning/flat)
 * - Dew factor (2nd innings)
 */

export type BowlingStyle =
  | "right-arm-fast" | "right-arm-medium"
  | "left-arm-fast" | "left-arm-medium"
  | "off-spin" | "left-arm-orthodox"
  | "leg-spin" | "left-arm-wrist-spin"
  | "unknown";

export type BattingHand = "right" | "left";
export type PitchType = "flat" | "seaming" | "turning" | "balanced";
export type BoundarySize = "small" | "medium" | "large";
export type DewFactor = "none" | "moderate" | "heavy";
export type MatchPhase = "powerplay" | "middle" | "death";

/** Whether a bowling style is pace or spin */
export function isPaceBowler(style: BowlingStyle): boolean {
  return ["right-arm-fast", "right-arm-medium", "left-arm-fast", "left-arm-medium"].includes(style);
}

export function isSpinBowler(style: BowlingStyle): boolean {
  return ["off-spin", "left-arm-orthodox", "leg-spin", "left-arm-wrist-spin"].includes(style);
}

/** Get the current match phase from the over number */
export function getMatchPhase(over: number): MatchPhase {
  if (over < 6) return "powerplay";
  if (over < 15) return "middle";
  return "death";
}

/** Venue-aware toss choice heuristic used by CPU-controlled sims. */
export function decideTossChoice(params: {
  pitchType?: PitchType;
  dewFactor?: DewFactor;
}): "bat" | "bowl" {
  const { pitchType = "balanced", dewFactor = "none" } = params;

  if (dewFactor === "heavy") return "bowl";
  if (dewFactor === "moderate") return Math.random() < 0.65 ? "bowl" : "bat";
  if (pitchType === "seaming") return "bat";
  return Math.random() < 0.6 ? "bowl" : "bat";
}

/**
 * Bowling style vs batting hand matchup modifier.
 * Returns a multiplier for wicket probability (>1 = advantage to bowler, <1 = advantage to batter).
 *
 * Key cricket matchup principles:
 * - Left-arm pace naturally angles across right-handers (advantage)
 * - Off-spin turns into right-handers (neutral), away from left-handers (advantage)
 * - Leg-spin turns away from right-handers (advantage), into left-handers (neutral)
 * - Left-arm orthodox turns into right-handers (neutral), away from left-handers (advantage)
 */
export function getHandMatchupModifier(bowlingStyle: BowlingStyle, battingHand: BattingHand): {
  wicketMod: number;
  boundaryMod: number;
  dotMod: number;
} {
  if (bowlingStyle === "unknown") return { wicketMod: 1.0, boundaryMod: 1.0, dotMod: 1.0 };

  // Default: neutral
  let wicketMod = 1.0;
  let boundaryMod = 1.0;
  let dotMod = 1.0;

  if (battingHand === "right") {
    switch (bowlingStyle) {
      case "left-arm-fast":
      case "left-arm-medium":
        // Ball angles across — harder to play
        wicketMod = 1.12; boundaryMod = 0.95; dotMod = 1.05; break;
      case "leg-spin":
      case "left-arm-wrist-spin":
        // Turns away — hard to reach, edges
        wicketMod = 1.15; boundaryMod = 0.92; dotMod = 1.08; break;
      case "off-spin":
      case "left-arm-orthodox":
        // Turns into bat — easier to play, but can trap LBW
        wicketMod = 0.95; boundaryMod = 1.05; dotMod = 0.95; break;
      case "right-arm-fast":
        // Standard matchup
        wicketMod = 1.0; boundaryMod = 1.0; dotMod = 1.0; break;
      case "right-arm-medium":
        // Less threatening
        wicketMod = 0.95; boundaryMod = 1.03; dotMod = 0.97; break;
    }
  } else {
    // Left-hand batter
    switch (bowlingStyle) {
      case "right-arm-fast":
      case "right-arm-medium":
        // Ball angles across — slightly harder
        wicketMod = 1.05; boundaryMod = 0.97; dotMod = 1.02; break;
      case "off-spin":
        // Turns away from left-hander — dangerous
        wicketMod = 1.15; boundaryMod = 0.90; dotMod = 1.10; break;
      case "left-arm-orthodox":
        // Turns into left-hander — easier
        wicketMod = 0.92; boundaryMod = 1.08; dotMod = 0.93; break;
      case "leg-spin":
      case "left-arm-wrist-spin":
        // Turns into left-hander — easier to play
        wicketMod = 0.93; boundaryMod = 1.05; dotMod = 0.95; break;
      case "left-arm-fast":
      case "left-arm-medium":
        // Standard angle for left-hander
        wicketMod = 0.97; boundaryMod = 1.02; dotMod = 0.98; break;
    }
  }

  return { wicketMod, boundaryMod, dotMod };
}

/**
 * Phase-based bowling effectiveness.
 * Pace is better in powerplay + death, spin is better in middle overs.
 */
export function getPhaseModifier(bowlingStyle: BowlingStyle, phase: MatchPhase): {
  wicketMod: number;
  economyMod: number;
} {
  if (bowlingStyle === "unknown") return { wicketMod: 1.0, economyMod: 1.0 };

  const pace = isPaceBowler(bowlingStyle);
  const spin = isSpinBowler(bowlingStyle);

  switch (phase) {
    case "powerplay":
      // Pace thrives with new ball, fielding restrictions help boundaries against spin
      if (pace) return { wicketMod: 1.10, economyMod: 0.95 };
      if (spin) return { wicketMod: 0.90, economyMod: 1.10 };
      break;
    case "middle":
      // Spin thrives with grip, pace less effective on used ball
      if (spin) return { wicketMod: 1.12, economyMod: 0.90 };
      if (pace) return { wicketMod: 0.95, economyMod: 1.05 };
      break;
    case "death":
      // Pace yorkers + bouncers are key, spin gets hit
      if (pace) return { wicketMod: 1.05, economyMod: 0.92 };
      if (spin) return { wicketMod: 0.85, economyMod: 1.15 };
      break;
  }

  return { wicketMod: 1.0, economyMod: 1.0 };
}

/**
 * Batter affinity — how well a batter handles pace vs spin.
 * Derived from their ratings:
 *   - High timing = good vs pace (can time drives, defend well)
 *   - High power = good vs spin (can muscle over the top)
 *   - High battingIQ = adaptable (good vs both)
 */
export function getBatterAffinityModifier(
  batterRatings: { battingIQ: number; timing: number; power: number },
  bowlingStyle: BowlingStyle,
): { wicketMod: number; boundaryMod: number } {
  if (bowlingStyle === "unknown") return { wicketMod: 1.0, boundaryMod: 1.0 };

  const pace = isPaceBowler(bowlingStyle);
  const spin = isSpinBowler(bowlingStyle);

  if (pace) {
    // vs pace: timing matters most (can they time drives and defend?)
    const paceAbility = (batterRatings.timing * 0.5 + batterRatings.battingIQ * 0.3 + batterRatings.power * 0.2) / 100;
    // paceAbility 0.7+ = good vs pace, 0.5 = neutral, <0.4 = struggles
    const mod = (paceAbility - 0.55) * 0.3; // ±0.06 for typical range
    return {
      wicketMod: 1 - mod,    // Good vs pace = less likely out
      boundaryMod: 1 + mod,  // Good vs pace = more boundaries
    };
  }

  if (spin) {
    // vs spin: power matters (can they hit over the top?) + IQ (read the spin)
    const spinAbility = (batterRatings.power * 0.4 + batterRatings.battingIQ * 0.4 + batterRatings.timing * 0.2) / 100;
    const mod = (spinAbility - 0.55) * 0.3;
    return {
      wicketMod: 1 - mod,
      boundaryMod: 1 + mod,
    };
  }

  return { wicketMod: 1.0, boundaryMod: 1.0 };
}

/**
 * Pitch condition modifiers for bowling type.
 */
export function getPitchModifier(
  bowlingStyle: BowlingStyle,
  pitchType: PitchType,
  dewFactor: DewFactor,
  isSecondInnings: boolean,
): {
  wicketMod: number;
  boundaryMod: number;
} {
  let wicketMod = 1.0;
  let boundaryMod = 1.0;

  const pace = isPaceBowler(bowlingStyle);
  const spin = isSpinBowler(bowlingStyle);

  // Pitch type effects
  switch (pitchType) {
    case "seaming":
      if (pace) { wicketMod *= 1.15; boundaryMod *= 0.90; }
      if (spin) { wicketMod *= 0.95; }
      break;
    case "turning":
      if (spin) { wicketMod *= 1.20; boundaryMod *= 0.85; }
      if (pace) { wicketMod *= 0.95; }
      break;
    case "flat":
      boundaryMod *= 1.10; // batsman-friendly
      wicketMod *= 0.95;
      break;
    case "balanced":
      // No modifier
      break;
  }

  // Dew effect (2nd innings)
  if (isSecondInnings && dewFactor !== "none") {
    const dewStrength = dewFactor === "heavy" ? 0.20 : 0.10;
    if (spin) {
      wicketMod *= (1 - dewStrength); // Dew reduces spin grip
    }
    if (pace) {
      // Wet ball harder to grip for pace but also skids on
      wicketMod *= (1 - dewStrength * 0.3);
    }
    // Dew generally helps batting
    boundaryMod *= (1 + dewStrength * 0.5);
  }

  return { wicketMod, boundaryMod };
}

/**
 * Boundary size modifier.
 */
export function getBoundaryModifier(boundarySize: BoundarySize): {
  fourMod: number;
  sixMod: number;
} {
  switch (boundarySize) {
    case "small": return { fourMod: 1.15, sixMod: 1.20 };
    case "large": return { fourMod: 0.90, sixMod: 0.85 };
    case "medium":
    default: return { fourMod: 1.0, sixMod: 1.0 };
  }
}

/**
 * Combined matchup modifier — call this from the match engine.
 * Returns multipliers for key outcome probabilities.
 */
export function getMatchupModifiers(params: {
  bowlingStyle: BowlingStyle;
  battingHand: BattingHand;
  batterRatings?: { battingIQ: number; timing: number; power: number };
  over: number;
  pitchType?: PitchType;
  boundarySize?: BoundarySize;
  dewFactor?: DewFactor;
  isSecondInnings?: boolean;
}): {
  wicketMod: number;
  fourMod: number;
  sixMod: number;
  dotMod: number;
} {
  const {
    bowlingStyle, battingHand, over,
    pitchType = "balanced",
    boundarySize = "medium",
    dewFactor = "none",
    isSecondInnings = false,
  } = params;

  const phase = getMatchPhase(over);
  const hand = getHandMatchupModifier(bowlingStyle, battingHand);
  const phaseM = getPhaseModifier(bowlingStyle, phase);
  const pitchM = getPitchModifier(bowlingStyle, pitchType, dewFactor, isSecondInnings);
  const boundM = getBoundaryModifier(boundarySize);

  // Batter affinity vs bowling type (pace/spin preference)
  const affinityM = params.batterRatings
    ? getBatterAffinityModifier(params.batterRatings, bowlingStyle)
    : { wicketMod: 1.0, boundaryMod: 1.0 };

  return {
    wicketMod: hand.wicketMod * phaseM.wicketMod * pitchM.wicketMod * affinityM.wicketMod,
    fourMod: hand.boundaryMod * pitchM.boundaryMod * boundM.fourMod * affinityM.boundaryMod,
    sixMod: hand.boundaryMod * pitchM.boundaryMod * boundM.sixMod * affinityM.boundaryMod,
    dotMod: hand.dotMod * (1 / phaseM.economyMod),
  };
}
