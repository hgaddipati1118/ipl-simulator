/** Every league is playable in multiplayer: auction rooms, season-draft rooms and Draft Match pools (multiplayer/leagues.ts) */
import { describe, it, expect, vi } from "vitest";

vi.mock("peerjs", () => ({ default: class MockPeer { on() {} destroy() {} } }));

import { ALL_LEAGUES, EXTRA_LEAGUES, getLeague, isOverseasIn, type ExtraLeagueId } from "@ipl-sim/engine";
import {
  MULTIPLAYER_LEAGUES, multiplayerAuctionRules, multiplayerLeagueTeams, multiplayerSeasonRules,
} from "../multiplayer/leagues.js";
import { HostGameLogic } from "../multiplayer/host-logic.js";
import { DraftRoomHost, type DraftRoomTransport } from "../multiplayer/draft-room.js";
import { realDraftRoomDeps } from "../multiplayer/draft-room-deps.js";
import type { HostMessage, MultiAuctionState } from "../multiplayer/protocol.js";
import { DRAFT_MATCH_POOLS, buildDraftMatchPool, draftPoolVenues, seasonDraftConfig } from "../draft-pools.js";

class MockHost implements DraftRoomTransport {
  roomCode = "LEAGUE";
  messages: HostMessage[] = [];
  onMessage: (peerId: string, data: unknown) => void = () => {};
  onConnection: (peerId: string) => void = () => {};
  onDisconnect: (peerId: string) => void = () => {};
  broadcast(data: unknown) { this.messages.push(JSON.parse(JSON.stringify(data))); }
  sendTo(_p: string, data: unknown) { this.messages.push(JSON.parse(JSON.stringify(data))); }
  destroy() {}
}

describe("multiplayer league registry", () => {
  it("offers every league of the game (IPL, WPL and every extra league)", () => {
    expect(MULTIPLAYER_LEAGUES.map(l => l.id)).toEqual(ALL_LEAGUES.map(l => l.id));
    expect(MULTIPLAYER_LEAGUES.length).toBe(2 + EXTRA_LEAGUES.length);
  });

  it("uses the single-player rules and franchises of each league", () => {
    for (const l of EXTRA_LEAGUES) {
      const id = l.id as ExtraLeagueId;
      expect(multiplayerSeasonRules(id)).toBe(l.rules);
      expect(multiplayerAuctionRules(id).league).toBe(l.id);
      expect(multiplayerLeagueTeams(id).map(t => t.id)).toEqual(l.teams.map(t => t.id));
    }
    expect(multiplayerLeagueTeams("ipl")).toHaveLength(10);
    expect(multiplayerLeagueTeams("wpl")).toHaveLength(5);
  });
});

describe("auction room", () => {
  it("the host switches the league: franchises, rules and claims follow; guests are told", () => {
    const host = new MockHost();
    const logic = new HostGameLogic(host as never, multiplayerAuctionRules("ipl"));
    logic.pickTeam("mi");
    logic.setLeague("bbl");
    const lobby = host.messages.filter(m => m.type === "lobby-state").pop() as Extract<HostMessage, { type: "lobby-state" }>;
    expect(lobby.league).toBe("bbl");
    expect(lobby.teams.map(t => t.teamId)).toEqual(getLeague("bbl")!.teams.map(t => t.id));
    expect(lobby.players.every(p => p.teamId === null)).toBe(true);
    expect(lobby.teams[0].budget).toBe(getLeague("bbl")!.rules.salaryCap);
    logic.destroy?.();
  });

  it("an extra league's auction is a mega auction of its real players with the league's budgets, and its season plays", async () => {
    const host = new MockHost();
    const logic = new HostGameLogic(host as never, multiplayerAuctionRules("psl"));
    let state: MultiAuctionState | null = null;
    logic.setStateChangeHandler(s => { state = s; });
    logic.fillWithCPU();
    const started = logic.startAuction();
    expect(started).toBeInstanceOf(Promise);
    await started;
    expect(state!.phase).toBe("auction");
    const teams = state!.teams;
    expect(teams.map(t => t.teamId)).toEqual(getLeague("psl")!.teams.map(t => t.id));
    // a mega auction: empty squads with the league's full budget, the league's real players in the pool
    expect(teams.every(t => t.rosterCount === 0 && t.budget === getLeague("psl")!.rules.salaryCap)).toBe(true);
    expect(state!.currentPlayer).toBeTruthy();
    expect(state!.totalPlayers).toBeGreaterThanOrEqual(8 * getLeague("psl")!.rules.maxSquadSize);
    // a Pakistani player is domestic in the PSL
    expect(isOverseasIn("psl", "Pakistan")).toBe(false);
    // the host sims the rest: every squad can field a side and the league's season is played
    vi.useFakeTimers();
    try {
      logic.simRemaining();
      vi.advanceTimersByTime(3500);
      expect(host.messages.some(m => m.type === "season-results")).toBe(true);
      expect(state!.teams.every(t => t.rosterCount >= 11)).toBe(true);
      // no squad holds more overseas players than the cap, so each can field an XI with its domestic players
      const cap = getLeague("psl")!.rules.maxOverseasInSquad;
      expect((logic as unknown as { teams: { internationalCount: number }[] }).teams.every(t => t.internationalCount <= cap)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("season-draft room", () => {
  it("seats are the chosen league's franchises; the draft starts after the league pool is prepared", async () => {
    const host = new MockHost();
    const room = new DraftRoomHost(host, { ...realDraftRoomDeps, aiDelayMs: 0 }, { mode: "season-draft", pickSeconds: 0 }, "Host");
    room.updateSettings({ league: "hundred-w" });
    const info = room.getRoomInfo();
    expect(info.seats.map(s => s.seatId)).toEqual(getLeague("hundred-w")!.teams.map(t => t.id));
    room.start();
    await vi.waitFor(() => expect(room.getDraft()).toBeTruthy(), { timeout: 20000 });
    const d = room.getDraft()!;
    expect(d.seats).toHaveLength(8);
    expect(d.pool.length).toBeGreaterThan(8 * 15);
    const cfg = seasonDraftConfig(multiplayerSeasonRules("hundred-w"), 1, false);
    expect(cfg.minBowlingOptions).toBe(6); // women's league
    room.destroy();
  }, 30000);
});

describe("Draft Match pools", () => {
  it("has a current-squads pool for every extra league with its overseas cap and grounds", () => {
    for (const l of EXTRA_LEAGUES) {
      const id = `league:${l.id as ExtraLeagueId}` as const;
      expect(DRAFT_MATCH_POOLS.some(p => p.id === id)).toBe(true);
      const pool = buildDraftMatchPool(id);
      expect(pool.maxOverseasInXI).toBe(l.rules.maxOverseasInXI);
      expect(pool.players.length).toBeGreaterThanOrEqual(40);
      expect(draftPoolVenues(id).length).toBeGreaterThan(0);
    }
    // IPL / WPL grounds unchanged
    expect(draftPoolVenues("ipl-current").every(v => !/-w$|^upw$/.test(v.teamId))).toBe(true);
    expect(draftPoolVenues("wpl-current").every(v => /-w$|^upw$/.test(v.teamId))).toBe(true);
  });
});
