/**
 * ODI benchmark: replay the real 2019+ ODI fixture list (men's and women's) with national XIs built from the game's
 * player pool, and print the simulated numbers next to the real ODIs (docs/data/odi_validation.json, written by
 * packages/ratings/src/analysis/odi-ball-model.py). docs/FORMATS.md has the table.
 *
 *   npx tsx packages/engine/src/__tests__/benchmark-odi.ts [replays per fixture=2] [men|women|both]
 *   ENGINE=live ...      play the matches in the live engine (CPU v CPU) instead of the instant one
 *   CALIBRATE=1 ...      also print what refitting needs: per-outcome rates sim vs real (-> ODI_CAL), the
 *                        involvement-weighted rating composites (-> ODI_REF) and the rating spread vs the real one (-> slopes)
 *   FORMAT_RATINGS=/path/format-ratings.json ...   play the players on their ODI ratings (the ratings pipeline's
 *                        packages/app/public/data/format-ratings.json, sourceId -> [odi, test] sets; default: that file if it
 *                        exists, else everyone on his T20 ratings). FORMAT_RATINGS=none forces the T20 ratings.
 *   ODI_TUNE='{"cal":{"male":[[...]]},"slopes":{"wicket":{"balance":-1.2}},"ref":{"male":{...}},"scale":{"female":1.4},"tail":0.5}' ...
 *                        try parameters before writing them into odi-model.ts (merged over the shipped ones)
 *
 * A national pool is everyone in the game's pool (ALL_PLAYERS men, WPL_PLAYERS women; Cricinfo ids) who batted or bowled
 * in the side's 2019+ ODIs; the squad is its 20 most involved, the XI the engine's own pick. Every match is seeded.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALL_PLAYERS } from "../../../ratings/src/all-players.js";
import { WPL_PLAYERS } from "../../../ratings/src/wpl-players.js";
import * as E from "../index.js";

if (process.env.ODI_TUNE) {
  const t = JSON.parse(process.env.ODI_TUNE);
  for (const [g, v] of Object.entries(t.ref ?? {})) Object.assign(E.ODI_REF[g as "male" | "female"], v);
  for (const [g, v] of Object.entries(t.scale ?? {})) E.ODI_RATING_SCALE[g as "male" | "female"] = v as number;
  if (t.tail !== undefined) E.ODI_TAIL_WEIGHT.value = t.tail;
  for (const [g, v] of Object.entries(t.cal ?? {})) E.ODI_CAL[g as "male" | "female"].splice(0, 3, ...(v as number[][]));
  for (const [k, v] of Object.entries(t.slopes ?? {})) (E.ODI_RATING_SLOPES as Record<string, object>)[k] = v as object;
}
const REPLAYS = Number(process.argv[2] ?? 2);
const WHICH = process.argv[3] ?? "both";
const LIVE = process.env.ENGINE === "live";
const CALIBRATE = !!process.env.CALIBRATE;
const V = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../docs/data/odi_validation.json", import.meta.url)), "utf8"));
const FR_PATH = process.env.FORMAT_RATINGS ?? fileURLToPath(new URL("../../../app/public/data/format-ratings.json", import.meta.url));
const FR: { players: Record<string, number[][]> } | null = FR_PATH !== "none" && existsSync(FR_PATH) ? JSON.parse(readFileSync(FR_PATH, "utf8")) : null;
const CORE = ["battingIQ", "timing", "power", "running", "wicketTaking", "economy", "accuracy", "clutch"] as const;
/** The player's ODI set from the ratings file (fielding / keeping stay his T20 values), if it has one */
function odiSet(d: E.PlayerData): E.PlayerData["formatRatings"] {
  const set = FR?.players[d.id]?.[0];
  if (!set || set.length < 9) return undefined;
  const ratings = { ...d.ratings, ...Object.fromEntries(CORE.map((k, i) => [k, set[i]])) } as E.PlayerData["ratings"];
  return { odi: { ratings, source: set[8] === 1 ? "data" : "derived" } };
}
const MODEL_REPORT = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../docs/data/odi_ball_model.json", import.meta.url)), "utf8"));

