/**
 * Test cricket: two innings a side over up to five days of 90 six-ball overs (women's Tests: four days of 100), three
 * sessions a day, the new ball after 80 overs, declarations, the follow-on, draws when time runs out, ties, DRS (three
 * unsuccessful reviews per innings), time lost to weather and bad light, pitch wear and toss decisions (docs/FORMATS-TEST.md).
 *
 * The ball model and every team decision are fitted from Cricsheet Tests (test-model-data.ts, built by
 * packages/ratings/src/analysis/test-match-model.py). Per delivery, each outcome class (1, 2, 3, 4, 6, wicket, wide,
 * no-ball, bye / leg bye) has a base rate times multiplicative factors for ball age, the batter's balls faced, innings,
 * day x pace / spin, the bowler's over in his spell, the situation (pushing to declare, a 4th-innings chase, blocking for a
 * draw), home / away, the host country x pace / spin, the match's own conditions (drawn per match), and the batter and
 * bowler (their ratings mapped onto the fitted player terms); the dot ball is what is left.
 *
 * One serialisable state machine (TestMatchState) runs both the instant simulation (simulateTestMatch) and the live driver
 * (test-live.ts). The state mutates in place: a Test has ~1,800 deliveries and copying it on every ball would be quadratic.
 * Its random stream is part of the state, so a saved match resumes exactly where it stopped.
 *
 * Reused engine pieces: the fielding unit and catch / stumping / run-out conversion (fielding.ts), run-out batter and
 * fielders (delivery-rules.ts), dismissal text (dismissal-kinds.ts), DRS review records and their commentary (drs.ts),
 * delivery commentary (commentary.ts), the post-match injury model with its Test multiplier (injury.ts), Player.forFormat.
 */

import { Player, type PlayerRatings } from "./player.js";
import type { Team } from "./team.js";
import type { RNG } from "./rng.js";
import { randomSeed } from "./rng.js";
import { TEST_MODEL as M } from "./test-model-data.js";
import {
  CONV as FIELDING_CONV, TEAM_FIELDING_PIVOT, NEUTRAL_FIELDING, buildFieldingUnit, fieldingRating, keepingRating,
  missedChanceOutcome, type FieldingNote, type FieldingUnit,
} from "./fielding.js";
import { pickRunOutBatter, pickRunOutFielders, pickRunOutRuns, type DeliveryDetail } from "./delivery-rules.js";
import { dismissalText, isBowlerWicket, type DismissalKind } from "./dismissal-kinds.js";
import { drsText, type DrsKind, type DrsReview } from "./drs.js";
import { generateDeliveryCommentary } from "./commentary.js";
import { runPostMatchInjuryChecks } from "./injury.js";
import type { BatterInnings, BowlerFigures, InningsScorecard, MatchInjuryEvent } from "./match.js";

// ── Model tables ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Outcome classes in model order; a dot is what is left */
export const TEST_OUTCOMES = ["1", "2", "3", "4", "6", "W", "wide", "nb", "bye"] as const;
export type TestOutcomeClass = (typeof TEST_OUTCOMES)[number] | "dot";
const K = TEST_OUTCOMES.length;
const IW = 5; // index of the wicket class
const SCORING = [0, 1, 2, 3, 4]; // 1, 2, 3, 4, 6
const BAT_TERMS = ["1", "2", "3", "4", "6", "W"] as const;
const BOWL_TERMS = ["1", "2", "3", "4", "6", "W", "wide", "nb"] as const;

type OutcomeTable = Readonly<Record<string, number>>;
const vec = (t: OutcomeTable): number[] => TEST_OUTCOMES.map(k => t[k] ?? 1);
const lv = (t: Readonly<Record<string, readonly number[]>>, n: number): number[][] =>
  Array.from({ length: n }, (_, i) => TEST_OUTCOMES.map(k => t[k]?.[i] ?? 1));

const F = M.factors;
const AGE_BINS: readonly number[] = M.bins.age;
const SET_BINS: readonly number[] = M.bins.set;
const CHASE_BINS: readonly number[] = M.bins.chaseRate;
const T_AGE = lv(F.age, AGE_BINS.length);
const T_SET = lv(F.set, SET_BINS.length);
const T_INN = lv(F.innings, 4);
const T_DAY = { pace: lv(F.day.pace, 5), spin: lv(F.day.spin, 5) };
/**
 * Over of the bowler's spell. The fitted wicket rate rises along a spell (0.96 in the first over to 1.05 in the seventh), but
 * that is selection: captains keep a bowler on while he is threatening. The engine takes the fitted run-rate drift (fatigue)
 * and leaves the wicket rate flat.
 */
const T_SPELL = lv(F.spell, M.bins.spell).map(row => row.map((v, k) => (k === IW ? 1 : v)));
const T_NORMAL = vec(F.situation.normal);
const T_PUSH = vec(F.situation.push);
const T_CHASE = F.situation.chase.map(vec);
const T_HOME = { home: vec(F.home.home), away: vec(F.home.away), neutral: vec(F.home.neutral) };
const T_BAZ = vec(F.bazball);
/** Approach multipliers on top of the situation: attack = the overs before a declaration, defend = blocking a hopeless chase */
const APPROACH_ATTACK = T_PUSH.map((v, k) => v / T_NORMAL[k]);
const APPROACH_DEFEND = T_CHASE[T_CHASE.length - 1].map((v, k) => v / T_CHASE[1][k]);
const BASE = { male: vec(M.base.male), female: vec(M.base.female) };

/** Host countries with their own conditions; anything else plays as "other" */
export const TEST_COUNTRIES = ["IND", "PAK", "SL", "BDESH", "UAE", "AUS", "ENG", "RSA", "NZ", "WI", "ZIM", "IRELAND"] as const;
const SUBCONTINENT = new Set(["IND", "PAK", "SL", "BDESH", "UAE"]);
const COUNTRY_OF: Record<string, string> = {
  India: "IND", England: "ENG", Australia: "AUS", "South Africa": "RSA", "New Zealand": "NZ", Pakistan: "PAK",
  "Sri Lanka": "SL", "West Indies": "WI", Bangladesh: "BDESH", Zimbabwe: "ZIM", Ireland: "IRELAND", Afghanistan: "AFG",
  "United Arab Emirates": "UAE", UAE: "UAE",
};

/** The country code of a team name or country ("India" -> "IND"); unknown names pass through */
export function testCountryCode(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return COUNTRY_OF[name] ?? name;
}

// ── Public types ────────────────────────────────────────────────────────────────────────────────────────────────────

export type TestApproach = "defend" | "normal" | "attack";
export type TestGender = "male" | "female";

export interface TestMatchOptions {
  seed?: number;
  gender?: TestGender;
  /** Host country (IND, ENG, AUS ...): conditions, weather, the toss. Default: the home side's country, else "other" */
  country?: string;
  /** Neither side is at home */
  neutral?: boolean;
  venueName?: string;
  /** Scheduled days (default 5 men, 4 women) and overs per day (90 men, 100 women) */
  days?: number;
  oversPerDay?: number;
  /** Time lost to weather and bad light (default on) */
  weather?: boolean;
  /** DRS: unsuccessful reviews per side per innings (default 3; 0 = no DRS) */
  reviews?: number;
  /** Explicit XIs in batting order, by team id (else picked from the squad on Test ratings) */
  xi?: Record<string, string[]>;
  /** Commentary text on every ball (default: on for live matches, off for instant ones; describeTestBall gives it later) */
  commentary?: boolean;
  /** Post-match injury checks with the Test workload multiplier (default off) */
  injuries?: boolean;
  /** Live: the user's side (decisions pause for it) */
  userTeamId?: string | null;
  /** Bowl England's batting from June 2022 style: the fitted Bazball factor for this team id (default none) */
  bazballTeamId?: string;
}

/** A player as the Test engine sees him: his Test ratings (T20 when he has none) and his fitted outcome multipliers */
export interface TestPlayer {
  id: string;
  name: string;
  role: Player["role"];
  bowlingStyle: Player["bowlingStyle"];
  battingHand: Player["battingHand"];
  isWicketKeeper: boolean;
  spin: boolean;
  /** In the bowling attack (bowlers, all-rounders, batters who bowl); part-timers only bowl when the attack is spent */
  bowler: boolean;
  ratings: PlayerRatings;
  /** Ratings source for the Test view */
  ratingsSource: "test" | "t20";
  /** Multipliers on each outcome class when he bats / bowls (model order) */
  batMul: number[];
  bowlMul: number[];
  /** Batting and bowling quality used for picking XIs, orders and attacks (log-rate units) */
  batValue: number;
  bowlValue: number;
}

export interface TestBatterLine {
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  out: boolean;
  /** Retired hurt and not (yet) back */
  retiredHurt?: boolean;
  kind?: DismissalKind;
  bowlerId?: string;
  fielderId?: string;
  /** Order of arrival (1-based) */
  arrived: number;
}

export interface TestBowlerLine {
  balls: number;
  runs: number;
  wickets: number;
  maidens: number;
  wides: number;
  noBalls: number;
  /** Overs in the current spell, and the spell the captain has in mind for him */
  spellOvers: number;
  spellPlan: number;
  /** Innings over index of his last over (-1 = has not bowled) */
  lastOver: number;
  /** Overs bowled on each day of the match (index day-1), across innings */
  dayOvers?: number[];
}

export interface TestBallEvent {
  inn: number;
  /** Over of the innings (0-based) and legal ball of the over (1-based; an extra carries the ball it precedes) */
  over: number;
  ball: number;
  day: number;
  bowler: string;
  batter: string;
  nonStriker: string;
  outcome: "dot" | "1" | "2" | "3" | "4" | "6" | "wicket" | "wide" | "noball" | "legbye";
  /** Runs off the bat; extras by type (sum in `extras`) */
  runs: number;
  extras: number;
  wides?: number;
  noBalls?: number;
  byes?: number;
  legByes?: number;
  boundary?: 4 | 6;
  isWicket: boolean;
  wicketType?: DismissalKind;
  playerOutId?: string;
  fielderId?: string;
  fielder2Id?: string;
  fieldingNote?: FieldingNote;
  review?: DrsReview;
  /** Innings score after the ball */
  score: number;
  wickets: number;
  commentary?: string;
}

export interface TestInnings {
  number: 1 | 2 | 3 | 4;
  battingTeamId: string;
  bowlingTeamId: string;
  /** This innings is a follow-on */
  followOn?: boolean;
  runs: number;
  wickets: number;
  legalBalls: number;
  extras: { wides: number; noBalls: number; byes: number; legByes: number; penalty: number };
  fours: number;
  sixes: number;
  closed?: "all_out" | "declared" | "target" | "time";
  /** Batting order planned for the innings, and how many have come in */
  order: string[];
  arrived: number;
  strikerId: string;
  nonStrikerId: string;
  batters: Record<string, TestBatterLine>;
  bowlers: Record<string, TestBowlerLine>;
  ballLog: TestBallEvent[];
  fow: { runs: number; wickets: number; balls: number; playerId: string }[];
  /** Innings overs completed when the ball in use was taken (0 = the new ball at the start) */
  ballTakenAt: number;
  newBalls: number;
  /** The fielding side may take the new ball (80 overs with this one) */
  newBallDue?: boolean;
  /** Unsuccessful reviews left */
  drs: { batting: number; fielding: number };
  /** The bowler at each end (the next over is bowled from end `end`) */
  ends: [string | null, string | null];
  end: 0 | 1;
  /** Legal balls and runs charged in the over in progress */
  overBalls: number;
  overRuns: number;
  /** The fielding user picked the next bowler at an end */
  nextBowler?: [string | null, string | null];
  retiredHurt?: string[];
  /** A CPU batting side went into its pre-declaration push at this over */
  pushFrom?: number;
  /** The innings' own scoring conditions (a multiplier on the scoring classes) */
  cond?: number;
  /** Overs of pace / spin bowled in this innings on each day */
  dayTypeOvers?: [number, number][];
}

