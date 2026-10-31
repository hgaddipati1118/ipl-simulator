import { describe, it, expect } from "vitest";
import { simulateMatch, type MatchResult } from "../../../engine/src/match.js";
import { RULE_PRESETS } from "../../../engine/src/rules.js";
import { chennaiVsMumbai, digestMatch, withSeededRandom } from "../../../engine/src/__tests__/mod-fixtures.js";
import { ModRuntime } from "../runtime.js";
import { addBundle, addInline, loadExample } from "./helpers.js";

const RULES = RULE_PRESETS.modern2026;
const MATCHES = 300;

function spinWicketRate(runtime: ModRuntime | null, neutralVenue: boolean): { rate: number; balls: number; digests: string[] } {
  const hooks = runtime ? runtime.engineHooks() : null;
  let spinBalls = 0;
  let spinWickets = 0;
  const digests: string[] = [];
  for (let seed = 1; seed <= MATCHES; seed++) {
    const result = withSeededRandom(seed, () => {
      const { home, away } = chennaiVsMumbai();
      const isSpin = new Set([...home.roster, ...away.roster].filter(p => p.bowlingStyle && p.bowlingStyle !== "right-arm-fast" && p.bowlingStyle !== "unknown").map(p => p.id));
      const r: MatchResult = simulateMatch(home, away, RULES, seed, { neutralVenue, countTowardStandings: false, hooks });
      for (const inn of r.innings) {
        for (const b of inn.ballLog) {
          if (!isSpin.has(b.bowler) || b.outcome === "wide" || b.outcome === "noball") continue;
          spinBalls++;
          if (b.isWicket) spinWickets++;
        }
      }
      return r;
    });
    digests.push(digestMatch(result));
  }
  return { rate: spinWickets / spinBalls, balls: spinBalls, digests };
}

describe("spin-friendly-chennai example mod", () => {
  it("raises spin wicket rates at Chepauk and nowhere else", async () => {
    const runtime = new ModRuntime();
    await addBundle(runtime, loadExample("spin-friendly-chennai"));

    const base = spinWicketRate(null, false);
    const modded = spinWicketRate(runtime, false);
    expect(base.balls).toBeGreaterThan(20000);
    // The mod boosts wickets 15% and dots 8% before renormalising (about +9% net, measured 0.0771 to 0.0840 over 300 seeds); require a clear lift without pinning the value
    expect(modded.rate / base.rate).toBeGreaterThan(1.05);
    expect(modded.rate / base.rate).toBeLessThan(1.3);
    expect(runtime.list()[0]).toMatchObject({ enabled: true, strikes: 0 });

    // At a neutral venue the mod returns probs untouched, so every match is byte-identical
    const neutralBase = spinWicketRate(null, true);
    const neutralModded = spinWicketRate(runtime, true);
    expect(neutralModded.digests).toEqual(neutralBase.digests);
  }, 120_000);
});

describe("a broken mod in a real match", () => {
  function playOnce(runtime: ModRuntime | null): string {
    return withSeededRandom(5, () => {
      const { home, away } = chennaiVsMumbai();
      return digestMatch(simulateMatch(home, away, RULES, 5, { countTowardStandings: false, hooks: runtime ? runtime.engineHooks() : null }));
    });
  }

  it("is skipped then disabled, and the match is unaffected", () => {
    const baseline = playOnce(null);
    for (const [id, bad] of [
      ["thrower", () => { throw new Error("kaput"); }],
      ["nan", () => ({ dot: NaN })],
    ] as const) {
      const runtime = new ModRuntime();
      addInline(runtime, id, ["engine.ballProbabilities"], { engine: { ballProbabilities: bad as never } });
      expect(playOnce(runtime)).toBe(baseline);
      expect(runtime.list()[0]).toMatchObject({ enabled: false, strikes: 3 });
      expect(runtime.engineHooks().ballProbabilities).toBeUndefined(); // once disabled, the engine's no-hook fast path is restored
    }
  });
});

