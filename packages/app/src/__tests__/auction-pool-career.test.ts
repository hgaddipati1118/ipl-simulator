import { describe, expect, it } from "vitest";
import { EXTRA_LEAGUES, RULE_PRESETS, getAuctionType, getScaledRetentions, generatePlayerPool, MINI_KEEP_FLOOR_SHARE, type RuleSet } from "@ipl-sim/engine";
import {
  createGameState, initSeason, nextSeason, finishTrades, runCPURetentions, finishRetention,
  initLiveAuction, liveAuctionSimRemaining, finalizeLiveAuction, addPlayersToPool, buildAuctionPoolFor,
  auctionConfigFor, togglePlayerRetention, miniRetentionShortfall, type GameState,
} from "../game-state";

/**
 * The auction from season 2 on (docs/RULES-AUCTION.md section 10): a shortlist sized like a real mini or mega auction
 * for the league, not every free agent, that still fills every squad legally in one "Sim Remaining Auction".
 */

const LEAGUES: [string, RuleSet][] = [
  ["ipl", RULE_PRESETS.modern2026],
  ["wpl", RULE_PRESETS.wpl],
  ...EXTRA_LEAGUES.map(l => [l.id, l.rules] as [string, RuleSet]),
  ["ipl-generated", { ...RULE_PRESETS.modern2026, league: "custom", playerSource: "generated" }],
];

function expectLegal(s: GameState, label: string) {
  const cfg = auctionConfigFor(s.rules);
  for (const t of s.teams) {
    const where = `${label} ${t.id}`;
    expect(t.roster.length, where).toBeGreaterThanOrEqual(cfg.minSquadSize);
    expect(t.roster.length, where).toBeLessThanOrEqual(cfg.maxRosterSize);
    expect(t.internationalCount, where).toBeLessThanOrEqual(cfg.maxInternational);
    expect(t.roster.some(p => p.isWicketKeeper), where).toBe(true);
    expect(t.remainingBudget, where).toBeGreaterThanOrEqual(-1e-9);
  }
}

/** Season 1 (an auction first when the squads start empty), then off-seasons to the next season's start */
function startCareer(rules: RuleSet): GameState {
  let s = createGameState(rules);
  s = { ...s, userTeamId: s.teams[0].id };
  if (s.teams.some(t => t.roster.length < auctionConfigFor(rules).minSquadSize)) {
    s = finalizeLiveAuction(liveAuctionSimRemaining(initLiveAuction({ ...s, phase: "auction" })));
    expectLegal(s, `${rules.league} S1`);
  }
  return initSeason({ ...s, phase: "season" });
}

function toAuction(s: GameState): GameState {
  s = nextSeason(s);
  s = finishRetention(runCPURetentions(s.phase === "trade" ? finishTrades(s) : s));
  return initLiveAuction(s);
}

/** To the retention page of the next off-season (mini years go through the trade window first) */
function toRetention(s: GameState): GameState {
  s = nextSeason(s);
  return s.phase === "trade" ? finishTrades(s) : s;
}

