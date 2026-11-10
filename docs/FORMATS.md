# Match formats

The engine plays three limited-overs formats and Test cricket, which has its own engine (section "Test" below).

| Format | Spec (`format.ts`) | Balls | Per bowler | Ball model | Live viewer |
|---|---|---|---|---|---|
| T20 | `T20_FORMAT` | 20 overs of 6 | 4 overs, never two in a row | T20 tables (`match.ts`, RULES-MATCH.md 12); a series' T20Is add the T20I level (section "T20I level") | yes |
| The Hundred | `HUNDRED_FORMAT` | 20 sets of 5 | 20 balls, up to two sets in a row | T20 tables, phases stretched (`phaseOver`) | no (instant only) |
| ODI | `ODI_FORMAT` | 50 overs of 6 | 10 overs, never two in a row | its own, fitted on ODIs (`odi-model.ts`) | yes |
| Test | `test-match.ts` (its own state machine) | two innings a side, up to 5 days of 90 overs | no cap: fitted spells and rest, never two overs in a row | its own, fitted on Tests (`test-model-data.ts`) | yes (`LiveTestPage`) |

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
sixes 0.28; simulated on the round-2 ODI sets: men 0.18 / 0.15 / 0.31, women 0.30 / 0.26 / 0.52 against 0.15 / 0.19 / 0.24);
a batter's shortfall below the reference counts half (`ODI_TAIL_WEIGHT`: on full weight a number ten scores at half the real
tail's rate). `ODI_RATING_SCALE` (men 0.9, women 1.45; 1.25 on the round-1 sets) sets the team spread: women's ODI sides are
further apart than men's. The women's batters are already too far apart one by one while their sides are not far enough
apart (the ratings' order of the sides is off: correlation 0.69), so the scale trades one for the other.

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
2019+, full matches. Instant engine, two replays of each fixture, on the round-2 ODI sets (docs/FORMAT-RATINGS-REPORT.md:
format roles from List A workload, the level carried by battingIQ / wicketTaking, timing from the four rate, power from the
six rate) with `ODI_REF`, `ODI_CAL` and the women's `ODI_RATING_SCALE` (1.45) recalibrated on them:

| | men sim | men real | women sim | women real |
|---|---|---|---|---|
| 1st-innings total: mean (sd) | 252.0 (70.3) | 253.1 (71.0) | 224.3 (72.2) | 227.4 (69.1) |
| 10 / 25 / 50 / 75 / 90th percentile | 150 / 206 / 260 / 302 / 337 | 157 / 206 / 258 / 299 / 342 | 123 / 174 / 229 / 277 / 311 | 139 / 180 / 225 / 272 / 320 |
| 300+ / 350+ / under 200 | 26.3% / 6.7% / 23.1% | 24.8% / 8.2% / 22.2% | 15.3% / 3.6% / 35.2% | 15.6% / 3.6% / 35.0% |
| run rate overs 1-10 / 11-40 / 41-50 (1st inns) | 4.73 / 4.95 / 7.70 | 4.60 / 4.91 / 7.67 | 4.22 / 4.58 / 6.62 | 4.17 / 4.53 / 6.52 |
| 1st inns: wickets / all out | 8.16 / 44.1% | 8.35 / 41.1% | 8.15 / 46.9% | 8.32 / 45.3% |
| 2nd inns: runs / wickets / all out | 209.3 / 6.84 / 40.6% | 217.8 / 6.93 / 38.5% | 177.2 / 6.51 / 40.3% | 186.9 / 6.69 / 36.1% |
| batting first wins / ties | 49.0% / 0.3% | 47.6% / 1.2% | 49.2% / 0.4% | 46.9% / 1.4% |
| 100s / 50s per match | 0.60 / 2.14 | 0.63 / 2.30 | 0.46 / 1.77 | 0.44 / 1.87 |
| extras / fours / sixes (1st inns) | 13.1 / 21.3 / 5.4 | 13.2 / 21.2 / 5.2 | 14.1 / 21.8 / 1.5 | 14.7 / 21.8 / 1.6 |
| caught / bowled / lbw / run out / c&b / stumped | 57.5 / 20.2 / 11.6 / 5.6 / 3.0 / 1.9% | 57.8 / 19.9 / 11.8 / 5.5 / 3.0 / 1.9% | 48.9 / 21.2 / 12.1 / 8.6 / 4.4 / 4.8% | 49.0 / 21.6 / 13.1 / 8.2 / 4.3 / 3.8% |

Before the recalibration (round-2 sets on the round-1 constants): men 240.4 (sd 71.3), 300+ 20.6%, run rates 4.44 / 4.85 /
7.48, all out 47.3%, 100s 0.53 a match; women 227.3 (63.6), 300+ 12.5%, leading four v the other full members 75.0%. On the
round-1 sets the constants had given men 251.9 (74.9) and women 226.8 (69.2).

Batting position averages / strike rates (men, sim | real): openers 37-38 / 88 | 33-34 / 84-86; 3-4: 36-38 / 83-85 |
37-38 / 82-83; 5-7: 21-34 / 78-84 | 24-35 / 86-87; 8-11: 10-16 / 67-75 | 7-19 / 54-86. The openers are a little too
productive and the lower middle order (6-8) scores a little slower than the real one.

**Strong against weak** (the same fixtures; "net" removes the binomial noise of a win share over n matches):

| | men sim | men real | women sim | women real |
|---|---|---|---|---|
| sides' win shares: sd (net of noise) | 0.12 (0.11) | 0.12 (0.10) | 0.17 (0.16) | 0.19 (0.17) |
| correlation of each side's win share, sim with real | 0.73 | | 0.69 | |
| full members v associates: the full member wins | 68.2% | 77.9% (70 matches) | 75.0% | 66.7% (30) |
| leading sides v the other full members (men: Ind, Aus, SA, NZ, Eng, Pak; women: Aus, Eng, Ind, SA) | 67.3% | 71.4% (199) | 81.4% | 84.2% (184) |

(Round-1 sets: sd 0.16 (0.15) / 0.17 (0.16), correlation 0.76 / 0.81, leading sides 63.6% / 81.8%.) The correlation is the
ratings' as much as the engine's: on the T20 ratings it was 0.55 (men) and 0.82 (women). Misses that are the ratings':
Scotland (real 66% over these fixtures, sim 51%), the United States (57% / 71%), Pakistan (54% / 41%); women Australia (92% /
76%), Thailand (65% / 29%), the Netherlands (29% / 57%). The women's correlation fell from 0.81 to 0.69 with the round-2 sets
(the same constants give 0.67); the recalibration does not recover it.

**On T20 ratings** (`FORMAT_RATINGS=none`, the fallback for players without an ODI set): men 253.1 (sd 70.1), 300+ 27.0%,
all out 43.8%, top six v other full members 66.0%, team win-share correlation 0.43; women 221.4 (71.7), 300+ 14.9%, all out
50.6%, top four 80.2%, correlation 0.75. With the round-2 reference (lower batting composites) the T20 sets now score at the
real level for the men (they were 5% low on the round-1 constants) and 1.3% under the ODI sets for the women; the men's side
order is much worse on T20 ratings (0.43 against 0.73).

**Live engine** (`ENGINE=live`, CPU v CPU, one replay of each fixture, ODI ratings): the same ball chain and captaincy, so
within the noise of the instant engine (one replay: about 2.5 runs on the men's mean, 3.5 on the women's):

| | men live | men instant | women live | women instant |
|---|---|---|---|---|
| 1st-innings total: mean (sd) | 252.6 (73.4) | 252.0 (70.3) | 222.9 (70.2) | 224.3 (72.2) |
| 300+ | 28.4% | 26.3% | 14.5% | 15.3% |
| run rate overs 1-10 / 11-40 / 41-50 | 4.73 / 4.98 / 7.86 | 4.73 / 4.95 / 7.70 | 4.15 / 4.60 / 6.41 | 4.22 / 4.58 / 6.62 |
| 1st inns: wickets / all out | 8.07 / 41.6% | 8.16 / 44.1% | 8.29 / 52.3% | 8.15 / 46.9% |
| batting first wins | 48.6% | 49.0% | 44.1% | 49.2% |
| 100s per match | 0.63 | 0.60 | 0.42 | 0.46 |
| leading sides v the other full members | 67.8% | 67.3% | 76.6% | 81.4% |

(Before the live CPU captain bowled his best bowlers, the T20 phase plan bowled about two points of bowling rating weaker per
ball and a live ODI scored 8-10 runs more than an instant one.)

**Fingerprint**: `npx tsx packages/engine/src/__tests__/fingerprint-matches.ts 300` hashes every ball of 300
instant T20 matches (men, men with rain, women), 300 Hundred matches with rain, and 100 live T20 matches each CPU v CPU and with
a user side. The ODI work left every line as it was. Since then, on purpose:

| change | instant men / men rain / women / Hundred | live CPU / user | combined |
|---|---|---|---|
| before the ODI work | `81d0471a218f9e03` / `886e09f301bed9f4` / `44cb21795e248267` / `c21a7f5308560ea1` | `7976b1a6fb569b50` / `c52cfbcc19c0d6ce` | `90919c560ce4405b` |
| live engine on the instant engine's ball (RULES-MATCH.md 12.4) | unchanged | `5fb19cfd90456037` / `8701f337d6b4e5fc` | `657e769a9f784f1c` |
| women's league contexts (RULES-MATCH.md 12.7): the women's line only | women `7d214ad967890a1c` | unchanged | `c83288e1be6891af` |
| the IPL's shape and match conditions (RULES-MATCH.md 12.8): all but the women's line | `48ec01dbb07dbc66` / `a4b19bc607589f48` / women unchanged / `35656ed4f9692502` | `c6092d833b2d11a6` / `b8cea85a7ee08af0` | `efa2366c3cb4e486` |
| wickets in hand, conditions refitted (RULES-MATCH.md 12.9): every line | `c3ec93bf630671cb` / `c7eb7766f258c4a9` / `bc0c2eaf9dd01cf8` / `85a482996e20d465` | `81b3d54bfe0ed362` / `b12b68652253c070` | `fa1132e42d640731` |
| a new batter's set term, refits (RULES-MATCH.md 12.10): every line | `fb77411d4def97b1` / `fcd1034152f2d622` / `a620d4744798119a` / `19c5499b6b2e0689` | `affd24e1d22c9d81` / `253902f78c7f51a5` | `8323aef815cac7df` |

### Refitting

1. `cd packages/ratings && python3 -I src/analysis/odi-ball-model.py` (needs `duckdb`; several minutes; `REUSE_FIT=1` reruns only
   the exports and validation targets from the last fit). It writes `odi-model-data.ts`, `odi-venue-data.ts` and the two
   `docs/data` files.
2. `CALIBRATE=1 npx tsx packages/engine/src/__tests__/benchmark-odi.ts 2 both`: prints the involvement-weighted composites
   (new `ODI_REF`), the per-phase rates against the real ones and a suggested `ODI_CAL`. Try values with
   `ODI_TUNE='{"cal":{"male":[[...],[...],[...]]},"scale":{"female":1.25}}'` and repeat until the suggestion stops moving (three
   or four rounds), then write them into `odi-model.ts`. Refit after the ratings change. Hold `ODI_REF` once the composites
   settle (they move a little with the simulation, and a moving reference chases the calibration): the round-2 refit set the
   composites and `ODI_CAL` together once, then `ODI_CAL` alone for three rounds.
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

## Test

Two innings a side over up to five days (women's Tests: four), with the ball model and every team decision fitted from
Cricsheet's ball-by-ball Tests. Instant simulation and live play run the same state machine. Section numbers below
("Test section 6.5") are the ones the code comments cite. In the app: "In the app" below (the live Test screen, the
Test scorecard, Tests in the International series).

Files:

| file | what |
|---|---|
| `packages/engine/src/test-match.ts` | rules, ball model, fielding, DRS, captains' policies, results, scorecards, `simulateTestMatch` |
| `packages/engine/src/test-live.ts` | live driver: user decisions, skip by over / session / day / innings, situation view, save / load |
| `packages/engine/src/test-model-data.ts` | GENERATED fitted parameters (no runtime data dependency) |
| `packages/engine/src/test-profile-data.ts` | GENERATED each player's usual batting position, bowling workload, keeping record and share of his country's recent Tests (section 3.2; `test-player-profiles.py`) |
| `packages/ratings/src/analysis/test-match-model.py` | the fit (DuckDB + Python, `python3 -I`) |
| `docs/data/test_model.json` | the same parameters plus the era factors, as a report |
| `packages/engine/src/__tests__/test-match.test.ts`, `test-live.test.ts` | rules, determinism, policies, seeded statistics; the live driver |
| `packages/engine/src/__tests__/benchmark-test.ts` | sim vs real Tests (section 6) |
| `packages/engine/src/__tests__/fixtures/test-squads.json` | national squads: the most-capped Test players since 2023 (women 2021) |

Shared engine pieces reused: the fielding unit and catch / stumping / run-out conversion (`fielding.ts`), run-out batter and
fielders (`delivery-rules.ts`), dismissal kinds and scorecard text (`dismissal-kinds.ts`), DRS review records and their
commentary (`drs.ts`), delivery commentary (`commentary.ts` `generateDeliveryCommentary`), the post-match injury model with
its Test/FC multiplier (`injury.ts`), `Player.forFormat("test")`. The only shared file touched is `index.ts` (one appended
export block).

---

### 1. Rules

- **Innings.** Two a side. The first-innings side bats third unless it enforces the follow-on. An innings ends all out,
  declared, when the target is reached (4th innings), or when time runs out.
- **Days and overs.** 5 days of 90 overs (women: 4 of 100), in three sessions (the day's overs in thirds: lunch, tea, stumps).
  A day's overs are 90, less what the over rate cannot fit into 6 hours plus the half hour of extra time
  (`floor(rate x 6.5)`, rate drawn per match from the fitted overs-per-hour quantiles), less time lost to weather, less 2
  overs for every change of innings (ICC Test playing conditions). Play stops at the end of the over that reaches the day's
  overs. A whole day can be washed out.
- **Result.** The 4th-innings side wins by wickets on reaching the target. All out short of it: the other side wins by runs,
  or it is a tie with the scores level. After three innings, if the side to bat last already leads, it wins by an innings and
  the difference. Time running out at any stage is a draw.
- **Follow-on (Law 14).** Available at a first-innings lead of 200 in a match of five days or more, 150 for three or four days
  (100 for two, 75 for one), after the side behind is bowled out. The leading captain chooses.
- **Declarations.** Innings 1-3, by the batting side, between deliveries (CPU sides at the end of an over).
- **New ball.** Available once 80 overs have been bowled with the current ball. The CPU takes it at the start of the 81st
  over. A user side is asked once and can take it later at any time.
- **Bowlers.** No limit on overs, but no bowler bowls two overs in a row, intervals and overnight included (Law 17.8).
  Bowlers tire (section 3.4).
- **DRS.** Three unsuccessful reviews per side per innings (umpire's call keeps the review). Reviewable: lbw and catches by
  the keeper.
- **Extras.** Wides, no-balls (one run plus what is hit, no free hit) and byes / leg byes, with the fitted Test rates and
  run distributions.
- **Retired hurt.** At the Test rate (46 in 1.73 million deliveries). The batter comes back if nobody else is left.
- **Toss.** Coin flip; the winner bats or bowls (CPU: section 4.1).

### 2. Ball model

#### 2.1 Fit

Every delivery falls in one of ten classes: dot, 1, 2, 3 (3s and the rare 5), 4, 6, wicket (any dismissal on a legal ball),
wide, no-ball, bye / leg bye. Each class except the dot has its own log-linear Poisson rate, and the dot is what is left:

    P(class) = base(class) x  Π factor(class, level) x batter(class) x bowler(class) x match(class) x innings(class)

The data is men's Tests from 2006: 835 Tests, 1.61 million deliveries (Cricsheet has 899 men's Tests from 2001). It is fitted
by iterative proportional fitting (backfitting the Poisson likelihood, 16 sweeps) in DuckDB. The factors and their levels:

| factor | levels |
|---|---|
| ball age | overs since the new ball: 0-4, 5-9, 10-19, 20-34, 35-49, 50-64, 65+ (a new ball assumed at 80, 160) |
| set-ness | balls the batter has faced: 0-4, 5-9, 10-19, 20-34, 35-59, 60-99, 100-149, 150+ |
| innings | 1-4 |
| wickets down | 0-2, 3-5, 6-7, 8-9 (the tail is in), separately for each innings |
| day x pace / spin | day 1-5 for each bowler type (pitch wear) |
| spell | the bowler's over in his spell, 1-7+ (a spell ends at a gap of more than one over at his end or overnight) |
| situation | normal; push (the last 12 overs of an innings that was declared); 4th-innings runs needed per scheduled over left (5 x 90 less the overs bowled) 0-2.5, 2.5-3.5, 3.5-4.5, 4.5-6, 6+ |
| home | batting side at home / away / neutral |
| country x type | host country (IND, PAK, SL, BDESH, UAE, AUS, ENG, RSA, NZ, WI, ZIM, IRELAND, other) x pace / spin |
| era | 2006-10, 2011-14, 2015-18, 2019-22, 2023+ |
| Bazball | England batting from June 2022 |
| match | each match's own conditions (shrunk with a 1,500-ball prior) |
| batter, bowler | each player (shrunk with a 300-ball prior at the average rate) |

The player and match terms mean a context factor measures the effect for the same players in the same match. A set batter
is not just a better batter; a 4th-innings collapse is not just a worse pitch. After the fit, nested terms are re-centred
into their parents, which leaves every prediction unchanged:
- match terms within country and era;
- bowler terms within pace / spin;
- country x type within type.

Then each context factor is normalised to a mean of 1 over men's Tests from 2023, the era the engine plays (section 6.7);
every era from 2006 still informs the factors. The player and match terms are centred over all Tests since 2015, the pool the
rating maps are centred on. Bazball off = 1. The base rates make the prediction match the 2023+ count.

Women's Tests (24 in Cricsheet) are too few to fit the structure. Their base rates are refitted on women's Tests since 2014,
with every men's context factor held as an offset (the men's structure, the women's levels).

**Days of play.** Cricsheet has no day or session markers. A ball's day is its match's cumulative legal balls divided by that
match's day length: total balls / (days played - 1 + 1 for a draw, + 0.55 for a result), clamped to 300-540 balls. The
4th-innings overs left use the same day length. Both are approximations. The first-hour / session effect is not identifiable
this way, so the engine has none.

#### 2.2 Fitted factors (selected; all in `test-model-data.ts`)

The values below are from the first fit, except the wickets-down row (all innings pooled; it is now fitted per innings).
Adding wickets down and changing the chase measure (section 6.5) moved the 4th-innings chase factors and little else.
`test-model-data.ts` has the current values.

Base rates per delivery (men): 1 0.151, 2 0.035, 3 0.0089, 4 0.059, 6 0.0049, wicket 0.0181, wide 0.0022, no-ball 0.0054,
bye / leg bye 0.0094 (the dot is what is left, ~0.71; real men's Tests since 2015: 0.70).

| factor | singles | fours | sixes | wickets |
|---|---|---|---|---|
| ball age 0-4 / 20-34 / 65+ overs | 0.98 / 1.00 / 1.05 | 1.09 / 1.00 / 0.93 | 0.95 / 1.02 / 0.90 | 1.06 / 1.00 / 0.98 |
| set-ness 0-4 / 35-59 / 150+ balls | 0.72 / 1.03 / 1.31 | 0.77 / 1.04 / 1.01 | 0.49 / 0.98 / 1.41 | 1.06 / 0.98 / 0.99 |
| innings 1 / 2 / 3 / 4 | 1.02 / 0.96 / 1.05 / 0.96 | 1.00 / 1.01 / 0.99 / 0.98 | 1.15 / 0.94 / 0.92 / 0.92 | 1.08 / 0.96 / 0.91 / 1.06 |
| wickets down 0-2 / 3-5 / 6-7 / 8-9 | 0.98 / 0.99 / 1.06 / 1.05 | 0.99 / 0.97 / 1.00 / 1.15 | 0.80 / 0.81 / 1.09 / 2.72 | 0.90 / 0.92 / 1.14 / 1.61 |
| pace, day 1 / 3 / 5 | 0.77 / 0.87 / 0.92 | 1.15 / 1.11 / 1.02 | 0.39 / 0.54 / 0.67 | 0.89 / 1.10 / 1.29 |
| spin, day 1 / 3 / 5 | 1.21 / 1.24 / 1.10 | 0.86 / 0.82 / 0.76 | 1.48 / 1.74 / 1.76 | 0.64 / 0.99 / 1.18 |
| push (pre-declaration) vs normal | 1.54 / 0.99 | 1.32 / 0.98 | 3.08 / 0.96 | 1.36 / 1.02 |
| 4th inn., runs per over left < 2.5 / 3.5-4.5 / 6+ | 1.11 / 0.89 / 0.84 | 1.13 / 0.98 / 1.07 | 1.16 / 0.70 / 0.78 | 0.85 / 0.78 / 0.92 |
| home / away batting side | 1.03 / 0.97 | 1.01 / 1.00 | | 0.95 / 1.05 |
| Bazball (England from June 2022) | 1.26 | 1.14 | 1.62 | 1.04 |
| era 2015-18 / 2023+ (relative) | 0.95 / 1.09 | 1.04 / 0.99 | 0.86 / 1.17 | 0.96 / 1.06 |

Country x type (wickets, pace / spin, within type): India 0.90 / 1.06, Sri Lanka 0.96 / 1.11, Pakistan 0.86 / 0.94,
South Africa 1.14 / 1.00, England 1.04 / 0.95, Australia 0.97 / 0.81, New Zealand 0.97 / 0.87.

The match's own conditions: SD 0.071 on the scoring rate, 0.19 on the wicket rate, correlation 0.15 (true spread beyond
Poisson noise, centred within country). An innings' own scoring conditions add SD 0.09. How the pitch wears is drawn per
match too: the wicket rate on days 4-5 against 1-2 has SD 0.11 (section 6.4). Per innings the wicket rate shows no
extra spread, and nor do bowler or batter innings (no "form" overdispersion). These are drawn per match and per innings with
mean 1.

**Spell.** The fitted wicket rate rises along a spell (0.96 in the first over to 1.05 in the seventh). That is selection:
captains keep a bowler on while he is threatening. The engine takes the spell's run-rate drift (fatigue, up to +2%) and leaves
the wicket rate flat. The captain's keep-him-on behaviour is modelled in the policy instead (section 4.3).

**Tried and left out.** An innings-within-match random effect (`INNINGS_TERM=1`). It soaks up collapses: a wicket brings in a
new, vulnerable batter, so set-ness disappeared into "a bad innings". Its wicket spread drawn per innings also interacts with
exposure (bad innings are short). With it the benchmark moved further from the real Tests (draws 20%).

#### 2.3 Dismissals, extras, DRS

Dismissal mix (men's Tests since 2010), as chances converted by the fielding unit (`fielding.ts` conversion rates, so a good
keeper or slip cordon takes more):

| | caught (fielder) | caught (keeper) | bowled | lbw | stumped | c & b | run out |
|---|---|---|---|---|---|---|---|
| pace | 38.9% | 25.2% | 18.2% | 14.0% | 0.05% | 1.5% | 2.1% |
| spin | 42.6% | 9.4% | 16.9% | 20.3% | 4.7% | 2.9% | 3.3% |

Women's mix is shrunk halfway to the men's (about 900 dismissals).

Extras: a wide is 1 run 86%, 5 (four wides) 11%. A no-ball's bat runs are 0 75%, 1 14%, 4 7%. Byes are 32% of bye / leg-bye
balls; a bye is four 51% of the time, a leg bye 16%.

DRS (men's Tests from 2021, three-review era): 3.36 reviews per innings, 43% by the batting side.
- Batting reviews: 35% overturned, 21% umpire's call.
- Fielding reviews: 19% overturned, 15% umpire's call.
- Kinds: batting reviews 90% lbw; fielding overturns 54% lbw, 46% caught behind.

These turn into per-wicket and per-dot-ball rates the same way `drs.ts` does for T20.

### 3. Players

#### 3.1 Ratings to player terms

Players play on `player.forFormat("test")`. The fit builds two maps:
- one on the shipped Test ratings (`packages/app/public/data/format-ratings.json`), used for players who have them;
- one on the T20 ratings, the fallback for players who don't.

Each outcome's term gets an attribute mix from a sign-constrained ridge regression of each real player's observed / expected
ratio on his z-scored ratings (players with 300+ balls since 2015; bowlers standardised within pace / spin).

The mix is read off a **calibration curve**: real players with 30+ balls (tail-enders included) are put in ten bins of equal
expected events, and each bin's pooled observed / expected ratio is made monotone. So a rating means what the real players
rated like that did. The real relationship is flat across most of the range and steep at the ends (number elevens, the very
best batters), which a linear map missed.

For the wicket term only (batter survival, bowler wicket-taking), where the ratings rank players (r ≥ 0.2), the curve is
stretched about its centre to the term's true spread, at most 2x. The scoring terms keep their measured curves: stretching
every term at once made strong sides far too dominant.

| term (Test ratings) | mix | r with the real term | best / worst bin |
|---|---|---|---|
| batter wicket | battingIQ 0.89, timing 0.11 | 0.81 | 0.64x / 2.32x |
| batter singles | running | 0.53 | 1.25x / 0.85x |
| batter fours | power | 0.42 | 1.22x / 0.90x |
| bowler wicket | wicketTaking 0.72, economy 0.28 (stretch 2.0) | 0.36 | 1.41x / 0.71x |
| bowler singles | economy 0.68, accuracy 0.32 | 0.59 | 0.84x / 1.14x |

On T20 ratings the same terms correlate less (batter wicket 0.71, bowler wicket 0.24, bowler fours 0.16), so the fallback
separates teams less (section 6.2). As the ratings agent warned, `timing` in the Test sets barely tracks real boundary rates:
the fitted fours mix uses `power`.

**Per-outcome regressions (section 6.6).** The map above is the first version. Each batter scoring term (1, 2, 3, 4, 6) and
the bowler's 1, 2, 4, 6 and wide terms now come from their own precision-weighted ridge regression. It runs on all eight Test
attributes, and for batters on the position group he usually bats in (1-3, 4-6, 7-11), applied from his place in the order.
So scoring rate comes from what predicts real scoring and survival from what predicts survival:
- fours: battingIQ -0.108 per SD, power +0.074, running +0.100;
- sixes: power +0.54, battingIQ -0.24;
- singles: running +0.126, battingIQ -0.041.

The batter's wicket term keeps its curve (better out of sample), plus fitted position offsets: 0 / -0.024 / -0.128 for 1-3 /
4-6 / 7-11, the curve's residual by group. The bowler's wicket term keeps its stretched curve.

**Round 2 of the format ratings (section 6.10)** changed what the attributes mean: battingIQ / wicketTaking carry the level,
timing the four rate, power the six rate, running the strike rotation, and economy is measured against each competition. The
maps are refitted on the new sets, with three changes:
- **Batter wicket mix:** battingIQ alone. Fitted freely, the mix moved to running (0.76), an era-sensitive rate that made
  today's players survive too long.
- **Level:** each term is levelled on the regulars, the men's benchmark squads (`CENTRE_IDS`). Their mean mapped term,
  weighted by balls since 2023, is put on the mean fitted term of every ball since 2023, and the batter's wicket term is
  levelled per position group. This replaces the old centring on the 2015+ pool.
- **Bowler wicket stretch:** may reach 2.5 (it settles at 2.18, the term's true spread).

On top of the levelled maps, the men's base rates are scaled by `LEVEL` (wickets x1.06, scoring outcomes x0.97); section 6.10
explains why. The women's base is put back on the women's squads' mapped level (`women_level`).

#### 3.2 XI and batting order

**Test profiles** (`test-profile-data.ts`, generated by `packages/ratings/src/analysis/test-player-profiles.py`; 2,687
players, 105 of them from the extended pool, 36 KB; `testProfileOf`). From the CricketArchive first-class cells already in
data/analysis:
- **Usual batting position:** his innings-weighted mean first-class position.
- **Bowling workload:** the balls he bowls per innings in the field. Front-line at six overs or more, part-time from one
  ball an over, otherwise none.
- Both use the first window with enough innings: Tests in the last six seasons, all first-class cricket in the last six,
  Tests ever, first-class ever.
- **Keeping:** the share of his first-class matches in which he kept wicket (`fielding_ca_keepers.csv`).

Extended-pool players (`ca_<id>`) who played their country's recent Tests have profiles too. Their CricketArchive id comes
from the Cricsheet register, the ESPN map, or a unique same-country surname and first initial.

From the Cricsheet line-ups of his country's last 15 Tests (men and women apart; the latest counts most, each Test 0.85 of
the one after it):
- **Recent share:** the weighted share of those Tests he played (`testRecency`).
- **Since:** how many of those Tests have been played since his last (`testDropped`: none of the last six means retired
  or dropped).
- **The attack.** Whether a player is in the attack comes from his workload, not his T20 role. Shoaib Bashir and Brydon
  Carse, T20 "batsmen", are a Test spinner and seamer; Joe Root, Travis Head and Marnus Labuschagne are part-timers; Cameron
  Green and Ben Stokes are front-line. Without a record the role rule stands (bowlers, all-rounders, and batters with a
  bowling overall of 65+). Spin or pace still comes from the bowling style. The shipped T20 roles are unchanged.
- **The order.** A player's usual place (`testBattingSlot`) is his mean position. Without a first-class record it is his T20
  place (opener 1.5, top order 3.5, middle 5, finisher 6.5, lower 8.5; a bowler 9.5; a keeper no higher than 6). He opens
  (`isTestOpener`) at 2.5 or higher up. When the order is not given, his batting-position group for XI picking comes from his
  usual place.

- **Who keeps.** A player keeps if he kept in a third of his first-class matches or more (`testKeeps`; without a record,
  the T20 flag). An XI has one designated keeper (`testKeeperOf`): of its keepers, the regular one (recent share, then the
  keeping record). So India's keeper is Pant, not KL Rahul (6 of 220 matches keeping), and New Zealand's is Blundell, not
  Latham.
- **Who plays.** Every pick ranks by the player's Test batting or bowling value plus `TEST_RECENCY_WEIGHT` (2) times his
  recent share, so the regulars of the country's recent Tests play. Between regulars, the values decide.

`pickTestXI`: the keeper, then four front-line bowlers (two spinners in the subcontinent and UAE, one elsewhere, when the
squad has them; with a recent-Tests record, only spinners who have played 15% of them), then two openers (the best of
those who usually open, when the squad has them), then the best remaining batters. The fifth-bowler swap never drops an
opener or the keeper. `testBattingOrder` sorts by the usual place, the better batter first on
a tie. Openers open, the keeper bats around six or seven (Carey 6.9, Jamie Smith 6.8, Rizwan 6.0) and the bowlers come last.
Explicit XIs in batting order can be passed (`options.xi`). Before this (round six), the order was by Test batting quality.
India batted Jadeja at two and Jaiswal at eight.

**Next batter.** The CPU sends in the next in the order, except a **nightwatchman**. When a wicket falls with 4 or fewer overs
left in the day (not the last day), at most five down, and a tail-ender is due later than the next batter, it sends the
best-batting bowler still to come in 35% of the time.

Cricsheet has no day markers, so the rate cannot be fitted, and the 35% is a judgement. What the data does show: real Tests
have 0.88 tail-enders promoted above their usual place per Test (all reasons). 13% of them come in the six overs before the
estimated close, against 6% of other arrivals. The sim sends 0.24 nightwatchmen per Test.

### 4. The captains (fitted policies)

#### 4.1 Toss
The share choosing to bat by host country, shrunk to the overall 68% with 10 matches' weight: India 89%, Sri Lanka 89%,
Bangladesh 85%, Pakistan 81%, Australia 77%, South Africa 70%, West Indies 54%, England 51%, New Zealand 23%.

#### 4.2 Declarations and the follow-on
Declarations are hazards per end of over: logistic regressions on men's Tests since 2015, over the overs of innings 1-3.
- innings 1: runs / 100 (1.57), match overs / 90 (0.77), wickets (0.32); from 250 runs;
- innings 2: lead / 100 (1.58), overs left / 90 (-1.66), wickets (0.40);
- innings 3: lead / 100 (1.48), overs left / 90 (-1.97), lead per over left (0.015), wickets (0.22); from a lead of 100.

Real 3rd-innings declarations come at a median lead of 433 with 124 overs left. A CPU side starts its pre-declaration push
(the fitted "push" situation) once its hazard passes 2% an over.

The follow-on is enforced with probability logistic(2.86 + 1.74 x (lead - 200) / 100 - 1.16 x overs left / 90 - 3.08 x overs
just fielded / 100). Fitted on 93 chances, 42 enforced.

#### 4.3 Bowling
- **Who bowls.** At a spell's end the captain picks spin with the fitted share of the overs for the region (subcontinent / UAE
  vs elsewhere), ball age and day, adjusted for spin spells being longer. He steers back if the day's share has drifted. Among
  that type he picks with weight exp(6 x quality) x (1 + 0.35 x wickets this innings) x freshness. Part-timers count at half
  weight.
- **How long.** Spell lengths are drawn from the fitted distribution (mean 3.8 overs pace, 4.9 spin). A wicket adds two overs
  to the spell, and rest follows the fitted 10th percentile (5 overs pace, 3 spin).
- **Workload.** Bowlers are kept under the fitted 99th-percentile day workloads (21 overs pace, 31 spin).

The constants are calibrated to the real share of overs and wickets by bowler rank (section 6).

**Fatigue beyond the data.** Past an 8-over spell or the 90th-percentile day (16 overs pace, 22 spin), every extra over adds 3%
to the runs and takes 3% off the wickets (capped at 30%). This is an assumption: captains rarely let it happen, so it cannot be
fitted.

#### 4.4 Approach
CPU sides bat "normal" (innings 1-3), push before declaring, and take the fitted chase intent in a 4th innings. A user's
approach replaces that:
- attack = the push factors;
- defend = the 6+ required-rate (blocking) factors relative to a normal chase;
- normal = 1.

#### 4.5 New ball, reviews
The CPU takes the new ball at 80 overs (the fit assumes it does). CPU reviews follow the fitted rates. A user review is
answered by the truth of the ball: overturned if he was right, struck down or umpire's call at the fitted shares if not.
The user sees a confidence hint, not the answer.

### 5. Time and weather

- **Over rate.** Overs per hour of play (CricketArchive minutes batted: an innings lasts half the sum of its batters' minutes),
  men since 2015: 10th / 50th / 90th percentile 12.8 / 13.8 / 15.8. One rate is drawn per match.
- **Weather.** Time lost = days elapsed x 6 hours less the time batted and the innings breaks (a decided match used the last day
  half; a draw used it all). Fitted per host country: the probability a day is affected (MLE from the matches that lost under
  30 minutes) and the mean share of an affected day lost. Overall 12.6% and 65%, e.g. Sri Lanka 22% / 47%, England 12.5% /
  71%, Australia 7.6% / 85%. An affected day is a wash-out with the probability that gives that mean, otherwise it loses
  5-75%. Days are independent.
- **Women's Tests.** The men's weather and over rates, with 100 overs a day.

### 6. Validation

`npx tsx packages/engine/src/__tests__/benchmark-test.ts 4000`: seeded Tests between the national squads, built the way the
game builds players (squad members from ALL_PLAYERS / WPL_PLAYERS via createPlayerFromData, Test ratings attached from
format-ratings.json with attachFormatRatings). Hosts and opponents are drawn in the real proportions since 2015. Real numbers
are Cricsheet men's Tests since 2023 (146), the era the engine plays, with all since 2015 (473) alongside. England bat
with the fitted Bazball factor (the squads are 2023+ England; `BAZBALL=0` turns it off).

#### 6.1 Men, Test ratings (4,000 Tests; columns: sim, real 2023+, real 2015+)

| metric | sim | real 2023+ | real 2015+ |
|---|---|---|---|
| innings 1: runs / wickets / overs | 324.7 / 9.49 / 88.9 | 322.6 / 9.55 / 89.6 | 331.1 / 9.44 / 97.8 |
| innings 2: runs / wickets / overs | 299.1 / 9.75 / 83.8 | 308.5 / 9.63 / 85.4 | 303.5 / 9.65 / 92.6 |
| innings 3: runs / wickets / overs | 246.4 / 8.74 / 68.8 | 247.2 / 9.04 / 69.4 | 242.9 / 8.5 / 72.3 |
| innings 4: runs / wickets / overs | 183.1 / 6.85 / 51.8 | 173.6 / 6.82 / 49.1 | 181 / 7.1 / 57.7 |
| innings 4 played | 79.0% | 78.1% | 75.1% |
| runs per over | 3.59 | 3.58 | 3.31 |
| balls per wicket | 50.7 | 50.6 | 55.8 |
| overs per Test | 282.4 | 282.8 | 304.5 |
| overs per day used | 78.3 | 78.6 | 79.6 |
| home win / away win / draw | 58.5% / 32.1% / 9.4% | 51.4% / 39.8% / 8.9% | 52.0% / 34.9% / 13.1% |
| ties | 0.1% | 0.0% | 0.0% |
| days: mean / <=3 / 4 / 5 | 4.06 / 25.5% / 39.9% / 34.6% | 4.05 / 27.4% / 37.0% / 35.6% | 4.26 / 19.7% / 33.4% / 46.9% |
| follow-ons per Test / enforced when available | 0.09 / 46.8% | 0.096 / 66.7% | 0.091 / 50.6% |
| declarations per Test (inn 1 / 2 / 3) | 0.15 / 0.07 / 0.26 | 0.144 / 0.096 / 0.178 | 0.173 / 0.093 / 0.277 |
| 4th-inn target 0-149: win / draw / loss | 94.0% / 3.2% / 2.9% (n 730) | 93.3% / 0.0% / 6.7% (n 30) | 93.6% / 2.6% / 3.8% (n 78) |
| 4th-inn target 150-199: win / draw / loss | 72.9% / 7.5% / 19.6% (n 280) | 88.9% / 0.0% / 11.1% (n 9) | 74.1% / 0.0% / 25.9% (n 27) |
| 4th-inn target 200-249: win / draw / loss | 58.7% / 9.9% / 31.4% (n 293) | 37.5% / 0.0% / 62.5% (n 8) | 39.1% / 8.7% / 52.2% (n 23) |
| 4th-inn target 250-299: win / draw / loss | 36.2% / 12.3% / 51.6% (n 318) | 26.1% / 17.4% / 56.5% (n 23) | 23.4% / 21.3% / 55.3% (n 47) |
| 4th-inn target 300-349: win / draw / loss | 18.1% / 17.8% / 64.1% (n 298) | 0.0% / 25.0% / 75.0% (n 8) | 11.1% / 13.9% / 75.0% (n 36) |
| 4th-inn target 350+: win / draw / loss | 6.4% / 10.4% / 83.2% (n 1241) | 2.8% / 5.6% / 91.7% (n 36) | 4.2% / 9.0% / 86.8% (n 144) |
| batting 1-3 / 4-6 / 7-11: runs per 6 balls faced | 3.36 / 3.55 / 3.19 | 3.36 / 3.49 / 3.23 | 3.05 / 3.23 / 3.13 |
| batting 1-3 / 4-6 / 7-11: balls faced per dismissal | 57.6 / 63.4 / 35.6 | 59.1 / 62.3 / 35.9 | 68.2 / 68.6 / 37.0 |
| batting 1-3 / 4-6 / 7-11: share of balls faced | 36.8% / 37.0% / 26.1% | 37.3% / 36.6% / 26.1% | 39.3% / 36.5% / 24.2% |
| 4th-inn target 200-349 pooled: win / draw (real 2022+ | 2015+) | 37.5% / 13.3% (n 909) | 30.0% (±13) / 16.0% (n 50) | 22.6% (±8) / 16.1% (n 106) |
| innings victories | 18.9% | 18.5% | 18.6% |
| centuries per Test | 1.64 | 1.719 | 1.732 |
| 50+ scores per Test | 6.06 | 5.952 | 6.118 |
| five-fors per Test | 1.43 | 1.459 | 1.304 |
| spin share of bowler wickets, day 1-5 | 28.7% 33.6% 37.3% 40.7% 47.6% | 27.1% 36.1% 43.2% 40.1% 50.8% | 26.9% 34.5% 40.6% 42.6% 50.7% |
| spin share of overs, day 1-5 | 40.1% 42.1% 44.3% 48.6% 55.3% | 34.6% 40.2% 44.2% 46.4% 54.2% | 34.2% 38.5% 42.6% 45.8% 51.9% |
| overs share of bowlers 1-6 (by overs) | 27.5% 22.2% 18.0% 13.9% 9.4% 5.4% | 29.7% 23.7% 19.4% 15.4% 9.6% 4.5% | 29.5% 23.5% 19.6% 15.9% 9.5% 4.2% |
| wicket share of bowlers 1-6 (by overs) | 32.2% 23.9% 17.5% 12.3% 7.5% 4.0% | 34.2% 25.8% 18.8% 13.2% 7.0% 2.9% | 33.6% 26.3% 19.4% 13.3% 6.5% 3.0% |
| strong v weak (Australia, India, South Africa, New Zealand v Sri Lanka, Bangladesh, West Indies, Zimbabwe): strong / draw / weak | 77.2% / 6.7% / 16.1% (n 1274) | 74.4% / 11.1% / 14.5% (n 117) | - |
| win share by team (sim / real 2015+ / 2023+) | I 70.2% E 56.6% A 68.9% SA 47.8% NZ 49.1% P 17.4% SL 33.3% WI 27.6% B 21.5% Z 11.4% | 55.8% 46.6% 57.4% 53.8% 52.8% 36.8% 36.5% 25.5% 27.8% 10.7% | 45.7% 50.0% 61.5% 72.0% 60.7% 29.2% 34.8% 23.3% 44.0% - |
| nightwatchmen per Test (real: promoted tail-enders, all reasons) | 0.25 | 0.88 | - |
| DRS reviews per innings | 3.01 | 3.362 | - |

The strong / weak lists and their real split are from 2015+ (too few 2023+ matches between them); the per-team win shares show
both.

Reading the table (against 2023+):
- **Close.** Runs per over (3.59 vs 3.58) and balls per wicket (50.7 vs 50.6), both set by the level calibration (section
  6.10). Also innings 1-3, draws (9.4% vs 8.9%), Tests within three days (26% vs 27%), innings victories, hundreds, and
  scoring, survival and share of the balls by batting position (the order is the real one, section 6.8, and so are the XIs,
  section 6.9). The pooled 200-349 chases: 38% won vs 30% ± 13 in 2022+.
- **Off.** Strong sides draw too rarely against weak ones (6.7% vs 11.1%), and India win 70% (real 56% since 2015, 46% since
  2023), which follows their round-2 ratings. Innings 4 runs 183 vs 174.
- **Five-fors** are 1.43 per Test vs 1.46 (1.30 since 2015), after section 6.11 (they were 1.04-1.07).
- **Draws lose time more evenly** than real ones (section 5: the model's days are independent).

#### 6.2 Men, T20 ratings only (the fallback, 3,000 Tests)

| metric | sim | real 2023+ | real 2015+ |
|---|---|---|---|
| runs per over | 3.59 | 3.58 | 3.31 |
| balls per wicket | 50.4 | 50.6 | 55.8 |
| home win / away win / draw | 57.6% / 32.9% / 9.4% | 51.4% / 39.8% / 8.9% | 52.0% / 34.9% / 13.1% |
| days: mean / <=3 / 4 / 5 | 4.10 / 23.3% / 40.4% / 36.3% | 4.05 / 27.4% / 37.0% / 35.6% | 4.26 / 19.7% / 33.4% / 46.9% |
| batting 1-3 / 4-6 / 7-11: runs per 6 balls faced | 3.44 / 3.54 / 3.10 | 3.36 / 3.49 / 3.23 | 3.05 / 3.23 / 3.13 |
| batting 1-3 / 4-6 / 7-11: balls faced per dismissal | 57.9 / 63.2 / 34.6 | 59.1 / 62.3 / 35.9 | 68.2 / 68.6 / 37.0 |
| batting 1-3 / 4-6 / 7-11: share of balls faced | 37.2% / 37.1% / 25.7% | 37.3% / 36.6% / 26.1% | 39.3% / 36.5% / 24.2% |
| innings victories | 13.3% | 18.5% | 18.6% |
| centuries per Test | 1.62 | 1.719 | 1.732 |
| five-fors per Test | 1.02 | 1.459 | 1.304 |
| strong v weak (Australia, India, South Africa, New Zealand v Sri Lanka, Bangladesh, West Indies, Zimbabwe): strong / draw / weak | 63.1% / 10.3% / 26.6% (n 967) | 74.4% / 11.1% / 14.5% (n 117) | - |
| win share by team (sim / real 2015+ / 2023+) | I 61.3% E 56.2% A 61.2% SA 33.5% NZ 50.8% P 37.4% SL 29.9% WI 39.2% B 25.6% Z 27.2% | 55.8% 46.6% 57.4% 53.8% 52.8% 36.8% 36.5% 25.5% 27.8% 10.7% | 45.7% 50.0% 61.5% 72.0% 60.7% 29.2% 34.8% 23.3% 44.0% - |

On T20 ratings the engine plays sensible Test cricket (the aggregates hold), but strong and weak sides are much less apart
(63% / 10% / 27%) and the ordering follows T20 form.
#### 6.3 Women (1,500 Tests, four squads)

Real: 17 women's Tests since 2014. With so few, these are only a sanity check.

| metric | sim | real 2014+ |
|---|---|---|
| innings 1: runs / wickets / overs | 341.5 / 9.32 / 106.3 | 312.2 / 9.29 / 95.8 |
| innings 2: runs / wickets / overs | 320.0 / 9.51 / 101.1 | 308.9 / 9.65 / 99.3 |
| innings 3: runs / wickets / overs | 232.1 / 7.67 / 73.3 | 225.6 / 7.71 / 80.5 |
| innings 4: runs / wickets / overs | 154.1 / 5.21 / 49.1 | 114.9 / 6 / 37.2 |
| innings 4 played | 69.6% | 64.7% |
| runs per over | 3.18 | 3.07 |
| balls per wicket | 62.8 | 58.9 |
| overs per Test | 312.6 | 299.6 |
| overs per day used | 88.1 | 87.1 |
| home win / away win / draw | 32.7% / 23.7% / 43.7% | 35.3% / 29.4% / 35.3% |
| ties | 0.0% | 0.0% |
| days: mean / <=3 / 4 / 5 | 3.83 / 15.9% / 84.1% / 0.0% | 3.76 / 29.4% / 64.7% / 5.9% |
| follow-ons per Test / enforced when available | 0.13 / 57.1% | 0.118 / 66.7% |
| declarations per Test (inn 1 / 2 / 3) | 0.19 / 0.11 / 0.31 | 0.412 / 0.294 / 0.294 |
| batting 1-3 / 4-6 / 7-11: runs per 6 balls faced | 3.04 / 3.07 / 2.89 | 3.04 / 3.06 / 2.50 |
| batting 1-3 / 4-6 / 7-11: balls faced per dismissal | 72.8 / 74.7 / 43.2 | 67.2 / 76.2 / 40.1 |
| batting 1-3 / 4-6 / 7-11: share of balls faced | 39.7% / 36.1% / 24.2% | 37.7% / 38.5% / 23.8% |
| innings victories | 12.7% | 11.8% |
| centuries per Test | 1.64 | 1.176 |
| 50+ scores per Test | 6.03 | 5.765 |
| five-fors per Test | 0.58 | 0.824 |
| overs share of bowlers 1-6 (by overs) | 25.5% 20.9% 17.2% 13.8% 10.5% 6.9% | 27.9% 21.0% 17.1% 14.0% 11.3% 7.2% |
| wicket share of bowlers 1-6 (by overs) | 29.0% 22.1% 16.9% 13.0% 9.1% 5.6% | 34.9% 22.4% 17.8% 10.6% 7.5% 6.7% |
| DRS reviews per innings | 3.46 | 3.362 |

Women's Tests come out higher scoring than real ones (innings 1: 342 vs 312) with fewer five-fors, while the draw rate,
innings victories and days played are about right. The structure is the men's; only the base rates are women's.
#### 6.4 Fourth innings, strong v weak, five-fors (second round)

Measured first, with the same definitions on real men's Tests since 2015 and on the sim (4th innings with targets of 200-349;
balls per wicket by wickets down when the ball was bowled):

| wickets down | real, 4th inn. | sim before | sim after | real, inn. 1-2 | sim inn. 1-2 before | after |
|---|---|---|---|---|---|---|
| 0-2 | 51.6 | 61.6 | 62.2 | 73.5 | 73.2 | 74.7 |
| 3-5 | 56.5 | 55.4 | 59.3 | 74.1 | 68.7 | 73.4 |
| 6-7 | 38.3 | 38.4 | 35.6 | 46.1 | 46.2 | 44.1 |
| 8-9 | 22.7 | 27.2 | 20.2 | 27.2 | 30.7 | 24.2 |

What the data showed:
- **Wickets down is a real effect the fit lacked.** With the batter's own term in, real wickets at 8-9 down fall 22-26% faster
  than the model predicted, in every innings, and middle-order stands at 3-5 down last 4-9% longer. Fitted as a factor (wickets
  ×0.90 / 0.92 / 1.14 / 1.61 from 0-2 to 8-9 down; sixes ×2.7 once the tail is in). It fixed the tail in every innings and
  brought strong v weak to the real split (81% / 11% / 9% → 74% / 14% / 13%; real 74% / 11% / 15%). It also absorbed part of
  the old 4th-innings chase factors (now 0.87-0.99 on wickets).
- **No set-ness × day or × innings interaction.** The model's residuals in real 4th innings by set-ness and by day are within
  ±3%, and its prediction for the real 4th-innings top order is on the mark (observed / expected 1.02 at 0-2 down).
- **Pitches wear differently.** Per match, the wicket rate on days 4-5 against days 1-2 has a true spread of SD 0.11 beyond
  noise. It is now drawn per match (a slope across the days, mean 1). It made no measurable difference to the chases.
- **The sim's 4th innings come a little earlier.** Mean day 4.12 vs 4.28; 34% of their balls on day 5 vs 46%. That is worth a
  few percent of wicket rate, not the 20% top-order gap.
- **Not found.** The sim's 4th-innings top order loses wickets 16% too slowly, so mid-sized chases are won and saved too often.
  The fitted factors match real 4th innings when fed real contexts, so the gap is in the contexts the sim generates for them.
  Candidates not resolved: which matches end up with such chases, and the estimated overs left / days in the data.

Five-fors stay at 1.02 vs 1.30: neither change moved them.

Before → after (4,000 Tests each): 200-249 chases won 50% → 53% (real 39%); 300-349 18% → 27% (real 11%); innings victories
19.8% → 16.9% (18.6%); draws 15.2% → 16.2% (13.1%); five-fors 1.04 → 1.02 (1.30); strong v weak 81 / 11 / 9 → 74 / 14 / 13
(74 / 11 / 15). Innings 1-3 totals and the home / away split unchanged within noise.

#### 6.5 Fourth innings, third round

The four suspects were measured against the data before anything changed. "Top order" means 0-2 down; balls per wicket and
runs per over are for 4th innings with targets of 200-349.

| check | real | sim (before) | verdict |
|---|---|---|---|
| (a) overs bowled before the 4th innings, targets 200-249 / 250-299 / 300-349 | 232 / 262 / 283 | 254 / 261 / 262 | not the cause |
| (a) the day factor on 4th-innings top-order wickets (log, vs all balls) | +0.108 | +0.111 | same |
| (b) the match's wicket term on 4th-innings top-order balls (log, vs all) | +0.011 | +0.005 | small |
| (c) bowler term / tiredness on 4th-innings top-order balls (log, vs all) | +0.023 / - | +0.016 / +0.004 | not the cause |
| (d) the chase situation term on top-order wickets (log, vs all) | -0.093 | -0.080 | sim already a little harsher |
| model observed / expected, 4th-innings vs innings 1-2 top order | 1.053 vs 0.991 | (sim matches its own factors: 0.99 / 1.01) | missing interaction |
| top-order balls per wicket, targets < 200 / 200-249 / 250-299 / 300-349 | 52 / 53 / 49 / 54 | 64 / 62 / 62 / 62 | the gap, at every target |

So target selection was not the cause: the gap is the same at small targets. The real 4th-innings top order loses wickets
about 6% faster than the innings and day factors say (an innings x wickets-down interaction). Two changes:

- **Wickets down is now fitted per innings** (16 levels). The 4th-innings top-order wicket multiplier rose from 0.955 to 1.005;
  the 2nd-innings top order came out a little safer. Sim 4th-innings balls per wicket by wickets down, targets 200-349: 55.7 /
  57.8 / 36.5 / 19.6, against real 51.6 / 56.5 / 38.3 / 22.7 (before: 62.2 / 59.3 / 35.6 / 20.2).
- **The chase is measured on scheduled overs left** (5 x 90 less the overs bowled, women 4 x 100), in the fit and in the
  engine alike. The old measure took each match's own length as its time, so a chase that collapsed looked short of time and
  a long rearguard looked unhurried. The easy-chase level was partly encoding the outcome. Results moved within noise.

What is left is scoring. The sim's chasing top order scores at 3.62 an over against 3.09 real (+17%), with wickets now right.
The same decomposition on scoring (log batter term on top-order balls vs all balls) shows why:

| | sim | real |
|---|---|---|
| singles, 4th innings | +0.047 | -0.009 |
| singles, innings 1-2 | +0.058 | +0.003 |
| fours, 4th innings | +0.017 | -0.029 |
| fours, innings 1-2 | +0.021 | -0.020 |

The sim's top orders score faster than real ones in every innings, and its tails slower (8-9 down, innings 1-2: 3.1 an over
vs 3.7). Innings totals still match. Likely causes:
- the Test ratings move survival, running and power together, while real survivors do not score faster per ball;
- the benchmark squads are 2023+ regulars.

Not changed in this round: the scoring maps would need a rethink of how ratings drive scoring rate by batting position.

Before → after this round (4,000 Tests each): 200-249 chases won 52.7% → 51.8% (real 39%), drawn 16.7% → 21.7% (9%); 250-299
won 35.0% → 29.1% (23%); 300-349 won 26.6% → 22.8% (11%); 350+ won 6.5% → 6.7% (4%). Innings 1-3 totals, results (52.0 / 32.6 /
15.4) and strong v weak (74 / 13 / 13) held.

#### 6.6 Scoring and survival by batting position (fourth round)

The cause from 6.5 was that the single-composite curves tied scoring rate to the attributes that drive survival. Before
changing the map, by batting position (men since 2015; runs off the bat per six balls faced, balls faced per dismissal):

| batting | real runs / 6 | sim before | sim after | real balls / dismissal | sim before | sim after |
|---|---|---|---|---|---|---|
| 1-3 | 3.05 (2023+: 3.36) | 3.36 | 3.27 | 68.2 (59.1) | 71.6 | 68.1 |
| 4-6 | 3.23 (3.49) | 3.23 | 3.29 | 68.6 (62.3) | 65.6 | 62.8 |
| 7-11 | 3.13 (3.23) | 3.07 | 3.01 | 37.0 (35.9) | 34.4 | 37.6 |

Real tails score about as fast per ball as top orders. Real openers survive no better than a number five, though they rate
higher.

**The map.** Per outcome, a precision-weighted ridge regression of each real player's observed / expected ratio on his eight
Test attributes plus his usual position group (players with 300+ balls). It was checked out of sample: fitted on terms before
2023, scored on the same players' terms from 2023 (116 batters, about 90 bowlers). The table gives the Poisson deviance gain
over no map. The curve map was fitted on all years, so it is favoured.

| term | regression | curve map |
|---|---|---|
| batter singles / fours / sixes | 0.42 / 0.26 / 0.42 | 0.39 / 0.25 / 0.22 |
| batter wicket | 0.46 | 0.50 |
| bowler singles / fours / wicket | 0.29 / 0.17 / 0.13 | 0.30 / 0.16 / 0.11 |
| bowler threes / no-balls | -0.13 / -0.01 | (near-flat curves) |

So the scoring terms take the regression. The batter's wicket term keeps its curve, with position offsets fitted on the curve's
residuals. Bowler threes and no-balls keep their near-flat curves.

Three variants were tried for the batter's wicket term:
- **the regression with its position term:** survival by position exact (69 / 66 / 37), but strong v weak dropped to 65%;
- **the regression stretched to the true spread:** the same;
- **the curve plus position offsets (shipped):** top-order survival right, strong v weak 78%, innings victories 17%.

**What the shipped Test ratings can and cannot express.** In the shipped Test sets `timing` carries no independent information
about the real four rate: its regression weight is 0.005 per SD. Fours are predicted only through power and running, and
negatively through battingIQ, with 0.26 deviance gain against 0.42 for singles and sixes. A Test `timing` built to track a
batter's boundary rate (fours per ball faced) would give the engine a direct handle. That is a fix in packages/ratings.

**What is left.** The chasing top order (4th innings, targets 200-349, 0-2 down) still scores at 3.58 an over against 3.09, with
the wicket rate now about right (54.0 vs 51.6 balls per wicket). It is not composition: the squads' top orders rate like the
real pool's (battingIQ 85 vs 90, power 67 vs 67, running 74 vs 73). In the sim the batter term on top-order scoring stays at
+0.02 to +0.05 (log, vs all balls) where the real one is -0.03 to 0.00; the cause is not found.

Before → after this round (4,000 Tests):

| | before | after | real |
|---|---|---|---|
| 200-249 / 250-299 / 300-349 chases won | 52% / 32% / 21% | 47% / 34% / 18% | 39% / 23% / 11% |
| innings 1 / 2 / 3 / 4 runs | 330 / 311 / 251 / 185 | 324 / 306 / 247 / 183 | 331 / 304 / 243 / 181 |
| home / away / draw | 52.5 / 32.5 / 15.0 | 52.7 / 32.8 / 14.4 | 52.0 / 34.9 / 13.1 |
| strong v weak | 74 / 12 / 14 | 78 / 11 / 12 | 74 / 11 / 15 |
| innings victories | 16.7% | 17.2% | 18.6% |
| hundreds / five-fors per Test | 1.79 / 1.02 | 1.66 / 1.01 | 1.73 / 1.30 |

#### 6.7 Era (fifth round)

The chase gap of 6.5-6.6 was mostly an era mismatch. Real 4th-innings chases of 200-349 (pooled bands; 95% interval):

| | Tests | won | drawn | chasing top order (0-2 down): runs / over, balls / wicket |
|---|---|---|---|---|
| 2015-21 | 56 | 16% (9-28%) | 16% | 2.90 (± 0.2), 55.3 |
| 2022+ | 50 | 30% (19-44%) | 16% | 3.35 (± 0.3), 47.2 |

Up to round 4 the engine's base rates sat at a 1 : 1.5 : 2 mix of 2015-18, 2019-22 and 2023+ (a ~2020 level), England batted
without Bazball, and the benchmark compared with all Tests since 2015, so with chasing that is half from a slower era. The game
is played today, so the engine now plays the 2023+ level:
- the context factors and base on 2023+;
- the player and match terms centred on the 2015+ pool, as the rating maps are (centring them on 2023+ instead left the modern
  wicket level out, since the fit splits harder modern conditions between the era and the players);
- the benchmark gives England Bazball and compares with 2023+.

The sim's pooled 200-349 chases (36% won, 16% drawn) are inside the 2022+ interval. What remains against same-era data:
- 4th-innings totals a little high (186 vs 174 runs);
- five-fors (1.04 vs 1.46; fixed in 6.11);
- slightly long-lived matches (balls per wicket 52.8 vs 50.6, 21% vs 27% within three days).
None is pursued further.

#### 6.8 Batting order and Test roles (sixth round)

The XI and order now come from each player's first-class record (section 3.2): his usual place in the order, two openers in
the XI, and the attack decided by bowling workload instead of the T20 role. Men, Test ratings, 4,000 Tests against real
2023+:

| metric | before | after | real 2023+ |
|---|---|---|---|
| batting 1-3 / 4-6 / 7-11: runs per 6 balls faced | 3.44 / 3.41 / 3.15 | 3.36 / 3.47 / 3.19 | 3.36 / 3.49 / 3.23 |
| batting 1-3 / 4-6 / 7-11: balls faced per dismissal | 64.3 / 62.3 / 36.0 | 60.4 / 65.3 / 36.3 | 59.1 / 62.3 / 35.9 |
| batting 1-3 / 4-6 / 7-11: share of balls faced | 39.6% / 35.2% / 25.3% | 37.5% / 37.0% / 25.5% | 37.3% / 36.6% / 26.1% |
| innings 1 / 2 / 3 / 4 runs | 328 / 311 / 252 / 186 | 331 / 306 / 249 / 188 | 323 / 309 / 247 / 174 |
| balls per wicket | 52.8 | 52.5 | 50.6 |
| home win / away win / draw | 54.5% / 33.3% / 12.0% | 55.7% / 32.8% / 11.4% | 51.4% / 39.8% / 8.9% |
| innings victories | 17.1% | 17.9% | 18.5% |
| strong v weak: strong / draw / weak | 76.3% / 9.8% / 13.7% | 74.6% / 8.8% / 16.5% | 74.4% / 11.1% / 14.5% |
| 4th-inn target 200-349 pooled: win / draw | 36.3% / 16.4% | 39.4% / 16.4% | 30.0% (±13) / 16.0% |

The order was what the fit's batting-position terms assume: they were fitted on players' real positions, but before this
round the sim applied them to an order sorted by batting quality. Scoring and the share of the balls by position now match
the real split. Survival at 1-3 matches too, and 4-6 is three balls long.

The one move away from the real numbers is the fourth-innings chase. The pooled 200-349 rate is 39% won (38.9% over 8,000
Tests). Each change alone leaves it at 36% (36.1% without the workload attack, 35.5% without the positions), so it is the
two together; it stays inside the real 2022+ band. On T20 ratings (section 6.2) and for women (section 6.3) the by-position
rows also move toward the real ones, and the aggregates barely change.

#### 6.9 Who plays: the auto XI against the real ones (seventh round)

Target: the auto Test XI of the International series (`buildNationSquad` on Test ratings and the activity data, then
`pickTestXI` for each Test's host conditions) against each country's last five real Test XIs. The real XIs are the Cricsheet
line-ups to October 2026, in `packages/app/src/__tests__/fixtures/test-recent-xis.json`, written by the profiles script. The
figure is the mean number of players shared, out of 11.

| men | before | after | out of sample |
|---|---|---|---|
| India | 6.6 | 8.6 | 8.6 |
| England | 6.8 | 9.2 | 5.8 |
| Australia | 7.4 | 8.4 | 7.4 |
| South Africa | 7.4 | 8.6 | 7.4 |
| New Zealand | 7.4 | 8.2 | 8.2 |
| Pakistan | 5.2 | 7.0 | 5.8 |
| Sri Lanka | 7.0 | 8.4 | 7.2 |
| West Indies | 6.6 | 8.0 | 5.8 |
| **the eight above** | **6.80** | **8.30** | **7.02** |
| Bangladesh | 6.8 | 8.8 | 8.2 |
| Zimbabwe | 5.2 | 7.6 | 6.4 |
| Ireland | 6.8 | 8.2 | 6.4 |
| women: Australia / England / India | 7.2 / 6.8 / 7.4 | 10.0 / 9.4 / 9.0 | 6.6 / 7.2 / 6.8 |

The columns:
- **After** is the picker as shipped. The five Tests are part of the recency it reads, so it says how well the auto XI is
  each country's current side.
- **Out of sample** computes the recency without them (`HOLDOUT=5`). It says how well the picker predicts the next XIs,
  which changing selections limit (England changed half their side over those five Tests).
- **Before** is the previous round's picker, which read no line-ups, so its in-sample and out-of-sample figures are the same.
  `src/__tests__/international-test.test.ts` holds the "after" level: 8 or more for the eight, 6.5 or more each.

What changed: recency ranks every pick, dropped players leave the squad, regulars come in first, one keeper on the keeping
record, and a forced spinner must have played (section 3.2; `pickTestSquad` in `test-series.ts`).

What the picker cannot fix:
- **The shipped pool lacked Test regulars** (fixed in the eighth round, below). Pakistan: Azan Awais (all of the last five
  Tests), Ali Usman, Mohammad Abbas and Sajid Khan. West Indies: Kavem Hodge (all five), Kemar Roach and Tagenarine
  Chanderpaul. Each country's squad held only 7.6 and 8.8 of the real XI.
- **The Test ratings rank some players oddly**, which still decides between regulars and newcomers:
  - Bashir's Test bowling is wicket-taking 25, economy 34, accuracy 35 (Leach 80/84/83). That is a non-bowler's rating
    for a front-line spinner; the ratings follow his T20 "batsman" role.
  - Stokes's bowling is 42/39/26, likewise.
  - Domestic first-class seamers rate above India's Test attack. Koushik's bowling value is 0.14 (78/94/69) and Kamboj's
    -0.05 (83/74/58), against Siraj's -0.07 (88/62/61).
  - Gill (batting value 0.11) rates below Padikkal and Sai Sudharsan (0.17 each).
  - Gay rates well above Crawley in batting (IQ, timing, power 89/86/66 against 76/81/78).

Benchmark (sections 6.1-6.3 updated; men against the previous round):
- Innings 1: 331 to 326 (real 323). Innings 4: 188 to 184 (174).
- Balls per wicket: 52.5 to 51.7 (50.6). Tests within three days: 22% to 24% (27%). Draws: 11.4% to 10.7% (8.9%).
- The pooled 200-349 chase: 39% to 38% won (30% ± 13).
- Batting by position stays matched.
- The women's sides now play their regulars and score more (innings 1: 329 to 339, real 312, on 17 real Tests).

**Eighth round: the extended pool.** National squads now also pick from the extended pool's senior players (the
CricketArchive players the shipped ESPN pool lacks; "National squads and the extended pool" in "In the app"). Pakistan's
and West Indies' missing regulars are there with Test sets. The profiles cover them by `ca_<id>`: 105 players who played
their country's recent Tests, matched through the register, `ca_espn_map.csv`, or a same-country surname and initial.
`player-activity.json` covers them too.

| men | without the pool | with it | out of sample, without / with |
|---|---|---|---|
| Pakistan | 7.0 (squad holds 7.6 of the real XI) | 8.6 (10.0) | 5.8 / 6.2 |
| West Indies | 8.0 (8.8) | 8.8 (10.6) | 5.8 / 7.2 |
| Sri Lanka | 8.4 | 8.4 | 7.2 / 6.4 |
| Zimbabwe | 7.6 | 7.4 | 6.4 / 6.2 |
| **the eight majors** | **8.30** | **8.60** | **7.02 / 7.15** |

The other countries are unchanged. Out of sample, extended players with no recent Tests can rank above a side's next
regular on their ratings (Sri Lanka). The benchmark squads are ESPN players, whose profiles are unchanged, so sections
6.1-6.3 stand.

#### 6.10 Round 2 of the format ratings: the refit (tenth round)

Round 2 of the format ratings changed the attributes' meanings (section 3.1). On the old maps the benchmark drifted, and a
plain refit was no better. Men, Test ratings, 4,000 Tests:

| metric | previous round (round-1 ratings) | new ratings, old maps | plain refit | final | real 2023+ |
|---|---|---|---|---|---|
| runs per over | 3.58 | 3.74 | 3.53 | 3.59 | 3.58 |
| balls per wicket | 51.7 | 51.4 | 55.1 | 50.7 | 50.6 |
| innings 1 runs | 326 | 337 | 341 | 325 | 323 |
| home / away / draw | 55.8 / 33.5 / 10.7% | 56.8 / 33.7 / 9.4% | 54.6 / 30.5 / 14.8% | 58.5 / 32.1 / 9.4% | 51.4 / 39.8 / 8.9% |
| Tests within three days | 24% | 23% | 18% | 26% | 27% |
| batting 1-3 / 4-6 / 7-11: balls per dismissal | 59.9 / 63.5 / 36.0 | 57.9 / 61.9 / 38.3 | 64.1 / 65.3 / 39.6 | 57.6 / 63.4 / 35.6 | 59.1 / 62.3 / 35.9 |
| strong / draw / weak | 76.0 / 9.5 / 14.5% | 77.5 / 6.4 / 16.1% | 69.9 / 13.6 / 16.5% | 77.2 / 6.7 / 16.1% | 74.4 / 11.1 / 14.5% |
| five-fors per Test | 1.05 | 0.99 | 1.00 | 1.07 | 1.46 |
| hundreds per Test | 1.69 | 1.84 | 1.81 | 1.64 | 1.72 |
| India's win share | 58% | 72% | 66% | 70% | 56% (2015+) |
| pooled 200-349 chases won | 37.6% | 41.6% | 39.1% | 37.5% | 30% ± 13 |

What went wrong, and the fixes:
- **The batter's survival mix moved to running.** Fitted freely, it became 0.76 running (now strike rotation, an
  era-sensitive rate). Today's players rate high on it, so they survived too long. The mix is now battingIQ, the level
  attribute.
- **The maps' level drifted.** Centred on the 2015+ pool, the new ratings put today's bowlers below that pool on
  wicket-taking, today's regulars above their own Test six-hitting on power, and raised tail-enders' battingIQ. The regular
  tail survived 7% longer than its record. Each term is now levelled on the regulars (the benchmark squads) at the modern
  fitted level, and the batter's wicket term per position group (section 3.1).
- **The level calibration.** Fed player terms at the real modern level, the engine still scores about 3% faster and takes
  wickets about 6% more slowly than real Tests since 2023. The maps of the previous round matched only because their drift
  happened to offset this: they put the regulars' scoring 2-3% below their fitted level, and the 4-6 batters' survival 4%
  below it. The men's base rates are scaled to close it (`LEVEL`: wickets x1.06, scoring outcomes x0.97). This is set
  against runs per over and balls per wicket only; the other rows stay out-of-sample checks.

Out-of-sample deviance gains of the per-outcome regressions on the new sets show where the meanings moved. Bowler
wicket-taking is much better (0.39, was 0.13). Batter fours are worse than no map (-0.04, was 0.26), as are singles (0.23,
was 0.42) and dismissals (0.34, was 0.44). The fours mix now uses timing (+0.06 per SD).

Still off: strong sides draw too rarely against weak ones, and India (70%) and Australia (69%) win too often (real since
2015: 56% and 57%). Their regulars rate highest on both survival and wicket-taking. The top seven batters' wicket term is
0.90 for India and 0.88 for Australia; the bowlers' is 1.12 and 1.17. The XI mean over all sides is 0.98 and 0.95. That is a
ratings question. Five-fors stayed at
1.07 here: the bowler's wicket term already reaches its true spread, and the gap was in how the sim shared the overs (its
leading bowler bowled 27% of them, real 30%); fixed in section 6.11.

On T20 ratings (section 6.2) balls per wicket is 50.4 and draws 9.5%, both closer than before. The women (section 6.3) are
back on their previous level: their base is levelled on the women's squads' mapped terms, since the men's levelling had
taken them to 73 balls per wicket.

The XI overlap of section 6.9 is 8.70 for the eight majors (8.60 before), 7.03 out of sample (7.15). England's auto XI now
includes Stokes, whose round-2 bowling is a seamer's.

#### 6.11 Five-fors: who bowls (the known gap, closed)

Five-fors were 1.07 per Test against 1.46. Measured on real men's Tests since 2015 and the sim (same definitions; innings of 50+
overs), the wickets per bowler *given his overs* were right (a bowler of 20-30 overs takes 2.4 wickets, real 2.3; the spread of his
wickets is as wide as the real one). The gap was who bowled:

