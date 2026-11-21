import { readFileSync } from "node:fs";
import { STATE_WICKETS, STATE_WICKETS_SWITCH } from "@ipl-sim/engine";

/**
 * The state-wickets term's benchmark switches (docs/TACTICS.md section 11), read by the collectors and benchmarks:
 * SW_OFF=1 plays without it (the engine as it was), SW_FIRST_OFF=1 / SW_CHASE_OFF=1 without one innings of it, and
 * SW_FILE=state_wickets.json plays the tables of a state-wickets.py fit (its json) without a rebuild.
 */
export function applyStateWicketsEnv(): void {
  if (process.env.SW_OFF) STATE_WICKETS_SWITCH.off = true;
  if (process.env.SW_FIRST_OFF) STATE_WICKETS_SWITCH.first = false;
  if (process.env.SW_CHASE_OFF) STATE_WICKETS_SWITCH.chase = false;
  if (process.env.SW_FILE) {
    const j = JSON.parse(readFileSync(process.env.SW_FILE, "utf-8")) as { log: { first: number[][]; chase: number[][] }; scale: { first: Record<string, number>; chase: Record<string, number> } };
    STATE_WICKETS.first = j.log.first;
    STATE_WICKETS.chase = j.log.chase;
    STATE_WICKETS.scale = Object.fromEntries(Object.keys({ ...j.scale.first, ...j.scale.chase }).map(c => [c, [j.scale.first[c] ?? 1, j.scale.chase[c] ?? 1] as [number, number]]));
  }
}
