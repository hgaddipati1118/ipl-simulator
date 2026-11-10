/**
 * Per-player pitch sensitivity, estimated and validated out of sample (docs/VENUE-SENSITIVITY.md).
 *
 *   npx tsx src/pipeline/pitch-sensitivity.ts [--split 2024] [--gender male|female]
 *
 * Do players perform differently by pitch? Two venue dimensions from Cricsheet T20 matches (men, club and international, 2016
 * on): FLAT (the venue's runs per ball against the all-venue mean, shrunk: high = a flat deck) and TURNS (the share of the
 * bowlers' wickets that spin takes there against the all-venue share, shrunk). Both are measured on the training years only.
 * For each side (batter, bowler), outcome (runs per ball, wickets per ball) and dimension, every player gets, as in a Poisson
 * mixed model, log mu = log balls + alpha_player + (beta_class + b_player) z_venue, the slope b_player a random effect
 * (empirical Bayes: shrunk toward the class mean by its sampling variance and the between-player variance tau^2, which is
 * estimated by moments), the class being pace or spin for a bowler and "all" for a batter. Validated on the years after the split:
 * the Poisson log-likelihood of every (player, venue, year) cell of the later years with the player's slope against without it
 * (class slope only). A slope ships only if it helps there.
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";

const ROOT = new URL("../../", import.meta.url).pathname;
const DIR = `${ROOT}data/analysis/`;
const arg = (n: string, d: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const SPLIT = Number(arg("--split", "2024"));
const GENDER = arg("--gender", "male");
const K_VENUE_BALLS = 3000, K_VENUE_WKTS = 60;

function duck<T>(sql: string): T[] {
  const out = execFileSync("duckdb", ["-json", "-c", sql], { encoding: "utf-8", cwd: DIR, maxBuffer: 2 * 1024 * 1024 * 1024 });
  return JSON.parse(out || "[]") as T[];
}

interface Cell { pid: string; venue: string; yr: number; balls: number; runs: number; wkts: number; spinW: number }
const cellsFor = (side: "bat" | "bowl") => duck<Cell>(`
SELECT d.${side === "bat" ? "batter_id" : "bowler_id"} pid, coalesce(m.venue, '?') || '|' || coalesce(m.city, '') venue, year(m.date)::INT yr,
  sum(CASE WHEN d.wides = 0 ${side === "bowl" ? "AND d.noballs = 0" : ""} THEN 1 ELSE 0 END)::BIGINT balls,
  sum(${side === "bat" ? "d.runs_batter" : "d.runs_batter + d.wides + d.noballs"})::BIGINT runs,
  sum(CASE WHEN d.is_wicket = 1 AND ${side === "bat" ? "d.player_out_id = d.batter_id AND d.wicket_kind NOT IN ('retired hurt', 'retired not out')" : "d.wicket_kind IN ('bowled', 'caught', 'lbw', 'stumped', 'caught and bowled', 'hit wicket')"} THEN 1 ELSE 0 END)::BIGINT wkts,
  0::BIGINT spinW
FROM 'deliveries.parquet' d JOIN 'matches.parquet' m USING(match_id)
WHERE m.match_type IN ('T20', 'IT20') AND m.gender = '${GENDER}' AND m.date >= DATE '2016-01-01' AND d.super_over = 0 GROUP BY 1, 2, 3`);

function main() {
  // bowling type per player: ESPN profile bowling style (spin or pace)
  const espn = JSON.parse(readFileSync(`${ROOT}data/scraped/espn-players.json`, "utf8")) as { profile: { espnId: number; bowlingStyles?: string[] } }[];
  const spinById = new Map<number, boolean>();
  for (const p of espn) { const s = p.profile.bowlingStyles?.[0]; if (s) spinById.set(p.profile.espnId, /break|orthodox|spin|googly|wrist/i.test(s)); }
  const people = duck<{ pid: string; ci: string }>(`SELECT identifier pid, key_cricinfo ci FROM read_csv('../cricsheet/people.csv', header=true, all_varchar=true) WHERE key_cricinfo IS NOT NULL`);
  const spinOf = new Map<string, boolean>();
  for (const p of people) { const s = spinById.get(Number(p.ci)); if (s !== undefined) spinOf.set(p.pid, s); }

  const bat = cellsFor("bat"), bowl = cellsFor("bowl");
  // venue measures on the training years only
  const train = (c: Cell) => c.yr < SPLIT;
  const venueRuns = new Map<string, { balls: number; runs: number }>();
  for (const c of bowl.filter(train)) { const v = venueRuns.get(c.venue) ?? { balls: 0, runs: 0 }; v.balls += c.balls; v.runs += c.runs; venueRuns.set(c.venue, v); }
  const gBalls = [...venueRuns.values()].reduce((s, v) => s + v.balls, 0), gRuns = [...venueRuns.values()].reduce((s, v) => s + v.runs, 0);
  const flat = new Map<string, number>();
  for (const [v, x] of venueRuns) flat.set(v, Math.log((x.runs / x.balls) / (gRuns / gBalls)) * (x.balls / (x.balls + K_VENUE_BALLS)));
  const venueSpin = new Map<string, { w: number; sw: number }>();
  for (const c of bowl.filter(train)) {
    const sp = spinOf.get(c.pid); if (sp === undefined) continue;
    const v = venueSpin.get(c.venue) ?? { w: 0, sw: 0 }; v.w += c.wkts; if (sp) v.sw += c.wkts; venueSpin.set(c.venue, v);
  }
  const gW = [...venueSpin.values()].reduce((s, v) => s + v.w, 0), gSW = [...venueSpin.values()].reduce((s, v) => s + v.sw, 0);
  const turns = new Map<string, number>();
  for (const [v, x] of venueSpin) turns.set(v, ((x.sw + (gSW / gW) * K_VENUE_WKTS) / (x.w + K_VENUE_WKTS) - gSW / gW) * 4); // x4: about one unit of sd
  const sd = (m: Map<string, number>) => { const xs = [...m.values()]; const mu = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length); };
  console.log(`${GENDER} T20, split ${SPLIT}: ${venueRuns.size} venues; flat sd ${sd(flat).toFixed(3)} (log run rate), turns sd ${sd(turns).toFixed(3)}`);

  const results: Record<string, unknown>[] = [];
  const specialists: Record<string, unknown>[] = [];
  for (const side of ["bat", "bowl"] as const) {
    for (const outcome of ["runs", "wkts"] as const) {
      for (const dim of ["flat", "turns"] as const) {
        const z = dim === "flat" ? flat : turns;
        const cells = side === "bat" ? bat : bowl;
        const classOf = (pid: string) => (side === "bowl" ? (spinOf.get(pid) === undefined ? "?" : spinOf.get(pid) ? "spin" : "pace") : "all");
        const y = (c: Cell) => (outcome === "runs" ? c.runs : c.wkts);
        // per player: training cells
        const byPlayer = new Map<string, Cell[]>();
        for (const c of cells) { if (!byPlayer.has(c.pid)) byPlayer.set(c.pid, []); byPlayer.get(c.pid)!.push(c); }
        // MLE of (alpha, slope) per player by Newton on the Poisson likelihood with a ridge `lam` on the slope around `center`
        const fit = (rows: Cell[], center: number, lam: number): { a: number; b: number; se: number } => {
          let a = Math.log((rows.reduce((s, c) => s + y(c), 0) + 0.5) / (rows.reduce((s, c) => s + c.balls, 0) + 1)), b = center;
          for (let it = 0; it < 25; it++) {
            let ga = 0, gb = -lam * (b - center), haa = 0, hab = 0, hbb = -lam;
            // gradient and Hessian of sum(y log mu - mu)
            for (const c of rows) {
              const zz = z.get(c.venue) ?? 0, mu = c.balls * Math.exp(a + b * zz);
              ga += y(c) - mu; gb += (y(c) - mu) * zz; haa -= mu; hab -= mu * zz; hbb -= mu * zz * zz;
            }
            const det = haa * hbb - hab * hab || -1e-9;
            const da = (ga * hbb - gb * hab) / det, db = (gb * haa - ga * hab) / det;
            a -= da; b -= db;
            if (Math.abs(da) + Math.abs(db) < 1e-7) break;
          }
          // sampling variance of b: -(H^-1)_bb
          let haa = 0, hab = 0, hbb = -lam;
          for (const c of rows) { const zz = z.get(c.venue) ?? 0, mu = c.balls * Math.exp(a + b * zz); haa -= mu; hab -= mu * zz; hbb -= mu * zz * zz; }
          const det = haa * hbb - hab * hab;
          return { a, b, se: Math.sqrt(Math.abs(haa / det)) };
        };
        const MIN_BALLS = 300;
        const players = [...byPlayer].map(([pid, rows]) => ({ pid, cls: classOf(pid), tr: rows.filter(train), te: rows.filter(c => !train(c)) }))
          .filter(p => p.cls !== "?" && p.tr.reduce((s, c) => s + c.balls, 0) >= MIN_BALLS);
        // raw slopes (a weak ridge for stability), class means by inverse variance, tau^2 by moments
        const raw = players.map(p => ({ p, ...fit(p.tr, 0, 1e-6) })).filter(r => Number.isFinite(r.b) && Number.isFinite(r.se) && r.se < 5);
        const classes = [...new Set(raw.map(r => r.p.cls))];
        const betaOf = new Map<string, number>(), tau2Of = new Map<string, number>();
        for (const c of classes) {
          const rs = raw.filter(r => r.p.cls === c);
          const w = rs.map(r => 1 / (r.se * r.se));
          const beta = rs.reduce((s, r, i) => s + w[i] * r.b, 0) / w.reduce((a, b) => a + b, 0);
          const q = rs.reduce((s, r, i) => s + w[i] * (r.b - beta) ** 2, 0), dfw = rs.length - 1;
          const tau2 = Math.max(0, (q - dfw) / (w.reduce((a, b) => a + b, 0) - w.reduce((a, b) => a + b * b, 0) / w.reduce((a, b) => a + b, 0)));
          betaOf.set(c, beta); tau2Of.set(c, tau2);
        }
        // held-out likelihood: class slope only against the player's EB slope, at the estimated tau and at fractions of it (a shrinkage
        // that is too weak overfits; if no fraction beats the class slope there is no slope worth shipping)
        const SCALES = [0.1, 0.25, 0.5, 1];
        const lik = (yy: number, mu: number) => (yy > 0 ? yy * Math.log(mu) : 0) - mu;
        let ll0 = 0, balls = 0;
        const llS = SCALES.map(() => 0);
        for (const r of raw) {
          const beta = betaOf.get(r.p.cls)!, tau2 = tau2Of.get(r.p.cls)!;
          const m0 = fit(r.p.tr, beta, 1e9);
          const ms = SCALES.map(sc => fit(r.p.tr, beta, tau2 > 0 ? 1 / (tau2 * sc * sc) : 1e9));
          if (![m0, ...ms].every(m => Number.isFinite(m.a) && Number.isFinite(m.b))) continue;
          for (const c of r.p.te) {
            if (c.balls === 0) continue;
            const zz = z.get(c.venue) ?? 0;
            ll0 += lik(y(c), c.balls * Math.exp(m0.a + m0.b * zz)); balls += c.balls;
            ms.forEach((m, k) => { llS[k] += lik(y(c), c.balls * Math.exp(m.a + m.b * zz)); });
          }
          if (outcome === "runs" && tau2 > 0) {
            const m = ms[SCALES.length - 1];
            specialists.push({ side, dim, pid: r.p.pid, cls: r.p.cls, balls: r.p.tr.reduce((s, c) => s + c.balls, 0), rawSlope: +r.b.toFixed(3), se: +r.se.toFixed(3), shrunk: +(m.b - beta).toFixed(3) });
          }
        }
        const gains = llS.map(l => +(((l - ll0) / Math.max(1, balls)) * 1000).toFixed(4));
        const res = { side, outcome, dim, players: raw.length, classes: Object.fromEntries(classes.map(c => [c, { beta: +betaOf.get(c)!.toFixed(3), tau: +Math.sqrt(tau2Of.get(c)!).toFixed(3) }])), testBalls: balls, gainPer1000BallsByTauFraction: Object.fromEntries(SCALES.map((sc, k) => [sc, gains[k]])) };
        console.log(JSON.stringify(res));
        results.push(res);
      }
    }
  }
  writeFileSync(`${DIR}pitch_sensitivity_${GENDER}.json`, JSON.stringify({ split: SPLIT, results, specialists }));
}
main();