| | before | after | real |
|---|---|---|---|
| bowlers used per innings | 6.94 | 6.26 | 5.53 |
| overs share of the 6th and 7th bowler (all innings) | 7.9% | 2.7% | 2.3% |
| innings with a five-for (innings 1 / 2 / 3 / 4, 2023+) | 31 / 34 / 30 / 20% | 38 / 42 / 38 / 28% | 42 / 40 / 37 / 33% |
| five-fors per Test (4,000 Tests) | 1.08 | 1.43 | 1.46 |

Causes, in `chooseBowler` (`test-match.ts`):
- **Part-timers were called on whenever the front-line bowlers were resting.** After a spell a bowler must rest the fitted number
  of overs, so with five bowlers some over often had no rested one of the type the captain wanted (the spin share asks for
  spinners on a fixed share of overs) and the choice fell to a part-timer or a batter who bowls. A front-line bowler of the type
  who is only resting is now the first call (still under his daily cap); a part-timer comes in only when there is none.
- **A wicket does not keep a bowler on long enough.** `WICKET_SPELL_EXTENSION` 2 to 5 overs and `PART_TIMER` 0.5 to 0.05 (the weight
  of a part-timer against a member of the attack). The spells of hot bowlers then carry the real upper tail (the leading
  bowler's overs in an innings at the 90th percentile 34 against a real 41; the median 23 to 24 against 26).

The benchmark's rank shares were also compared the wrong way (the sim over all innings, the real over the innings that have a
bowler of that rank); they are now taken as the real ones are, and it prints the bowlers used and the innings with a five-for.
Nothing else moved outside noise (4,000 Tests: innings 1 322 (real 323), balls per wicket 50.2 (50.6), runs per over 3.61, draws
9.6%, innings victories 19.4%, spin share of overs 38.6 / 40.3 / 42.5 / 47.2 / 53.1% by day against 40.1 / 42.1 / 44.3 / 48.6 /
55.3% before). The women's five-fors 0.58 to 0.82 (real 0.82). Still off: 6.3 bowlers an innings against 5.5 (the XI's fifth
bowler and the part-timer who gets his overs when the attack is capped), and the wicket share of the leading bowler 36.9%
against 34.2%.