export interface TestTeamState {
  id: string;
  name: string;
  shortName: string;
  xi: string[];
  keeperId: string;
  home: boolean;
  /** The user's batting approach (null = the captain's own choice: the fitted policy) */
  approach: TestApproach | null;
  bazball?: boolean;
}

export type TestDecisionType = "toss" | "follow_on" | "drs_batting" | "drs_fielding" | "new_ball";

export interface TestPendingDecision {
  type: TestDecisionType;
  teamId: string;
  options: string[];
  /** What the decision is about, for the UI */
  context?: {
    lead?: number;
    oversLeft?: number;
    batterId?: string;
    bowlerId?: string;
    kind?: DrsKind;
    reviewsLeft?: number;
    /** How out it looked (0-1): a hint, not the answer */
    confidence?: number;
  };
}

export interface TestMatchEvent {
  day: number;
  inn: number;
  /** Innings overs when it happened */
  overs: number;
  kind: "toss" | "day_start" | "stumps" | "lunch" | "tea" | "weather" | "innings_end" | "declaration" | "follow_on" | "new_ball" | "result";
  text: string;
}

export interface TestResult {
  winnerId: string | null;
  kind: "win" | "draw" | "tie";
  /** "an innings and 45 runs", "120 runs", "6 wickets", "" for a draw / tie */
  margin: string;
  text: string;
  /** Day on which the match ended */
  day: number;
  playerOfMatch: { playerId: string; playerName: string; reason: string };
}

export interface TestMatchState {
  kind: "test";
  id: string;
  seed: number;
  /** Random stream position (mulberry32) */
  rng: number;
  gender: TestGender;
  days: number;
  oversPerDay: number;
  country: string;
  region: "sub" | "other";
  neutral: boolean;
  venueName: string;
  teams: Record<string, TestTeamState>;
  /** [home, away] */
  teamOrder: [string, string];
  players: Record<string, TestPlayer>;
  toss: { winnerId: string; decision: "bat" | "bowl" } | null;
  innings: TestInnings[];
  /** Day of play (1-based), legal balls bowled today, today's overs after weather / over rate / innings changes */
  day: number;
  dayBalls: number;
  dayCap: number;
  /** Planned overs per day before innings changes (weather and over-rate shortfall applied) and the weather loss per day */
  dayPlan: number[];
  weatherLost: number[];
  /** Where in each day the weather struck (share of the day's play), for the event log */
  weatherAt: number[];
  session: 1 | 2 | 3;
  matchBalls: number;
  /** The match's own conditions (multipliers per outcome class) */
  cond: number[];
  status: "awaiting_toss" | "in_progress" | "waiting_for_decision" | "completed";
  pending?: TestPendingDecision;
  /** A delivery held while a DRS decision is pending */
  heldBall?: HeldBall;
  userTeamId: string | null;
  /** The CPU captain takes the user's discretionary decisions too (simulating ahead) */
  autoUser: boolean;
  reviewsPerInnings: number;
  commentary: boolean;
  events: TestMatchEvent[];
  result?: TestResult;
  injuries?: MatchInjuryEvent[];
}

/** A delivery waiting on a DRS decision: what really happened and what the umpire gave */
interface HeldBall {
  ev: TestBallEvent;
  /** The batter is truly out (the umpire's out call is right / a not-out call is wrong) */
  trulyOut: boolean;
  kind: DrsKind;
  side: "batting" | "fielding";
  /** The full dismissal, if the decision ends up out */
  dismissal: Pick<TestBallEvent, "wicketType" | "playerOutId" | "fielderId" | "fielder2Id">;
}

// ── Random stream ───────────────────────────────────────────────────────────────────────────────────────────────────

