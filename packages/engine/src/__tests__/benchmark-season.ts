/**
 * Season benchmark: run full IPL seasons with the real rosters and report venue, toss/chase
 * and injury behaviour next to real IPL 2024-26 averages (Cricsheet).
 *
 * Usage: npx tsx packages/engine/src/__tests__/benchmark-season.ts [seasons=20] [--no-injuries]
 */

import {
  Team,
  IPL_TEAMS,
  runSeason,
  createPlayerFromData,
  RULE_PRESETS,
  type RuleSet,
  type Player,
  getVenueProfileForTeam,
} from "@ipl-sim/engine";
import { getRealPlayers } from "../../../ratings/src/real-players.js";

const SEASONS = Number(process.argv.find(a => /^\d+$/.test(a)) ?? 20);
const INJURIES = !process.argv.includes("--no-injuries");

/** Real IPL 2024-26 men's averages (Cricsheet ipl_json, 215 completed matches) */
const REAL = {
  firstInnings: 191.8,
  runRate: 9.7,
  wicketsFirstInnings: 6.35,
  chaseWin: 0.554,
  fieldShare: 0.8,
  tossWinnerWin: 0.521,
  byGround: {
    gt: 191.2, lsg: 183.3, csk: 173.8, mi: 194.3, kkr: 196.8, dc: 200.0,
    srh: 205.9, pbks: 186.6, rcb: 188.2, rr: 201.6,
  } as Record<string, number>,
  /** Share of IPL squad-seasons ending in a replacement (injury report, section 4) */
  replacement: { pace: 0.096, "finger spin": 0.012, "wrist spin": 0.044, medium: 0.041, batter: 0.041, wicketkeeper: 0.042, "all-rounder": 0.05 } as Record<string, number>,
};

function archetype(p: Player): string {
  if (p.isWicketKeeper) return "wicketkeeper";
  if (p.role === "batsman") return "batter";
  if (p.role === "all-rounder") return "all-rounder";
  const s = p.bowlingStyle ?? "unknown";
  if (s === "off-spin" || s === "left-arm-orthodox") return "finger spin";
  if (s === "leg-spin" || s === "left-arm-wrist-spin") return "wrist spin";
  if (s.endsWith("-medium")) return "medium";
  if (s.includes("fast")) return "pace";
  return "medium";
}

function buildTeams(rules: RuleSet): Team[] {
  const teams = IPL_TEAMS.map(c => new Team(c, rules.salaryCap));
  const byId = new Map(teams.map(t => [t.id, t]));
  for (const rp of getRealPlayers()) {
    const team = rp.teamId ? byId.get(rp.teamId) : undefined;
    if (!team) continue;
    const player = createPlayerFromData({
      name: rp.name, age: rp.age, country: rp.country, role: rp.role,
      isWicketKeeper: rp.isWicketKeeper, bowlingStyle: rp.bowlingStyle, battingHand: rp.battingHand,
      battingIQ: rp.battingIQ, timing: rp.timing, power: rp.power, running: rp.running,
      wicketTaking: rp.wicketTaking, economy: rp.economy, accuracy: rp.accuracy, clutch: rp.clutch,
      teamId: rp.teamId,
    });
    team.addPlayer(player, player.bid || 1);
  }
  return teams;
}

