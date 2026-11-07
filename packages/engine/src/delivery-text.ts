/**
 * Hand-written lines for the deliveries the corpus model does not cover (docs/COMMENTARY.md section 8): every dismissal
 * kind with the right batter out, wides by size and kind, no-balls with bat runs / byes / the two-run cost, byes and leg
 * byes of 1 to 5, overthrows, penalty runs, free hits, the Mankad, retirements and the timed out. Used by the instant
 * engine (match.ts) for all of them and by the live path (commentary.ts generateDeliveryCommentary) whenever the corpus
 * has no fitting line.
 *
 * Rules the text follows: only people in the ball's context are named (bowler, striker, non-striker, the fielder(s));
 * the body of a line uses commentator short names ("Kohli"), the opening "Bowler to Batter" keeps the names as given;
 * no pronouns (so the same line fits men's and women's matches); no em dashes.
 */

import type { RNG } from "./rng.js";
import type { DeliveryDetail, DismissalKind } from "./delivery-rules.js";
import { commentaryShortName } from "./commentary-model.js";

export interface DeliveryTextInput {
  detail: Pick<DeliveryDetail, "outcome" | "batRuns" | "wides" | "noBalls" | "byes" | "legByes" | "penalty" | "overthrow" | "wideKind" | "dismissal"> & Partial<Pick<DeliveryDetail, "freeHitNext" | "noBallKind" | "beamer" | "penaltyReason">>;
  bowler: string;
  /** The striker (who played, or failed to play, the ball) */
  batter: string;
  nonStriker?: string;
  /** Catch / stumping / throw */
  fielder?: string;
  fielder2?: string;
  substitute?: boolean;
  freeHit?: boolean;
  /** The ball was a dead ball with no delivery (Mankad) */
  deadBall?: boolean;
  /** Use the names exactly as given in the body too (default: commentator short names) */
  fullNames?: boolean;
  rng: RNG;
}

function pick<T>(xs: readonly T[], rng: RNG): T {
  return xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))];
}

const runWord = (n: number) => `${n} run${n === 1 ? "" : "s"}`;
const NUMBER_WORD = ["no", "one", "two", "three", "four", "five", "six"];
const numWord = (n: number) => NUMBER_WORD[n] ?? String(n);
const upper = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

interface Names {
  B: string; S: string; N: string;
  /** fielder as the line says it ("substitute Jadeja", "the fielder") */
  F: string; F2: string;
  /** the keeper for a stumping */
  K: string;
  hasFielder: boolean; hasFielder2: boolean;
}

/** Short names for the body; two people who would shorten to the same word keep their full names */
function namesOf(i: DeliveryTextInput): Names {
  const raw = { B: i.bowler, S: i.batter, N: i.nonStriker ?? "", F: i.fielder ?? "", F2: i.fielder2 ?? "" };
  const short: Record<string, string> = {};
  const used = new Map<string, string>();
  for (const [k, v] of Object.entries(raw)) {
    if (!v) { short[k] = ""; continue; }
    const s = i.fullNames ? v : commentaryShortName(v);
    // the bowler can be the fielder (caught and bowled, a run out by the bowler): same person, same word
    const clash = [...used.entries()].find(([w, full]) => w === s && full !== v);
    short[k] = clash ? v : s;
    used.set(short[k], v);
  }
  const sub = i.substitute && i.fielder;
  const F = i.fielder ? (sub ? `substitute ${short.F}` : short.F) : "the fielder";
  return {
    B: short.B, S: short.S, N: short.N || "the non-striker", F, F2: short.F2,
    K: i.fielder ? short.F : "the keeper",
    hasFielder: !!i.fielder, hasFielder2: !!i.fielder2,
  };
}

