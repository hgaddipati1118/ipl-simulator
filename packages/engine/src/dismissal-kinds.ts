/**
 * Dismissal kinds, the Laws' legality matrix, the scorecard text and test overrides. A leaf module (no engine imports)
 * shared by fielding.ts and delivery-rules.ts.
 */

export type Gender = "male" | "female";

/** Every way a batter can be given out. `retired_out` and `timed_out` happen between balls. */
export type DismissalKind =
  | "bowled"
  | "caught"
  | "caught_and_bowled"
  | "lbw"
  | "run_out"
  | "stumped"
  | "hit_wicket"
  | "obstructing_the_field"
  | "handled_the_ball"
  | "hit_the_ball_twice"
  | "timed_out"
  | "retired_out";

export const DISMISSAL_KINDS: readonly DismissalKind[] = [
  "bowled", "caught", "caught_and_bowled", "lbw", "run_out", "stumped", "hit_wicket",
  "obstructing_the_field", "handled_the_ball", "hit_the_ball_twice", "timed_out", "retired_out",
];

/** Kinds that happen on a delivery (the engine's "wicket" draw); timed out and retired out do not. */
export const DELIVERY_DISMISSALS: readonly DismissalKind[] = [
  "bowled", "caught", "caught_and_bowled", "lbw", "run_out", "stumped", "hit_wicket",
  "obstructing_the_field", "handled_the_ball", "hit_the_ball_twice",
];

/** Kinds credited to the bowler (Law 21.? / ICC statistics: not run out, obstructing, handled, hit twice, timed out, retired). */
export function isBowlerWicket(kind: DismissalKind | undefined): boolean {
  return kind === "bowled" || kind === "caught" || kind === "caught_and_bowled" || kind === "lbw" || kind === "stumped" || kind === "hit_wicket";
}

/** A wicket (counts towards the 10) as opposed to a retirement. Timed out is a wicket; retired out / hurt are not. */
export function countsAsWicket(kind: DismissalKind | undefined): boolean {
  return kind !== undefined && kind !== "retired_out";
}

export type DeliveryClass = "legal" | "wide" | "noBall";

/**
 * Which kinds can dismiss a batter on a delivery (Laws 22, 21, 41; T20 free hit):
 *  - legal ball: everything that happens on a delivery;
 *  - wide: stumped, hit wicket, run out, obstructing, handled, hit twice (not bowled, caught, lbw);
 *  - no-ball and free hit: only run out, obstructing the field, handled the ball, hit the ball twice.
 */
export function canDismiss(kind: DismissalKind, cls: DeliveryClass, freeHit: boolean): boolean {
  if (kind === "timed_out" || kind === "retired_out") return false;
  const always = kind === "run_out" || kind === "obstructing_the_field" || kind === "handled_the_ball" || kind === "hit_the_ball_twice";
  if (always) return true;
  if (cls === "noBall" || freeHit) return false;
  if (cls === "wide") return kind === "stumped" || kind === "hit_wicket";
  return true;
}

/** The Laws' other limits on a delivery's dismissal set, for tests and callers. */
export function legalDismissals(cls: DeliveryClass, freeHit: boolean): DismissalKind[] {
  return DELIVERY_DISMISSALS.filter(k => canDismiss(k, cls, freeHit));
}

export interface RuleOverrides {
  /** Every delivery dismissal draw has this kind (as long as it is legal on the ball) */
  forceKind?: DismissalKind;
  /** Who a run out dismisses: the striker or the non-striker */
  forceRunOutRole?: "striker" | "nonStriker";
  /** Runs completed on a run-out ball */
  forceRunOutRuns?: number;
  hurtPerBatterBall?: number;
  returnProb?: number;
  retiredOutPerInning?: number;
  timedOutPerWicket?: number;
  mankadPerDelivery?: number;
  penaltyPerDelivery?: number;
  bowlerLeavesPerOver?: number;
  overthrowBoundaryAfterRun?: number;
  overthrowBoundaryAfterDot?: number;
  /** Probability that a wicket draw is on a substitute fielder */
  substituteShare?: number;
  // section 13 plays (special-plays.ts, drs.ts)
  shortRunPerDelivery?: number;
  lodgedPerDelivery?: number;
  misfieldPerDelivery?: number;
  sixSavedShare?: number;
  boundaryCatchShare?: number;
  relayCatchShare?: number;
  /** Every height no-ball is a beamer */
  forceBeamer?: boolean;
  /** Share of no-balls (multiplies the base no-ball probability) */
  noBallRateFactor?: number;
  overRatePenaltyPerInnings?: number;
  /** Rain: p(no result) and p(reduced) per match, overriding the league's fitted rates */
  rainNoResult?: number;
  rainReduced?: number;
  /** DRS: multiply every review rate */
  drsRateFactor?: number;
  /** Every delivery's coarse outcome (tests: forcing a tie, a no-ball ...) */
  forceCoarseOutcome?: "dot" | "1" | "2" | "3" | "4" | "6" | "wicket" | "wide" | "noball" | "legbye";
  /** forceCoarseOutcome leaves super overs alone (a forced tie, then real super overs) */
  forceOutcomeSparesSuperOver?: boolean;
}

let overrides: RuleOverrides = {};

/** Test hook: replace rates / force outcomes. `null` clears. Never used by the game. */
export function setRuleOverrides(o: RuleOverrides | null): void {
  overrides = o ?? {};
}

export function ruleOverrides(): Readonly<RuleOverrides> {
  return overrides;
}

export interface DismissalTextInput {
  kind: DismissalKind;
  bowler?: string;
  fielder?: string;
  fielder2?: string;
  substitute?: boolean;
}

/** The scorecard "how out" text, as Cricinfo prints it */
export function dismissalText(i: DismissalTextInput): string {
  const b = i.bowler ?? "unknown";
  const f = i.fielder ? (i.substitute ? `sub (${i.fielder})` : i.fielder) : undefined;
  switch (i.kind) {
    case "bowled": return `b ${b}`;
    case "caught": return `c ${f ?? "fielder"} b ${b}`;
    case "caught_and_bowled": return `c & b ${b}`;
    case "lbw": return `lbw b ${b}`;
    case "stumped": return `st ${f ?? "keeper"} b ${b}`;
    case "hit_wicket": return `hit wicket b ${b}`;
    case "run_out": {
      const names = [i.fielder ? (i.substitute ? `sub (${i.fielder})` : i.fielder) : undefined, i.fielder2].filter(Boolean);
      return names.length > 0 ? `run out (${names.join("/")})` : "run out";
    }
    case "obstructing_the_field": return "obstructing the field";
    case "handled_the_ball": return "handled the ball";
    case "hit_the_ball_twice": return "hit the ball twice";
    case "timed_out": return "timed out";
    case "retired_out": return "retired out";
  }
}

export const RETIRED_HURT_TEXT = "retired hurt";
