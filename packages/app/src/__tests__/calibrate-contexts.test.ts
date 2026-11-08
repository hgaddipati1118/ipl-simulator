import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import {
  EXTRA_LEAGUES, RULE_PRESETS, T20I_CONTEXT, WOMENS_LEAGUE_CONTEXT, createMatchState, simulateMatch, simulateRemaining,
  type BallEvent, type BallOutcome, type RuleSet, type T20Context, type Team,
} from "@ipl-sim/engine";
import { createGameState } from "../game-state";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import type { PlayerActivityFile } from "@ipl-sim/ratings/dist/player-activity.js";
import { createSeries, matchContext, seriesSquads, type SeriesGender } from "../international";
import { createPoolLoader } from "../extended-pool";

/**
 * The T20I level (skipped unless CALIBRATE_T20I=1): the real fixtures between full members since 2019
 * (docs/data/t20i_validation.json, from packages/ratings/src/analysis/t20i-level.py) replayed by the engine with the
 * series' own sides (national squads of active players on T20 ratings, the extended pool's senior players among the
 * candidates as on the series page; neutral venues, no rain), against the real ones.
 * With CAL_ITER=n it first fits the T20I context (engine scoring-context.ts) by n rounds of proportional fitting: each phase's
 * share of deliveries by outcome class (dot, 1, 2, 3, 4, 6, wicket, wide, no-ball, bye / leg bye) is brought to the real
 * share, multiplying the class's weight by real / simulated (half steps after the third round); CALIBRATE_WRITE=1 then
 * writes t20i-context-data.ts.
 *   CALIBRATE_T20I=1 CAL_ITER=6 CALIBRATE_WRITE=1 npx vitest run packages/app/src/__tests__/calibrate-contexts.test.ts --reporter=verbose
 * CAL_REPLAYS (default 2) replays each fixture; CAL_LIVE=1 also plays the fixtures on the live engine (CPU v CPU);
 * CAL_GENDER=men|women limits the genders; CAL_NOCONTEXT=1 shows the engine without the context (the league tables).
 *
 * The women's leagues (skipped unless CALIBRATE_LEAGUES=1): the WPL, WBBL and women's Hundred with the game's own squads
 * (createGameState), random pairings, instant engine, against their real matches since 2024 (the file's womensLeagues2024).
 * CAL_ITER=n fits each league's context the same way (womens-league-context-data.ts); a league's real class shares are
 * shrunk toward the three leagues' pooled shares with the weight of 1,500 deliveries (the WPL has 66 full matches), and the
 * "default" table (any other women's T20) is the delivery-weighted geometric mean of the three. CAL_MATCHES (default 600)
 * matches per league per round; CAL_LIVE=1 adds the live engine (not the Hundred: the live viewer has none).
 *   CALIBRATE_LEAGUES=1 CAL_ITER=6 CALIBRATE_WRITE=1 npx vitest run packages/app/src/__tests__/calibrate-contexts.test.ts --reporter=verbose
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const PUBLIC = join(HERE, "..", "..", "public");
const OUT = join(REPO, "packages", "engine", "src", "t20i-context-data.ts");
const OUT_LEAGUES = join(REPO, "packages", "engine", "src", "womens-league-context-data.ts");

type Phase = "powerplay" | "middle" | "death";
const PHASES: Phase[] = ["powerplay", "middle", "death"];
const CLASSES: BallOutcome[] = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"];

interface Real {
  matches: number;
  firstInnings: { runs: number; sd: number; p200: number; wickets: number; allOut: number; runRate: number[]; extras: number; fours: number; sixes: number };
  secondInnings: { runs: number; wickets: number };
  allInnings: { runs: number; wickets: number; allOut: number; extras: number; fours: number; sixes: number };
  battingFirstWins: number;
  phaseShares: Record<Phase, Record<string, number>>;
  phaseDeliveries: Record<Phase, number>;
  fixtures: [string, string, number][];
}

/** A delivery's outcome class, as t20i-level.py classes a real one */
function classOf(b: BallEvent): BallOutcome {
  if ((b.wides ?? 0) > 0 || b.outcome === "wide") return "wide";
  if ((b.noBalls ?? 0) > 0 || b.outcome === "noball") return "noball";
  if (b.isWicket) return "wicket";
  if ((b.byes ?? 0) + (b.legByes ?? 0) > 0 && b.runs === 0) return "legbye";
  if (b.runs >= 6) return "6";
  if (b.runs >= 4) return "4";
  return b.runs === 0 ? "dot" : (String(b.runs) as BallOutcome);
}
/** A ball's phase on the T20 timeline; The Hundred's sets as format.ts phaseOver maps them (powerplay sets 1-5, middle 6-15) */
const phaseOf = (over: number, hundred = false): Phase => (over <= (hundred ? 4 : 5) ? "powerplay" : over <= 14 ? "middle" : "death");

