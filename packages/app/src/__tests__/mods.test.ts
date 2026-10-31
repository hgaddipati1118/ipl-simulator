import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("peerjs", () => ({ default: class MockPeer { on() {} destroy() {} } }));
vi.mock("@ipl-sim/ratings/dist/real-players.js", () => ({ getRealPlayers: () => [], getPoolPlayers: () => [] }));
vi.mock("@ipl-sim/ratings/dist/wpl-players.js", () => ({ getWPLPlayers: () => [] }));

import { Player, Team, IPL_TEAMS, RULE_PRESETS, getEngineHooks, setEngineHooks, type RuleSet } from "@ipl-sim/engine";
import { HostGameLogic } from "../multiplayer/host-logic.js";
import type { HostMessage } from "../multiplayer/protocol.js";
import { modRuntime, themeToCss } from "../mods/registry.js";
import { applyPendingMods, describeSaveModMismatch, pendingDataMods } from "../mods/apply.js";
import { frameDocument, isSafeRoute, buildSnapshot } from "../mods/snapshot.js";
import type { GameState } from "../game-state.js";

class MockHost {
  roomCode = "TEST01";
  messages: HostMessage[] = [];
  onMessage: (peerId: string, data: unknown) => void = () => {};
  onConnection: (peerId: string) => void = () => {};
  onDisconnect: (peerId: string) => void = () => {};
  broadcast(data: unknown) { this.messages.push(data as HostMessage); }
  sendTo(_p: string, data: unknown) { this.messages.push(data as HostMessage); }
  destroy() {}
}

const RULES: RuleSet = { ...RULE_PRESETS.modern, teamIds: ["csk", "mi", "rcb"], playerSource: "generated" };

function lobby(hostMods: string[]) {
  const host = new MockHost();
  const logic = new HostGameLogic(host as never, RULES, () => hostMods);
  return { host, logic, join: (peer: string, name: string, mods?: string[]) => host.onMessage(peer, { type: "join", name, ...(mods ? { mods } : {}) }) };
}

describe("multiplayer lobby and engine mods", () => {
  afterEach(() => vi.useRealTimers());

  it("starts when nobody has mods", () => {
    vi.useFakeTimers();
    const { logic, join } = lobby([]);
    join("p1", "Bob");
    expect(logic.modMismatches()).toEqual([]);
    expect(logic.startAuction()).toEqual({ ok: true });
    logic.destroy();
  });

  it("starts when hashes and order match", () => {
    vi.useFakeTimers();
    const { logic, join } = lobby(["spin@aaa", "fmt@bbb"]);
    join("p1", "Bob", ["spin@aaa", "fmt@bbb"]);
    expect(logic.startAuction().ok).toBe(true);
    logic.destroy();
  });

  it("refuses to start when a guest's mod hash differs, and says who and why", () => {
    const { host, logic, join } = lobby(["spin@aaa"]);
    join("p1", "Bob", ["spin@zzz"]);
    const result = logic.startAuction();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Bob/);
    expect(result.error).toMatch(/different versions of: spin/);
    expect(logic.getAuctionState().phase).toBe("lobby");
    expect(host.messages.some(m => m.type === "error")).toBe(true);
    const lobbyMsg = [...host.messages].reverse().find(m => m.type === "lobby-state") as Extract<HostMessage, { type: "lobby-state" }>;
    expect(lobbyMsg.players.find(p => p.name === "Bob")?.modsNote).toMatch(/different versions/);
    expect(lobbyMsg.modFingerprint).toEqual(["spin@aaa"]);
    logic.destroy();
  });

  it("refuses when a guest is missing a mod, has an extra one, or an old client sends nothing", () => {
    for (const [host, guest] of [[["a@1"], []], [[], ["a@1"]], [["a@1"], undefined], [["a@1", "b@2"], ["b@2", "a@1"]]] as const) {
      const { logic, join } = lobby([...host]);
      join("p1", "Bob", guest ? [...guest] : undefined);
      expect(logic.startAuction().ok, `${host} vs ${guest}`).toBe(false);
      logic.destroy();
    }
  });

  it("allows the start again once the guest leaves", () => {
    vi.useFakeTimers();
    const { host, logic, join } = lobby(["a@1"]);
    join("p1", "Bob", []);
    expect(logic.startAuction().ok).toBe(false);
    host.onDisconnect("p1");
    expect(logic.startAuction().ok).toBe(true);
    logic.destroy();
  });
});

