/**
 * International top-up of the extended pool: every player with an international appearance (any format, men and women) for
 * one of the app's nations since 2024-01-01 who is in neither the ESPN pool (all-players.ts / wpl-players.ts) nor the
 * extended pool, rated from Cricsheet alone.
 *
 *   npx tsx src/pipeline/generate-intl-pool.ts [--dry]
 *
 * Inputs (data/analysis/): deliveries.parquet, matches.parquet (Cricsheet), data/cricsheet/people.csv (ids and names),
 *   data/scraped/espn-players.json (ESPN profiles: birth date, batting hand, bowling style, role, where the player has one),
 *   the shipped pools and shards (the reference set), app/public/data/format-ratings.json.
 * Output: rows appended to app/public/pool/ca-<men|women>-senior.json.gz (ids `ca_9<ESPN id>`: 9e9 + the Cricinfo id, so a
 *   row never collides with a CricketArchive id), each with ODI and Test sets; rows of an earlier run are replaced.
 *
 * Method (a player the pool lacks has little or no T20 record, often a Test or ODI career only):
 *  1. Per format (T20 = T20 + IT20, ODI = ODI + ODM, Test = Test + MDM; Cricsheet since 2016) his batting (balls, runs,
 *     dismissals, fours, sixes) and bowling (legal balls, runs, wickets) records.
 *  2. A format's side score is a shrunk log-rate against the format's average, with the prior at the 25th percentile of the
 *     pooled players' rates (a player the pool does not have is below the pooled ones until his record says otherwise):
 *     batting log(runs per ball) - 0.6 log(dismissals per ball), bowling 0.6 log(wickets per ball) - log(runs per ball).
 *  3. The score maps to the game's rating by a linear fit on the players the pool does have (their score against their
 *     T20 / ODI / Test overall, per gender, format and side); a side the player does not do is the fit's value for a
 *     non-regular. A format with no record of his own is derived from his other formats through a fit of that format's
 *     overall on the other (players who have both), shrunk to the format's median.
 *  4. The eight attributes are the average of the five pooled players of his gender nearest in (batting, bowling) overall,
 *     then shifted together until each side hits the overall (model-ratings.ts shiftTo).
 *  5. Role from the two overalls (calculator.ts inferRole); hand, bowling style, date of birth and keeper from his ESPN
 *     profile where he has one (about half), else right-handed, a medium-pace bowler (spin if his ESPN role says) and 27.
 */
import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { gunzipSync, gzipSync } from "zlib";
import { calculateBattingOverall, calculateBowlingOverall, type PlayerRatings } from "@ipl-sim/engine";
import { inferRole } from "../calculator.js";
import { ALL_PLAYERS } from "../all-players.js";
import { WPL_PLAYERS } from "../wpl-players.js";
import { decodeShard, encodeShard, type PoolRow, type PoolShard } from "../extended-pool.js";
import { CORE_KEYS, encodeSet, type FormatRatingsFile } from "../format-ratings.js";
import { shiftTo } from "./model-ratings.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const DIR = `${ROOT}data/analysis/`;
const POOL_DIR = new URL("../../../app/public/pool/", import.meta.url).pathname;
const FR_FILE = new URL("../../../app/public/data/format-ratings.json", import.meta.url).pathname;
const DRY = process.argv.includes("--dry");
const ID_BASE = 9_000_000_000;
const SINCE = "2024-01-01";
const NATIONS = ["India", "Australia", "England", "South Africa", "New Zealand", "Pakistan", "Sri Lanka", "West Indies", "Bangladesh", "Afghanistan", "Zimbabwe", "Ireland",
  "Netherlands", "Scotland", "Nepal", "United Arab Emirates", "United States of America", "Namibia", "Oman", "Canada", "Kenya", "Thailand"];