/** mulberry32 over a state held in the match, so a serialised match carries on with the same numbers */
function rngOf(st: { rng: number }): RNG {
  return () => {
    st.rng = (st.rng + 0x6D2B79F5) | 0;
    let t = Math.imul(st.rng ^ (st.rng >>> 15), 1 | st.rng);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng: RNG): number {
  const u = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

function sampleTable(t: Readonly<Record<string, number>>, rng: RNG): string {
  let tot = 0;
  for (const v of Object.values(t)) tot += v;
  let x = rng() * tot;
  let last = "";
  for (const [k, v] of Object.entries(t)) {
    last = k;
    x -= v;
    if (x <= 0) return k;
  }
  return last;
}

const logistic = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
const binOf = (x: number, bins: readonly number[]) => {
  let i = 0;
  while (i + 1 < bins.length && x >= bins[i + 1]) i++;
  return i;
};

// ── Players ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function isSpinStyle(style: string | undefined): boolean {
  return !!style && (style.includes("spin") || style.includes("orthodox") || style.endsWith("-slow"));
}

type TermMap = Readonly<Record<string, { readonly weights: Readonly<Record<string, number>>; readonly c?: number | Readonly<Record<string, number>> }>>;
type Pool = { readonly mean: Readonly<Record<string, number>>; readonly sd: Readonly<Record<string, number>> };

/**
 * A player's log multiplier on one outcome class from his ratings: the fitted attribute mix (z-scored against the real
 * Test players' ratings; bowlers against their own type) scaled to the real spread of that player term (reduced major axis,
 * test-match-model.py).
 */
function termLog(ratings: PlayerRatings, term: TermMap[string] | undefined, pool: Pool, type?: "pace" | "spin"): number {
  if (!term) return 0;
  let z = typeof term.c === "number" ? term.c : (type && term.c?.[type]) ?? 0;
  for (const [a, w] of Object.entries(term.weights)) {
    const r = (ratings as unknown as Record<string, number>)[a] ?? pool.mean[a];
    z += w * (r - pool.mean[a]) / (pool.sd[a] || 1);
  }
  return Math.max(-2.5, Math.min(2.5, z));
}

type RatingMap = { readonly bat: TermMap; readonly bowl: TermMap; readonly pool: { readonly bat: Pool; readonly bowl: Readonly<Record<"pace" | "spin", Pool>> } };
const MAPS = M.players as unknown as { readonly t20: RatingMap; readonly test?: RatingMap };

/**
 * The Test view of a player, with his outcome multipliers. A player with Test ratings is mapped with the mix fitted on Test
 * ratings; one without plays on his T20 ratings through the mix fitted on those (test-match-model.py fits both).
 */
export function testPlayerOf(player: Player): TestPlayer {
  const view = player.forFormat("test");
  const ratings = { ...view.ratings };
  const source: TestPlayer["ratingsSource"] = player.formatRatings?.test ? "test" : "t20";
  const P = (source === "test" && MAPS.test) || MAPS.t20;
  const spin = isSpinStyle(player.bowlingStyle);
  const type = spin ? "spin" : "pace";
  const batLog = TEST_OUTCOMES.map(k => (BAT_TERMS as readonly string[]).includes(k) ? termLog(ratings, P.bat[k], P.pool.bat) : 0);
  const bowlLog = TEST_OUTCOMES.map(k => (BOWL_TERMS as readonly string[]).includes(k) ? termLog(ratings, P.bowl[k], P.pool.bowl[type], type) : 0);
  // quality in log-rate units: surviving and scoring for a batter, taking wickets and not conceding for a bowler
  const batValue = -batLog[IW] + 0.6 * batLog[0] + 0.5 * batLog[3];
  const bowlValue = bowlLog[IW] - 0.6 * bowlLog[0] - 0.6 * bowlLog[3];
  // the attack: bowlers and all-rounders, and a batter only if he really bowls; the rest are part-timers
  const bowls = (player.role === "bowler" || player.role === "all-rounder" || view.bowlingOvr >= 65) && !player.isWicketKeeper;
  return {
    id: player.id, name: player.name, role: player.role, bowlingStyle: player.bowlingStyle, battingHand: player.battingHand,
    isWicketKeeper: player.isWicketKeeper, spin, bowler: bowls, ratings, ratingsSource: source,
    batMul: batLog.map(Math.exp), bowlMul: bowlLog.map(Math.exp), batValue, bowlValue,
  };
}

/**
 * A Test XI from a squad, on Test ratings: the best keeper, four front-line bowlers (two spinners in the subcontinent, one
 * elsewhere, when the squad has them) and the six best remaining batters; then the batting order.
 */
export function pickTestXI(squad: readonly Player[], region: "sub" | "other" = "other"): Player[] {
  const avail = squad.filter(p => !p.injured);
  const tp = new Map(avail.map(p => [p.id, testPlayerOf(p)]));
  const val = (p: Player) => tp.get(p.id)!;
  const chosen: Player[] = [];
  const take = (p: Player | undefined) => { if (p && !chosen.includes(p)) chosen.push(p); };
  const keepers = avail.filter(p => p.isWicketKeeper);
  take([...(keepers.length ? keepers : avail)].sort((a, b) =>
    (val(b).batValue + 0.01 * keepingRating(b)) - (val(a).batValue + 0.01 * keepingRating(a)))[0]);
  const bowlers = avail.filter(p => val(p).bowler && !chosen.includes(p)).sort((a, b) => val(b).bowlValue - val(a).bowlValue);
  const spinners = bowlers.filter(p => val(p).spin);
  const pacers = bowlers.filter(p => !val(p).spin);
  const nSpin = Math.min(spinners.length, region === "sub" ? 2 : 1);
  spinners.slice(0, nSpin).forEach(take);
  pacers.slice(0, 4 - nSpin).forEach(take);
  for (const p of bowlers) if (chosen.length < 5) take(p);
  const rest = avail.filter(p => !chosen.includes(p)).sort((a, b) =>
    (val(b).batValue + 0.3 * Math.max(0, val(b).bowlValue)) - (val(a).batValue + 0.3 * Math.max(0, val(a).bowlValue)));
  for (const p of rest) if (chosen.length < 11) take(p);
  // a fifth bowling option: the best remaining bowler or all-rounder replaces the weakest batter when it costs little batting
  if (chosen.filter(p => val(p).bowler).length < 5) {
    const spare = avail.filter(p => !chosen.includes(p) && val(p).bowler).sort((a, b) => val(b).bowlValue - val(a).bowlValue)[0];
    const batters = chosen.filter(p => !val(p).bowler && !p.isWicketKeeper).sort((a, b) => val(a).batValue - val(b).batValue);
    const weakest = batters[0];
    if (spare && weakest && batters.length > 5 && val(weakest).batValue - val(spare).batValue < FIFTH_BOWLER_COST) chosen.splice(chosen.indexOf(weakest), 1, spare);
  }
  return testBattingOrder(chosen);
}

/** Batting quality (log-rate units) a side gives up for a fifth bowling option */
const FIFTH_BOWLER_COST = 0.35;

/** Batting order on Test batting quality: batters and all-rounders by quality, the keeper no higher than five, bowlers last */
export function testBattingOrder(xi: readonly Player[]): Player[] {
  const v = new Map(xi.map(p => [p.id, testPlayerOf(p).batValue]));
  const top = xi.filter(p => p.role !== "bowler").sort((a, b) => v.get(b.id)! - v.get(a.id)!);
  const tail = xi.filter(p => p.role === "bowler").sort((a, b) => v.get(b.id)! - v.get(a.id)!);
  const order = [...top, ...tail];
  const k = order.findIndex(p => p.isWicketKeeper);
  if (k >= 0 && k < 4) {
    const [keeper] = order.splice(k, 1);
    order.splice(Math.min(4, order.length), 0, keeper);
  }
  return order;
}

// ── Conditions: weather, over rate, the match's own pitch ───────────────────────────────────────────────────────────

/** Inverse of the fitted over-rate quantiles (10th, 25th, 50th, 75th, 90th percentile; linear in between and beyond) */
function drawOverRate(rng: RNG): number {
  const q = M.policy.time.oversPerHour;
  const ps = [0.1, 0.25, 0.5, 0.75, 0.9];
  const u = rng();
  if (u <= ps[0]) return q[0] - (q[1] - q[0]) * (ps[0] - u) / (ps[1] - ps[0]);
  for (let i = 1; i < ps.length; i++) if (u <= ps[i]) return q[i - 1] + (q[i] - q[i - 1]) * (u - ps[i - 1]) / (ps[i] - ps[i - 1]);
  return q[4] + (q[4] - q[3]) * (u - ps[4]) / (ps[4] - ps[3]);
}

/**
 * Time lost per day. A day is affected with the host country's fitted probability; an affected day loses on average the
 * fitted share of its play (TEST_MODEL.policy.time.weather): a wash-out with probability w, else 5-75% of the day, w chosen so
 * the mean is the fitted share.
 */
function planWeather(st: TestMatchState, rng: RNG, on: boolean): void {
  const W = M.policy.time.weather;
  const c = (W.byCountry as Readonly<Record<string, { p: number; share: number }>>)[st.country];
  const p = c?.p ?? W.p;
  const share = c?.share ?? W.share;
  const washout = Math.max(0, Math.min(1, (share - 0.4) / 0.6));
  const rate = drawOverRate(rng);
  // A day has six hours plus up to half an hour's extra time to bowl its overs: a slow side falls short
  const dry = Math.min(st.oversPerDay, Math.floor(rate * 6.5 * (st.oversPerDay / 90)));
  st.dayPlan = [];
  st.weatherLost = [];
  st.weatherAt = [];
  for (let d = 0; d < st.days; d++) {
    let lost = 0;
    if (on && rng() < p) {
      const x = rng() < washout ? 1 : 0.05 + 0.7 * rng();
      lost = Math.round(x * st.oversPerDay);
    }
    st.weatherLost.push(lost);
    st.weatherAt.push(rng());
    st.dayPlan.push(Math.max(0, dry - lost));
  }
}

/** The match's own conditions beyond its country: run and wicket multipliers drawn from the fitted spread */
function drawConditions(rng: RNG): number[] {
  const s = M.matchSpread;
  const z1 = normal(rng);
  const z2 = normal(rng);
  const ur = s.run * z1;
  const uw = s.wicket * (s.corr * z1 + Math.sqrt(1 - s.corr * s.corr) * z2);
  // centred so the mean multiplier is 1 (the fitted match terms average 1)
  return TEST_OUTCOMES.map((_, k) => (SCORING.includes(k) ? Math.exp(ur - s.run * s.run / 2) : k === IW ? Math.exp(uw - s.wicket * s.wicket / 2) : 1));
}

// ── Creating a match ────────────────────────────────────────────────────────────────────────────────────────────────

let testCounter = 0;

function majorityCountry(xi: readonly Player[]): string | undefined {
  const n = new Map<string, number>();
  for (const p of xi) n.set(p.country, (n.get(p.country) ?? 0) + 1);
  let best: string | undefined;
  let bn = 0;
  for (const [c, v] of n) if (v > bn) { best = c; bn = v; }
  return best;
}

function teamGender(xi: readonly Player[]): TestGender {
  return xi.filter(p => p.isFemale).length > xi.length / 2 ? "female" : "male";
}

/**
 * Set up a Test between `home` and `away`. With a user side the match waits for the toss call when the user wins it;
 * otherwise it is ready to bowl the first ball. The caller then steps it (stepTestBall / test-live.ts) or runs it out
 * (simulateTestMatch).
 */
export function createTestMatch(home: Team, away: Team, options: TestMatchOptions = {}): TestMatchState {
  const seed = options.seed ?? randomSeed();
  const squadXI = (t: Team, region: "sub" | "other") => {
    const ids = options.xi?.[t.id];
    if (ids && ids.length >= 11) {
      const xi = ids.map(id => t.roster.find(p => p.id === id)).filter((p): p is Player => !!p);
      if (xi.length >= 11) return xi.slice(0, 11);
    }
    return pickTestXI(t.roster, region);
  };
  // the host country decides the conditions, so it comes first (the XI depends on it)
  const guessXI = pickTestXI(home.roster);
  const hostName = majorityCountry(guessXI);
  const country = options.country ?? (options.neutral ? "other" : COUNTRY_OF[hostName ?? ""] ?? "other");
  const region: "sub" | "other" = SUBCONTINENT.has(country) ? "sub" : "other";
  const homeXI = squadXI(home, region);
  const awayXI = squadXI(away, region);
  const gender = options.gender ?? teamGender([...homeXI, ...awayXI]);
  const days = options.days ?? (gender === "female" ? 4 : 5);
  const oversPerDay = options.oversPerDay ?? (gender === "female" ? 100 : 90);

  const players: Record<string, TestPlayer> = {};
  for (const p of [...homeXI, ...awayXI]) players[p.id] = testPlayerOf(p);
  const teamState = (t: Team, xi: Player[], isHome: boolean): TestTeamState => ({
    id: t.id, name: t.name, shortName: t.shortName, xi: xi.map(p => p.id),
    keeperId: (xi.find(p => p.isWicketKeeper) ?? [...xi].sort((a, b) => keepingRating(b) - keepingRating(a))[0]).id,
    home: isHome && !options.neutral, approach: null,
    ...(options.bazballTeamId === t.id ? { bazball: true } : {}),
  });

  const st: TestMatchState = {
    kind: "test", id: `test_${++testCounter}`, seed, rng: seed | 0, gender, days, oversPerDay, country, region,
    neutral: !!options.neutral, venueName: options.venueName ?? (options.neutral ? "Neutral venue" : home.config.city),
    teams: { [home.id]: teamState(home, homeXI, true), [away.id]: teamState(away, awayXI, false) },
    teamOrder: [home.id, away.id], players, toss: null, innings: [],
    day: 1, dayBalls: 0, dayCap: 0, dayPlan: [], weatherLost: [], weatherAt: [], session: 1, matchBalls: 0,
    cond: [], status: "awaiting_toss", userTeamId: options.userTeamId ?? null, autoUser: false,
    reviewsPerInnings: options.reviews ?? 3,
    commentary: options.commentary ?? !!options.userTeamId, events: [],
  };
  const r = rngOf(st);
  planWeather(st, r, options.weather ?? true);
  st.cond = drawConditions(r);
  st.dayCap = st.dayPlan[0];
  // the toss: a CPU winner follows the host country's fitted bat-first share; a user winner is asked
  const winner = r() < 0.5 ? home.id : away.id;
  if (st.userTeamId === winner) {
    st.status = "waiting_for_decision";
    st.pending = { type: "toss", teamId: winner, options: ["bat", "bowl"] };
  } else {
    applyToss(st, winner, cpuTossDecision(st, r));
  }
  return st;
}

function cpuTossDecision(st: TestMatchState, rng: RNG): "bat" | "bowl" {
  const t = M.policy.toss;
  const p = (t.byCountry as Readonly<Record<string, number>>)[st.country] ?? t.all;
  return rng() < p ? "bat" : "bowl";
}

/** Record the toss and start the first innings */
export function applyToss(st: TestMatchState, winnerId: string, decision: "bat" | "bowl"): void {
  st.toss = { winnerId, decision };
  const other = st.teamOrder[0] === winnerId ? st.teamOrder[1] : st.teamOrder[0];
  const batting = decision === "bat" ? winnerId : other;
  st.events.push({ day: 1, inn: 1, overs: 0, kind: "toss", text: `${st.teams[winnerId].name} won the toss and chose to ${decision === "bat" ? "bat" : "bowl"}.` });
  st.status = "in_progress";
  st.pending = undefined;
  startInnings(st, batting, false);
  noteWeather(st);
}

function startInnings(st: TestMatchState, battingTeamId: string, followOn: boolean): void {
  const bowlingTeamId = st.teamOrder[0] === battingTeamId ? st.teamOrder[1] : st.teamOrder[0];
  const order = [...st.teams[battingTeamId].xi];
  const inn: TestInnings = {
    number: (st.innings.length + 1) as 1 | 2 | 3 | 4, battingTeamId, bowlingTeamId, runs: 0, wickets: 0, legalBalls: 0,
    extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0, penalty: 0 }, fours: 0, sixes: 0,
    order, arrived: 2, strikerId: order[0], nonStrikerId: order[1], batters: {}, bowlers: {}, ballLog: [], fow: [],
    ballTakenAt: 0, newBalls: 1, drs: { batting: st.reviewsPerInnings, fielding: st.reviewsPerInnings },
    ends: [null, null], end: 0, overBalls: 0, overRuns: 0,
    ...(followOn ? { followOn: true } : {}),
  };
  // the innings' own scoring conditions (fitted spread beyond the match's), mean 1
  const sd = M.inningsSpread.run;
  inn.cond = Math.exp(sd * normal(rngOf(st)) - sd * sd / 2);
  inn.batters[order[0]] = { runs: 0, balls: 0, fours: 0, sixes: 0, out: false, arrived: 1 };
  inn.batters[order[1]] = { runs: 0, balls: 0, fours: 0, sixes: 0, out: false, arrived: 2 };
  st.innings.push(inn);
}

export function currentInnings(st: TestMatchState): TestInnings | undefined {
  return st.innings[st.innings.length - 1];
}

// ── Time ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Overs left in the match: the rest of today plus every day still to come (weather and over rate as planned) */
export function oversLeftInMatch(st: TestMatchState): number {
  let n = Math.max(0, st.dayCap - st.dayBalls / 6);
  for (let d = st.day; d < st.days; d++) n += st.dayPlan[d];
  return n;
}

function noteWeather(st: TestMatchState): void {
  const lost = st.weatherLost[st.day - 1];
  if (lost <= 0) return;
  const inn = currentInnings(st);
  st.events.push({
    day: st.day, inn: inn?.number ?? 0, overs: Math.floor((inn?.legalBalls ?? 0) / 6), kind: "weather",
    text: lost >= st.oversPerDay ? `Day ${st.day}: no play, rain washes out the day.` : `Day ${st.day}: rain and bad light cost ${lost} overs.`,
  });
}

/** Close the day; a match out of days is drawn */
function endDay(st: TestMatchState): void {
  const inn = currentInnings(st)!;
  st.events.push({ day: st.day, inn: inn.number, overs: Math.floor(inn.legalBalls / 6), kind: "stumps", text: `Stumps, day ${st.day}: ${scoreLine(st, inn)}.` });
  for (;;) {
    st.day++;
    if (st.day > st.days) {
      st.day = st.days;
      inn.closed = "time";
      finishMatch(st, null, "draw", "");
      return;
    }
    st.dayBalls = 0;
    st.dayCap = st.dayPlan[st.day - 1];
    st.session = 1;
    noteWeather(st);
    if (st.dayCap > 0) break;
  }
  // overnight: every bowler is rested and starts a new spell
  for (const b of Object.values(inn.bowlers)) { b.spellOvers = 0; b.spellPlan = 0; b.lastOver = -99; }
  inn.ends = [null, null];
  st.events.push({ day: st.day, inn: inn.number, overs: Math.floor(inn.legalBalls / 6), kind: "day_start", text: `Day ${st.day}: ${scoreLine(st, inn)}.` });
}

