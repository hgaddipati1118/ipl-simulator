/**
 * Rich contextual ball-by-ball commentary engine.
 *
 * Replaces the simple per-outcome templates with context-aware commentary
 * that considers bowling style, match situation, milestones, and phase.
 */

import type { RNG } from "./rng.js";
import { hasCommentaryModel, pickModelCommentary, type ModelPick } from "./commentary-model.js";
import type { DeliveryDetail } from "./delivery-rules.js";
import { describeDelivery } from "./delivery-text.js";
import { specialPlayTail, specialPlayText } from "./special-plays.js";

type BowlingStyleCategory = "pace" | "spin" | "medium" | "unknown";

function classifyBowlingStyle(bowlingStyle?: string): BowlingStyleCategory {
  if (!bowlingStyle) return "unknown";
  if (["right-arm-fast", "right-arm-fast-medium", "left-arm-fast", "left-arm-fast-medium"].includes(bowlingStyle)) return "pace";
  if (["right-arm-medium-fast", "right-arm-medium", "left-arm-medium-fast", "left-arm-medium", "right-arm-slow", "left-arm-slow"].includes(bowlingStyle)) return "medium";
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
  /** Batter's hand ("right" | "left"); lets the corpus model pick off-side / leg-side lines that fit */
  battingHand?: string;
  /** Women's matches say she/her */
  gender?: "male" | "female";
  /** The batter at the other end, for corpus lines that mention them */
  nonStrikerName?: string;
  /** Corpus lines already used in this match (keys returned by generateBallCommentaryDetailed); never repeated */
  usedLines?: Readonly<Record<string, unknown>>;
}

export interface BallCommentaryResult {
  text: string;
  /** Key of the corpus line used (undefined for the built-in lines); remember it in usedLines */
  key?: string;
}

const OUTCOME_LABEL: Record<string, string> = {
  dot: "no run.", "1": "1 run.", "2": "2 runs.", "3": "3 runs.", "4": "FOUR!", "6": "SIX!", wicket: "OUT!",
  wide: "wide.", noball: "no ball!", legbye: "leg bye.",
};

export function generateBallCommentary(params: BallCommentaryParams): string {
  return generateBallCommentaryDetailed(params).text;
}

export function generateBallCommentaryDetailed(params: BallCommentaryParams): BallCommentaryResult {
  // Corpus line (real commentary turned into templates), when a model is loaded and has a fit
  const picked = hasCommentaryModel() && OUTCOME_LABEL[params.outcome]
    ? pickModelCommentary({
      outcome: params.outcome, wicketType: params.wicketType, bowlingStyle: params.bowlingStyle, battingHand: params.battingHand,
      over: params.over, ball: params.ball, score: params.score, wickets: params.wickets,
      isSecondInnings: params.isSecondInnings, target: params.target, gender: params.gender, batterName: params.batterName,
      bowlerName: params.bowlerName, fielderName: params.fielderName, nonStrikerName: params.nonStrikerName,
    }, params.rng ?? Math.random, params.usedLines)
    : null;
  return composeBallCommentary(params, picked);
}

interface ComposeOptions {
  /** Do not add "a duck for X" / "well set" to a wicket (the striker is not the batter who is out) */
  noWicketContext?: boolean;
}