type G = "male" | "female";
/** A bowler exactly at the reference composites, to measure batters against */
const refBowler = (g: G): E.OdiPlayerLike => ({
  battingOvr: 0, bowlingOvr: 200 * E.ODI_REF[g].bowl - 100 * E.ODI_REF[g].accuracy,
  ratings: { timing: 0, power: 0, wicketTaking: 100 * E.ODI_REF[g].wicketTaking, accuracy: 100 * E.ODI_REF[g].accuracy },
});
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);

function nationalTeams(gender: G): Map<string, E.Team> {
  const src = (gender === "male" ? ALL_PLAYERS : WPL_PLAYERS) as unknown as E.PlayerData[];
  const byEspn = new Map(src.map(p => [Number(String(p.id).replace("espn_", "")), p]));
  const teams = new Map<string, E.Team>();
  for (const [name, pool] of Object.entries(V[gender].pools as Record<string, [number, number, number][]>)) {
    const found = pool.map(([espn]) => byEspn.get(espn)).filter((p): p is E.PlayerData => !!p).slice(0, 20);
    if (found.length < 13) continue;
    const id = name.toLowerCase().replace(/[^a-z]+/g, "-");
    const team = new E.Team({ id, name, shortName: name.slice(0, 3).toUpperCase(), city: name, primaryColor: "#333333", secondaryColor: "#999999" }, 100);
    for (const d of found) {
      const fr = odiSet(d);
      team.addPlayer(new E.Player({ ...d, id: `${id}_${d.id}`, ...(fr ? { formatRatings: fr } : {}), injured: false, injuryGamesLeft: 0 }), 1);
    }
    if (team.getPlayingXI(11).length === 11) teams.set(name, team);
  }
  return teams;
}

interface Inn { runs: number; wickets: number; extras: number; fours: number; sixes: number; legal: number; phase: [number, number][]; kinds: string[] }

function fromInstant(inn: E.InningsScore): Inn {
  const phase: [number, number][] = [[0, 0], [0, 0], [0, 0]];
  const kinds: string[] = [];
  for (const b of inn.ballLog) {
    const p = b.over < 10 ? 0 : b.over < 40 ? 1 : 2;
    phase[p][0] += b.runs + b.extras;
    if (b.outcome !== "wide" && b.outcome !== "noball" && !b.deadBall) phase[p][1]++;
    if (b.isWicket) kinds.push(b.wicketType ?? "?");
  }
  const off = (inn.offBall ?? []).filter(o => o.kind !== "retired_hurt").length;
  return { runs: inn.runs, wickets: inn.wickets, extras: inn.extras, fours: inn.fours, sixes: inn.sixes, legal: inn.totalBalls, phase, kinds: [...kinds, ...Array(off).fill("other")] };
}

const FULL_MEMBERS = new Set(["India", "Australia", "England", "South Africa", "New Zealand", "Pakistan", "Sri Lanka", "West Indies", "Bangladesh", "Afghanistan", "Zimbabwe", "Ireland"]);
/** Head-to-head groups for the strong-v-weak check: full members v associates, and the leading sides v the other full members */
function groupDefs(gender: G): [string, (t: string) => boolean, (t: string) => boolean][] {
  const top = gender === "male" ? new Set(["India", "Australia", "South Africa", "New Zealand", "England", "Pakistan"]) : new Set(["Australia", "England", "India", "South Africa"]);
  return [
    ["full members v associates", t => FULL_MEMBERS.has(t), t => !FULL_MEMBERS.has(t)],
    [`top ${top.size} v the other full members`, t => top.has(t), t => FULL_MEMBERS.has(t) && !top.has(t)],
  ];
}

