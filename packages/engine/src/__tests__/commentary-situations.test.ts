import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { setCommentaryModel, getCommentaryModel, commentaryShortName, type CommentaryModelData } from "../commentary-model.js";
import { generateDeliveryCommentary, type DeliveryCommentaryParams } from "../commentary.js";
import { describeDelivery, retiredHurtLine, retiredOutLine, timedOutLine, superOverLine } from "../delivery-text.js";
import { DELIVERY_DISMISSALS, setRuleOverrides, type DeliveryDetail, type DismissalKind } from "../delivery-rules.js";
import { createMatchState, simulateRemaining } from "../live-match.js";
import { createRNG } from "../rng.js";
import { Player } from "../player.js";
import { RULE_PRESETS } from "../rules.js";
import { Team, IPL_TEAMS } from "../team.js";

const MODEL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../app/public/data/commentary-model.json");
const model: CommentaryModelData | null = existsSync(MODEL_PATH) ? JSON.parse(readFileSync(MODEL_PATH, "utf8")) : null;

const P = {
  bowler: "Torin Marbleton",
  striker: "Zayan Quillfeather",
  ns: "Evander Oakhurst",
  f1: "Marlo Zephyrov",
  f2: "Lucan Dunmore",
  // a player of the match who is NOT in the ball's context
  stranger: "Anselm Brightwell",
};
const S = (n: string) => commentaryShortName(n);

function detail(o: Partial<DeliveryDetail> = {}): DeliveryDetail {
  return {
    outcome: "dot", legal: true, batRuns: 0, batBoundary: 0, wides: 0, noBalls: 0, byes: 0, legByes: 0, penalty: 0, extras: 0,
    runsRun: 0, overthrow: 0, freeHitNext: false, ...o,
  };
}

function dismissal(kind: DismissalKind, out: "striker" | "nonStriker" = "striker", extra: Partial<NonNullable<DeliveryDetail["dismissal"]>> = {}): NonNullable<DeliveryDetail["dismissal"]> {
  return { kind, out, bowlerCredit: false, newBatterFaces: false, ...extra };
}

function params(d: DeliveryDetail, o: Partial<DeliveryCommentaryParams> = {}): DeliveryCommentaryParams {
  return {
    detail: d, bowlerName: P.bowler, batterName: P.striker, nonStrikerName: P.ns, fielderName: P.f1,
    over: 8, ball: 3, score: 60, wickets: 2, isSecondInnings: false, bowlingStyle: "right-arm-fast", battingHand: "right",
    batterRuns: 12, batterBalls: 10, ...o,
  };
}

interface Scenario {
  name: string;
  p: DeliveryCommentaryParams;
  /** extra assertions on the line */
  check?: (line: string) => void;
}

const dis = dismissal;
const wide = (w: number, kind: "off" | "leg" | "height", d: Partial<DeliveryDetail> = {}) =>
  detail({ outcome: "wide", legal: false, wides: w, extras: w, runsRun: w === 5 ? 0 : w - 1, wideKind: kind, ...d });
const noball = (d: Partial<DeliveryDetail> = {}) => {
  const n = d.noBalls ?? 1;
  const bat = d.batRuns ?? 0;
  return detail({ outcome: "noball", legal: false, noBalls: n, extras: n + (d.byes ?? 0) + (d.legByes ?? 0), freeHitNext: true, batBoundary: bat === 4 ? 4 : bat === 6 ? 6 : 0, ...d });
};

const mustNotBeOut = (name: string) => (line: string) =>
  expect(line, `${name} must not be the dismissed batter`).not.toMatch(new RegExp(`${name}\\s+(is|was|has been|gets|got)\\s+(\\w+\\s+)?(run[- ]?out|out|gone|bowled|caught|stranded)\\b`, "i"));

const scenarios: Scenario[] = [];

