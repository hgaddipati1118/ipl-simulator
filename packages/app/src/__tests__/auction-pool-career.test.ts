import { describe, expect, it } from "vitest";
import { EXTRA_LEAGUES, RULE_PRESETS, getAuctionType, generatePlayerPool, type RuleSet } from "@ipl-sim/engine";
import {
  createGameState, initSeason, nextSeason, finishTrades, runCPURetentions, finishRetention,
  initLiveAuction, liveAuctionSimRemaining, finalizeLiveAuction, addPlayersToPool, buildAuctionPoolFor,
  auctionConfigFor, type GameState,
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

describe("auction pool through a career, every league", () => {
  it.each(LEAGUES)("%s: realistic pools, legal squads, one-click sims, free agents kept", (id, rules) => {
    let s = startCareer(rules);
    const places = s.teams.length * rules.maxSquadSize;
    for (let k = 0; k < 3; k++) {
      s = toAuction(s);
      const type = getAuctionType(s.seasonNumber, s.rules);
      const label = `${id} S${s.seasonNumber} ${type}`;
      const freeAgents = s.playerPool.length;
      const auctioned = s.auctionLiveState!.players.length;

      // A shortlist: no more than the must-includes and the role cover call for beyond a mega auction's size
      expect(auctioned, label).toBeLessThanOrEqual(Math.max(freeAgents, 0));
      expect(auctioned, label).toBeLessThanOrEqual(Math.round(2.8 * places));
      if (freeAgents > 3 * places) expect(auctioned, label).toBeLessThan(freeAgents / 4);
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

describe("who is in the auction", () => {
  it("released players and the unsold of the last auction are always in; unsold twice, back to the market", () => {
    let s = startCareer(RULE_PRESETS.modern2026);
    s = toAuction(s);
    const released = s.auctionEntrantIds ?? [];
    expect(released.length).toBeGreaterThan(100);
    const inAuction = new Set(s.auctionLiveState!.players.map(p => p.id));
    for (const pid of released) expect(inAuction.has(pid)).toBe(true);

    s = finalizeLiveAuction(liveAuctionSimRemaining(s));
    const unsold = s.auctionResult!.unsold.map(p => p.id);
    expect(s.lastAuctionUnsoldIds).toEqual(unsold);
    expect(s.auctionEntrantIds).toEqual([]);

    // next auction: last time's unsold re-enter (those still free agents and not retired)
    s = toAuction(initSeason({ ...s, phase: "season" }));
    const pool = new Set(s.playerPool.map(p => p.id));
    const next = new Set(s.auctionLiveState!.players.map(p => p.id));
    const reEntering = unsold.filter(pid => pool.has(pid));
    expect(reEntering.length).toBeGreaterThan(0);
    for (const pid of reEntering) expect(next.has(pid)).toBe(true);

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
