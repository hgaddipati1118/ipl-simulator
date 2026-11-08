import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("peerjs", () => ({ default: class MockPeer { on() {} destroy() {} } }));
vi.mock("@ipl-sim/ratings/dist/real-players.js", () => ({ getRealPlayers: () => [], getPoolPlayers: () => [] }));
vi.mock("@ipl-sim/ratings/dist/wpl-players.js", () => ({ getWPLPlayers: () => [] }));

import { generatePlayerPool, RULE_PRESETS, IPL_TEAMS, getSquad, canFieldValidXI, createMatchState, simulateRemaining } from "@ipl-sim/engine";
import {
  DraftRoomHost, reduceDraftRoomView, EMPTY_DRAFT_ROOM_VIEW, teamsFromMatchStart,
  type DraftRoomTransport, type DraftRoomDeps, type DraftRoomView,
} from "../multiplayer/draft-room.js";
import type { HostMessage, GuestMessage } from "../multiplayer/protocol.js";
import { draftMatchRules } from "../draft-pools.js";

/**
 * In-memory network: the host transport plus N guests. Every broadcast is delivered to every
 * connected guest; each guest keeps its own reduced view, like the real UI does.
 */
class FakeHub implements DraftRoomTransport {
  roomCode = "DRAFT1";
  onMessage: (peerId: string, data: unknown) => void = () => {};
  onConnection: (peerId: string) => void = () => {};
  onDisconnect: (peerId: string) => void = () => {};
  guests = new Map<string, { view: DraftRoomView; connected: boolean; inbox: HostMessage[] }>();

  broadcast(data: unknown) {
    const msg = JSON.parse(JSON.stringify(data)) as HostMessage; // like the wire
    for (const g of this.guests.values()) if (g.connected) { g.inbox.push(msg); g.view = reduceDraftRoomView(g.view, msg); }
  }
  sendTo(peerId: string, data: unknown) {
    const g = this.guests.get(peerId);
    if (!g?.connected) return;
    const msg = JSON.parse(JSON.stringify(data)) as HostMessage;
    g.inbox.push(msg);
    g.view = reduceDraftRoomView(g.view, msg);
  }
  destroy() {}

  connect(peerId: string, name: string) {
    this.guests.set(peerId, { view: EMPTY_DRAFT_ROOM_VIEW, connected: true, inbox: [] });
    this.onConnection(peerId);
    this.send(peerId, { type: "join", name });
  }
  send(peerId: string, msg: GuestMessage) { this.onMessage(peerId, msg); }
  drop(peerId: string) { const g = this.guests.get(peerId)!; g.connected = false; this.onDisconnect(peerId); }
  view(peerId: string) { return this.guests.get(peerId)!.view; }
}

function testDeps(): DraftRoomDeps {
  return {
    aiDelayMs: 10,
    tickMs: 1000,
    random: (() => { let s = 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })(),
    buildSeasonPool: () => {
      const rules = { ...RULE_PRESETS.modern2026, teamIds: RULE_PRESETS.modern2026.teamIds };
      return { teams: IPL_TEAMS, players: generatePlayerPool(320), rules };
    },
    buildMatchPool: () => ({ players: generatePlayerPool(70), maxOverseasInXI: 4, label: "Test pool" }),
  };
}

/** Each guest picks the first legal player in their own pool view whenever it's their turn. */
function guestsPlay(hub: FakeHub, host: DraftRoomHost, rounds = 400) {
  for (let i = 0; i < rounds; i++) {
    const d = host.getDraft();
    if (!d || d.status === "complete") return;
    const seatId = d.order[d.picks.length];
    const seat = d.seats.find(s => s.id === seatId);
    if (seat?.controller === "human" && seat.ownerId && hub.guests.get(seat.ownerId)?.connected) {
      const v = hub.view(seat.ownerId);
      const legal = v.draft?.pool.find(p => !v.draft!.taken[p.id] && (p.role === "bowler" || p.isWicketKeeper || i % 3 === 0));
      if (legal) hub.send(seat.ownerId, { type: "draft-pick", playerId: legal.id });
      // If the engine refused it (rules), fall back to an auto pick by letting the clock run out
      if (host.getDraft()!.picks.length === d.picks.length) vi.advanceTimersByTime(31_000);
    } else {
      vi.advanceTimersByTime(20);
    }
  }
}