/** The sentence(s) after "OUT!" for one dismissal; `out` is the short name of the batter who is out */
function dismissalBody(kind: DismissalKind, i: DeliveryTextInput, n: Names, out: string, outIsNonStriker: boolean): string {
  const { rng } = i;
  const O = out;
  switch (kind) {
    case "bowled": return pick([
      `Bowled! ${n.B} knocks over the stumps and ${O} has to go.`,
      `Cleaned up! The stumps are rattled and ${O} departs.`,
      `Through the gate! ${n.B} bowls a beauty and ${O} is clean bowled.`,
      `The middle stump is out of the ground! ${O} is bowled.`,
    ], rng);
    case "caught": return pick([
      `Caught! ${O} holes out and ${n.F} takes it safely. ${n.B} strikes.`,
      `In the air... and taken by ${n.F}! ${O} has to walk.`,
      `${O} goes for the big shot but only finds ${n.F}! ${n.B} is pumped.`,
      `Caught by ${n.F}! ${O} pays the price for going aerial.`,
    ], rng);
    case "caught_and_bowled": return pick([
      `Caught and bowled! ${n.B} plucks it out of the air and ${O} has to go.`,
      `Hit straight back, and ${n.B} holds on to a sharp return catch! ${O} is gone.`,
      `Returns to the bowler, ${n.B} takes it with both hands. ${O} is caught and bowled.`,
      `${O} spoons it back and ${n.B} grabs it. Caught and bowled!`,
    ], rng);
    case "lbw": return pick([
      `LBW! Struck on the pad in front of the stumps, the finger goes up. ${O} goes.`,
      `Trapped in front! ${n.B} appeals and the umpire raises the finger. ${O} has to go.`,
      `Huge appeal for lbw... and it is given! ${O} is out.`,
    ], rng);
    case "stumped": return pick([
      `Stumped! ${n.K} whips off the bails and ${O} is out of the crease.`,
      `${O} is beaten and stranded, and ${n.K} does the rest. Stumped!`,
      `Down the pitch, beaten, and ${n.K} is quick to break the stumps. ${O} is stumped.`,
    ], rng);
    case "hit_wicket": return pick([
      `Hit wicket! ${O} dislodges the bails with the bat while playing the shot.`,
      `Oh no! ${O} treads back onto the stumps as the shot is played. Hit wicket!`,
      `${O} knocks the bails off on the follow through. Hit wicket, and that is the end of the innings for ${O}.`,
    ], rng);
    case "run_out": {
      if (outIsNonStriker) {
        if (n.hasFielder && n.hasFielder2) return pick([
          `Run out! ${n.F} to ${n.F2}, the bails are off and ${O} is the man to go. ${n.S} stays.`,
          `${n.S} plays it and they go for the run. ${n.F} gathers, relays to ${n.F2}, and ${O} is short. Run out!`,
        ], rng);
        if (n.hasFielder) return pick([
          `Run out! ${n.S} plays it and they go for a run, but ${O} is the one short of the crease after ${n.F}'s throw.`,
          `A mix-up between the batters, and it is ${O} who is stranded. ${n.F} breaks the stumps. ${n.S} survives.`,
          `Direct hit from ${n.F}! ${O} is well short, and ${n.S} survives.`,
        ], rng);
        return pick([
          `Run out! A direct hit, and ${O} is short of the crease. ${n.S} survives.`,
          `A mix-up in the middle, and ${O} is the one left short. Run out, and ${n.S} stays.`,
        ], rng);
      }
      if (n.hasFielder && n.hasFielder2) return pick([
        `Run out! ${n.F} to ${n.F2}, the bails are off and ${O} is short of the crease.`,
        `${n.F} gathers, relays to ${n.F2}, who breaks the stumps. ${O} is run out.`,
      ], rng);
      if (n.hasFielder) return pick([
        `Run out! ${n.F} hits the stumps and ${O} is short of the crease.`,
        `Run out, a mix-up in the middle. ${O} is gone after ${n.F}'s throw.`,
        `Direct hit from ${n.F}! ${O} is well short.`,
      ], rng);
      return pick([
        `Run out! A direct hit, and ${O} is short of the crease.`,
        `Run out, a mix-up in the middle. ${O} is gone.`,
      ], rng);
    }
    case "obstructing_the_field": return pick([
      `Obstructing the field! ${O} gets in the way of the throw and the umpires send ${O} back.`,
      `${O} changes line mid-run and blocks the fielder's throw. Given out, obstructing the field!`,
    ], rng);
    case "handled_the_ball": return pick([
      `Handled the ball! ${O} knocks it away with the hand, not the bat, and the appeal is upheld.`,
      `${O} picks the ball up to stop it rolling onto the stumps. Out, handled the ball!`,
    ], rng);
    case "hit_the_ball_twice": return pick([
      `Hit the ball twice! ${O} plays at it again to keep it away from the stumps, and that is out.`,
      `A second stroke at the ball, and the umpires have no choice. ${O} is out, hit the ball twice!`,
    ], rng);
    case "timed_out": return pick([
      `${O} is timed out! The new batter was not ready to face in time.`,
      `Timed out! ${O} took too long to get to the crease and walks off without facing a ball.`,
    ], rng);
    case "retired_out": return `${O} retires out and walks off. A tactical retirement, so it does not count as a wicket.`;
  }
}

