# Match formats

The engine plays three limited-overs formats; a Test section will follow.

| Format | Spec (`format.ts`) | Balls | Per bowler | Ball model | Live viewer |
|---|---|---|---|---|---|
| T20 | `T20_FORMAT` | 20 overs of 6 | 4 overs, never two in a row | T20 tables (`match.ts`, RULES-MATCH.md 12) | yes |
| The Hundred | `HUNDRED_FORMAT` | 20 sets of 5 | 20 balls, up to two sets in a row | T20 tables, phases stretched (`phaseOver`) | no (instant only) |
| ODI | `ODI_FORMAT` | 50 overs of 6 | 10 overs, never two in a row | its own, fitted on ODIs (`odi-model.ts`) | yes |

`RuleSet.matchFormat` picks the format (`matchFormatFor`). The T20 and Hundred paths are untouched by the ODI: the same seed
plays the same match ball for ball (`__tests__/fingerprint-matches.ts`, below).

## ODI

### Rules

| Rule | Where |
|---|---|
| 50 overs of six balls a side | `ODI_FORMAT` (`overs`, `totalBalls`) |
| A bowler bowls at most 10 overs and never two in a row; in an innings cut short by rain, a fifth of its overs | both engines' bowler choice; `odiCap` (instant), `applyOdiRain` (live) |
| Fielding restrictions: at most 2 fielders outside the circle in overs 1-10, 4 in 11-40, 5 in 41-50 | `ODI_FORMAT.fieldingRestrictions`, `maxFieldersOutside`; their effect on play is in the fitted over profile |
| A new ball from each end in men's ODIs (each ball about half as old as the innings), one ball in women's | `ODI_FORMAT.newBallEachEnd`, `ballAgeOvers`; the effect (swing early, little reverse, spin) is in the fitted pace / spin profiles, per gender |
| No Impact Player, no strategic timeouts, no tactical retirements | `simulateMatch`, `createMatchState` (an ODI drops `impactPlayer`) |
| No-ball: one extra and a free hit | `ODI_FORMAT.noBallPenalty`, shared delivery rules |
| DRS: two reviews a side an innings | shared `drs.ts` |
| Rain: fitted ODI rates, DLS over 50-over resources, 20 overs a side for a result | `planRain` (`ODI_RAIN`), `dls.ts` (`dlsGFor`, `DLS_G_ODI`, `odiRevisedTarget`) |
| A tie stands (a point each, counted in the net run rate); a super over only where the competition plays one (ICC event knockouts) | `MatchOptions.superOver` / `LiveMatchOptions.superOver` (default false for an ODI) |
| A super over is the same six balls as a T20's | the super over innings play on the T20 model |

### Playing one

```ts
import { odiRules, simulateMatch, createMatchState } from "@ipl-sim/engine";

const rules = odiRules("men");            // or "women"; squad / auction fields from a base RuleSet (default DEFAULT_RULES)
simulateMatch(home, away, rules, seed, { venueName: "Melbourne Cricket Ground", rain: true });
simulateMatch(home, away, rules, seed, { superOver: true }); // an ICC knockout: a tie goes to super overs
createMatchState(home, away, rules, userTeamId, seed, { venueName, rain: true, superOver: false });
```

