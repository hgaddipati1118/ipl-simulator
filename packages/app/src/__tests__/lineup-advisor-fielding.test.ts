import { describe, it, expect } from "vitest";
import { Player, Team, IPL_TEAMS, type PlayerData } from "@ipl-sim/engine";
import { buildLineupReport } from "../lineup-advisor";

let n = 0;
function mk(role: PlayerData["role"], bat: number, bowl: number, f: { fielding?: number; keeping?: number; wk?: boolean } = {}): Player {
  return new Player({
    id: `la${++n}`, name: `Player ${n}`, age: 26, country: "India", role, isWicketKeeper: f.wk,
    ratings: {
      battingIQ: bat, timing: bat, power: bat, running: 60, wicketTaking: bowl, economy: bowl, accuracy: bowl, clutch: 55,
      ...(f.fielding !== undefined ? { fielding: f.fielding } : {}),
      ...(f.keeping !== undefined ? { keeping: f.keeping } : {}),
    },
    isInternational: false, injured: false, injuryGamesLeft: 0,
  });
}

function squad(fielding: number, keepers: { keeping: number; bat: number }[], level = 80): Team {
  const team = new Team(IPL_TEAMS[0]);
  for (const k of keepers) team.addPlayer(mk("batsman", k.bat, 25, { wk: true, keeping: k.keeping, fielding }), 1);
  for (let i = 0; i < 4; i++) team.addPlayer(mk("batsman", level, 25, { fielding }), 1);
  for (let i = 0; i < 2; i++) team.addPlayer(mk("all-rounder", 70, 70, { fielding }), 1);
  for (let i = 0; i < 4; i++) team.addPlayer(mk("bowler", 30, level, { fielding }), 1);
  return team;
}

function report(team: Team, xi: Player[]) {
  return buildLineupReport({
    team, availablePlayers: team.roster, selectedPlayers: xi,
    battingOrder: team.autoBattingOrder(xi), bowlingOrder: team.autoBowlingOrder(xi),
  });
}

describe("lineup advisor: fielding and keeping", () => {
  it("flags a leaky fielding XI and praises a sharp one", () => {
    const poor = squad(35, [{ keeping: 50, bat: 72 }]);
    expect(report(poor, poor.autoSelectPlayingXI()).concerns.map(c => c.title)).toContain("Leaky Fielding");
    // a modest side (no top-order / death-overs strengths to crowd the three-item list)
    const sharp = squad(65, [{ keeping: 50, bat: 60 }], 60);
    const r = report(sharp, sharp.autoSelectPlayingXI());
    expect(r.concerns.map(c => c.title)).not.toContain("Leaky Fielding");
    expect(r.strengths.map(c => c.title)).toContain("Sharp in the Field");
  });

  it("recommends the better keeper when a much worse one has the gloves", () => {
    const team = squad(48, [{ keeping: 25, bat: 74 }, { keeping: 80, bat: 72 }]);
    const [bad, good] = team.roster;
    // a hand-picked XI with the poor keeper; Auto Select would take the gloveman
    const xi = team.roster.filter(p => p !== good);
    expect(xi).toHaveLength(11);
    expect(report(team, xi).recommendations.map(r => r.title)).toContain("Keeper Choice");
    const auto = team.autoSelectPlayingXI();
    expect(auto).toContain(good);
    expect(auto).not.toContain(bad);
    expect(report(team, auto).recommendations.map(r => r.title)).not.toContain("Keeper Choice");
  });
});
