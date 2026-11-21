import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { ATTACK_MODEL, IMPACT_MODEL, IPL_TEAMS, LEAGUE_LEVELS, RULE_PRESETS, Team, createPlayerFromData, isOverseasIn, simulateMatch, type BallEvent, type MatchResult, type Player, type RuleSet } from "@ipl-sim/engine";
import { createGameState } from "../game-state";
import { prepareLeaguePool } from "../extended-pool";
import { getPoolPlayers, getRealPlayers } from "@ipl-sim/ratings/dist/real-players.js";
import { toRealPlayerData } from "@ipl-sim/ratings/dist/extended-pool.js";
import { createPoolLoader } from "../extended-pool";

/**
 * The Impact Player (docs/TACTICS.md section 9).
 *   IMP_OUT=/path/rows.json: every side of every IPL match since 2023 (docs/data/impact_player.json, generate-impact-player.ts) with its
 *   players rated as the game rates them and the rest of its season squad (the union of the franchise's twelves that season, a player
 *   available between his first and last match), for packages/ratings/src/analysis/impact-player.py.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const PUBLIC = join(HERE, "..", "..", "public");

export interface ImpSide { team: string; inn: number; xi: (string | null)[]; names: string[]; bat: number[]; balls: number[]; ov: number[]; sub: { inn: number; over: number; ball: number; wkts: number; runs: number; in: number; out: number; batting: boolean } | null }
export interface ImpMatch { id: string; date: string; season: string; venue: string; city: string | null; toss: { winner: string; decision: string }; batFirst: string | null; winner: string | null; result: string | null; method: string | null; fow: [number, number, number][][]; overs: number[]; runs: number[]; sides: ImpSide[] }

const ID = (p: Player) => p.sourceId ?? p.id;
function row(p: Player) {
  return { id: ID(p), bat: p.battingOvr, tim: p.ratings.timing, bowl: p.bowlingOvr, ovr: p.overall, fld: p.ratings.fielding, wk: p.isWicketKeeper ? 1 : 0, os: p.isInternational ? 1 : 0, role: p.role, style: p.bowlingStyle };
}

export async function ratedPlayers() {
  const loader = createPoolLoader(async f => new Uint8Array(readFileSync(join(PUBLIC, "pool", f))));
  const data = new Map<string, Parameters<typeof createPlayerFromData>[0]>();
  for (const p of await loader.players("men", ["senior", "tier0"])) data.set(p.id, { ...toRealPlayerData(p), id: p.id });
  for (const p of [...getRealPlayers(), ...getPoolPlayers()]) data.set(p.id, { ...p, teamId: undefined, bid: undefined });
  return (id: string): Player | undefined => {
    const d = data.get(id);
    if (!d) return undefined;
    const p = createPlayerFromData(d);
    p.isInternational = isOverseasIn("ipl", d.country);
    return p;
  };
}

export function loadImpactMatches(): ImpMatch[] {
  return JSON.parse(readFileSync(join(REPO, "docs", "data", "impact_player.json"), "utf-8")) as ImpMatch[];
}

it.skipIf(!process.env.IMP_OUT)("impact player: rows for the fit", async () => {
  const OUT = process.env.IMP_OUT!;
  mkdirSync(dirname(OUT), { recursive: true });
  const ms = loadImpactMatches();
  const make = await ratedPlayers();
  const cache = new Map<string, Player | undefined>();
  const player = (id: string) => { if (!cache.has(id)) cache.set(id, make(id)); return cache.get(id); };
  // season squads and when each player was available
  const span = new Map<string, Map<string, [string, string]>>();
  for (const m of ms) for (const s of m.sides) {
    const key = `${m.season}|${s.team}`;
    if (!span.has(key)) span.set(key, new Map());
    const sp = span.get(key)!;
    for (const id of s.xi) if (id) { const w = sp.get(id); sp.set(id, w ? [w[0] < m.date ? w[0] : m.date, w[1] > m.date ? w[1] : m.date] : [m.date, m.date]); }
  }
  const out: unknown[] = [];
  for (const m of ms) for (const s of m.sides) {
    const sp = span.get(`${m.season}|${s.team}`)!;
    const bench = [...sp.entries()].filter(([id, w]) => !s.xi.includes(id) && w[0] <= m.date && m.date <= w[1]).map(([id]) => id);
    out.push({
      id: m.id, date: m.date, season: m.season, team: s.team, batFirst: m.batFirst === s.team, toss: m.toss.winner === s.team ? m.toss.decision : null,
      winner: m.winner, result: m.result, fow: m.fow[s.inn] ?? [], sub: s.sub, bat: s.bat, balls: s.balls, ov: s.ov, inn: s.inn,
      players: s.xi.map(id => (id && player(id) ? row(player(id)!) : null)),
      bench: bench.map(id => player(id)).filter((p): p is Player => !!p).map(row),
    });
  }
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`wrote ${out.length} sides`);
}, 1_800_000);

/** The engine's IPL innings and impact subs: per innings the bowling shape, per side the kind of sub, who came on and the eleven in the field */
export function impactTally(results: { r: MatchResult; byId: Map<string, Player> }[]) {
  const t = { inns: 0, used: 0, six: 0, seven: 0, part: 0, extras: 0, runs: 0, wkts: 0, n: 0, kinds: {} as Record<string, number>, f6: 0, f7: 0, nf: 0, yBowl: 0, yBat: 0, ny: 0, xBat: 0, nx: 0 };
  for (const { r, byId } of results) {
    for (const inn of r.innings) {
      const overs = new Map<number, string>();
      for (const e of inn.ballLog as BallEvent[]) if (!overs.has(e.over)) overs.set(e.over, e.bowler);
      if (overs.size >= 19) {
        const bowlers = [...overs.values()];
        const n = new Set(bowlers).size;
        t.inns++; t.used += n; t.six += +(n >= 6); t.seven += +(n >= 7);
        t.part += bowlers.filter(b => (byId.get(b)?.bowlingOvr ?? 0) < 50).length;
      }
      t.extras += inn.extras; t.runs += inn.runs; t.wkts += inn.wickets; t.n++;
    }
    if (r.innings.length < 2) continue;
    const all = r.innings.flatMap((inn, q) => (inn.impactSubs ?? (inn.impactSub ? [inn.impactSub] : [])).map(s => ({ s, q, team: s.side === "batting" ? inn.teamId : r.innings[1 - q].teamId })));
    for (const q of [0, 1]) {
      const team = r.innings[q].teamId;
      const own = all.find(x => x.team === team);
      const kind = !own ? "none" : q === 1 ? "chase" : own.q === 0 ? "batfirst-mid" : "batfirst-break";
      const key = (q === 0 ? "bf:" : "ch:") + kind;
      t.kinds[key] = (t.kinds[key] ?? 0) + 1;
      const bat = [...r.innings[q].batterStats.keys()];
      let field = bat;
      if (own) {
        const yid = kind === "chase" ? own.s.subOut : own.s.subIn, xid = kind === "chase" ? own.s.subIn : own.s.subOut;
        field = [...bat.filter(id => id !== xid && id !== yid), yid];
        const y = byId.get(yid), x = byId.get(xid);
        if (y) { t.yBowl += y.bowlingOvr; t.yBat += y.battingOvr; t.ny++; }
        if (x) { t.xBat += x.battingOvr; t.nx++; }
      }
      if (field.length === 11) {
        const b = field.map(id => byId.get(id)?.bowlingOvr ?? 0).sort((x, y) => y - x);
        t.f6 += b[5]; t.f7 += b[6]; t.nf++;
      }
    }
  }
  return t;
}