const COUNTRY: Record<string, string> = { "United Arab Emirates": "UAE", "United States of America": "USA" };
type Fmt = "t20" | "odi" | "test";
const FMTS: Fmt[] = ["t20", "odi", "test"];
const MT: Record<Fmt, string[]> = { t20: ["T20", "IT20"], odi: ["ODI", "ODM"], test: ["Test", "MDM"] };
type Gender = "male" | "female";
type Side = "bat" | "bowl";

function duck<T>(sql: string): T[] {
  const out = execFileSync("duckdb", ["-json", "-c", sql], { encoding: "utf-8", cwd: DIR, maxBuffer: 2 * 1024 * 1024 * 1024 });
  return JSON.parse(out || "[]") as T[];
}

interface Person { pid: string; name: string; team: string; gender: Gender; n: number; fmts: string[]; ci: string | null; ca: string | null; lastday: string }
interface Rec { bat?: { balls: number; runs: number; outs: number; fours: number; sixes: number }; bowl?: { balls: number; runs: number; wkts: number } }

const players = (): Person[] => duck<Person>(`
WITH pm AS (SELECT d.match_id, d.batter_id pid, d.batting_team team FROM 'deliveries.parquet' d UNION SELECT d.match_id, d.non_striker_id, d.batting_team FROM 'deliveries.parquet' d
  UNION SELECT d.match_id, d.bowler_id, d.bowling_team FROM 'deliveries.parquet' d),
m AS (SELECT match_id, match_type, gender, date FROM 'matches.parquet' WHERE team_type = 'international' AND date >= DATE '${SINCE}'),
pp AS (SELECT pm.pid, pm.team, m.gender, m.match_type, count(DISTINCT pm.match_id) n, max(m.date) lastd FROM pm JOIN m USING(match_id) GROUP BY ALL)
SELECT pp.pid, p.name, pp.team, pp.gender, sum(pp.n)::BIGINT n, list(DISTINCT pp.match_type) fmts, any_value(p.key_cricinfo) ci, any_value(p.key_cricketarchive) ca, strftime(max(pp.lastd), '%Y-%m-%d') lastday
FROM pp LEFT JOIN read_csv('../cricsheet/people.csv', header=true, all_varchar=true) p ON p.identifier = pp.pid
WHERE pp.team IN (${NATIONS.map(n => `'${n}'`).join(",")}) GROUP BY pp.pid, p.name, pp.team, pp.gender`);

/** Cricsheet records per player and format (matches since 2016), keyed `pid|fmt` */
function records(): Map<string, Rec> {
  const out = new Map<string, Rec>();
  for (const fmt of FMTS) {
    const types = MT[fmt].map(t => `'${t}'`).join(",");
    const bat = duck<{ pid: string; balls: number; runs: number; outs: number; fours: number; sixes: number }>(`
SELECT d.batter_id pid, sum(CASE WHEN d.wides = 0 THEN 1 ELSE 0 END)::BIGINT balls, sum(d.runs_batter)::BIGINT runs,
  sum(CASE WHEN d.is_wicket = 1 AND d.player_out_id = d.batter_id AND d.wicket_kind NOT IN ('retired hurt', 'retired not out') THEN 1 ELSE 0 END)::BIGINT outs,
  sum(CASE WHEN d.runs_batter = 4 THEN 1 ELSE 0 END)::BIGINT fours, sum(CASE WHEN d.runs_batter = 6 THEN 1 ELSE 0 END)::BIGINT sixes
FROM 'deliveries.parquet' d JOIN 'matches.parquet' m USING(match_id) WHERE m.match_type IN (${types}) AND m.date >= DATE '2016-01-01' AND d.super_over = 0 GROUP BY 1`);
    const bowl = duck<{ pid: string; balls: number; runs: number; wkts: number }>(`
SELECT d.bowler_id pid, sum(CASE WHEN d.wides = 0 AND d.noballs = 0 THEN 1 ELSE 0 END)::BIGINT balls, sum(d.runs_batter + d.wides + d.noballs)::BIGINT runs,
  sum(CASE WHEN d.is_wicket = 1 AND d.wicket_kind IN ('bowled', 'caught', 'lbw', 'stumped', 'caught and bowled', 'hit wicket') THEN 1 ELSE 0 END)::BIGINT wkts
FROM 'deliveries.parquet' d JOIN 'matches.parquet' m USING(match_id) WHERE m.match_type IN (${types}) AND m.date >= DATE '2016-01-01' AND d.super_over = 0 GROUP BY 1`);
    for (const b of bat) out.set(`${b.pid}|${fmt}`, { bat: b });
    for (const b of bowl) { const r = out.get(`${b.pid}|${fmt}`) ?? {}; r.bowl = b; out.set(`${b.pid}|${fmt}`, r); }
  }
  return out;
}