function run(gender: G) {
  const real = V[gender];
  const teams = nationalTeams(gender);
  const rules = E.odiRules(gender === "male" ? "men" : "women", { ...E.DEFAULT_RULES, injuriesEnabled: false });
  const fixtures = (real.fixtures as [string, string, string | null][]).filter(([a, b]) => teams.has(a) && teams.has(b));
  const s = { matches: 0, batFirstWins: 0, decided: 0, ties: 0, hundreds: 0, fifties: 0 };
  const first: Inn[] = [], second: Inn[] = [];
  const teamRec = new Map<string, { w: number; n: number; rw: number; rn: number }>();
  const rec = (t: string) => teamRec.get(t) ?? (teamRec.set(t, { w: 0, n: 0, rw: 0, rn: 0 }), teamRec.get(t)!);
  for (const [a, b, w] of fixtures) {
    if (w === null) continue;
    rec(a).rn++; rec(b).rn++;
    if (w === a || w === b) rec(w).rw++;
    else { rec(a).rw += 0.5; rec(b).rw += 0.5; }
  }
  const pos = Array.from({ length: 11 }, () => ({ runs: 0, balls: 0, outs: 0 }));
  const simH2H = new Map<string, { w: number; n: number }>();
  const classCount = new Array(10).fill(0);
  const phaseCount = [0, 1, 2].map(() => new Array(10).fill(0));
  const phaseN = [0, 0, 0];
  let deliveries = 0;
  const involvement = { bat: [0, 0, 0, 0], bowl: [0, 0, 0, 0] }; // weighted sums of composites, weight
  const spread: Record<string, { bat: number[][]; bowl: number[][] }> = {};
  const cls = (o: string) => E.ODI_OUTCOMES.indexOf(o as never);
  let seed = gender === "male" ? 7000 : 9000;
  for (let rep = 0; rep < REPLAYS; rep++) {
    for (const [a, b, w] of fixtures) {
      if (w === null) continue;
      const home = teams.get(a)!, away = teams.get(b)!;
      let inns: [Inn, Inn];
      let winner: string | null;
      let batFirst: string;
      let batterRows: { order: string[]; stats: Map<string, { runs: number; balls: number; isOut: boolean }> }[] = [];
      if (LIVE) {
        const { state } = E.simulateRemaining(E.createMatchState(home, away, rules, null, ++seed));
        const raws = [state._internal.innings1Raw!, state._internal.currentInningsRaw];
        inns = raws.map(r => fromInstant({ ...r, batterStats: new Map(), bowlerStats: new Map() } as unknown as E.InningsScore)) as [Inn, Inn];
        winner = state.winnerId ?? null;
        batFirst = state._internal.battingFirstId;
        batterRows = raws.map(r => ({ order: Object.keys(r.batterStats), stats: new Map(Object.entries(r.batterStats)) }));
        for (const r of raws) for (const e of r.ballLog) {
          if (e.deadBall) continue;
          deliveries++;
          const c = cls(e.isWicket && e.outcome !== "wide" && e.outcome !== "noball" ? "wicket" : e.outcome);
          classCount[c]++;
          const ph = e.over < 10 ? 0 : e.over < 40 ? 1 : 2;
          phaseCount[ph][c]++; phaseN[ph]++;
        }
      } else {
        const res = E.simulateMatch(home, away, rules, ++seed, { countTowardStandings: false, neutralVenue: true });
        inns = [fromInstant(res.innings[0]), fromInstant(res.innings[1])];
        winner = res.winnerId;
        batFirst = res.innings[0].teamId;
        for (const inn of res.innings) {
          for (const e of inn.ballLog) {
            if (e.deadBall) continue;
            deliveries++;
            const c = cls(e.isWicket && e.outcome !== "wide" && e.outcome !== "noball" ? "wicket" : e.outcome);
            classCount[c]++;
            const ph = e.over < 10 ? 0 : e.over < 40 ? 1 : 2;
            phaseCount[ph][c]++; phaseN[ph]++;
          }
          const team = inn.teamId === home.id ? home : away;
          const xi = team.getPlayingXI(11);
          batterRows.push({ order: [...inn.batterStats.keys()].filter(id => inn.batterStats.get(id)!.balls > 0 || inn.batterStats.get(id)!.isOut), stats: inn.batterStats });
          if (CALIBRATE) {
            const other = team === home ? away : home;
            for (const p of xi) {
              const st = inn.batterStats.get(p.id);
              if (st && st.balls > 0) {
                const v = p.forFormat("odi");
                const wt = st.balls;
                involvement.bat[0] += wt * (v.battingOvr + v.ratings.timing) / 200; involvement.bat[1] += wt * v.ratings.timing / 100;
                involvement.bat[2] += wt * v.ratings.power / 100; involvement.bat[3] += wt;
                const m = E.odiRatingMultipliers(v, refBowler(gender), gender);
                (spread[gender] ??= { bat: [], bowl: [] }).bat.push([wt, ...m.map(Math.log)]);
              }
            }
            for (const p of other.getPlayingXI(11)) {
              const bs = inn.bowlerStats.get(p.id);
              if (bs && (bs.overs > 0 || bs.balls > 0)) {
                const v = p.forFormat("odi");
                const wt = bs.overs * 6 + bs.balls;
                involvement.bowl[0] += wt * (v.bowlingOvr + v.ratings.accuracy) / 200; involvement.bowl[1] += wt * v.ratings.wicketTaking / 100;
                involvement.bowl[2] += wt * v.ratings.accuracy / 100; involvement.bowl[3] += wt;
              }
            }
          }
        }
      }
      s.matches++;
      first.push(inns[0]); second.push(inns[1]);
      if (winner === null) s.ties++;
      else { s.decided++; if (winner === batFirst) s.batFirstWins++; }
      const wName = winner === home.id ? a : winner === away.id ? b : null;
      const ra = rec(a), rb = rec(b);
      ra.n++; rb.n++;
      if (wName) rec(wName).w++; else { ra.w += 0.5; rb.w += 0.5; }
      for (const [label, isA, isB] of groupDefs(gender)) {
        if (!((isA(a) && isB(b)) || (isA(b) && isB(a)))) continue;
        const g2 = simH2H.get(label) ?? (simH2H.set(label, { w: 0, n: 0 }), simH2H.get(label)!);
        g2.n++; g2.w += wName === null ? 0.5 : isA(wName) ? 1 : 0;
      }
      for (const row of batterRows) {
        row.order.forEach((id, i) => {
          const st = row.stats.get(id)!;
          if (st.runs >= 100) s.hundreds++; else if (st.runs >= 50) s.fifties++;
          const q = pos[Math.min(10, i)];
          q.runs += st.runs; q.balls += st.balls; if (st.isOut) q.outs++;
        });
      }
    }
  }
  const runs = first.map(i => i.runs).sort((x, y) => x - y);
  const q = (p: number) => runs[Math.min(runs.length - 1, Math.floor(p * runs.length))];
  const mean = (xs: number[]) => xs.reduce((t, x) => t + x, 0) / Math.max(1, xs.length);
  const avg = mean(runs);
  const sd = Math.sqrt(mean(runs.map(r => (r - avg) ** 2)));
  const rr = (inns: Inn[], p: number) => 6 * inns.reduce((t, i) => t + i.phase[p][0], 0) / Math.max(1, inns.reduce((t, i) => t + i.phase[p][1], 0));
  const fi = real.firstInnings;
  const rows: [string, string, string][] = [
    ["1st-innings total: mean", f1(avg), f1(fi.avg)],
    ["  sd", f1(sd), f1(fi.sd)],
    ["  10 / 25 / 50 / 75 / 90%", [0.1, 0.25, 0.5, 0.75, 0.9].map(q).join(" / "), fi.q.map((x: number) => Math.round(x)).join(" / ")],
    ["  300+", pct(mean(runs.map(r => (r >= 300 ? 1 : 0)))), pct(fi.p300)],
    ["  350+", pct(mean(runs.map(r => (r >= 350 ? 1 : 0)))), pct(fi.p350)],
    ["  under 200", pct(mean(runs.map(r => (r < 200 ? 1 : 0)))), pct(fi.pUnder200)],
    ["run rate overs 1-10 (1st inns)", f2(rr(first, 0)), f2(fi.rr1)],
    ["run rate overs 11-40", f2(rr(first, 1)), f2(fi.rr2)],
    ["run rate overs 41-50", f2(rr(first, 2)), f2(fi.rr3)],
    ["1st inns: wickets", f2(mean(first.map(i => i.wickets))), f2(fi.wk)],
    ["1st inns: all out", pct(mean(first.map(i => (i.wickets >= 10 ? 1 : 0)))), pct(fi.allOut)],
    ["2nd inns: runs", f1(mean(second.map(i => i.runs))), f1(real.secondInnings.avg)],
    ["2nd inns: wickets", f2(mean(second.map(i => i.wickets))), f2(real.secondInnings.wk)],
    ["2nd inns: all out", pct(mean(second.map(i => (i.wickets >= 10 ? 1 : 0)))), pct(real.secondInnings.allOut)],
    ["batting first wins", pct(s.batFirstWins / Math.max(1, s.decided)), pct(real.results.batFirstWin)],
    ["ties", pct(s.ties / s.matches), pct(real.results.tieShare)],
    ["100s per match", f2(s.hundreds / s.matches), f2(real.perMatch.hundreds)],
    ["50s per match", f2(s.fifties / s.matches), f2(real.perMatch.fifties)],
    ["extras per innings (1st)", f1(mean(first.map(i => i.extras))), f1(fi.extras)],
    ["fours per innings (1st)", f1(mean(first.map(i => i.fours))), f1(fi.fours)],
    ["sixes per innings (1st)", f1(mean(first.map(i => i.sixes))), f1(fi.sixes)],
  ];
  const onOdi = [...teams.values()].flatMap(t => t.roster).filter(p => p.formatRatings?.odi).length;
  console.log(`\n${gender === "male" ? "MEN" : "WOMEN"} (${LIVE ? "live" : "instant"} engine): ${s.matches} matches, ${teams.size} national sides, ${fixtures.length} real fixtures x ${REPLAYS}; ${onOdi ? `${onOdi} players on ODI ratings (${FR_PATH})` : "T20 ratings"}`);
  console.log(`| ${"".padEnd(32)} | ${"sim".padEnd(28)} | real 2019+ |`);
  for (const [k, a2, b2] of rows) console.log(`| ${k.padEnd(32)} | ${a2.padEnd(28)} | ${b2} |`);
  // dismissal mix
  const kinds: Record<string, number> = {};
  for (const i of [...first, ...second]) for (const k of i.kinds) kinds[k] = (kinds[k] ?? 0) + 1;
  const kt = Object.values(kinds).reduce((t, x) => t + x, 0);
  const realName: Record<string, string> = { caught: "caught", bowled: "bowled", lbw: "lbw", run_out: "run out", caught_and_bowled: "caught and bowled", stumped: "stumped", hit_wicket: "hit wicket" };
  console.log("dismissals: " + Object.entries(kinds).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${pct(v / kt)} (real ${pct(real.dismissals[realName[k] ?? k] ?? 0)})`).join(", "));
  console.log("by position (avg / SR), sim | real: " + pos.map((p, i) => `${i + 1}: ${f1(p.runs / Math.max(1, p.outs))}/${f1(100 * p.runs / Math.max(1, p.balls))} | ${f1(real.byPosition[i]?.avg ?? 0)}/${f1(real.byPosition[i]?.sr ?? 0)}`).join("; "));
  // spread: team win share, sim against real, over the same fixtures
  const tr = [...teamRec.entries()].filter(([, r]) => r.rn >= 10).map(([t, r]) => ({ t, sim: r.w / r.n, real: r.rw / r.rn, n: r.rn }));
  const mx = mean(tr.map(x => x.real)), my = mean(tr.map(x => x.sim));
  const cov = mean(tr.map(x => (x.real - mx) * (x.sim - my)));
  const sdx = Math.sqrt(mean(tr.map(x => (x.real - mx) ** 2))), sdy = Math.sqrt(mean(tr.map(x => (x.sim - my) ** 2)));
  // net of the binomial noise of a win share over n matches, the spread of the sides' strength
  const net = (sd: number, noise: number) => Math.sqrt(Math.max(0, sd * sd - noise));
  const noiseReal = mean(tr.map(x => (x.real * (1 - x.real)) / x.n)), noiseSim = mean(tr.map(x => (x.sim * (1 - x.sim)) / (x.n * REPLAYS)));
  console.log(`team win share over the same fixtures (${tr.length} sides, 10+ matches): sd real ${f2(sdx)} / sim ${f2(sdy)} (net of noise ${f2(net(sdx, noiseReal))} / ${f2(net(sdy, noiseSim))}), correlation ${f2(cov / (sdx * sdy))}`);
  const h2h = (isA: (t: string) => boolean, isB: (t: string) => boolean) => {
    let rw = 0, rn = 0;
    for (const [a, b, w] of fixtures) {
      if (w === null || !((isA(a) && isB(b)) || (isA(b) && isB(a)))) continue;
      rn++; rw += w === "tie" ? 0.5 : isA(w) ? 1 : 0;
    }
    return rn ? { real: rw / rn, n: rn } : null;
  };
  for (const [label, isA, isB] of groupDefs(gender)) {
    const r = h2h(isA, isB);
    if (!r) continue;
    const sw = simH2H.get(label) ?? { w: 0, n: 0 };
    console.log(`${label}: the first group wins ${pct(sw.w / Math.max(1, sw.n))} simulated, ${pct(r.real)} real (${r.n} real matches)`);
  }
  console.log("  " + tr.sort((x, y) => y.real - x.real).map(x => `${x.t} ${pct(x.real)}/${pct(x.sim)}`).join(", "));
  if (CALIBRATE) {
    const obs = MODEL_REPORT[gender].observed2019 as number[];
    const simRate = classCount.map(c => c / deliveries);
    console.log("per-delivery rates sim / real (-> ODI_CAL x real/sim): " + E.ODI_OUTCOMES.map((k, i) => `${k} ${simRate[i].toFixed(4)}/${obs[i].toFixed(4)} (x${(obs[i] / simRate[i]).toFixed(3)})`).join(", "));
    console.log("per-delivery rates by phase sim/real: " + ["1-10", "11-40", "41-50"].map((ph, p) => `${ph}: ` + E.ODI_OUTCOMES.map((k, i) => `${k} ${(phaseCount[p][i] / Math.max(1, phaseN[p])).toFixed(4)}/${real.phaseRates[p][i].toFixed(4)}`).join(" ")).join(" | "));
    const next = E.ODI_CAL[gender].map((row, p) => row.map((c, i) => Math.round(1000 * c * real.phaseRates[p][i] / Math.max(1e-6, phaseCount[p][i] / Math.max(1, phaseN[p]))) / 1000));
    console.log(`suggested ODI_CAL.${gender} = ${JSON.stringify(next)}`);
    const ib = involvement.bat, iw = involvement.bowl;
    console.log(`involvement-weighted composites (-> ODI_REF): bat ${(ib[0] / ib[3]).toFixed(3)} timing ${(ib[1] / ib[3]).toFixed(3)} power ${(ib[2] / ib[3]).toFixed(3)} | bowl ${(iw[0] / iw[3]).toFixed(3)} wicketTaking ${(iw[1] / iw[3]).toFixed(3)} accuracy ${(iw[2] / iw[3]).toFixed(3)}`);
    const sp = spread[gender];
    if (sp) {
      const tw = sp.bat.reduce((t, r) => t + r[0], 0);
      const out = E.ODI_OUTCOMES.map((k, i) => {
        const mu = sp.bat.reduce((t, r) => t + r[0] * r[i + 1], 0) / tw;
        const sdv = Math.sqrt(sp.bat.reduce((t, r) => t + r[0] * (r[i + 1] - mu) ** 2, 0) / tw);
        const realSd = MODEL_REPORT[gender].playerSpread.batter[k]?.sd;
        return `${k} ${sdv.toFixed(3)}/${realSd ?? "-"}`;
      });
      console.log("batter spread, sd of log rate (sim from ratings / real player effects): " + out.join(", "));
    }
  }
}

for (const g of (WHICH === "both" ? ["male", "female"] : [WHICH === "women" ? "female" : "male"]) as G[]) run(g);