describe("draft room: Draft Match with 3+ peers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("2 humans draft head-to-head; a spectator sees every pick live; result + best-of-3 rematch", () => {
    const hub = new FakeHub();
    const host = new DraftRoomHost(hub, testDeps(), { mode: "draft-match", sides: 2, pickSeconds: 30 }, "Hosty");
    hub.connect("p1", "Asha");
    hub.connect("p2", "Ben");
    hub.connect("p3", "Spectator Sam");
    hub.send("p1", { type: "draft-claim-seat", seatId: "side-1" });
    hub.send("p2", { type: "draft-claim-seat", seatId: "side-2" });
    // Ben can't steal Asha's seat
    hub.send("p2", { type: "draft-claim-seat", seatId: "side-1" });
    expect(hub.view("p3").room!.seats.map(s => s.ownerName)).toEqual(["Asha", "Ben"]);

    host.start();
    expect(hub.view("p3").draft?.status).toBe("in-progress");
    expect(hub.view("p3").pool.length).toBeGreaterThanOrEqual(70); // topped up if a random pool lacks keepers

    // A pick out of turn is rejected
    const d0 = host.getDraft()!;
    const wrong = d0.order[0] === "side-1" ? "p2" : "p1";
    hub.send(wrong, { type: "draft-pick", playerId: d0.pool[0].id });
    expect(host.getDraft()!.picks).toHaveLength(0);
    expect(hub.guests.get(wrong)!.inbox.some(m => m.type === "error")).toBe(true);

    guestsPlay(hub, host);
    const done = host.getDraft()!;
    expect(done.status).toBe("complete");
    expect(done.picks).toHaveLength(22);
    // Spectator's live board matches the host's exactly
    expect(hub.view("p3").draft!.picks.map(p => p.playerId)).toEqual(done.picks.map(p => p.playerId));
    expect(hub.view("p3").feed.length).toBe(22);
    for (const seatId of ["side-1", "side-2"]) {
      expect(canFieldValidXI(getSquad(done, seatId), { minWicketKeepers: 1, minBowlingOptions: 5, maxOverseasInXI: 4 })).toBe(true);
    }

    // Lineups → match
    expect(hub.view("p1").room!.phase).toBe("lineups");
    const squad1 = done.squads["side-1"];
    hub.send("p1", { type: "draft-lineup", battingOrder: [...squad1].reverse(), captainId: squad1[3] });
    expect(hub.view("p3").matchStart).toBeNull();
    const squad2 = done.squads["side-2"];
    hub.send("p2", { type: "draft-lineup", battingOrder: squad2, captainId: squad2[0] });
    const start = hub.view("p3").matchStart!;
    expect(start).toBeTruthy();
    expect(start.sides.find(s => s.seatId === "side-1")!.battingOrder).toEqual([...squad1].reverse());
    const result = hub.view("p1").matchResult!;
    expect(result.summary.innings1.totalRuns).toBeGreaterThan(0);
    expect(result.shareText).toContain("Draft Match");
    expect(result.series!.game).toBe(1);

    // Every peer replays the same seeded match locally and reaches the official result
    const [home, away] = teamsFromMatchStart(start);
    const rules = draftMatchRules(start.maxOverseasInXI);
    const replay = simulateRemaining(createMatchState(home, away, rules, null, start.seed)).state;
    expect(replay.winnerId ?? null).toBe(result.summary.winnerSideId);

    // Rematch: loser picks first
    const loser = result.series!.nextFirstSeatId!;
    hub.send("p2", { type: "draft-rematch" });
    expect(host.getDraft()!.picks).toHaveLength(0);
    expect(host.getDraft()!.order[0]).toBe(loser);
    expect(hub.view("p3").matchResult).toBeNull(); // new game clears the old result
  });

  it("3 humans + 1 CPU: mini round-robin; a dropped player is auto-drafted and can rejoin", { timeout: 60000 }, () => {
    const hub = new FakeHub();
    const host = new DraftRoomHost(hub, testDeps(), { mode: "draft-match", sides: 4, pickSeconds: 30 });
    hub.connect("a", "A"); hub.connect("b", "B"); hub.connect("c", "C");
    hub.send("a", { type: "draft-claim-seat", seatId: "side-1" });
    hub.send("b", { type: "draft-claim-seat", seatId: "side-2" });
    hub.send("c", { type: "draft-claim-seat", seatId: "side-3" });
    host.start();

    // C disconnects mid-draft → their seat keeps auto-drafting
    guestsPlay(hub, host, 6);
    hub.drop("c");
    expect(host.getRoomInfo().members.find(m => m.name === "C")!.connected).toBe(false);
    guestsPlay(hub, host, 30);
    const mid = host.getDraft()!;
    expect(mid.squads["side-3"].length).toBeGreaterThan(2);

    // C rejoins with a new peer id and gets the seat + full board back
    hub.guests.set("c2", { view: EMPTY_DRAFT_ROOM_VIEW, connected: true, inbox: [] });
    hub.send("c2", { type: "join", name: "C" });
    expect(host.getRoomInfo().seats.find(s => s.seatId === "side-3")!.ownerPeerId).toBe("c2");
    expect(hub.view("c2").draft!.picks.length).toBe(host.getDraft()!.picks.length);

    guestsPlay(hub, host);
    expect(host.getDraft()!.status).toBe("complete");
    // Humans submit lineups (CPU side is automatic)
    for (const [peer, seat] of [["a", "side-1"], ["b", "side-2"], ["c2", "side-3"]] as const) {
      const sq = host.getDraft()!.squads[seat];
      hub.send(peer, { type: "draft-lineup", battingOrder: sq, captainId: sq[0] });
    }
    const rr = hub.view("a").roundRobin!;
    expect(rr.results).toHaveLength(6); // 4 sides → 6 matches
    expect(rr.table.reduce((s, r) => s + r.played, 0)).toBe(12);
    expect(hub.view("b").roundRobin!.table).toEqual(rr.table);
  });

  it("host can kick a member and swap a seat to AI", () => {
    const hub = new FakeHub();
    const host = new DraftRoomHost(hub, testDeps(), { mode: "draft-match", sides: 2 });
    hub.connect("x", "X"); hub.connect("y", "Y"); hub.connect("z", "Z");
    hub.send("x", { type: "draft-claim-seat", seatId: "side-1" });
    hub.send("y", { type: "draft-claim-seat", seatId: "side-2" });
    host.kick("x");
    expect(hub.guests.get("x")!.inbox.some(m => m.type === "draft-kicked")).toBe(true);
    expect(host.getRoomInfo().seats[0].controller).toBe("ai");
    hub.send("x", { type: "draft-claim-seat", seatId: "side-1" }); // ignored after kick
    expect(host.getRoomInfo().seats[0].controller).toBe("ai");
    host.setSeatAI("side-2");
    expect(host.getRoomInfo().seats[1].controller).toBe("ai");
    expect(host.getRoomInfo().members.find(m => m.name === "Y")!.seatId).toBeNull(); // now spectating
  });
});

