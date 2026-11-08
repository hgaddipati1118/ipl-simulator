import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  loadCommentaryModel, setCommentaryModel, getCommentaryModel, MIN_UNUSED, hasCommentaryModel, pickModelCommentary, commentaryShortName,
  bowlerKindIndex, type CommentaryModelData, type ModelBall,
} from "../commentary-model.js";
import { generateBallCommentary, generateBallCommentaryDetailed } from "../commentary.js";
import { createMatchState, simulateRemaining } from "../live-match.js";
import { createRNG } from "../rng.js";
import { Player } from "../player.js";
import { RULE_PRESETS } from "../rules.js";
import { Team, IPL_TEAMS } from "../team.js";
import { NAME_POOLS } from "../name-model.js";

// The model is generated (packages/ratings/src/analysis/commentary-build.py) and committed with the app.
const MODEL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../app/public/data/commentary-model.json");
const model: CommentaryModelData | null = existsSync(MODEL_PATH) ? JSON.parse(readFileSync(MODEL_PATH, "utf8")) : null;

const OUTCOMES = ["dot", "1", "2", "3", "4", "6", "wide", "noball", "legbye"] as const;
const WICKETS = ["bowled", "caught", "lbw", "run_out", "stumped"] as const;

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
      ratings: {
        battingIQ: bat ? 70 : 45, timing: bat ? 68 : 40, power: bat ? 66 : 45, running: 55,
        wicketTaking: bat ? 20 : 66, economy: bat ? 20 : 64, accuracy: bat ? 20 : 62, clutch: 55,
      },
      battingHand: i % 3 === 0 ? "left" : "right",
      bowlingStyle: bat ? undefined : styles[i % styles.length],
      injured: false, injuryGamesLeft: 0, isInternational: false, isWicketKeeper: i === 4,
    }), 5);
  });
  return team;
}

function playMatch(seed: number, women = false): { lines: string[]; scores: number[]; names: string[] } {
  const home = makeTeam(0, `h${seed}`);
  const away = makeTeam(1, `a${seed}`);
  const names = [...home.roster, ...away.roster].map((p) => p.name);
  const { state, balls } = simulateRemaining(createMatchState(home, away, women ? { ...RULE_PRESETS.modern, gender: "women" } : RULE_PRESETS.modern, null, seed));
  return { lines: balls.map((b) => b.commentary), scores: [state.innings1Score ?? 0, state.score], names };
}

