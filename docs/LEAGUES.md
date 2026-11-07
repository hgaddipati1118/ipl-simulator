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
has), so each league has three scoring levels in `LEAGUE_LEVELS` (`venues.ts`): `run` (scales the ground's run factor),
`wicket` (wicket rate) and `dot` (dot-ball rate). They are applied to the league's home grounds and to its neutral
playoff ground. Fitted per league by a linear fit of simulated runs / wickets / balls per innings over a grid of levels
(6 simulated seasons per point), solved for the real 2024-26 averages of the competition in
`deliveries.parquet` / `matches.parquet`, then verified with 16 simulated seasons per league (this table). The harness
is `packages/app/src/__tests__/calibrate-leagues.test.ts` (`CALIBRATE_LEAGUES=1`).

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

## Verification

* `packages/engine/src/__tests__/leagues.test.ts`: registry, rules and venues of every league, balanced schedules
  (every team plays exactly its quota), the three playoff brackets, the Hundred's 100-ball innings (5-ball sets, 20-ball bowler cap,
  no three sets in a row) and a full season to a champion for every league.
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