/**
 * IMP_SIM=1 [IMP_MATCHES=2000] [IMPACT_OFF=1] [ATTACK_OFF=1]: the game's IPL squads, random pairings, no injuries: the bowling shape of
 * innings of 19+ overs (bowlers used, six or more, seven or more, overs by bowlers rated under 50), extras, runs and wickets an
 * innings, the kinds of impact sub, the bowling eleven's sixth and seventh bowlers, and who came on.
 */
it.skipIf(!process.env.IMP_SIM)("impact player: the engine's IPL", async () => {
  if (process.env.IMPACT_OFF) IMPACT_MODEL.off = true;
  if (process.env.ATTACK_OFF) ATTACK_MODEL.except = ["ipl"];
  const N = Number(process.env.IMP_MATCHES ?? 2000);
  const loader = (await import("../extended-pool")).createPoolLoader(async f => new Uint8Array(readFileSync(join(PUBLIC, "pool", f))));
  await prepareLeaguePool("ipl", loader);
  const rules = { ...RULE_PRESETS.modern2026, injuriesEnabled: false } as RuleSet;
  const teams = createGameState(rules).teams;
  const res: { r: MatchResult; byId: Map<string, Player> }[] = [];
  for (let i = 0; i < N; i++) {
    const home = teams[i % teams.length];
    let away = teams[(i * 7 + 3) % teams.length];
    if (away === home) away = teams[(i * 7 + 4) % teams.length];
    const r = simulateMatch(home, away, rules, 9000 + i, { countTowardStandings: false });
    res.push({ r, byId: new Map<string, Player>([...home.roster, ...away.roster].map(p => [p.id, p])) });
  }
  const t = impactTally(res);
  const n = t.inns;
  console.log(JSON.stringify({ matches: N, innings: n, used: (t.used / n).toFixed(2), six: (t.six / n).toFixed(3), seven: (t.seven / n).toFixed(3), part: (t.part / n).toFixed(2),
    extras: (t.extras / t.n).toFixed(2), runs: (t.runs / t.n).toFixed(1), wkts: (t.wkts / t.n).toFixed(2), kinds: t.kinds,
    yBowl: (t.yBowl / Math.max(1, t.ny)).toFixed(1), yBat: (t.yBat / Math.max(1, t.ny)).toFixed(1), xBat: (t.xBat / Math.max(1, t.nx)).toFixed(1),
    field67: [(t.f6 / t.nf).toFixed(1), (t.f7 / t.nf).toFixed(1)] }));
}, 3_600_000);