interface Inn { runs: number; wickets: number; extras: number; fours: number; sixes: number; ballLog: BallEvent[] }
interface Acc {
  n: number; first: number[]; firstW: number[]; firstOut: number; second: number[]; secondW: number[];
  all: { runs: number; wkts: number; out: number; extras: number; fours: number; sixes: number; inns: number };
  rr: number[][]; bf: number; decided: number; cls: Record<Phase, Record<string, number>>;
}
const newAcc = (): Acc => ({
  n: 0, first: [], firstW: [], firstOut: 0, second: [], secondW: [], all: { runs: 0, wkts: 0, out: 0, extras: 0, fours: 0, sixes: 0, inns: 0 },
  rr: PHASES.map(() => [0, 0]), bf: 0, decided: 0,
  cls: Object.fromEntries(PHASES.map(p => [p, Object.fromEntries(CLASSES.map(c => [c, 0]))])) as Acc["cls"],
});

function addMatch(a: Acc, inns: Inn[], battingFirstWon: boolean | null, hundred = false) {
  a.n++;
  inns.forEach((inn, k) => {
    a.all.runs += inn.runs; a.all.wkts += inn.wickets; a.all.extras += inn.extras; a.all.fours += inn.fours; a.all.sixes += inn.sixes; a.all.inns++;
    if (inn.wickets >= 10) a.all.out++;
    if (k === 0) { a.first.push(inn.runs); a.firstW.push(inn.wickets); if (inn.wickets >= 10) a.firstOut++; }
    else { a.second.push(inn.runs); a.secondW.push(inn.wickets); }
    for (const b of inn.ballLog) {
      if (b.deadBall) continue;
      const p = phaseOf(b.over, hundred);
      a.cls[p][classOf(b)]++;
      if (k === 0) {
        const i = PHASES.indexOf(p);
        a.rr[i][0] += b.runs + b.extras;
        if (b.outcome !== "wide" && b.outcome !== "noball") a.rr[i][1]++;
      }
    }
  });
  if (battingFirstWon !== null) { a.decided++; if (battingFirstWon) a.bf++; }
}

const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / Math.max(1, x.length);
const sd = (x: number[]) => { const m = mean(x); return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, x.length - 1)); };

function summary(a: Acc) {
  const inns = a.all.inns;
  return {
    runs: mean(a.first), sd: sd(a.first), p200: (100 * a.first.filter(r => r >= 200).length) / a.first.length,
    rr: a.rr.map(([r, b]) => (6 * r) / b), wickets: mean(a.firstW), allOut: (100 * a.firstOut) / a.first.length,
    runs2: mean(a.second), wickets2: mean(a.secondW), bf: (100 * a.bf) / Math.max(1, a.decided),
    extras: a.all.extras / inns, fours: a.all.fours / inns, sixes: a.all.sixes / inns, allRuns: a.all.runs / inns, allOutAll: (100 * a.all.out) / inns,
  };
}

function shares(a: Acc): Record<Phase, Record<string, number>> {
  return Object.fromEntries(PHASES.map(p => {
    const tot = CLASSES.reduce((s, c) => s + a.cls[p][c], 0);
    return [p, Object.fromEntries(CLASSES.map(c => [c, a.cls[p][c] / tot]))];
  })) as Record<Phase, Record<string, number>>;
}

const f = (x: number, d = 1) => x.toFixed(d);
const row = (label: string, s: ReturnType<typeof summary>) =>
  `| ${label} | ${f(s.runs)} (${f(s.sd)}) | ${f(s.p200)}% | ${s.rr.map(x => f(x, 2)).join(" / ")} | ${f(s.wickets, 2)} / ${f(s.allOut)}% | ${f(s.runs2)} | ${f(s.bf)}% | ${f(s.extras)} | ${f(s.fours)} / ${f(s.sixes)} |`;
