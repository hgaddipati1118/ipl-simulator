import { describe, it, expect, afterEach } from "vitest";
import { simulateMatch } from "../match.js";
import { createMatchState, simulateRemaining } from "../live-match.js";
import { RULE_PRESETS } from "../rules.js";
import {
  setEngineHooks, getEngineHooks, normalizeOver, DEFAULT_MATCH_FORMAT,
  type EngineHooks, type BallHookContext,
} from "../mod-hooks.js";
import { chennaiVsMumbai, digestMatch, digestLive, withSeededRandom } from "./mod-fixtures.js";

const RULES = RULE_PRESETS.modern2026;

/** Digests produced by the engine before the hook points existed (captured from the unmodified code). */
const GOLDEN: Record<string, string> = {
  "sim:1": "174/8-126/10-de262cb5-csk-48 runs",
  "sim:2": "148/9-140/10-8648df3c-mi-8 runs",
  "sim:3": "172/7-105/10-dc97c596-mi-67 runs",
  "sim:4": "169/10-99/10-db2b61ff-mi-70 runs",
  "sim:5": "180/8-180/4-60b560c0-csk-Super Over",
  "sim:101": "163/10-165/8-e07ec986-csk-2 wickets",
  "sim:202": "120/10-123/7-b1dc5063-csk-3 wickets",
  "neutral:7": "160/10-130/10-a78bbb0d-mi-30 runs",
  "live:1": "62b89dd2:Match tied",
  "live:2": "949e78d5:Chennai Super Kings won by 3 wickets",
  "live:3": "8bf1716a:Chennai Super Kings won by 6 wickets",
};

function sim(seed: number, hooks?: EngineHooks | null, neutral = false) {
  return withSeededRandom(seed, () => {
    const { home, away } = chennaiVsMumbai();
    return simulateMatch(home, away, RULES, seed, { neutralVenue: neutral, countTowardStandings: false, ...(hooks !== undefined ? { hooks } : {}) });
  });
}

function live(seed: number) {
  return withSeededRandom(seed, () => {
    const { home, away } = chennaiVsMumbai();
    const r = simulateRemaining(createMatchState(home, away, RULES, null, seed));
    return digestLive(r.state.ballLog) + ":" + r.state.result;
  });
}

afterEach(() => setEngineHooks(null));

describe("no mods installed", () => {
  it("simulateMatch reproduces the pre-hook results exactly", () => {
    for (const seed of [1, 2, 3, 4, 5, 101, 202]) {
      expect(digestMatch(sim(seed)), `seed ${seed}`).toBe(GOLDEN[`sim:${seed}`]);
    }
    expect(digestMatch(sim(7, undefined, true))).toBe(GOLDEN["neutral:7"]);
  });

  it("live matches reproduce the pre-hook results exactly", () => {
    for (const seed of [1, 2, 3]) expect(live(seed), `seed ${seed}`).toBe(GOLDEN[`live:${seed}`]);
  });
});

describe("pass-through hooks", () => {
  const identity: EngineHooks = {
    ballProbabilities: (_ctx, probs) => probs,
    onBall: () => {},
    matchFormat: f => f,
  };

  it("leave simulateMatch results untouched", () => {
    for (const seed of [1, 5, 101]) expect(digestMatch(sim(seed, identity))).toBe(GOLDEN[`sim:${seed}`]);
  });

  it("leave live results untouched when registered globally", () => {
    setEngineHooks(identity);
    expect(getEngineHooks()).toBe(identity);
    for (const seed of [1, 2, 3]) expect(live(seed)).toBe(GOLDEN[`live:${seed}`]);
  });
});

