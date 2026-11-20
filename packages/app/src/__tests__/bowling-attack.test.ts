/**
 * The bowling attack (engine bowling-choice.ts `attackTableFor`, docs/TACTICS.md section 8): a CPU side in a men's T20 league chooses each
 * over's bowler from the whole eleven, so the fitted model decides who joins the attack and when a sixth or seventh bowler comes on; the
 * caps and the no-two-in-a-row rule hold, a side whose user set a bowling order bowls from it, the live engine plays the table too, and
 * the switch restores the former attack (Team.autoBowlingOrder).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ATTACK_MODEL, BOWLING_ATTACK_TABLE, attackFeatures, EXTRA_LEAGUES, createMatchState, simulateMatch, simulateRemaining, buildDetailedResultFromState, matchXiOptions, type BallEvent, type RuleSet, type Team } from "@ipl-sim/engine";
import { createGameState } from "../game-state";
import { createPoolLoader, prepareLeaguePool } from "../extended-pool";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const RULES = { ...EXTRA_LEAGUES.find(l => l.id === "bbl")!.rules, injuriesEnabled: false } as RuleSet;
let teams: Team[] = [];

beforeAll(async () => {
  await prepareLeaguePool("bbl", createPoolLoader(async f => new Uint8Array(readFileSync(join(PUBLIC, "pool", f)))));
  teams = createGameState(RULES).teams;
});
afterEach(() => { ATTACK_MODEL.league = true; ATTACK_MODEL.t20i = false; });

/** The bowler of each over of every full innings of n matches (instant engine), with the bowling side */
function innings(n: number, seed = 100): { overs: string[]; team: Team }[] {
  const out: { overs: string[]; team: Team }[] = [];
  for (let i = 0; i < n; i++) {
    const home = teams[i % teams.length], away = teams[(i + 1) % teams.length];
    const r = simulateMatch(home, away, RULES, seed + i, { countTowardStandings: false, rain: false });
    r.innings.forEach((inn, k) => {
      const overs: string[] = [];
      for (const e of inn.ballLog as BallEvent[]) if (overs[e.over] === undefined) overs[e.over] = e.bowler;
      void k;
      out.push({ overs, team: inn.teamId === home.id ? away : home });
    });
  }
  return out;
}