const realRow = (label: string, real: Omit<Real, "fixtures" | "phaseShares" | "phaseDeliveries">) => {
  const fr = real.firstInnings;
  return `| ${label} (${real.matches}) | ${f(fr.runs)} (${f(fr.sd)}) | ${f(fr.p200)}% | ${fr.runRate.map(x => f(x, 2)).join(" / ")} | ${f(fr.wickets, 2)} / ${f(fr.allOut)}% | ${f(real.secondInnings.runs)} | ${f(real.battingFirstWins)}% | ${f(real.allInnings.extras)} | ${f(real.allInnings.fours)} / ${f(real.allInnings.sixes)} |`;
};

const fmtContext = (c: T20Context) =>
  `{ ${PHASES.map(p => `${p}: { ${CLASSES.filter(k => c[p][k] !== undefined).map(k => `${/^\d/.test(k) ? `"${k}"` : k}: ${c[p][k]!.toFixed(4)}`).join(", ")} }`).join(",\n    ")} }`;

type WomensLeague = "wpl" | "wbbl" | "hundred-w";

it.skipIf(!process.env.CALIBRATE_LEAGUES)("women's league levels", () => {
  const VALID = JSON.parse(readFileSync(join(REPO, "docs", "data", "t20i_validation.json"), "utf-8")) as { womensLeagues2024: Record<WomensLeague, Real> };
  const N = Number(process.env.CAL_MATCHES ?? 600);
  const iters = Number(process.env.CAL_ITER ?? 0);
  const extra = (id: string) => EXTRA_LEAGUES.find(l => l.id === id)!.rules;
  const leagues: Array<[WomensLeague, RuleSet, boolean]> = [["wpl", RULE_PRESETS.wpl, false], ["wbbl", extra("wbbl"), false], ["hundred-w", extra("hundred-w"), true]];
  if (process.env.CAL_NOCONTEXT) for (const id of [...leagues.map(l => l[0]), "default"] as const) for (const p of PHASES) WOMENS_LEAGUE_CONTEXT[id][p] = {};

  // a league's real shares, shrunk toward the pooled shares of the three (1,500 deliveries' weight)
  const A = 1500;
  const pooled = Object.fromEntries(PHASES.map(p => {
    const n = leagues.reduce((s, [id]) => s + VALID.womensLeagues2024[id].phaseDeliveries[p], 0);
    return [p, Object.fromEntries(CLASSES.map(c => [c, leagues.reduce((s, [id]) => s + VALID.womensLeagues2024[id].phaseShares[p][c] * VALID.womensLeagues2024[id].phaseDeliveries[p], 0) / n]))];
  })) as Record<Phase, Record<string, number>>;
  const target = (id: WomensLeague) => Object.fromEntries(PHASES.map(p => {
    const r = VALID.womensLeagues2024[id], n = r.phaseDeliveries[p];
    return [p, Object.fromEntries(CLASSES.map(c => [c, (n * r.phaseShares[p][c] + A * pooled[p][c]) / (n + A)]))];
  })) as Record<Phase, Record<string, number>>;

  const play = (id: WomensLeague, r0: RuleSet, hundred: boolean, live: boolean): Acc => {
    const rules = { ...r0, injuriesEnabled: false } as RuleSet;
    const teams = createGameState(rules).teams;
    const acc = newAcc();
    for (let i = 0; i < N; i++) {
      const home = teams[i % teams.length];
      let away = teams[(i * 7 + 3) % teams.length];
      if (away === home) away = teams[(i * 7 + 4) % teams.length];
      if (!live) {
        const r = simulateMatch(home, away, rules, 5000 + i, { countTowardStandings: false });
        addMatch(acc, r.innings as Inn[], r.winnerId && r.margin !== "Super Over" ? r.winnerId === r.innings[0].teamId : null, hundred);
      } else {
        const { state } = simulateRemaining(createMatchState(home, away, rules, null, 5000 + i));
        const raws = [state._internal.innings1Raw, state._internal.currentInningsRaw].filter(Boolean) as Inn[];
        addMatch(acc, raws, state.winnerId && !state.superOvers ? state.winnerId === state._internal.battingFirstId : null);
      }
    }
    void id;
    return acc;
  };

  for (const [id, r0, hundred] of leagues) {
    const ctx = WOMENS_LEAGUE_CONTEXT[id];
    const goal = target(id);
    for (let it = 0; it < iters; it++) {
      const sim = shares(play(id, r0, hundred, false));
      const step = it < 3 ? 1 : 0.5;
      for (const p of PHASES) for (const c of CLASSES) {
        const r = goal[p][c], s = sim[p][c];
        if (!(s > 0) || !(r > 0)) continue;
        ctx[p][c] = (ctx[p][c] ?? 1) * (r / s) ** step;
      }
      const err = Math.max(...PHASES.flatMap(p => CLASSES.filter(c => goal[p][c] > 0).map(c => Math.abs(sim[p][c] / goal[p][c] - 1))));
      console.log(`${id} round ${it + 1}: largest class-share error before this round ${(100 * err).toFixed(1)}%`);
    }
    console.log(`| ${id} | 1st inns (sd) | 200+ | RR 1-6 / 7-15 / 16-20 | 1st inns wkts / all out | 2nd inns | bat 1st wins | extras/inn | 4s / 6s per inn |`);
    console.log(realRow("real", VALID.womensLeagues2024[id]));
    const tag = process.env.CAL_NOCONTEXT ? " (no context)" : "";
    console.log(row(`instant${tag}`, summary(play(id, r0, hundred, false))));
    if (process.env.CAL_LIVE && !hundred) console.log(row(`live CPU${tag}`, summary(play(id, r0, hundred, true))));
  }

  if (iters > 0) {
    // the pooled table: each class's multiplier as the delivery-weighted geometric mean of the three leagues'
    const def: T20Context = { powerplay: {}, middle: {}, death: {} };
    for (const p of PHASES) {
      const w = leagues.map(([id]) => VALID.womensLeagues2024[id].phaseDeliveries[p]);
      const W = w.reduce((a, b) => a + b, 0);
      for (const c of CLASSES) def[p][c] = Math.exp(leagues.reduce((s, [id], k) => s + (w[k] / W) * Math.log(WOMENS_LEAGUE_CONTEXT[id][p][c] ?? 1), 0));
    }
    Object.assign(WOMENS_LEAGUE_CONTEXT.default, def);
  }

  if (process.env.CALIBRATE_WRITE) {
    writeFileSync(OUT_LEAGUES, `/**
 * GENERATED by packages/app/src/__tests__/calibrate-contexts.test.ts (CALIBRATE_LEAGUES=1 CALIBRATE_WRITE=1) from
 * docs/data/t20i_validation.json. Do not edit by hand.
 *
 * The women's league contexts: per league and phase, a multiplier on each outcome class of the T20 ball model, fitted so
 * the game's own WPL, WBBL and women's Hundred sides reproduce the leagues' real matches since 2024 (scoring-context.ts).
 * "default" (the delivery-weighted geometric mean of the three) is any other women's T20 or Hundred.
 */
import type { T20Context } from "./scoring-context.js";

export const WOMENS_LEAGUE_CONTEXT: Record<"wpl" | "wbbl" | "hundred-w" | "default", T20Context> = {
  wpl: ${fmtContext(WOMENS_LEAGUE_CONTEXT.wpl)},
  wbbl: ${fmtContext(WOMENS_LEAGUE_CONTEXT.wbbl)},
  "hundred-w": ${fmtContext(WOMENS_LEAGUE_CONTEXT["hundred-w"])},
  default: ${fmtContext(WOMENS_LEAGUE_CONTEXT.default)},
};
`);
    console.log(`wrote ${OUT_LEAGUES}`);
  }
}, 3_600_000);