const HOME_CITIES: Record<string, string[]> = {
  srh: ["Hyderabad"], dc: ["Delhi", "Visakhapatnam"], rcb: ["Bengaluru", "Bangalore"], kkr: ["Kolkata"], rr: ["Jaipur", "Guwahati"], csk: ["Chennai"],
  mi: ["Mumbai"], pbks: ["Mohali", "Dharamsala", "New Chandigarh", "Chandigarh"], gt: ["Ahmedabad"], lsg: ["Lucknow"],
};
const teamIdOf = (name: string) => IPL_TEAMS.find(t => t.name === name || (name.startsWith("Royal Challengers") && t.id === "rcb"))?.id;

/** A side of a real match as the benchmark plays it: the eleven that batted (in the real batting order) and the twelfth as the bench */
export function benchSide(m: ImpMatch, s: ImpSide, make: (id: string) => Player | undefined) {
  const ps = s.xi.map(id => (id ? make(id) : undefined));
  let off = -1;
  const sub = s.sub;
  if (sub && sub.in >= 0 && sub.out >= 0 && ps.length >= 12) off = m.batFirst === s.team ? sub.in : sub.out; // the one who did not bat for the side
  const keep = ps.map((p, j) => ({ p, j })).filter(x => x.j !== off && x.p && x.j < (off >= 0 ? 13 : 11));
  const eleven = keep.slice(0, 11).map(x => x.p!);
  const bench = off >= 0 && ps[off] ? [ps[off]!] : [];
  // the batting order: the order of the card (who batted first), then the rest
  return { eleven, bench };
}

interface Arm { name: string; impactOff: boolean; except: string[]; formerLevel?: boolean; level?: { run: number; wicket: number; dot: number } }
const ARMS: Record<string, Arm> = {
  old: { name: "former (mid-innings sub, former attack, former wicket level)", impactOff: true, except: ["ipl"], formerLevel: true },
  new: { name: "fitted impact player + attack table", impactOff: false, except: [] },
  impact: { name: "fitted impact player, former attack", impactOff: false, except: ["ipl"] },
  attack: { name: "former impact player + attack table", impactOff: true, except: [] },
};
// IPL_LEVEL='{"run":1.1,"wicket":1.1,"dot":1}': the arm "level", the shipped engine with this IPL level (LEAGUE_LEVELS.ipl)
if (process.env.IPL_LEVEL) ARMS.level = { name: `the IPL level ${process.env.IPL_LEVEL}`, impactOff: false, except: [], level: JSON.parse(process.env.IPL_LEVEL) };

/**
 * IPL_BENCH=1 [IPL_REPLAYS=256] [IPL_ARMS=old,new,impact] [IPL_DUMP=prefix]: the IPL actual-XI match benchmark. Every decided IPL match
 * since 2023 (the Impact Player era, docs/data/impact_player.json) replayed with the players who really played: each side's eleven that
 * batted, in the real batting order, the twelfth (the impact player or the man he replaced) as its only bench player; the real home side
 * (neutral when neither side is at home); the engine's own toss; the same seeds in every arm. Log loss per match of the real winner,
 * p = (wins + 1) / (replays + 2) clamped to [0.03, 0.97], on the fit half (2023-24) and the 2025+ holdout, and each arm's paired
 * difference against the first with its standard error over the matches.
 */
