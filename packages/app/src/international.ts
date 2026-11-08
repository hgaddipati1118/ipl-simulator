/**
 * International series: two national sides, a format (T20I, ODI, Test), 1 to 5 matches, home grounds or neutral,
 * the user captaining a side or watching. Pure logic (no React): formats, national squads, the series state and its
 * persistence, playing a match (instantly or from a finished live match) and the series stats.
 *
 * A format is a pluggable entry of SERIES_FORMATS (`SeriesFormatDef`): which ratings it plays on, how to play a match
 * instantly and, if it has a live viewer, which screen and how to start one and read its result. Results are kept
 * format-agnostic (a list of innings scorecards, a winner or none), so a Test (up to four innings over five days, a draw,
 * its own live screen) slots in with its own entry: `simulate` wraps simulateTestMatch, `live.viewer` names its screen.
 */

import {
  ODI_GROUNDS, Player, Team, RULE_PRESETS, odiRules, simulateMatch, createMatchState, buildDetailedResultFromState,
  keepingRating, xiSelectionValue, IPL_TEAMS, WPL_TEAMS, EXTRA_LEAGUES,
  type DetailedBallEvent, type DetailedMatchResult, type InningsScorecard, type LongFormat, type MatchState, type PlayerData,
  type RuleSet, type TeamConfig,
} from "@ipl-sim/engine";
import { attachFormatRatings, type FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import { playerActivity, squadTier, type ActivityFormat, type PlayerActivityFile } from "@ipl-sim/ratings/dist/player-activity.js";
import { getRealPlayers, getPoolPlayers } from "@ipl-sim/ratings/dist/real-players.js";
import { WPL_PLAYERS } from "@ipl-sim/ratings/dist/wpl-players.js";
import type { ExtendedPlayer } from "@ipl-sim/ratings/dist/extended-pool.js";
import { markTestKeepers, pickTestSquad, testSeriesFormat } from "./test-match/test-series";

// ── Formats ────────────────────────────────────────────────────────────

export type SeriesGender = "men" | "women";
export type SeriesFormatId = "t20i" | "odi" | (string & {});

/** What a format needs to know about one match of a series */
export interface SeriesMatchContext {
  home: Team;
  away: Team;
  /** The format's RuleSet, for formats that play on one (limited overs) */
  rules?: RuleSet;
  gender: SeriesGender;
  seed: number;
  venue: SeriesVenue;
  /** The match's stable key (series id and match number, seriesMatchKey), for a format that keeps more than the record */
  key?: string;
}

/**
 * A format's live screen: which viewer the series page shows ("limited-overs" = LiveMatchPage; a Test adds its own), how to
 * start a match on it and how to turn the finished state into a record. `S` is the viewer's state type.
 */
export interface SeriesLiveDef<S = unknown> {
  viewer: "limited-overs" | (string & {});
  create(ctx: SeriesMatchContext, userTeamId: string | null): S;
  finish(state: S, ctx: Pick<SeriesMatchContext, "venue" | "seed">): SeriesMatchRecord;
}

export interface SeriesFormatDef {
  id: SeriesFormatId;
  /** "ODI", "T20I" */
  label: string;
  /** One line for the setup page */
  desc: string;
  /** The ratings players play this format on (Player.forFormat) */
  ratingFormat: "t20" | LongFormat;
  /** Overs a side (display) */
  overs?: number;
  /** Series lengths the setup page offers */
  lengths: number[];
  /** The RuleSet a limited-overs format plays on (absent for formats with their own engine) */
  rules?(gender: SeriesGender): RuleSet;
  /** Play the whole match at once */
  simulate(ctx: SeriesMatchContext): SeriesMatchRecord;
  /** The live screen, if the format has one (absent = instant only) */
  live?: SeriesLiveDef<any>;
  /** The format's own XI and batting order for a squad (absent: the engine's limited-overs pick, autoLineup) */
  autoLineup?(squad: Player[], series: IntlSeries): SeriesLineup;
  /** The format's check of a user's XI (absent: lineupProblems) */
  lineupProblems?(squad: Player[], lineup: SeriesLineup): string[];
}

/** A limited-overs format played by the engine's simulateMatch / createMatchState (rain on, as in a season) */
function limitedOversFormat(def: Omit<SeriesFormatDef, "simulate" | "live"> & { rules(gender: SeriesGender): RuleSet }): SeriesFormatDef {
  const live: SeriesLiveDef<MatchState> = {
    viewer: "limited-overs",
    create(ctx, userTeamId) {
      return createMatchState(ctx.home, ctx.away, ctx.rules ?? def.rules(ctx.gender), userTeamId, ctx.seed,
        { rain: true, ...(ctx.venue.neutral ? { neutralVenue: true } : { venueName: ctx.venue.name }) });
    },
    finish(state, ctx) {
      return recordFromDetailed(buildDetailedResultFromState(state), ctx.venue, ctx.seed, "live");
    },
  };
  return {
    ...def,
    simulate(ctx) {
      const res = simulateMatch(ctx.home, ctx.away, ctx.rules ?? def.rules(ctx.gender), ctx.seed, {
        countTowardStandings: false,
        rain: true, // rain, DLS and no results at the fitted rates, as in a season
        ...(ctx.venue.neutral ? { neutralVenue: true } : { venueName: ctx.venue.name }),
      });
      return recordFromDetailed(res.detailed!, ctx.venue, ctx.seed, "sim");
    },
    live,
  };
}

function t20iRules(gender: SeriesGender): RuleSet {
  return {
    ...RULE_PRESETS.modern2026,
    name: gender === "women" ? "Women's T20I" : "T20I",
    league: "custom",
    leagueName: gender === "women" ? "Women's T20I" : "T20I",
    impactPlayer: false,
    maxOverseasInXI: 11,
    gender,
    injuriesEnabled: false,
    scoringMultiplier: gender === "women" ? 0.82 : 1.0,
    superOverTieBreaker: "repeated-super-over",
    // the T20I level, fitted on real T20Is between full members since 2019 (engine scoring-context.ts); leagues have none
    scoringContext: "t20i",
  };
}

/**
 * The formats an international series can be played in. A Test entry (its own engine and viewer) is added here; the
 * series page lists whatever this holds.
 */
export const SERIES_FORMATS: SeriesFormatDef[] = [
  limitedOversFormat({
    id: "odi", label: "ODI", desc: "50 overs a side, ten overs a bowler", ratingFormat: "odi", overs: 50, lengths: [1, 3, 5],
    rules: gender => ({ ...odiRules(gender), injuriesEnabled: false }),
  }),
  limitedOversFormat({
    id: "t20i", label: "T20I", desc: "20 overs a side, four overs a bowler", ratingFormat: "t20", overs: 20, lengths: [1, 3, 5],
    rules: t20iRules,
  }),
  // the Test engine and LiveTestPage (test-match/test-series.ts)
  testSeriesFormat(),
];

export function registerSeriesFormat(def: SeriesFormatDef): void {
  const i = SERIES_FORMATS.findIndex(f => f.id === def.id);
  if (i >= 0) SERIES_FORMATS[i] = def;
  else SERIES_FORMATS.push(def);
}

export function seriesFormat(id: SeriesFormatId): SeriesFormatDef {
  return SERIES_FORMATS.find(f => f.id === id) ?? SERIES_FORMATS[0];
}

// ── Nations and squads ─────────────────────────────────────────────────

/** Nations with a colour, a three-letter code and the venue analysis' ground country code */
const NATION_INFO: Record<string, { short: string; primary: string; secondary: string; grounds?: string }> = {
  India: { short: "IND", primary: "#1d4ed8", secondary: "#f97316", grounds: "IND" },
  Australia: { short: "AUS", primary: "#facc15", secondary: "#166534", grounds: "AUS" },
  England: { short: "ENG", primary: "#1e3a8a", secondary: "#dc2626", grounds: "ENG" },
  "South Africa": { short: "SA", primary: "#15803d", secondary: "#facc15", grounds: "RSA" },
  "New Zealand": { short: "NZ", primary: "#111827", secondary: "#e5e7eb", grounds: "NZ" },
  Pakistan: { short: "PAK", primary: "#166534", secondary: "#f8fafc", grounds: "PAK" },
  "Sri Lanka": { short: "SL", primary: "#1e40af", secondary: "#fbbf24", grounds: "SL" },
  "West Indies": { short: "WI", primary: "#7f1d1d", secondary: "#fbbf24", grounds: "WI" },
  Bangladesh: { short: "BAN", primary: "#065f46", secondary: "#dc2626", grounds: "BDESH" },
  Afghanistan: { short: "AFG", primary: "#2563eb", secondary: "#dc2626" },
  Zimbabwe: { short: "ZIM", primary: "#dc2626", secondary: "#facc15", grounds: "ZIM" },
  Ireland: { short: "IRE", primary: "#16a34a", secondary: "#f8fafc", grounds: "IRELAND" },
  Netherlands: { short: "NED", primary: "#ea580c", secondary: "#1e3a8a", grounds: "NL" },
  Scotland: { short: "SCO", primary: "#1e3a8a", secondary: "#a855f7", grounds: "SCOT" },
  Nepal: { short: "NEP", primary: "#b91c1c", secondary: "#1e40af", grounds: "NEP" },
  UAE: { short: "UAE", primary: "#15803d", secondary: "#dc2626", grounds: "UAE" },
  "United Arab Emirates": { short: "UAE", primary: "#15803d", secondary: "#dc2626", grounds: "UAE" },
  USA: { short: "USA", primary: "#1e3a8a", secondary: "#dc2626", grounds: "USA" },
  "United States of America": { short: "USA", primary: "#1e3a8a", secondary: "#dc2626", grounds: "USA" },
  Namibia: { short: "NAM", primary: "#1d4ed8", secondary: "#dc2626", grounds: "NAMIB" },
  Oman: { short: "OMA", primary: "#dc2626", secondary: "#15803d", grounds: "OMAN" },
  Canada: { short: "CAN", primary: "#dc2626", secondary: "#f8fafc", grounds: "CAN" },
  Kenya: { short: "KEN", primary: "#166534", secondary: "#dc2626", grounds: "KENYA" },
  Thailand: { short: "THA", primary: "#1e3a8a", secondary: "#dc2626" },
};

const SQUAD_SIZE = 16;
/** Without activity data (or for a player it has no record of): the oldest a squad player can be */
const MAX_AGE = 40;

/**
 * A player's availability for a national squad in a format (player-activity.json, ratings package player-activity.ts):
 * 0 = played the format internationally in the last two seasons, 1 = senior cricket in the last two seasons, 2 = in the
 * last three only (fills gaps), 3 = inactive three seasons or more (never picked). Without activity data, or for a player
 * it has no record of, the age rule stands in: 40 or under counts as 2, older as 3.
 */
function availability(p: Pick<PlayerData, "id" | "sourceId" | "age"> & { lastYear?: number }, format: ActivityFormat, activity: PlayerActivityFile | null | undefined): 0 | 1 | 2 | 3 {
  const tier = activity ? squadTier(playerActivity(activity, p.sourceId ?? p.id), format, activity.asOf) : null;
  if (tier !== null) return tier;
  // an extended-pool player without a record: his last season, as the activity data would read it
  if (typeof p.lastYear === "number") {
    const asOf = activity?.asOf ?? new Date().getFullYear();
    return p.lastYear >= asOf - 1 ? 1 : p.lastYear >= asOf - 2 ? 2 : 3;
  }
  return p.age <= MAX_AGE ? 2 : 3;
}

/** Cricket West Indies' territories: their players play for West Indies */
const WI_TERRITORIES = new Set([
  "Jamaica", "Barbados", "Guyana", "Trinidad", "Trinidad and Tobago", "Tobago", "Antigua", "St Kitts", "Nevis", "Montserrat",
  "Anguilla", "St Vincent", "St Lucia", "Grenada", "Dominica", "St Maarten", "British Virgin Islands",
]);

/** A nation's name as the player data spells it, without the women's suffix some records carry (a West Indian territory: West Indies) */
export function nationOf(country: string): string {
  const c = country.replace(/ Women$/, "").trim();
  return WI_TERRITORIES.has(c) ? "West Indies" : c;
}

let menCache: PlayerData[] | null = null;
let womenCache: PlayerData[] | null = null;

/** The shipped players of a gender as engine PlayerData (stable ids: the record id, `espn_<id>`) */
function shippedPlayers(gender: SeriesGender): PlayerData[] {
  if (gender === "men") {
    if (!menCache) {
      const seen = new Set<string>();
      menCache = [...getRealPlayers(), ...getPoolPlayers()].filter(d => (seen.has(d.id) ? false : (seen.add(d.id), true))).map(d => ({
        id: d.id, sourceId: d.id, name: d.name, age: d.age, country: nationOf(d.country), role: d.role as PlayerData["role"],
        ratings: {
          battingIQ: d.battingIQ, timing: d.timing, power: d.power, running: d.running, wicketTaking: d.wicketTaking,
          economy: d.economy, accuracy: d.accuracy, clutch: d.clutch,
          ...(d.fielding !== undefined ? { fielding: d.fielding } : {}), ...(d.keeping !== undefined ? { keeping: d.keeping } : {}),
        },
        isInternational: false, isWicketKeeper: d.isWicketKeeper, bowlingStyle: d.bowlingStyle, battingHand: d.battingHand,
        imageUrl: d.imageUrl, injured: false, injuryGamesLeft: 0,
      }));
    }
    return menCache;
  }
  if (!womenCache) {
    womenCache = (WPL_PLAYERS as unknown as PlayerData[]).map(p => ({
      ...p, sourceId: p.id, country: nationOf(p.country), isInternational: false, isFemale: true, injured: false, injuryGamesLeft: 0,
    }));
  }
  return womenCache;
}

export interface NationOption { country: string; short: string; players: number }

const extendedCache = new WeakMap<readonly ExtendedPlayer[], (PlayerData & { lastYear: number })[]>();

/**
 * The extended pool's senior players (app: extended-pool.ts poolLoader, the CricketArchive players the shipped pool lacks)
 * as engine PlayerData: ids `ca_<id>`, the record's country, his own ODI / Test sets, and his last season (availability)
 */
function extendedSenior(extended: readonly ExtendedPlayer[] | null | undefined, gender: SeriesGender): (PlayerData & { lastYear: number })[] {
  if (!extended) return [];
  let out = extendedCache.get(extended);
  if (!out) {
    out = extended.filter(p => p.gender === gender && p.tier === "senior").map(p => {
      const { gender: _g, tier: _t, ...data } = p;
      return {
        ...data, sourceId: p.id, country: nationOf(p.country), isInternational: false, injured: false, injuryGamesLeft: 0,
        ...(gender === "women" ? { isFemale: true } : {}),
      } as PlayerData & { lastYear: number };
    });
    extendedCache.set(extended, out);
  }
  return out;
}

/** Nations of a gender with enough players for a squad (a keeper or someone to keep, five bowling options) */
export function seriesNations(gender: SeriesGender, activity?: PlayerActivityFile | null): NationOption[] {
  const by = new Map<string, PlayerData[]>();
  for (const p of shippedPlayers(gender)) {
    if (availability(p, "t20", activity) === 3) continue;
    const list = by.get(p.country) ?? [];
    list.push(p);
    by.set(p.country, list);
  }
  return [...by.entries()]
    .filter(([, list]) => list.length >= 14 && list.filter(p => p.role === "bowler" || p.role === "all-rounder").length >= 6)
    .map(([country, list]) => ({ country, short: NATION_INFO[country]?.short ?? country.slice(0, 3).toUpperCase(), players: list.length }))
    .sort((a, b) => (NATION_INFO[b.country] ? 1 : 0) - (NATION_INFO[a.country] ? 1 : 0) || b.players - a.players);
}

/**
 * A nation's squad for a format: the country's active players on that format's ratings (`ratings` is the format set, so
 * selection, orders and the UI all read it), 16 of them with at least a keeper and six bowling options. The candidates are
 * the shipped players and, when given, the nation's senior players from the extended pool (`extended`: the CricketArchive
 * players without an ESPN profile, e.g. Pakistan's Azan Awais, West Indies' Kemar Roach). Players who
 * played the format internationally in the last two seasons come first, then players active at senior level in the last
 * two, then (only to fill gaps) those active in the last three; nobody inactive for three seasons or more
 * (`availability`). Within a tier, by XI value. Player ids are the stable record ids. Without a designated keeper the best
 * gloveman is made the keeper. `ids` rebuilds a saved squad as it was.
 */
export function buildNationSquad(
  country: string, gender: SeriesGender, ratingFormat: "t20" | LongFormat, file: FormatRatingsFile | null, ids?: string[],
  activity?: PlayerActivityFile | null, extended?: readonly ExtendedPlayer[] | null,
): Player[] {
  const fmt: ActivityFormat = ratingFormat;
  const tierOf = new Map<string, number>();
  const all = [...shippedPlayers(gender), ...extendedSenior(extended, gender)].filter(p => {
    if (p.country !== country) return false;
    if (ids && ids.length > 0) return ids.includes(p.id);
    const t = availability(p, fmt, activity);
    tierOf.set(p.id, t);
    return t < 3;
  });
  const players = all.map(d => new Player({ ...d, ratings: { ...d.ratings } }));
  attachFormatRatings(players, file);
  const inFormat = players.map(p => {
    const set = ratingFormat === "t20" ? undefined : p.formatRatings?.[ratingFormat];
    if (set) p.ratings = { ...set.ratings };
    return p;
  });
  let squad: Player[];
  if (ids && ids.length > 0) {
    const byId = new Map(inFormat.map(p => [p.id, p]));
    squad = ids.map(id => byId.get(id)).filter((p): p is Player => !!p);
    if (ratingFormat === "test") markTestKeepers(squad);
  } else if (ratingFormat === "test") {
    // a Test squad is picked for its shape (keepers, seamers, spinners, batters), recent Test players first (test-series.ts)
    squad = pickTestSquad(inFormat, SQUAD_SIZE, p => tierOf.get(p.id) ?? 2);
  } else {
    const ranked = [...inFormat].sort((a, b) => (tierOf.get(a.id) ?? 2) - (tierOf.get(b.id) ?? 2) || xiSelectionValue(b) - xiSelectionValue(a));
    squad = ranked.slice(0, SQUAD_SIZE);
    const isBowl = (p: Player) => p.role === "bowler" || p.role === "all-rounder";
    const keeper = ranked.find(p => p.isWicketKeeper);
    if (keeper && !squad.includes(keeper)) squad[squad.length - 1] = keeper;
    for (const p of ranked) {
      if (squad.filter(isBowl).length >= 6) break;
      if (isBowl(p) && !squad.includes(p)) {
        const out = [...squad].reverse().find(x => !isBowl(x) && !x.isWicketKeeper);
        if (out) squad[squad.indexOf(out)] = p;
      }
    }
  }
  if (!squad.some(p => p.isWicketKeeper) && squad.length > 0) {
    const gloves = [...squad].filter(p => p.role !== "bowler").sort((a, b) => keepingRating(b) - keepingRating(a))[0] ?? squad[0];
    gloves.isWicketKeeper = true;
  }
  return squad;
}

// ── Venues ─────────────────────────────────────────────────────────────

export interface SeriesVenue {
  name: string;
  city?: string;
  /** No ground effects */
  neutral?: boolean;
  /** A franchise whose home ground this is (the T20 engine's measured conditions) */
  venueTeamId?: string;
}

const FRANCHISE_GROUNDS = (): TeamConfig[] => [...IPL_TEAMS, ...WPL_TEAMS, ...EXTRA_LEAGUES.flatMap(l => l.teams)].filter(c => c.stadiumName);
const groundKey = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** A nation's home grounds: its ODI grounds from the venue analysis (any gender), most used first */
export function homeGrounds(country: string): SeriesVenue[] {
  const code = NATION_INFO[country]?.grounds;
  if (!code) return [];
  const seen = new Set<string>();
  const franchise = FRANCHISE_GROUNDS();
  return ODI_GROUNDS.filter(g => g.country === code)
    .sort((a, b) => b.matches - a.matches)
    .filter(g => (seen.has(g.name) ? false : (seen.add(g.name), true)))
    .map(g => {
      const f = franchise.find(c => groundKey(c.stadiumName!) === groundKey(g.name) || groundKey(c.stadiumName!).startsWith(groundKey(g.name)));
      return { name: g.name, city: g.city ?? undefined, ...(f ? { venueTeamId: f.id } : {}) };
    });
}

export const NEUTRAL_VENUE: SeriesVenue = { name: "Neutral venue", neutral: true };

// ── Series state ───────────────────────────────────────────────────────

export interface SeriesSide {
  id: string;
  country: string;
  name: string;
  shortName: string;
  primaryColor: string;
  secondaryColor: string;
  /** Squad player ids (record ids) */
  squad: string[];
}

export interface SeriesLineup {
  /** The XI (ids) */
  xi: string[];
  /** Batting order (ids of the XI) */
  order: string[];
}

export interface SeriesMatchRecord {
  /** Match number, 0-based */
  n: number;
  seed: number;
  mode: "live" | "sim";
  venue: string;
  homeTeamId: string;
  awayTeamId: string;
  winnerId: string | null;
  /** "India won by 5 wickets", "Match tied", "No result (rain)" */
  result: string;
  tossWinnerName: string;
  tossDecision: "bat" | "bowl";
  /** Every innings in order (two in a limited-overs match; a Test has up to four) */
  innings: InningsScorecard[];
  /** Runs at the end of each over, per innings (the worm chart) */
  worm: number[][];
  potm?: { playerId: string; playerName: string; reason: string };
  /** The score line the series shows when the innings list says it badly ("IND 312 & 245/4d · ENG 280 & 101" in a Test) */
  summary?: string;
}

export type SeriesHost = "a" | "b" | "neutral";

export interface IntlSeries {
  v: 1;
  id: string;
  createdAt: string;
  format: SeriesFormatId;
  gender: SeriesGender;
  sides: [SeriesSide, SeriesSide];
  /** Matches in the series */
  length: number;
  host: SeriesHost;
  /** The side the user captains (index), or null to watch */
  userSide: 0 | 1 | null;
  /** The user's lineup for his side (kept from match to match until he changes it) */
  lineup?: SeriesLineup;
  results: SeriesMatchRecord[];
  /** A live match in progress (its match number) */
  liveMatch?: number;
  seedBase: number;
}

export interface NewSeriesOptions {
  format: SeriesFormatId;
  gender: SeriesGender;
  nations: [string, string];
  length: number;
  host: SeriesHost;
  userSide: 0 | 1 | null;
  seed?: number;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** A new series; `extended` adds the extended pool's senior players of the gender to the squads' candidates */
export function createSeries(
  opts: NewSeriesOptions, file: FormatRatingsFile | null, activity?: PlayerActivityFile | null, extended?: readonly ExtendedPlayer[] | null,
): IntlSeries {
  const def = seriesFormat(opts.format);
  const sides = opts.nations.map((country, i) => {
    const info = NATION_INFO[country];
    const squad = buildNationSquad(country, opts.gender, def.ratingFormat, file, undefined, activity, extended);
    return {
      id: `${slug(country)}-${i}`, country, name: opts.gender === "women" ? `${country} Women` : country,
      shortName: info?.short ?? country.slice(0, 3).toUpperCase(),
      primaryColor: info?.primary ?? (i ? "#2563eb" : "#f97316"), secondaryColor: info?.secondary ?? "#f8fafc",
      squad: squad.map(p => p.id),
    };
  }) as [SeriesSide, SeriesSide];
  // two different nations look different even when both sides are drawn from colour-alike flags
  if (sides[0].primaryColor === sides[1].primaryColor) sides[1].primaryColor = "#2563eb";
  const seedBase = opts.seed ?? Math.floor(Math.random() * 2 ** 30);
  return {
    v: 1, id: `${Date.now().toString(36)}-${seedBase.toString(36)}`, createdAt: new Date().toISOString(),
    format: def.id, gender: opts.gender, sides, length: opts.length, host: opts.host, userSide: opts.userSide,
    results: [], seedBase,
  };
}

/** The squads of a series, rebuilt from their saved ids on the format's ratings (`extended` is needed for its `ca_<id>` players) */
export function seriesSquads(series: IntlSeries, file: FormatRatingsFile | null, extended?: readonly ExtendedPlayer[] | null): [Player[], Player[]] {
  const def = seriesFormat(series.format);
  return series.sides.map(s => buildNationSquad(s.country, series.gender, def.ratingFormat, file, s.squad, undefined, extended)) as [Player[], Player[]];
}

/** The ground of match n: the host's grounds in turn (alternating hosts when neither side is the host is not offered) */
export function venueFor(series: IntlSeries, n: number): SeriesVenue {
  if (series.host === "neutral") return NEUTRAL_VENUE;
  const host = series.sides[series.host === "a" ? 0 : 1];
  const grounds = homeGrounds(host.country);
  return grounds.length > 0 ? grounds[n % grounds.length] : { name: `${host.country}`, city: host.country };
}

/** "1st ODI", "3rd T20I" */
export function matchName(series: IntlSeries, n: number): string {
  const k = n + 1;
  const suffix = k % 10 === 1 && k !== 11 ? "st" : k % 10 === 2 && k !== 12 ? "nd" : k % 10 === 3 && k !== 13 ? "rd" : "th";
  return series.length === 1 ? `One-off ${seriesFormat(series.format).label}` : `${k}${suffix} ${seriesFormat(series.format).label}`;
}

/** Build the two playing Teams for match n (home side first). The user's lineup applies to his side. */
export function teamsForMatch(series: IntlSeries, n: number, squads: [Player[], Player[]]): { home: Team; away: Team; venue: SeriesVenue } {
  const venue = venueFor(series, n);
  const homeIdx = series.host === "b" ? 1 : 0;
  const make = (i: 0 | 1) => {
    const side = series.sides[i];
    const isHome = i === homeIdx && !venue.neutral;
    const config: TeamConfig = {
      id: side.id, name: side.name, shortName: side.shortName, city: isHome ? venue.city ?? side.country : "Away",
      primaryColor: side.primaryColor, secondaryColor: side.secondaryColor,
      ...(isHome ? { stadiumName: venue.name, ...(venue.venueTeamId ? { venueTeamId: venue.venueTeamId } : {}) } : {}),
    };
    const team = new Team(config, 999);
    for (const p of squads[i]) {
      const copy = Player.fromJSON(p.toJSON());
      copy.injured = false; copy.injuryGamesLeft = 0; copy.fatigue = 0;
      team.addPlayer(copy, 0);
    }
    if (series.userSide === i && series.lineup) {
      const xi = series.lineup.xi.filter(id => team.roster.some(p => p.id === id));
      if (xi.length === 11) {
        team.isUserControlled = true;
        team.userPlayingXI = xi;
        team.userBattingOrder = series.lineup.order.filter(id => xi.includes(id));
      }
    } else if (series.userSide === i) {
      team.isUserControlled = true;
    }
    return team;
  };
  const a = make(0), b = make(1);
  return homeIdx === 0 ? { home: a, away: b, venue } : { home: b, away: a, venue };
}

/** The engine's own pick for a side: its XI and batting order */
export function autoLineup(squad: Player[], rules?: RuleSet): SeriesLineup {
  const t = new Team({ id: "auto", name: "auto", shortName: "AUT", city: "", primaryColor: "#000", secondaryColor: "#fff" }, 999);
  for (const p of squad) t.addPlayer(Player.fromJSON(p.toJSON()), 0);
  const xi = t.getPlayingXI(rules?.maxOverseasInXI ?? 11);
  return { xi: xi.map(p => p.id), order: t.getBattingOrder(xi).map(p => p.id) };
}

/** Problems with an XI the user picked (empty = fine) */
export function lineupProblems(squad: Player[], lineup: SeriesLineup): string[] {
  const byId = new Map(squad.map(p => [p.id, p]));
  const xi = lineup.xi.map(id => byId.get(id)).filter((p): p is Player => !!p);
  const out: string[] = [];
  if (xi.length !== 11) out.push(`${xi.length}/11 players`);
  if (!xi.some(p => p.isWicketKeeper)) out.push("No wicket-keeper");
  const bowl = xi.filter(p => p.role === "bowler" || p.role === "all-rounder").length;
  if (bowl < 5) out.push(`${bowl}/5 bowling options`);
  return out;
}

// ── Playing ────────────────────────────────────────────────────────────

export function nextMatchNumber(series: IntlSeries): number | null {
  if (isSeriesDecidedEarly(series)) return null;
  return series.results.length < series.length ? series.results.length : null;
}

export function matchSeed(series: IntlSeries, n: number): number {
  return (series.seedBase + n * 7919) >>> 0;
}

/** A match's stable key: the series id and the match number */
export function seriesMatchKey(series: Pick<IntlSeries, "id">, n: number): string {
  return `${series.id}-${n}`;
}

export function matchContext(series: IntlSeries, n: number, squads: [Player[], Player[]]): SeriesMatchContext {
  const { home, away, venue } = teamsForMatch(series, n, squads);
  const def = seriesFormat(series.format);
  return {
    home, away, venue, ...(def.rules ? { rules: def.rules(series.gender) } : {}), gender: series.gender, seed: matchSeed(series, n),
    key: seriesMatchKey(series, n),
  };
}

/** Play match n instantly and add its record */
export function simulateSeriesMatch(series: IntlSeries, squads: [Player[], Player[]], n = series.results.length): IntlSeries {
  const ctx = matchContext(series, n, squads);
  const rec = { ...seriesFormat(series.format).simulate(ctx), n };
  return addResult(series, rec);
}

/** Add a finished match (instant or live) */
export function addResult(series: IntlSeries, rec: SeriesMatchRecord): IntlSeries {
  const results = [...series.results.filter(r => r.n !== rec.n), rec].sort((a, b) => a.n - b.n);
  return { ...series, results, liveMatch: series.liveMatch === rec.n ? undefined : series.liveMatch };
}

/** Play every match left instantly */
export function simulateRestOfSeries(series: IntlSeries, squads: [Player[], Player[]]): IntlSeries {
  let s = series;
  for (let guard = 0; guard < 10; guard++) {
    const n = nextMatchNumber(s);
    if (n === null) break;
    s = simulateSeriesMatch(s, squads, n);
  }
  return s;
}

function worm(log: DetailedBallEvent[]): number[] {
  const out: number[] = [];
  for (const b of log) out[b.over] = b.scoreSoFar;
  for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = i > 0 ? out[i - 1] : 0;
  return out;
}

export function recordFromDetailed(d: DetailedMatchResult, venue: SeriesVenue, seed: number, mode: "live" | "sim"): SeriesMatchRecord {
  const winnerId = /won by/.test(d.result) ? (d.result.startsWith(d.homeTeamName) ? d.homeTeamId : d.result.startsWith(d.awayTeamName) ? d.awayTeamId : null) : null;
  return {
    n: 0, seed, mode, venue: venue.neutral ? NEUTRAL_VENUE.name : venue.name,
    homeTeamId: d.homeTeamId, awayTeamId: d.awayTeamId, winnerId, result: d.result,
    tossWinnerName: d.tossWinnerName, tossDecision: d.tossDecision,
    innings: [d.innings1, d.innings2],
    worm: [worm(d.ballLog.filter(b => b.innings === 1)), worm(d.ballLog.filter(b => b.innings === 2))],
    potm: d.manOfTheMatch,
  };
}

// ── Series score and stats ─────────────────────────────────────────────

export interface SeriesScore {
  wins: [number, number];
  /** Ties, no results (and draws in a Test) */
  shared: number;
  played: number;
  /** "India win the series 2-1", "Series level 1-1", "India lead 1-0" */
  text: string;
  /** The series winner (index), once decided */
  winner: 0 | 1 | null;
  done: boolean;
}

export function seriesScore(series: IntlSeries): SeriesScore {
  const wins: [number, number] = [0, 0];
  let shared = 0;
  for (const r of series.results) {
    const i = series.sides.findIndex(s => s.id === r.winnerId);
    if (i === 0 || i === 1) wins[i]++;
    else shared++;
  }
  const played = series.results.length;
  const left = series.length - played;
  const decided = wins[0] > wins[1] + left || wins[1] > wins[0] + left;
  const done = played >= series.length || decided;
  const [a, b] = series.sides;
  const lead = wins[0] === wins[1] ? null : wins[0] > wins[1] ? 0 : 1;
  const hi = Math.max(...wins), lo = Math.min(...wins);
  let text: string;
  if (played === 0) text = `${series.length === 1 ? "One-off" : `${series.length}-match`} series`;
  else if (done) text = lead === null ? `Series drawn ${hi}-${lo}` : `${series.sides[lead].name} win the series ${hi}-${lo}`;
  else text = lead === null ? `Series level ${hi}-${lo}` : `${series.sides[lead].name} lead ${hi}-${lo}`;
  // a Test series counts its draws: "India lead 1-0 (2 Tests drawn)"
  const drawn = series.format === "test" ? series.results.filter(r => !r.winnerId && /drawn/i.test(r.result)).length : 0;
  if (drawn > 0) text += ` (${drawn} Test${drawn > 1 ? "s" : ""} drawn)`;
  void a; void b;
  return { wins, shared, played, text, winner: done && lead !== null ? lead : null, done };
}

/** A best-of series that one side has already won (the remaining matches are not played: dead rubbers are skipped) */
export function isSeriesDecidedEarly(series: IntlSeries): boolean {
  const s = seriesScore(series);
  return s.done && s.played < series.length;
}

export interface BattingLine { playerId: string; name: string; sideId: string; innings: number; notOuts: number; runs: number; balls: number; fours: number; sixes: number; high: number; highNotOut: boolean; fifties: number; hundreds: number; average: number | null; strikeRate: number | null }
export interface BowlingLine { playerId: string; name: string; sideId: string; balls: number; runs: number; wickets: number; best: string; average: number | null; economy: number | null; /** Innings with five wickets or more */ fiveFors: number }

function oversToBalls(overs: string): number {
  const [o, b] = overs.split(".").map(Number);
  return (o || 0) * 6 + (b || 0);
}

export function seriesStats(series: IntlSeries): { batting: BattingLine[]; bowling: BowlingLine[]; playerOfSeries: { playerId: string; name: string; sideId: string; summary: string } | null } {
  const bat = new Map<string, BattingLine>();
  const bowl = new Map<string, BowlingLine & { bestW: number; bestR: number }>();
  for (const r of series.results) {
    for (const inn of r.innings) {
      for (const b of inn.batters) {
        if (b.balls === 0 && b.howOut === "not out") continue;
        const line = bat.get(b.playerId) ?? { playerId: b.playerId, name: b.playerName, sideId: inn.battingTeamId, innings: 0, notOuts: 0, runs: 0, balls: 0, fours: 0, sixes: 0, high: 0, highNotOut: false, fifties: 0, hundreds: 0, average: null, strikeRate: null };
        const notOut = b.howOut === "not out" || /retired hurt/.test(b.howOut);
        line.innings++; if (notOut) line.notOuts++;
        line.runs += b.runs; line.balls += b.balls; line.fours += b.fours; line.sixes += b.sixes;
        if (b.runs > line.high || (b.runs === line.high && notOut)) { line.high = b.runs; line.highNotOut = notOut; }
        if (b.runs >= 100) line.hundreds++; else if (b.runs >= 50) line.fifties++;
        bat.set(b.playerId, line);
      }
      for (const b of inn.bowlers) {
        const line = bowl.get(b.playerId) ?? { playerId: b.playerId, name: b.playerName, sideId: inn.bowlingTeamId, balls: 0, runs: 0, wickets: 0, best: "", average: null, economy: null, fiveFors: 0, bestW: -1, bestR: 0 };
        line.balls += oversToBalls(b.overs); line.runs += b.runs; line.wickets += b.wickets;
        if (b.wickets >= 5) line.fiveFors++;
        if (b.wickets > line.bestW || (b.wickets === line.bestW && b.runs < line.bestR)) { line.bestW = b.wickets; line.bestR = b.runs; line.best = `${b.wickets}/${b.runs}`; }
        bowl.set(b.playerId, line);
      }
    }
  }
  const batting = [...bat.values()].map(l => ({ ...l, average: l.innings - l.notOuts > 0 ? l.runs / (l.innings - l.notOuts) : null, strikeRate: l.balls > 0 ? (100 * l.runs) / l.balls : null }))
    .sort((a, b) => b.runs - a.runs || (b.strikeRate ?? 0) - (a.strikeRate ?? 0));
  const bowling = [...bowl.values()].map(({ bestW: _w, bestR: _r, ...l }) => ({ ...l, average: l.wickets > 0 ? l.runs / l.wickets : null, economy: l.balls > 0 ? (6 * l.runs) / l.balls : null }))
    .sort((a, b) => b.wickets - a.wickets || (a.economy ?? 99) - (b.economy ?? 99));
  // Player of the series: runs plus 20 a wicket, the series winner's players first on a tie
  const pts = new Map<string, { name: string; sideId: string; p: number; runs: number; wkts: number }>();
  for (const l of batting) pts.set(l.playerId, { name: l.name, sideId: l.sideId, p: l.runs, runs: l.runs, wkts: 0 });
  for (const l of bowling) {
    const e = pts.get(l.playerId) ?? { name: l.name, sideId: l.sideId, p: 0, runs: 0, wkts: 0 };
    e.p += 20 * l.wickets; e.wkts = l.wickets;
    pts.set(l.playerId, e);
  }
  const score = seriesScore(series);
  const winSide = score.winner !== null ? series.sides[score.winner].id : null;
  const best = [...pts.entries()].sort((a, b) => b[1].p - a[1].p || (b[1].sideId === winSide ? 1 : 0) - (a[1].sideId === winSide ? 1 : 0))[0];
  const playerOfSeries = series.results.length > 0 && best
    ? { playerId: best[0], name: best[1].name, sideId: best[1].sideId, summary: [best[1].runs ? `${best[1].runs} runs` : "", best[1].wkts ? `${best[1].wkts} wickets` : ""].filter(Boolean).join(", ") }
    : null;
  return { batting, bowling, playerOfSeries };
}

// ── Persistence (its own key: career saves, presets and multiplayer are untouched) ─

export const SERIES_STORAGE_KEY = "ipl-sim-intl-series-v1";
/** Live-match storage namespace for series matches (season -2; Draft Match uses -1) */
export const SERIES_SEASON_KEY = -2;

export function saveSeries(series: IntlSeries | null, storage: Pick<Storage, "setItem" | "removeItem"> = localStorage): void {
  try {
    if (series) storage.setItem(SERIES_STORAGE_KEY, JSON.stringify(series));
    else storage.removeItem(SERIES_STORAGE_KEY);
  } catch { /* quota or private mode: the series lives for this session */ }
}

export function loadSeries(storage: Pick<Storage, "getItem"> = localStorage): IntlSeries | null {
  try {
    const raw = storage.getItem(SERIES_STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as IntlSeries;
    return s && s.v === 1 && Array.isArray(s.sides) && Array.isArray(s.results) ? s : null;
  } catch {
    return null;
  }
}