Players play on their ODI ratings where they have them: both engines use `player.forFormat("odi")` (the ratings pipeline's
sets, attached in the app by `packages/app/src/format-ratings.ts`), and a player without an ODI set plays on his T20
ratings. Injuries and season stats are recorded on the players themselves, not the views. An ODI ground is looked up by
name (`MatchOptions.venueName`, else the home side's `stadiumName`) in `odi-venue-data.ts`: 122 grounds with 10+ ODIs
(96 men's, 26 women's) from the venue analysis (`venue_factors.csv`, List A x ODI). T20 league levels never apply to an ODI.
Exports for the app: `ODI_FORMAT`, `odiRules`, `hasOwnBallModel`, `maxFieldersOutside`, `ballAgeOvers`, `liveMatchFormat`,
`LiveMatchOptions`, the model (`odiBallProbabilities` and its tables) and the DLS helpers.

### Where the format hooks in

- `format.ts`: `ODI_FORMAT`; `hasOwnBallModel(fmt)` is true for the ODI only, and every ODI branch in the engines hangs on it
  (or on `rules.matchFormat === "odi"` in the live engine), so a T20 or Hundred ball takes exactly the old path.
  `phaseOver` maps ODI overs 1-10 / 11-40 / 41-50 onto T20's powerplay / middle / death for phase-keyed plans.
- `match.ts`, `simulateBall`: an ODI ball starts from `odiBallProbabilities` instead of the T20 base matrix, phase multipliers,
  chase adjustment and IPL ball-change rule; the T20 phase modifier of the bowling type is skipped (`noPhase`: the ODI model has
  its own); the clutch window is the last three overs of the innings; the dismissal mix is the ODI's (`ODI_DISMISSAL_MIX`,
  more bowled and lbw). Venue, hand matchups, morale, the over-rate restriction, free hits, fielding, DRS, extras detail and the
  rare plays are shared.
- `match.ts`, `simulateInnings`: the captain spreads ten-over quotas (`odiBowlerChoices`: while every quota is needed, only a
  bowler after whose over all of them can still be finished in alternate overs; before the last fifth the two best keep three
  overs each), then one of the best three as in a T20; caps for rain-shortened innings; no tactical retirements.
- `match.ts`, `simulateMatch`: format views for the XIs; no Impact Player or timeouts; ODI venue and toss (60% of 2019+ toss
  winners in men's ODIs fielded, 57% in women's); ODI rain plan and G; ties.
- `live-match.ts`: `runOneBall` takes the same ODI model (with the user's aggression applied as the relative change the live T20
  model gives it, neutral at 50, and the batter's form); the live-only T20 nuances (phase multipliers, set-batter and fatigue
  bonuses, home edge, the "IPL 2025 era" boost, dew extras) are off for an ODI. Batting and bowling orders on the ODI ratings,
  the CPU bowls its best (the user's own bowling plan, if he set one, first), the user's bowler choice lists only bowlers under
  their cap who did not bowl the last over; the rain plan is drawn at the start (`LiveMatchOptions.rain`) and applied between
  overs (`applyOdiRain`), with the DLS target at the break or at the cut; no retire-out or strategic-timeout decisions.

### The ball model

`packages/ratings/src/analysis/odi-ball-model.py` fits per-delivery rates of the ten outcome classes (dot, 1, 2, 3, 4, 6,
wicket, wide, no-ball, bye / leg bye) on Cricsheet ODIs: full 50-over matches (no rain revision), men 2012+ (two new balls
since October 2011; 1,389 matches, 764,919 deliveries), women 2010+ (522 matches, 284,146 deliveries), recent seasons weighted
more (half-life six years):

    rate_k = base_k x over_k x wickets_k(down, overs) x set_k(balls faced) x chase_k(required rate, stage) x era_k
             x bowlerType_k(pace / spin, overs) x batter_k x bowler_k

Each class is a Poisson rate, fitted by iterative proportional fitting with Poisson-gamma shrinkage toward 1 (10 pseudo-events
for context levels, 20 for players; the women's context factors shrink toward the men's with 40). The batter and bowler
effects take the players' own quality out of the situation effects (seven down, the tail is in: that is the batters, not the
situation); they are not exported, because the engine gets quality from ratings. Every context factor is normalised to mean 1
over the 2019+ deliveries, so `base` is the average 2019+ ODI delivery: men 5.03 runs an over and a wicket every 36 balls,
women 4.36 and every 35. The output is `packages/engine/src/odi-model-data.ts` (tables, `ODI_DISMISSAL_MIX`, `ODI_RAIN`) and
`odi-venue-data.ts`; the report is `docs/data/odi_ball_model.json`, the validation targets `docs/data/odi_validation.json`.

What the fit shows (men; each factor as a multiple of runs and of the wicket rate at an otherwise average delivery; the over
profile and the overs buckets of the wickets table share the timing, so compare rows within one bucket):