function noteSession(st: TestMatchState, inn: TestInnings): void {
  const per = st.dayPlan[st.day - 1] / 3;
  if (per <= 0) return;
  const s = Math.min(3, 1 + Math.floor(st.dayBalls / 6 / per)) as 1 | 2 | 3;
  if (s > st.session) {
    st.events.push({ day: st.day, inn: inn.number, overs: Math.floor(inn.legalBalls / 6), kind: s === 2 ? "lunch" : "tea", text: `${s === 2 ? "Lunch" : "Tea"}, day ${st.day}: ${scoreLine(st, inn)}.` });
    st.session = s;
  }
}

// ── Scores ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function teamTotal(st: TestMatchState, teamId: string, upTo = st.innings.length): number {
  let n = 0;
  for (let i = 0; i < upTo; i++) if (st.innings[i].battingTeamId === teamId) n += st.innings[i].runs;
  return n;
}

/** Runs the side batting now leads by (negative = behind) */
export function testLead(st: TestMatchState): number {
  const inn = currentInnings(st);
  if (!inn) return 0;
  return teamTotal(st, inn.battingTeamId) - teamTotal(st, inn.bowlingTeamId);
}

/** The 4th-innings target (undefined before the 4th innings) */
export function testTarget(st: TestMatchState): number | undefined {
  const inn = currentInnings(st);
  if (!inn || inn.number !== 4) return undefined;
  return teamTotal(st, inn.bowlingTeamId) - teamTotal(st, inn.battingTeamId, 3) + 1;
}

const oversText = (balls: number) => `${Math.floor(balls / 6)}${balls % 6 ? "." + (balls % 6) : ""}`;

function scoreLine(st: TestMatchState, inn: TestInnings): string {
  return `${st.teams[inn.battingTeamId].shortName} ${inn.runs}/${inn.wickets} (${oversText(inn.legalBalls)} ov)`;
}

// ── The ball model ──────────────────────────────────────────────────────────────────────────────────────────────────

const COUNTRY_T = F.country as unknown as Readonly<Record<string, { pace: OutcomeTable; spin: OutcomeTable }>>;
const CTY: Record<string, { pace: number[]; spin: number[] }> = {};
for (const [c, t] of Object.entries(COUNTRY_T)) CTY[c] = { pace: vec(t.pace), spin: vec(t.spin) };

/** The CPU's chase intent in a 4th innings: the fitted factor for the runs needed per over left (data: scheduled overs) */
function chaseLevel(st: TestMatchState, inn: TestInnings): number {
  const need = (testTarget(st) ?? 0) - inn.runs;
  return binOf(need / Math.max(1, oversLeftInMatch(st)), CHASE_BINS);
}

/** Situation and approach multipliers for the side batting */
function situation(st: TestMatchState, inn: TestInnings): number[] {
  const choice = st.teams[inn.battingTeamId].approach;
  if (inn.number < 4) {
    if (choice === "attack" || (choice === null && inn.pushFrom !== undefined)) return T_PUSH;
    if (choice === "defend") return T_NORMAL.map((v, k) => v * APPROACH_DEFEND[k]);
    return T_NORMAL;
  }
  if (choice === null) return T_CHASE[chaseLevel(st, inn)];
  if (choice === "attack") return T_CHASE[1].map((v, k) => v * APPROACH_ATTACK[k]);
  if (choice === "defend") return T_CHASE[T_CHASE.length - 1];
  return T_CHASE[1];
}

/**
 * Beyond what the data shows (spells of more than eight overs, more overs in a day than 90% of real bowlers bowl) a bowler
 * tires: 3% more runs and 3% fewer wickets per over over the line (an assumption; captains rarely let it happen, so it
 * cannot be fitted). Only a user who over-bowls someone, or an attack worn down to its last bowlers, meets it.
 */
const FATIGUE_SPELL = 8;
const FATIGUE_PER_OVER = 0.03;
function fatigue(line: TestBowlerLine | undefined, tp: TestPlayer, day: number): { runs: number; wkts: number } {
  if (!line) return { runs: 1, wkts: 1 };
  const capDay = tp.spin ? M.policy.workload.day_spin[1] : M.policy.workload.day_pace[1];
  const extra = Math.max(0, line.spellOvers + 1 - FATIGUE_SPELL) + Math.max(0, (line.dayOvers?.[day - 1] ?? 0) - capDay);
  if (extra <= 0) return { runs: 1, wkts: 1 };
  return { runs: Math.min(1.3, 1 + FATIGUE_PER_OVER * extra), wkts: Math.max(0.7, 1 - FATIGUE_PER_OVER * extra) };
}

/** Per-delivery probabilities of the outcome classes (model order), before fielding */
export function testBallProbs(st: TestMatchState, inn: TestInnings): number[] {
  const bat = st.players[inn.strikerId];
  const bowlerId = inn.ends[inn.end]!;
  const bowl = st.players[bowlerId];
  const line = inn.bowlers[bowlerId];
  const base = BASE[st.gender];
  const ab = binOf(Math.floor(inn.legalBalls / 6) - inn.ballTakenAt, AGE_BINS);
  const sb = binOf(inn.batters[inn.strikerId]?.balls ?? 0, SET_BINS);
  const i = inn.number - 1;
  const d = Math.min(st.day, 5) - 1;
  const type = bowl.spin ? "spin" : "pace";
  const sp = Math.min((line?.spellOvers ?? 0) + 1, T_SPELL.length) - 1;
  const sit = situation(st, inn);
  const team = st.teams[inn.battingTeamId];
  const home = st.neutral ? T_HOME.neutral : team.home ? T_HOME.home : T_HOME.away;
  const cty = (CTY[st.country] ?? CTY.other)[type];
  const fat = fatigue(line, bowl, st.day);
  const p = new Array<number>(K);
  for (let k = 0; k < K; k++) {
    let v = base[k] * T_AGE[ab][k] * T_SET[sb][k] * T_INN[i][k] * T_DAY[type][d][k] * T_SPELL[sp][k] * sit[k] * home[k] * cty[k]
      * bat.batMul[k] * bowl.bowlMul[k] * st.cond[k];
    if (team.bazball) v *= T_BAZ[k];
    if (k < IW && inn.cond) v *= inn.cond;
    if (k === IW) v *= fat.wkts; else v *= fat.runs;
    p[k] = v;
  }
  return p;
}

// ── Dismissals and fielding ─────────────────────────────────────────────────────────────────────────────────────────

type TestKind = "caught" | "caught_keeper" | "caught_and_bowled" | "bowled" | "lbw" | "stumped" | "run_out" | "hit_wicket";
const CHANCE_CONV: Partial<Record<TestKind, number>> = {
  caught: FIELDING_CONV.catch.base, caught_keeper: FIELDING_CONV.catch.base, caught_and_bowled: FIELDING_CONV.catch.base,
  stumped: FIELDING_CONV.stump.base, run_out: FIELDING_CONV.runOut.base,
};

/** Dismissal kinds by bowler type as chances: each weighted by share / average conversion, so converted chances give the mix */
const KIND_WEIGHTS: Record<TestGender, Record<"pace" | "spin", Record<string, number>>> = { male: { pace: {}, spin: {} }, female: { pace: {}, spin: {} } };
const INFLATION: Record<TestGender, Record<"pace" | "spin", number>> = { male: { pace: 1, spin: 1 }, female: { pace: 1, spin: 1 } };
for (const g of ["male", "female"] as const) {
  for (const t of ["pace", "spin"] as const) {
    const mix = (M.dismissal as unknown as Record<string, Record<string, Record<string, number>>>)[g][t];
    let tot = 0;
    let w = 0;
    for (const [k, v] of Object.entries(mix)) {
      if (k === "other") continue;
      tot += v;
      const c = CHANCE_CONV[k as TestKind] ?? 1;
      KIND_WEIGHTS[g][t][k] = v / c;
      w += v / c;
    }
    INFLATION[g][t] = w / tot;
  }
}

function conv(kind: "catch" | "stump" | "runOut", skill: number, pivot: number): number {
  const c = FIELDING_CONV[kind];
  return Math.max(c.lo, Math.min(c.hi, c.base + c.slope * (skill - pivot)));
}

interface Chance {
  outcome: "wicket" | "dot" | "1" | "2" | "3" | "4" | "6";
  kind: TestKind;
  fielderId?: string;
  fielder2Id?: string;
  note?: FieldingNote;
  out?: "striker" | "nonStriker";
  runsCompleted?: number;
}

/** A dismissal chance: its kind (Test mix by bowler type), who was involved, and whether it was taken */
function resolveChance(st: TestMatchState, inn: TestInnings, unit: FieldingUnit, rng: RNG): Chance {
  const bowlerId = inn.ends[inn.end]!;
  const type = st.players[bowlerId].spin ? "spin" : "pace";
  const kind = sampleTable(KIND_WEIGHTS[st.gender][type], rng) as TestKind;
  const keeper = unit.keeper;
  if (kind === "bowled" || kind === "lbw" || kind === "hit_wicket") return { outcome: "wicket", kind };
  if (kind === "caught_keeper") {
    if (!keeper) return { outcome: "wicket", kind: "caught" };
    const c = conv("catch", keepingRating(keeper), NEUTRAL_FIELDING);
    if (rng() < c) return { outcome: "wicket", kind, fielderId: keeper.id };
    return { outcome: missedChanceOutcome("catch_keeper", rng), kind, fielderId: keeper.id, note: "dropped_catch" };
  }
  if (kind === "caught" || kind === "caught_and_bowled") {
    const f = kind === "caught_and_bowled" ? unit.fielders.find(p => p.id === bowlerId)
      : (() => {
        const pool = unit.fielders.filter(p => p.id !== bowlerId && p.id !== keeper?.id);
        return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
      })();
    const skill = f ? fieldingRating(f) : TEAM_FIELDING_PIVOT;
    if (rng() < conv("catch", skill, TEAM_FIELDING_PIVOT)) {
      const great = skill >= 72 && rng() < 0.3;
      return { outcome: "wicket", kind, fielderId: f?.id, ...(great ? { note: "great_catch" as const } : {}) };
    }
    return { outcome: missedChanceOutcome("catch_ring", rng), kind, fielderId: f?.id, note: "dropped_catch" };
  }
  if (kind === "stumped") {
    const c = keeper ? conv("stump", keepingRating(keeper), NEUTRAL_FIELDING) : 0.5;
    if (rng() < c) return { outcome: "wicket", kind, fielderId: keeper?.id };
    return { outcome: missedChanceOutcome("stumping", rng), kind, fielderId: keeper?.id, note: "missed_stumping" };
  }
  // run out
  const runsCompleted = pickRunOutRuns(rng);
  const out = pickRunOutBatter(runsCompleted, false, rng);
  const fl = pickRunOutFielders({ rng, bowlerId, unit });
  const skill = fl.first ? fieldingRating(fl.first) : TEAM_FIELDING_PIVOT;
  if (rng() < conv("runOut", skill, TEAM_FIELDING_PIVOT)) {
    return { outcome: "wicket", kind, fielderId: fl.first?.id, fielder2Id: fl.second?.id, out, runsCompleted };
  }
  return { outcome: missedChanceOutcome("run_out", rng), kind, fielderId: fl.first?.id, note: "run_out_missed" };
}

