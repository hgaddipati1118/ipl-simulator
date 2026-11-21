# Extra T20 leagues

Besides the IPL and WPL, the game can play the other major T20 leagues with their real teams, squads, home grounds
and rules. Pick one on the Setup page (the row of league buttons under IPL / WPL) and play seasons exactly as in the
IPL: pre-formed real squads in season 1, then retention, auctions (or a draft), trades, progression.

| id | League | Gender | Teams | Source season of the squads | Innings |
|----|--------|--------|-------|-----------------------------|---------|
| `bbl` | Big Bash League | men | 8 | 2025/26 | T20 |
| `wbbl` | Women's Big Bash League | women | 8 | 2025/26 | T20 |
| `psl` | Pakistan Super League | men | 8 | 2025/26 | T20 |
| `sa20` | SA20 | men | 6 | 2025/26 | T20 |
| `hundred-m` | The Hundred (men) | men | 8 | 2026 | 100 balls |
| `hundred-w` | The Hundred (women) | women | 8 | 2026 | 100 balls |
| `cpl` | Caribbean Premier League | men | 7 | 2026 | T20 |
| `ilt20` | International League T20 | men | 6 | 2025/26 | T20 |
| `mlc` | Major League Cricket | men | 6 | 2026 | T20 |
| `bpl` | Bangladesh Premier League | men | 6 | 2025/26 | T20 |
| `lpl` | Lanka Premier League | men | 5 | 2026 | T20 |

Teams (names, short names, colours, home grounds) and the league rules live in
`packages/ratings/src/analysis/league_defs.py`, the single source of truth. `build-league-rosters.py` turns it into
`packages/engine/src/league-defs.ts` (teams + rules), `packages/ratings/src/league-rosters.ts` (squads) and a
match-rate report; `export-engine-venues.py` reads the same file for the home grounds. The registry is
`packages/engine/src/leagues.ts` (`ALL_LEAGUES`, `EXTRA_LEAGUES`, `getLeague`, `isOverseasIn`).

## Rules

All values are in `league_defs.py` and the data shows how each was chosen. The rules are the leagues' publicly known
playing conditions to the best of our knowledge; where the 2025/26 and 2026 scorecards disagree with a remembered rule the
scorecards win (e.g. The Hundred fielded up to five overseas players in an XI; the table says 5). Squads are trimmed to
the limits below.

| League | Matches/team | Playoffs | Overseas in XI | Overseas in squad | Squad (min-max) | Real squad building |
|--------|-------------|----------|----------------|-------------------|-----------------|---------------------|
| BBL | 10 (40 total) | Top 4: Qualifier 1v2, Knockout 3v4, Challenger, Final | 3 | 6 | 16-20 | Draft |
| WBBL | 10 | Top 4, 1st goes straight to the Final: Knockout 3v4, Challenger 2nd v winner | 4 | 6 | 13-17 | Draft |
| PSL | 10 (40) | Top 4: Qualifier, Eliminator 1, Eliminator 2, Final | 4 | 8 | 16-22 | Draft |
| SA20 | 10 (30), double round robin | Top 4: Qualifier 1, Eliminator, Qualifier 2, Final | 4 | 7 | 16-17 | Auction |
| The Hundred (m) | 8 (32) | Top 3: Eliminator 2v3, Final v 1st | 5 | 8 | 14-16 | Auction |
| The Hundred (w) | 8 (32) | Top 3: Eliminator 2v3, Final v 1st | 5 | 8 | 14-16 | Auction |
| CPL | 10 (35) | Top 4: Qualifier 1, Eliminator, Qualifier 2, Final | 4 | 8 | 15-20 | Draft |
| ILT20 | 10 (30), double round robin | Top 4: Qualifier 1, Eliminator, Qualifier 2, Final | 10 | 17 | 17-20 | Auction |
| MLC | 10 (30), double round robin | Top 4: Qualifier, Eliminator, Challenger, Final | 8 | 14 | 15-19 | Auction |
| BPL | 10 (30), double round robin | Top 4: Qualifier 1, Eliminator, Qualifier 2, Final | 4 | 9 | 17-22 | Draft |
| LPL | 8 (20), double round robin | Top 4: Qualifier 1, Eliminator, Qualifier 2, Final | 4 | 8 | 17-22 | Auction |

