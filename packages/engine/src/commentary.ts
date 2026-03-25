/**
 * Rich contextual ball-by-ball commentary engine.
 *
 * Replaces the simple per-outcome templates with context-aware commentary
 * that considers bowling style, match situation, milestones, and phase.
 */

import type { RNG } from "./rng.js";

type BowlingStyleCategory = "pace" | "spin" | "medium" | "unknown";

function classifyBowlingStyle(bowlingStyle?: string): BowlingStyleCategory {
  if (!bowlingStyle) return "unknown";
  if (["right-arm-fast", "left-arm-fast"].includes(bowlingStyle)) return "pace";
  if (["right-arm-medium", "left-arm-medium"].includes(bowlingStyle)) return "medium";
  if (["off-spin", "left-arm-orthodox", "leg-spin", "left-arm-wrist-spin"].includes(bowlingStyle)) return "spin";
  return "unknown";
}

function pick<T>(arr: T[], rng: RNG = Math.random): T {
  return arr[Math.floor(rng() * arr.length)];
}

export interface BallCommentaryParams {
  bowlerName: string;
  batterName: string;
  outcome: string; // "dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"
  runs: number;
  over: number;
  ball: number;
  score: number;
  wickets: number;
  isSecondInnings: boolean;
  target?: number;
  bowlingStyle?: string;
  batterRuns?: number;
  batterBalls?: number;
  wicketType?: "bowled" | "caught" | "lbw" | "run_out" | "stumped";
  fielderName?: string;
  /** Random boundary shot description (from the existing randomBoundaryShot function) */
  boundaryShot?: string;
  /** Seeded RNG for deterministic commentary */
  rng?: RNG;
}

export function generateBallCommentary(params: BallCommentaryParams): string {
  const {
    bowlerName: bowler, batterName: batter, outcome, over, score, wickets,
    isSecondInnings, target, bowlingStyle, batterRuns = 0, batterBalls = 0,
    wicketType, fielderName, boundaryShot, rng = Math.random,
  } = params;

  const style = classifyBowlingStyle(bowlingStyle);
  const phase = over < 6 ? "powerplay" : over < 15 ? "middle" : "death";
  const prefix = `${bowler} to ${batter}`;

  // Check for milestones AFTER this ball
  const newBatterRuns = batterRuns + params.runs;
  let milestone = "";
  if (newBatterRuns >= 100 && batterRuns < 100) {
    milestone = ` That's a CENTURY for ${batter}! What an innings!`;
  } else if (newBatterRuns >= 50 && batterRuns < 50) {
    milestone = ` FIFTY for ${batter}! Well-played half-century!`;
  }

  // Chase context suffix
  let chaseSuffix = "";
  if (isSecondInnings && target && target > score) {
    const runsNeeded = target - score - params.runs;
    if (runsNeeded > 0 && runsNeeded <= 30) {
      chaseSuffix = ` Need ${runsNeeded} more to win.`;
    }
  }

  // Powerplay end marker
  let powerplaySuffix = "";
  if (over === 5 && params.ball >= 6) {
    powerplaySuffix = ` That's the end of the powerplay, ${score + params.runs}/${wickets} after 6 overs.`;
  }

  let commentary: string;

  switch (outcome) {
    case "dot":
      commentary = generateDotCommentary(prefix, batter, bowler, style, phase, rng);
      break;
    case "1":
      commentary = generateSingleCommentary(prefix, batter, bowler, style, rng);
      break;
    case "2":
      commentary = generateTwoCommentary(prefix, batter, bowler, rng);
      break;
    case "3":
      commentary = generateThreeCommentary(prefix, batter, bowler, rng);
      break;
    case "4":
      commentary = generateFourCommentary(prefix, batter, bowler, style, phase, boundaryShot, rng);
      break;
    case "6":
      commentary = generateSixCommentary(prefix, batter, bowler, style, phase, boundaryShot, rng);
      break;
    case "wicket":
      commentary = generateWicketCommentary(prefix, batter, bowler, style, wicketType, fielderName, batterRuns, batterBalls, rng);
      break;
    case "wide":
      commentary = generateWideCommentary(prefix, batter, bowler, style, rng);
      break;
    case "noball":
      commentary = generateNoBallCommentary(prefix, batter, bowler, rng);
      break;
    case "legbye":
      commentary = generateLegbyeCommentary(prefix, batter, bowler, style, rng);
      break;
    default:
      commentary = `${prefix}, no run.`;
  }

  return commentary + milestone + chaseSuffix + powerplaySuffix;
}