function engineKind(k: TestKind): DismissalKind {
  return k === "caught_keeper" ? "caught" : k;
}

// ── DRS (Tests) ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Per-ball review rates from the Test review records (TEST_MODEL.drs: reviews per innings, the batting side's share, kind
 * shares and outcome shares), turned into rates per wicket of the kind and per dot ball the same way drs.ts does for T20.
 */
const DRS_RATES = (() => {
  const d = M.drs;
  const B = d.reviewsPerInnings * d.battingShare;
  const Fr = d.reviewsPerInnings * (1 - d.battingShare);
  const wpi = d.wicketsPerInnings as Readonly<Record<string, number>>;
  const out = {} as Record<DrsKind, { fieldOverturnOfWicket: number; batReviewOfWicket: number; batUc: number; wrongOutPerDot: number; fieldFailPerDot: number; fieldUc: number }>;
  for (const k of ["lbw", "caught"] as DrsKind[]) {
    const bk = (d.batting.kindShare as Readonly<Record<string, number>>)[k] ?? 0;
    const fk = (d.fielding.kindShare as Readonly<Record<string, number>>)[k] ?? 0;
    out[k] = {
      fieldOverturnOfWicket: Math.min(0.6, (Fr * fk * d.fielding.overturned) / wpi[k]),
      batReviewOfWicket: Math.min(0.95, (B * bk * (1 - d.batting.overturned)) / wpi[k]),
      batUc: d.batting.umpiresCall / (1 - d.batting.overturned),
      wrongOutPerDot: (B * bk * d.batting.overturned) / d.legalBallsPerInnings / d.dotShare,
      fieldFailPerDot: (Fr * fk * (1 - d.fielding.overturned)) / d.legalBallsPerInnings / d.dotShare,
      fieldUc: d.fielding.umpiresCall / (1 - d.fielding.overturned),
    };
  }
  return out;
})();

const isUserSide = (st: TestMatchState, teamId: string) => st.userTeamId === teamId && !st.autoUser;

// ── Delivering a ball ───────────────────────────────────────────────────────────────────────────────────────────────

function newEvent(st: TestMatchState, inn: TestInnings): TestBallEvent {
  return {
    inn: inn.number, over: Math.floor(inn.legalBalls / 6), ball: inn.overBalls + 1, day: st.day, bowler: inn.ends[inn.end]!,
    batter: inn.strikerId, nonStriker: inn.nonStrikerId, outcome: "dot", runs: 0, extras: 0, isWicket: false, score: 0, wickets: 0,
  };
}

/** Draw the delivery; returns the event, or a held event when a user DRS decision is pending */
function deliver(st: TestMatchState, inn: TestInnings, rng: RNG): TestBallEvent | null {
  const p = testBallProbs(st, inn);
  const bowlerId = inn.ends[inn.end]!;
  const type = st.players[bowlerId].spin ? "spin" : "pace";
  const infl = INFLATION[st.gender][type];
  // chances inflate the wicket class; the chances put down at average conversion come out of the dot ball
  const pChance = p[IW] * infl;
  let sum = 0;
  for (let k = 0; k < K; k++) sum += k === IW ? pChance : p[k];
  const scale = sum > 0.97 ? 0.97 / sum : 1;
  const ev = newEvent(st, inn);
  let u = rng();
  let cls: TestOutcomeClass = "dot";
  for (let k = 0; k < K; k++) {
    const pk = (k === IW ? pChance : p[k]) * scale;
    if (u < pk) { cls = TEST_OUTCOMES[k]; break; }
    u -= pk;
  }
  const fieldXI = st.teams[inn.bowlingTeamId].xi.map(id => fielderOf(st, id));
  const unit = buildFieldingUnit(fieldXI);
  switch (cls) {
    case "1": case "2": case "4": case "6":
      ev.outcome = cls; ev.runs = Number(cls);
      if (cls === "4" || cls === "6") ev.boundary = cls === "4" ? 4 : 6;
      break;
    case "3":
      ev.outcome = "3"; ev.runs = Number(sampleTable(M.threeRuns, rng));
      break;
    case "wide": {
      ev.outcome = "wide"; ev.wides = Number(sampleTable(M.wideRuns, rng)); ev.extras = ev.wides;
      break;
    }
    case "nb": {
      ev.outcome = "noball"; ev.noBalls = 1;
      const bat = Number(sampleTable(M.noBallBat, rng));
      if (bat === 0 && rng() < M.noBallByes) ev.byes = 1;
      ev.runs = bat;
      if (bat === 4 || bat === 6) ev.boundary = bat as 4 | 6;
      ev.extras = 1 + (ev.byes ?? 0);
      break;
    }
    case "bye": {
      ev.outcome = "legbye";
      const isBye = rng() < M.byeShare;
      const n = Number(sampleTable(isBye ? M.byeRuns : M.legByeRuns, rng));
      if (isBye) ev.byes = n; else ev.legByes = n;
      ev.extras = n;
      break;
    }
    case "W": {
      const ch = resolveChance(st, inn, unit, rng);
      if (ch.outcome !== "wicket") {
        ev.outcome = ch.outcome; ev.runs = ch.outcome === "dot" ? 0 : Number(ch.outcome);
        if (ch.outcome === "4" || ch.outcome === "6") ev.boundary = ch.outcome === "4" ? 4 : 6;
        ev.fieldingNote = ch.note;
        if (ch.fielderId) ev.fielderId = ch.fielderId;
        break;
      }
      const dis: HeldBall["dismissal"] = { wicketType: engineKind(ch.kind), playerOutId: ch.out === "nonStriker" ? inn.nonStrikerId : inn.strikerId };
      if (ch.fielderId) dis.fielderId = ch.fielderId;
      if (ch.fielder2Id) dis.fielder2Id = ch.fielder2Id;
      if (ch.kind === "run_out") ev.runs = ch.runsCompleted ?? 0;
      if (ch.note) ev.fieldingNote = ch.note;
      const dk: DrsKind | null = ch.kind === "lbw" ? "lbw" : ch.kind === "caught_keeper" ? "caught" : null;
      if (dk && st.reviewsPerInnings > 0) {
        const R = DRS_RATES[dk];
        if (rng() < R.fieldOverturnOfWicket) {
          // given not out on the field: the fielding side must review to get it
          if (isUserSide(st, inn.bowlingTeamId) && inn.drs.fielding > 0) return hold(st, inn, ev, { trulyOut: true, kind: dk, side: "fielding", dismissal: dis }, rng);
          if (inn.drs.fielding <= 0) { ev.outcome = "dot"; break; }
          ev.review = { by: "fielding", kind: dk, onField: "not_out", result: "overturned" };
        } else if (inn.drs.batting > 0) {
          if (isUserSide(st, inn.battingTeamId)) return hold(st, inn, ev, { trulyOut: true, kind: dk, side: "batting", dismissal: dis }, rng);
          if (rng() < R.batReviewOfWicket) {
            ev.review = { by: "batting", kind: dk, onField: "out", result: rng() < R.batUc ? "umpires_call" : "struck_down" };
            if (ev.review.result === "struck_down") inn.drs.batting--;
          }
        }
      }
      Object.assign(ev, dis);
      ev.outcome = "wicket"; ev.isWicket = true;
      break;
    }
    default: {
      // a dot: now and then an appeal goes to the third umpire
      if (st.reviewsPerInnings > 0) {
        for (const dk of ["lbw", "caught"] as DrsKind[]) {
          if (dk === "caught" && !unit.keeper) continue;
          const R = DRS_RATES[dk];
          if (rng() < R.wrongOutPerDot) {
            const dis: HeldBall["dismissal"] = { wicketType: dk === "lbw" ? "lbw" : "caught", playerOutId: inn.strikerId, ...(dk === "caught" && unit.keeper ? { fielderId: unit.keeper.id } : {}) };
            if (inn.drs.batting <= 0) { Object.assign(ev, dis); ev.outcome = "wicket"; ev.isWicket = true; break; }
            if (isUserSide(st, inn.battingTeamId)) return hold(st, inn, ev, { trulyOut: false, kind: dk, side: "batting", dismissal: dis }, rng);
            ev.review = { by: "batting", kind: dk, onField: "out", result: "overturned" };
            break;
          }
          if (inn.drs.fielding > 0 && rng() < R.fieldFailPerDot) {
            if (isUserSide(st, inn.bowlingTeamId)) {
              const dis: HeldBall["dismissal"] = { wicketType: dk === "lbw" ? "lbw" : "caught", playerOutId: inn.strikerId };
              return hold(st, inn, ev, { trulyOut: false, kind: dk, side: "fielding", dismissal: dis }, rng);
            }
            ev.review = { by: "fielding", kind: dk, onField: "not_out", result: rng() < R.fieldUc ? "umpires_call" : "struck_down" };
            if (ev.review.result === "struck_down") inn.drs.fielding--;
            break;
          }
        }
      }
    }
  }
  return ev;
}

function fielderOf(st: TestMatchState, id: string) {
  const p = st.players[id];
  return { id, name: p.name, isWicketKeeper: p.id === Object.values(st.teams).find(t => t.xi.includes(id))?.keeperId, ratings: { fielding: p.ratings.fielding, keeping: p.ratings.keeping } };
}

/** Hold a delivery for the user's review call */
function hold(st: TestMatchState, inn: TestInnings, ev: TestBallEvent, h: Omit<HeldBall, "ev">, rng: RNG): null {
  st.heldBall = { ev, ...h };
  const teamId = h.side === "batting" ? inn.battingTeamId : inn.bowlingTeamId;
  st.status = "waiting_for_decision";
  st.pending = {
    type: h.side === "batting" ? "drs_batting" : "drs_fielding", teamId, options: h.side === "batting" ? ["review", "accept"] : ["review", "decline"],
    context: {
      batterId: inn.strikerId, bowlerId: ev.bowler, kind: h.kind, reviewsLeft: h.side === "batting" ? inn.drs.batting : inn.drs.fielding,
      confidence: Math.round(100 * (h.trulyOut ? 0.45 + 0.5 * rng() : 0.05 + 0.6 * rng())) / 100,
    },
  };
  return null;
}

/** The user's review call on a held delivery */
function resolveHeld(st: TestMatchState, review: boolean): TestBallEvent {
  const h = st.heldBall!;
  const inn = currentInnings(st)!;
  const rng = rngOf(st);
  const ev = h.ev;
  st.heldBall = undefined;
  st.pending = undefined;
  st.status = "in_progress";
  const out = () => { Object.assign(ev, h.dismissal); ev.outcome = "wicket"; ev.isWicket = true; };
  const R = DRS_RATES[h.kind];
  if (h.side === "batting") {
    // given out on the field
    if (!review) { out(); return ev; }
    if (h.trulyOut) {
      ev.review = { by: "batting", kind: h.kind, onField: "out", result: rng() < R.batUc ? "umpires_call" : "struck_down" };
      if (ev.review.result === "struck_down") inn.drs.batting--;
      out();
    } else {
      ev.review = { by: "batting", kind: h.kind, onField: "out", result: "overturned" };
    }
    return ev;
  }
  // given not out on the field
  if (!review) return ev;
  if (h.trulyOut) {
    ev.review = { by: "fielding", kind: h.kind, onField: "not_out", result: "overturned" };
    out();
  } else {
    ev.review = { by: "fielding", kind: h.kind, onField: "not_out", result: rng() < R.fieldUc ? "umpires_call" : "struck_down" };
    if (ev.review.result === "struck_down") inn.drs.fielding--;
  }
  return ev;
}