### 7. Live play

```ts
const st = startLiveTest(home, away, { userTeamId: home.id, country: "ENG", seed });  // waits for the toss call if won
decideTest(st, "bat");                          // toss / follow_on ("enforce" | "bat") / new_ball ("take" | "wait") / drs_* ("review" | ...) / next_batter (a batter id)
advanceTest(st, "ball" | "over" | "session" | "day" | "innings" | "match", { autoDecide }); // stops at the user's decisions
declareTest(st); setTestBattingApproach(st, "attack" | "defend" | "normal" | null); setTestNextBatter(st, id | null);
changeTestBowlerTo(st, id, { keepOn }); takeTestNewBall(st); testBowlingOptions(st); testSituation(st);
setTestAutoCaptain(st, true);                   // the CPU captain takes the user's decisions too
serializeTestState(st) / deserializeTestState(json); finishLiveTest(st) // -> TestMatchResult
```

The user is asked for the next batter at the nightwatchman moment (the context names the suggested nightwatchman), and at every
wicket with `pickBatters: true`. `setTestNextBatter` presets the next one in.

The state mutates in place (a Test is ~1,800 deliveries; copying it per ball would be quadratic) and is plain JSON. Its random
stream is a number in the state, so a loaded match carries on exactly as it would have. Live matches carry commentary on every
ball. Instant ones don't by default; `describeTestBall(st, innings, i)` writes it when viewed.