Common to all: no impact player (the IPL-only rule), two bouncers per over for men / one for women, repeated super
overs for a tie, injuries on, 2 points per win.

### What "overseas" means

A player is overseas when their nationality differs from the league's home country (`isOverseasIn`): Australia (BBL,
WBBL), Pakistan, South Africa, England (The Hundred: Welsh players count as home), the West Indies as one nation
(CPL), Bangladesh, Sri Lanka. The IPL's rule (non-Indian) no longer hard-codes India: `Player.isInternational` is set
per league when a game is created, so the same player is overseas in one league and not in another.

ILT20 and MLC are different: their squads are mostly made of foreigners (UAE and USA players are a small minority),
so the real constraints are "at least N home-eligible players in the XI". In the data an ILT20 XI had 9-11 non-UAE
players and an MLC XI 6-8 non-USA players, so the limits are 10 and 8 (equivalent to a minimum of 1 UAE and 3 US
players in the XI).

### Simplifications

* SA20 bonus points (4 for a win plus a bonus point) are not modelled; a win is 2 points like everywhere else.
* The SA20's transformation targets, MLC's and ILT20's home-player minimums (expressed as the overseas limit above),
  BBL's replacement and "Global signing" mechanics, The Hundred's wildcard picks and PSL's categories are not modelled.
* Money is the game's abstract Cr scale: the auction budget is about 5 per squad slot for men and 0.67 for women
  (WPL: 12 for 18 players), whatever the real currency.
* Offseason: retention, mini/mega auctions and trades work as in the IPL (mega auction every third season; retentions
  = a third of the squad). Setting Squad building to Draft on the Setup page runs the draft instead of auctions for
  any league.