function main() {
  const rules: RuleSet = { ...RULE_PRESETS.modern, injuriesEnabled: INJURIES };
  const teams = buildTeams(rules);

  const byGround = new Map<string, number[]>();
  let inn1Runs = 0, inn1Wkts = 0, inn1Balls = 0, inn2Runs = 0, inn2Balls = 0, nInn = 0;
  let decided = 0, chaseWins = 0, fieldChoices = 0, tossWinnerWins = 0;
  let close = 0, closeChaseWins = 0;
  const injurySeasons = new Map<string, { squad: number; any: number; long: number; injuries: number; days: number[] }>();

  for (let s = 0; s < SEASONS; s++) {
    const power = new Map(teams.map(t => [t.id, t.powerRating]));
    const result = runSeason(teams, rules);
    const injuredBy = new Map<string, { any: boolean; long: boolean; n: number }>();
    for (const m of result.schedule) {
      const r = m.result;
      if (!r) continue;
      for (const inj of r.injuries ?? []) {
        const e = injuredBy.get(inj.playerId) ?? { any: false, long: false, n: 0 };
        e.any = true; e.n++;
        if (inj.injury.matchesRemaining >= 3) e.long = true;
        injuredBy.set(inj.playerId, e);
      }
      if (m.isPlayoff) continue;
      const [i1, i2] = r.innings;
      inn1Runs += i1.runs; inn1Wkts += i1.wickets; inn1Balls += i1.totalBalls;
      inn2Runs += i2.runs; inn2Balls += i2.totalBalls; nInn++;
      const list = byGround.get(r.homeTeamId) ?? [];
      list.push(i1.runs);
      byGround.set(r.homeTeamId, list);
      if (r.tossDecision === "bowl") fieldChoices++;
      if (r.winnerId) {
        decided++;
        const chaser = i2.teamId;
        if (r.winnerId === chaser) chaseWins++;
        if (r.winnerId === r.tossWinner) tossWinnerWins++;
        const gap = Math.abs((power.get(r.homeTeamId) ?? 0) - (power.get(r.awayTeamId) ?? 0));
        if (gap <= 2) { close++; if (r.winnerId === chaser) closeChaseWins++; }
      }
    }
    for (const t of teams) {
      for (const p of t.roster) {
        if (p.stats.matches <= 0) continue;
        const a = archetype(p);
        const e = injurySeasons.get(a) ?? { squad: 0, any: 0, long: 0, injuries: 0, days: [] };
        e.squad++;
        const inj = injuredBy.get(p.id);
        if (inj?.any) e.any++;
        if (inj?.long) e.long++;
        e.injuries += inj?.n ?? 0;
        injurySeasons.set(a, e);
      }
    }
  }

  const f1 = (x: number) => x.toFixed(1);
  const pct = (x: number) => (x * 100).toFixed(1) + "%";
  console.log(`Seasons: ${SEASONS} (${nInn} league matches), injuries ${INJURIES ? "on" : "off"}`);
  console.log(`First-innings avg: ${f1(inn1Runs / nInn)} (real ${REAL.firstInnings})`);
  console.log(`Run rate: inn1 ${(inn1Runs / inn1Balls * 6).toFixed(2)}, inn2 ${(inn2Runs / inn2Balls * 6).toFixed(2)} (real ${REAL.runRate})`);
  console.log(`Wickets per 1st innings: ${(inn1Wkts / nInn).toFixed(2)} (real ${REAL.wicketsFirstInnings})`);
  console.log(`Chase win%: all ${pct(chaseWins / decided)} (real ${pct(REAL.chaseWin)}), close sides (power gap<=2, n=${close}) ${pct(closeChaseWins / Math.max(1, close))}`);
  console.log(`Toss: field-first ${pct(fieldChoices / nInn)} (real ${pct(REAL.fieldShare)}), toss winner wins ${pct(tossWinnerWins / decided)} (real ${pct(REAL.tossWinnerWin)})`);
  console.log("First-innings avg by home ground:");
  const rows = [...byGround.entries()].map(([id, l]) => [id, l.reduce((a, b) => a + b, 0) / l.length, l.length] as const)
    .sort((a, b) => b[1] - a[1]);
  for (const [id, avg, n] of rows) {
    const name = IPL_TEAMS.find(t => t.id === id)?.stadiumName ?? id;
    console.log(`  ${id.padEnd(5)} ${name.padEnd(36)} ${f1(avg)}  (n=${n}, real ${REAL.byGround[id] ?? "?"})`);
  }
  // Does the simulated ground spread track the measured run factor one-for-one?
  const overall = inn1Runs / nInn;
  const pts = rows.map(([id, avg]) => [getVenueProfileForTeam(id)?.runMult ?? 1, avg / overall] as const);
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const slope = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / Math.max(1e-9, pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0));
  console.log(`Ground spread vs measured runFactor: slope ${slope.toFixed(2)} (1.00 = one-for-one)`);
  console.log("Injuries per squad-season (players who played):");
  for (const [a, e] of [...injurySeasons.entries()].sort()) {
    console.log(`  ${a.padEnd(13)} any ${pct(e.any / e.squad)}  3+ matches ${pct(e.long / e.squad)}  injuries/season ${(e.injuries / e.squad).toFixed(2)}  (n=${e.squad}; IPL replaced ${REAL.replacement[a] !== undefined ? pct(REAL.replacement[a]) : "?"})`);
  }
}

main();