// every delivery dismissal, striker out
for (const k of DELIVERY_DISMISSALS) {
  scenarios.push({
    name: `${k} (striker out)`,
    p: params(detail({ outcome: "wicket", dismissal: dis(k, "striker", { bowlerCredit: k === "bowled" }) }), { fielderName: k === "caught_and_bowled" ? undefined : P.f1 }),
    check: (l) => {
      expect(l).toMatch(/OUT!/);
      expect(l).toContain(P.striker);
      mustNotBeOut(S(P.ns))(l);
    },
  });
}
// substitute fielders
for (const k of ["caught", "run_out"] as const) {
  scenarios.push({
    name: `${k} by a substitute`,
    p: params(detail({ outcome: "wicket", dismissal: dis(k, "striker", { substitute: true }) })),
    check: (l) => expect(l).toMatch(new RegExp(`substitute ${S(P.f1)}`, "i")),
  });
}
// relay run outs
scenarios.push({
  name: "run out, two fielders (striker)",
  p: params(detail({ outcome: "wicket", batRuns: 1, runsRun: 1, dismissal: dis("run_out", "striker", { fielder2Id: "x" }) }), { fielder2Name: P.f2 }),
  check: (l) => { expect(l).toContain(S(P.f1)); expect(l).toContain(S(P.f2)); },
});
scenarios.push({
  name: "run out, two fielders (non-striker)",
  p: params(detail({ outcome: "wicket", dismissal: dis("run_out", "nonStriker", { fielder2Id: "x" }) }), { fielder2Name: P.f2 }),
  check: (l) => {
    expect(l).toContain(S(P.f1));
    expect(l).toContain(S(P.f2));
    expect(l).toContain(S(P.ns));
    mustNotBeOut(S(P.striker))(l);
  },
});
// non-striker run outs: the partner is out, the striker is not
for (const runs of [0, 1, 2]) {
  scenarios.push({
    name: `run out (non-striker), ${runs} completed`,
    p: params(detail({ outcome: "wicket", batRuns: runs, runsRun: runs, dismissal: dis("run_out", "nonStriker") })),
    check: (l) => {
      expect(l).toMatch(/OUT!/);
      expect(l).toContain(S(P.ns));
      mustNotBeOut(S(P.striker))(l);
      expect(l).not.toMatch(new RegExp(`A duck for ${P.striker}|well set`));
    },
  });
}
scenarios.push({
  name: "run out (non-striker), no fielder named",
  p: params(detail({ outcome: "wicket", dismissal: dis("run_out", "nonStriker") }), { fielderName: undefined }),
  check: (l) => { expect(l).toContain(S(P.ns)); mustNotBeOut(S(P.striker))(l); },
});
// the Mankad
scenarios.push({
  name: "Mankad",
  p: params(detail({ outcome: "wicket", dismissal: dis("run_out", "nonStriker") }), { deadBall: true, fielderName: P.bowler }),
  check: (l) => {
    expect(l).toContain(S(P.bowler));
    expect(l).toContain(S(P.ns));
    expect(l).toMatch(/no ball is bowled/i);
    expect(l).toMatch(/Mankad|backing up|before delivering/i);
  },
});
// dismissals on extras
for (const k of ["stumped", "hit_wicket", "run_out"] as const) {
  scenarios.push({
    name: `${k} off a wide`,
    p: params(wide(1, "off", { dismissal: dis(k) })),
    check: (l) => { expect(l).toMatch(/wide/i); expect(l).toMatch(/OUT!/); },
  });
}
scenarios.push({
  name: "run out (non-striker) off a wide",
  p: params(wide(1, "leg", { dismissal: dis("run_out", "nonStriker") })),
  check: (l) => { expect(l).toMatch(/wide/i); expect(l).toContain(S(P.ns)); mustNotBeOut(S(P.striker))(l); },
});
scenarios.push({
  name: "run out off a no-ball",
  p: params(noball({ dismissal: dis("run_out") })),
  check: (l) => { expect(l).toMatch(/NO BALL/); expect(l).toMatch(/OUT!/); expect(l).toMatch(/free hit/i); },
});
scenarios.push({
  name: "run out (non-striker) off a no-ball",
  p: params(noball({ dismissal: dis("run_out", "nonStriker") })),
  check: (l) => { expect(l).toMatch(/NO BALL/); expect(l).toContain(S(P.ns)); mustNotBeOut(S(P.striker))(l); },
});
// free hit: run out is the only way
for (const out of ["striker", "nonStriker"] as const) {
  scenarios.push({
    name: `run out (${out}) on a free hit`,
    p: params(detail({ outcome: "wicket", dismissal: dis("run_out", out) }), { freeHit: true }),
    check: (l) => expect(l).toMatch(/FREE HIT/),
  });
}
// wides by size and kind
for (const kind of ["off", "leg", "height"] as const) {
  for (const w of [1, 2, 3, 4, 5]) {
    scenarios.push({
      name: `${w} wide(s), ${kind}`,
      p: params(wide(w, kind)),
      check: (l) => {
        expect(l).toMatch(/wide/i);
        if (w >= 5) expect(l).toMatch(/\b(FIVE|Five|5) wides?\b/);
        else if (w >= 2) expect(l).toContain(`${w} wides`);
        if (kind === "height") expect(l).toMatch(/height/i);
        if (kind === "leg" && w === 1) expect(l).toMatch(/\bleg\b/i);
        if (kind === "off" && w === 1) expect(l).not.toMatch(/\bleg side|down leg|height/i);
      },
    });
  }
}
// no-balls
scenarios.push({ name: "no ball, nothing off the bat", p: params(noball()), check: (l) => { expect(l).toMatch(/NO BALL/); expect(l).toMatch(/free hit/i); } });
for (const r of [1, 2, 3, 4, 6]) {
  scenarios.push({
    name: `no ball, ${r} off the bat`,
    p: params(noball({ batRuns: r, runsRun: r >= 4 ? 0 : r })),
    check: (l) => {
      expect(l).toMatch(/NO BALL/); expect(l).toMatch(/free hit/i);
      if (r === 4) expect(l).toMatch(/FOUR/);
      if (r === 6) expect(l).toMatch(/SIX/);
      if (r < 4) expect(l).toContain(`${r} run`);
    },
  });
}
scenarios.push({ name: "no ball with byes", p: params(noball({ byes: 2 })), check: (l) => { expect(l).toMatch(/NO BALL/); expect(l).toMatch(/2 runs of byes/); } });
scenarios.push({ name: "no ball with leg byes", p: params(noball({ legByes: 1 })), check: (l) => { expect(l).toMatch(/NO BALL/); expect(l).toMatch(/1 run of leg byes/); } });
scenarios.push({ name: "no ball costs two (The Hundred)", p: params(noball({ noBalls: 2 })), check: (l) => { expect(l).toMatch(/NO BALL/); expect(l).toMatch(/two runs/i); expect(l).toMatch(/free hit/i); } });
// byes and leg byes
for (const n of [1, 2, 3, 4, 5]) {
  scenarios.push({
    name: `${n} bye(s)`, p: params(detail({ outcome: "legbye", byes: n, extras: n, runsRun: n >= 4 ? n - 4 : n })),
    check: (l) => { expect(l).toMatch(/\bbyes?\b/i); expect(l).not.toMatch(/leg bye/i); if (n === 4) expect(l).toMatch(/FOUR/); if (n === 5) expect(l).toMatch(/FIVE/); },
  });
  scenarios.push({
    name: `${n} leg bye(s)`, p: params(detail({ outcome: "legbye", legByes: n, extras: n, runsRun: n >= 4 ? n - 4 : n })),
    check: (l) => { expect(l).toMatch(/leg byes?/i); if (n === 4) expect(l).toMatch(/FOUR/); if (n === 5) expect(l).toMatch(/FIVE/); },
  });
}
// overthrows, penalty runs
for (const r of ["dot", "1", "2"] as const) {
  const base = r === "dot" ? 0 : Number(r);
  scenarios.push({
    name: `${r} then overthrows`,
    p: params(detail({ outcome: r, batRuns: base + 4, overthrow: 4, runsRun: base })),
    check: (l) => { expect(l).toMatch(/overthrow/i); expect(l).toContain(`${base + 4} run`); },
  });
}
scenarios.push({ name: "bye overthrows", p: params(detail({ outcome: "legbye", byes: 5, extras: 5, overthrow: 4, runsRun: 1 })), check: (l) => expect(l).toMatch(/overthrow|FIVE/i) });
scenarios.push({ name: "penalty runs on a dot", p: params(detail({ outcome: "dot", penalty: 5, extras: 5 })), check: (l) => expect(l).toMatch(/penalty/i) });
scenarios.push({ name: "penalty runs on a four", p: params(detail({ outcome: "4", batRuns: 4, batBoundary: 4, penalty: 5, extras: 5 })), check: (l) => expect(l).toMatch(/penalty/i) });
// free hit on every kind of ball
for (const [name, d] of [
  ["dot", detail()], ["1", detail({ outcome: "1", batRuns: 1, runsRun: 1 })], ["2", detail({ outcome: "2", batRuns: 2, runsRun: 2 })], ["3", detail({ outcome: "3", batRuns: 3, runsRun: 3 })],
  ["4", detail({ outcome: "4", batRuns: 4, batBoundary: 4 })], ["6", detail({ outcome: "6", batRuns: 6, batBoundary: 6 })],
  ["wide", wide(1, "off", { freeHitNext: true })], ["no ball", noball()], ["leg bye", detail({ outcome: "legbye", legByes: 1, extras: 1, runsRun: 1 })],
  ["overthrows", detail({ outcome: "1", batRuns: 5, overthrow: 4, runsRun: 1 })],
] as const) {
  scenarios.push({ name: `free hit: ${name}`, p: params(d, { freeHit: true }), check: (l) => expect(l).toMatch(/^FREE HIT!/) });
}
scenarios.push({
  name: "free hit: wide keeps the free hit",
  p: params(wide(1, "leg", { freeHitNext: true }), { freeHit: true }),
  check: (l) => expect(l).toMatch(/free hit/i),
});
// plain balls (corpus territory)
for (const [name, d] of [
  ["dot", detail()], ["1", detail({ outcome: "1", batRuns: 1, runsRun: 1 })], ["4", detail({ outcome: "4", batRuns: 4, batBoundary: 4 })], ["6", detail({ outcome: "6", batRuns: 6, batBoundary: 6 })],
] as const) {
  scenarios.push({ name: `plain ${name}`, p: params(d), check: (l) => expect(l).not.toMatch(/FREE HIT/) });
}