* Multiplayer offers every league (`packages/app/src/multiplayer/leagues.ts`, built from `ALL_LEAGUES`): an auction room's
  host picks the league in the lobby (franchises, budget and rules follow; team claims reset), a season-draft room has a
  League setting with every league, and Draft Match has a "<league> <season> squads" pool for each extra league (its
  overseas cap per XI, random grounds from that league). An extra league's room loads its squads the way a single-player
  new game does: `prepareLeaguePool(league)` (extended CricketArchive pool, on the host only) and then `createGameState(rules)`;
  an auction room is then a mega auction: every franchise starts empty with the league's budget and the league's real
  players (squads and free agents, best first, 1.4 squads' worth per team, capped at 320) go under the hammer, topped up
  with generated players (the women's model in a women's league) if thin; the season-draft pool is its squads plus free agents (capped at 600, best first). IPL and WPL rooms behave
  as before. Guests receive everything from the host, so they need no league data. Draft Match itself plays T20 rules
  in every pool (as the WPL pool always has).

## Season structure

The IPL and WPL keep their own schedule generators. The extra leagues use `generateBalancedSchedule`
(`packages/engine/src/schedule.ts`): every pair meets `floor(m/(n-1))` times, home and away alternating, and the
remaining fixtures come from a regular circulant graph, so every team plays exactly its quota (8 teams x 10 = one
round robin plus a 3-regular graph, 7 teams x 10 = one round robin plus a 4-regular graph, 6 teams x 10 = double round
robin, 5 teams x 8 = double round robin). Brackets are `playoffFormat` values on the rule set:

* `eliminator` (IPL style): Q1 1v2, Eliminator 3v4, Q2 (Q1 loser v Eliminator winner), Final. Used by 8 of the leagues
  (the match labels differ per league in real life: Knockout, Challenger, Eliminator 1/2 ...; the engine keeps the IPL labels).
* `top3` (The Hundred): Eliminator 2nd v 3rd, then the Final v the 1st-placed team.
* `wbbl` (Women's Big Bash League): Knockout 3rd v 4th, Challenger 2nd v the Knockout winner, Final v the 1st-placed team.

`progressPlayoffs` adds each round as the previous one finishes (the Season page) and `runSeason` plays the same
brackets in one go. IPL, WPL and custom leagues keep their old behaviour untouched.

## The Hundred

Implemented in the engine, not faked. `RuleSet.matchFormat = "hundred"` selects `HUNDRED_FORMAT`
(`packages/engine/src/format.ts`):

* an innings is 100 balls, modelled as 20 sets of 5 balls (strike changes after every set);
* a bowler delivers at most 4 sets (20 balls) and may bowl two sets in a row (10 balls) but never three;
* the powerplay is the first 5 sets (25 balls). Every over-indexed table (phase multipliers, ball-change rule, clutch
  window) was tuned for 20 overs, so a Hundred set is mapped onto the same 20-over timeline (`phaseOver`): the powerplay
  stretches to six T20 overs and the death sets line up with overs 15-19;
* the super over is a single 5-ball set per side; NRR charges a bowled-out side the full 100 balls;
* scorecards show balls instead of overs (bowler figures in balls, innings "93 balls"; economy stays runs per 6 balls so
  it compares across formats); `InningsScore.ballsPerOver` is 5 and absent (= 6) for T20.

Not modelled: wides and no-balls cost the same one run as in T20 (the Hundred charges two), no free-hit rule, and the
"Strategic Timeout" of the Hundred.

The ball-by-ball live viewer (`live-match.ts`) is built around 6-ball overs, DLS and rain, so for the Hundred the app
plays the user's matches through the quick simulator (same engine, full scorecard, no live controls). The
`engine.matchFormat` hook of the mods branch (`mod-hooks.ts`, overs-based) is a different mechanism that cannot express
a 5-ball over; the two will need reconciling when that branch merges (format.ts already carries `ballsPerOver`).

## Venues

Every team has a measured home ground in `venue-data.ts` (regenerated by `export-engine-venues.py`, existing IPL and WPL
entries are byte-identical): run, six and wicket factors, bowler-type edges and chase advantage, normalised to the
league's own mean ground like the IPL's (`venues.ts` now takes the team-to-league map from the league definitions).
Each competition has its own chase baseline (`chase.leagues`: its record in `toss_chase.csv` shrunk toward the gender
mean). Home grounds are the most used ground of each franchise in its latest season; where a league plays at one or two
neutral hubs (PSL, ILT20, MLC, BPL, LPL) franchises are given a plausible home ground from the same hubs and some share
one. Women's leagues use the women's ground record (the men's, shrunk 50%, below 15 matches).

## Squads

Source: CricketArchive scorecards in `data/cricket.db` (full XIs per match including "did not bat"), the most recent
complete season of each league; the squad is the team's players ranked by appearances, trimmed to the squad size and
overseas limits, with a keeper guaranteed. Short squads (players who never made an XI are invisible in scorecards) are
topped up from the franchise's previous season, then, when a game is created, from the free agents (home-country
players first) up to the league's minimum.

Players are matched to the game pool by Cricinfo id (`espn_<id>`, via `people.parquet` and `ca_espn_map.csv`): matched
players keep the exact ratings, age, bowling style and photo they have everywhere else. Anyone not in the pool gets
the id `ca_<CricketArchive id>` and a fallback rating regressed from the ratings model's latest snapshot
(`player_ratings_by_season.parquet`; an OLS fit of the pool's 8 attributes on the model's batting / bowling / clutch
components, R2 0.3-0.8 per attribute), or a low role default when the model has no row. The fallback is stored in
`league-rosters.ts` (`fb`) and used only if nothing better exists.

`league-players.ts` resolves a squad entry in this order: game pool (`espn_<id>`; men in `ALL_PLAYERS`, women in
`WPL_PLAYERS`), then the full CricketArchive pool if one is registered with `registerCaPlayerSource`, then `fb`. The
CricketArchive-pool work (`ca_<id>` ids) plugs in by calling `registerCaPlayerSource(({ca, espn, gender}) => ...)`;
`getLeagueMatchStats(league)` reports how many of a league's players came from the pool, the CA pool or the fallback.
The squad files also carry the CricketArchive id of every player (`ca`), so re-matching needs no new lookup.

### Squad match rates

Players matched to the game pool versus given a generated fallback (from `data/analysis/league_squads_report.json`,
written by the build script; `getLeagueMatchStats(league)` reports the same at runtime):

| League | Season | Squad players | In the pool (ratings shared) | Generated fallback | Match rate |
|--------|--------|---------------|------------------------------|--------------------|-----------|
| Big Bash League | 2025/26 | 143 | 142 | 1 | 99% |
| Women's Big Bash League | 2025/26 | 111 | 56 | 55 | 50% |
| Pakistan Super League | 2025/26 | 143 | 128 | 15 | 90% |
| SA20 | 2025/26 | 101 | 98 | 3 | 97% |
| The Hundred (Men) | 2026 | 119 | 118 | 1 | 99% |
| The Hundred (Women) | 2026 | 111 | 75 | 36 | 68% |
| Caribbean Premier League | 2026 | 125 | 112 | 13 | 90% |
| International League T20 | 2025/26 | 114 | 110 | 4 | 96% |
| Major League Cricket | 2026 | 102 | 98 | 4 | 96% |
| Bangladesh Premier League | 2025/26 | 119 | 101 | 18 | 85% |
| Lanka Premier League | 2026 | 92 | 88 | 4 | 96% |
| **All 11 leagues** | | **1280** | **1126** | **154** | **88%** |

The men's leagues match 85-99%: the pool holds every man with 3+ T20 matches on Cricinfo, so the unmatched are
players with a thin T20 record (mostly Associate-nation and domestic-only players in the BPL and PSL). The women's
pool only holds women with 10+ T20I matches, so the WBBL (50%) and The Hundred women (68%) keep the generated fallback
for their domestic-only and young players; those are the players the CricketArchive pool will replace.


## Calibration

The IPL and WPL keep the scoring the engine was tuned to. For the extra leagues the engine's player ratings and measured
grounds already land near each competition's real scoring, but with about 10% too many wickets (the same bias the IPL
has), so each league has three scoring levels in `LEAGUE_LEVELS` (`venues.ts`): `run` (all scoring, over the grounds' own level),
`wicket` (wicket rate) and `dot` (dot-ball rate). They are applied to the league's home grounds and to its neutral
playoff ground. Fitted per league by a linear fit of simulated runs / wickets / balls per innings over a grid of levels
(6 simulated seasons per point), solved for the real 2024-26 averages of the competition in
`deliveries.parquet` / `matches.parquet`, then verified with 16 simulated seasons per league (this table). The harness
is `packages/app/src/__tests__/calibrate-leagues.test.ts` (`CALIBRATE_LEAGUES=1`).

Since the league XIs (TACTICS.md section 7: CPU franchises pick XIs as real ones do, which bat deeper) and the innings clock's
wicket row (TACTICS.md section 6), the eight men's leagues' `wicket` and `dot` levels were refitted to the same targets (two Newton
steps on the response pooled over the leagues, verified over 32 seasons; the wicket factors moved from 0.84-0.90 to 0.83-0.96: the
former XIs' thin tails had needed fewer wickets). The 32-season verification, men's leagues (the women's and The Hundred's levels are
unchanged): IPL 176.6 runs / 5.94 wickets, BBL 161.1 / 6.44, PSL 169.7 / 6.49, SA20 151.3 / 6.08, CPL 159.7 / 6.35, ILT20 156.4 / 6.15,
MLC 166.6 / 6.37, BPL 152.9 / 6.25, LPL 177.4 / 6.48 (real as in the table).

Since the bowling attack (TACTICS.md section 8: CPU sides choose their bowlers from the whole eleven, so part-timers bowl as real ones do,
which adds about 2 runs and takes 0.08 wickets an innings), the same eight leagues were refitted again (a common correction from the
pooled response, then one Newton step per league at 64 seasons; wicket factors up 0.025-0.055, dot factors -0.024 to +0.037). The
64-season verification: BBL 158.9 / 6.47, PSL 169.1 / 6.43, SA20 153.1 / 6.27, CPL 158.1 / 6.23, ILT20 154.8 / 6.21, MLC 165.9 / 6.45,
BPL 152.4 / 6.43, LPL 174.7 / 6.58 (the IPL, which keeps the former attack and has no levels, 176.4 / 6.00). The table below is the
earlier fit.

Since the Impact Player (TACTICS.md section 9) the IPL has levels of its own, and since section 10 its run level works: `run` is now a
multiplier on every scoring class, sixes included, over the level a league's grounds are set at (the profile's `levelRun`), where it had
scaled the ground's run factor (which the stadium labels read, so a refit was cancelled by the stadium effect, and which reached only the
non-six classes, under a clamp). The extra leagues' `run` is 1, so they are unchanged. The IPL is refitted on 2024 (182.9 runs an innings,
wickets kept where section 9 put them): run 1.17, wicket 1.21; 64 seasons 182.7 runs / 6.06 wickets (before 175.8 / 6.08; real 2025-26
184.1 / 5.96). The IPL's neutral (playoff) grounds now play the league's level, like the extra leagues'; a T20I at an IPL ground plays
none of the IPL's levels.