/** Wrap a corpus pick (or, with none, the built-in lines) in the prefix, the outcome label and the milestone / chase / powerplay suffixes */
function composeBallCommentary(params: BallCommentaryParams, picked: ModelPick | null, opts: ComposeOptions = {}): BallCommentaryResult {
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
  let lineKey: string | undefined;

  if (picked) {
    lineKey = picked.key;
    commentary = `${prefix}, ${OUTCOME_LABEL[outcome]} ${/[.!?…]$/.test(picked.text) ? picked.text : picked.text + "."}`;
    if (outcome === "wicket" && !opts.noWicketContext) {
      commentary = addWicketContext(commentary, batter, batterRuns === 0, batterRuns >= 30, batterRuns >= 40 && batterRuns < 50);
    }
  } else switch (outcome) {
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

  return { text: commentary + milestone + chaseSuffix + powerplaySuffix, key: lineKey };
}

/* ─────────────────── Any delivery: the full-Laws entry point ─────────────────── */

export interface DeliveryCommentaryParams {
  /** The complete delivery (DeliveryDetail from delivery-rules.ts expandDelivery) */
  detail: DeliveryDetail;
  bowlerName: string;
  /** The striker: who played (or missed) the ball. NOT necessarily the batter who is out. */
  batterName: string;
  nonStrikerName?: string;
  /** Catch / stumping / throw. The bowler for a caught and bowled is not needed. */
  fielderName?: string;
  /** Second fielder of a relay run out ("A to B") */
  fielder2Name?: string;
  /** The fielder is a substitute ("substitute X"); defaults to detail.dismissal.substitute */
  substitute?: boolean;
  /** This ball is a free hit: every line says so */
  freeHit?: boolean;
  /** No delivery was bowled (a Mankad) */
  deadBall?: boolean;
  over: number;
  /** 1-based legal ball of the over this delivery belongs to */
  ball: number;
  score: number;
  wickets: number;
  isSecondInnings: boolean;
  target?: number;
  bowlingStyle?: string;
  battingHand?: string;
  gender?: "male" | "female";
  batterRuns?: number;
  batterBalls?: number;
  boundaryShot?: string;
  rng?: RNG;
  /** Corpus lines already used in this match; never repeated */
  usedLines?: Readonly<Record<string, unknown>>;
}

type LegacyKind = NonNullable<BallCommentaryParams["wicketType"]>;
const LEGACY_KINDS: readonly string[] = ["bowled", "caught", "lbw", "run_out", "stumped"];

interface CorpusRoute {
  outcome: string;
  wicketType?: string;
  outNonStriker: boolean;
  textFilter?: (t: string) => boolean;
  /** The built-in lines in this file say the right thing when the corpus has no fit */
  legacy: boolean;
}

/** A catch in the deep / on the rope */
const DEEP = /\b(rope|boundary|deep|long[- ]?(on|off|leg)|sweeper|cow corner|third man|fine leg)\b/i;

/** A substitute fielder must be named ("substitute X"), so only templates that name the fielder qualify */
const NAMES_FIELDER = (t: string) => t.includes("{fielder}");

/** Which deliveries the corpus model (and, failing that, the built-in lines) describes fully; null = hand-written lines only */
function corpusRoute(p: DeliveryCommentaryParams): CorpusRoute | null {
  const d = p.detail;
  const dis = d.dismissal;
  if (d.overthrow || d.penalty) return null;
  if (dis) {
    if (d.outcome !== "wicket") return null; // a dismissal on a wide / no-ball
    const k = dis.kind;
    const nsOut = dis.out === "nonStriker";
    if (nsOut && k !== "run_out") return null;
    if (k === "caught_and_bowled") return { outcome: "wicket", wicketType: k, outNonStriker: false, legacy: false };
    if (k === "run_out") {
      if (p.fielder2Name) return null; // two fielders: the hand-written line names both
      const sub = p.substitute ?? dis.substitute ?? false;
      return { outcome: "wicket", wicketType: k, outNonStriker: nsOut, legacy: false, textFilter: sub ? NAMES_FIELDER : undefined };
    }
    if (k === "bowled" || k === "caught" || k === "lbw" || k === "stumped") {
      const sub = p.substitute ?? dis.substitute ?? false;
      if (k === "caught" && d.relayFielderId) return null; // a relay catch names both fielders: hand-written
      if (k === "caught" && d.boundaryCatch) {
        // a catch on the rope: only corpus lines that say it was in the deep (the hand-written tail says it otherwise)
        return { outcome: "wicket", wicketType: k, outNonStriker: false, legacy: !sub, textFilter: (t) => DEEP.test(t) && (!sub || NAMES_FIELDER(t)) };
      }
      return { outcome: "wicket", wicketType: k, outNonStriker: false, legacy: !(k === "caught" && sub), textFilter: k === "caught" && sub ? NAMES_FIELDER : undefined };
    }
    return null;
  }
  switch (d.outcome) {
    case "dot": case "1": case "2": case "3": case "4": case "6":
      return { outcome: d.outcome, outNonStriker: false, legacy: true };
    case "wide": {
      if (d.wides !== 1 || d.wideKind === "height") return null;
      const leg = /\bleg\b/i;
      return { outcome: "wide", outNonStriker: false, legacy: false, textFilter: d.wideKind === "leg" ? (t) => leg.test(t) : (t) => !/\b(leg|head|height|bouncer)\b/i.test(t) };
    }
    case "legbye":
      return d.byes === 0 && d.legByes === 1 ? { outcome: "legbye", outNonStriker: false, legacy: true } : null;
    default:
      return null;
  }
}

/**
 * The commentary line for ANY delivery the engines can produce: every dismissal kind with the right batter out (a
 * non-striker run out names the non-striker; the striker played the shot), caught and bowled, substitute and relay
 * fielders, wides of 1 to 5 by kind, no-balls with their runs and cost, byes / leg byes of 1 to 5, overthrows, penalty
 * runs, free hits, the Mankad.
 *
 * Plain deliveries and the common dismissals draw a corpus line when the model has an unused fitting one (docs/COMMENTARY.md);
 * everything else, and every case the corpus cannot say truthfully, uses the hand-written lines in delivery-text.ts.
 * Only the bowler, striker, non-striker and the named fielders are ever mentioned. Uses only `rng` (never the simulation's
 * stream) and returns the corpus key to remember in `usedLines`.
 */
export function generateDeliveryCommentary(p: DeliveryCommentaryParams): BallCommentaryResult {
  const r = generateDeliveryCommentaryBase(p);
  // Section 13 plays: no-ball reasons and beamers, boundary / relay catches (unless the corpus line already says so), illegal fielding
  const d = p.detail;
  const names = { bowler: p.bowlerName, batter: p.batterName, fielder: p.fielderName, fielder2: p.fielder2Name };
  const tailDetail = d.boundaryCatch && r.key && !d.relayFielderId ? { ...d, boundaryCatch: false } : d;
  const tail = specialPlayTail(tailDetail, names, p.rng ?? Math.random);
  return tail ? { ...r, text: r.text + tail } : r;
}

function generateDeliveryCommentaryBase(p: DeliveryCommentaryParams): BallCommentaryResult {
  const d = p.detail;
  const dis = d.dismissal;
  const rng = p.rng ?? Math.random;
  const freeHit = !!p.freeHit;
  const sub = p.substitute ?? dis?.substitute ?? false;
  const withFreeHit = (r: BallCommentaryResult): BallCommentaryResult =>
    freeHit && !r.text.startsWith("FREE HIT") ? { ...r, text: "FREE HIT! " + r.text } : r;

  // Short runs, a ball lodged in the helmet, misfields and sixes saved on the rope: hand-written (the corpus has a handful at most)
  if (!dis && (d.sixSaved || d.shortRun || d.lodged || d.misfield)) {
    const t = specialPlayText(d, { bowler: p.bowlerName, batter: p.batterName, fielder: p.fielderName }, rng);
    if (t) return withFreeHit({ text: t });
  }

  const route = p.deadBall ? null : corpusRoute(p);
  if (route) {
    const nsOut = route.outNonStriker;
    const fielderForLine = dis && dis.kind !== "caught_and_bowled" ? p.fielderName : undefined;
    const picked = hasCommentaryModel()
      ? pickModelCommentary({
        outcome: route.outcome, wicketType: route.wicketType, bowlingStyle: p.bowlingStyle, battingHand: p.battingHand,
        over: p.over, ball: p.ball, score: p.score, wickets: p.wickets, isSecondInnings: p.isSecondInnings, target: p.target,
        gender: p.gender, batterName: p.batterName, bowlerName: p.bowlerName, fielderName: fielderForLine,
        nonStrikerName: p.nonStrikerName, outNonStriker: nsOut, substitute: sub, textFilter: route.textFilter,
      }, rng, p.usedLines)
      : null;
    if (picked || route.legacy) {
      const wt = route.wicketType && LEGACY_KINDS.includes(route.wicketType) ? (route.wicketType as LegacyKind) : undefined;
      const base: BallCommentaryParams = {
        bowlerName: p.bowlerName, batterName: p.batterName, outcome: route.outcome, runs: d.batRuns, over: p.over, ball: p.ball,
        score: p.score, wickets: p.wickets, isSecondInnings: p.isSecondInnings, target: p.target, bowlingStyle: p.bowlingStyle,
        batterRuns: p.batterRuns, batterBalls: p.batterBalls, wicketType: wt, fielderName: fielderForLine, boundaryShot: p.boundaryShot,
        rng, battingHand: p.battingHand, gender: p.gender, nonStrikerName: p.nonStrikerName, usedLines: p.usedLines,
      };
      const r = withFreeHit(composeBallCommentary(base, picked, { noWicketContext: nsOut }));
      // a wide bowled on a free hit leaves the free hit for the next ball
      return freeHit && d.outcome === "wide" ? { ...r, text: r.text + " The free hit stays for the next ball." } : r;
    }
  }

  // Hand-written lines
  const batter = p.batterName;
  const batterRuns = p.batterRuns ?? 0;
  const batterBalls = p.batterBalls ?? 0;
  let text = describeDelivery({
    detail: d, bowler: p.bowlerName, batter, nonStriker: p.nonStrikerName, fielder: p.fielderName, fielder2: p.fielder2Name,
    substitute: sub, freeHit, deadBall: p.deadBall, rng,
  });
  if (text === undefined) {
    // an ordinary delivery nothing above handled (cannot normally happen): the built-in line
    return withFreeHit(composeBallCommentary({
      bowlerName: p.bowlerName, batterName: batter, outcome: d.outcome, runs: d.batRuns, over: p.over, ball: p.ball, score: p.score,
      wickets: p.wickets, isSecondInnings: p.isSecondInnings, target: p.target, bowlingStyle: p.bowlingStyle, batterRuns, batterBalls,
      rng, battingHand: p.battingHand, gender: p.gender, nonStrikerName: p.nonStrikerName, boundaryShot: p.boundaryShot,
    }, null));
  }
  if (!p.deadBall) {
    const teamRuns = d.batRuns + d.extras;
    const strikerOut = !!dis && dis.out === "striker" && dis.kind !== "retired_out" && dis.kind !== "timed_out";
    if (strikerOut) {
      const total = batterRuns + d.batRuns;
      text = addWicketContext(text, batter, total === 0, total >= 30, total >= 40 && total < 50);
    } else if (!dis) {
      if (batterRuns + d.batRuns >= 100 && batterRuns < 100) text += ` That's a CENTURY for ${batter}! What an innings!`;
      else if (batterRuns + d.batRuns >= 50 && batterRuns < 50) text += ` FIFTY for ${batter}! Well-played half-century!`;
    }
    if (p.isSecondInnings && p.target && p.target > p.score) {
      const need = p.target - p.score - teamRuns;
      if (need > 0 && need <= 30) text += ` Need ${need} more to win.`;
    }
    if (d.legal && p.over === 5 && p.ball >= 6) text += ` That's the end of the powerplay, ${p.score + teamRuns}/${p.wickets + (dis ? 1 : 0)} after 6 overs.`;
  }
  return { text };
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
      return addWicketContext(pick(templates, rng), batter, isDuck, isSetBatter, wasOnFifty);
    }

    case "caught": {
      const catcher = fielderName ?? "the fielder";
      const templates = [
        `${prefix}, OUT! Caught! ${batter} holes out to ${catcher}, ${bowler} strikes!`,
        `${prefix}, OUT! In the air... taken! ${catcher} pouches it, ${batter} has to walk!`,
        `${prefix}, OUT! Goes for the big shot but only finds ${catcher}! ${bowler} is pumped!`,
        `${prefix}, OUT! Caught by ${catcher}! ${batter} goes for the glory shot and pays the price!`,
      ];
      return addWicketContext(pick(templates, rng), batter, isDuck, isSetBatter, wasOnFifty);
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
      return addWicketContext(pick(templates, rng), batter, isDuck, isSetBatter, wasOnFifty);
    }

    case "run_out": {
      const templates = [
        `${prefix}, OUT! Run out! Terrible mix-up between the batters, ${batter} is short!`,
        `${prefix}, OUT! Direct hit! ${batter} was scrambling and the throw finds the stumps!`,
        `${prefix}, OUT! Run out! Brilliant fielding, ${batter} was well short of the crease!`,
      ];
      return addWicketContext(pick(templates, rng), batter, isDuck, isSetBatter, wasOnFifty);
    }

    case "stumped": {
      const keeper = fielderName ?? "the keeper";
      const templates = [
        `${prefix}, OUT! Stumped! ${batter} comes down the track and misses, ${keeper} does the rest!`,
        `${prefix}, OUT! Quick as a flash, ${keeper} whips off the bails! ${batter} is stumped!`,
        `${prefix}, OUT! Down the pitch and beaten in the flight! Stumped by ${keeper}!`,
      ];
      return addWicketContext(pick(templates, rng), batter, isDuck, isSetBatter, wasOnFifty);
    }

    default: {
      const templates = [
        `${prefix}, OUT! ${bowler} strikes! ${batter} has to go!`,
        `${prefix}, OUT! Big wicket! ${batter} departs!`,
        `${prefix}, OUT! Breakthrough! That's the end of ${batter}!`,
      ];
      return addWicketContext(pick(templates, rng), batter, isDuck, isSetBatter, wasOnFifty);
    }
  }
}