const log = Math.log;
interface Prior { rpb: number; opb: number; wpb: number; brpb: number; rpb0: number; opb0: number; wpb0: number; brpb0: number }
const K_BAT = 150, K_BOWL = 180;

/** The side's score (see the header), with the shrinkage prior `p` (rates of the pooled players' 25th percentile) and the format's average */
function score(side: Side, r: Rec | undefined, p: Prior): number {
  if (side === "bat") {
    const b = r?.bat;
    const balls = b?.balls ?? 0;
    const rpb = ((b?.runs ?? 0) + p.rpb * K_BAT) / (balls + K_BAT), opb = ((b?.outs ?? 0) + p.opb * K_BAT) / (balls + K_BAT);
    return log(rpb / p.rpb0) - 0.6 * log(opb / p.opb0);
  }
  const b = r?.bowl;
  const balls = b?.balls ?? 0;
  const wpb = ((b?.wkts ?? 0) + p.wpb * K_BOWL) / (balls + K_BOWL), rpb = ((b?.runs ?? 0) + p.brpb * K_BOWL) / (balls + K_BOWL);
  return 0.6 * log(wpb / p.wpb0) - log(rpb / p.brpb0);
}

function ols(xs: number[], ys: number[]): { a: number; b: number; r: number } {
  const n = xs.length, mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: my - b * mx, b, r: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0 };
}
/** y = a + b1 x1 + b2 x2 by the normal equations */
function ols2(x1: number[], x2: number[], ys: number[]): { a: number; b1: number; b2: number; r: number } {
  const n = ys.length, m1 = x1.reduce((s, v) => s + v, 0) / n, m2 = x2.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let s11 = 0, s22 = 0, s12 = 0, s1y = 0, s2y = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const a = x1[i] - m1, b = x2[i] - m2, y = ys[i] - my;
    s11 += a * a; s22 += b * b; s12 += a * b; s1y += a * y; s2y += b * y; syy += y * y;
  }
  const det = s11 * s22 - s12 * s12 || 1;
  const b1 = (s1y * s22 - s2y * s12) / det, b2 = (s2y * s11 - s1y * s12) / det;
  return { a: my - b1 * m1 - b2 * m2, b1, b2, r: Math.sqrt(Math.max(0, (b1 * s1y + b2 * s2y) / (syy || 1))) };
}
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
/** A small record can't rate high (the pools' small-sample caps, simplified): 60 at 100 balls, 67 at 500, 72 at 1,500 */
const cap = (balls: number) => 40 + 10 * Math.log10(1 + balls);
const clampR = (x: number) => Math.max(15, Math.min(99, Math.round(x)));

interface Pooled { key: string; gender: Gender; ratings: PlayerRatings; sets: Partial<Record<Fmt, PlayerRatings>>; }