/* ─────────────────── Outcome-specific generators ─────────────────── */

function generateDotCommentary(prefix: string, batter: string, bowler: string, style: BowlingStyleCategory, phase: string, rng: RNG = Math.random): string {
  const paceTemplates = [
    `${prefix}, no run. Good length outside off, left alone`,
    `${prefix}, no run. Defended solidly back down the pitch`,
    `${prefix}, no run. Beaten outside off! Good delivery`,
    `${prefix}, no run. Fires one short, ${batter} ducks under it`,
    `${prefix}, no run. Bowls full and straight, ${batter} blocks solidly`,
    `${prefix}, no run. Short of a length, plays and misses`,
    `${prefix}, no run. Back of a length, cramping ${batter} for room`,
  ];

  const spinTemplates = [
    `${prefix}, no run. Flights it up, ${batter} comes forward and defends`,
    `${prefix}, no run. Tossed up outside off, left alone`,
    `${prefix}, no run. Turns sharply, beaten on the inside edge!`,
    `${prefix}, no run. Bowls the arm ball, ${batter} plays inside the line`,
    `${prefix}, no run. Nicely flighted, pushed back to the bowler`,
    `${prefix}, no run. Drifts in, ${batter} pads it away`,
  ];

  const mediumTemplates = [
    `${prefix}, no run. Bowls the slower one, ${batter} waits and defends`,
    `${prefix}, no run. Good length, can't get it away`,
    `${prefix}, no run. Tight line, pushed to cover but no single there`,
    `${prefix}, no run. Cutters on a good length, ${batter} is watchful`,
    `${prefix}, no run. Pushes it across, ${batter} leaves well`,
  ];

  const deathTemplates = [
    `${prefix}, no run. Good yorker! ${batter} digs it out`,
    `${prefix}, no run. Slower ball, ${batter} swings and misses!`,
    `${prefix}, no run. Wide yorker, can't reach it`,
  ];

  if (phase === "death" && (style === "pace" || style === "medium")) {
    return pick([...deathTemplates, ...(style === "pace" ? paceTemplates.slice(0, 3) : mediumTemplates.slice(0, 3))], rng);
  }

  switch (style) {
    case "pace": return pick(paceTemplates, rng);
    case "spin": return pick(spinTemplates, rng);
    case "medium": return pick(mediumTemplates, rng);
    default: return pick([...paceTemplates.slice(0, 3), ...spinTemplates.slice(0, 2)], rng);
  }
}

function generateSingleCommentary(prefix: string, batter: string, bowler: string, style: BowlingStyleCategory, rng: RNG = Math.random): string {
  const templates = [
    `${prefix}, 1 run. Worked away to midwicket for a single`,
    `${prefix}, 1 run. Nudged to the leg side, quick single taken`,
    `${prefix}, 1 run. Pushed to cover, they take the run`,
    `${prefix}, 1 run. Tapped to mid-on, easy single`,
    `${prefix}, 1 run. Deft touch to third man, rotates the strike`,
    `${prefix}, 1 run. Turned off the pads, single to fine leg`,
  ];

  const spinSingles = [
    `${prefix}, 1 run. Swept fine, they scamper through for one`,
    `${prefix}, 1 run. Works it off the back foot to midwicket`,
    `${prefix}, 1 run. Uses the crease well, dabbed to point for a single`,
  ];

  if (style === "spin") return pick([...templates, ...spinSingles], rng);
  return pick(templates, rng);
}

function generateTwoCommentary(prefix: string, batter: string, _bowler: string, rng: RNG = Math.random): string {
  return pick([
    `${prefix}, 2 runs. Pushed into the gap, they come back for two`,
    `${prefix}, 2 runs. Driven wide of mid-off, good running between the wickets`,
    `${prefix}, 2 runs. Worked square, misfield and they get a second`,
    `${prefix}, 2 runs. Placed through the covers, excellent running`,
    `${prefix}, 2 runs. Pulled to deep midwicket, comfortable two`,
  ], rng);
}

function generateThreeCommentary(prefix: string, batter: string, _bowler: string, rng: RNG = Math.random): string {
  return pick([
    `${prefix}, 3 runs. Driven to the deep, misfield and they get three!`,
    `${prefix}, 3 runs. Placed into the gap, excellent running gets them back for the third`,
    `${prefix}, 3 runs. Sliced to the deep, slight fumble allows the third`,
    `${prefix}, 3 runs. Lofted just short of the fielder, three taken with sharp running`,
  ], rng);
}