| Situation | Effect |
|---|---|
| Wickets in hand, same overs | overs 1-10: 0 down runs x1.11, 3 down x0.82; overs 31-40: 0-1 down x1.22, 5 down x0.94, 7 down x0.83; overs 46-50: 3 down x1.28 with wickets x1.34, 8+ down x0.96 with wickets x1.52 (keep wickets, then charge; a side seven down cannot) |
| A set batter (balls faced) | first ball runs x0.62, wickets x0.85; 1-4 balls x0.77; 10-19 x1.01; 35-99 x1.10-1.14; 100+ wickets x1.16 |
| The chase | needing 8-10 an over in overs 21-35: runs x1.19-1.27, wickets x1.16-1.23; 10-12 in overs 36-45: x1.21, wickets x1.34; needing under 4 in the last five overs: x0.82-0.86, wickets x0.71-0.84 |
| Era | at the same situation 2010-14 scored x0.93 and 2015-18 x0.98 of 2019-26 |
| Bowler type over the innings | each type against its own average: spin concedes x1.06 in overs 1-10 (pace x0.96, the fielding restrictions and the new balls); both take about a third more wickets in overs 41-50 |
| Dismissals (legal balls, 2019+) | caught 58.0%, bowled 19.9%, lbw 11.8%, run out 5.4%, c&b 3.1%, stumped 1.7% (women: 49.1 / 21.7 / 13.1 / 8.1 / 4.3 / 3.7) |
| Rain (ODIs 2012+) | men: no result 3.6% of matches, reduced with a result 11.3% (cut before the start 46%, in the first innings 15%, in the chase 39%); women 3.1% / 11.2% |

