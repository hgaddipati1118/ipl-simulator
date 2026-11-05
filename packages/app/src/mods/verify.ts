/**
 * Check a mod in the browser before it's installed: compile it, then exercise its hooks in an
 * isolated runtime (seeded test matches for engine hooks, the default rules for `rules`, theme,
 * screens and panels through their validators). Errors are worded so they can go straight back to
 * the generator as retry feedback (docs/MODS-DESIGN.md, "Coding agent").
 */

import {
  DEFAULT_RULES, IPL_TEAMS, Team, createRNG, generateRandomPlayer, simulateMatch,
  type MatchResult, type PlayerRole,
} from "@ipl-sim/engine";
import { ModRuntime, compileMod, hashBundle, parseBundle, ValidationError, type ModBundle } from "@ipl-sim/mods";

export interface VerifyResult {
  ok: boolean;
  errors: string[];
  /** Not failures, but worth showing ("had no effect in the test matches") */
  notes: string[];
  bundle?: ModBundle;
  hash?: string;
}

const TEST_MATCHES = 6;
const ROLES: PlayerRole[] = ["batsman", "batsman", "batsman", "batsman", "batsman", "all-rounder", "all-rounder", "bowler", "bowler", "bowler", "bowler"];

/** Player generation reads Math.random, so seed it for the duration to make test matches repeatable */
function withSeededRandom<T>(seed: number, fn: () => T): T {
  const original = Math.random;
  Math.random = createRNG(seed);
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

/** CSK (home ground Chepauk) against MI, so venue-specific mods get exercised */
function testTeams(): { home: Team; away: Team } {
  const make = (id: string) => {
    const team = new Team({ ...IPL_TEAMS.find(t => t.id === id)! });
    for (const role of ROLES) team.addPlayer(generateRandomPlayer({ role, isInternational: false }), 5);
    return team;
  };
  return { home: make("csk"), away: make("mi") };
}

function runMatches(runtime: ModRuntime | null): MatchResult[] {
  const hooks = runtime ? runtime.engineHooks() : null;
  return Array.from({ length: TEST_MATCHES }, (_, i) =>
    withSeededRandom(i + 1, () => {
      const { home, away } = testTeams();
      return simulateMatch(home, away, DEFAULT_RULES, i + 1, { countTowardStandings: false, hooks });
    }),
  );
}

function digest(r: MatchResult): string {
  return r.innings.map(inn => `${inn.runs}/${inn.wickets}:${inn.ballLog.map(b => b.outcome).join("")}`).join("|");
}

export async function verifyMod(json: unknown): Promise<VerifyResult> {
  const errors: string[] = [];
  const notes: string[] = [];

  let bundle: ModBundle;
  try {
    bundle = parseBundle(json);
    compileMod(bundle);
  } catch (e) {
    return { ok: false, errors: [e instanceof ValidationError || e instanceof SyntaxError ? e.message : `could not compile: ${String(e)}`], notes };
  }
  const hash = await hashBundle(bundle);

  const runtime = new ModRuntime();
  runtime.add({ manifest: bundle.manifest, definition: compileMod(bundle), hash });
  const hooks = bundle.manifest.hooks;
  const fault = () => runtime.list()[0]?.lastError;

  if (hooks.includes("rules")) {
    runtime.applyRules({ ...DEFAULT_RULES });
    if (fault()) errors.push(`rules hook failed: ${fault()}`);
  }

  if (hooks.some(h => h.startsWith("engine."))) {
    const base = runMatches(null);
    let modded: MatchResult[] = [];
    try {
      modded = runMatches(runtime);
    } catch (e) {
      errors.push(`a test match crashed with the mod: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (fault()) errors.push(`engine hook failed during test matches: ${fault()}`);
    for (const r of modded) {
      for (const inn of r.innings) {
        if (inn.runs < 0 || inn.runs > 400 || inn.wickets < 0 || inn.wickets > 10) {
          errors.push(`a test innings ended ${inn.runs}/${inn.wickets}, outside believable limits`);
        }
      }
    }
    if (errors.length === 0 && modded.length > 0 && modded.every((r, i) => digest(r) === digest(base[i])) && !hooks.every(h => h === "engine.onBall")) {
      notes.push("the mod didn't change anything in the test matches (CSK v MI at Chepauk); it may only apply in situations those didn't hit");
    }
  }

  if (hooks.includes("ui.theme")) runtime.theme();
  if (hooks.includes("ui.screens")) runtime.screens();
  if (hooks.includes("ui.panels")) runtime.panels();
  if (fault() && !errors.some(e => e.includes(fault()!))) errors.push(`hook failed: ${fault()}`);

  return { ok: errors.length === 0, errors: [...new Set(errors)].slice(0, 10), notes, bundle, hash };
}