// ── Applying a ball ─────────────────────────────────────────────────────────────────────────────────────────────────

function bowlerLine(inn: TestInnings, id: string): TestBowlerLine {
  return (inn.bowlers[id] ??= { balls: 0, runs: 0, wickets: 0, maidens: 0, wides: 0, noBalls: 0, spellOvers: 0, spellPlan: 0, lastOver: -99 });
}

function nextBatter(inn: TestInnings): string | null {
  while (inn.arrived < inn.order.length) {
    const id = inn.order[inn.arrived++];
    if (!inn.batters[id]) {
      inn.batters[id] = { runs: 0, balls: 0, fours: 0, sixes: 0, out: false, arrived: inn.arrived };
      return id;
    }
  }
  // a retired-hurt batter comes back when nobody else is left
  const back = inn.retiredHurt?.shift();
  if (back) { inn.batters[back].retiredHurt = false; return back; }
  return null;
}

/** Book a delivery into the innings; returns whether the innings ended on it */
function applyBall(st: TestMatchState, inn: TestInnings, ev: TestBallEvent): boolean {
  const legal = ev.outcome !== "wide" && ev.outcome !== "noball";
  const line = bowlerLine(inn, ev.bowler);
  const bat = inn.batters[ev.batter];
  const total = ev.runs + ev.extras;
  inn.runs += total;
  inn.extras.wides += ev.wides ?? 0;
  inn.extras.noBalls += ev.noBalls ?? 0;
  inn.extras.byes += ev.byes ?? 0;
  inn.extras.legByes += ev.legByes ?? 0;
  const charged = ev.runs + (ev.wides ?? 0) + (ev.noBalls ?? 0);
  line.runs += charged;
  inn.overRuns += charged;
  if (ev.wides) line.wides++;
  if (ev.noBalls) line.noBalls++;
  if (ev.outcome !== "wide") bat.balls++;
  bat.runs += ev.runs;
  if (ev.boundary === 4) { bat.fours++; inn.fours++; }
  if (ev.boundary === 6) { bat.sixes++; inn.sixes++; }
  if (legal) {
    inn.legalBalls++;
    inn.overBalls++;
    line.balls++;
    st.dayBalls++;
    st.matchBalls++;
  }
  let ended = false;
  if (ev.isWicket) {
    const outId = ev.playerOutId ?? ev.batter;
    const o = inn.batters[outId];
    o.out = true;
    o.kind = ev.wicketType;
    o.bowlerId = ev.bowler;
    if (ev.fielderId) o.fielderId = ev.fielderId;
    inn.wickets++;
    if (isBowlerWicket(ev.wicketType)) {
      line.wickets++;
      // a captain keeps a bowler on while he is taking wickets
      line.spellPlan = Math.max(line.spellPlan, line.spellOvers + 1 + WICKET_SPELL_EXTENSION);
    }
    inn.fow.push({ runs: inn.runs, wickets: inn.wickets, balls: inn.legalBalls, playerId: outId });
    const incoming = nextBatter(inn);
    if (!incoming) ended = true;
    else {
      // the new batter takes the end of the one who is out; a run out with an odd number completed crossed first
      if (outId === inn.strikerId) inn.strikerId = incoming; else inn.nonStrikerId = incoming;
      if (ev.wicketType === "run_out" && ev.runs % 2 === 1) [inn.strikerId, inn.nonStrikerId] = [inn.nonStrikerId, inn.strikerId];
    }
  } else {
    const ran = ev.boundary ? 0 : ev.outcome === "wide" ? Math.max(0, (ev.wides ?? 1) - 1) % 5 : ev.runs + (ev.byes ?? 0) + (ev.legByes ?? 0);
    if (ran % 2 === 1 && ran !== 5) [inn.strikerId, inn.nonStrikerId] = [inn.nonStrikerId, inn.strikerId];
  }
  ev.score = inn.runs;
  ev.wickets = inn.wickets;
  inn.ballLog.push(ev);
  if (st.commentary && !ev.commentary) ev.commentary = describeTestBall(st, inn, inn.ballLog.length - 1);
  if (inn.wickets >= 10 || ended) { closeInnings(st, inn, "all_out"); return true; }
  if (inn.number === 4 && inn.runs >= (testTarget(st) ?? Infinity)) { closeInnings(st, inn, "target"); return true; }
  // a batter goes off hurt (Cricsheet Tests: 46 in 1.73m deliveries) and comes back if nobody else is left
  if (legal && rngOf(st)() < RETIRED_HURT_PER_BALL) {
    const id = inn.strikerId;
    const incoming = nextBatter(inn);
    if (incoming) {
      inn.batters[id].retiredHurt = true;
      (inn.retiredHurt ??= []).push(id);
      inn.strikerId = incoming;
    }
  }
  if (inn.overBalls >= 6) endOver(st, inn);
  return false;
}

const RETIRED_HURT_PER_BALL = 46 / 1.73e6;

function endOver(st: TestMatchState, inn: TestInnings): void {
  const id = inn.ends[inn.end]!;
  const line = bowlerLine(inn, id);
  if (inn.overRuns === 0) line.maidens++;
  line.spellOvers++;
  line.lastOver = Math.floor(inn.legalBalls / 6) - 1;
  (line.dayOvers ??= [])[st.day - 1] = (line.dayOvers[st.day - 1] ?? 0) + 1;
  const dt = ((inn.dayTypeOvers ??= [])[st.day - 1] ??= [0, 0]);
  dt[st.players[id].spin ? 1 : 0]++;
  inn.overBalls = 0;
  inn.overRuns = 0;
  [inn.strikerId, inn.nonStrikerId] = [inn.nonStrikerId, inn.strikerId];
  inn.end = inn.end === 0 ? 1 : 0;
  noteSession(st, inn);
  const overs = Math.floor(inn.legalBalls / 6);
  if (!inn.newBallDue && overs - inn.ballTakenAt >= 80) inn.newBallDue = true;
  // the batting captain: push for, then make, a declaration (innings 1-3)
  if (inn.number <= 3 && st.status === "in_progress" && !isUserSide(st, inn.battingTeamId)) cpuDeclaration(st, inn);
}

// ── The captains (fitted policies) ──────────────────────────────────────────────────────────────────────────────────

/** Hazard of declaring at the end of this over (logistic fits per innings, TEST_MODEL.policy.declare) */
export function declarationHazard(st: TestMatchState, inn: TestInnings): number {
  const D = M.policy.declare;
  const lead = testLead(st);
  const ol = oversLeftInMatch(st);
  const w = inn.wickets;
  if (inn.number === 1) {
    if (inn.runs < 250) return 0;
    const c = D.inn1.coef;
    return logistic(c.intercept + c["runs/100"] * inn.runs / 100 + c["matchOvers/90"] * (st.matchBalls / 6) / 90 + c.wickets * w);
  }
  if (inn.number === 2) {
    if (lead < -50) return 0;
    const c = D.inn2.coef;
    return logistic(c.intercept + c["lead/100"] * lead / 100 + c["oversLeft/90"] * ol / 90 + c.wickets * w);
  }
  if (inn.number === 3) {
    if (lead < 100) return 0;
    const c = D.inn3.coef;
    return logistic(c.intercept + c["lead/100"] * lead / 100 + c["oversLeft/90"] * ol / 90 + c["lead/oversLeft"] * lead / Math.max(ol, 10) + c.wickets * w);
  }
  return 0;
}

/**
 * Real sides push in the overs before they declare (the fitted "push" situation: the last 12 overs of declared innings). The
 * CPU starts pushing once its declaration hazard passes PUSH_HAZARD, so the push lasts about as long as the data's.
 */
export const PUSH_HAZARD = 0.02;

function cpuDeclaration(st: TestMatchState, inn: TestInnings): void {
  const h = declarationHazard(st, inn);
  if (h <= 0) return;
  if (inn.pushFrom === undefined && h >= PUSH_HAZARD) inn.pushFrom = Math.floor(inn.legalBalls / 6);
  if (rngOf(st)() < h) declareInnings(st);
}

/** The follow-on margin for the match length (Law 14: 200 for five days or more, 150 for three or four, 100 for two) */
export function followOnMargin(days: number): number {
  return days >= 5 ? 200 : days >= 3 ? 150 : days === 2 ? 100 : 75;
}

/** Probability the CPU enforces the follow-on (logistic on the lead, the overs left and the overs its bowlers just fielded) */
export function followOnProbability(st: TestMatchState): number {
  const [i1, i2] = st.innings;
  const lead = i1.runs - i2.runs;
  const c = M.policy.followOn.coef;
  const margin = followOnMargin(st.days);
  return logistic(c.intercept + c["(lead-200)/100"] * (lead - margin) / 100 + c["oversLeft/90"] * oversLeftInMatch(st) / 90 + c["oversFielded/100"] * (i2.legalBalls / 6) / 100);
}

const SPELL = M.policy.spellLength as unknown as Readonly<Record<"pace" | "spin", Readonly<Record<string, number>>>>;
const MEAN_SPELL = {
  pace: Object.entries(SPELL.pace).reduce((a, [k, v]) => a + Number(k) * v, 0),
  spin: Object.entries(SPELL.spin).reduce((a, [k, v]) => a + Number(k) * v, 0),
};
/** Overs a bowler rests between spells: the fitted 10th percentile for his type (a spinner often just changes ends) */
const REST_OVERS = { pace: M.policy.restOvers.pace[0], spin: M.policy.restOvers.spin[0] };

/** Share of the overs spinners bowl, by region, ball age and day (TEST_MODEL.policy.spinShare) */
function spinShare(st: TestMatchState, inn: TestInnings): number {
  const t = (M.policy.spinShare as unknown as Record<string, number[][]>)[st.region];
  const ab = binOf(Math.floor(inn.legalBalls / 6) - inn.ballTakenAt, AGE_BINS);
  return t[ab][Math.min(st.day, 5) - 1];
}

/**
 * The fielding captain's bowler for the next over at the current end: the bowler there carries on until his spell (drawn
 * from the fitted spell lengths for his type) is done; then a fresh bowler, spin with the fitted share of the overs for the
 * ball's age, the day and the region, the best rested one of that type, kept under the fitted daily workloads.
 */
