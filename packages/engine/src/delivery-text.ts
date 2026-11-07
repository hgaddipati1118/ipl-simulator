/**
 * One-line descriptions of the deliveries the plain run / four / six / dot lines do not cover: every dismissal kind
 * (with the right batter out), wides and no-balls with their runs, byes, leg byes, overthrows, penalty runs, free hits,
 * a Mankad, retirements. Used by the instant engine for all of them and by the live engine as the built-in fallback.
 */

import type { RNG } from "./rng.js";
import type { DeliveryDetail, DismissalKind } from "./delivery-rules.js";

export interface DeliveryTextInput {
  detail: Pick<DeliveryDetail, "outcome" | "batRuns" | "wides" | "noBalls" | "byes" | "legByes" | "penalty" | "overthrow" | "wideKind" | "dismissal">;
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
  rng: RNG;
}

function pick<T>(xs: readonly T[], rng: RNG): T {
  return xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))];
}

const runWord = (n: number) => `${n} run${n === 1 ? "" : "s"}`;

export function describeDismissal(kind: DismissalKind, i: DeliveryTextInput, outName: string): string {
  const { bowler, batter, rng } = i;
  const f = i.fielder ? (i.substitute ? `substitute ${i.fielder}` : i.fielder) : "the fielder";
  const pre = `${bowler} to ${batter}`;
  switch (kind) {
    case "bowled": return `${pre}, OUT! Bowled! ${outName} is clean bowled by ${bowler}.`;
    case "caught": return pick([
      `${pre}, OUT! Caught by ${f}. ${outName} has to go.`,
      `${pre}, OUT! In the air... and taken by ${f}! ${bowler} strikes.`,
    ], rng);
    case "caught_and_bowled": return pick([
      `${pre}, OUT! Caught and bowled! ${bowler} takes it back-handed.`,
      `${pre}, OUT! Returns to the bowler, ${bowler} holds on. Caught and bowled!`,
    ], rng);
    case "lbw": return `${pre}, OUT! LBW! Struck on the pad in front, the finger goes up. ${outName} goes.`;
    case "stumped": return `${pre}, OUT! Stumped! ${i.fielder ?? "The keeper"} whips off the bails and ${outName} is out of the crease.`;
    case "hit_wicket": return `${pre}, OUT! Hit wicket! ${outName} breaks the stumps with the bat on the way back.`;
    case "run_out": {
      const who = outName === batter ? batter : `${outName} at the non-striker's end`;
      const throwBy = i.fielder2 ? `${i.fielder} to ${i.fielder2}` : f;
      return pick([
        `${pre}, OUT! Run out! ${throwBy} breaks the stumps and ${who} is short of the crease.`,
        `${pre}, OUT! Run out, a mix-up in the middle. ${who} is gone after ${throwBy}'s throw.`,
      ], rng);
    }
    case "obstructing_the_field": return `${pre}, OUT! Obstructing the field! ${outName} gets in the way of the throw and the umpires send him back.`;
    case "handled_the_ball": return `${pre}, OUT! Handled the ball! ${outName} picks it up with the hand and the appeal is upheld.`;
    case "hit_the_ball_twice": return `${pre}, OUT! Hit the ball twice! ${outName} plays it a second time to protect the stumps.`;
    case "timed_out": return `${outName} is timed out! The new batter has not taken guard in time.`;
    case "retired_out": return `${outName} retires out and walks off.`;
  }
}

/** The line for a delivery, or undefined when the ordinary line for the outcome fits */
export function describeDelivery(i: DeliveryTextInput): string | undefined {
  const d = i.detail;
  const pre = `${i.bowler} to ${i.batter}`;
  const fh = i.freeHit ? "FREE HIT! " : "";
  const tail: string[] = [];
  if (d.overthrow) tail.push(`Overthrows, and ${d.overthrow} more runs are added!`);
  if (d.penalty) tail.push(`Five penalty runs are awarded.`);
  const suffix = tail.length > 0 ? " " + tail.join(" ") : "";

  if (i.deadBall && d.dismissal) {
    const who = i.nonStriker ?? "the non-striker";
    return `${i.bowler} whips off the bails at the non-striker's end before delivering: ${who} is run out backing up. No ball is bowled.`;
  }
  if (d.dismissal) {
    const out = d.dismissal.out === "nonStriker" ? i.nonStriker ?? "the non-striker" : i.batter;
    let t = describeDismissal(d.dismissal.kind, i, out);
    if (d.outcome === "wide") t += " That was a wide, one extra.";
    if (d.outcome === "noball") t += ` That was a no-ball${d.noBalls > 1 ? `, ${d.noBalls} extras` : ", one extra"}, so a free hit follows.`;
    else if (d.batRuns > 0) t += ` ${runWord(d.batRuns)} were completed first.`;
    return fh + t + suffix;
  }
  switch (d.outcome) {
    case "wide": {
      if (d.wides === 5) return `${pre}, wide, and it races away for four more: 5 wides.${suffix}`;
      const kind = d.wideKind === "height" ? "Over the batter's head, called wide for height" : d.wideKind === "leg" ? "Down the leg side, wide" : "Too far outside off, wide";
      return `${fh}${pre}, wide. ${kind}${d.wides > 1 ? `, and they run ${d.wides - 1} more: ${d.wides} wides` : ""}.${suffix}`;
    }
    case "noball": {
      const bits: string[] = [];
      if (d.batRuns > 0) bits.push(`${d.batRuns === 4 ? "FOUR" : d.batRuns === 6 ? "SIX" : runWord(d.batRuns)} off the bat`);
      if (d.byes > 0) bits.push(`${runWord(d.byes)} of byes`);
      if (d.legByes > 0) bits.push(`${runWord(d.legByes)} of leg byes`);
      const extra = bits.length > 0 ? ` ${bits.join(" and ")}.` : "";
      return `${fh}${pre}, NO BALL${d.noBalls > 1 ? ` (${d.noBalls} extras)` : ""}!${extra} Free hit next ball!${suffix}`;
    }
    case "legbye": {
      if (d.byes > 0) return `${fh}${pre}, ${runWord(d.byes)} of byes${d.byes === 4 ? ", four byes, the keeper has no chance" : ""}. Beats the bat and the keeper.${suffix}`;
      return `${fh}${pre}, ${runWord(d.legByes)} of leg byes${d.legByes === 4 ? ", four leg byes, it runs away off the pad" : ""}.${suffix}`;
    }
    default:
      if (fh || suffix) return undefined;
      return undefined;
  }
}