function generateFourCommentary(
  prefix: string, batter: string, bowler: string,
  style: BowlingStyleCategory, phase: string, boundaryShot?: string, rng: RNG = Math.random,
): string {
  const shot = boundaryShot ?? "races away to the boundary";

  const templates = [
    `${prefix}, FOUR! ${shot}!`,
    `${prefix}, FOUR! That races away to the boundary!`,
    `${prefix}, FOUR! Beautiful shot by ${batter}! ${shot}`,
    `${prefix}, FOUR! Poor delivery and ${batter} makes it pay, ${shot}`,
  ];

  const deathFours = [
    `${prefix}, FOUR! ${batter} finds the gap in the death, ${shot}!`,
    `${prefix}, FOUR! Full toss, put away by ${batter}! ${shot}`,
    `${prefix}, FOUR! Fails to nail the yorker, ${batter} slams it away!`,
  ];

  const powerplayFours = [
    `${prefix}, FOUR! Fielding restrictions help, ${shot}!`,
    `${prefix}, FOUR! ${batter} takes advantage of the powerplay, ${shot}!`,
  ];

  if (phase === "death") return pick([...templates, ...deathFours], rng);
  if (phase === "powerplay") return pick([...templates, ...powerplayFours], rng);
  return pick(templates, rng);
}

function generateSixCommentary(
  prefix: string, batter: string, bowler: string,
  style: BowlingStyleCategory, phase: string, boundaryShot?: string, rng: RNG = Math.random,
): string {
  const shot = boundaryShot ?? "launched into the stands";

  const templates = [
    `${prefix}, SIX! ${shot}!`,
    `${prefix}, SIX! What a shot! That's massive!`,
    `${prefix}, SIX! ${batter} clears the boundary with ease!`,
    `${prefix}, SIX! ${shot}! ${batter} is in destructive mode!`,
  ];

  const deathSixes = [
    `${prefix}, SIX! WHAT A HIT! ${batter} launches it out of the ground!`,
    `${prefix}, SIX! That's enormous! ${batter} goes big in the death overs!`,
    `${prefix}, SIX! ${bowler} will want to forget that delivery, ${shot}!`,
  ];

  const spinSixes = [
    `${prefix}, SIX! Steps out and clears the boundary! ${shot}!`,
    `${prefix}, SIX! Down the track and ${shot}! ${batter} reads the spin perfectly!`,
  ];

  if (phase === "death") return pick([...templates, ...deathSixes], rng);
  if (style === "spin") return pick([...templates, ...spinSixes], rng);
  return pick(templates, rng);
}