function chooseBowler(st: TestMatchState, inn: TestInnings, rng: RNG): string {
  const e = inn.end;
  const other = inn.ends[e === 0 ? 1 : 0];
  const picked = inn.nextBowler?.[e];
  if (picked && picked !== other) {
    inn.nextBowler![e] = null;
    const l = bowlerLine(inn, picked);
    if (inn.ends[e] !== picked) { l.spellOvers = 0; l.spellPlan = drawSpell(st, picked, rng); }
    return picked;
  }
  const cur = inn.ends[e];
  const overs = Math.floor(inn.legalBalls / 6);
  const capOf = (id: string) => st.players[id].spin ? M.policy.workload.day_spin[2] : M.policy.workload.day_pace[2];
  const today = (id: string) => inn.bowlers[id]?.dayOvers?.[st.day - 1] ?? 0;
  if (cur && cur !== other) {
    const l = inn.bowlers[cur];
    if (l && l.spellOvers < l.spellPlan && today(cur) < capOf(cur)) return cur;
  }
  const xi = st.teams[inn.bowlingTeamId].xi;
  const keeper = st.teams[inn.bowlingTeamId].keeperId;
  const rested = (id: string) => overs - (inn.bowlers[id]?.lastOver ?? -99) - 1 >= REST_OVERS[st.players[id].spin ? "spin" : "pace"] - 1;
  // every outfielder can be called on; part-timers rarely are (PART_TIMER weight on top of their low quality)
  let pool = xi.filter(id => id !== keeper && id !== other && id !== cur && rested(id) && today(id) < capOf(id));
  if (pool.length === 0) pool = xi.filter(id => id !== keeper && id !== other && today(id) < capOf(id));
  if (pool.length === 0) pool = xi.filter(id => id !== other && id !== keeper);
  // spells of spinners are longer, so the share of spells that are spin is set to give the fitted share of overs; when the
  // day's overs so far have fallen short of (or run past) that share, the captain leans the other way
  const ps = spinShare(st, inn);
  let pStart = (ps * MEAN_SPELL.pace) / (ps * MEAN_SPELL.pace + (1 - ps) * MEAN_SPELL.spin);
  const day = inn.dayTypeOvers?.[st.day - 1];
  if (day && day[0] + day[1] >= 6) pStart = Math.max(0, Math.min(1, pStart + SHARE_TRACKING * (ps - day[1] / (day[0] + day[1]))));
  const wantSpin = rng() < pStart;
  const ofType = pool.filter(id => st.players[id].spin === wantSpin);
  const from = ofType.length > 0 ? ofType : pool;
  // the better the bowler the more he is called on (weight exp(BOWLER_PREFERENCE x quality)), the longer rested the readier
  const weight = (id: string) => {
    const since = overs - (inn.bowlers[id]?.lastOver ?? -99) - 1;
    const form = 1 + WICKET_FORM * (inn.bowlers[id]?.wickets ?? 0);
    const part = st.players[id].bowler ? 1 : PART_TIMER;
    return Math.exp(BOWLER_PREFERENCE * st.players[id].bowlValue) * form * part * Math.min(1, 0.25 + since / 12);
  };
  const ws = from.map(weight);
  let x = rng() * ws.reduce((a, b) => a + b, 0);
  let best = from[from.length - 1];
  for (let j = 0; j < from.length; j++) { x -= ws[j]; if (x <= 0) { best = from[j]; break; } }
  const l = bowlerLine(inn, best);
  l.spellOvers = 0;
  l.spellPlan = drawSpell(st, best, rng);
  return best;
}

/**
 * Captains' bowling changes, calibrated to real Tests (benchmark-test.ts: overs and wickets of an innings' bowlers by rank,
 * five-fors): how strongly they favour better bowlers, how much a bowler's wickets in the innings make him the next choice, and
 * how many overs a wicket adds to his spell. The fitted wicket rate rising along a spell is this behaviour seen from the data.
 */
export const BOWLER_PREFERENCE = 6;
export const WICKET_FORM = 0.35;
export const WICKET_SPELL_EXTENSION = 2;
/** A part-timer's weight against a member of the attack of the same quality */
export const PART_TIMER = 0.5;
/** How hard the captain steers the day's spin share back to the fitted share */
export const SHARE_TRACKING = 2;

function drawSpell(st: TestMatchState, id: string, rng: RNG): number {
  return Number(sampleTable(SPELL[st.players[id].spin ? "spin" : "pace"], rng));
}

/** The new ball: the CPU takes it as soon as it is due (the fit assumes it is taken at 80 overs) */
function takeNewBallNow(st: TestMatchState, inn: TestInnings): void {
  inn.ballTakenAt = Math.floor(inn.legalBalls / 6);
  inn.newBalls++;
  inn.newBallDue = false;
  // the captain brings his strike bowlers back for it
  for (const id of inn.ends) if (id) { const l = inn.bowlers[id]; if (l) l.spellPlan = l.spellOvers; }
  st.events.push({ day: st.day, inn: inn.number, overs: inn.ballTakenAt, kind: "new_ball", text: `${st.teams[inn.bowlingTeamId].name} take the new ball after ${inn.ballTakenAt} overs.` });
}

// ── Innings and match ends ──────────────────────────────────────────────────────────────────────────────────────────

function closeInnings(st: TestMatchState, inn: TestInnings, reason: NonNullable<TestInnings["closed"]>): void {
  inn.closed = reason;
  const name = st.teams[inn.battingTeamId].name;
  st.events.push({
    day: st.day, inn: inn.number, overs: Math.floor(inn.legalBalls / 6), kind: reason === "declared" ? "declaration" : "innings_end",
    text: reason === "declared" ? `${name} declare at ${inn.runs}/${inn.wickets}.` : `${name} ${inn.runs}${inn.wickets < 10 ? "/" + inn.wickets : " all out"} (${oversText(inn.legalBalls)} ov).`,
  });
  if (inn.number === 4) return finishFourth(st, inn);
  if (reason === "time") return finishMatch(st, null, "draw", "");
  // the interval between innings costs two overs of the day (ICC Test playing conditions)
  st.dayCap = Math.max(Math.ceil(st.dayBalls / 6), st.dayCap - 2);
  const other = inn.bowlingTeamId;
  if (inn.number === 1) return startInnings(st, other, false);
  if (inn.number === 2) {
    const lead = st.innings[0].runs - inn.runs;
    if (lead >= followOnMargin(st.days)) {
      const captain = st.innings[0].battingTeamId;
      if (isUserSide(st, captain)) {
        st.status = "waiting_for_decision";
        st.pending = { type: "follow_on", teamId: captain, options: ["enforce", "bat"], context: { lead, oversLeft: Math.round(oversLeftInMatch(st)) } };
        return;
      }
      return applyFollowOn(st, rngOf(st)() < followOnProbability(st));
    }
    return startInnings(st, st.innings[0].battingTeamId, false);
  }
  // after the third innings: the side to bat last may already have won by an innings
  const fourth = other;
  const target = teamTotal(st, inn.battingTeamId) - teamTotal(st, fourth) + 1;
  if (target <= 0) return finishMatch(st, fourth, "win", `an innings and ${1 - target} run${1 - target === 1 ? "" : "s"}`);
  startInnings(st, fourth, false);
}

/** The follow-on call: enforce (the side behind bats again) or bat again yourself */
export function applyFollowOn(st: TestMatchState, enforce: boolean): void {
  st.pending = undefined;
  st.status = "in_progress";
  const [i1, i2] = st.innings;
  if (enforce) st.events.push({ day: st.day, inn: 2, overs: 0, kind: "follow_on", text: `${st.teams[i1.battingTeamId].name} enforce the follow-on, ${i1.runs - i2.runs} ahead.` });
  else st.events.push({ day: st.day, inn: 2, overs: 0, kind: "follow_on", text: `${st.teams[i1.battingTeamId].name} lead by ${i1.runs - i2.runs} and choose to bat again.` });
  startInnings(st, enforce ? i2.battingTeamId : i1.battingTeamId, enforce);
}

function finishFourth(st: TestMatchState, inn: TestInnings): void {
  const target = teamTotal(st, inn.bowlingTeamId) - teamTotal(st, inn.battingTeamId, 3) + 1;
  if (inn.runs >= target) return finishMatch(st, inn.battingTeamId, "win", `${10 - inn.wickets} wicket${10 - inn.wickets === 1 ? "" : "s"}`);
  if (inn.closed === "time") return finishMatch(st, null, "draw", "");
  if (inn.runs === target - 1) return finishMatch(st, null, "tie", "");
  const by = target - 1 - inn.runs;
  finishMatch(st, inn.bowlingTeamId, "win", `${by} run${by === 1 ? "" : "s"}`);
}

function finishMatch(st: TestMatchState, winnerId: string | null, kind: TestResult["kind"], margin: string): void {
  st.status = "completed";
  st.pending = undefined;
  const text = kind === "draw" ? "Match drawn" : kind === "tie" ? "Match tied" : `${st.teams[winnerId!].name} won by ${margin}`;
  st.result = { winnerId, kind, margin, text, day: st.day, playerOfMatch: playerOfMatch(st, winnerId) };
  st.events.push({ day: st.day, inn: st.innings.length, overs: Math.floor((currentInnings(st)?.legalBalls ?? 0) / 6), kind: "result", text: `${text}.` });
}

/** Player of the match: runs, wickets (more for five-fors and hundreds), a premium for the winning side */
function playerOfMatch(st: TestMatchState, winnerId: string | null): TestResult["playerOfMatch"] {
  let best = { playerId: "", playerName: "", reason: "", score: -1 };
  for (const t of Object.values(st.teams)) {
    for (const id of t.xi) {
      let runs = 0, wk = 0, conc = 0, score = 0;
      for (const inn of st.innings) {
        const b = inn.batters[id];
        if (b) { runs += b.runs; score += b.runs + (b.runs >= 100 ? 25 : 0); }
        const w = inn.bowlers[id];
        if (w) { wk += w.wickets; conc += w.runs; score += 22 * w.wickets + (w.wickets >= 5 ? 25 : 0); }
      }
      if (winnerId && t.id === winnerId) score *= 1.3;
      if (score > best.score) {
        const parts = [runs > 0 ? `${runs} runs` : "", wk > 0 ? `${wk}/${conc}` : ""].filter(Boolean);
        best = { playerId: id, playerName: st.players[id].name, reason: parts.join(" & "), score };
      }
    }
  }
  return { playerId: best.playerId, playerName: best.playerName, reason: best.reason };
}

// ── Stepping ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Bowl the next delivery (handling the start of the over, the new ball, the end of the day). Returns the ball, or null when
 * the match is over or waiting for a decision (state.pending).
 */
export function stepTestBall(st: TestMatchState): TestBallEvent | null {
  if (st.status !== "in_progress") return null;
  const rng = rngOf(st);
  let inn = currentInnings(st)!;
  if (inn.overBalls === 0) {
    if (st.dayBalls >= st.dayCap * 6) {
      endDay(st);
      if (st.status !== "in_progress") return null;
      inn = currentInnings(st)!;
    }
    if (inn.newBallDue) {
      if (!isUserSide(st, inn.bowlingTeamId)) takeNewBallNow(st, inn);
      else if (inn.newBalls === inn.ballTakenAt / 80 + 1 && !(inn as { asked?: number }).asked) {
        (inn as { asked?: number }).asked = inn.ballTakenAt;
        st.status = "waiting_for_decision";
        st.pending = { type: "new_ball", teamId: inn.bowlingTeamId, options: ["take", "wait"] };
        return null;
      }
    }
    inn.ends[inn.end] = chooseBowler(st, inn, rng);
  }
  const ev = deliver(st, inn, rng);
  if (!ev) return null;
  applyBall(st, inn, ev);
  return ev;
}

/** Run the match to its end with the CPU taking every decision (the user's too) */
export function runTestToEnd(st: TestMatchState): void {
  const saved = st.autoUser;
  st.autoUser = true;
  for (let guard = 0; st.status !== "completed" && guard < 20000; guard++) {
    if (st.status === "waiting_for_decision") { autoResolveTestDecision(st); continue; }
    stepTestBall(st);
  }
  st.autoUser = saved;
}

// ── Decisions (user calls, or the CPU's answer to them) ─────────────────────────────────────────────────────────────