describe("draft room: season draft with humans and AI", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("3 humans + 7 AI teams draft full squads, clock auto-picks from the queue, then the season runs", () => {
    const hub = new FakeHub();
    const host = new DraftRoomHost(hub, testDeps(), { mode: "season-draft", league: "ipl", pickSeconds: 5, order: "listed" });
    hub.connect("h1", "One"); hub.connect("h2", "Two"); hub.connect("h3", "Three"); hub.connect("s1", "Watcher");
    hub.send("h1", { type: "draft-claim-seat", seatId: "csk" });
    hub.send("h2", { type: "draft-claim-seat", seatId: "mi" });
    hub.send("h3", { type: "draft-claim-seat", seatId: "rcb" });
    host.start();
    const d = host.getDraft()!;
    expect(d.seats.filter(s => s.controller === "human").map(s => s.id).sort()).toEqual(["csk", "mi", "rcb"]);

    // h3 queues a player and then lets their clock run out every time
    const pool = hub.view("h3").pool;
    // The last keeper in pool order: the scripted humans take the first matching players
    const want = [...pool].reverse().find(p => p.isWicketKeeper)!.id;
    hub.send("h3", { type: "draft-queue", playerIds: [want] });

    let guard = 3000;
    while (host.getDraft()!.status !== "complete" && guard-- > 0) {
      const cur = host.getDraft()!;
      const seatId = cur.order[cur.picks.length];
      if (seatId === "csk" || seatId === "mi") {
        const peer = seatId === "csk" ? "h1" : "h2";
        const v = hub.view(peer).draft!;
        const pick = v.pool.find(p => !v.taken[p.id] && (p.isWicketKeeper || p.role !== "batsman"))!;
        hub.send(peer, { type: "draft-pick", playerId: pick.id });
        if (host.getDraft()!.picks.length === cur.picks.length) vi.advanceTimersByTime(6000);
      } else {
        vi.advanceTimersByTime(seatId === "rcb" ? 1000 : 20);
      }
    }
    const done = host.getDraft()!;
    expect(done.status).toBe("complete");
    expect(done.squads.rcb).toContain(want);
    expect(done.picks.filter(p => p.seatId === "rcb").every(p => p.auto)).toBe(true);
    for (const seat of done.seats) {
      expect(done.squads[seat.id]).toHaveLength(done.config.rounds);
      expect(canFieldValidXI(getSquad(done, seat.id), { minWicketKeepers: 1, minBowlingOptions: 5, maxOverseasInXI: 4 })).toBe(true);
    }
    // Everyone (spectator too) got the squads and the season table
    const v = hub.view("s1");
    expect(v.seasonSquads).toHaveLength(10);
    expect(v.seasonResults!.standings).toHaveLength(10);
    expect(v.room!.phase).toBe("results");
  });

  it("pause stops the clock and AI; host undo removes the last pick", () => {
    const hub = new FakeHub();
    const host = new DraftRoomHost(hub, testDeps(), { mode: "season-draft", pickSeconds: 5, order: "listed" });
    host.start();
    vi.advanceTimersByTime(100);
    const n = host.getDraft()!.picks.length;
    expect(n).toBeGreaterThan(0);
    host.pause();
    vi.advanceTimersByTime(5000);
    expect(host.getDraft()!.picks.length).toBe(n);
    host.undo();
    expect(host.getDraft()!.picks.length).toBe(n - 1);
    host.resume();
    vi.advanceTimersByTime(100);
    expect(host.getDraft()!.picks.length).toBeGreaterThanOrEqual(n);
    host.destroy();
  });
});

