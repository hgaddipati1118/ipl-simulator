import { describe, it, expect } from "vitest";
import { Team, IPL_TEAMS } from "../team.js";
import { Player, type BowlingStyle } from "../player.js";
import { createRNG } from "../rng.js";
import {
  buildAuctionPool, auctionNeeds, auctionPoolTarget, isFrontlineSpinner, isFrontlinePacer,
  POOL_COVERAGE, POOL_PER_SQUAD_PLACE,
} from "../auction-pool.js";
import {
  initAuction, simRemainingAuction, runAuction, completeSquads, keepsSquadReserve, squadTarget,
  retentionCostScale, evaluateRetentionSelection, RETENTION_BUDGET, MAX_RETENTIONS,
  type AuctionBid, type AuctionConfig,
} from "../auction.js";

type Role = "batsman" | "bowler" | "all-rounder";

interface Spec { role: Role; ovr: number; intl?: boolean; wk?: boolean; style?: BowlingStyle }

function makePlayer(id: string, s: Spec): Player {
  const base = s.ovr / 65;
  const bat = s.role === "batsman", bowl = s.role === "bowler";
  return new Player({
    id, name: `Player ${id}`, age: 26, country: s.intl ? "Australia" : "India", role: s.role,
    ratings: {
      battingIQ: Math.round((bat ? 65 : bowl ? 25 : 50) * base), timing: Math.round((bat ? 63 : bowl ? 25 : 48) * base),
      power: Math.round((bat ? 60 : bowl ? 20 : 48) * base), running: Math.round((bat ? 55 : 40) * base),
      wicketTaking: Math.round((bowl ? 65 : bat ? 20 : 50) * base), economy: Math.round((bowl ? 63 : bat ? 20 : 50) * base),
      accuracy: Math.round((bowl ? 60 : bat ? 20 : 48) * base), clutch: Math.round(50 * base),
    },
    isInternational: !!s.intl, isWicketKeeper: !!s.wk,
    bowlingStyle: s.style ?? (bat ? "right-arm-medium" : "right-arm-fast-medium"),
    injured: false, injuryGamesLeft: 0,
  });
}

/** A varied free-agent market: every kind of player at every level, seeded */
function market(n: number, seed = 7): Player[] {
  const rng = createRNG(seed);
  const styles: BowlingStyle[] = ["right-arm-fast", "left-arm-fast-medium", "off-spin", "leg-spin", "left-arm-orthodox", "right-arm-medium"];
  const roles: Role[] = ["batsman", "bowler", "all-rounder"];
  return Array.from({ length: n }, (_, i) => makePlayer(`fa${i}`, {
    role: roles[Math.floor(rng() * 3)],
    ovr: 35 + Math.floor(rng() * 55),
    intl: rng() < 0.45,
    wk: rng() < 0.08,
    style: styles[Math.floor(rng() * styles.length)],
  }));
}

/** IPL-shaped teams, each keeping `kept` players (two overseas, one keeper, one spinner, one pacer among them) */
function teams(count: number, kept: number, salaryCap = 125): Team[] {
  return IPL_TEAMS.slice(0, count).map((config, t) => {
    const team = new Team(config, salaryCap);
    for (let i = 0; i < kept; i++) {
      const spec: Spec = i === 0 ? { role: "batsman", ovr: 80, wk: true }
        : i === 1 ? { role: "bowler", ovr: 80, style: "off-spin" }
        : i === 2 ? { role: "bowler", ovr: 80, intl: true, style: "right-arm-fast" }
        : i === 3 ? { role: "all-rounder", ovr: 78, intl: true }
        : { role: "batsman", ovr: 75 };
      team.addPlayer(makePlayer(`t${t}k${i}`, spec), 10);
    }
    return team;
  });
}

const IPL = { maxSquadSize: 25, maxOverseasInSquad: 8 };