// ── Applying data/rules mods ───────────────────────────────────────────

function makeState(): GameState {
  const csk = new Team({ ...IPL_TEAMS.find(t => t.id === "csk")! }, 120);
  const mi = new Team({ ...IPL_TEAMS.find(t => t.id === "mi")! }, 120);
  const mk = (id: string, power = 60) => new Player({
    id, name: id, age: 28, country: "India", role: "batsman", isInternational: false, injured: false, injuryGamesLeft: 0,
    ratings: { battingIQ: 60, timing: 60, power, running: 60, wicketTaking: 20, economy: 20, accuracy: 20, clutch: 50 },
  });
  csk.addPlayer(mk("c1"), 5);
  csk.addPlayer(mk("c2"), 5);
  mi.addPlayer(mk("m1"), 5);
  return {
    phase: "results", rules: { ...RULE_PRESETS.modern, teamIds: ["csk", "mi"], playoffTeams: 1 }, teams: [csk, mi], userTeamId: "csk",
    playerPool: [mk("free1")], seasonNumber: 1,
  } as unknown as GameState;
}

function addDataMod(id: string, definition: object, hooks: string[], hash = `h-${id}`) {
  modRuntime.add({ manifest: { id, name: id, version: "1.0.0", sdk: "1", hooks: hooks as never }, definition, hash });
}

describe("applying data and rules mods to a game", () => {
  beforeEach(() => { for (const m of modRuntime.list()) modRuntime.remove(m.id); });

  it("does nothing without mods", () => {
    const s = makeState();
    expect(applyPendingMods(s)).toBe(s);
  });

  it("applies players, teams and rules once per mod version", () => {
    addDataMod("boost", {
      data: {
        players: (ps: { id: string; ratings: { power: number } }[]) => ps.map(p => p.id === "c1" ? { ...p, ratings: { ...p.ratings, power: p.ratings.power + 10 } } : p),
        teams: (ts: { id: string; name: string }[]) => ts.map(t => t.id === "mi" ? { ...t, name: "Mumbai Mods" } : t),
      },
      rules: (r: RuleSet) => ({ ...r, scoringMultiplier: 1.2 }),
    }, ["data.players", "data.teams", "rules"]);

    const s = makeState();
    expect(pendingDataMods(s)).toEqual(["boost"]);
    const once = applyPendingMods(s);
    expect(once.teams.find(t => t.id === "csk")!.roster.find(p => p.id === "c1")!.ratings.power).toBe(70);
    expect(once.teams.find(t => t.id === "mi")!.name).toBe("Mumbai Mods");
    expect(once.rules.scoringMultiplier).toBe(1.2);
    expect(once.modsApplied).toEqual(["boost@h-boost"]);

    // Applying again (a reload) must not compound the +10
    const twice = applyPendingMods(once);
    expect(twice).toBe(once);
    expect(twice.teams.find(t => t.id === "csk")!.roster.find(p => p.id === "c1")!.ratings.power).toBe(70);

    // A new version of the mod applies again; the old hash is not remembered as new
    addDataMod("boost", { rules: (r: RuleSet) => ({ ...r, impactPlayer: false }) }, ["rules"], "h2");
    const third = applyPendingMods(once);
    expect(third.rules.impactPlayer).toBe(false);
    expect(third.modsApplied).toEqual(["boost@h-boost", "boost@h2"]);
  });

  it("moves players between squads and drops unknown ids", () => {
    addDataMod("swap", {
      data: { teams: (ts: { id: string; squad?: string[] }[]) => ts.map(t => t.id === "mi" ? { ...t, squad: ["m1", "c2", "ghost"] } : t) },
    }, ["data.teams"]);
    const out = applyPendingMods(makeState());
    const ids = (id: string) => out.teams.find(t => t.id === id)!.roster.map(p => p.id);
    expect(ids("mi")).toEqual(["m1", "c2"]);
    expect(ids("csk")).toEqual(["c1"]);
  });

  it("leaves a season in progress alone until it ends", () => {
    addDataMod("r", { rules: (r: RuleSet) => ({ ...r, scoringMultiplier: 1.3 }) }, ["rules"]);
    const s = { ...makeState(), phase: "season" as const };
    expect(applyPendingMods(s)).toBe(s);
    expect(pendingDataMods(s)).toEqual(["r"]);
  });

  it("ignores a teams result that removes the user's team, and a rules result with bad values", () => {
    addDataMod("evil", {
      data: { teams: (ts: { id: string }[]) => ts.filter(t => t.id !== "csk").concat([{ id: "x1" }, { id: "x2" }] as never) },
      rules: (r: RuleSet) => ({ ...r, salaryCap: -1 }),
    }, ["data.teams", "rules"]);
    const out = applyPendingMods(makeState());
    expect(out.teams.map(t => t.id)).toEqual(["csk", "mi"]);
    expect(out.rules.salaryCap).toBe(120);
    expect(modRuntime.list()[0].strikes).toBeGreaterThan(0);
  });

  it("describes saves played with engine mods that are gone or changed", () => {
    const saved = [
      { id: "a", hash: "1", engine: true }, { id: "b", hash: "1", engine: true },
      { id: "c", hash: "1", engine: true }, { id: "theme", hash: "9", engine: false },
    ];
    const now = [{ id: "a", hash: "1", engine: true }, { id: "b", hash: "2", engine: true }];
    expect(describeSaveModMismatch(saved, now)).toEqual(["b (different version)", "c (not enabled)"]);
    expect(describeSaveModMismatch(undefined, now)).toEqual([]);
  });
});

