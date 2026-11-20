/**
 * ODI / Test ratings over a career (docs/RATINGS-PIPELINE.md, "ODI and Test ratings in career mode").
 *
 * Two things, both fitted (pipeline/fit-format-career.ts writes format-career-data.ts):
 *
 *  - `deriveFormatSets`: a player with no real ODI / Test record (a regen, a youth prospect, a generated pool player) gets
 *    format sets from his T20 ratings through the regression fitted on the pipeline's own "derived" sets, so he plays like
 *    a real player in that position who has no record in the format (source "derived").
 *  - `coupleFormatChange`: when a player's T20 ratings change (`Player.progress()`, mid-season training) his ODI / Test
 *    ratings move by the share of that change the real data carries over (CricketArchive per-year ratings, per side),
 *    each attribute by its own T20 change, so his format-specific offsets stay.
 */

import type { CoreRatingKey, FormatRatings, LongFormat, PlayerRatings } from "./player.js";
import { FORMAT_COUPLING, FORMAT_DERIVE_COEF } from "./format-career-data.js";

export const CORE_ATTRS: readonly CoreRatingKey[] = ["battingIQ", "timing", "power", "running", "wicketTaking", "economy", "accuracy", "clutch"];
const BAT_ATTRS: readonly CoreRatingKey[] = ["battingIQ", "timing", "power", "running"];
export const LONG_FORMATS_ALL: readonly LongFormat[] = ["odi", "test"];

type Gender = "male" | "female";
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The ODI and Test sets of a player with no record in them, from his T20 ratings and batting / bowling overalls */
export function deriveFormatSets(ratings: PlayerRatings, batting: number, bowling: number, gender: Gender): Partial<Record<LongFormat, FormatRatings>> {
  const out: Partial<Record<LongFormat, FormatRatings>> = {};
  for (const fmt of LONG_FORMATS_ALL) {
    const coef = FORMAT_DERIVE_COEF[gender][fmt] as unknown as Record<CoreRatingKey, readonly number[]>;
    const set = {} as PlayerRatings;
    for (const k of CORE_ATTRS) {
      const c = coef[k];
      set[k] = clamp(Math.round(c[0] + c[1] * ratings[k] + c[2] * batting + c[3] * bowling), 1, 99);
    }
    if (ratings.fielding !== undefined) set.fielding = ratings.fielding;
    if (ratings.keeping !== undefined) set.keeping = ratings.keeping;
    out[fmt] = { ratings: set, source: "derived" };
  }
  return out;
}

/**
 * Move a player's format sets by his T20 attribute changes (`changes`: attribute -> points it moved), in place. A format
 * attribute takes the change times the coupling of its side in that format; the fraction that does not make a whole point
 * is carried to the next change, so small moves are not lost to rounding (nor biased up). Fielding / keeping follow the
 * T20 values, as in a stored set.
 */
export function coupleFormatChange(
  sets: Partial<Record<LongFormat, FormatRatings>> | undefined,
  changes: Partial<Record<CoreRatingKey, number>>,
  t20: Pick<PlayerRatings, "fielding" | "keeping">,
  gender: Gender,
): void {
  if (!sets) return;
  for (const fmt of LONG_FORMATS_ALL) {
    const fr = sets[fmt];
    if (!fr) continue;
    const coupling = FORMAT_COUPLING[gender][fmt];
    const carry = fr.carry ?? {};
    for (const k of CORE_ATTRS) {
      const d = changes[k];
      if (d) {
        let k2: number;
        if (k === "clutch") k2 = (coupling.bat + coupling.bowl) / 2;
        else k2 = BAT_ATTRS.includes(k) ? coupling.bat : coupling.bowl;
        const want = d * k2 + (carry[k] ?? 0);
        const whole = Math.round(want);
        const next = clamp(fr.ratings[k] + whole, 1, 99);
        // a clamped move keeps no carry (nothing is owed beyond the limit)
        carry[k] = next === fr.ratings[k] + whole ? want - whole : 0;
        fr.ratings[k] = next;
      }
    }
    if (Object.values(carry).some(v => v)) fr.carry = carry; else delete fr.carry;
    if (t20.fielding !== undefined) fr.ratings.fielding = t20.fielding;
    if (t20.keeping !== undefined) fr.ratings.keeping = t20.keeping;
  }
}