Since the chase's state term (TACTICS.md section 11: a chase's wicket rate by its pressure, the over and wickets down, neutral on the
engine's own balls, so chases collapse and end all out less often and last longer) the eight extra men's leagues' `wicket` and `dot`
levels were refitted to the same targets once more (one Newton step on the response pooled over the leagues; wicket factors -2.8% to
+0.8%, dot factors -2.3% to +3.6%; the IPL's level as section 10 fitted it). The 128-season verification: BBL 158.6 / 6.42, PSL 168.5 /
6.45, SA20 152.3 / 6.21, CPL 158.3 / 6.21, ILT20 155.3 / 6.26, MLC 165.2 / 6.31, BPL 151.9 / 6.36, LPL 176.8 / 6.63, IPL 184.1 / 6.09.
The balls an innings cannot be fitted through the levels (at fixed runs and wickets their response to the three levels is nearly
singular); they follow the all-outs.

| League | Runs/innings sim | real | Wickets/innings sim | real | Balls/innings sim | real |
|---|---|---|---|---|---|---|
| IPL (engine baseline, not refitted) | 167.6 | 183.7 | 6.84 | 6.05 | 110.4 | 113.7 |
| WPL (not refitted) | 163.6 | 157.8 | 6.85 | 6.2 | 109.9 | 114.6 |
| BBL | 158.1 | 158.3 | 6.46 | 6.47 | 112.4 | 111.9 |
| WBBL | 141.8 | 141 | 6.23 | 6.37 | 112.7 | 108.7 |
| PSL | 169.7 | 169.2 | 6.47 | 6.47 | 112.6 | 112.9 |
| SA20 | 152.2 | 153.4 | 6.18 | 6.21 | 113.5 | 110.2 |
| The Hundred (men) | 138.3 | 137.3 | 5.92 | 5.88 | 95.5 | 92.8 |
| The Hundred (women) | 119.4 | 120.5 | 5.87 | 5.97 | 95.0 | 94.8 |
| CPL | 157.0 | 158 | 6.31 | 6.27 | 112.6 | 111.8 |
| ILT20 | 154.7 | 154.9 | 6.15 | 6.18 | 113.7 | 113.2 |
| MLC | 164.6 | 164.9 | 6.51 | 6.38 | 112.4 | 111.6 |
| BPL | 151.8 | 152.4 | 6.39 | 6.4 | 112.6 | 113.6 |
| LPL | 171.5 | 175.7 | 6.58 | 6.64 | 112.7 | 114.5 |

Every extra league is within about 2% on runs and wickets per innings. The Hundred's 100-ball innings average 95 balls
against 93-95 in the real data. The engine's IPL baseline averages 168 runs against the real 2024-26 IPL's 184 and its
WPL 164 against 158; those are the existing calibration targets and were left alone.

## Home advantage (measured; a league term fitted and not shipped)

**Real home share.** `packages/ratings/src/analysis/home-advantage.py` (output `docs/data/home_advantage.json`). A league match has a
home side when the ground is one of that franchise's own grounds (by name, former names and second homes included) and not one of
the opponent's; shared grounds, hubs, the UAE legs of the IPL and PSL and festival grounds are neutral, and whole bubble seasons are
left out (IPL 2020-22 and 2009, PSL 2021, CPL 2020-21, WBBL 2020-21, WPL 2023). The first-listed side is not used. An international
has a home side when the venue is in one side's country (`venue_map.csv`; full members). Share of decided matches the home side won,
+- its binomial standard error (matches):

| competition | all years | 2021-24 (fit half) | 2025+ (holdout) | engine, actual XIs, fit / holdout |
|---|---|---|---|---|
| IPL | 0.529 +- 0.018 (814) | 0.489 +- 0.042 (139) | 0.457 +- 0.044 (129) | 0.494 / 0.507 |
| PSL | 0.554 +- 0.050 (101) | 0.553 +- 0.072 (47) | 0.567 +- 0.090 (30) | 0.517 / 0.513 |
| BBL | 0.534 +- 0.020 (608) | 0.590 +- 0.036 (190) | 0.597 +- 0.060 (67) | 0.507 / 0.516 |
| SA20 | 0.569 +- 0.047 (109) | 0.569 +- 0.065 (58) | 0.569 +- 0.069 (51) | 0.489 / 0.511 |
| CPL | 0.542 +- 0.029 (297) | 0.485 +- 0.061 (68) | 0.581 +- 0.063 (62) | 0.491 / 0.481 |
| The Hundred (men) | 0.560 +- 0.037 (182) | 0.551 +- 0.046 (118) | 0.578 +- 0.062 (64) | 0.501 / 0.504 |
| ILT20 (three grounds, six sides) | 0.487 +- 0.056 (80) | 0.487 +- 0.080 (39) | 0.488 +- 0.078 (41) | 0.428 / 0.510 |
| MLC (mostly neutral) | 0.438 +- 0.088 (32) | 0.455 +- 0.150 (11) | 0.429 +- 0.108 (21) | 0.526 / 0.470 |
| BPL | 0.469 +- 0.039 (162) | 0.268 +- 0.069 (41) | 0.400 +- 0.098 (25) | (no benchmark) |
| LPL | 0.523 +- 0.075 (44) | 0.559 +- 0.085 (34) | 0.400 +- 0.155 (10) | (no benchmark) |
| WBBL | 0.560 +- 0.032 (241) | 0.540 +- 0.053 (87) | 0.606 +- 0.085 (33) | (no benchmark) |
| The Hundred (women) | 0.472 +- 0.038 (176) | 0.491 +- 0.047 (114) | 0.435 +- 0.063 (62) | (no benchmark) |
| WPL | 0.545 +- 0.087 (33) | 0.800 +- 0.127 (10) | 0.435 +- 0.103 (23) | (no benchmark) |
| T20I men | 0.532 +- 0.017 (822) | 0.552 +- 0.030 (281) | 0.532 +- 0.042 (139) | series tuning home 2: 0.543 / 0.536 (real on its matches 0.545 / 0.552) |
| T20I women | 0.548 +- 0.023 (469) | 0.481 +- 0.036 (187) | 0.635 +- 0.049 (96) | series tuning home 2: 0.558 / 0.665 (real on its matches 0.502 / 0.641) |
| ODI men | 0.590 +- 0.012 (1579) | 0.611 +- 0.033 (216) | 0.635 +- 0.047 (104) | series tuning: home 4 |
| ODI women | 0.584 +- 0.024 (440) | 0.535 +- 0.038 (172) | 0.641 +- 0.050 (92) | series tuning: home 2 |
| Test men (decided) | 0.639 +- 0.018 (695) | 0.583 +- 0.041 (144) | 0.544 +- 0.066 (57) | ball model + series home -1.5 |

The engine column is the league actual-XI benchmark (`league-bench.test.ts`, 128 replays, its own home grounds per franchise; the IPL,
PSL and CPL fit figures still counted the 2021-22 bubble matches at a side's own ground as home; its real shares differ a little from this table's because it keeps only matches whose players the pool has). The
engine gives every league's home side about half, because nothing in league play favours it: the ground's measured factors and chase
edge act on both sides alike. (The T20I engine figures: the country actual-XI benchmark, `BENCH_ACTUAL=1 BENCH_MODES=actual BENCH_REPLAYS=48`, its 2019-24 / 2025+ halves.) The internationals already have home terms fitted on actual XIs and judged out of sample
(docs/COUNTRY-VALIDATION.md, "Test and ODI series tuning"; `series-tuning-data.ts`), so they are not refitted here.

**The term tried.** `packages/engine/src/home-advantage.ts`: on every ball of a league T20 or Hundred match at a side's own ground the
batter-bowler balance of the ball model moves `edge` points toward the home side (for it when it bats, against the visitors when they
bat; one point is what one rating point on each of the six batting and bowling attributes of both sides moves, the series tuning's
unit). It acts in both innings whoever bats first (toss-neutral) and the two innings' scoring changes cancel (the league levels stay
fitted). None at a neutral ground, at a ground both sides call home (ILT20 and MLC share theirs), at a borrowed ground (Draft Match),
in T20Is, ODIs or Tests. Instant and live engines alike (`LEAGUE_HOME`, per league; empty, so no league has one). Ratings are untouched.