describe("engine.ballProbabilities", () => {
  it("receives a coherent context and normalised probabilities in simulateMatch", () => {
    const seen: BallHookContext[] = [];
    let maxDrift = 0;
    sim(1, {
      ballProbabilities: (ctx, probs) => {
        seen.push(ctx);
        maxDrift = Math.max(maxDrift, Math.abs(Object.values(probs).reduce((a, b) => a + b, 0) - 1));
        return probs;
      },
    });
    expect(seen.length).toBeGreaterThan(200);
    expect(maxDrift).toBeLessThan(1e-9);
    const first = seen[0];
    expect(first.venue.id).toBe("chepauk");
    expect(first.innings).toBe(1);
    expect(first.over).toBe(0);
    expect(first.ball).toBe(1);
    expect(first.maxOvers).toBe(20);
    expect(first.phase).toBe("powerplay");
    expect(typeof first.bowler.isSpin).toBe("boolean");
    expect(seen.some(c => c.innings === 2 && c.target > 0)).toBe(true);
  });

  it("reports the neutral venue", () => {
    let id = "";
    sim(1, { ballProbabilities: (ctx, p) => { id = ctx.venue.id; return p; } }, true);
    expect(id).toBe("neutral");
  });

  it("changes the outcome and is deterministic for a given seed", () => {
    const wickets: EngineHooks = { ballProbabilities: (_c, p) => ({ ...p, wicket: p.wicket * 6 }) };
    const a = digestMatch(sim(2, wickets));
    expect(a).toBe(digestMatch(sim(2, wickets)));
    expect(a).not.toBe(GOLDEN["sim:2"]);
  });

  it("gives hooks a seeded rng that is reproducible", () => {
    const hook: EngineHooks = { ballProbabilities: (ctx, p) => ({ ...p, "6": ctx.rng() < 0.5 ? p["6"] * 3 : p["6"] }) };
    expect(digestMatch(sim(3, hook))).toBe(digestMatch(sim(3, hook)));
  });

  it("runs in live matches via the registry", () => {
    const venues = new Set<string>();
    setEngineHooks({ ballProbabilities: (ctx, p) => { venues.add(ctx.venue.id); return { ...p, wicket: p.wicket * 8 }; } });
    expect(live(2)).not.toBe(GOLDEN["live:2"]);
    expect([...venues]).toEqual(["chepauk"]);
  });
});

describe("engine.onBall", () => {
  it("observes every delivery of a simulated match", () => {
    const events: string[] = [];
    const r = sim(4, { onBall: (_ctx, e) => { events.push(e.outcome); } });
    const total = r.innings[0].ballLog.length + r.innings[1].ballLog.length + (r.superOver?.reduce((n, i) => n + i.ballLog.length, 0) ?? 0);
    expect(events.length).toBe(total);
  });

  it("observes every delivery of a live match", () => {
    let n = 0;
    setEngineHooks({ onBall: () => { n++; } });
    withSeededRandom(1, () => {
      const { home, away } = chennaiVsMumbai();
      const r = simulateRemaining(createMatchState(home, away, RULES, null, 1)).state;
      expect(n).toBeGreaterThanOrEqual(r.ballLog.length);
    });
  });
});

describe("engine.matchFormat", () => {
  it("shortens innings to the requested overs in simulateMatch", () => {
    const r = sim(1, { matchFormat: f => ({ ...f, overs: 10, powerplayOvers: 3, maxOversPerBowler: 2 }) });
    for (const inn of r.innings) {
      expect(inn.overs).toBeLessThanOrEqual(10);
      expect(inn.totalBalls).toBeLessThanOrEqual(60);
      for (const b of inn.bowlerStats.values()) expect(b.overs).toBeLessThanOrEqual(2);
    }
  });

  it("shortens live innings", () => {
    setEngineHooks({ matchFormat: f => ({ ...f, overs: 10, powerplayOvers: 3, maxOversPerBowler: 2 }) });
    const state = withSeededRandom(1, () => {
      const { home, away } = chennaiVsMumbai();
      return simulateRemaining(createMatchState(home, away, RULES, null, 1)).state;
    });
    expect(state.status).toBe("completed");
    expect(state.innings1BallLog.filter(b => b.eventType !== "wide" && b.eventType !== "noball").length).toBeLessThanOrEqual(60);
  });

  it("maps the default format to itself", () => {
    for (let o = 0; o < 20; o++) expect(normalizeOver(o, null)).toBe(o);
    expect(DEFAULT_MATCH_FORMAT.overs).toBe(20);
    const ten = { ...DEFAULT_MATCH_FORMAT, overs: 10, powerplayOvers: 3 };
    expect(normalizeOver(0, ten)).toBe(0);
    expect(normalizeOver(3, ten)).toBeCloseTo(6);
    expect(normalizeOver(9, ten)).toBeGreaterThanOrEqual(15);
    expect(normalizeOver(9, ten)).toBeLessThan(20);
  });
});