describe("registry glue", () => {
  beforeEach(() => { for (const m of modRuntime.list()) modRuntime.remove(m.id); });

  it("builds theme CSS for both modes and the font variable", () => {
    const css = themeToCss({ variables: { "--th-accent": "#f00" }, light: { "--th-body": "#fff" }, dark: { "--th-body": "#000" }, fonts: { body: "Georgia, serif" } });
    expect(css).toContain(":root,.dark{--th-accent:#f00}");
    expect(css).toContain(":root:not(.dark){--th-body:#fff}");
    expect(css).toContain(".dark{--th-body:#000}");
    expect(css).toContain(":root{--mod-font-body:Georgia, serif}");
    expect(themeToCss({})).toBe("");
  });

  it("keeps the engine registry null-safe when no sim mods are installed", () => {
    setEngineHooks(null);
    expect(getEngineHooks()).toBeNull();
  });
});

describe("sandboxed frame helpers", () => {
  it("prefixes a CSP that blocks network access and keeps the mod markup", () => {
    const doc = frameDocument("<!doctype html><html><body>hi</body></html>");
    expect(doc.startsWith("<!DOCTYPE html><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(doc).toContain("default-src 'none'");
    expect(doc).not.toContain("connect-src");
    expect(doc).toContain("<body>hi</body>");
    expect(doc.match(/doctype/gi)).toHaveLength(1);
  });

  it("only lets mods navigate to in-app paths", () => {
    for (const ok of ["/", "/season", "/team/csk", "/mods/screen/a/b"]) expect(isSafeRoute(ok)).toBe(true);
    for (const bad of ["//evil.com", "https://evil.com", "javascript:alert(1)", "/a?b=c", "/a#b", 5, null, "/" + "x".repeat(300)]) expect(isSafeRoute(bad)).toBe(false);
  });

  it("snapshots plain data only", () => {
    const snap = buildSnapshot(makeState());
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    expect(snap.teams.map(t => t.id)).toEqual(["csk", "mi"]);
    expect(buildSnapshot(null).teams).toEqual([]);
  });
});