describe("auction pool through a career, every league", () => {
  it.each(LEAGUES)("%s: mini and mega years, realistic pools, legal squads, one-click sims, free agents kept", (id, rules) => {
    let s = startCareer(rules);
    const places = s.teams.length * rules.maxSquadSize;
    for (let k = 0; k < 4; k++) {
      // the off-season's retention: a mini year keeps most of each squad, a mega year retains up to the limit
      s = toRetention(s);
      const type = getAuctionType(s.seasonNumber, s.rules);
      const label = `${id} S${s.seasonNumber} ${type}`;
      expect(s.retentionState?.mode, label).toBe(type);
      s = runCPURetentions(s);
      const cpu = s.teams.filter(t => t.id !== s.userTeamId);
      if (type === "mini") {
        for (const t of cpu) expect(t.roster.length, `${label} ${t.id} kept`).toBeGreaterThanOrEqual(Math.min(11, Math.round(MINI_KEEP_FLOOR_SHARE * rules.maxSquadSize)));
      } else {
        for (const t of cpu) expect(t.roster.length, `${label} ${t.id} retained`).toBeLessThanOrEqual(getScaledRetentions(s.seasonNumber, rules));
      }
      s = initLiveAuction(finishRetention(s));
      const plan = buildAuctionPoolFor({ ...s, auctionLiveState: undefined });
      const freeAgents = s.playerPool.length;
      const auctioned = s.auctionLiveState!.players.length;

      // A shortlist the size of a real auction for the league (the must-includes and role cover can add a little)
      expect(auctioned, label).toBeLessThanOrEqual(freeAgents);
      expect(auctioned, label).toBeLessThanOrEqual(Math.max(Math.ceil(1.25 * plan.target), plan.mustIncluded));
      if (freeAgents > 3 * places) expect(auctioned, label).toBeLessThan(freeAgents / 4);
      if (id === "ipl") {
        // the IPL's real shortlists: about 350 for a mini auction, 575 for a mega
        if (type === "mini") { expect(auctioned, label).toBeGreaterThanOrEqual(300); expect(auctioned, label).toBeLessThanOrEqual(400); }
        else { expect(auctioned, label).toBeGreaterThanOrEqual(500); expect(auctioned, label).toBeLessThanOrEqual(650); }
      }
      // enough for every team's open places
      const open = s.teams.reduce((n, t) => n + Math.max(0, rules.maxSquadSize - t.roster.length), 0);
      expect(auctioned, label).toBeGreaterThanOrEqual(Math.min(freeAgents, open));

      // "Sim Remaining Auction" completes it in one click, and the squads are legal
      s = liveAuctionSimRemaining(s);
      expect(s.auctionLiveState!.phase, label).toBe("complete");
      const sold = s.auctionLiveState!.completedBids.length;
      s = finalizeLiveAuction(s);
      expectLegal(s, label);

      // Everyone not sold is still a free agent: the unsold and those never shortlisted
      expect(s.playerPool.length, label).toBe(freeAgents - sold);
      s = initSeason({ ...s, phase: "season" });
    }
  });
});

describe("the user's retention", () => {
  it("a mini year keeps the squad on its contracts by default; a release frees the contract for the auction purse", () => {
    let s = toRetention(startCareer(RULE_PRESETS.modern2026)); // season 2: a mini auction
    const user = s.teams.find(t => t.id === s.userTeamId)!;
    const r = s.retentionState!;
    expect(r.mode).toBe("mini");
    expect(r.retained).toHaveLength(user.roster.length);
    const contracts = user.roster.reduce((n, p) => n + p.bid, 0);
    expect(r.budget).toBeCloseTo(user.salaryCap - contracts, 1);

    // release the most expensive player: the purse grows by his contract; the kept keep theirs
    const priciest = [...user.roster].sort((a, b) => b.bid - a.bid)[0];
    const bid = priciest.bid;
    const keptBids = new Map(user.roster.filter(p => p !== priciest).map(p => [p.id, p.bid]));
    s = togglePlayerRetention(s, priciest.id);
    expect(s.retentionState!.budget).toBeCloseTo(r.budget + bid, 1);
    s = finishRetention(runCPURetentions(s));
    const after = s.teams.find(t => t.id === s.userTeamId)!;
    expect(after.roster.some(p => p.id === priciest.id)).toBe(false);
    for (const p of after.roster) expect(p.bid).toBe(keptBids.get(p.id));
    expect(s.playerPool.some(p => p.id === priciest.id)).toBe(true);
    expect(s.auctionEntrantIds).toContain(priciest.id);
  });

  it("a mega year retains up to the league's limit on the slabs", () => {
    let s = startCareer(RULE_PRESETS.modern2026);
    for (let k = 0; k < 3; k++) {
      s = toRetention(s);
      if (s.retentionState!.mode === "mega") break;
      s = initSeason({ ...finalizeLiveAuction(liveAuctionSimRemaining(initLiveAuction(finishRetention(runCPURetentions(s))))), phase: "season" });
    }
    expect(s.seasonNumber).toBe(4);
    expect(s.retentionState!.mode).toBe("mega");
    expect(s.retentionState!.retained).toHaveLength(0);
  });

  it("a mini-year choice whose purse can't fill the squad to the minimum doesn't start the auction", () => {
    let s = toRetention(startCareer(RULE_PRESETS.modern2026));
    // keep only the eight cheapest: ten places to the minimum, but no purse left for them
    const user = s.teams.find(t => t.id === s.userTeamId)!;
    const keep = new Set([...user.roster].sort((a, b) => a.bid - b.bid).slice(0, 8).map(p => p.id));
    for (const p of user.roster) if (!keep.has(p.id)) s = togglePlayerRetention(s, p.id);
    s = { ...s, retentionState: { ...s.retentionState!, budget: 1 } }; // as if the kept were paid nearly the whole purse
    expect(miniRetentionShortfall(s)).toBeGreaterThan(0);
    expect(finishRetention(runCPURetentions(s)).phase).toBe("retention");
  });
});

