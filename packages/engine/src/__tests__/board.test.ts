import { describe, expect, it } from "vitest";
import {
  generateBoardObjectives,
  evaluateBoardObjectives,
  createBoardState,
  updateBoardState,
  isFired,
} from "../board.js";

describe("generateBoardObjectives", () => {
  it("generates title objective for strong teams", () => {
    const objectives = generateBoardObjectives({
      seasonNumber: 2,
      teamPower: 88,
    });
    expect(objectives.some(o => o.type === "title")).toBe(true);
  });

  it("generates top_4 for moderately strong teams", () => {
    const objectives = generateBoardObjectives({
      seasonNumber: 2,
      teamPower: 82,
    });
    expect(objectives.some(o => o.type === "top_4")).toBe(true);
  });

  it("generates playoff objective for average teams", () => {
    const objectives = generateBoardObjectives({
      seasonNumber: 2,
      teamPower: 75,
    });
    expect(objectives.some(o => o.type === "playoff")).toBe(true);
  });

  it("overrides to playoff for weak teams in season 1", () => {
    const objectives = generateBoardObjectives({
      seasonNumber: 1,
      teamPower: 70,
    });
    expect(objectives[0].type).toBe("playoff");
  });

  it("always includes a youth development objective", () => {
    const objectives = generateBoardObjectives({
      seasonNumber: 2,
      teamPower: 85,
    });
    expect(objectives.some(o => o.type === "develop_youth")).toBe(true);
  });

  it("includes NRR objective after poor finishing position", () => {
    const objectives = generateBoardObjectives({
      seasonNumber: 3,
      previousPosition: 8,
      teamPower: 72,
    });
    expect(objectives.some(o => o.type === "improve_nrr")).toBe(true);
  });
});

describe("evaluateBoardObjectives", () => {
  it("returns high satisfaction when all objectives met", () => {
    const result = evaluateBoardObjectives({
      objectives: [
        { type: "playoff", description: "Qualify for playoffs" },
        { type: "develop_youth", count: 2, description: "Give 2 young players 5+ matches" },
      ],
      finalPosition: 3,
      isChampion: false,
      youthMatchesGiven: 3,
      currentNRR: 0.5,
      totalTeams: 10,
    });
    expect(result.satisfaction).toBeGreaterThanOrEqual(6);
    expect(result.budgetModifier).toBeGreaterThan(1.0);
    expect(result.metCount).toBe(2);
    expect(result.totalCount).toBe(2);
  });

  it("returns negative satisfaction when all objectives fail", () => {
    const result = evaluateBoardObjectives({
      objectives: [
        { type: "title", description: "Win the championship" },
        { type: "develop_youth", count: 3, description: "Give 3 young players 5+ matches" },
      ],
      finalPosition: 8,
      isChampion: false,
      youthMatchesGiven: 0,
      currentNRR: -0.5,
      totalTeams: 10,
    });
    expect(result.satisfaction).toBeLessThan(0);
    expect(result.budgetModifier).toBeLessThan(1.0);
  });

  it("champion always gets positive evaluation", () => {
    const result = evaluateBoardObjectives({
      objectives: [
        { type: "title", description: "Win the championship" },
      ],
      finalPosition: 1,
      isChampion: true,
      youthMatchesGiven: 0,
      currentNRR: 1.0,
      totalTeams: 10,
    });
    expect(result.satisfaction).toBeGreaterThanOrEqual(15);
    expect(result.budgetModifier).toBeGreaterThanOrEqual(1.10);
  });
});

describe("createBoardState", () => {
  it("creates state with default satisfaction of 50", () => {
    const state = createBoardState([
      { type: "playoff", description: "Qualify for playoffs" },
    ]);
    expect(state.satisfaction).toBe(50);
    expect(state.warnings).toBe(0);
    expect(state.budgetModifier).toBe(1.0);
  });
});

describe("updateBoardState", () => {
  it("increases satisfaction on positive evaluation", () => {
    const state = createBoardState([
      { type: "playoff", description: "Qualify for playoffs" },
    ]);
    const evaluation = {
      satisfaction: 10,
      budgetModifier: 1.05,
      message: "Good season",
      metCount: 1,
      totalCount: 1,
    };
    const updated = updateBoardState(state, evaluation);
    expect(updated.satisfaction).toBe(60);
  });

  it("decreases satisfaction on negative evaluation", () => {
    const state = createBoardState([]);
    state.satisfaction = 30;
    const evaluation = {
      satisfaction: -20,
      budgetModifier: 0.92,
      message: "Bad season",
      metCount: 0,
      totalCount: 2,
    };
    const updated = updateBoardState(state, evaluation);
    expect(updated.satisfaction).toBe(10);
    expect(updated.warnings).toBe(1);
  });

  it("fires manager at 3 warnings with low satisfaction", () => {
    const state = createBoardState([]);
    state.satisfaction = 15;
    state.warnings = 2;
    const evaluation = {
      satisfaction: -10,
      budgetModifier: 0.90,
      message: "Terrible",
      metCount: 0,
      totalCount: 3,
    };
    const updated = updateBoardState(state, evaluation);
    expect(updated.warnings).toBe(3);
    expect(isFired(updated)).toBe(true);
  });

  it("clamps satisfaction between 0 and 100", () => {
    const state = createBoardState([]);
    state.satisfaction = 95;
    const evaluation = {
      satisfaction: 15,
      budgetModifier: 1.10,
      message: "Great",
      metCount: 2,
      totalCount: 2,
    };
    const updated = updateBoardState(state, evaluation);
    expect(updated.satisfaction).toBeLessThanOrEqual(100);
  });

  it("reduces warnings on high satisfaction", () => {
    const state = createBoardState([]);
    state.satisfaction = 65;
    state.warnings = 1;
    const evaluation = {
      satisfaction: 10,
      budgetModifier: 1.05,
      message: "Good",
      metCount: 1,
      totalCount: 1,
    };
    const updated = updateBoardState(state, evaluation);
    expect(updated.warnings).toBe(0);
  });
});