/** "Bowler to Batter, OUT! ..." for one dismissal (kept for callers that name the out batter themselves) */
export function describeDismissal(kind: DismissalKind, i: DeliveryTextInput, outName: string): string {
  const n = namesOf(i);
  if (kind === "timed_out" || kind === "retired_out") return dismissalBody(kind, i, n, i.fullNames ? outName : commentaryShortName(outName), false);
  const outIsNs = !!i.nonStriker && outName === i.nonStriker && outName !== i.batter;
  const short = i.fullNames ? outName : commentaryShortName(outName);
  const out = outIsNs ? n.N : outName === i.batter ? n.S : short;
  return `${i.bowler} to ${i.batter}, OUT! ${dismissalBody(kind, i, n, out, outIsNs)}`;
}

/* ─────────────────────────── extras ─────────────────────────── */

function wideLine(i: DeliveryTextInput, n: Names, fh: string, pre: string): string {
  const d = i.detail;
  const w = d.wides;
  const kind = d.wideKind ?? "off";
  const rng = i.rng;
  let body: string;
  if (w >= 5) {
    body = kind === "height"
      ? pick([`Sails over ${n.S}'s head, called wide for height, and it flies away to the boundary: FIVE wides!`, `A wide for height, and it races to the fence. Five wides!`], rng)
      : kind === "leg"
        ? pick([`Down the leg side, beats the keeper and runs away to the boundary: FIVE wides!`, `Way down leg, the keeper cannot stop it and it goes for four more. Five wides!`], rng)
        : pick([`Well outside off, beats the keeper and races away to the boundary: FIVE wides!`, `Wide outside off, the keeper cannot gather and it runs away for four. Five wides!`], rng);
  } else if (w >= 2) {
    const more = w - 1;
    body = (kind === "height"
      ? pick([`Over ${n.S}'s head, called wide for height, and the keeper cannot hold it. They run ${numWord(more)} more: ${w} wides.`, `Wide for height, it goes past the keeper and they scamper ${numWord(more)} more: ${w} wides.`], rng)
      : kind === "leg"
        ? pick([`Down the leg side, the keeper has to chase it and they run ${numWord(more)} more: ${w} wides.`, `Strays down leg and gets past the keeper. They take ${numWord(more)} more: ${w} wides.`, `Too much down leg, ${n.S} lets it go, and the batters hurry ${numWord(more)} more: ${w} wides.`], rng)
        : pick([`Wide outside off, past the keeper, and they run ${numWord(more)} more: ${w} wides.`, `Too far outside off, the keeper cannot gather it cleanly, and they run ${numWord(more)} more: ${w} wides.`, `Sprayed wide of off stump, ${n.S} leaves it alone, and the batters steal ${numWord(more)} more while the keeper chases: ${w} wides.`], rng));
  } else {
    body = kind === "height"
      ? pick([`Over ${n.S}'s head, called wide for height.`, `A high one sails over ${n.S}'s head, and it is a wide for height.`], rng)
      : kind === "leg"
        ? pick([`Down the leg side, wide.`, `Strays down leg and the umpire signals wide.`, `${n.B} loses the line, well down the leg side, and it is called wide.`], rng)
        : pick([`Too far outside off, the umpire stretches out both arms.`, `Drifts wide of off stump, and it is called wide.`, `${n.B} misses the target, well outside off, and the umpire signals wide.`], rng);
  }
  const tail = i.freeHit ? ` ${pick(["The free hit stays for the next ball.", "That means the free hit carries over."], rng)}` : "";
  return `${fh}${pre}, wide. ${body}${tail}`;
}