it.skipIf(!process.env.CALIBRATE_T20I)("T20I level", async () => {
  const VALID = JSON.parse(readFileSync(join(REPO, "docs", "data", "t20i_validation.json"), "utf-8")) as { t20i: Record<SeriesGender, Real> };
  const FILE = JSON.parse(readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;
  const ACTIVITY = JSON.parse(readFileSync(join(PUBLIC, "data", "player-activity.json"), "utf-8")) as PlayerActivityFile;
  const iters = Number(process.env.CAL_ITER ?? 0);
  const replays = Number(process.env.CAL_REPLAYS ?? 2);
  const genders = (process.env.CAL_GENDER ? [process.env.CAL_GENDER] : ["men", "women"]) as SeriesGender[];

  for (const gender of genders) {
    const real = VALID.t20i[gender];
    const ctx: T20Context = T20I_CONTEXT[gender === "women" ? "female" : "male"];
    if (process.env.CAL_NOCONTEXT) for (const p of PHASES) ctx[p] = {};
    // one series per pairing (its squads), each fixture replayed with its own seeds
    const extended = await createPoolLoader(async f => new Uint8Array(readFileSync(join(PUBLIC, "pool", f)))).players(gender, ["senior"]);
    const pairings = real.fixtures.map(([a, b, n], i) => {
      const series = createSeries({ format: "t20i", gender, nations: [a, b], length: 1, host: "neutral", userSide: null, seed: 1000 + i }, FILE, ACTIVITY, extended);
      return { series, squads: seriesSquads(series, FILE, extended), n };
    });
    const play = (live: boolean): Acc => {
      const acc = newAcc();
      pairings.forEach(({ series, squads, n }, pi) => {
        for (let j = 0; j < n * replays; j++) {
          const m = matchContext(series, 0, squads);
          const seed = 7919 * pi + 104729 * j + 17;
          const [home, away]: [Team, Team] = [m.home, m.away];
          if (!live) {
            const r = simulateMatch(home, away, m.rules!, seed, { countTowardStandings: false, neutralVenue: true });
            const decided = r.winnerId && r.margin !== "Super Over" ? r.winnerId === r.innings[0].teamId : null;
            addMatch(acc, r.innings as Inn[], decided);
          } else {
            const { state } = simulateRemaining(createMatchState(home, away, m.rules!, null, seed, { neutralVenue: true }));
            const raws = [state._internal.innings1Raw, state._internal.currentInningsRaw].filter(Boolean) as Inn[];
            addMatch(acc, raws, state.winnerId && !state.superOvers ? state.winnerId === state._internal.battingFirstId : null);
          }
        }
      });
      return acc;
    };

    for (let it = 0; it < iters; it++) {
      const sim = shares(play(false));
      // full steps first, then half steps (the small classes are noisy)
      const step = it < 3 ? 1 : 0.5;
      for (const p of PHASES) {
        for (const c of CLASSES) {
          const r = real.phaseShares[p][c], s = sim[p][c];
          if (!(s > 0) || !(r > 0)) continue;
          ctx[p][c] = (ctx[p][c] ?? 1) * (r / s) ** step;
        }
      }
      const err = Math.max(...PHASES.flatMap(p => CLASSES.filter(c => real.phaseShares[p][c] > 0).map(c => Math.abs(sim[p][c] / real.phaseShares[p][c] - 1))));
      console.log(`${gender} round ${it + 1}: largest class-share error before this round ${(100 * err).toFixed(1)}%`);
    }

    console.log(`| ${gender} | 1st inns (sd) | 200+ | RR 1-6 / 7-15 / 16-20 | 1st inns wkts / all out | 2nd inns | bat 1st wins | extras/inn | 4s / 6s per inn |`);
    console.log(realRow("real", real));
    console.log(row(`instant${process.env.CAL_NOCONTEXT ? " (no context)" : ""}`, summary(play(false))));
    if (process.env.CAL_LIVE) console.log(row(`live CPU${process.env.CAL_NOCONTEXT ? " (no context)" : ""}`, summary(play(true))));
  }

  if (process.env.CALIBRATE_WRITE) {
    writeFileSync(OUT, `/**
 * GENERATED by packages/app/src/__tests__/calibrate-contexts.test.ts (CALIBRATE_T20I=1 CALIBRATE_WRITE=1) from
 * docs/data/t20i_validation.json. Do not edit by hand.
 *
 * The T20I context: per gender and phase, a multiplier on each outcome class of the T20 ball model, fitted so national
 * sides playing T20Is reproduce real T20Is between full members since 2019 (scoring-context.ts).
 */
import type { T20Context } from "./scoring-context.js";

export const T20I_CONTEXT: Record<"male" | "female", T20Context> = {
  male: ${fmtContext(T20I_CONTEXT.male)},
  female: ${fmtContext(T20I_CONTEXT.female)},
};
`);
    console.log(`wrote ${OUT}`);
  }
}, 3_600_000);
