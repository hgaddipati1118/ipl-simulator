import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { ATTACK_MODEL, IMPACT_MODEL, RULE_PRESETS, createPlayerFromData, isOverseasIn, simulateMatch, type BallEvent, type MatchResult, type Player, type RuleSet } from "@ipl-sim/engine";
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
