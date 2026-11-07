/** Combined (men + women) leagues generate, age and retire each player as their own gender (game-state.ts nextSeason) */
import { describe, it, expect } from "vitest";
import { RULE_PRESETS, playerGender, teamGender, type RuleSet, type Player } from "@ipl-sim/engine";
import { createGameState, nextSeason, type GameState } from "../game-state";

const COMBINED: RuleSet = {
  ...RULE_PRESETS.modern2026,
  name: "Combined",
  league: "custom",
  gender: "combined",
  teamIds: ["mi", "csk", "rcb", "kkr", "mi-w", "dc-w", "rcb-w", "gg-w"],
  playerSource: "real",
};

const everyone = (s: GameState): Player[] => [...s.teams.flatMap(t => t.roster), ...s.playerPool];

/** Make most players very old so the fitted retirement hazard retires many of them */
function aged(state: GameState): GameState {
  for (const p of everyone(state)) if (!p.id.includes("_y")) p.age = 40;
  return state;
}

function genders(state: GameState) {
  const m = new Map<string, "male" | "female">();
  for (const t of state.teams) for (const p of t.roster) m.set(p.id, playerGender(p, state.rules));
  for (const p of state.playerPool) m.set(p.id, playerGender(p, state.rules));
  return m;
}

describe("combined leagues: generated players match the gender", () => {
  it("knows each franchise's side and tags the real women", () => {
    expect(teamGender("mi", COMBINED)).toBe("male");
    expect(teamGender("mi-w", COMBINED)).toBe("female");
    const state = createGameState(COMBINED);
    const women = state.teams.filter(t => t.id.endsWith("-w")).flatMap(t => t.roster);
    expect(women.length).toBeGreaterThan(30);
    expect(women.every(p => p.isFemale)).toBe(true);
    expect(state.teams.filter(t => !t.id.endsWith("-w")).flatMap(t => t.roster).some(p => p.isFemale)).toBe(false);
    // generated pool supplements follow the share of women's teams
    const generatedWomen = state.playerPool.filter(p => p.isFemale);
    expect(generatedWomen.every(p => !p.sourceId)).toBe(true);
  });

  it("a retiring woman is replaced by a woman regen, a man by a man; fill-ins split by the women's teams' share", () => {
    const before = aged(createGameState(COMBINED));
    const g0 = genders(before);
    const next = nextSeason(before);
    const after = new Set(everyone(next).map(p => p.id));
    const retired = [...g0.keys()].filter(id => !after.has(id));
    const retiredWomen = retired.filter(id => g0.get(id) === "female").length;
    const retiredMen = retired.length - retiredWomen;
    expect(retiredWomen).toBeGreaterThan(0);
    expect(retiredMen).toBeGreaterThan(0);
    const regens = everyone(next).filter(p => /_r\d+$/.test(p.id));
    expect(regens).toHaveLength(retired.length);
    expect(regens.filter(p => p.isFemale).length).toBe(retiredWomen);
    expect(regens.filter(p => !p.isFemale).length).toBe(retiredMen);
    const fills = everyone(next).filter(p => /_fw?_\d+$/.test(p.id));
    expect(fills).toHaveLength(15);
    expect(fills.filter(p => p.isFemale).length).toBe(Math.round(15 * 4 / 8));
    // isFemale is set by the generator only when it drew from the women's model (strata, ages, names, fielding)
    expect(regens.filter(p => p.isFemale).every(p => typeof p.potential === "number")).toBe(true);
  });

  it("men's and women's leagues are unchanged: all-male / all-female generation", () => {
    const ipl = nextSeason(aged(createGameState(RULE_PRESETS.modern2026)));
    expect(everyone(ipl).some(p => p.isFemale)).toBe(false);
    const wpl = nextSeason(aged(createGameState(RULE_PRESETS.wpl)));
    const gen = everyone(wpl).filter(p => /_(r|f|fw|y)_?\d+$/.test(p.id) || /_r\d+$/.test(p.id));
    expect(gen.length).toBeGreaterThan(0);
    expect(gen.every(p => p.isFemale)).toBe(true);
  });
});