describe("Draft Match playing side", () => {
  it("a match with a user-controlled side always simulates to the end (DRS and other decisions auto-resolve)", { timeout: 60000 }, () => {
    for (let k = 0; k < 25; k++) {
      const hub = new FakeHub();
      const deps = testDeps();
      const host = new DraftRoomHost(hub, { ...deps, aiDelayMs: 0 }, { mode: "draft-match", sides: 2, pickSeconds: 0 });
      host.start();
      host.simRemaining();
      const d = host.getDraft()!;
      const start = {
        gameNo: 1, seed: 900 + k, venueTeamId: "csk", maxOverseasInXI: 4,
        sides: d.seats.map(s => ({
          seatId: s.id, name: s.name, shortName: s.id,
          players: getSquad(d, s.id).map(p => (host as unknown as { players: Map<string, { toJSON(): unknown }> }).players.get(p.id)!.toJSON()),
          battingOrder: d.squads[s.id], captainId: d.squads[s.id][0],
        })),
      } as unknown as Parameters<typeof teamsFromMatchStart>[0];
      const userSide = d.seats[k % 2].id;
      const [home, away] = teamsFromMatchStart(start, userSide);
      const done = simulateRemaining(createMatchState(home, away, draftMatchRules(4), userSide, start.seed)).state;
      expect(done.status).toBe("completed");
      host.destroy();
    }
  });
});