describe("who is in the auction", () => {
  it("released players are always in; the last auction's unsold come first after them; unsold twice, back to the market", () => {
    let s = startCareer(RULE_PRESETS.modern2026);
    s = toAuction(s);
    const released = s.auctionEntrantIds ?? [];
    // a mini year: each CPU team lets a few go (about 70% of the squad stays)
    expect(released.length).toBeGreaterThan(20);
    const inAuction = new Set(s.auctionLiveState!.players.map(p => p.id));
    for (const pid of released) expect(inAuction.has(pid)).toBe(true);

    s = finalizeLiveAuction(liveAuctionSimRemaining(s));
    const unsold = s.auctionResult!.unsold.map(p => p.id);
    expect(s.lastAuctionUnsoldIds).toEqual(unsold);
    expect(s.auctionEntrantIds).toEqual([]);

    // next auction: last time's unsold re-register (those still free agents and not retired) and fill the places
    // after the must-includes and the role cover
    s = toAuction(initSeason({ ...s, phase: "season" }));
    const pool = new Set(s.playerPool.map(p => p.id));
    const next = new Set(s.auctionLiveState!.players.map(p => p.id));
    const reEntering = unsold.filter(pid => pool.has(pid) && next.has(pid));
    expect(reEntering.length).toBeGreaterThan(0);

    // unsold again: an ordinary free agent for the auction after (no longer a must-include)
    s = finalizeLiveAuction(liveAuctionSimRemaining(s));
    const unsoldTwice = s.auctionResult!.unsold.map(p => p.id).filter(pid => reEntering.includes(pid));
    for (const pid of unsoldTwice) expect(s.lastAuctionUnsoldIds).not.toContain(pid);
  });

  it("players the user adds or imports go to the next auction", () => {
    let s = startCareer(RULE_PRESETS.modern2026);
    const imported = generatePlayerPool(5).map((p, i) => { p.id = `imported_${i}`; p.age = 22; return p; });
    s = addPlayersToPool(s, imported);
    s = toAuction(s);
    // (a generated player can retire between seasons, like any free agent)
    const stillFree = imported.filter(p => s.playerPool.some(q => q.id === p.id));
    expect(stillFree.length).toBeGreaterThan(0);
    const inAuction = new Set(s.auctionLiveState!.players.map(p => p.id));
    for (const p of stillFree) expect(inAuction.has(p.id)).toBe(true);
  });

  it("the Deep pool puts every free agent in the auction", () => {
    let s = startCareer({ ...RULE_PRESETS.modern2026, poolDepth: "deep" });
    s = toAuction(s);
    expect(s.auctionLiveState!.players.length).toBe(s.playerPool.length);
    expect(buildAuctionPoolFor(s).pool.length).toBe(s.playerPool.length);
  });
});