function noBallLine(i: DeliveryTextInput, n: Names, fh: string, pre: string): string {
  const d = i.detail;
  const rng = i.rng;
  const k = d.noBallKind;
  const reason = k === "height"
    ? (d.beamer
      ? pick(["A beamer! A full toss above the waist, and the umpire calls no ball.", "That is a dangerous full toss, head high: no ball."], rng)
      : pick(["A high full toss above the waist, called no ball.", "Too high: a bouncer over the batter's head is a no ball.", "Above waist height, so the umpire signals no ball."], rng))
    : k === "fielding"
      ? pick(["Too many fielders outside the circle, so the umpire calls no ball!", "The fielding side has broken the fielding restrictions: no ball."], rng)
      : k === "front_foot"
        ? pick(["Overstepped.", "Front foot no ball.", "The umpire signals no ball, the bowler has overstepped."], rng)
        : pick(["Overstepped.", "Front foot no ball.", "The umpire signals no ball, the bowler has overstepped.", "A high full toss, and the umpire calls no ball."], rng);
  const cost = d.noBalls >= 2 ? `That costs ${numWord(d.noBalls)} runs.` : "One extra.";
  const bits: string[] = [];
  if (d.batRuns >= 6) bits.push(`SIX off the no ball! ${n.S} sends it into the stands.`);
  else if (d.batRuns === 4) bits.push(`FOUR off the no ball! ${n.S} punishes the overstep.`);
  else if (d.batRuns > 0) bits.push(`${upper(n.S)} takes ${runWord(d.batRuns)} off the bat.`);
  if (d.byes > 0) bits.push(`${upper(runWord(d.byes))} of byes as well.`);
  if (d.legByes > 0) bits.push(`${upper(runWord(d.legByes))} of leg byes as well.`);
  if (bits.length === 0) bits.push(pick([`Nothing off the bat.`, `${n.S} cannot make anything of it.`], rng));
  const next = i.freeHit
    ? pick(["The free hit stays for the next ball.", "And that means another free hit!"], rng)
    : pick(["Free hit next ball!", "The next ball is a free hit!", "Free hit coming up."], rng);
  return `${fh}${pre}, NO BALL! ${reason} ${cost} ${bits.join(" ")} ${next}`;
}

function byeLine(i: DeliveryTextInput, fh: string, pre: string): string {
  const d = i.detail;
  const rng = i.rng;
  const isBye = d.byes > 0;
  const n = isBye ? d.byes : d.legByes;
  const unit = isBye ? "bye" : "leg bye";
  if (n >= 5) return `${fh}${pre}, FIVE ${unit}s! ${isBye ? "Past the bat and the keeper, away to the fence, and they steal one more." : "Off the pad, away to the fence, and they steal one more."}`;
  if (n === 4) return `${fh}${pre}, FOUR ${unit}s! ${isBye ? pick(["Beats the bat and beats the keeper, and it races to the boundary.", "The keeper has no chance, it runs away to the boundary."], rng) : pick(["Off the pad and away to the boundary.", "Flicked off the thigh pad, and it runs away to the fence."], rng)}`;
  if (n === 1) return `${fh}${pre}, 1 ${unit}. ${isBye ? pick(["Beats the bat and the keeper, and they sneak a bye.", "Past the bat, and the keeper cannot gather, so they steal a bye."], rng) : pick(["Off the pad, they scamper through for one.", "Hit on the pads, a leg bye is taken."], rng)}`;
  return `${fh}${pre}, ${n} ${unit}s. ${isBye ? pick(["Past the bat and the keeper has to chase, so they run " + numWord(n) + ".", "Beats everything and they come back for " + numWord(n) + " byes.", "The keeper dives and cannot stop it, so they scurry " + numWord(n) + " byes."], rng) : pick([`Off the pad and into the gap, they run ${numWord(n)}.`, `Struck on the pad, the ball rolls away and they run ${numWord(n)}.`, `Deflected off the thigh and away, and they hurry ${numWord(n)} leg byes.`], rng)}`;
}