describe("auction pool size", () => {
  it("mini and mega auctions shortlist like the IPL's (about 350 and 575 for ten 25-man squads)", () => {
    const fa = market(3000);
    // squads mostly kept: the size per squad place decides
    const t = teams(10, 20);
    const mini = buildAuctionPool(fa, t, { type: "mini", ...IPL });
    const mega = buildAuctionPool(fa, t, { type: "mega", ...IPL });
    expect(mini.target).toBe(Math.round(POOL_PER_SQUAD_PLACE.mini * 250));
    expect(mega.target).toBe(Math.round(POOL_PER_SQUAD_PLACE.mega * 250));
    expect(mini.pool.length).toBeGreaterThanOrEqual(300);
    expect(mini.pool.length).toBeLessThanOrEqual(400);
    expect(mega.pool.length).toBeGreaterThanOrEqual(500);
    expect(mega.pool.length).toBeLessThanOrEqual(650);
  });

  it("scales with the league: fewer teams and smaller squads, a smaller pool", () => {
    expect(auctionPoolTarget("mini", 5, 18, 0)).toBe(126); // WPL
    expect(auctionPoolTarget("mega", 5, 18, 0)).toBe(207);
    expect(auctionPoolTarget("mini", 8, 16, 0)).toBe(179); // The Hundred
    expect(auctionPoolTarget("mega", 8, 16, 0)).toBe(294);
  });

  it("holds enough players for the places the teams have open", () => {
    const t = teams(10, 4); // 210 open places
    const { openPlaces } = auctionNeeds(t, 25, 8);
    expect(openPlaces).toBe(210);
    const plan = buildAuctionPool(market(3000), t, { type: "mini", ...IPL });
    expect(plan.target).toBeGreaterThanOrEqual(Math.ceil(1.6 * 210));
    expect(plan.pool.length).toBeGreaterThanOrEqual(plan.target);
  });

  it("takes every free agent when there are fewer than the target, or with the Deep pool", () => {
    const t = teams(10, 20);
    expect(buildAuctionPool(market(120), t, { type: "mini", ...IPL }).pool).toHaveLength(120);
    expect(buildAuctionPool(market(3000), t, { type: "mini", ...IPL, deep: true }).pool).toHaveLength(3000);
  });
});

describe("auction pool contents", () => {
  it("always holds the must-includes (released, unsold last time, added by the user), even past the target", () => {
    const fa = market(3000);
    const t = teams(10, 20);
    // the 500 lowest-valued players: none would make a value shortlist
    const weakest = [...fa].sort((a, b) => a.marketValue - b.marketValue).slice(0, 500).map(p => p.id);
    const plan = buildAuctionPool(fa, t, { type: "mini", ...IPL, mustInclude: weakest });
    const ids = new Set(plan.pool.map(p => p.id));
    for (const id of weakest) expect(ids.has(id)).toBe(true);
    expect(plan.mustIncluded).toBe(500);
    expect(plan.pool.length).toBeGreaterThan(plan.target);
  });

  it("fills the rest with the best free agents by market value", () => {
    const fa = market(3000);
    const plan = buildAuctionPool(fa, teams(10, 20), { type: "mini", ...IPL });
    const best = [...fa].sort((a, b) => b.marketValue - a.marketValue).slice(0, 150);
    const ids = new Set(plan.pool.map(p => p.id));
    for (const p of best) expect(ids.has(p.id)).toBe(true);
  });

  it("covers what the teams need: keepers, spinners, pacers, overseas and domestic players", () => {
    // A market whose most valuable players are all overseas pace-bowling batters: a value shortlist alone would
    // hold no keeper, no spinner and no domestic player
    const stars = Array.from({ length: 600 }, (_, i) => makePlayer(`star${i}`, { role: "batsman", ovr: 85 + (i % 10), intl: true }));
    const others = market(2000, 11).filter(p => p.overall < 60);
    const t = teams(10, 4);
    const plan = buildAuctionPool([...stars, ...others], t, { type: "mini", ...IPL });
    for (const kind of ["keeper", "spinner", "pacer", "overseas", "domestic"] as const) {
      expect(plan.needs[kind]).toBeGreaterThan(0);
      expect(plan.counts[kind]).toBeGreaterThanOrEqual(Math.ceil(POOL_COVERAGE * plan.needs[kind]));
    }
    expect(plan.pool.filter(isFrontlineSpinner).length).toBe(plan.counts.spinner);
    expect(plan.pool.filter(isFrontlinePacer).length).toBe(plan.counts.pacer);
  });

  it("is deterministic: the same free agents and teams give the same pool", () => {
    const a = buildAuctionPool(market(3000), teams(10, 6), { type: "mega", ...IPL }).pool.map(p => p.id).sort();
    const b = buildAuctionPool(market(3000), teams(10, 6), { type: "mega", ...IPL }).pool.map(p => p.id).sort();
    expect(a).toEqual(b);
  });
});

