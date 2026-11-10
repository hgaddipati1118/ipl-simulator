/**
 * Test cricket benchmark: seeded simulations of Tests between the national squads (fixtures drawn in the real proportions of
 * hosts and opponents since 2015) against real men's Tests since 2015 and since 2023 (TEST_MODEL.real, Cricsheet).
 *
 *   npx tsx packages/engine/src/__tests__/benchmark-test.ts [tests=3000]
 *   GENDER=female ...   the women's squads against real women's Tests
 *   MD=1 ...            print the table as markdown (docs/FORMATS.md, Test section)
 *   RATINGS=t20 ...     leave the Test ratings off: every player plays on his T20 ratings (the fallback)
 *   BAZBALL=0 ...       England bat without the fitted Bazball factor (on by default: the squads are 2023+ England)
 *
 * The engine plays the modern era (base rates of men's Tests from 2023), so the first real column is 2023+ (and 2022+ for the
 * pooled 4th-innings chases, the bands being small); 2015+ is shown alongside.
 *
 * Squads: the fixture's members from the shipped pools with format-ratings.json attached (test-pool-squads.ts).
 *
 * docs/FORMATS.md, Test section 6 has the numbers.
 */
import { simulateTestMatch, type TestMatchState } from "../test-match.js";
import { TEST_MODEL } from "../test-model-data.js";
import { TEST_SQUADS } from "./test-squads.js";
import { poolTestTeam, HAS_FORMAT_RATINGS } from "./test-pool-squads.js";

const N = Number(process.argv[2] ?? 3000);
const gender = (process.env.GENDER === "female" ? "female" : "male") as "male" | "female";
// first column: the era the engine plays (2023+); second: all men's Tests since 2015
const real = gender === "female" ? TEST_MODEL.real.female : TEST_MODEL.real.male2023;
const recent = gender === "female" ? undefined : TEST_MODEL.real.male;
const bazball = gender === "male" && process.env.BAZBALL !== "0";
const squads = TEST_SQUADS.filter(s => s.gender === gender);
const t20Only = process.env.RATINGS === "t20" || !HAS_FORMAT_RATINGS;
const built = squads.map(s => ({ s, ...poolTestTeam(s.team, gender, { t20Only }) }));
const missing = built.flatMap(b => b.missing.map(n => `${n} (${b.s.team})`));
const teams = new Map(built.map(b => [b.s.team, b.team]));
const withTest = built.reduce((a, b) => a + b.team.roster.filter(p => p.formatRatings?.test).length, 0);
const rosterSize = built.reduce((a, b) => a + b.team.roster.length, 0);
const country = new Map(squads.map(s => [s.team, s.country]));

// fixtures: host by the real number of home Tests, opponent by the real number of Tests played
const hostW = squads.map(s => (gender === "male" ? (TEST_MODEL.real.male.hostTests as Record<string, number>)[s.team] ?? 3 : 1));
const oppW = squads.map(s => (gender === "male" ? (TEST_MODEL.real.male.teamTests as Record<string, number>)[s.team] ?? 5 : 1));
let seed = 20261107;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const pick = (w: number[], not = -1) => {
  const tot = w.reduce((a, b, i) => a + (i === not ? 0 : b), 0);
  let x = rnd() * tot;
  for (let i = 0; i < w.length; i++) { if (i === not) continue; x -= w[i]; if (x <= 0) return i; }
  return w.length - 1 === not ? 0 : w.length - 1;
};