const FOREIGN = [P.stranger, S(P.stranger)];

function run(sc: Scenario, seed: number, used: Record<string, 1>): { text: string; key?: string } {
  const r = generateDeliveryCommentary({ ...sc.p, rng: createRNG(seed), usedLines: used });
  if (r.key) used[r.key] = 1;
  return r;
}

function assertLine(sc: Scenario, line: string) {
  expect(line.length, `${sc.name}: empty`).toBeGreaterThan(10);
  expect(line, `${sc.name}: unfilled slot`).not.toMatch(/\{[a-z]+\}|\bundefined\b|\bNaN\b|\bnull\b/);
  for (const f of FOREIGN) expect(line, `${sc.name}: names someone not in the ball`).not.toContain(f);
  expect(line, `${sc.name}: em dash`).not.toContain("—");
  if (sc.p.freeHit) expect(line, `${sc.name}: free hit`).toMatch(/FREE HIT/);
  // only the people of the ball: the striker's name must open the line ("<bowler> to <striker>") unless nobody was bowled to
  if (!sc.p.deadBall) expect(line).toContain(P.striker);
  sc.check?.(line);
}

function sweep(label: string) {
  describe(label, () => {
    it("every situation yields a clean line naming the right people, across seeds", () => {
      for (const sc of scenarios) {
        const used: Record<string, 1> = {};
        for (let seed = 1; seed <= 25; seed++) assertLine(sc, run(sc, seed, used).text);
      }
    });
    it("is deterministic per seed", () => {
      for (const sc of scenarios) {
        for (const seed of [3, 11]) {
          expect(run(sc, seed, {}).text, sc.name).toBe(run(sc, seed, {}).text);
        }
      }
    });
    it("never repeats a corpus key inside one match", () => {
      for (const sc of scenarios) {
        const used: Record<string, 1> = {};
        const seen = new Set<string>();
        for (let seed = 1; seed <= 40; seed++) {
          const r = run(sc, seed, used);
          if (r.key) { expect(seen.has(r.key), `${sc.name} repeated ${r.key}`).toBe(false); seen.add(r.key); }
        }
      }
    });
  });
}

