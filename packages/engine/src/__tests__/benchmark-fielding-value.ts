/**
 * What are fielding and keeping worth in runs? Simulate IPL matches between the ten squads (the game's own player
 * data) with the fielding side's ratings shifted, and measure the runs the opposition scores per innings (and the
 * wickets it loses, and the fielding side's win probability).
 *
 *   npx tsx packages/engine/src/__tests__/benchmark-fielding-value.ts [matches=20000]
 *
 * For each condition the same match seeds are used. The fielding team's whole squad gets `fielding + delta` (or the
 * keepers `keeping + delta`), opponents are unchanged. Output: runs conceded per innings relative to delta = 0, per
 * rating point of one fielder (the XI has 11), and as win-probability points. docs/RULES-AUCTION.md section 9 uses it.
 */
import { getRealPlayers } from "../../../ratings/src/real-players.js";
import * as E from "../index.js";

const N = Number(process.argv[2] ?? 20000);
const rules = { ...E.RULE_PRESETS.modern, injuriesEnabled: false };

function build() {
  const teams = E.IPL_TEAMS.map((c: any) => new E.Team(c, rules.salaryCap));
  for (const d of getRealPlayers()) {
    const team = teams.find((t: any) => t.id === d.teamId);
    if (team) team.addPlayer(E.createPlayerFromData({ ...d }), d.bid ?? 1);
  }
  return teams;
}

type Mode = "fielding" | "keeping" | "batting" | "bowling";
const BAT: string[] = ["battingIQ", "timing", "power", "running"];
const BOWL: string[] = ["wicketTaking", "economy", "accuracy", "clutch"];
function run(mode: Mode, delta: number) {
  const teams = build();
  const base = new Map<string, number>();
  let seed = 4242;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  let runs = 0, wkts = 0, inns = 0, wins = 0, decided = 0;
  for (let i = 0; i < N; i++) {
    const a = Math.floor(rnd() * teams.length);
    let b = Math.floor(rnd() * teams.length);
    if (b === a) b = (b + 1) % teams.length;
    // team a is the one whose ratings are shifted; apply for this match only
    const saved = teams[a].roster.map((p: any) => ({ ...p.ratings }));
    teams[a].roster.forEach((p: any) => {
      if (mode === "fielding" || mode === "keeping") {
        const v = mode === "fielding" ? E.fieldingRating(p) : E.keepingRating(p);
        if (mode === "keeping" && !p.isWicketKeeper) return;
        p.ratings[mode] = Math.max(0, Math.min(99, v + delta));
      } else {
        for (const k of mode === "batting" ? BAT : BOWL) p.ratings[k] = Math.max(1, Math.min(99, p.ratings[k] + delta));
      }
    });
    const res = E.simulateMatch(teams[a], teams[b], rules, 1000 + i, { countTowardStandings: false });
    teams[a].roster.forEach((p: any, j: number) => { p.ratings = saved[j]; });
    for (const inn of res.innings) {
      // fielding / keeping / bowling: what the opposition scores; batting: what team a scores (as a negative, so
      // that "runs" is always the opposition-minus-own swing to subtract from the baseline)
      const own = mode === "batting" ? teams[a].id : teams[b].id;
      if (inn.teamId === own) { runs += inn.runs; wkts += inn.wickets; inns++; }
    }
    if (res.winnerId) { decided++; if (res.winnerId === teams[a].id) wins++; }
  }
  return { runs: runs / inns, wkts: wkts / inns, win: wins / decided, inns };
}

console.log(`${N} matches per condition`);
const MODES = (process.env.MODES ?? "fielding,keeping,batting,bowling").split(",") as Mode[];
for (const mode of MODES) {
  const r0 = run(mode, 0);
  for (const delta of mode === "batting" || mode === "bowling" ? [-10, 10] : [-30, 30]) {
    const r = run(mode, delta);
    console.log(
      `${mode} ${delta > 0 ? "+" : ""}${delta}: runs/inns ${r.runs.toFixed(2)} (${(r.runs - r0.runs).toFixed(2)} vs base ${r0.runs.toFixed(2)}), ` +
      `opp wkts ${(r.wkts - r0.wkts).toFixed(3)}, win% ${(100 * (r.win - r0.win)).toFixed(2)} pts`);
  }
}