/** Answer the pending decision with one of its options */
export function applyTestDecision(st: TestMatchState, choice: string): TestBallEvent | null {
  const p = st.pending;
  if (st.status !== "waiting_for_decision" || !p) throw new Error("No pending decision");
  if (!p.options.includes(choice)) throw new Error(`Invalid choice ${choice} for ${p.type}`);
  switch (p.type) {
    case "toss":
      applyToss(st, p.teamId, choice as "bat" | "bowl");
      return null;
    case "follow_on":
      applyFollowOn(st, choice === "enforce");
      return null;
    case "new_ball": {
      st.pending = undefined;
      st.status = "in_progress";
      const inn = currentInnings(st)!;
      if (choice === "take") takeNewBallNow(st, inn);
      return null;
    }
    case "drs_batting":
    case "drs_fielding": {
      const ev = resolveHeld(st, choice === "review");
      const inn = currentInnings(st)!;
      applyBall(st, inn, ev);
      return ev;
    }
  }
}

/** The CPU's answer to the pending decision (the fitted policies; a review with the fitted review rates) */
export function autoResolveTestDecision(st: TestMatchState): TestBallEvent | null {
  const p = st.pending;
  if (!p) return null;
  const rng = rngOf(st);
  switch (p.type) {
    case "toss": return applyTestDecision(st, cpuTossDecision(st, rng));
    case "follow_on": return applyTestDecision(st, rng() < followOnProbability(st) ? "enforce" : "bat");
    case "new_ball": return applyTestDecision(st, "take");
    case "drs_batting": {
      const h = st.heldBall!;
      const R = DRS_RATES[h.kind];
      // a wrong out is always reviewed by real sides that have a review (that is how it is counted), a right one at the fitted rate
      return applyTestDecision(st, !h.trulyOut || rng() < R.batReviewOfWicket ? "review" : "accept");
    }
    case "drs_fielding": {
      const h = st.heldBall!;
      return applyTestDecision(st, h.trulyOut ? "review" : rng() < 0.5 ? "review" : "decline");
    }
  }
}

/** The batting side declares now (between deliveries) */
export function declareInnings(st: TestMatchState): void {
  const inn = currentInnings(st);
  if (!inn || inn.closed || st.status === "completed" || inn.number === 4) return;
  closeInnings(st, inn, "declared");
}

/** A side's batting approach; null hands it back to the captain's fitted policy */
export function setTestApproach(st: TestMatchState, teamId: string, approach: TestApproach | null): void {
  st.teams[teamId].approach = approach;
}

/** The fielding side takes the new ball from the next over (once 80 overs have been bowled with the old one) */
export function takeNewBall(st: TestMatchState): boolean {
  const inn = currentInnings(st);
  if (!inn || Math.floor(inn.legalBalls / 6) - inn.ballTakenAt < 80) return false;
  if (st.pending?.type === "new_ball") { st.pending = undefined; st.status = "in_progress"; }
  takeNewBallNow(st, inn);
  return true;
}

/**
 * The fielding captain puts `bowlerId` on at the end that bowls next (from the next over if one is in progress). He bowls a
 * spell of the usual length for his type, or until changed with `keepOn`. Throws if he bowled the previous over.
 */
export function changeTestBowler(st: TestMatchState, bowlerId: string, opts: { keepOn?: boolean } = {}): void {
  const inn = currentInnings(st);
  if (!inn) return;
  if (!st.teams[inn.bowlingTeamId].xi.includes(bowlerId)) throw new Error(`${bowlerId} is not in the fielding XI`);
  const e = inn.overBalls === 0 ? inn.end : (inn.end === 0 ? 1 : 0);
  const other = inn.overBalls === 0 ? inn.ends[e === 0 ? 1 : 0] : inn.ends[inn.end];
  if (bowlerId === other) throw new Error("A bowler cannot bowl two overs in a row");
  (inn.nextBowler ??= [null, null])[e] = bowlerId;
  if (opts.keepOn) { const l = bowlerLine(inn, bowlerId); l.spellPlan = 999; }
}

// ── Commentary, scorecards, results ─────────────────────────────────────────────────────────────────────────────────

/** Commentary for a ball of the log (deterministic for the ball; uses its own random stream) */
export function describeTestBall(st: TestMatchState, inn: TestInnings, index: number): string {
  const ev = inn.ballLog[index];
  const legal = ev.outcome !== "wide" && ev.outcome !== "noball";
  const detail: DeliveryDetail = {
    outcome: ev.outcome, legal, batRuns: ev.runs, batBoundary: ev.boundary ?? 0, wides: ev.wides ?? 0, noBalls: ev.noBalls ?? 0,
    byes: ev.byes ?? 0, legByes: ev.legByes ?? 0, penalty: 0, extras: ev.extras, runsRun: ev.boundary ? 0 : ev.runs, overthrow: 0, freeHitNext: false,
    ...(ev.isWicket ? { dismissal: {
      kind: ev.wicketType!, out: ev.playerOutId && ev.playerOutId !== ev.batter ? "nonStriker" as const : "striker" as const,
      fielderId: ev.fielderId, fielder2Id: ev.fielder2Id, bowlerCredit: isBowlerWicket(ev.wicketType), newBatterFaces: true,
    } } : {}),
  };
  let s = (st.seed ^ (inn.number * 7919 + index * 104729)) >>> 0;
  const rng: RNG = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const name = (id?: string) => (id ? st.players[id]?.name : undefined);
  const bat = inn.batters[ev.batter];
  let text = generateDeliveryCommentary({
    detail, bowlerName: name(ev.bowler)!, batterName: name(ev.batter)!, nonStrikerName: name(ev.nonStriker),
    fielderName: name(ev.fielderId), fielder2Name: name(ev.fielder2Id), over: ev.over, ball: ev.ball, score: ev.score, wickets: ev.wickets,
    isSecondInnings: inn.number === 4, target: inn.number === 4 ? testTarget(st) : undefined, bowlingStyle: st.players[ev.bowler]?.bowlingStyle,
    battingHand: st.players[ev.batter]?.battingHand, gender: st.gender, batterRuns: bat?.runs, batterBalls: bat?.balls, rng,
  }).text;
  if (!ev.isWicket && ev.fieldingNote === "dropped_catch") text += ` Dropped! ${name(ev.fielderId) ?? "The fielder"} puts down the chance.`;
  if (!ev.isWicket && ev.fieldingNote === "missed_stumping") text += ` ${name(ev.fielderId) ?? "The keeper"} misses the stumping.`;
  if (ev.review) text += " " + drsText(ev.review, st.teams[ev.review.by === "batting" ? inn.battingTeamId : inn.bowlingTeamId].name, rng);
  return text;
}

/** An innings as a scorecard (the same shape as the limited-overs scorecards) */
export function testInningsScorecard(st: TestMatchState, inn: TestInnings): InningsScorecard {
  const name = (id?: string) => (id ? st.players[id]?.name ?? id : undefined);
  const batters: BatterInnings[] = [];
  const seen = Object.entries(inn.batters).sort((a, b) => a[1].arrived - b[1].arrived);
  for (const [id, b] of seen) {
    let howOut = b.retiredHurt ? "retired hurt" : "not out";
    if (b.out && b.kind) howOut = dismissalText({ kind: b.kind, bowler: name(b.bowlerId), fielder: name(b.fielderId) });
    const f = inn.fow.find(x => x.playerId === id);
    batters.push({
      playerId: id, playerName: name(id)!, runs: b.runs, balls: b.balls, fours: b.fours, sixes: b.sixes,
      strikeRate: b.balls > 0 ? Math.round((b.runs / b.balls) * 1000) / 10 : 0, howOut,
      ...(f ? { fallOfWicket: `${f.runs}/${f.wickets} (${oversText(f.balls)} ov)` } : {}),
    });
  }
  const bowlers: BowlerFigures[] = Object.entries(inn.bowlers).filter(([, l]) => l.balls > 0 || l.runs > 0).map(([id, l]) => ({
    playerId: id, playerName: name(id)!, overs: `${Math.floor(l.balls / 6)}.${l.balls % 6}`, maidens: l.maidens, runs: l.runs, wickets: l.wickets,
    economy: l.balls > 0 ? Math.round((l.runs / (l.balls / 6)) * 100) / 100 : 0,
    dots: inn.ballLog.filter(e => e.bowler === id && e.outcome !== "wide" && e.outcome !== "noball" && e.runs === 0 && !e.wides && !e.noBalls).length,
    wides: l.wides, noBalls: l.noBalls,
  }));
  const x = inn.extras;
  return {
    battingTeamId: inn.battingTeamId, battingTeamName: st.teams[inn.battingTeamId].name,
    bowlingTeamId: inn.bowlingTeamId, bowlingTeamName: st.teams[inn.bowlingTeamId].name,
    totalRuns: inn.runs, totalWickets: inn.wickets, totalOvers: oversText(inn.legalBalls), batters, bowlers,
    extras: { wides: x.wides, noBalls: x.noBalls, legByes: x.legByes, total: x.wides + x.noBalls + x.byes + x.legByes + x.penalty, ...(x.byes ? { byes: x.byes } : {}) },
    fallOfWickets: inn.fow.map(f => `${f.runs}/${f.wickets} (${oversText(f.balls)} ov)`),
  };
}

export interface TestInningsSummary {
  number: 1 | 2 | 3 | 4;
  teamId: string;
  runs: number;
  wickets: number;
  overs: string;
  declared: boolean;
  followOn: boolean;
}

export interface TestMatchResult {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  toss: { winnerId: string; decision: "bat" | "bowl" };
  innings: TestInningsSummary[];
  result: TestResult;
  scorecards: InningsScorecard[];
  events: TestMatchEvent[];
  injuries: MatchInjuryEvent[];
  /** The finished match, ball logs included */
  state: TestMatchState;
}

/** The finished match as a result (summaries, scorecards, events) */
export function testMatchResult(st: TestMatchState): TestMatchResult {
  if (!st.result || !st.toss) throw new Error("The Test is not finished");
  return {
    id: st.id, homeTeamId: st.teamOrder[0], awayTeamId: st.teamOrder[1], toss: st.toss,
    innings: st.innings.map(i => ({ number: i.number, teamId: i.battingTeamId, runs: i.runs, wickets: i.wickets, overs: oversText(i.legalBalls), declared: i.closed === "declared", followOn: !!i.followOn })),
    result: st.result, scorecards: st.innings.map(i => testInningsScorecard(st, i)), events: st.events, injuries: st.injuries ?? [], state: st,
  };
}

/**
 * Simulate a whole Test instantly: CPU captains on both sides (fitted toss, bowling, declaration, follow-on and review policies).
 * Pass `seed` for a reproducible match.
 */
export function simulateTestMatch(home: Team, away: Team, options: TestMatchOptions = {}): TestMatchResult {
  const st = createTestMatch(home, away, { ...options, userTeamId: null });
  runTestToEnd(st);
  if (options.injuries) {
    st.injuries = [];
    for (const t of [home, away]) {
      const xi = st.teams[t.id].xi.map(id => t.roster.find(p => p.id === id)).filter((p): p is Player => !!p);
      for (const { player, injury } of runPostMatchInjuryChecks(xi, true, { gender: st.gender === "female" ? "women" : "men", format: "Test/FC" })) {
        st.injuries.push({ playerId: player.id, playerName: player.name, teamId: t.id, injury });
      }
    }
  }
  return testMatchResult(st);
}