describe("situation commentary without the corpus model (hand-written lines)", () => {
  beforeAll(() => setCommentaryModel(null));
  sweep("no model");
  it("varies the wording", () => {
    const sc = scenarios.find((s) => s.name === "run out (non-striker), 1 completed")!;
    const lines = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) lines.add(run(sc, seed, {}).text);
    expect(lines.size).toBeGreaterThan(2);
  });
});

describe.skipIf(!model)("situation commentary with the corpus model", () => {
  beforeAll(() => setCommentaryModel(model));
  afterAll(() => setCommentaryModel(null));
  sweep("model loaded");

  it("uses corpus lines for the ordinary balls and for non-striker run outs", () => {
    const rng = createRNG(5);
    const nsTemplates = getCommentaryModel()!.lines["W:run_out_ns"]?.t.length ?? 0;
    const sc = scenarios.find((s) => s.name === "run out (non-striker), 1 completed")!;
    let corpus = 0;
    const used: Record<string, 1> = {};
    for (let i = 0; i < 30; i++) { const r = generateDeliveryCommentary({ ...sc.p, rng: createRNG(100 + i), usedLines: used }); if (r.key) { used[r.key] = 1; corpus++; } }
    if (nsTemplates >= 4) expect(corpus).toBeGreaterThan(0);
    const plain = generateDeliveryCommentary({ ...scenarios.find((s) => s.name === "plain dot")!.p, rng });
    expect(plain.key).toBeDefined();
  });

  it("run-out templates are tagged by who was out", () => {
    const L = getCommentaryModel()!.lines;
    const shotByPartner = /\{nonstriker\}\s+(went|goes|looks?|looked|tried|tries|plays?|played|pulls?|pulled|drives?|drove|cuts?|flicks?|hooks?|punche[sd]|tap(s|ped)|nudge[sd]|push(es|ed)|swings?|swung)\b/i;
    const out = "(is|was|has been|gets|got)\\s+(\\w+\\s+)?(run[- ]?out|out|gone|stranded)";
    const ns = L["W:run_out_ns"]?.t ?? [];
    const st = L["W:run_out"]?.t ?? [];
    expect(st.length).toBeGreaterThan(0);
    expect(ns.filter((t) => !t.includes("{nonstriker}")), "every non-striker template refers to the partner").toEqual([]);
    expect(ns.filter((t) => new RegExp(`\\{batter\\}(?:'s)?\\s+(\\w+\\s+){0,2}?${out}`, "i").test(t) || /\{batter\}'s\s+run[- ]?out/i.test(t)), "non-striker templates must not describe the striker's own dismissal").toEqual([]);
    expect(st.filter((t) => shotByPartner.test(t) || new RegExp(`\\{nonstriker\\}(?:'s)?\\s+(\\w+\\s+){0,2}?${out}`, "i").test(t)), "striker templates: the partner neither plays the shot nor is the one out").toEqual([]);
    expect(ns.filter((t) => shotByPartner.test(t)), "the partner never plays the shot").toEqual([]);
    expect((L["W:caught_and_bowled"]?.t ?? []).filter((t) => t.includes("{fielder}")), "a caught and bowled has no separate fielder").toEqual([]);
  });
});

describe("hand-written lines directly (instant engine)", () => {
  const rng = createRNG(1);
  it("describeDelivery covers every dismissal kind without placeholders", () => {
    for (const k of [...DELIVERY_DISMISSALS, "timed_out", "retired_out"] as DismissalKind[]) {
      for (const out of ["striker", "nonStriker"] as const) {
        const t = describeDelivery({
          detail: detail({ outcome: "wicket", dismissal: dis(k, out) }), bowler: P.bowler, batter: P.striker, nonStriker: P.ns, fielder: P.f1, rng,
        })!;
        expect(t, k).toMatch(/OUT!|timed out|retires out/i);
        expect(t).not.toMatch(/\{|undefined/);
      }
    }
  });
  it("non-striker kinds name the partner and the striker is not out", () => {
    const t = describeDelivery({ detail: detail({ outcome: "wicket", dismissal: dis("run_out", "nonStriker") }), bowler: P.bowler, batter: P.striker, nonStriker: P.ns, fielder: P.f1, rng })!;
    expect(t).toContain(S(P.ns));
    mustNotBeOut(S(P.striker))(t);
  });
  it("between-ball events name only the batter", () => {
    for (const f of [retiredHurtLine, retiredOutLine, timedOutLine]) {
      const t = f(P.striker, rng);
      expect(t).toContain(S(P.striker));
      expect(t).not.toMatch(/\{|undefined|—/);
    }
    expect(retiredHurtLine(P.striker, rng)).toMatch(/retire hurt/i);
    expect(retiredOutLine(P.striker, rng)).toMatch(/retire[sd]? out/i);
    expect(timedOutLine(P.striker, rng)).toMatch(/timed out/i);
    for (const k of ["start", "tied", "end"] as const) expect(superOverLine(k, rng)).toMatch(/super over/i);
  });
  it("a plain scoring ball has no special line", () => {
    expect(describeDelivery({ detail: detail({ outcome: "4", batRuns: 4, batBoundary: 4 }), bowler: P.bowler, batter: P.striker, rng })).toBeUndefined();
  });
});

// ── whole matches with every unusual situation forced ─────────────────────

const SURNAMES = ["Quillfeather", "Marbleton", "Zephyrov", "Oakhurst", "Tamarind", "Velkanov", "Dunmore", "Pellegrino", "Ashgrove", "Kestrelman", "Ulverton", "Brightwell"];
const FIRSTS = ["Zayan", "Torin", "Marlo", "Evander", "Lucan", "Yorick", "Casimir", "Ottoline", "Percival", "Dmitri", "Anselm", "Rafferty"];

function makeTeam(idx: number, tag: string): Team {
  const team = new Team({ ...IPL_TEAMS[idx] });
  const roles: ("batsman" | "all-rounder" | "bowler")[] = ["batsman", "batsman", "batsman", "batsman", "batsman", "all-rounder", "all-rounder", "all-rounder", "bowler", "bowler", "bowler", "bowler"];
  const styles = ["right-arm-fast", "off-spin", "left-arm-orthodox", "leg-spin", "right-arm-medium", "left-arm-fast"] as const;
  roles.forEach((role, i) => {
    const bat = role === "batsman";
    team.addPlayer(new Player({
      id: `${tag}_${i}`,
      name: `${FIRSTS[(i + idx) % FIRSTS.length]} ${SURNAMES[(i * 5 + idx) % SURNAMES.length]}${i >= 5 && i % 2 ? "son" : ""}`,
      age: 26, country: "India", role,
      ratings: { battingIQ: bat ? 70 : 45, timing: bat ? 68 : 40, power: bat ? 66 : 45, running: 55, wicketTaking: bat ? 20 : 66, economy: bat ? 20 : 64, accuracy: bat ? 20 : 62, clutch: 55 },
      battingHand: i % 3 === 0 ? "left" : "right",
      bowlingStyle: bat ? undefined : styles[i % styles.length],
      injured: false, injuryGamesLeft: 0, isInternational: false, isWicketKeeper: i === 4,
    }), 5);
  });
  return team;
}

describe("live matches with forced situations", () => {
  afterEach(() => setRuleOverrides(null));
  beforeAll(() => setCommentaryModel(model));
  afterAll(() => setCommentaryModel(null));

  it("non-striker run outs: the line names the partner who is out", () => {
    setRuleOverrides({ forceKind: "run_out", forceRunOutRole: "nonStriker", forceRunOutRuns: 1 });
    let checked = 0;
    for (const seed of [41, 42]) {
      const { balls } = simulateRemaining(createMatchState(makeTeam(0, `n${seed}h`), makeTeam(1, `n${seed}a`), RULE_PRESETS.modern, null, seed));
      for (const b of balls) {
        if (b.wicketType !== "run_out" || !b.playerOutName || b.playerOutName === b.batterName) continue;
        // DRS review texts (live-match.ts, outside this module) are written without regard to who was out
        if (/DRS|review/i.test(b.commentary)) continue;
        checked++;
        expect(b.commentary, "names the batter who is out").toContain(S(b.playerOutName));
        expect(b.commentary).not.toMatch(/\{|undefined/);
        mustNotBeOut(S(b.batterName))(b.commentary);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("any forced dismissal kind produces a clean line", () => {
    for (const kind of DELIVERY_DISMISSALS) {
      setRuleOverrides({ forceKind: kind });
      const { balls } = simulateRemaining(createMatchState(makeTeam(2, "k1"), makeTeam(3, "k2"), RULE_PRESETS.modern, null, 7));
      for (const b of balls) {
        expect(b.commentary.length, kind).toBeGreaterThan(5);
        expect(b.commentary, kind).not.toMatch(/\{[a-z]+\}|undefined|NaN/);
      }
    }
  }, 120_000);

  it("the match plays the same with and without the model", () => {
    const score = () => {
      const { state } = simulateRemaining(createMatchState(makeTeam(4, "s1"), makeTeam(5, "s2"), RULE_PRESETS.modern, null, 99));
      return [state.innings1Score ?? 0, state.score];
    };
    const a = score();
    setCommentaryModel(null);
    const b = score();
    setCommentaryModel(model);
    expect(a).toEqual(b);
  });
});