**Fit, 2021-24, eight men's leagues** (`home-advantage-fit.py` on benchmark arms at edge 0, 4 and 8, 128 replays; the edge moves the
home side's logit 0.048 a point, about 1.2 points of win share): per-league estimates IPL -0.1 +- 3.8, PSL +2.5 +- 6.3, BBL +9.0 +- 3.3,
SA20 +7.4 +- 5.8, CPL -1.5 +- 5.2, ILT20 -11 +- 11, MLC -2 +- 13, The Hundred +4.3 +- 4.1. They agree within their errors (the
between-league spread beyond noise is 0), so the empirical-Bayes fit is one pooled edge, **+3.7 +- 1.8**, every league shrunk to it.

**Holdout, 2025+** (the engine played at each setting, 256 replays, the same seeds, log loss per match paired against no edge; minus is better):

| league (matches) | pooled edge 3.5 (the fit) | exploratory: each league's own fit, floored at 0 (PSL 2.5, BBL 9, SA20 7.5, Hundred 4.5) | home share real / engine 0 -> pooled |
|---|---|---|---|
| IPL (142) | **+0.0176 +- 0.0079** | 0 | 0.444 / 0.507 -> 0.544 |
| PSL (75) | -0.0015 +- 0.0070 | -0.0047 +- 0.0055 | 0.586 / 0.513 -> 0.552 |
| BBL (64) | +0.0147 +- 0.0141 | +0.0201 +- 0.0301 | 0.571 / 0.516 -> 0.555 |
| SA20 (57) | -0.0088 +- 0.0143 | -0.0127 +- 0.0261 | 0.571 / 0.511 -> 0.560 |
| CPL (61) | -0.0198 +- 0.0139 | 0 | 0.618 / 0.481 -> 0.523 |
| ILT20 (66) | +0.0078 +- 0.0095 | 0 | 0.316 / 0.510 -> 0.563 |
| MLC (41) | +0.0094 +- 0.0075 | 0 | 0.385 / 0.470 -> 0.498 |
| The Hundred (66) | -0.0183 +- 0.0123 | -0.0226 +- 0.0140 | 0.571 / 0.504 -> 0.547 |
| **all (572)** | **+0.0023 +- 0.0039** | **-0.0023 +- 0.0046** | |