`simulateTestMatch(home, away, options)` plays a whole Test with CPU captains on both sides and returns innings summaries,
`InningsScorecard`s (the limited-overs shape), the event log (toss, days, sessions, weather, declarations, follow-on, new
balls, result), player of the match, and the final state with every ball. It does not touch players' season stats.
`injuries: true` runs the post-match injury checks with the Test/FC multiplier.

### 8. Refitting

```
# Cricsheet Test JSON (declared / absent-hurt flags, days played, reviews) into an empty directory
curl -O https://cricsheet.org/downloads/tests_json.zip && unzip tests_json.zip -d /path/to/tests_json
cd packages/ratings
CRICSHEET_TEST_JSON_DIR=/path/to/tests_json python3 -I src/analysis/test-match-model.py   # ~4 min
#   REUSE=1 reuses the parsed JSON and ball table, REUSE_FIT=1 also the IPF fit (re-run only the maps, policies, targets)
#   FORMAT_RATINGS=... another format-ratings.json (default: packages/app/public/data/format-ratings.json)
cd ../.. && npx tsx packages/engine/src/__tests__/benchmark-test.ts 4000   # RATINGS=t20, GENDER=female, MD=1
```

The script also needs `deliveries.parquet` / `matches.parquet`, `venue_map.csv`, `game_players.json` (data/analysis),
`people.csv` (data/cricsheet), and for bowling styles and minutes batted `espn-players.json` and `cricket.db`. Refit after the
ratings change (new Test sets): the rating maps and the squads fixture depend on them.

