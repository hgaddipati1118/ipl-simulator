/** Lazy model commentary for instantly simulated matches (instant-commentary.ts, docs/COMMENTARY.md section 9) */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { setCommentaryModel, type CommentaryModelData } from "../commentary-model.js";
import { attachCommentaryCues, withModelCommentary, type DetailedWithCues } from "../instant-commentary.js";
import { simulateMatch, type DetailedMatchResult } from "../match.js";
import { Player } from "../player.js";
import { RULE_PRESETS } from "../rules.js";
import { Team, IPL_TEAMS } from "../team.js";
import { genderOf } from "../delivery-rules.js";

const MODEL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../app/public/data/commentary-model.json");
const model: CommentaryModelData | null = existsSync(MODEL_PATH) ? JSON.parse(readFileSync(MODEL_PATH, "utf8")) : null;

const SURNAMES = ["Quillfeather", "Marbleton", "Zephyrov", "Oakhurst", "Tamarind", "Velkanov", "Dunmore", "Pellegrino", "Ashgrove", "Kestrelman", "Ulverton", "Brightwell"];
const FIRSTS = ["Zayan", "Torin", "Marlo", "Evander", "Lucan", "Yorick", "Casimir", "Ottoline", "Percival", "Dmitri", "Anselm", "Rafferty"];

function makeTeam(idx: number, tag: string): Team {
  const team = new Team({ ...IPL_TEAMS[idx] });
  const roles = ["batsman", "batsman", "batsman", "batsman", "batsman", "all-rounder", "all-rounder", "all-rounder", "bowler", "bowler", "bowler", "bowler"] as const;
  const styles = ["right-arm-fast", "off-spin", "left-arm-orthodox", "leg-spin", "right-arm-medium", "left-arm-fast"] as const;
  roles.forEach((role, i) => {
    const bat = role === "batsman";
    team.addPlayer(new Player({
      id: `${tag}_${i}`,
      name: `${FIRSTS[(i + idx * 3) % FIRSTS.length]} ${SURNAMES[(i * 5 + idx) % SURNAMES.length]}${i >= 5 && i % 2 ? "son" : ""}`,
      age: 26, country: "India", role,
      ratings: {
        battingIQ: bat ? 70 : 45, timing: bat ? 68 : 40, power: bat ? 66 : 45, running: 55,
        wicketTaking: bat ? 20 : 66, economy: bat ? 20 : 64, accuracy: bat ? 20 : 62, clutch: 55, fielding: 30 + i * 4,
      },
      battingHand: i % 3 === 0 ? "left" : "right",
      bowlingStyle: bat ? undefined : styles[i % styles.length],
      injured: false, injuryGamesLeft: 0, isInternational: false, isWicketKeeper: i === 4,
    }), 5);
  });
  return team;
}

function play(seed: number, women = false) {
  const rules = { ...RULE_PRESETS.modern, injuriesEnabled: false, ...(women ? { gender: "women" as const } : {}) };
  const home = makeTeam(0, `h${seed}`), away = makeTeam(1, `a${seed}`);
  const result = simulateMatch(home, away, rules, seed, { countTowardStandings: false });
  attachCommentaryCues(result, [...home.roster, ...away.roster], genderOf(rules));
  return { result, detailed: result.detailed as DetailedWithCues, names: [...home.roster, ...away.roster].map(p => p.name) };
}

const strip = (d: DetailedMatchResult) => ({ ...d, commentaryCues: undefined, ballLog: d.ballLog.map(b => ({ ...b, commentary: "" })) });

describe("commentary cues", () => {
  it("line up one-to-one with the detailed ball log and stay small", () => {
    const { detailed } = play(11);
    expect(detailed.commentaryCues).toBeDefined();
    expect(detailed.commentaryCues!.balls).toHaveLength(detailed.ballLog.length);
    expect(JSON.stringify(detailed.commentaryCues).length / detailed.ballLog.length).toBeLessThan(60);
  });

  it("without a loaded model the detailed result is returned as is", () => {
    setCommentaryModel(null);
    const { detailed } = play(12);
    expect(withModelCommentary(detailed)).toBe(detailed);
  });

  it("matches without cues (older saves, live-viewed matches) are returned as is", () => {
    const { detailed } = play(13);
    delete detailed.commentaryCues;
    expect(withModelCommentary(detailed)).toBe(detailed);
  });
});

describe.skipIf(!model)("model commentary for instant matches", () => {
  beforeAll(() => setCommentaryModel(model));
  afterAll(() => setCommentaryModel(null));

  it("rewrites most balls with corpus lines and changes nothing but the text", () => {
    const { detailed } = play(21);
    const before = JSON.parse(JSON.stringify(detailed));
    const out = withModelCommentary(detailed);
    expect(out).not.toBe(detailed);
    expect(JSON.parse(JSON.stringify(detailed))).toEqual(before); // input untouched
    expect(strip(out)).toEqual(strip(detailed));
    const changed = out.ballLog.filter((b, i) => b.commentary !== detailed.ballLog[i].commentary).length;
    expect(changed / out.ballLog.length).toBeGreaterThan(0.6);
  });

  it("is deterministic and repeats no line within a match", () => {
    const { detailed } = play(22);
    const a = withModelCommentary(detailed).ballLog.map(b => b.commentary);
    const b = withModelCommentary(detailed).ballLog.map(b => b.commentary);
    expect(a).toEqual(b);
    const plain = a.filter((t, i) => t !== detailed.ballLog[i].commentary);
    expect(new Set(plain).size).toBe(plain.length);
  });

  it("names only the players of the match, opens with bowler to batter, fills every slot", () => {
    const { detailed, names } = play(23);
    const out = withModelCommentary(detailed);
    const known = new Set(names.flatMap(n => n.split(" ")));
    out.ballLog.forEach((b, i) => {
      if (b.commentary === detailed.ballLog[i].commentary) return;
      expect(b.commentary).not.toMatch(/\{[a-z]+\}/);
      expect(b.commentary.startsWith(`${b.bowlerName} to ${b.batterName}`) || b.commentary.startsWith("FREE HIT!")).toBe(true);
      for (const w of b.commentary.match(/\b[A-Z][a-z]{3,}son\b/g) ?? []) expect(known.has(w)).toBe(true);
    });
  });

  it("wickets keep their dismissal and a missed chance keeps its fielding line", () => {
    let wickets = 0, notes = 0;
    for (let s = 30; s < 36; s++) {
      const { detailed } = play(s);
      const out = withModelCommentary(detailed);
      out.ballLog.forEach((b, i) => {
        const cue = detailed.commentaryCues!.balls[i];
        if (cue.note && !b.wicketType) { notes++; expect(b.commentary).toBe(detailed.ballLog[i].commentary); }
        if (b.wicketType && b.commentary !== detailed.ballLog[i].commentary) {
          wickets++;
          expect(b.commentary).not.toMatch(/\b(FOUR|SIX)\b/);
        }
      });
    }
    expect(wickets).toBeGreaterThan(0);
    expect(notes).toBeGreaterThan(0);
  });

  it("women's matches use she / her", () => {
    const { detailed } = play(41, true);
    const lines = withModelCommentary(detailed).ballLog.map(b => b.commentary).filter((t, i) => t !== detailed.ballLog[i].commentary);
    expect(lines.length).toBeGreaterThan(50);
    for (const t of lines) expect(t).not.toMatch(/\b(he|him|his|himself)\b/i);
  });
});