describe("auction end: completing the squads", () => {
  const cfg: AuctionConfig = { maxRosterSize: 25, maxInternational: 8, minSquadSize: 18 };

  function legal(t: Team[], config: AuctionConfig = cfg) {
    for (const team of t) {
      expect(team.roster.length).toBeGreaterThanOrEqual(config.minSquadSize);
      expect(team.roster.length).toBeLessThanOrEqual(config.maxRosterSize);
      expect(team.internationalCount).toBeLessThanOrEqual(config.maxInternational);
      expect(team.roster.some(p => p.isWicketKeeper)).toBe(true);
      expect(team.remainingBudget).toBeGreaterThanOrEqual(0);
    }
  }

  it("the live auction fills every squad legally from a shortlist", () => {
    const t = teams(10, 6, 110); // six kept at 10 Cr: 50 Cr left
    const plan = buildAuctionPool(market(3000), t, { type: "mini", ...IPL });
    const done = simRemainingAuction(initAuction(plan.pool, t, cfg), t, cfg);
    expect(done.phase).toBe("complete");
    expect(done.completedBids.length + done.unsold.length).toBe(plan.pool.length);
    legal(t);
    // and completes them to the target squad while the purse allows
    for (const team of t) expect(team.roster.length).toBeGreaterThanOrEqual(squadTarget(cfg));
  });

  it("so does the automated auction", () => {
    const t = teams(10, 6, 110);
    runAuction(buildAuctionPool(market(3000), t, { type: "mini", ...IPL }).pool, t, cfg, createRNG(3));
    legal(t);
  });

  it("a fill signing in the closing rounds never takes the purse below zero", () => {
    // ten teams with 5 Cr left and 14 places each to the minimum: at base prices the fill would overspend, so it comes
    // down to 30 lakh a player (the last accelerated round)
    const t = teams(10, 4, 45);
    const unsold = market(400);
    const bids: AuctionBid[] = [];
    completeSquads(t, unsold, bids, cfg);
    legal(t);
  });

  it("a CPU bid keeps 30 lakh for each place still to fill to the target squad", () => {
    const [team] = teams(1, 10, 110); // 100 Cr spent: 10 Cr left, 11 places to the target of 22 after this one
    expect(squadTarget(cfg)).toBe(22);
    expect(keepsSquadReserve(team, 10 - 0.3 * 11, cfg)).toBe(true);
    expect(keepsSquadReserve(team, 10 - 0.3 * 11 + 0.05, cfg)).toBe(false);
  });
});

describe("retention priced for the league's purse", () => {
  it("keeps the IPL's slabs and scales them down for a smaller purse", () => {
    expect(retentionCostScale(125, "ipl")).toBe(1);
    expect(retentionCostScale(150, "custom")).toBe(1);
    expect(retentionCostScale(12, "wpl")).toBeCloseTo(0.1);
    const stars = Array.from({ length: 6 }, (_, i) => makePlayer(`r${i}`, { role: "batsman", ovr: 85, intl: i < 5 }));
    stars[5] = makePlayer("r5", { role: "batsman", ovr: 50 });
    const ipl = evaluateRetentionSelection(stars, RETENTION_BUDGET, MAX_RETENTIONS);
    const wpl = evaluateRetentionSelection(stars, RETENTION_BUDGET * 0.1, MAX_RETENTIONS, 0.1);
    expect(ipl.totalCost).toBe(79); // 18 + 14 + 11 + 18 + 14 + 4: over the 75 Cr budget
    expect(ipl.valid).toBe(false);
    expect(wpl.totalCost).toBeCloseTo(7.9);
    expect(wpl.retentionCosts.map(c => c.cost)).toEqual([1.8, 1.4, 1.1, 1.8, 1.4, 0.4]);
  });
});