const sum: Record<string, number> = {};
const add = (k: string, v = 1) => { sum[k] = (sum[k] ?? 0) + v; };
const strong = new Set<string>(gender === "male" ? TEST_MODEL.real.male.strongVsWeak.strong : []);
const weak = new Set<string>(gender === "male" ? TEST_MODEL.real.male.strongVsWeak.weak : []);
const CH = [0, 150, 200, 250, 300, 350];
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const h = pick(hostW);
  const a = pick(oppW, h);
  const home = teams.get(squads[h].team)!, away = teams.get(squads[a].team)!;
  const eng = [home, away].find(t => t.name === "England");
  const res = simulateTestMatch(home, away, { seed: 5000 + i, country: country.get(squads[h].team), ...(bazball && eng ? { bazballTeamId: eng.id } : {}) });
  const st: TestMatchState = res.state;
  add("tests");
  const r = res.result;
  for (const t of [home, away]) { add(`team_${t.name}`); if (r.winnerId === t.id) add(`teamWin_${t.name}`); }
  if (r.kind === "draw") add("draw"); else if (r.kind === "tie") add("tie"); else if (r.winnerId === home.id) add("home"); else add("away");
  add("days", r.day);
  if (r.day <= 3) add("d3"); else if (r.day === 4) add("d4"); else add("d5");
  const daysUsed = r.day - 1 + (r.kind === "draw" ? 1 : 0.5);
  add("daysUsed", daysUsed);
  for (const inn of st.innings) {
    add(`inn${inn.number}`); add(`inn${inn.number}runs`, inn.runs); add(`inn${inn.number}wkts`, inn.wickets); add(`inn${inn.number}balls`, inn.legalBalls);
    add("runs", inn.runs); add("balls", inn.legalBalls); add("wkts", inn.wickets);
    if (inn.closed === "declared") add(`dec${inn.number}`);
    if (inn.followOn) add("followOn");
    for (const b of Object.values(inn.batters)) {
      if (b.runs >= 100) add("c100");
      if (b.runs >= 50) add("c50");
      const g = b.arrived <= 3 ? "p13" : b.arrived <= 6 ? "p46" : "p711";
      add(`${g}_runs`, b.runs); add(`${g}_balls`, b.balls); if (b.out && b.kind !== "run_out") add(`${g}_out`); if (b.out && b.kind === "run_out") add(`${g}_ro`);
    }
    for (const l of Object.values(inn.bowlers)) if (l.wickets >= 5) add("f5");
    if (Object.values(inn.bowlers).some(l => l.wickets >= 5)) add(`i5_${inn.number}`);
    if (inn.legalBalls >= 300) {
      const ranked = Object.values(inn.bowlers).sort((a, b) => b.balls - a.balls);
      const w = ranked.reduce((a, l) => a + l.wickets, 0);
      add("rankInns"); add("bowlersUsed", ranked.length);
      // by rank, over the innings that have a bowler of that rank (the real shares are taken the same way)
      ranked.slice(0, 6).forEach((l, k) => { add(`rankN${k}`); add(`rankOv${k}`, l.balls / inn.legalBalls); add(`rankW${k}`, l.wickets); add(`rankWt${k}`, w); });
    }
    for (const ev of inn.ballLog) {
      if (ev.outcome !== "wide" && ev.outcome !== "noball") { const d = Math.min(5, ev.day); add(`b_day${d}`); if (st.players[ev.bowler].spin) add(`bs_day${d}`); }
      if (ev.isWicket && ev.wicketType && ev.wicketType !== "run_out") {
        const d = Math.min(5, ev.day);
        add(`w_day${d}`); if (st.players[ev.bowler].spin) add(`spin_day${d}`);
      }
      if (ev.review) add("reviews");
    }
    if (inn.number === 4) {
      const target = st.innings.filter(x => x.battingTeamId !== inn.battingTeamId).reduce((s, x) => s + x.runs, 0)
        - st.innings.filter(x => x.battingTeamId === inn.battingTeamId && x.number < 4).reduce((s, x) => s + x.runs, 0) + 1;
      const b = CH.filter(lo => target >= lo).length - 1;
      add(`ch${b}`);
      add(`ch${b}_${r.kind === "draw" || r.kind === "tie" ? "draw" : r.winnerId === inn.battingTeamId ? "win" : "loss"}`);
    }
  }
  if (r.margin.startsWith("an innings")) add("innWin");
  add("nightwatchmen", st.events.filter(e => e.kind === "nightwatchman").length);
  if (st.innings.length >= 2) {
    const lead = st.innings[0].runs - st.innings[1].runs;
    if (lead >= (st.days >= 5 ? 200 : 150) && st.innings[1].wickets >= 10) add("foAvail");
  }
  const hs = strong.has(squads[h].team), as = strong.has(squads[a].team), hw = weak.has(squads[h].team), aw = weak.has(squads[a].team);
  if ((hs && aw) || (as && hw)) {
    add("svw");
    const sId = hs ? home.id : away.id;
    if (r.kind === "draw") add("svw_draw"); else if (r.winnerId === sId) add("svw_strong"); else if (r.winnerId) add("svw_weak");
  }
}
const ms = (Date.now() - t0) / N;
const n = sum.tests;
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);
const rows: [string, string, string, string][] = [];
const row = (label: string, sim: string, r1: string | number | undefined, r2?: string | number) => rows.push([label, sim, String(r1 ?? "-"), String(r2 ?? "-")]);
/** The real targets (TEST_MODEL.real.*), read loosely: the women's have fewer fields */
interface Chase { n: number; win: number; draw: number; loss: number }
interface RealTargets {
  tests: number;
  innings: Record<number, { n: number; runs: number; wickets: number; overs: number }>;
  runsPerOver: number; ballsPerWicket: number; oversPerTest: number; oversPerDayUsed: number;
  results: { home: number; away: number; neutral: number; draw: number; tie: number };
  days: { mean: number; upTo3: number; four: number; five: number };
  followOnsPerTest: number; followOnEnforcedShare: number; declarationsPerTest: Record<number, number>;
  chases: Record<string, Chase>; inningsWins: number; centuriesPerTest: number; fiftiesPlusPerTest: number; fiveForsPerTest: number;
  spinWicketShareByDay: number[]; spinOverShareByDay: number[]; oversShareByRank: number[]; wicketShareByRank: number[];
}
const R = real as unknown as RealTargets, R2 = recent as unknown as RealTargets | undefined;
for (const i of [1, 2, 3, 4]) {
  const c = sum[`inn${i}`] ?? 0;
  row(`innings ${i}: runs / wickets / overs`, `${f1(sum[`inn${i}runs`] / c)} / ${f2(sum[`inn${i}wkts`] / c)} / ${f1(sum[`inn${i}balls`] / 6 / c)}`,
    `${R.innings[i].runs} / ${R.innings[i].wickets} / ${R.innings[i].overs}`, R2 ? `${R2.innings[i].runs} / ${R2.innings[i].wickets} / ${R2.innings[i].overs}` : undefined);
}
row("innings 4 played", pct((sum.inn4 ?? 0) / n), pct(R.innings[4].n / R.tests), R2 ? pct(R2.innings[4].n / R2.tests) : undefined);
row("runs per over", f2((6 * sum.runs) / sum.balls), R.runsPerOver.toFixed(2), R2?.runsPerOver.toFixed(2));
row("balls per wicket", f1(sum.balls / sum.wkts), R.ballsPerWicket, R2?.ballsPerWicket);
row("overs per Test", f1(sum.balls / 6 / n), R.oversPerTest, R2?.oversPerTest);
row("overs per day used", f1(sum.balls / 6 / sum.daysUsed), R.oversPerDayUsed, R2?.oversPerDayUsed);
row("home win / away win / draw", `${pct((sum.home ?? 0) / n)} / ${pct((sum.away ?? 0) / n)} / ${pct((sum.draw ?? 0) / n)}`,
  `${pct(R.results.home)} / ${pct(R.results.away + R.results.neutral)} / ${pct(R.results.draw)}`, R2 ? `${pct(R2.results.home)} / ${pct(R2.results.away + R2.results.neutral)} / ${pct(R2.results.draw)}` : undefined);