function generateWicketCommentary(
  prefix: string, batter: string, bowler: string,
  style: BowlingStyleCategory,
  wicketType?: string, fielderName?: string,
  batterRuns?: number, batterBalls?: number, rng: RNG = Math.random,
): string {
  const isDuck = (batterRuns ?? 0) === 0;
  const isSetBatter = (batterRuns ?? 0) >= 30;
  const wasOnFifty = (batterRuns ?? 0) >= 40 && (batterRuns ?? 0) < 50;

  // Wicket-type specific commentary
  switch (wicketType) {
    case "bowled": {
      const templates = [
        `${prefix}, OUT! Bowled 'em! ${bowler} knocks over the stumps, ${batter} has to go!`,
        `${prefix}, OUT! Cleaned up! The stumps are rattled, ${batter} departs!`,
        `${prefix}, OUT! Through the gate! ${bowler} bowls a beauty to castle ${batter}!`,
        `${prefix}, OUT! The middle stump is out of the ground! ${batter} is bowled!`,
      ];
      if (style === "spin") templates.push(
        `${prefix}, OUT! Turns and hits the top of off! ${batter} beaten by the spin!`,
      );
      if (style === "pace") templates.push(
        `${prefix}, OUT! Too quick! Crashes into the stumps before ${batter} can react!`,
      );
      return addWicketContext(pick(templates), batter, isDuck, isSetBatter, wasOnFifty);
    }

    case "caught": {
      const catcher = fielderName ?? "the fielder";
      const templates = [
        `${prefix}, OUT! Caught! ${batter} holes out to ${catcher}, ${bowler} strikes!`,
        `${prefix}, OUT! In the air... taken! ${catcher} pouches it, ${batter} has to walk!`,
        `${prefix}, OUT! Goes for the big shot but only finds ${catcher}! ${bowler} is pumped!`,
        `${prefix}, OUT! Caught by ${catcher}! ${batter} goes for the glory shot and pays the price!`,
      ];
      return addWicketContext(pick(templates), batter, isDuck, isSetBatter, wasOnFifty);
    }

    case "lbw": {
      const templates = [
        `${prefix}, OUT! LBW! Struck on the pads, the finger goes up! ${batter} departs!`,
        `${prefix}, OUT! Trapped in front! Dead plumb LBW, ${batter} has to go!`,
        `${prefix}, OUT! Huge appeal for LBW and it's given! ${bowler} gets the breakthrough!`,
      ];
      if (style === "spin") templates.push(
        `${prefix}, OUT! Spins back in and traps ${batter} on the crease! LBW!`,
      );
      return addWicketContext(pick(templates), batter, isDuck, isSetBatter, wasOnFifty);
    }

    case "run_out": {
      const templates = [
        `${prefix}, OUT! Run out! Terrible mix-up between the batters, ${batter} is short!`,
        `${prefix}, OUT! Direct hit! ${batter} was scrambling and the throw finds the stumps!`,
        `${prefix}, OUT! Run out! Brilliant fielding, ${batter} was well short of the crease!`,
      ];
      return addWicketContext(pick(templates), batter, isDuck, isSetBatter, wasOnFifty);
    }

    case "stumped": {
      const keeper = fielderName ?? "the keeper";
      const templates = [
        `${prefix}, OUT! Stumped! ${batter} comes down the track and misses, ${keeper} does the rest!`,
        `${prefix}, OUT! Quick as a flash, ${keeper} whips off the bails! ${batter} is stumped!`,
        `${prefix}, OUT! Down the pitch and beaten in the flight! Stumped by ${keeper}!`,
      ];
      return addWicketContext(pick(templates), batter, isDuck, isSetBatter, wasOnFifty);
    }

    default: {
      const templates = [
        `${prefix}, OUT! ${bowler} strikes! ${batter} has to go!`,
        `${prefix}, OUT! Big wicket! ${batter} departs!`,
        `${prefix}, OUT! Breakthrough! That's the end of ${batter}!`,
      ];
      return addWicketContext(pick(templates), batter, isDuck, isSetBatter, wasOnFifty);
    }
  }
}

function addWicketContext(base: string, batter: string, isDuck: boolean, isSetBatter: boolean, wasOnFifty: boolean): string {
  if (isDuck) return base + ` A duck for ${batter}!`;
  if (wasOnFifty) return base + ` Agonisingly close to a fifty!`;
  if (isSetBatter) return base + ` Crucial wicket, ${batter} was well set!`;
  return base;
}

function generateWideCommentary(prefix: string, _batter: string, bowler: string, style: BowlingStyleCategory): string {
  const templates = [
    `${prefix}, wide. Straying down the leg side`,
    `${prefix}, wide. Too far outside off, the umpire signals`,
    `${prefix}, wide. Drifts too wide, extra run added`,
    `${prefix}, wide. ${bowler} loses the line, one run added`,
  ];

  if (style === "pace") templates.push(
    `${prefix}, wide. Fires it down the leg side, ${bowler} needs to tighten up`,
  );
  if (style === "spin") templates.push(
    `${prefix}, wide. Drifts too far, the umpire has no hesitation`,
  );

  return pick(templates);
}

function generateNoBallCommentary(prefix: string, _batter: string, bowler: string): string {
  return pick([
    `${prefix}, no ball! Overstepped, free hit coming up`,
    `${prefix}, no ball! Front foot no ball, one extra. ${bowler} needs to watch the crease`,
    `${prefix}, no ball! That's a freebie, ${bowler} overstepped the mark`,
    `${prefix}, no ball! The umpire checks... yes, overstep. Free hit next ball!`,
  ]);
}

function generateLegbyeCommentary(prefix: string, batter: string, _bowler: string, style: BowlingStyleCategory): string {
  const templates = [
    `${prefix}, leg bye. Off the pad, they scamper through for one`,
    `${prefix}, leg bye. Flicked off the thigh pad`,
    `${prefix}, leg bye. Hit on the pads, ${batter} calls for the run`,
    `${prefix}, leg bye. Struck on the body, single taken off the pads`,
  ];

  if (style === "spin") templates.push(
    `${prefix}, leg bye. Turns past the bat and off the pad`,
  );

  return pick(templates);
}