it.skipIf(!process.env.IPL_BENCH)("impact player: IPL actual-XI benchmark", async () => {
  const replays = Number(process.env.IPL_REPLAYS ?? 256);
  const arms = (process.env.IPL_ARMS ?? "old,new,impact").split(",").map(a => ARMS[a]);
  const make = await ratedPlayers();
  const rules = { ...RULE_PRESETS.modern2026, injuriesEnabled: false } as RuleSet;
  const shippedLevel = { ...LEAGUE_LEVELS.ipl };
  const ms = loadImpactMatches().filter(m => m.winner && m.sides.length === 2 && m.sides.every(s => teamIdOf(s.team)));
  const halves: [string, (d: string) => boolean][] = [["fit (2023-24)", d => d <= "2024-12-31"], ["holdout (2025+)", d => d >= "2025-01-01"]];
  const only = process.env.IPL_HALF;
  for (const [label, inHalf] of halves) {
    if (only && !label.startsWith(only)) continue;
    const set = ms.filter(m => inHalf(m.date));
    const loss: number[][] = arms.map(() => []);
    const extra = arms.map(() => ({ bf: 0, n: 0, runs: 0, inns: 0 }));
    const per: unknown[] = [];
    set.forEach((m, i) => {
      const ids = m.sides.map(s => teamIdOf(s.team)!);
      const homeIdx = ids.findIndex(id => HOME_CITIES[id]?.includes(m.city ?? ""));
      const order = homeIdx === 1 ? [1, 0] : [0, 1];
      const row: Record<string, unknown> = { id: m.id, date: m.date, winner: m.winner, home: homeIdx < 0 ? -1 : order.indexOf(homeIdx) === 0 ? 0 : 1, toss: m.toss, batFirst: m.batFirst, venue: m.venue, city: m.city };
      // the two sides in play order with their strengths (the eleven that batted): overall, top-7 batting, top-5 bowling
      row.sides = order.map(k => {
        const el = benchSide(m, m.sides[k], make).eleven;
        const top = (v: number[], n: number) => v.sort((x, y) => y - x).slice(0, n).reduce((x, y) => x + y, 0) / Math.max(1, Math.min(n, v.length));
        return { name: m.sides[k].team, ovr: top(el.map(p => p.overall), 11), bat: top(el.map(p => p.battingOvr), 7), bowl: top(el.map(p => p.bowlingOvr), 5), os: el.filter(p => p.isInternational).length };
      });
      arms.forEach((arm, a) => {
        IMPACT_MODEL.off = arm.impactOff;
        ATTACK_MODEL.except = arm.except;
        // the former engine had no IPL level of its own (the wicket level 1.0)
        if (arm.formerLevel) delete LEAGUE_LEVELS.ipl; else LEAGUE_LEVELS.ipl = { ...(arm.level ?? shippedLevel) };
        const teams = order.map(k => {
          const s = m.sides[k];
          const t = new Team(IPL_TEAMS.find(c => c.id === ids[k])!);
          const { eleven, bench } = benchSide(m, s, make);
          t.roster = [...eleven, ...bench];
          t.isUserControlled = true;
          t.userPlayingXI = eleven.map(p => p.id);
          t.userBattingOrder = eleven.map(p => p.id);
          return { t, name: s.team };
        });
        let w = 0, n = 0;
        for (let j = 0; j < replays; j++) {
          const r = simulateMatch(teams[0].t, teams[1].t, rules, 7919 * i + 104729 * (j + 1), { countTowardStandings: false, neutralVenue: homeIdx < 0 });
          if (!r.winnerId) continue;
          n++;
          const winName = r.winnerId === teams[0].t.id ? teams[0].name : teams[1].name;
          if (winName === m.winner) w++;
          extra[a].n++; if (r.winnerId === r.innings[0].teamId) extra[a].bf++;
          for (const inn of r.innings) { extra[a].runs += inn.runs; extra[a].inns++; }
        }
        const p = Math.min(0.97, Math.max(0.03, (w + 1) / (n + 2)));
        loss[a].push(-Math.log(p));
        row[Object.keys(ARMS).find(k => ARMS[k] === arm)!] = [w, n];
      });
      per.push(row);
    });
    const mean = (v: number[]) => v.reduce((x, y) => x + y, 0) / v.length;
    const sd = (v: number[]) => { const mu = mean(v); return Math.sqrt(v.reduce((x, y) => x + (y - mu) ** 2, 0) / (v.length - 1)); };
    console.log(`\nIPL ${label}: ${set.length} matches, ${replays} replays`);
    arms.forEach((arm, a) => {
      const d = loss[a].map((x, k) => x - loss[0][k]);
      console.log(`  ${arm.name}: log loss ${mean(loss[a]).toFixed(4)} +- ${(sd(loss[a]) / Math.sqrt(loss[a].length)).toFixed(4)}` +
        (a > 0 ? ` | paired vs first ${mean(d) >= 0 ? "+" : ""}${mean(d).toFixed(4)} +- ${(sd(d) / Math.sqrt(d.length)).toFixed(4)}` : "") +
        ` | bat-first wins ${(extra[a].bf / extra[a].n).toFixed(3)} | runs/inns ${(extra[a].runs / extra[a].inns).toFixed(1)}`);
    });
    if (process.env.IPL_DUMP) writeFileSync(`${process.env.IPL_DUMP}-${label.startsWith("fit") ? "fit" : "hold"}.json`, JSON.stringify(per));
  }
  IMPACT_MODEL.off = false;
  ATTACK_MODEL.except = [];
  LEAGUE_LEVELS.ipl = shippedLevel;
}, 14_400_000);