The Test profiles (section 3.2) have their own short script. It also writes the evaluation fixture of real XIs (section 6.9).
Rerun it when the CricketArchive cells, the game's players or the Cricsheet Tests change:

```
cd packages/ratings
CRICSHEET_TEST_JSON_DIR=/path/to/tests_json python3 -I src/analysis/test-player-profiles.py
#   SHOW="Joe Root,Shoaib Bashir" prints the evidence; HOLDOUT=5 drops each country's last 5 Tests from the recency
#   (the out-of-sample check; do not commit that output)
```

## In the app

### International series (`/international`)

Reached from the Setup page ("International") and the top navigation. `packages/app/src/international.ts` holds the logic
(pure TypeScript, unit-tested in `src/__tests__/international.test.ts`); `src/pages/InternationalPage.tsx` the screens.

- **Setup**: men or women; two nations (every nation with 14+ shipped players aged 40 or under and six bowling options:
  `ALL_PLAYERS` for men, `WPL_PLAYERS` for women); the format; 1, 3 or 5 matches; the venue (the host's grounds in turn,
  most used first, from the ODI venue analysis; or neutral); captain one side or watch.
- **Squads**: 16 of the nation's active players on the format's ratings (a player's `ratings` is his ODI set for an ODI,
  attached from `public/data/format-ratings.json` like the rest of the app; T20 ratings for a T20I), with a keeper (the best
  gloveman if the data flags none) and six bowling options. Who is active comes from `public/data/player-activity.json`
  (`packages/ratings/src/pipeline/generate-player-activity.ts`: each shipped player's last T20I, ODI and Test season and last
  senior domestic season, from the CricketArchive cells; 7,235 players, 39 KB gzipped; read by
  `packages/ratings/src/player-activity.ts` `squadTier`). Players who played the format internationally in the last two
  seasons come first, then players active at senior level in the last two, then (only to fill a gap) the last three; nobody
  inactive three seasons or more. Within a tier, by XI value. Australia's ODI squad no longer has James Faulkner (last senior
  game 2022) or David Warner (no ODI since 2023); a player the data has no record of (685 of the pool) counts as a gap-filler
  if he is 40 or under. Ids are the record ids (`espn_<id>`), so a saved series rebuilds the same squads. The rule is in
  `buildNationSquad`, so every format, the Test included, uses it.
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
or none), and optionally `live` (`viewer`, `create`, `finish`), `autoLineup` and `lineupProblems` (the format's own XI and
its check). Results, the series score (draws and ties count as shared) and the stats only read records; a format with its own
live screen adds a branch for its `viewer` in `InternationalPage` (the Test's is `"test"`, below). `registerSeriesFormat` adds
one at run time.

### National squads and the extended pool

Squads for every format (T20I, ODI, Test) pick from the shipped ESPN pool and the nation's senior players in the extended
pool (`extended-pool.ts`, the CricketArchive players the ESPN pool lacks, ids `ca_<id>`).
- **The shared builder.** `buildNationSquad` / `createSeries` / `seriesSquads` take the extended players as an optional
  last argument; without it, the synchronous path for tests, the shipped pool alone is used.
- **Loading.** The series page fetches the gender's senior shards once: at "Start", and before a saved series' squads are
  rebuilt ("Loading players..."). Offline it falls back to the shipped pool.
- **Countries.** The West Indies territories (Jamaica, Barbados, Guyana, Trinidad, the Leewards and Windwards) count as
  West Indies (`nationOf`).
- **Activity.** `player-activity.json` (`generate-player-activity.ts`) has records for the extended pool's senior players
  active in the last three seasons. An extended player without one is ranked on his last season.

### Tests in the International series

The Test entry of `SERIES_FORMATS` (`testSeriesFormat()`, `packages/app/src/test-match/test-series.ts`; unit tests in
`src/__tests__/international-test.test.ts`) plays the Test engine above.

- **Series of 1 to 5 Tests**, men (five days) or women (four), in the host's conditions (the engine's country: weather, toss,
  pitch; two spinners in the XI in the subcontinent) or on a neutral ground. England's men bat in their fitted post-2022 style
  (`bazballTeamId`).