**Not shipped.** The fitted term does not predict 2025+ better (+0.0023 +- 0.0039 a match, slightly worse), and it is clearly worse in
the IPL, whose home sides won 44% of 2025+ matches. It does fix the home share where real home sides win 57-62% (PSL, SA20, CPL, The
Hundred), but it misplaces it where they win 32-44% (IPL, ILT20, MLC), so the calibration gain is not clear either. The exploratory
per-league setting is level (-0.0023 +- 0.0046), was chosen after the pooled holdout had been read, and overshoots the BBL (62% against
57% real); it is not evidence enough. `LEAGUE_HOME` stays empty, so league play is ball for ball as before (the fingerprint is
unchanged); the hook stays for benchmark arms (`LB_HOME`). Women's leagues have no actual-XI benchmark (most of their players are not in
the pool); their real home shares (WBBL 0.56, The Hundred 0.47, WPL 0.55 on 33 matches) do not make a case on their own.

Rerun: `cd packages/ratings && python3 -I src/analysis/home-advantage.py`; benchmark arms
`LEAGUE_BENCH=1 LB_LEAGUES=ipl,psl,bbl,sa20,cpl,ilt20,mlc,hundred-m LB_REPLAYS=128 LB_HOME='{"bbl":4,...}' LB_DUMP=<dir>/h4-r128 [LB_HALF=fit|hold] npx vitest run packages/app/src/__tests__/league-bench.test.ts`
(one per edge, every league at that edge), then `python3 -I src/analysis/home-advantage-fit.py <dir> r128 0 4 8`. The Hundred's
actual XIs are in their own files (`docs/data/league_xi_hundred.json`, `league_results_hundred.json`: `LXI_LEAGUES=hundred-m` in
`generate-league-xi.ts` and `LXI_IN` / `LXI_OUT` in `generate-league-results.ts`), so `league_xi.json` and the fits on it are unchanged.

