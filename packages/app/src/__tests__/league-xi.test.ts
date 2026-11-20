import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { createPlayerFromData, fieldingValueBonus, selectLeagueXI, simulateMatch, EXTRA_LEAGUES, LEAGUE_XI_SWITCH, isOverseasIn, RULE_PRESETS, Team, type BallEvent, type Player, type RuleSet } from "@ipl-sim/engine";
import { getPoolPlayers, getRealPlayers } from "@ipl-sim/ratings/dist/real-players.js";
import { toRealPlayerData } from "@ipl-sim/ratings/dist/extended-pool.js";
import { createGameState } from "../game-state";
import { createPoolLoader, prepareLeaguePool } from "../extended-pool";

/**
 * League XIs (docs/TACTICS.md section 7; skipped unless LXI_OUT is set): the XIs the men's T20 leagues really fielded
 * (docs/data/league_xi.json, packages/ratings/src/pipeline/generate-league-xi.ts) against the CPU's selection (Team.autoSelectPlayingXI)
 * from the same squads, written as json for packages/ratings/src/analysis/league-xi.py.
 *   LXI_OUT=/path/xi.json npx vitest run packages/app/src/__tests__/league-xi.test.ts
 * A real squad is the union of a franchise's XIs over a season (players who never made an XI are not in the data); the game's squads are
 * the leagues' own (createGameState, the CricketArchive records as the app loads them, prepareLeaguePool).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const PUBLIC = join(HERE, "..", "..", "public");

interface Side { team: string; xi: (string | null)[]; ov: number[]; off: number; batted: number }
interface LeagueMatch { id: string; date: string; season: string; sides: Side[] }

const ID = (p: Player) => p.sourceId ?? p.id;
function row(p: Player) {
  const fb = fieldingValueBonus({ fielding: p.ratings.fielding });
  const kb = fieldingValueBonus({ fielding: p.ratings.fielding, keeping: p.ratings.keeping, isWicketKeeper: true }) - fb;
  return { id: ID(p), bat: p.battingOvr, tim: p.ratings.timing, bowl: p.bowlingOvr, ovr: p.overall, fb, kb, wk: p.isWicketKeeper ? 1 : 0, os: p.isInternational ? 1 : 0, role: p.role };
}

it.skipIf(!process.env.LXI_OUT)("league XIs: real against the CPU's selection", async () => {
  const OUT = process.env.LXI_OUT!;
  mkdirSync(dirname(OUT), { recursive: true });
  const ACT = JSON.parse(readFileSync(join(REPO, "docs", "data", "league_xi.json"), "utf-8")) as Record<string, LeagueMatch[]>;
  const loader = createPoolLoader(async f => new Uint8Array(readFileSync(join(PUBLIC, "pool", f))));
  const data = new Map<string, Parameters<typeof createPlayerFromData>[0]>();
  for (const p of await loader.players("men", ["senior", "tier0"])) data.set(p.id, { ...toRealPlayerData(p), id: p.id });
  for (const p of [...getRealPlayers(), ...getPoolPlayers()]) data.set(p.id, { ...p, teamId: undefined, bid: undefined });
  const rulesOf = (lg: string): RuleSet => (lg === "ipl" ? RULE_PRESETS.modern2026 : EXTRA_LEAGUES.find(l => l.id === lg)!.rules) as RuleSet;
  const out: unknown[] = [];
  for (const [lg, ms] of Object.entries(ACT)) {
    const cap = rulesOf(lg).maxOverseasInXI;
    // squads: the union of the season's XIs per franchise
    const squads = new Map<string, Map<string, Player>>();
    for (const m of ms) for (const s of m.sides) {
      const key = `${m.season}|${s.team}`;
      if (!squads.has(key)) squads.set(key, new Map());
      const sq = squads.get(key)!;
      for (const id of s.xi) {
        if (!id || sq.has(id)) continue;
        const d = data.get(id);
        if (!d) continue;
        const p = createPlayerFromData(d);
        p.isInternational = isOverseasIn(lg, d.country);
        sq.set(id, p);
      }
    }
    // the CPU's XI from each real squad (fresh players: no fatigue)
    const autoOf = new Map<string, string[]>();
    for (const [key, sq] of squads) {
      const team = new Team({ id: "x", name: "x", shortName: "x", city: "", primaryColor: "", secondaryColor: "" });
      team.roster = [...sq.values()];
      autoOf.set(key, team.autoSelectPlayingXI(cap).map(ID));
    }
    for (const [key, sq] of squads) {
      const [season, team] = key.split("|");
      const sides = ms.flatMap(m => m.sides.filter(s => s.team === team && m.season === season).map(s => ({ m, s })));
      // available for a match: between the player's first and last XI of the franchise's season (late arrivals, early departures)
      const span = new Map<string, [string, string]>();
      for (const { m, s } of sides) for (const id of s.xi) if (id) { const w = span.get(id); span.set(id, w ? [w[0] < m.date ? w[0] : m.date, w[1] > m.date ? w[1] : m.date] : [m.date, m.date]); }
      out.push({
        lg, season, team, cap, squad: [...sq.values()].map(row), auto: autoOf.get(key),
        xis: sides.map(({ m, s }) => {
          const avail = [...sq.keys()].filter(id => { const w = span.get(id)!; return w[0] <= m.date && m.date <= w[1]; });
          const team = new Team({ id: "x", name: "x", shortName: "x", city: "", primaryColor: "", secondaryColor: "" });
          team.roster = avail.map(id => sq.get(id)!);
          const ps = avail.map(id => sq.get(id)!);
          return { id: m.id, date: m.date, xi: s.xi, ov: s.ov, off: s.off, avail, auto: team.autoSelectPlayingXI(cap).map(ID), drawn: selectLeagueXI(ps, cap, Number(m.id) * 2 + 1).map(ID) };
        }),
      });
    }
    console.log(`${lg}: ${squads.size} franchise-seasons`);
  }
  // the game's own squads (as the app loads them) and the CPU's XI from each
  const game: unknown[] = [];
  for (const [lg, rules] of [["ipl", RULE_PRESETS.modern2026], ...EXTRA_LEAGUES.filter(l => l.gender === "men" && l.rules.matchFormat !== "hundred").map(l => [l.id, l.rules])] as [string, RuleSet][]) {
    await prepareLeaguePool(lg, loader);
    const st = createGameState({ ...rules, injuriesEnabled: false } as RuleSet);
    for (const t of st.teams) {
      const fit = t.roster.filter(p => !p.injured);
      game.push({
        lg, team: t.id, cap: rules.maxOverseasInXI, squad: t.roster.map(row), auto: t.autoSelectPlayingXI(rules.maxOverseasInXI).map(ID),
        likely: selectLeagueXI(fit, rules.maxOverseasInXI).map(ID),
        drawn: Array.from({ length: 40 }, (_, k) => selectLeagueXI(fit, rules.maxOverseasInXI, 1000 + k).map(ID)),
      });
    }
  }
  writeFileSync(OUT, JSON.stringify({ real: out, game }));
  console.log(`wrote ${OUT}`);
}, 1_800_000);

/**
 * LXI_SIM=/path/sim.json [LXI_MATCHES=1000] [LXI_OFF=1]: the CPU's XIs in play, for the bowling side of section 7: per innings the bowlers
 * used, the overs bowled by men rated under 50 / 60 with the ball, and the bowling side's batting ratings (the depth table of the XIs
 * that played); the game's squads as the app loads them (prepareLeaguePool), random pairings, no injuries.
 */