row("ties", pct((sum.tie ?? 0) / n), pct(R.results.tie), R2 ? pct(R2.results.tie) : undefined);
row("days: mean / <=3 / 4 / 5", `${f2(sum.days / n)} / ${pct((sum.d3 ?? 0) / n)} / ${pct((sum.d4 ?? 0) / n)} / ${pct((sum.d5 ?? 0) / n)}`,
  `${R.days.mean} / ${pct(R.days.upTo3)} / ${pct(R.days.four)} / ${pct(R.days.five)}`, R2 ? `${R2.days.mean} / ${pct(R2.days.upTo3)} / ${pct(R2.days.four)} / ${pct(R2.days.five)}` : undefined);
row("follow-ons per Test / enforced when available", `${f2((sum.followOn ?? 0) / n)} / ${pct((sum.followOn ?? 0) / Math.max(1, sum.foAvail ?? 0))}`,
  `${R.followOnsPerTest} / ${pct(R.followOnEnforcedShare)}`, R2 ? `${R2.followOnsPerTest} / ${pct(R2.followOnEnforcedShare)}` : undefined);
row("declarations per Test (inn 1 / 2 / 3)", `${f2((sum.dec1 ?? 0) / n)} / ${f2((sum.dec2 ?? 0) / n)} / ${f2((sum.dec3 ?? 0) / n)}`,
  `${R.declarationsPerTest[1]} / ${R.declarationsPerTest[2]} / ${R.declarationsPerTest[3]}`, R2 ? `${R2.declarationsPerTest[1]} / ${R2.declarationsPerTest[2]} / ${R2.declarationsPerTest[3]}` : undefined);