function main() {
  const people = players();
  const recs = records();
  const fr = JSON.parse(readFileSync(FR_FILE, "utf8")) as FormatRatingsFile;
  const profiles = new Map<number, { dob?: { year: number; month: number; date: number } | null; hand?: string; style?: string; role?: string }>();
  for (const p of JSON.parse(readFileSync(`${ROOT}data/scraped/espn-players.json`, "utf8")) as { profile: { espnId: number; dateOfBirth?: { year: number; month: number; date: number } | null; battingStyles?: string[]; bowlingStyles?: string[]; playingRoles?: string[] } }[])
    profiles.set(p.profile.espnId, { dob: p.profile.dateOfBirth, hand: p.profile.battingStyles?.[0], style: p.profile.bowlingStyles?.[0], role: p.profile.playingRoles?.[0] });

  // the shards (without rows of an earlier run) and the shipped players
  const shards: Record<"men" | "women", { shard: PoolShard; rows: PoolShard["rows"]; file: string }> = {} as never;
  const extIds = new Set<string>();
  const pooled: Pooled[] = [];
  /** Pool players by country, gender, surname and first initial: Cricsheet's `TA Imlach` is the pool's `Tevin Imlach` under a CricketArchive id */
  const nameKey = (name: string, country: string, g: Gender) => { const w = name.toLowerCase().normalize("NFD").replace(/[^a-z ]/g, "").split(" ").filter(Boolean); return `${country}|${g}|${w[w.length - 1]}|${w[0]?.[0]}`; };
  const byName = new Map<string, Pooled>();
  const byKey = new Map<string, Pooled>();
  for (const g of ["men", "women"] as const) {
    const file = `${POOL_DIR}ca-${g}-senior.json.gz`;
    const shard = JSON.parse(gunzipSync(readFileSync(file)).toString()) as PoolShard;
    const kept = shard.rows.filter(r => (r[0] as number) < ID_BASE);
    shards[g] = { shard, rows: kept, file };
    const dec = decodeShard({ ...shard, rows: kept });
    for (const p of dec) {
      extIds.add(p.id);
      const rec: Pooled = { key: p.id, gender: g === "men" ? "male" : "female", ratings: p.ratings, sets: {} };
      if (p.formatRatings?.odi) rec.sets.odi = p.formatRatings.odi.ratings;
      if (p.formatRatings?.test) rec.sets.test = p.formatRatings.test.ratings;
      pooled.push(rec); byKey.set(p.id, rec); byName.set(nameKey(p.name, p.country, rec.gender), rec);
    }
  }
  for (const [list, g] of [[ALL_PLAYERS, "male"], [WPL_PLAYERS, "female"]] as const) {
    for (const p of list as unknown as { id: string; sourceId?: string; name: string; country: string; ratings: PlayerRatings }[]) {
      const id = p.sourceId ?? p.id;
      const sets = fr.players[id];
      const rec: Pooled = { key: id, gender: g, ratings: p.ratings, sets: {} };
      if (sets) { for (const [i, f] of (["odi", "test"] as const).entries()) { const s = sets[i]; if (s?.length >= 9) rec.sets[f] = Object.fromEntries(CORE_KEYS.map((k, j) => [k, s[j]])) as unknown as PlayerRatings; } }
      pooled.push(rec); byKey.set(id, rec); byName.set(nameKey(p.name, p.country, g), rec);
    }
  }
  const idsOf = (p: Person) => [p.ci ? `espn_${p.ci}` : "", p.ca ? `ca_${p.ca}` : ""].filter(Boolean);
  const pooledOf = (p: Person): Pooled | undefined => idsOf(p).map(i => byKey.get(i)).find(Boolean) ?? byName.get(nameKey(p.name, COUNTRY[p.team] ?? p.team, p.gender));
  const missing = people.filter(p => !pooledOf(p));
  console.log(`${people.length} international players for the app's nations since ${SINCE}, ${missing.length} not in the pool`);

  // reference scores, priors and fits per gender, format and side
  const ratingOf = (r: Pooled, f: Fmt) => (f === "t20" ? r.ratings : r.sets[f]);
  const fits = new Map<string, { a: number; b1: number; b2: number; r: number; lo: number; n: number; prior: Prior }>();
  const ballsOf = (side: Side, r: Rec | undefined) => (side === "bat" ? r?.bat?.balls : r?.bowl?.balls) ?? 0;
  const groupsOf = (g: Gender, f: Fmt) => people.filter(p => p.gender === g).map(p => ({ p, rec: recs.get(`${p.pid}|${f}`), pl: pooledOf(p) })).filter(x => x.pl);
  for (const g of ["male", "female"] as Gender[]) for (const f of FMTS) {
    const ref = groupsOf(g, f);
    for (const side of ["bat", "bowl"] as Side[]) {
      const have = ref.filter(x => (side === "bat" ? (x.rec?.bat?.balls ?? 0) >= 120 : (x.rec?.bowl?.balls ?? 0) >= 120));
      // format average rates and the 25th percentile of the pooled players' rates (the prior)
      const rate = (num: (r: Rec) => number, den: (r: Rec) => number, pick: "bat" | "bowl") => have.map(x => num(x.rec!) / Math.max(1, den(x.rec!)));
      const pop = (num: (r: Rec) => number, den: (r: Rec) => number) => have.reduce((s, x) => s + num(x.rec!), 0) / Math.max(1, have.reduce((s, x) => s + den(x.rec!), 0));
      const prior: Prior = {
        rpb0: pop(r => r.bat?.runs ?? 0, r => r.bat?.balls ?? 0), opb0: pop(r => r.bat?.outs ?? 0, r => r.bat?.balls ?? 0),
        wpb0: pop(r => r.bowl?.wkts ?? 0, r => r.bowl?.balls ?? 0), brpb0: pop(r => r.bowl?.runs ?? 0, r => r.bowl?.balls ?? 0),
        rpb: q(rate(r => r.bat?.runs ?? 0, r => r.bat?.balls ?? 0, "bat"), 0.25), opb: q(rate(r => r.bat?.outs ?? 0, r => r.bat?.balls ?? 0, "bat"), 0.75),
        wpb: q(rate(r => r.bowl?.wkts ?? 0, r => r.bowl?.balls ?? 0, "bowl"), 0.25), brpb: q(rate(r => r.bowl?.runs ?? 0, r => r.bowl?.balls ?? 0, "bowl"), 0.75),
      };
      const xs = have.map(x => score(side, x.rec, prior));
      const ys = have.map(x => { const rt = ratingOf(x.pl!, f)!; return rt ? (side === "bat" ? calculateBattingOverall(rt) : calculateBowlingOverall(rt)) : NaN; });
      const keep = xs.map((_, i) => i).filter(i => Number.isFinite(ys[i]));
      const fit = ols2(keep.map(i => xs[i]), keep.map(i => Math.log1p(ballsOf(side, have[i].rec))), keep.map(i => ys[i]));
      // the rating of a pooled player with no record on that side (a non-bowler's bowling, etc.), at the 25th percentile
      const none = ref.filter(x => !((side === "bat" ? x.rec?.bat?.balls : x.rec?.bowl?.balls) ?? 0)).map(x => { const rt = ratingOf(x.pl!, f); return rt ? (side === "bat" ? calculateBattingOverall(rt) : calculateBowlingOverall(rt)) : NaN; }).filter(Number.isFinite);
      fits.set(`${g}|${f}|${side}`, { ...fit, lo: none.length ? q(none, 0.5) : 25, n: keep.length, prior });
      console.log(`${g} ${f} ${side}: ${keep.length} pooled players with a record, r = ${fit.r.toFixed(2)}, rating = ${fit.a.toFixed(1)} + ${fit.b1.toFixed(1)} x score + ${fit.b2.toFixed(1)} x ln(balls); no-record median ${(none.length ? q(none, 0.5) : 25).toFixed(0)}`);
    }
  }

  // neighbours for the attribute mix
  const neighbours = (g: Gender, f: Fmt, bat: number, bowl: number, k = 5): PlayerRatings[] => {
    const cand = pooled.filter(p => p.gender === g && ratingOf(p, f)).map(p => { const r = ratingOf(p, f)!; return { r, d: (calculateBattingOverall(r) - bat) ** 2 + (calculateBowlingOverall(r) - bowl) ** 2 }; });
    return cand.sort((a, b) => a.d - b.d).slice(0, k).map(c => c.r);
  };

  const rows: Record<"men" | "women", PoolRow[]> = { men: [], women: [] };
  const report: string[] = [];
  for (const p of missing) {
    const g = p.gender;
    const est = {} as Record<Fmt, { bat: number; bowl: number; data: boolean }>;
    for (const f of FMTS) {
      const r = recs.get(`${p.pid}|${f}`);
      const one = (side: Side) => {
        const fit = fits.get(`${g}|${f}|${side}`)!;
        const has = side === "bat" ? (r?.bat?.balls ?? 0) > 0 : (r?.bowl?.balls ?? 0) > 0;
        return has ? { v: Math.min(cap(ballsOf(side, r)), fit.a + fit.b1 * score(side, r, fit.prior) + fit.b2 * Math.log1p(ballsOf(side, r))), has } : { v: fit.lo, has };
      };
      const b = one("bat"), w = one("bowl");
      est[f] = { bat: b.v, bowl: w.v, data: b.has || w.has };
    }
    // a format with no record of his own follows his best other one, with the format's usual offset (the median of the pooled
    // players' difference), shrunk toward the format's no-record median
    for (const f of FMTS) {
      if (est[f].data) continue;
      const src = FMTS.filter(o => est[o].data).sort((a, b) => (recs.get(`${p.pid}|${b}`)?.bat?.balls ?? 0) + (recs.get(`${p.pid}|${b}`)?.bowl?.balls ?? 0) - (recs.get(`${p.pid}|${a}`)?.bat?.balls ?? 0) - (recs.get(`${p.pid}|${a}`)?.bowl?.balls ?? 0))[0];
      if (!src) continue;
      const reg = (side: Side) => {
        const pr = pooled.filter(x => x.gender === g && ratingOf(x, f) && ratingOf(x, src)).map(x => {
          const a = ratingOf(x, src)!, b = ratingOf(x, f)!;
          return side === "bat" ? [calculateBattingOverall(a), calculateBattingOverall(b)] : [calculateBowlingOverall(a), calculateBowlingOverall(b)];
        });
        const fit = ols(pr.map(x => x[0]), pr.map(x => x[1]));
        const sb = ballsOf(side, recs.get(`${p.pid}|${src}`));
        return Math.min(cap(sb), fit.a + fit.b * est[src][side]);
      };
      est[f] = { bat: reg("bat"), bowl: reg("bowl"), data: false };
    }
    const prof = p.ci ? profiles.get(Number(p.ci)) : undefined;
    const sets = FMTS.map(f => {
      const bat = clampR(est[f].bat), bowl = clampR(est[f].bowl);
      const base = neighbours(g, f, bat, bowl);
      const rt = Object.fromEntries(CORE_KEYS.map(k => [k, base.reduce((s, x) => s + (x[k] as number), 0) / Math.max(1, base.length)])) as unknown as PlayerRatings;
      shiftTo(rt as never, ["battingIQ", "timing", "power", "running"] as never, r => calculateBattingOverall(r as unknown as PlayerRatings), bat);
      shiftTo(rt as never, ["wicketTaking", "economy", "accuracy"] as never, r => calculateBowlingOverall(r as unknown as PlayerRatings), bowl);
      for (const k of CORE_KEYS) rt[k] = clampR(rt[k] as number);
      return { f, rt, data: est[f].data };
    });
    const t20 = sets[0].rt;
    const role = inferRole({ battingOvr: calculateBattingOverall(t20), bowlingOvr: calculateBowlingOverall(t20) } as never);
    const year = Number(p.lastday.slice(0, 4));
    const age = prof?.dob ? 2026 - prof.dob.year : 27;
    const hand = prof?.hand?.startsWith("left") ? "left" : "right";
    const spin = /break|orthodox|spin|googly|wrist/i.test(prof?.style ?? "");
    const left = /left/i.test(prof?.style ?? "");
    const style = role === "batsman" && !prof?.style ? "unknown"
      : spin ? (/orthodox/i.test(prof!.style!) ? "left-arm-orthodox" : /leg/i.test(prof!.style!) ? "leg-spin" : "off-spin")
      : /fast/i.test(prof?.style ?? "") && !/medium/i.test(prof?.style ?? "") ? (left ? "left-arm-fast" : "right-arm-fast") : left ? "left-arm-medium" : "right-arm-medium";
    const bt = recs.get(`${p.pid}|t20`)?.bat, bo = recs.get(`${p.pid}|t20`)?.bowl;
    const row: PoolRow = {
      id: ID_BASE + Number(p.ci ?? p.pid.replace(/\D/g, "").slice(0, 8) ?? 0), name: p.name, age, country: COUNTRY[p.team] ?? p.team, role: role as PoolRow["role"],
      ratings: CORE_KEYS.map(k => t20[k]) as PoolRow["ratings"], bowlingStyle: style, battingHand: hand as "left" | "right",
      isWicketKeeper: /wicket/i.test(prof?.role ?? ""), matches: p.n, runs: bt?.runs ?? 0, average: bt && bt.outs ? Math.round((bt.runs / bt.outs) * 10) / 10 : 0,
      strikeRate: bt && bt.balls ? Math.round((bt.runs / bt.balls) * 1000) / 10 : 0, wickets: bo?.wkts ?? 0, economy: bo && bo.balls ? Math.round((bo.runs / bo.balls) * 600) / 100 : 0,
      lastYear: year,
      formats: [encodeSet(sets[1].rt, sets[1].data ? "data" : "derived"), encodeSet(sets[2].rt, sets[2].data ? "data" : "derived")],
    };
    rows[g === "male" ? "men" : "women"].push(row);
    report.push(`${p.name.padEnd(22)} ${p.team.padEnd(14)} ${g[0]} n${String(p.n).padStart(3)} ${p.fmts.join("/").padEnd(14)} T20 ${calculateBattingOverall(t20)}/${calculateBowlingOverall(t20)} ODI ${calculateBattingOverall(sets[1].rt)}/${calculateBowlingOverall(sets[1].rt)} Test ${calculateBattingOverall(sets[2].rt)}/${calculateBowlingOverall(sets[2].rt)} ${role}`);
  }
  console.log(report.slice(0, 40).join("\n"));
  if (DRY) return;
  for (const g of ["men", "women"] as const) {
    const base = shards[g];
    const enc = encodeShard(g, "senior", rows[g]);
    // merge: the existing rows (re-encoded against the new country / style tables) then the new ones
    const old = decodeShard({ ...base.shard, rows: base.rows });
    void old;
    const countries = [...base.shard.countries], styles = [...base.shard.styles];
    const idx = (list: string[], v: string) => { let i = list.indexOf(v); if (i < 0) { i = list.length; list.push(v); } return i; };
    const added = enc.rows.map(r => { const x = [...r]; x[3] = idx(countries, enc.countries[r[3] as number]); x[5] = idx(styles, enc.styles[r[5] as number]); return x; });
    const merged: PoolShard = { ...base.shard, countries, styles, rows: [...base.rows, ...added] };
    writeFileSync(base.file, gzipSync(Buffer.from(JSON.stringify(merged))));
    const mf = `${POOL_DIR}manifest.json`;
    const manifest = JSON.parse(readFileSync(mf, "utf8")) as { shards: { file: string; count: number; bytes: number }[] };
    const info = manifest.shards.find(x => x.file === `ca-${g}-senior.json.gz`);
    if (info) { info.count = merged.rows.length; info.bytes = readFileSync(base.file).length; writeFileSync(mf, JSON.stringify(manifest)); }
    console.log(`${g}: ${added.length} rows added to ${base.file}`);
  }
}

if (!existsSync(DIR)) throw new Error("data/analysis missing");
main();