it.skipIf(!process.env.LXI_SIM)("league XIs: the CPU's XIs in play", async () => {
  if (process.env.LXI_OFF) LEAGUE_XI_SWITCH.off = true;
  const N = Number(process.env.LXI_MATCHES ?? 1000);
  const loader = createPoolLoader(async f => new Uint8Array(readFileSync(join(PUBLIC, "pool", f))));
  const out: Record<string, { used: number[]; ov50: number[]; ov60: number[]; depth: number[][]; nb60: number[] }> = {};
  for (const [lg, r0] of [["ipl", RULE_PRESETS.modern2026], ...EXTRA_LEAGUES.filter(l => l.gender === "men" && l.rules.matchFormat !== "hundred").map(l => [l.id, l.rules])] as [string, RuleSet][]) {
    await prepareLeaguePool(lg, loader);
    const rules = { ...r0, injuriesEnabled: false } as RuleSet;
    const teams = createGameState(rules).teams;
    const o: (typeof out)[string] = { used: [], ov50: [], ov60: [], depth: [], nb60: [] };
    out[lg] = o;
    for (let i = 0; i < N; i++) {
      const home = teams[i % teams.length];
      let away = teams[(i * 7 + 3) % teams.length];
      if (away === home) away = teams[(i * 7 + 4) % teams.length];
      const r = simulateMatch(home, away, rules, 9000 + i, { countTowardStandings: false });
      const byId = new Map<string, Player>([...home.roster, ...away.roster].map(p => [p.id, p]));
      for (const inn of r.innings) {
        const overs = new Map<number, string>();
        for (const e of inn.ballLog as BallEvent[]) if (!overs.has(e.over)) overs.set(e.over, e.bowler);
        const bowlers = [...overs.values()];
        o.used.push(new Set(bowlers).size);
        o.ov50.push(bowlers.filter(b => (byId.get(b)?.bowlingOvr ?? 0) < 50).length);
        o.ov60.push(bowlers.filter(b => (byId.get(b)?.bowlingOvr ?? 0) < 60).length);
      }
      for (const inn of r.innings) {
        const ps = [...inn.batterStats.keys()].map(id => byId.get(id)).filter((p): p is Player => !!p);
        o.depth.push(ps.map(p => (p.battingOvr + p.ratings.timing) / 200).sort((a, b) => b - a).slice(0, 11));
        o.nb60.push(ps.filter(p => p.bowlingOvr >= 60).length);
      }
    }
    console.log(`${lg}: ${N} matches`);
  }
  writeFileSync(process.env.LXI_SIM!, JSON.stringify(out));
}, 7_200_000);