**Player quality** (`odiRatingMultipliers`) is log-linear in the rating composites the T20 model uses (batter - bowler balance
of `(battingOvr + timing) / 2` and `(bowlingOvr + accuracy) / 2`, timing for fours, power for sixes, wicket-taking for wickets,
accuracy for wides and no-balls), measured from `ODI_REF`, the involvement-weighted mean of the replayed national XIs on their
ODI ratings (balls faced, balls bowled). The slopes started from the T20 model's sensitivities and were set so the simulated
spread of batters' rates is near the real one (real sd of log batter effects among 2019+ regulars: wickets 0.15, fours 0.15,
sixes 0.28; simulated 0.20 / 0.17 / 0.35 on the ODI ratings); a batter's shortfall below the reference counts half
(`ODI_TAIL_WEIGHT`: on full weight a number ten scores at half the real tail's rate). `ODI_RATING_SCALE` (men 0.9, women 1.25)
sets the team spread: women's ODI sides are further apart than men's.

**Calibration** (`ODI_CAL`, per gender x phase x outcome): the full engine adds layers the fit does not see (hand matchups,
fielding, free hits) and the game's ratings put different players in different states than the real ones (a better top order
in the powerplay, more tail-enders at the death), so a replay of the real fixture list misses the real per-delivery rates by
phase. `ODI_CAL` is the ratio that closes it, iterated until it settles. The largest corrections are on sixes (men's overs 1-10
x0.58, 11-40 x0.77; women's x0.39 / x0.65) and death-over wickets (x0.82): the ratings over-reward the top order's power.

### Validation

`npx tsx packages/engine/src/__tests__/benchmark-odi.ts [replays=2] [men|women|both]` replays the real 2019+ ODI fixture list
(men 886 fixtures between 21 national sides, women 430 between 17) with national pools built from the game's players
(`ALL_PLAYERS` / `WPL_PLAYERS` by Cricinfo id: everyone who batted or bowled for the side, the squad its 20 most involved,
the XI the engine's own pick) on their ODI ratings, neutral venues, rain off, every match seeded. Real: Cricsheet ODIs
2019+, full matches. Instant engine, two replays of each fixture:

| | men sim | men real | women sim | women real |
|---|---|---|---|---|
| 1st-innings total: mean (sd) | 251.9 (74.9) | 253.1 (71.0) | 226.8 (69.2) | 227.4 (69.1) |
| 10 / 25 / 50 / 75 / 90th percentile | 147 / 205 / 260 / 307 / 345 | 157 / 206 / 258 / 299 / 342 | 132 / 179 / 230 / 276 / 317 | 139 / 180 / 225 / 272 / 320 |
| 300+ / 350+ / under 200 | 28.4% / 8.0% / 23.0% | 24.8% / 8.2% / 22.2% | 15.6% / 2.9% / 34.7% | 15.6% / 3.6% / 35.0% |
| run rate overs 1-10 / 11-40 / 41-50 (1st inns) | 4.68 / 5.01 / 7.66 | 4.60 / 4.91 / 7.67 | 4.23 / 4.60 / 6.60 | 4.17 / 4.53 / 6.52 |
| 1st inns: wickets / all out | 8.08 / 44.0% | 8.35 / 41.1% | 8.14 / 49.0% | 8.32 / 45.3% |
| 2nd inns: runs / wickets / all out | 209.5 / 6.66 / 39.0% | 217.8 / 6.93 / 38.5% | 179.7 / 6.52 / 41.9% | 186.9 / 6.69 / 36.1% |
| batting first wins / ties | 47.6% / 0.8% | 47.6% / 1.2% | 50.6% / 1.0% | 46.9% / 1.4% |
| 100s / 50s per match | 0.68 / 2.10 | 0.63 / 2.30 | 0.47 / 1.82 | 0.44 / 1.87 |
| extras / fours / sixes (1st inns) | 13.0 / 21.2 / 5.4 | 13.2 / 21.2 / 5.2 | 14.4 / 22.2 / 1.5 | 14.7 / 21.8 / 1.6 |
| caught / bowled / lbw / run out / c&b / stumped | 58.0 / 20.1 / 11.1 / 5.5 / 3.2 / 2.0% | 57.8 / 19.9 / 11.8 / 5.5 / 3.0 / 1.9% | 48.3 / 21.9 / 12.5 / 8.4 / 4.1 / 4.7% | 49.0 / 21.6 / 13.1 / 8.2 / 4.3 / 3.8% |

Batting position averages / strike rates (men, sim | real): openers 36-41 / 88-89 | 33-34 / 84-86; 3-4: 38-40 / 85-87 |
37-38 / 82-83; 5-7: 21-32 / 78-82 | 24-35 / 86-87; 8-11: 9-16 / 62-75 | 7-19 / 54-86. The top order is a little too
productive and the lower middle order (6-8) scores a little slower than the real one.

**Strong against weak** (the same fixtures; "net" removes the binomial noise of a win share over n matches):

| | men sim | men real | women sim | women real |
|---|---|---|---|---|
| sides' win shares: sd (net of noise) | 0.16 (0.15) | 0.12 (0.10) | 0.17 (0.16) | 0.19 (0.17) |
| correlation of each side's win share, sim with real | 0.76 | | 0.81 | |
| full members v associates: the full member wins | 71.1% | 77.9% (70 matches) | 65.8% | 66.7% (30) |
| leading sides v the other full members (men: Ind, Aus, SA, NZ, Eng, Pak; women: Aus, Eng, Ind, SA) | 63.6% | 71.4% (199) | 81.8% | 84.2% (184) |

The correlation is the ratings' as much as the engine's: on the T20 ratings it was 0.55 (men) and 0.82 (women). Misses that
are the ratings': Scotland (real 66% over these fixtures, sim 51%), Australia women (92% / 70%), the United States (57% / 72%).

**On T20 ratings** (`FORMAT_RATINGS=none`, the fallback for players without an ODI set): men 239.7 (sd 68.7), 300+ 20.0%,
all out 48.3%, top six v other full members 61.9%; women 221.8 (64.8), 300+ 10.4%, all out 48.8%, top four 78.3%. Scoring is
about 5% (men) / 2.5% (women) lower and the spread a little narrower, because the T20 composites sit above the ODI reference.

**Live engine** (`ENGINE=live`, CPU v CPU, one replay of each fixture, ODI ratings): the same model and captaincy, so within
the noise of the instant engine:

| | men live | men instant | women live | women instant |
|---|---|---|---|---|
| 1st-innings total: mean (sd) | 251.9 (74.9) | 251.9 (74.9) | 228.0 (67.1) | 226.8 (69.2) |
| 300+ | 28.8% | 28.4% | 15.7% | 15.6% |
| run rate overs 1-10 / 11-40 / 41-50 | 4.72 / 5.03 / 7.62 | 4.68 / 5.01 / 7.66 | 4.15 / 4.63 / 6.51 | 4.23 / 4.60 / 6.60 |
| 1st inns: wickets / all out | 8.10 / 46.0% | 8.08 / 44.0% | 8.11 / 46.7% | 8.14 / 49.0% |
| batting first wins | 49.8% | 47.6% | 49.5% | 50.6% |
| 100s per match | 0.65 | 0.68 | 0.46 | 0.47 |
| leading sides v the other full members | 60.6% | 63.6% | 85.9% | 81.8% |

(Before the live CPU captain bowled his best bowlers, the T20 phase plan bowled about two points of bowling rating weaker per
ball and a live ODI scored 8-10 runs more than an instant one.)

**T20 and The Hundred unchanged**: `npx tsx packages/engine/src/__tests__/fingerprint-matches.ts 300` hashes every ball of 300
instant T20 matches (men, men with rain, women), 300 Hundred matches with rain, and 100 live T20 matches each CPU v CPU and with
a user side. The hashes on this branch equal the ones before the ODI work and on main (`90919c560ce4405b` combined).

### Refitting

1. `cd packages/ratings && python3 -I src/analysis/odi-ball-model.py` (needs `duckdb`; several minutes; `REUSE_FIT=1` reruns only
   the exports and validation targets from the last fit). It writes `odi-model-data.ts`, `odi-venue-data.ts` and the two
   `docs/data` files.
2. `CALIBRATE=1 npx tsx packages/engine/src/__tests__/benchmark-odi.ts 2 both`: prints the involvement-weighted composites
   (new `ODI_REF`), the per-phase rates against the real ones and a suggested `ODI_CAL`. Try values with
   `ODI_TUNE='{"cal":{"male":[[...],[...],[...]]},"scale":{"female":1.25}}'` and repeat until the suggestion stops moving (three
   or four rounds), then write them into `odi-model.ts`. Refit after the ratings change.
3. `npx vitest run packages/engine/src/__tests__/odi.test.ts` and the fingerprint script.

### Not done / limits

- The fielding restrictions and the second new ball act through the fitted over and bowler-type profiles, not through a field
  the engine places; the live viewer's field settings are the T20 ones.
- Venues: run, six and wicket factors of the 122 ODI grounds; no per-ground bowler-type edges or chase records for ODIs, and the
  ODI run gain (`ODI_VENUE_RUN_GAIN` 1.6) is the T20 value, not separately calibrated.
- The model has no match-level conditions (pitch, weather) beyond the ground; state effects such as "0 down after 30 overs" may
  partly carry good batting conditions with them.
- The Duckworth-Lewis-Stern G for women's ODIs (227) is the data's first-innings average, not a published value; men's 245.
- Strategic decisions a real ODI captain makes (powerplay field choices, holding a bowler for a matchup) are not modelled.
- `ODI_CAL` and the rating slopes are tuned on the national pools in this game; other XIs (franchise sides playing an ODI,
  generated players) are not validated.

## In the app

### International series (`/international`)

Reached from the Setup page ("International") and the top navigation. `packages/app/src/international.ts` holds the logic
(pure TypeScript, unit-tested in `src/__tests__/international.test.ts`); `src/pages/InternationalPage.tsx` the screens.

- **Setup**: men or women; two nations (every nation with 14+ shipped players aged 40 or under and six bowling options:
  `ALL_PLAYERS` for men, `WPL_PLAYERS` for women); the format; 1, 3 or 5 matches; the venue (the host's grounds in turn,
  most used first, from the ODI venue analysis; or neutral); captain one side or watch.
- **Squads**: the nation's 16 best by XI value on the format's ratings (a player's `ratings` is his ODI set for an ODI,
  attached from `public/data/format-ratings.json` like the rest of the app; T20 ratings for a T20I), with a keeper (the best
  gloveman if the data flags none) and six bowling options. Ids are the record ids (`espn_<id>`), so a saved series rebuilds
  the same squads.
- **Before each match** the captain can pick his XI from the squad and set the batting order (the Draft Match lineup editor);
  the CPU side gets the engine's own XI and order. A saved lineup carries over to the next match.
- **Each match** is played live (`LiveMatchPage`, with the user's decisions for his side) or simulated instantly; rain is on
  (the fitted rates, DLS). "Simulate the rest" plays out the series; a series decided early skips its dead rubbers.
- **Series view**: the score ("India lead 2-1", "Series drawn 1-1"), each match's result, innings totals, player of the match
  and mode, a scorecard per match (batting and bowling cards, extras, fall of wickets, worm), series stats (most runs with
  innings, high score, average, strike rate, 100s/50s; most wickets with overs, average, economy, best) and player of the
  series (runs plus 20 a wicket).
- **Persistence**: one localStorage key, `ipl-sim-intl-series-v1` (a match record keeps the scorecards and the over-by-over
  worm, not the ball log). A live match in progress is saved by the live page under its own namespace (season -2, Draft Match
  uses -1) and resumes after a reload. Career saves, presets and multiplayer are untouched.

**Adding a format.** `SERIES_FORMATS` is a list of `SeriesFormatDef`: its label, the ratings it plays on (`ratingFormat`),
the series lengths it offers, `simulate(ctx)` returning a `SeriesMatchRecord` (any number of innings scorecards, a winner
or none), and optionally `live` (`viewer`, `create`, `finish`). Results, the series score (draws and ties count as shared)
and the stats only read records, so a Test entry (`simulateTestMatch`, four innings over days, draws, its own live screen
under a new `viewer` id) needs its entry plus a branch for its viewer in `InternationalPage`; `registerSeriesFormat` adds one
at run time.

### Draft Match

The setup has a T20 / ODI choice. An ODI draft plays 50-over matches (`draftMatchRules(maxOs, "odi", women)`, the women's
model for a women's pool) and its pool is on ODI ratings (`toOdiPool`), so the draft board, the lineups and the match read
the ODI sets; players without one keep their T20 ratings. Multiplayer Draft Match stays T20 (`DraftMatchStart.format` is
optional, absent = T20).

### Live ODI (`LiveMatchPage`)

The page reads the format from the match's rules (`liveMatchFormat`): the overs counter shows `/ 50` (or the overs left
after rain), run rate, required rate, progress and win probability (the T20 model on a stretched par, `totalOvers`) work for
50 overs, the worm spans the innings, and a chip shows the fielding-restriction phase (P1 / P2 / P3 with the fielders allowed
out, in proportion in a shortened innings). The bowler picker lists only bowlers under their cap who did not bowl the last
over, with "3/10 ov · 7 left". After rain the chase shows "DLS target 306 in 48 overs" and the rain banner the revised
target. No Impact Player or strategic-timeout prompts appear (the engine raises none in an ODI). A live match is now also
saved when the page is left for another route.

### Checked

`npx vitest run packages/app packages/engine` (the series logic, Draft Match ODI), `npm run build`, and
`E2E_PORT=3893 npx playwright test e2e/international.spec.ts` (start an ODI series, simulate a match, play live balls, pick the
XI, open the scorecard, reload and resume; a Draft Match ODI to its result; `Math.random` is seeded in the page so the runs
repeat). `E2E_PORT` runs the app on another port when several checkouts share the machine.

Not done: the T20I is the franchise-calibrated T20 engine (T20I scoring is not separately validated); live win probability in
an ODI uses the T20 model on a stretched par, which reads generous to the chasing side; no multiplayer series; the series
does not feed career stats.