CH.forEach((lo, b) => {
  const c = sum[`ch${b}`] ?? 0;
  const rr = R.chases[`${lo}+`];
  const rr2 = R2 ? R2.chases[`${lo}+`] : undefined;
  const fmt = (x: Chase | undefined) => (x ? `${pct(x.win)} / ${pct(x.draw)} / ${pct(x.loss)} (n ${x.n})` : "-");
  row(`4th-inn target ${lo}${b < CH.length - 1 ? `-${CH[b + 1] - 1}` : "+"}: win / draw / loss`,
    c ? `${pct((sum[`ch${b}_win`] ?? 0) / c)} / ${pct((sum[`ch${b}_draw`] ?? 0) / c)} / ${pct((sum[`ch${b}_loss`] ?? 0) / c)} (n ${c})` : "-", fmt(rr), rr2 ? fmt(rr2) : undefined);
});
{
  const bp = (R as unknown as { byPosition?: Record<string, { runsPer6: number; ballsPerDismissal: number; ballShare: number }> }).byPosition;
  const bp2 = (R2 as unknown as { byPosition?: Record<string, { runsPer6: number; ballsPerDismissal: number; ballShare: number }> } | undefined)?.byPosition;
  const gs = [["p13", "1-3"], ["p46", "4-6"], ["p711", "7-11"]] as const;
  const balls = gs.reduce((a, [g]) => a + (sum[`${g}_balls`] ?? 0), 0);
  const fmt = (b?: Record<string, { runsPer6: number; ballsPerDismissal: number; ballShare: number }>, k?: "runsPer6" | "ballsPerDismissal" | "ballShare") =>
    b ? gs.map(([, p]) => k === "ballShare" ? pct(b[p][k]) : b[p][k!].toFixed(k === "runsPer6" ? 2 : 1)).join(" / ") : undefined;
  row("batting 1-3 / 4-6 / 7-11: runs per 6 balls faced", gs.map(([g]) => f2(6 * (sum[`${g}_runs`] ?? 0) / Math.max(1, sum[`${g}_balls`] ?? 0))).join(" / "), fmt(bp, "runsPer6"), fmt(bp2, "runsPer6"));
  row("batting 1-3 / 4-6 / 7-11: balls faced per dismissal", gs.map(([g]) => f1((sum[`${g}_balls`] ?? 0) / Math.max(1, (sum[`${g}_out`] ?? 0) + (sum[`${g}_ro`] ?? 0)))).join(" / "), fmt(bp, "ballsPerDismissal"), fmt(bp2, "ballsPerDismissal"));
  row("batting 1-3 / 4-6 / 7-11: share of balls faced", gs.map(([g]) => pct((sum[`${g}_balls`] ?? 0) / balls)).join(" / "), fmt(bp, "ballShare"), fmt(bp2, "ballShare"));
}
{
  // pooled 200-349 chases: the bands are small in any one era, so 2022+ (n 50) with a 95% interval
  const pc = [2, 3, 4].reduce((a, b) => ({ n: a.n + (sum[`ch${b}`] ?? 0), w: a.w + (sum[`ch${b}_win`] ?? 0), d: a.d + (sum[`ch${b}_draw`] ?? 0) }), { n: 0, w: 0, d: 0 });
  const rc = (r: RealTargets | undefined) => {
    if (!r) return undefined;
    const xs = ["200+", "250+", "300+"].map(k => r.chases[k]).filter(Boolean);
    const n = xs.reduce((a, x) => a + x.n, 0), w = xs.reduce((a, x) => a + x.win * x.n, 0) / n, d = xs.reduce((a, x) => a + x.draw * x.n, 0) / n;
    const ci = 1.96 * Math.sqrt((w * (1 - w)) / n);
    return `${pct(w)} (±${(100 * ci).toFixed(0)}) / ${pct(d)} (n ${n})`;
  };
  const R22 = (TEST_MODEL.real as unknown as Record<string, RealTargets | undefined>).male2022;
  row("4th-inn target 200-349 pooled: win / draw (real 2022+ | 2015+)", `${pct(pc.w / Math.max(1, pc.n))} / ${pct(pc.d / Math.max(1, pc.n))} (n ${pc.n})`,
    gender === "male" ? rc(R22) : rc(R), gender === "male" ? rc(R2) : undefined);
}
row("innings victories", pct((sum.innWin ?? 0) / n), pct(R.inningsWins), R2 ? pct(R2.inningsWins) : undefined);
row("centuries per Test", f2((sum.c100 ?? 0) / n), R.centuriesPerTest, R2?.centuriesPerTest);
row("50+ scores per Test", f2((sum.c50 ?? 0) / n), R.fiftiesPlusPerTest, R2?.fiftiesPlusPerTest);
row("five-fors per Test", f2((sum.f5 ?? 0) / n), R.fiveForsPerTest, R2?.fiveForsPerTest);
row("spin share of bowler wickets, day 1-5", [1, 2, 3, 4, 5].map(d => pct((sum[`spin_day${d}`] ?? 0) / Math.max(1, sum[`w_day${d}`] ?? 0))).join(" "),
  R.spinWicketShareByDay.map((x: number) => pct(x)).join(" "), R2 ? R2.spinWicketShareByDay.map((x: number) => pct(x)).join(" ") : undefined);