- **Squads** on Test ratings, picked the way selectors do (`pickTestSquad`, the `ratingFormat === "test"` branch of
  `buildNationSquad`; section 3.2 has the evidence):
  - Players who have stopped playing Tests (none of the country's last six) are left out.
  - Two keepers come first, on the keeping record; the squad's "WK" marks are those keepers only (`markTestKeepers`).
  - Then the regulars of the country's recent Tests (30%+ of them), the most regular first.
  - Then the shape is covered: five seamers, two spinners, an all-rounder (a front-line bowler who bats in the top seven),
    two openers.
  - Then the best of the rest.

  Every pick ranks by the engine's Test value plus the recency weight. Seamer, spinner, opener or keeper comes from the
  first-class record, not the T20 role. The auto XIs share 8.3 of 11 with the eight major men's sides' last five real XIs
  (section 6.9). Within each slot, recent Test players come first (the activity tiers above), so India's seamers
  are Siraj, Prasidh and Akash Deep rather than domestic quicks with high first-class ratings. The limited-overs ranking
  left red-ball specialists such as Lyon out.
- **XI**: the CPU and the user's "auto" XI are the engine's `pickTestXI` and `testBattingOrder` (`autoLineup`): two openers,
  and the order by each player's usual place (section 3.2). A user's XI
  needs eleven, a keeper and four bowlers (`lineupProblems`); it reaches the engine as `xi` in his batting order.
- **Play** live on `LiveTestPage` (`viewer: "test"`, `SeriesLiveTest` in `SeriesTestViews.tsx`; the user captains his side or
  watches with CPU captains on both), or simulate. The series records the result the moment the match ends (`onMatchEnd`).
- **Series view**: draws count in the score ("India lead 1-0 (2 Tests drawn)"); each match line has the Test score line
  (`summary`: "IND 399 & 105/2d · NZ 156 & 349/5"); the stats show not outs and five-fors (`BowlingLine.fiveFors`) for a Test
  series; a match's scorecard is `TestScorecard` (`SeriesTestScorecard`).
- **Persistence**: a Test's full state (440-650 KB with every ball) goes to IndexedDB under `live-test:intl-<series id>-<match>`
  (`test-db.ts`). A live Test saves there as it is played and an instant one when it is simulated. The series' localStorage
  record keeps the innings scorecards and the score line (about 12 KB a Test), so the hub and the stats need no IndexedDB. If
  the state is gone, the scorecard falls back to the record's own cards. A new series clears the last one's Tests;
  abandoning a live Test clears its save.

### Draft Match

The setup has a T20 / ODI choice. An ODI draft plays 50-over matches (`draftMatchRules(maxOs, "odi", women)`, the women's
model for a women's pool) and its pool is on ODI ratings (`toOdiPool`), so the draft board, the lineups and the match read
the ODI sets; players without one keep their T20 ratings. Multiplayer Draft Match stays T20 (`DraftMatchStart.format` is
optional, absent = T20).

### Live ODI (`LiveMatchPage`)

The page reads the format from the match's rules (`liveMatchFormat`): the overs counter shows `/ 50` (or the overs left
after rain), run rate, required rate, progress and win probability work for 50 overs, the worm spans the innings, and a chip shows the fielding-restriction phase (P1 / P2 / P3 with the fielders allowed
out, in proportion in a shortened innings). The bowler picker lists only bowlers under their cap who did not bowl the last
over, with "3/10 ov · 7 left". After rain the chase shows "DLS target 306 in 48 overs" and the rain banner the revised
target. No Impact Player or strategic-timeout prompts appear (the engine raises none in an ODI). A live match is now also
saved when the page is left for another route.

### Live Test (`LiveTestPage`) and the Test scorecard

`packages/app/src/pages/LiveTestPage.tsx` plays a `TestMatchState` from `test-match/test-entry.ts` (`startTestLive(setup,
userTeamId | null)`; `playTestInstantly(setup)` for a whole Test), with components in `src/test-match/`:
- **Scoreboard** (`TestScoreboard`): day, session, overs today and left in the match, both sides' score lines, lead, trail
  or target, run rate, partnership, batters, both bowlers' figures and spells, ball age with "new ball due", reviews left,
  the last balls.
- **Controls**: next ball, skip an over, session, day or innings, or go to the end, and autoplay at three speeds. An option
  lets the CPU captain answer the user's decisions while skipping.
- **Decisions** (`TestDecisionModal`, every one with "Let the captain decide"): the toss, the follow-on, the new ball, DRS when
  batting or fielding, and the next batter or nightwatchman.
- **Captain panel** (`TestCaptainPanel`): batting approach, declaring (confirmed), the next batter, "ask me at every wicket",
  bowling changes with figures, spell and workload ("keep him on"), and taking the new ball. "CPU captains my side too"
  hands everything over.
- **Commentary** (`TestCommentary`): every ball through the commentary model, never repeating a corpus line in a match. The
  shared lines' limited-overs sentences (free hit, powerplay, fielding restrictions, death overs) are dropped. Match events
  appear between the balls.
- **Scorecard** (`TestScorecard`): a match summary (result, including draws and ties; both sides' innings; toss; venue and
  the day it ended; player of the match), then a tab per innings with batting, extras, total, did not bat, fall of wickets
  and bowling, then the match notes.

The state saves to IndexedDB (`useLiveTest`, `test-db.ts`): at the start, after each action (batched) and at once when the
page is left. It resumes exactly. View helpers are in `test-view.ts`, with unit tests in `src/__tests__/live-test.test.ts`.
`/live-test` (`LiveTestDemoPage`) is an unlinked dev route kept for the seeded e2e of the live screen.

### Checked

`npx vitest run packages/app packages/engine` (the series logic, Draft Match ODI), `npm run build`, and
`E2E_PORT=3893 npx playwright test e2e/international.spec.ts` (start an ODI series, simulate a match, play live balls, pick the
XI, open the scorecard, reload and resume; a Draft Match ODI to its result; `Math.random` is seeded in the page so the runs
repeat). `E2E_PORT` runs the app on another port when several checkouts share the machine.

Tests: `E2E_PORT=3947 npx playwright test e2e/international-test.spec.ts e2e/live-test.spec.ts`. The first starts a Test
series, simulates a Test (score line, series score, Test stats, the Test scorecard), and plays one live: a few balls, leave
and resume, reload, play to the end, the result in the series. The second covers the live screen on its seeded dev route
(toss, skips, decisions, captain panel, scorecard tab, leave and resume, to the end) and an instant Test's scorecard.

**ODI win probability** (`odiWinProbability`, `calculateWinProbability` with `totalOvers: 50`): fitted on Cricsheet ODIs
2015+ (full matches with a result, every delivery a state; `packages/ratings/src/analysis/odi-win-probability.py`, generated
`odi-win-probability-data.ts`, calibration in `docs/data/odi_win_probability.json`). E = g x R(overs left, wickets down) / 100,
the runs still to come at the average level (R = the DLS resources). A chase: P = sigmoid(a_k + b_k (E - runs needed) /
sqrt(E + c)) with its own a, b in six stages of overs left (the end of a chase is sharper than its start); the first innings:
P = sigmoid(a + b (runs + E - g) / sd). Men g 265, sd 65; women g 235, sd 64. Predicted and actual agree within about 3 points
in every tenth of probability (in sample). 11/1 chasing 306 in 48 overs reads 21% (the T20 model on a stretched par had said
76%), the start of a chase of 301 31%, of 251 59%. T20 win probability is unchanged.

**T20I check**: the T20Is of a series used to play on the league tables (powerplay two runs an over too fast, a third of
innings bowled out, the women 21 runs an innings too many; the live engine about 250 an innings). They now play at their own
fitted level: section "T20I level" below.

Not done: no multiplayer series; the series does not feed career stats.

## Per-country validation (benchmark built, fits not done)

`packages/app/src/__tests__/benchmark-countries.test.ts` (`BENCH_COUNTRIES=1 npx vitest run packages/app/src/__tests__/benchmark-countries.test.ts`) replays
the real fixtures (pairing, host country or neutral) between the twelve full members with the series' own sides and prints, per
country and format (men's and women's T20I and ODI since 2019, men's Tests since 2023): win rate overall, at home and away, mean
first-innings total, runs per wicket, and the head-to-head rates of the pairs with 8+ real matches, marking a figure OFF outside
its tolerance. Real targets: `docs/data/country_validation.json` from `packages/ratings/src/analysis/country-validation.py`.
First run (3 replays of each fixture; the T20I spread and SA20 changes above not yet in): OFF figures men's T20I 36, women's T20I
40, men's ODI 24, women's ODI 23, men's Tests 12 (of about 60-70 per set). The clearest: Australia and England women win 64% and 59% against
a real 87% and 74%; Bangladesh and Zimbabwe women win 46% and 38% against 18% and 0%; Sri Lanka, West Indies and Zimbabwe men's
T20I are too strong (48 / 51 / 43% against 36 / 41 / 29%); Test first innings: New Zealand 284 against 394, Bangladesh 310 against
236. No per-country strength or home-advantage fit has been made yet.

## T20I level

A series' T20Is play at a level fitted on real T20Is, in both engines; men's leagues stay on the league tables (the instant
fingerprint's men's lines are unchanged); women's leagues have contexts of their own (RULES-MATCH.md 12.7).

**Where it hooks in.** `t20iRules` (international.ts) sets `RuleSet.scoringContext: "t20i"`. `scoringContextFor(rules, fmt)`
(`scoring-context.ts`) returns the gender's table from `t20i-context-data.ts` for a T20 with that field and nothing otherwise
(leagues, The Hundred, the ODI). The instant engine puts it in the match's `VenueContext`, the live engine in each ball's rules
context; `ballProbabilities` multiplies it in after the T20 phase multipliers: per phase (overs 1-6, 7-15, 16-20) a
multiplier on each outcome class (dot, 1, 2, 3, 4, 6, wicket, wide, no-ball, bye / leg bye). A live user's batting approach
and field setting apply on top, as in a league match.

**Data** (`packages/ratings/src/analysis/t20i-level.py`, `docs/data/t20i_validation.json`): Cricsheet T20Is from 2019 between
two of the twelve full members, full 20-over matches (no overs lost, no DLS or awarded result): 582 men's and 434 women's. Per
gender: first-innings totals, run rate by phase, wickets and all-out share, the chase, batting-first wins, extras, fours and
sixes, each phase's share of deliveries by outcome class, and the fixtures (pairings and counts).

**Fit** (`packages/app/src/__tests__/calibrate-contexts.test.ts`): the real fixtures replayed twice by the instant engine with the
series' own sides (`createSeries` / `seriesSquads`: national squads of active players on T20 ratings, the extended pool's
senior players among the candidates; neutral venues, no rain); each round multiplies every class's weight by real share /
simulated share in its phase (six rounds, half steps after the third). The largest class error after the last round is under
4% (on the rare threes); the classes that carry the runs are within 1-2%.

| men | 1st inns (sd) | 200+ | RR 1-6 / 7-15 / 16-20 | 1st inns wkts / all out | 2nd inns | bat 1st wins | extras / inn | 4s / 6s per inn |
|---|---|---|---|---|---|---|---|---|
| real (582) | 169.5 (37.3) | 19.2% | 8.08 / 8.05 / 10.01 | 6.63 / 11.5% | 150.7 | 49.7% | 8.4 | 12.9 / 6.6 |
| instant, league tables | 171.5 (34.0) | 20.4% | 10.37 / 7.56 / 10.30 | 7.60 / 31.1% | 153.4 | 47.9% | 8.1 | 15.4 / 8.0 |
| live, before this round (150 matches) | 251.8 | | | | | | | |
| live CPU, league tables | 170.7 (32.3) | 17.1% | 10.41 / 7.42 / 10.35 | 7.58 / 31.7% | 153.7 | 46.6% | 8.1 | 15.4 / 7.8 |
| instant, T20I level | 165.5 (24.3) | 6.6% | 8.00 / 8.06 / 9.77 | 6.63 / 15.6% | 154.2 | 45.9% | 8.4 | 12.9 / 6.6 |
| live CPU, T20I level | 165.5 (25.1) | 6.7% | 8.01 / 8.07 / 9.76 | 6.63 / 15.8% | 154.4 | 44.8% | 8.4 | 12.7 / 6.7 |

| women | 1st inns (sd) | 200+ | RR 1-6 / 7-15 / 16-20 | 1st inns wkts / all out | 2nd inns | bat 1st wins | extras / inn | 4s / 6s per inn |
|---|---|---|---|---|---|---|---|---|
| real (434) | 142.2 (34.6) | 5.1% | 6.52 / 6.84 / 8.46 | 6.23 / 9.2% | 123.2 | 48.0% | 7.6 | 13.9 / 1.8 |
| instant, league tables | 163.3 (33.1) | 11.6% | 10.17 / 6.92 / 10.03 | 7.72 / 31.8% | 144.8 | 47.1% | 7.2 | 14.8 / 7.3 |
| live, before this round (150 matches) | 229.6 | | | | | | | |
| live CPU, league tables | 161.9 (33.9) | 11.3% | 10.12 / 6.97 / 9.85 | 7.71 / 32.0% | 145.0 | 45.6% | 7.2 | 14.9 / 7.1 |
| instant, T20I level | 138.1 (18.4) | 0.0% | 6.54 / 6.71 / 8.05 | 6.15 / 12.2% | 128.6 | 46.9% | 7.1 | 13.9 / 1.9 |
| live CPU, T20I level | 138.8 (18.6) | 0.0% | 6.54 / 6.78 / 8.01 | 5.95 / 10.5% | 129.9 | 45.2% | 7.2 | 13.9 / 1.9 |

("League tables" = the same sides with the context off, `CAL_NOCONTEXT=1`; the live engine there already plays the instant
engine's ball, RULES-MATCH.md 12.4.) The powerplay comes down by about two and a half runs an over (men) and three and a half
(women), all-out innings from about 31% to 16% / 11-12%, the women's first innings from 163 to 138 and their sixes from 7 an
innings to 2. The live rows match the instant ones within a run. What the context does not fix:

- First-innings totals sit 4 runs (2-3%) under the real ones, mostly in the death overs (9.8 against 10.0 an over for the
  men, 8.0 against 8.5 for the women) and from innings bowled out early.
- The spread (fixed, see below): simulated first innings had a standard deviation of 24 (men) and 18 (women) against 37 and 35.
  The real spread includes grounds and pitches (the fit plays neutral venues) and gaps between sides wider than the ratings
  give; so the engine had a third as many 200s as real men's T20Is, and no women's 200.
- All out: 15.6% / 12.2% against 11.5% / 9.2% with the wickets per innings right. A wicket term by wickets down (fitted per
  phase on the real dismissal rates) left this unchanged and was dropped: with the per-ball rates right, the excess comes
  from weak batting sides collapsing more than real ones, which is the ratings' spread, not the context.
- Chasing sides win 2-5 points more often than real (batting first 45-47% against 48-50%).

Refit: `python3 -I src/analysis/t20i-level.py` (from packages/ratings, needs `duckdb`), then
`CALIBRATE_T20I=1 CAL_ITER=6 CALIBRATE_WRITE=1 npx vitest run packages/app/src/__tests__/calibrate-contexts.test.ts -t "T20I" --reporter=verbose`
(about 15 minutes; `CAL_LIVE=1` adds the live rows; it starts from the current table, `CAL_NOCONTEXT=1` from none), rebuild the
engine, then `npx vitest run packages/engine/src/__tests__/scoring-context.test.ts`. Refit after the T20 ratings or the national
squads change.

**The T20I's own match conditions** (`match-conditions.ts`, key `t20i` of each gender in `match-conditions-data.ts`; both
engines read it for a match whose rules have `scoringContext: "t20i"`). The T20Is had borrowed the men's default term and the
women none. Fitted like the leagues' (RULES-MATCH.md 12.8) but on the replayed real fixtures (`calibrate-spread.test.ts`,
`CAL_T20I=1`): a grid of fixed run multipliers, the two-piece normal shape and scale that best match the real season-centred first
innings' percentiles and 200+ / under-120 shares (t20_spread.json "t20i-m" / "t20i-w"), the centre set to keep the mean. Men
`lo` 0.12, `hi` 0.36; women 0.29 / 0.435 (a wider scale: their ratings compress the gaps between sides most). On 3,500 / 2,600
drawn matches, first innings, deviation at the 10 / 25 / 50 / 75 / 90th percentile; 200+; under 120:

| | sd | percentiles | 200+ | under 120 |
|---|---|---|---|---|
| men real (centred) | 36.1 | -44 / -25 / 0 / +23 / +42 | 15.5% | 9.5% |
| men before | 24.3 | -38 / -18 / +1 / +21 / +38 | 12.0% (6.6% at the unscaled mean) | 7.2% |
| men after | 35.3 | -45 / -22 / +2 / +25 / +44 | 15.4% | 10.1% |
| women real (centred) | 33.5 | -41 / -20 / 0 / +21 / +42 | 3.2% | 28.1% |
| women before | 22.6 | -27 / -15 / -1 / +16 / +28 | 0.3% | 19.1% |
| women after | 30.2 | -39 / -21 / 0 / +21 / +38 | 2.0% | 26.2% |

Refit: `CAL_T20I=1 CALIBRATE_WRITE=1 npx vitest run packages/app/src/__tests__/calibrate-spread.test.ts -t "T20I"` (about 8 minutes;
the leagues' entries are kept). The women's spread is still 3 runs short (their grid cannot go wider without under-120 overshooting).

**The women's leagues** (WPL, WBBL, the women's Hundred) were off the same way and now have contexts of their own, fitted
the same way on their matches since 2024: docs/RULES-MATCH.md 12.7.

