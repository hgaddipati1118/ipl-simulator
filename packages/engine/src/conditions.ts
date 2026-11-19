/**
 * Conditions a user can set for a match (pitch, light, weather) and the realistic default (none: the ground's measured profile and the
 * day's fitted draw stay as they are).
 *
 * Every control acts through a term that is already fitted on real matches; nothing here is a new hand-set number.
 *
 *  - PITCH (flat / seaming / turning / slow). A pitch preset is the mean profile of the top tenth of real grounds on that dimension
 *    (the measured T20 grounds of venue-data.ts, 91 of them; the ODI grounds of odi-venue-data.ts, 72 men's with 15+ matches; bowler-type
 *    edges for the ODI from the List A venue analysis, in the T20 edges' units). It replaces the ground's run / six / wicket factors
 *    (the wicket factor shrunk to a quarter, as the grounds' are) and its pace and spin edges, so it costs and pays what a ground of
 *    that kind really does (venues.ts applyVenueProfile). Player-level pitch sensitivity does not predict out of sample
 *    (docs/VENUE-SENSITIVITY.md) and is not modelled: every bowler of a type reads the same edge.
 *  - LIGHT (ODI: day / day-night). The chasing side's edge by day against under lights, from the List A record
 *    (docs/VENUE-CONDITIONS-REPORT.md, "Day vs day/night": men's List A chases by day +4.6% win probability, day-night -1.2%): half the
 *    gap either way, on the engine's chase-edge term. The T20 gap (+2.8% against +0.9%, 1.9 +- 1.7 points) is inside its noise: no effect.
 *  - WEATHER (Test). Clear = no time lost; unsettled = the wettest fitted host country's days-affected rate and share lost.
 *  - A Test's pitch acts on the match's own conditions: the run / wicket spread drawn per Test (test-match.ts drawConditions), set to the
 *    top-tenth mean of that fitted distribution along the pitch's dimension, with the fitted run / wicket correlation.
 */
import type { VenueProfile, VenueEdgeKey } from "./venues.js";
import { ODI_VENUE_RUN_GAIN, ODI_SIX_RUN_SHARE, WICKET_FACTOR_WEIGHT } from "./venues.js";

export type PitchPreset = "flat" | "seaming" | "turning" | "slow";
export type LightPreset = "day" | "night";
export type WeatherPreset = "clear" | "unsettled";

export interface ConditionsSetting {
  pitch?: PitchPreset;
  light?: LightPreset;
  weather?: WeatherPreset;
}

export const PITCH_LABELS: Record<PitchPreset, string> = { flat: "Flat", seaming: "Green, seaming", turning: "Dry, turning", slow: "Slow and low" };

interface Edge { wkts: number; econ: number }
interface PresetNumbers { run: number; six: number; wkt: number; spin: Edge; pace: Edge }

/** Top-tenth means of the real grounds (see the file header). Edges: wickets per 100 balls and runs per over against the same bowlers elsewhere */
const NEUTRAL_EDGE: Edge = { wkts: 0, econ: 0 };
export const PITCH_PRESETS: Record<"t20" | "odi", Record<PitchPreset, PresetNumbers>> = {
  t20: {
    flat: { run: 1.075, six: 0.987, wkt: 0.962, spin: NEUTRAL_EDGE, pace: NEUTRAL_EDGE },
    slow: { run: 0.913, six: 0.891, wkt: 1.064, spin: NEUTRAL_EDGE, pace: NEUTRAL_EDGE },
    turning: { run: 0.952, six: 1, wkt: 1.044, spin: { wkts: 0.086, econ: -0.132 }, pace: { wkts: -0.102, econ: 0.117 } },
    seaming: { run: 1.006, six: 1, wkt: 1.051, spin: { wkts: -0.129, econ: 0.106 }, pace: { wkts: 0.075, econ: -0.127 } },
  },
  odi: {
    flat: { run: 1.076, six: 1.008, wkt: 0.976, spin: NEUTRAL_EDGE, pace: NEUTRAL_EDGE },
    slow: { run: 0.904, six: 0.994, wkt: 1.027, spin: NEUTRAL_EDGE, pace: NEUTRAL_EDGE },
    // List A venues' top-tenth edges per 100 balls / per over, scaled to the T20 edges' units (ODI base: 2.4 wickets per 100 balls, 5.4 an over)
    turning: { run: 0.97, six: 1, wkt: 1.02, spin: { wkts: 0.048, econ: -0.121 }, pace: { wkts: -0.024, econ: 0.1 } },
    seaming: { run: 1.0, six: 1, wkt: 1.03, spin: { wkts: -0.097, econ: 0.078 }, pace: { wkts: 0.078, econ: -0.078 } },
  },
};

const SPIN_KEYS: VenueEdgeKey[] = ["off-spin", "wrist-spin", "LA orthodox"];
const PACE_KEYS: VenueEdgeKey[] = ["RA fast", "RA fast-medium", "RA medium", "LA pace"];

/** ODI: the chase edge by day (+) and under lights (-): half the List A gap (+4.6% against -1.2% win probability) either way */
export const ODI_LIGHT_CHASE: Record<LightPreset, number> = { day: 0.029, night: -0.029 };

/** A profile with the user's conditions laid over it (the ground's own, or a neutral one where the ground has none) */
export function applyConditionsToProfile(
  profile: VenueProfile | null, c: ConditionsSetting | undefined, kind: "t20" | "odi", chaseAdvantage: number,
): VenueProfile | null {
  if (!c || (!c.pitch && !(kind === "odi" && c.light))) return profile;
  const base: VenueProfile = profile ?? {
    groundName: "Set conditions", runMult: 1, sixMult: 1, wicketMult: 1, edges: {}, chaseAdvantage, source: "user-set conditions",
    ...(kind === "odi" ? { runGain: ODI_VENUE_RUN_GAIN, sixRunShare: ODI_SIX_RUN_SHARE } : {}),
  };
  const out: VenueProfile = { ...base, edges: { ...base.edges } };
  if (c.pitch) {
    const p = PITCH_PRESETS[kind][c.pitch];
    out.runMult = base.runMult * p.run;
    out.sixMult = base.sixMult * p.six;
    out.wicketMult = base.wicketMult * (1 + (p.wkt - 1) * WICKET_FACTOR_WEIGHT);
    for (const k of SPIN_KEYS) out.edges[k] = p.spin;
    for (const k of PACE_KEYS) out.edges[k] = p.pace;
    out.groundName = base.groundName ? `${base.groundName} (${PITCH_LABELS[c.pitch].toLowerCase()})` : PITCH_LABELS[c.pitch];
  }
  if (kind === "odi" && c.light) out.chaseTilt = ODI_LIGHT_CHASE[c.light];
  return out;
}