/**
 * LXI_TRAIN=/path/train.json: the training rows of the bowling-attack fit (packages/ratings/src/analysis/bowling-choice.py `attack`):
 * every league match side of docs/data/league_xi.json with its players' ratings (the real squads' players, as above) and the overs it
 * bowled (docs/data/bowling_overs.json, packages/ratings/src/pipeline/generate-bowling-overs.ts: the bowler's id, runs, his wickets).
 */
it.skipIf(!process.env.LXI_TRAIN)("league XIs: bowling-attack training rows", async () => {
  const ACT = JSON.parse(readFileSync(join(REPO, "docs", "data", "league_xi.json"), "utf-8")) as Record<string, LeagueMatch[]>;
  const OV = JSON.parse(readFileSync(join(REPO, "docs", "data", "bowling_overs.json"), "utf-8")) as { league: Record<string, Record<string, { inn: number; overs: [number, number, number][] } | null>> };
  const loader = createPoolLoader(async f => new Uint8Array(readFileSync(join(PUBLIC, "pool", f))));
  const data = new Map<string, Parameters<typeof createPlayerFromData>[0]>();
  for (const p of await loader.players("men", ["senior", "tier0"])) data.set(p.id, { ...toRealPlayerData(p), id: p.id });
  for (const p of [...getRealPlayers(), ...getPoolPlayers()]) data.set(p.id, { ...p, teamId: undefined, bid: undefined });
  const made = new Map<string, Player>();
  const player = (id: string) => { if (!made.has(id)) { const d = data.get(id); if (d) made.set(id, createPlayerFromData(d)); } return made.get(id); };
  const out: unknown[] = [];
  for (const [lg, ms] of Object.entries(ACT)) for (const m of ms) for (const s of m.sides) {
    const ov = OV.league[m.id]?.[s.team];
    if (!ov) continue;
    const xi = s.xi.map(id => (id ? player(id) : undefined));
    if (xi.some(p => !p)) continue;
    out.push({
      key: lg, id: m.id, date: m.date, team: s.team, inn: ov.inn, off: s.off,
      xi: xi.map(p => ({ id: ID(p!), ovr: p!.bowlingOvr, style: p!.bowlingStyle, kp: !!p!.isWicketKeeper, role: p!.role, bat: p!.battingOvr })),
      overs: ov.overs.map(([i, r, w]) => [i >= 0 ? s.xi[i] : null, r, w]),
    });
  }
  writeFileSync(process.env.LXI_TRAIN!, JSON.stringify(out));
  console.log(`wrote ${out.length} rows`);
}, 1_800_000);