row("spin share of overs, day 1-5", [1, 2, 3, 4, 5].map(d => pct((sum[`bs_day${d}`] ?? 0) / Math.max(1, sum[`b_day${d}`] ?? 0))).join(" "),
  R.spinOverShareByDay.map((x: number) => pct(x)).join(" "), R2 ? R2.spinOverShareByDay.map((x: number) => pct(x)).join(" ") : undefined);
row("overs share of bowlers 1-6 (by overs)", [0, 1, 2, 3, 4, 5].map(k => pct((sum[`rankOv${k}`] ?? 0) / (sum[`rankN${k}`] ?? 1))).join(" "),
  R.oversShareByRank.map((x: number) => pct(x)).join(" "), R2 ? R2.oversShareByRank.map((x: number) => pct(x)).join(" ") : undefined);
row("wicket share of bowlers 1-6 (by overs)", [0, 1, 2, 3, 4, 5].map(k => pct((sum[`rankW${k}`] ?? 0) / (sum[`rankWt${k}`] ?? 1))).join(" "),
  R.wicketShareByRank.map((x: number) => pct(x)).join(" "), R2 ? R2.wicketShareByRank.map((x: number) => pct(x)).join(" ") : undefined);
if (gender === "male") {
  // measured on Cricsheet men's Tests with the same definitions (innings of 50+ overs; docs/FORMATS.md, section 6.11)
  row("bowlers used per innings (50+ overs)", f2(sum.bowlersUsed / sum.rankInns), "5.53", "5.53");
  row("innings with a five-for, innings 1 / 2 / 3 / 4", [1, 2, 3, 4].map(i => pct((sum[`i5_${i}`] ?? 0) / Math.max(1, sum[`inn${i}`] ?? 1))).join(" "),
    "41.8% 40.4% 37.0% 33.3%", "34.5% 40.1% 33.0% 29.6%");
}
if (gender === "male") {
  const S = TEST_MODEL.real.male.strongVsWeak;
  row(`strong v weak (${S.strong.join(", ")} v ${S.weak.join(", ")}): strong / draw / weak`,
    `${pct((sum.svw_strong ?? 0) / sum.svw)} / ${pct((sum.svw_draw ?? 0) / sum.svw)} / ${pct((sum.svw_weak ?? 0) / sum.svw)} (n ${sum.svw})`,
    `${pct(S.strongWin)} / ${pct(S.draw)} / ${pct(S.weakWin)} (n ${S.n})`);
}
if (gender === "male") {
  const tw = TEST_MODEL.real.male.teamWinShare as Record<string, number>;
  const tw2 = TEST_MODEL.real.male2023.teamWinShare as Record<string, number>;
  row("win share by team (sim / real 2015+ / 2023+)", squads.filter(s => tw[s.team] !== undefined).map(s => `${s.team.split(" ").map(w => w[0]).join("")} ${pct((sum[`teamWin_${s.team}`] ?? 0) / (sum[`team_${s.team}`] ?? 1))}`).join(" "),
    squads.filter(s => tw[s.team] !== undefined).map(s => `${pct(tw[s.team])}`).join(" "), squads.filter(s => tw[s.team] !== undefined).map(s => tw2[s.team] !== undefined ? pct(tw2[s.team]) : "-").join(" "));
}
row("nightwatchmen per Test (real: promoted tail-enders, all reasons)", f2((sum.nightwatchmen ?? 0) / n), "0.88");
row("DRS reviews per innings", f2((sum.reviews ?? 0) / (sum.inn1 + sum.inn2 + (sum.inn3 ?? 0) + (sum.inn4 ?? 0))), TEST_MODEL.drs.reviewsPerInnings);

console.log(`${N} ${gender} Tests, ${ms.toFixed(1)} ms each; squads from the shipped pool, ${withTest}/${rosterSize} players on Test ratings${t20Only ? " (T20 ratings only)" : ""}${missing.length ? `; not in the pool: ${missing.join(", ")}` : ""}`);
if (process.env.MD) {
  console.log(`| metric | sim | real ${gender === "male" ? "2023+" : "2014+"} | ${gender === "male" ? "real 2015+" : "-"} |\n|---|---|---|---|`);
  for (const r of rows) console.log(`| ${r.join(" | ")} |`);
} else {
  const w = Math.max(...rows.map(r => r[0].length));
  for (const r of rows) console.log(`${r[0].padEnd(w)}  sim ${r[1].padEnd(34)} real ${r[2].padEnd(34)} ${r[3] !== "-" ? "2015+ " + r[3] : ""}`);
}