describe.skipIf(!model)("corpus commentary model", () => {
  beforeAll(() => setCommentaryModel(model));
  afterAll(() => setCommentaryModel(null));

  const ball = (over: Partial<ModelBall> = {}): ModelBall => ({
    outcome: "dot", over: 8, ball: 3, score: 60, wickets: 2, isSecondInnings: false, bowlingStyle: "right-arm-fast",
    battingHand: "right", batterName: "Zayan Quillfeather", bowlerName: "Torin Marbleton", fielderName: "Marlo Zephyrov",
    nonStrikerName: "Evander Oakhurst", ...over,
  });

  const has = (cls: string) => (getCommentaryModel()?.lines[cls]?.t.length ?? 0) > 0;

  it("is loaded and covers the common outcomes (rare classes fall back to the built-in lines)", () => {
    expect(hasCommentaryModel()).toBe(true);
    for (const o of ["dot", "1", "2", "4", "6", "wide"]) expect(has(o), `class ${o}`).toBe(true);
    expect(has("W:caught") || has("W:bowled") || has("W:lbw")).toBe(true);
  });

  it("a class without templates yields no pick, and the full generator still answers", () => {
    const rng = createRNG(1);
    for (const cls of [...OUTCOMES, ...WICKETS.map((w) => `W:${w}`)]) {
      if (has(cls)) continue;
      const wicket = cls.startsWith("W:");
      expect(pickModelCommentary(ball({ outcome: wicket ? "wicket" : cls, wicketType: wicket ? cls.slice(2) : undefined }), rng)).toBeNull();
      const text = generateBallCommentary({ bowlerName: "A B", batterName: "C D", outcome: wicket ? "wicket" : cls, runs: 0, over: 3, ball: 2, score: 20, wickets: 0, isSecondInnings: false, wicketType: wicket ? (cls.slice(2) as "bowled") : undefined, fielderName: "E F", rng });
      expect(text.length).toBeGreaterThan(10);
    }
  });

  it("never leaves an unfilled slot", () => {
    const rng = createRNG(7);
    for (const o of [...OUTCOMES, "wicket"]) {
      for (let i = 0; i < 300; i++) {
        for (const wt of o === "wicket" ? WICKETS : [undefined]) {
          const p = pickModelCommentary(ball({ outcome: o, wicketType: wt, over: i % 20, gender: i % 2 ? "female" : "male" }), rng);
          if (!p) { expect(getCommentaryModel()!.lines[o === "wicket" ? `W:${wt}` : o]?.t.length ?? 0, `${o}/${wt}`).toBeLessThan(12); continue; }
          expect(p!.text).not.toMatch(/\{[a-z]+\}/i);
          expect(p!.text).not.toMatch(/undefined|NaN|\{|\}/);
          expect(p!.text.length).toBeGreaterThan(8);
          expect(p!.text.length).toBeLessThanOrEqual(260);
        }
      }
    }
  });

  it("a line never contradicts its outcome", () => {
    const rng = createRNG(11);
    const bad: string[] = [];
    const check = (o: string, wt: string | undefined, re: RegExp, why: string) => {
      for (let i = 0; i < 400; i++) {
        const p = pickModelCommentary(ball({ outcome: o, wicketType: wt, over: i % 20, bowlingStyle: i % 2 ? "off-spin" : "right-arm-fast" }), rng);
        if (p && re.test(p.text)) bad.push(`${o}${wt ? "/" + wt : ""} ${why}: ${p.text}`);
      }
    };
    check("dot", undefined, /\b(four|fours|six|sixes|boundary|boundaries|maximum)\b/i, "boundary word on a dot");
    check("dot", undefined, /\b(single|couple of runs|two runs)\b/i, "run word on a dot");
    check("1", undefined, /\b(four|six|boundary|maximum)\b/i, "boundary word on a single");
    check("2", undefined, /\b(four|six|boundary|maximum)\b/i, "boundary word on a two");
    check("4", undefined, /\b(six|sixes|maximum|single|dot ball)\b/i, "wrong word on a four");
    check("6", undefined, /\b(four|fours|single|dot ball)\b/i, "wrong word on a six");
    for (const o of ["dot", "1", "2", "3", "4", "6"]) check(o, undefined, /\b(caught|lbw|stumped|run[- ]out|bowled him|clean bowled)\b/i, "dismissal on a non-wicket");
    check("wicket", "bowled", /\b(caught|lbw|stumped|run[- ]out)\b/i, "wrong dismissal on a bowled");
    check("wicket", "caught", /\b(lbw|stumped|run[- ]out|clean bowled|castle\w*)\b/i, "wrong dismissal on a catch");
    check("wicket", "lbw", /\b(caught|stumped|run[- ]out|clean bowled)\b/i, "wrong dismissal on an lbw");
    check("wicket", "run_out", /\b(caught|lbw|stumped|clean bowled)\b/i, "wrong dismissal on a run out");
    check("wicket", "stumped", /\b(caught|lbw|run[- ]out|clean bowled)\b/i, "wrong dismissal on a stumping");
    check("wicket", "caught", /\b(four|six|single|no run|dot ball)\b/i, "run word on a wicket");
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it("the full commentary line says the right thing for the outcome", () => {
    const rng = createRNG(3);
    const base = { bowlerName: "Torin Marbleton", batterName: "Zayan Quillfeather", over: 8, ball: 3, score: 60, wickets: 2, isSecondInnings: false, bowlingStyle: "right-arm-fast", rng };
    for (let i = 0; i < 100; i++) {
      expect(generateBallCommentary({ ...base, outcome: "4", runs: 4 })).toMatch(/FOUR!/);
      expect(generateBallCommentary({ ...base, outcome: "6", runs: 6 })).toMatch(/SIX!/);
      expect(generateBallCommentary({ ...base, outcome: "wicket", runs: 0, wicketType: "bowled" })).toMatch(/OUT!/);
      expect(generateBallCommentary({ ...base, outcome: "dot", runs: 0 })).not.toMatch(/FOUR|SIX|OUT!/);
      expect(generateBallCommentary({ ...base, outcome: "wide", runs: 1 })).toMatch(/wide/i);
    }
  });

  it("caught lines name the fielder only when the match supplies one", () => {
    const rng = createRNG(5);
    let named = 0;
    for (let i = 0; i < 400; i++) {
      const p = pickModelCommentary(ball({ outcome: "wicket", wicketType: "caught", fielderName: undefined }), rng);
      if (p) expect(p.text).not.toContain("Zephyrov");
      const q = pickModelCommentary(ball({ outcome: "wicket", wicketType: "caught" }), rng);
      if (q?.text.includes("Zephyrov")) named++;
    }
    const namesFielder = getCommentaryModel()!.lines["W:caught"]?.t.some((t) => t.includes("{fielder}")) ?? false;
    if (namesFielder) expect(named).toBeGreaterThan(0);
  });

  it("samples shot tags consistent with the outcome", () => {
    const rng = createRNG(9);
    for (let i = 0; i < 400; i++) {
      const six = pickModelCommentary(ball({ outcome: "6" }), rng)!;
      expect(["DEFENDED", "LEFT_ALONE", "BLOCK", "DAB"]).not.toContain(six.tags.shot);
      const dot = pickModelCommentary(ball({ outcome: "dot" }), rng)!;
      expect(dot.tags.control).toBeLessThanOrEqual(3);
    }
  });

  it("uses spin vocabulary only for spinners and pace vocabulary only for pace bowlers", () => {
    const rng = createRNG(13);
    const spinOnly = /\b(googly|doosra|carrom|flight(ed)?|loops?|spinner|leggie|offie|arm ball|turn(s|ed)? (sharply|away|back|in)|drifts?|tossed)\b/i;
    const paceOnly = /\b(bouncer|yorker|seam(s|ing)?|slower ball|cutter|knuckle|back of a length|pace|quick)\b/i;
    let spinLeak = 0, paceLeak = 0;
    for (let i = 0; i < 600; i++) {
      const o = (["dot", "1", "4"] as const)[i % 3];
      if (paceOnly.test(pickModelCommentary(ball({ outcome: o, bowlingStyle: "leg-spin" }), rng)!.text)) paceLeak++;
      if (spinOnly.test(pickModelCommentary(ball({ outcome: o, bowlingStyle: "right-arm-fast" }), rng)!.text)) spinLeak++;
    }
    // the tag scoring strongly prefers matching bowler kinds; allow a little leakage from generic lines
    expect(spinLeak / 600).toBeLessThan(0.08);
    expect(paceLeak / 600).toBeLessThan(0.08);
  });

  it("gender: women's lines say she/her, men's never do", () => {
    const rng = createRNG(21);
    for (let i = 0; i < 300; i++) {
      const w = pickModelCommentary(ball({ outcome: (["dot", "1", "4", "6"] as const)[i % 4], gender: "female" }), rng)!.text;
      expect(w).not.toMatch(/\b(he|him|his|himself)\b/i);
      const m = pickModelCommentary(ball({ outcome: (["dot", "1", "4", "6"] as const)[i % 4], gender: "male" }), rng)!.text;
      expect(m).not.toMatch(/\b(she|herself)\b/i);
    }
  });

  it("is deterministic for a seed and varies across seeds", () => {
    const a = playMatch(101).lines;
    const b = playMatch(101).lines;
    const c = playMatch(102).lines;
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("the match plays out identically with or without the model (commentary never touches the sim RNG)", () => {
    const withModel = playMatch(2024).scores;
    setCommentaryModel(null);
    const without = playMatch(2024).scores;
    setCommentaryModel(model);
    expect(withModel).toEqual(without);
  });

  it("gives a varied commentary over a whole match and never repeats a corpus line", () => {
    const { lines } = playMatch(77);
    expect(lines.length).toBeGreaterThan(200);
    const distinct = new Set(lines);
    expect(distinct.size / lines.length).toBeGreaterThan(0.85);
    // corpus text (everything after the "..., OUTCOME" label) is not repeated verbatim while the class still has unused lines
    const CLASS_OF: Record<string, string> = { "FOUR!": "4", "SIX!": "6", "no run.": "dot", "1 run.": "1", "2 runs.": "2", "3 runs.": "3", "wide.": "wide", "no ball!": "noball", "leg bye.": "legbye" };
    const seen = new Map<string, number>();
    const demand = new Map<string, number>();
    const parsed = lines.map((l) => {
      const m = l.match(/^[^,]*,\s*(FOUR!|SIX!|OUT!|no run\.|\d runs?\.|wide\.|no ball!|leg bye\.)\s*(.*)$/);
      return m ? { cls: CLASS_OF[m[1]] ?? "wicket", body: m[2] } : null;
    });
    for (const p of parsed) if (p) demand.set(p.cls, (demand.get(p.cls) ?? 0) + 1);
    const repeats: string[] = [];
    for (const p of parsed) {
      if (!p || p.body.length < 40) continue;
      const pool = getCommentaryModel()!.lines[p.cls]?.t.length ?? 0;
      const key = p.cls + "|" + p.body;
      if ((seen.get(key) ?? 0) >= 1 && pool >= 2 * (demand.get(p.cls) ?? 0) + 20) repeats.push(p.body);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect(repeats.slice(0, 5)).toEqual([]);
  });

  it("only names players who are in the match (no real names leak from the source text)", () => {
    const { lines, names } = playMatch(31);
    const inMatch = new Set<string>();
    for (const n of names) for (const t of n.split(/\s+/)) inMatch.add(t);
    for (const n of names) inMatch.add(commentaryShortName(n));
    const words = new Set<string>();
    for (const { t } of Object.values(getCommentaryModel()!.lines)) for (const s of t) for (const w of s.match(/[a-z][a-z'’]+/g) ?? []) words.add(w);
    // fixed vocabulary that the engine's own suffixes use
    for (const w of ["Need", "That", "FIFTY", "CENTURY", "Well", "What", "Crucial", "Agonisingly", "Fires", "The", "A", "End"]) words.add(w.toLowerCase());
    const realTokens = new Set<string>();
    for (const pool of Object.values(NAME_POOLS)) for (const t of [...pool.first, ...pool.last]) if (t.length >= 4) realTokens.add(t);
    const leaks: string[] = [];
    for (const line of lines) {
      let stripped = line;
      for (const n of [...inMatch].sort((a, b) => b.length - a.length)) stripped = stripped.split(n).join(" ");
      for (const m of stripped.matchAll(/\b[A-Z][a-z]{3,}\b/g)) {
        const tok = m[0];
        if (!words.has(tok.toLowerCase()) && realTokens.has(tok)) leaks.push(`${tok} in: ${line}`);
      }
    }
    expect(leaks.slice(0, 5)).toEqual([]);
  });

  it("no template carries a real player name: capitalised words are plain vocabulary", () => {
    const lowerWords = new Set<string>();
    for (const { t } of Object.values(getCommentaryModel()!.lines)) for (const s of t) for (const w of s.match(/\b[a-z][a-z'’]+\b/g) ?? []) lowerWords.add(w);
    const realTokens = new Set<string>();
    for (const pool of Object.values(NAME_POOLS)) for (const t of [...pool.first, ...pool.last]) if (t.length >= 3) realTokens.add(t);
    // onomatopoeia and exclamations that happen to be a first name somewhere in the world
    for (const w of ["Bam", "Boom", "Wham", "Pow", "Zing", "Whack", "Wow", "Ooh", "Oof", "Yes", "Hope", "Love", "Lord", "King", "Major", "Short", "Brown", "Gray", "Grey", "Rose", "Sunny", "Happy", "Faith", "Free", "Grace"]) lowerWords.add(w.toLowerCase());
    // idioms whose first word is also a surname ("Stone dead." for a plumb lbw); the bare surname still counts
    const IDIOMS = /\bStone dead\b/g;
    const offenders: string[] = [];
    for (const [cls, { t }] of Object.entries(getCommentaryModel()!.lines)) {
      for (const s of t) {
        for (const m of s.replace(IDIOMS, "").matchAll(/\b[A-Z][a-zA-Z'’-]+\b/g)) {
          const tok = m[0];
          if (realTokens.has(tok) && !lowerWords.has(tok.toLowerCase())) offenders.push(`${cls}: ${tok} in "${s}"`);
        }
      }
    }
    expect(offenders.slice(0, 5)).toEqual([]);
  });

  it("never repeats a line while the class has unused lines", () => {
    const rng = createRNG(99);
    for (const cls of ["dot", "1", "4"]) {
      const pool = getCommentaryModel()!.lines[cls].t.length;
      const used: Record<string, 1> = {};
      const draws = Math.min(pool - MIN_UNUSED, 80);
      for (let i = 0; i < draws; i++) {
        const p = pickModelCommentary(ball({ outcome: cls, over: i % 20 }), rng, used)!;
        expect(p, `${cls} ran dry on draw ${i}`).not.toBeNull();
        expect(used[p.key], `${cls} repeated ${p.key} on draw ${i}`).toBeUndefined();
        used[p.key] = 1;
      }
    }
    // when a class is used up the picker steps aside instead of repeating
    const dry: Record<string, 1> = {};
    getCommentaryModel()!.lines["dot"].t.forEach((_, i) => (dry[`dot:${i}`] = 1));
    expect(pickModelCommentary(ball({ outcome: "dot" }), rng, dry)).toBeNull();
  });

  it("falls back to the built-in lines when the model is cleared", () => {
    setCommentaryModel(null);
    const r = generateBallCommentaryDetailed({ bowlerName: "Bumrah", batterName: "Kohli", outcome: "4", runs: 4, over: 5, ball: 3, score: 42, wickets: 1, isSecondInnings: false, bowlingStyle: "right-arm-fast", rng: () => 0 });
    expect(r.key).toBeUndefined();
    expect(r.text).toContain("FOUR");
    setCommentaryModel(model);
  });
});

describe("commentary model helpers", () => {
  it("loadCommentaryModel installs a fetched model and survives a failed fetch", async () => {
    const tiny: CommentaryModelData = { v: 1, dict: { shot: [null], line: [null], len: [null], bk: [], hand: [], ph: [], pr: [] }, joint: {}, lines: { dot: { t: ["Left alone"], g: [0] } } };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => tiny })));
    setCommentaryModel(null);
    expect(await loadCommentaryModel("/x.json")).toBe(true);
    expect(hasCommentaryModel()).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    setCommentaryModel(null);
    expect(await loadCommentaryModel("/x.json")).toBe(false);
    expect(hasCommentaryModel()).toBe(false);
    vi.unstubAllGlobals();
  });
  it("shortens names like a commentator", () => {
    expect(commentaryShortName("Virat Kohli")).toBe("Kohli");
    expect(commentaryShortName("Rohit Sharma")).toBe("Rohit");
    expect(commentaryShortName("Arshdeep Singh")).toBe("Arshdeep");
    expect(commentaryShortName("V Singh")).toBe("Singh");
    expect(commentaryShortName("Bumrah")).toBe("Bumrah");
  });
  it("maps bowling styles to kinds", () => {
    expect(bowlerKindIndex("right-arm-fast")).toBe(1);
    expect(bowlerKindIndex("left-arm-medium")).toBe(2);
    expect(bowlerKindIndex("off-spin")).toBe(3);
    expect(bowlerKindIndex("left-arm-orthodox")).toBe(4);
    expect(bowlerKindIndex("left-arm-wrist-spin")).toBe(5);
    expect(bowlerKindIndex("unknown")).toBe(0);
  });
  it("without a model the picker steps aside", () => {
    setCommentaryModel(null);
    expect(pickModelCommentary({ outcome: "dot", over: 1, ball: 1, score: 0, wickets: 0, isSecondInnings: false, batterName: "A B", bowlerName: "C D" }, createRNG(1))).toBeNull();
  });
});

describe("run-out lines credit the right batter", () => {
  // Run-out templates are tagged by who was out: "W:run_out" = the striker ({batter}), "W:run_out_ns" = the partner ({nonstriker};
  // {batter} is still the striker who played the shot and survives). docs/COMMENTARY.md section 8.
  const lines = (cls: string) => (model as unknown as { lines: Record<string, { t: string[] }> }).lines[cls]?.t ?? [];
  const shotByPartner = /\{nonstriker\}\s+(went|goes|looks?|looked|tried|tries|plays?|played|pulls?|pulled|drives?|drove|cuts?|flicks?|hooks?|punche[sd]|tap(s|ped)|nudge[sd]|push(es|ed))\b/i;
  const outPhrase = "(is|was|has been|gets|got)\\s+(\\w+\\s+)?(run[- ]?out|out|gone|stranded)";
  const slotOut = (slot: string) => new RegExp(`\\{${slot}\\}(?:'s)?\\s+(\\w+\\s+){0,2}?${outPhrase}|\\{${slot}\\}'s\\s+run[- ]?out`, "i");

  it.runIf(model !== null)("no run-out template has the non-striker playing the shot, in either class", () => {
    expect(lines("W:run_out").length).toBeGreaterThan(0);
    expect([...lines("W:run_out"), ...lines("W:run_out_ns")].filter((t) => shotByPartner.test(t))).toEqual([]);
  });
  it.runIf(model !== null)("striker run outs (out = striker) never say the partner is the one out", () => {
    expect(lines("W:run_out").filter((t) => slotOut("nonstriker").test(t))).toEqual([]);
  });
  it.runIf(model !== null)("non-striker run outs (out = nonstriker) refer to the partner and never describe the striker's own dismissal", () => {
    const ns = lines("W:run_out_ns");
    expect(ns.filter((t) => !t.includes("{nonstriker}"))).toEqual([]);
    expect(ns.filter((t) => slotOut("batter").test(t))).toEqual([]);
  });
  it.runIf(model !== null)("a non-striker run out only draws from the non-striker class", () => {
    setCommentaryModel(model);
    const ns = new Set(lines("W:run_out_ns"));
    const mk = (nonStriker: boolean): ModelBall => ({
      outcome: "wicket", wicketType: "run_out", outNonStriker: nonStriker, over: 8, ball: 3, score: 60, wickets: 2, isSecondInnings: false,
      bowlingStyle: "right-arm-fast", battingHand: "right", batterName: "Zayan Quillfeather", bowlerName: "Torin Marbleton",
      fielderName: "Marlo Zephyrov", nonStrikerName: "Evander Oakhurst",
    });
    const rng = createRNG(4);
    for (let i = 0; i < 100; i++) {
      const p = pickModelCommentary(mk(true), rng);
      if (p) { expect(p.key.startsWith("W:run_out_ns:")).toBe(true); expect(p.text).toContain("Oakhurst"); }
      const q = pickModelCommentary(mk(false), rng);
      if (q) expect(q.key.startsWith("W:run_out:")).toBe(true);
    }
    expect(ns.size).toBeGreaterThanOrEqual(0);
    setCommentaryModel(null);
  });
});