const FREE_HIT_PLAIN: Record<string, (n: Names, rng: RNG) => string> = {
  "0": (n, rng) => pick([`no run. A free hit wasted, ${n.S} cannot get it away.`, `no run. ${n.B} keeps it tight and ${n.S} cannot make the free hit count.`], rng),
  "1": (n, rng) => pick([`1 run. Only a single from the free hit.`, `1 run. ${upper(n.S)} takes the single, not much to show for a free hit.`], rng),
  "2": (n, rng) => pick([`2 runs. Placed into the gap, two off the free hit.`, `2 runs. ${upper(n.S)} finds the gap and they come back for the second, two off the free hit.`], rng),
  "3": (n, rng) => pick([`3 runs. Three off the free hit, good running.`, `3 runs. ${upper(n.S)} hits it into the deep and they run three on the free hit.`], rng),
  "4": (n, rng) => pick([`FOUR! ${upper(n.S)} makes the free hit count, it races away to the boundary!`, `FOUR! A free swing from ${n.S} and it screams away to the fence!`], rng),
  "6": (n, rng) => pick([`SIX! ${upper(n.S)} swings freely and sends the free hit into the stands!`, `SIX! The free hit is dispatched over the rope by ${n.S}!`], rng),
};

function overthrowLine(i: DeliveryTextInput, fh: string, pre: string): string {
  const d = i.detail;
  const rng = i.rng;
  const base = Math.max(0, d.batRuns - d.overthrow);
  const first = base === 0 ? "no run at first" : `${runWord(base)} taken`;
  return `${fh}${pre}, ${first}, but there are overthrows! ${pick([
    `The throw misses the stumps and runs away to the boundary for four more.`,
    `A wild throw at the stumps, nobody backs up, and it goes to the fence for four more.`,
  ], rng)} ${upper(runWord(d.batRuns))} in all.`;
}

function penaltyTail(rng: RNG, reason?: "helmet" | "fielding" | "other"): string {
  if (reason === "helmet") return pick([
    "The ball hits the helmet lying on the ground behind the keeper, so it is five penalty runs!",
    "It rolls into the keeper's helmet on the ground: five penalty runs to the batting side.",
  ], rng);
  if (reason === "fielding") return pick([
    "The umpires rule illegal fielding and award five penalty runs to the batting side!",
    "A fielder is penalised for deliberately distracting the batters: five penalty runs.",
  ], rng);
  return pick([
    "Five penalty runs are awarded to the batting side!",
    "The umpires signal five penalty runs.",
  ], rng);
}

/* ─────────────────────────── the line ─────────────────────────── */

/** The line for a delivery, or undefined when the ordinary line for the outcome fits */
export function describeDelivery(i: DeliveryTextInput): string | undefined {
  const t = describeDeliveryRaw(i);
  return t === undefined ? t : t.replace(/(^|[.!?]\s+)substitute\b/g, (_m, p: string) => p + "Substitute");
}