function addWicketContext(base: string, batter: string, isDuck: boolean, isSetBatter: boolean, wasOnFifty: boolean): string {
  if (isDuck) return base + ` A duck for ${batter}!`;
  if (wasOnFifty) return base + ` Agonisingly close to a fifty!`;
  if (isSetBatter) return base + ` Crucial wicket, ${batter} was well set!`;
  return base;
}

function generateWideCommentary(prefix: string, _batter: string, bowler: string, style: BowlingStyleCategory, rng: RNG = Math.random): string {
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

  return pick(templates, rng);
}

function generateNoBallCommentary(prefix: string, _batter: string, bowler: string, rng: RNG = Math.random): string {
  return pick([
    `${prefix}, no ball! Overstepped, free hit coming up`,
    `${prefix}, no ball! Front foot no ball, one extra. ${bowler} needs to watch the crease`,
    `${prefix}, no ball! That's a freebie, ${bowler} overstepped the mark`,
    `${prefix}, no ball! The umpire checks... yes, overstep. Free hit next ball!`,
  ], rng);
}

function generateLegbyeCommentary(prefix: string, batter: string, _bowler: string, style: BowlingStyleCategory, rng: RNG = Math.random): string {
  const templates = [
    `${prefix}, leg bye. Off the pad, they scamper through for one`,
    `${prefix}, leg bye. Flicked off the thigh pad`,
    `${prefix}, leg bye. Hit on the pads, ${batter} calls for the run`,
    `${prefix}, leg bye. Struck on the body, single taken off the pads`,
  ];

  if (style === "spin") templates.push(
    `${prefix}, leg bye. Turns past the bat and off the pad`,
  );

  return pick(templates, rng);
}