describe("the bowling attack (men's T20 leagues)", () => {
  it("caps and the no-two-in-a-row rule hold; a sixth bowler in most full innings, a seventh in some", () => {
    const full = innings(60).filter(i => i.overs.length === 20);
    expect(full.length).toBeGreaterThan(60);
    let six = 0, seven = 0;
    for (const { overs } of full) {
      const n = new Map<string, number>();
      overs.forEach((id, o) => { n.set(id, (n.get(id) ?? 0) + 1); if (o > 0) expect(id).not.toBe(overs[o - 1]); });
      for (const c of n.values()) expect(c).toBeLessThanOrEqual(4);
      if (n.size >= 6) six++;
      if (n.size >= 7) seven++;
    }
    // real leagues since 2024: 85% of innings use six or more, 18% seven or more (section 7); the former attack about 55% and 16%
    expect(six / full.length).toBeGreaterThan(0.65);
    expect(seven / full.length).toBeGreaterThan(0.05);
    expect(seven / full.length).toBeLessThan(0.4);
  });

  it("switched off, every over goes to the side's bowling order (the former attack)", () => {
    ATTACK_MODEL.league = false;
    let overs = 0, outside = 0;
    for (let i = 0; i < 20; i++) {
      const home = teams[i % teams.length], away = teams[(i + 1) % teams.length];
      const r = simulateMatch(home, away, RULES, 300 + i, { countTowardStandings: false, rain: false });
      for (const inn of r.innings) {
        const side = inn.teamId === home.id ? away : home;
        const xi = side.getPlayingXI(RULES.maxOverseasInXI, matchXiOptions(RULES, 300 + i, side === home ? 0 : 1));
        const order = new Set(side.getBowlingOrder(xi).map(p => p.id));
        const first = new Map<number, string>();
        for (const e of inn.ballLog as BallEvent[]) if (!first.has(e.over)) first.set(e.over, e.bowler);
        for (const id of first.values()) { overs++; if (!order.has(id)) outside++; }
      }
    }
    // (a bowler hurt mid-innings can bring in someone else: the only way out of the order)
    expect(overs).toBeGreaterThan(600);
    expect(outside / overs).toBeLessThan(0.01);
  });

  it("a user's own bowling order is the attack (the table does not widen it)", () => {
    const user = teams[0];
    const xi = user.getPlayingXI(RULES.maxOverseasInXI);
    const order = user.autoBowlingOrder(xi).slice(0, 5).map(p => p.id);
    user.isUserControlled = true;
    user.userPlayingXI = xi.map(p => p.id);
    user.userBowlingOrder = order;
    let overs = 0, outside = 0;
    try {
      for (let i = 0; i < 10; i++) {
        const r = simulateMatch(user, teams[1 + (i % (teams.length - 1))], RULES, 500 + i, { countTowardStandings: false, rain: false });
        for (const inn of r.innings) if (inn.teamId !== user.id) {
          const first = new Map<number, string>();
          for (const e of inn.ballLog as BallEvent[]) if (!first.has(e.over)) first.set(e.over, e.bowler);
          for (const id of first.values()) { overs++; if (!order.includes(id)) outside++; }
        }
      }

    } finally {
      user.isUserControlled = false; user.userPlayingXI = undefined; user.userBowlingOrder = undefined;
    }
    // (five bowlers who cannot finish the overs without two in a row hand an over to someone else: the former rule, about 1-2% of overs)
    expect(overs).toBeGreaterThan(150);
    expect(outside / overs).toBeLessThan(0.03);
  });

  it("the live engine's CPU sides choose from the eleven too (caps and no back-to-back overs hold)", () => {
    let outside = 0;
    for (let i = 0; i < 12; i++) {
      const home = teams[i % teams.length], away = teams[(i + 1) % teams.length];
      const done = simulateRemaining(createMatchState(home, away, RULES, null, 700 + i, { rain: false })).state;
      const d = buildDetailedResultFromState(done);
      for (const k of [1, 2] as const) {
        const inn = k === 1 ? d.innings1 : d.innings2;
        const side = inn.bowlingTeamId === home.id ? home : away;
        const byName = new Map(side.roster.map(p => [p.name, p]));
        const xi = side.getPlayingXI(RULES.maxOverseasInXI, matchXiOptions(RULES, 700 + i, side === home ? 0 : 1));
        const order = new Set(side.autoBowlingOrder(xi).map(p => p.id));
        const overs: string[] = [];
        for (const b of d.ballLog) if (b.innings === k && overs[b.over] === undefined) overs[b.over] = b.bowlerName;
        const n = new Map<string, number>();
        overs.forEach((nm, o) => { n.set(nm, (n.get(nm) ?? 0) + 1); if (o > 0) expect(nm).not.toBe(overs[o - 1]); });
        for (const c of n.values()) expect(c).toBeLessThanOrEqual(4);
        for (const nm of n.keys()) if (!order.has(byName.get(nm)?.id ?? "")) outside++;
      }
    }
    expect(outside).toBeGreaterThan(0);
  });

  it("the engine builds only features the fitted table knows (the names bowling-attack.py writes)", () => {
    const known = new Set(Object.keys(BOWLING_ATTACK_TABLE["t20-male-league"]));
    let checked = 0;
    for (const over of [0, 4, 9, 14, 17, 19]) for (const rank of [0, 3, 5, 6, 8]) for (const last of [null, over - 2]) {
      const c = { id: "x", rank, style: "off-spin" as const, partTimer: rank >= 6, used: last === null ? 0 : 1, lastOver: last !== null && last >= 0 ? last : null, phaseUsed: 0, slack: 2, paceLeft: 8 };
      for (const f of attackFeatures(over, c, { ovr: 45, wkts: 3, inn: 2, rr: 9, nused: 5, lastRuns: 12, runs: 12, wk: 1 })) { expect(known.has(f), f).toBe(true); checked++; }
    }
    expect(checked).toBeGreaterThan(100);
  });
});