function describeDeliveryRaw(i: DeliveryTextInput): string | undefined {
  const d = i.detail;
  // hot path of the instant engine: an ordinary scoring ball has no special line
  if (!d.dismissal && !i.freeHit && !i.deadBall && d.overthrow === 0 && d.penalty === 0 && d.outcome !== "wide" && d.outcome !== "noball" && d.outcome !== "legbye") return undefined;
  const n = namesOf(i);
  const rng = i.rng;
  const pre = `${i.bowler} to ${i.batter}`;
  const fh = i.freeHit ? "FREE HIT! " : "";
  const tail: string[] = [];
  if (d.overthrow && (d.dismissal || d.outcome !== "dot" && d.outcome !== "1" && d.outcome !== "2" && d.outcome !== "3")) tail.push(`Overthrows, and ${numWord(d.overthrow)} more runs are added!`);
  if (d.penalty) tail.push(penaltyTail(rng, d.penaltyReason));
  const suffix = tail.length > 0 ? " " + tail.join(" ") : "";

  if (i.deadBall && d.dismissal) {
    return pick([
      `${i.bowler}, OUT! Mankad! ${n.B} stops in the delivery stride and whips the bails off at the non-striker's end. ${n.N} was backing up too far and is run out. No ball is bowled.`,
      `${n.B} breaks the stumps at the non-striker's end before delivering! ${n.N} was out of the crease, and ${n.S} looks on from the other end. Run out, and no ball is bowled.`,
    ], rng);
  }

  if (d.dismissal) {
    const nsOut = d.dismissal.out === "nonStriker" && !!i.nonStriker;
    const out = nsOut ? n.N : n.S;
    const lead = d.outcome === "wide" ? "wide, but OUT!" : d.outcome === "noball" ? "NO BALL, but OUT!" : "OUT!";
    let t = `${fh}${pre}, ${lead} ${dismissalBody(d.dismissal.kind, i, n, out, nsOut)}`;
    if (d.outcome === "wide") t += i.freeHit ? " It was a wide as well, so one extra, and the free hit stays for the next ball." : " It was a wide as well, so one extra goes on the board.";
    else if (d.outcome === "noball") {
      const cost = d.noBalls > 1 ? `${numWord(d.noBalls)} extras` : "one extra";
      t += i.freeHit ? ` It was a no ball too, ${cost}, and the free hit stays for the next ball.` : ` It was a no ball too, ${cost}, so a free hit follows.`;
    } else if (d.batRuns > 0) t += ` ${d.batRuns === 1 ? "1 run was" : `${d.batRuns} runs were`} completed first.`;
    return t + suffix;
  }

  switch (d.outcome) {
    case "wide": return wideLine(i, n, fh, pre) + suffix;
    case "noball": return noBallLine(i, n, fh, pre) + suffix;
    case "legbye": return byeLine(i, fh, pre) + suffix;
    default: {
      if (d.overthrow) return overthrowLine(i, fh, pre) + suffix;
      if (i.freeHit) {
        const f = FREE_HIT_PLAIN[d.batRuns >= 6 ? "6" : String(Math.min(d.batRuns, 4))];
        if (f) return `${fh}${pre}, ${f(n, rng)}${suffix}`;
      }
      if (suffix) return `${pre}, ${d.batRuns === 0 ? "no run." : d.batRuns >= 6 ? "SIX!" : d.batRuns >= 4 ? "FOUR!" : runWord(d.batRuns) + "."}${suffix}`;
      return undefined;
    }
  }
}

/* ─────────────────── events between balls ─────────────────── */

/** A batter leaves the field injured (not out; may bat again later) */
export function retiredHurtLine(batter: string, rng: RNG): string {
  const b = commentaryShortName(batter);
  return pick([
    `${b} is forced to retire hurt and walks off, and the physio goes out with a concerned look. It is not a wicket, and ${b} may come back later.`,
    `Trouble for the batting side: ${b} cannot continue and retires hurt. Not out, and ${b} can return if fit.`,
  ], rng);
}

/** A tactical retirement (out of the innings for good, not a wicket) */
export function retiredOutLine(batter: string, rng: RNG): string {
  const b = commentaryShortName(batter);
  return pick([
    `${b} retires out and walks off. A tactical call, it does not count as a wicket, and ${b} cannot bat again.`,
    `${b} is retired out, a tactical switch by the batting side. Not a wicket, but the innings is over for ${b}.`,
  ], rng);
}

/** A batter is timed out before facing */
export function timedOutLine(batter: string, rng: RNG): string {
  const b = commentaryShortName(batter);
  return pick([
    `${b} is timed out! The new batter was not ready to face in time, and it counts as a wicket.`,
    `Timed out! ${b} took too long to take guard and is given out without facing a ball.`,
  ], rng);
}

/** Super over milestones */
export function superOverLine(kind: "start" | "tied" | "end", rng: RNG): string {
  switch (kind) {
    case "start": return pick(["The scores are level, so we go to a super over!", "Tied! Nothing between the sides, and it will be decided in a super over."], rng);
    case "tied": return pick(["Level again after the super over! Another super over to settle it.", "Still tied, and the umpires call for another super over."], rng);
    case "end": return pick(["That is the end of the super over.", "And the super over is done."], rng);
  }
}