## Verification

* `packages/engine/src/__tests__/leagues.test.ts`: registry, rules and venues of every league, balanced schedules
  (every team plays exactly its quota), the three playoff brackets, the Hundred's 100-ball innings (5-ball sets, 20-ball bowler cap,
  no three sets in a row) and a full season to a champion for every league.
* `packages/engine/src/__tests__/home-advantage.test.ts`: the home edge (unset in play) only at a side's own ground in league play,
  its sign on the ball, and both engines playing it (the home side wins more; a neutral ground ball for ball as without it).
* `packages/ratings/src/__tests__/league-players.test.ts`: squads fit each league's squad and overseas limits, one keeper per
  team, unique players, pool match-rate floors, the CricketArchive-pool hook.
* `packages/app/src/__tests__/leagues.test.ts`: every league loads into a game with valid squads and XIs, plays a full
  match-by-match season (group stage, playoffs, final) the way the Season page does, and pool players keep their ratings
  across leagues; `setup-page.test.ts` server-renders the Setup page for every league (picker button, teams, rules).

## Regenerating

```bash
cd packages/ratings
python3 -I src/analysis/export-engine-venues.py        # grounds -> engine/src/venue-data.ts
python3 -I src/analysis/build-league-rosters.py        # squads + teams + rules (about 10 minutes)
cd ../.. && npm run build
```

Edit `league_defs.py` to change a team, ground, colour or rule and rerun both scripts.
