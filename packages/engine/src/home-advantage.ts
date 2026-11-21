/**
 * Home advantage in the T20 leagues (docs/LEAGUES.md, "Home advantage"). A side at its own ground plays a little above its ratings
 * and the visitors a little below: on every ball the batter-bowler balance of the T20 ball model (match.ts baseOutcomeProbabilities)
 * moves by `edge` points toward the home side, for it when it bats and against the visitors when they bat. Both innings carry it
 * whoever bats first, so it is toss-neutral, and the two innings' scoring changes cancel over a match (the league levels stay where
 * they were fitted). A balance point is what one rating point on each of the six batting and bowling attributes of both sides moves
 * (the series tuning's `home`, series-tuning.ts in the app, is the same unit).
 *
 * League play only: none at a neutral ground (playoffs), at a ground both sides call home (shared grounds: ILT20, MLC) or at a
 * ground that is neither side's own (Draft Match, whose sides borrow a franchise's ground); none in T20Is (their home term is the
 * series tuning), ODIs or Tests (their own fitted models and series terms).
 */

/** league id -> the home edge in balance points; leagues absent have none. Mutable so the benchmarks can try other values. */
export const LEAGUE_HOME: Record<string, number> = {};

interface SideLike { id: string; config: { id?: string; venueTeamId?: string; stadiumName?: string } }

/** The ground a side plays its home matches at: its own, or the franchise ground it borrows (venueTeamId) */
function groundOf(t: SideLike): string {
  return t.config.venueTeamId ?? t.config.id ?? t.id;
}

/**
 * The home side's edge for a match between `home` (whose ground it is) and `away`, under `rules`: 0 at a neutral ground, at a shared
 * or borrowed ground, outside league T20 play, or where the league has no home term.
 */
export function leagueHomeEdge(
  rules: { league: string; scoringContext?: string; matchFormat?: string },
  home: SideLike,
  away: SideLike,
  neutral: boolean,
): number {
  const edge = LEAGUE_HOME[rules.league];
  if (!edge || neutral || rules.scoringContext === "t20i" || rules.matchFormat === "odi") return 0;
  // a borrowed ground (Draft Match) is no side's home
  if (home.config.venueTeamId && home.config.venueTeamId !== (home.config.id ?? home.id)) return 0;
  // a ground both sides call home
  if (groundOf(home) === groundOf(away)) return 0;
  if (home.config.stadiumName && home.config.stadiumName === away.config.stadiumName) return 0;
  return edge;
}

/** The edge on one ball: `edge` for the home side batting, `-edge` for the visitors */
export function battingHomeEdge(edge: number | undefined, homeBatting: boolean): number {
  return edge ? (homeBatting ? edge : -edge) : 0;
}
