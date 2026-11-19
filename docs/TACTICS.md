# Tactics: bowling plan, bowler type by phase, ball age, conditions

What a user can set for a match and how the engines stay accurate for whatever is set. Everything below is fitted on Cricsheet ball by ball (or on the measured
grounds those data produced); a control is either a fitted effect that improved out-of-sample prediction or a way of reaching an already-fitted term. Where
the data was thin the setting is neutral or not offered, and where a test failed the term was not shipped (the tables say which).

**What a user can set** (International series: T20I, ODI, Test; men and women), on top of the XIs and the batting order (COUNTRY-VALIDATION.md, "Actual XI"):

| control | where | what it does |
|---|---|---|
| Bowling plan: who bowls the powerplay, the middle overs, the death | the side's XI screen (T20I, ODI) | bowlers listed for a phase are chosen from, by the captain's fitted model |
| Bowling plan: fix individual overs | same, "Fix individual overs" | the over goes to that bowler when the rules allow him |
| Bowling plan, Test: who opens, spin not before over N | same (Test) | the first over from each end; no spin before the over while a seamer is free |
| Pitch: flat, green and seaming, dry and turning, slow and low | the series page, per series | the profile of the top tenth of real grounds on that dimension |
| Light: day, day-night (ODI) | same | the chasing side's edge by day against under lights |
| Weather: clear, unsettled (Test) | same | no time lost, or the wettest fitted host's rate |

Left alone, a side bowls as real captains do and the ground plays as the real ground did: every control defaults to the realistic choice. Code:
`packages/engine/src/bowling-choice.ts`, `t20-bowler-type.ts`, `conditions.ts` (+ `test-match.ts` `chooseBowler`, `pitchConditions`); app:
`components/BowlingPlanEditor.tsx`, `InternationalPage.tsx` (`ConditionsBar`, `LineupScreen`), `international.ts` (`SeriesLineup.bowling`, `IntlSeries.conditions`).

## 1. Bowling plan

**Before.** The instant engine (and the live engine's CPU side) bowled, each over, one of the three best available bowlers on rating, uniformly, bar the caps (4 overs a
bowler in a T20, 10 in an ODI) and no two overs in a row. Against what 1,788 real international T20Is and ODIs since 2019 did (the `bowl` lists of
`docs/data/actual_xi.json`, replayed with the XIs that really played; `tactics-allocation.test.ts`, `BENCH_TACTICS=1`), that put spin on for half the powerplay and a
third of the death, and the best three bowlers on for every first and last over:

| share of overs bowled by spin (real / before / after) | men's T20I | women's T20I | men's ODI | women's ODI |
|---|---|---|---|---|
| powerplay | 0.22 / 0.50 / **0.24** | 0.36 / 0.61 / **0.35** | 0.10 / 0.39 / **0.11** | 0.17 / 0.61 / **0.19** |
| middle overs | 0.60 / 0.47 / **0.62** | 0.67 / 0.58 / **0.68** | 0.52 / 0.40 / **0.52** | 0.65 / 0.52 / **0.63** |
| death | 0.19 / 0.39 / **0.25** | 0.51 / 0.48 / **0.53** | 0.28 / 0.41 / **0.34** | 0.48 / 0.55 / **0.52** |

| first over bowled by the XI's 1st / 2nd / 3rd / 4th+ best bowler, men's T20I | real | before | after |
|---|---|---|---|
| | 0.18 / 0.20 / 0.22 / 0.41 | 0.33 / 0.32 / 0.30 / 0.06 | **0.19 / 0.17 / 0.19 / 0.46** |
| last over | 0.13 / 0.12 / 0.17 / 0.58 | 0.06 / 0.06 / 0.06 / 0.82 | **0.10 / 0.13 / 0.16 / 0.61** |

(Real captains open and close with the bowler who suits the phase, not the one with the best rating: the fourth best or lower bowled the first over in 41% of men's T20Is.)
Overs by the k-th most used bowler of an innings, men's T20I, real 4.00 / 3.96 / 3.83 / 3.50 / 2.85 / 1.13 / 0.15: before 4.00 / 4.00 / 3.96 / 3.63 / 2.55 / 1.10 / 0.19, after
3.98 / 3.88 / 3.65 / 3.34 / 2.87 / 1.27 / 0.36 (the sim still uses a sixth and seventh bowler a little more than real captains).

**The model** (`bowling-choice.ts`, fitted by `packages/ratings/src/analysis/bowling-choice.py`, table `bowling-choice-data.ts`, report `docs/data/bowling_choice.json`). A conditional
logit over the bowlers who may bowl the next over (the attack, overs left, not the bowler of the last over), one per format and gender. The utility of a bowler is a sum of
fitted weights of: his rating rank in the eleven; his type (fast, medium, spin, part-time) in each phase and in each over (single overs in a T20, pairs in an ODI); whether he is one
of the two best at the start and the death; overs used by type and phase; the gap since his last over; overs he has bowled in the phase; whether he is new to the attack; whether he is
a part-timer, and how tight the attack is (front-line overs left against overs to bowl: a part-timer is used only when the rest cannot cover the innings); and whether choosing a pace
bowler now would leave the attack short of pace for the death. Fit on matches to 2024 (ridge penalty), judged on 2025 on, on the ratings the engine plays the players on:

| set | choices fit / holdout | log likelihood per choice, holdout: model | uniform over the eligible | the former rule (top three, uniform; floor 0.01 for the rest) |
|---|---|---|---|---|
| men's T20I | 15,116 / 5,940 | **-1.245** | -1.533 | -2.098 |
| women's T20I | 11,232 / 4,278 | **-1.358** | -1.587 | -2.223 |
| men's ODI | 24,836 / 8,125 | **-0.955** | -1.609 | -2.125 |
| women's ODI | 15,058 / 7,592 | **-0.937** | -1.644 | -2.252 |

The former rule put the real bowler among its top three 68-72% of the time. The ODI keeps its feasibility filter (`odiBowlerChoices`: five bowlers, all ten overs needed, so only choices
that leave every quota finishable) and the model chooses within it. The Hundred and a rain-cut innings keep the former rule (not fitted there). Both engines use the same function: the
live engine's CPU side (and a user's plan on a CPU-controlled side) goes through `pickNextBowler`, the instant engine through `simulateInnings`.

**The plan** (`BowlingPlan`: `powerplay`, `middle`, `death` (ids), `overs` (over index to id), and for a Test `spinFrom`). In an over: the bowler fixed to it if the rules allow him (cap,
no two in a row, not hurt), else the bowlers listed for the phase that are eligible, else anyone; the model chooses among what is left, so a user who lists two bowlers for the death
gets them in the death in the proportions a captain would use them. A bowler named in a plan joins the attack. The caps and the consecutive-over rule always hold: a plan that asks for more
(one bowler for twenty overs) is flagged in the editor and played as far as the rules allow, then by the captain. Phases are overs 1-6 / 7-15 / 16-20 in a T20I and 1-10 / 11-40 / 41-50 in an ODI.
"Default" in the editor shows the captain's most likely bowler for every over (`modelPlanFor`); "Start from the default plan" copies it into the fixed overs to edit.

**Test.** The Test engine already had fitted captaincy (spells, workloads by day, the spin share by region and ball age, the new ball at 80 overs: `chooseBowler`, FORMATS.md "The captains").
A Test plan adds two things on top: who opens (overs 0 and 1 of an innings, one from each end) and `spinFrom` (no spin before that over while a seamer is free: the captain's want for spin
is overridden, the spell lengths and workloads stay his). Fixed overs of any other index are honoured the same way.

## 2. Bowler type by phase

**Before.** `matchups.ts getPhaseModifier` held hand-set multipliers: a fast bowler 1.12 on wickets and 0.93 on economy in the powerplay, a spinner 0.90 / 1.10, a part-timer 0.80 / 1.20; spin
1.12 / 0.90 in the middle overs and 0.85 / 1.15 at the death. The ODI had its own fitted `bowlerType` table (pace / spin by ten overs).

**Refit** (`packages/ratings/src/analysis/t20-bowler-type.py`, `t20-bowler-type-data.ts`, `docs/data/t20_bowler_type*.json`). Cricsheet T20 and T20I balls of 6-ball overs from 2016 (1.2 million men's,
0.4 million women's), ten ball classes (dot, 1, 2, 3, 4, 6, wicket, wide, no-ball, bye), per-class Poisson rates fitted by iterative proportional fitting with the batter's and the bowler's own quality,
the over, wickets down, balls the striker has faced, the chase, the era and the competition taken out, and a factor per bowler type and over bucket (1-6, 7-10, 11-15, 16-18, 19-20), shrunk toward 1
(women's toward men's). Factors are normalised to mean 1 over the balls the type bowled, because a bowler's rating already carries his average quality: the table is each type's phase profile.
It replaces the hand-set modifiers in both engines (`applyT20BowlerType` in `ballProbabilities`).

**Out of sample.** Fit to the end of 2023, scored on the balls of 2024 on for players the fit had seen (the multinomial log likelihood per ball, `--holdout`):

| | balls | no type factor | former hand-set modifiers | fitted, pace / spin | fitted, 5 types (fast, medium, off-spin, orthodox, wrist) |
|---|---|---|---|---|---|
| men's T20 | 339,671 | -1.64535 | -1.64575 | **-1.64497** | -1.64516 |
| women's T20 | 119,684 | -1.54682 | -1.54739 | **-1.54594** | -1.54593 |

The hand-set modifiers predicted **worse** than no phase-by-type effect at all; the fitted table beats both (+0.38 and +0.88 per 1,000 balls over none, which is 130 and 105 log-likelihood points
on these balls). Finer types did not beat pace / spin out of sample (left-arm against right-arm was not separately fitted for the same reason), so there are two types plus "neither" (part-timers and
bowlers with no recorded style, which carries its own fitted profile).

**What it costs.** From the table (men's T20, a typical ball's class shares; relative to the type's own average over the innings, same bowler quality), runs per over and wicket rate by over bucket:

| | overs 1-6 | 7-10 | 11-15 | 16-18 | 19-20 |
|---|---|---|---|---|---|
| pace | +0.06 rpo, wickets +3% | -0.36, -4% | +0.06, -2% | -0.13, -3% | +0.31, +3% |
| spin | **+0.39**, 0% | -0.36, -4% | +0.15, +2% | -0.11, +4% | **+0.67**, **+14%** |
| neither (part-time) | +0.13, +2% | -0.34, -4% | +0.06, -2% | -0.03, +6% | +0.22, +1% |

So a spinner in the powerplay costs about 0.3 runs an over more than a pace bowler of the same rating (more fours: spin 4s x1.15; the hand-set rule charged about 0.8), a spinner at overs 19-20
costs about 0.4 an over more than pace but takes 14% more wickets (sixes x1.29, wickets x1.15), and a part-timer at the death costs about as much as the average bowler there: part-timers are used
there rarely, in the data and now in the sim, and the fitted cost is small. The women's profile has the same shape with a bigger over-19-20 swing (sixes x1.35 for spin, x1.41 for pace).

**The ODI's own.** The ODI model carries pace / spin by ten overs (`odi-model-data.ts`). Whether finer buckets (the first three overs, 4-10, then 5s) predict better: they do not (section 3, `odi`).

**What had to be refit because of the new allocation and the new table.** Both change who bowls what, so the scoring level moved: the ODI per-outcome calibration (`ODI_CAL`) was refitted
(`benchmark-odi.ts CALIBRATE=1`, three rounds; the ODI men's replay of the real fixtures was 234 runs against 253 real before, 252 after; women's 227 real, 223 after) and the series tuning (strength stretch and
home advantage per set, fitted on actual-XI play to 2024 as before, `BENCH_FIT` then `BENCH_FITHOME`):

| set | before: spread / home (country homes) | after |
|---|---|---|
| men's T20I | 2.5 / 6 (Australia 12, New Zealand 10, Pakistan 2 ...) | 2 / 4 (Australia 2, New Zealand 8, Pakistan 6, South Africa 2, Sri Lanka 2, West Indies 2, Zimbabwe 2, Ireland 0) |
| women's T20I | 3.5 / 2 (India 4, Ireland 6, South Africa 4 ...) | 3.5 / 4 (Australia 6, England 6, India 0, New Zealand 8, West Indies 2, Sri Lanka 8, Zimbabwe 2) |
| men's ODI | 1 / 2 (Sri Lanka 8, Australia 4 ...) | 1.5 / 6 (Australia 8, South Africa 8, Sri Lanka 14, West Indies 4, New Zealand 8, Zimbabwe 2) |
| women's ODI | 1.5 / 2 (Australia 6, South Africa 6 ...) | 2 / 2 (Bangladesh 4, Australia 4, India 0, Ireland 4, New Zealand 0, West Indies 6, South Africa 4, Sri Lanka 4, Zimbabwe 4, Pakistan 0) |

**Win prediction on the real fixtures** (`BENCH_ACTUAL=1 BENCH_REPLAYS=24`, every real match replayed with the XIs that played, log loss per real match, 0.693 a coin flip; the Test is untouched):

| set | fit half (to 2024) before -> after | holdout (2025+) before -> after |
|---|---|---|
| men's T20I | 0.634 -> **0.630** | 0.592 -> 0.611 |
| women's T20I | 0.524 -> 0.526 | 0.436 -> 0.471 |
| men's ODI | 0.575 -> **0.559** | 0.653 -> 0.704 |
| women's ODI | 0.497 -> 0.520 | 0.465 -> 0.490 |

This is the cost, stated plainly: the ball-level effects it rests on improved (the choice of bowler, the bowler-type table, both out of sample), and the fit halves are level or better in two sets, but the win prediction on the
2025+ holdouts is 0.02-0.05 worse in all four limited-overs sets (the holdouts are 60-120 matches, a paired noise of about 0.03, but four of four in one direction is more than noise). Retuning the spread and home terms did not close it (the
old tuning on the new engine scored the same on the holdouts at 8 replays).

**League benchmarks** (`calibrate-leagues.test.ts`, 8 simulated seasons, `LEAGUE_LEVELS` untouched; real in brackets): runs per innings / wickets per innings, before -> after:

| league | runs | wickets |
|---|---|---|
| IPL | 170.8 -> 172.3 (183.7) | 5.85 -> 5.95 (6.05) |
| WPL | 155.3 -> 154.2 (157.8) | 6.19 -> 6.30 (6.20) |
| BBL | 156.5 -> 153.5 (158.3) | 6.21 -> 6.27 (6.47) |
| WBBL | 139.8 -> 142.3 (141.0) | 6.12 -> 6.26 (6.37) |
| PSL | 169.1 -> 167.2 (169.2) | 6.38 -> 6.47 (6.47) |
| SA20 | 145.2 -> 145.5 (153.4) | 5.71 -> 5.73 (6.21) |
| Hundred (m) | 134.9 -> 136.0 (137.3) | 5.74 -> 6.01 (5.88) |
| Hundred (w) | 119.1 -> 120.8 (120.5) | 5.73 -> 5.86 (5.97) |
| CPL | 156.4 -> 153.5 (158.0) | 6.05 -> 6.14 (6.27) |
| ILT20 | 151.9 -> 154.9 (154.9) | 6.09 -> 5.93 (6.18) |
| MLC | 166.4 -> 168.0 (164.9) | 6.25 -> 6.26 (6.38) |
| BPL | 155.3 -> 152.4 (152.4) | 6.33 -> 6.33 (6.40) |
| LPL | 167.9 -> 168.9 (175.7) | 6.55 -> 6.35 (6.64) |

Mean absolute error against the real innings: runs 3.64 -> 3.62, wickets 0.176 -> 0.161: at or a little closer to real overall; individual leagues moved by a few runs either way (BBL, CPL -3, ILT20 and BPL
to the data). T20I (`calibrate-contexts.test.ts`): men's first innings 163.5 -> 165.9 (real 169.5), wickets 6.69 -> 6.56 (6.63); women's 140.3 -> 141.8 (142.2), all out 10.5% -> 13.1% (real 9.2%).
The T20 / Hundred fingerprint (`fingerprint-matches.ts 300`) moved on every line, as it must when the bowler choice changes.

## 3. Ball age

Real ball-age effects would show as a term that predicts the next ball better than the over and the bowler type already do. Four tests, each fitted twice by iterative proportional fitting on matches to the end of 2023
(with and without the term, the batter's and bowler's own quality taken out) and scored on the balls of 2024 on (`packages/ratings/src/analysis/ball-age.py`, `docs/data/ball_age.json`; log likelihood per ball,
gain per 1,000 balls; a term ships only if it is positive):

| test | what the term is | holdout balls | gain per 1,000 balls | shipped |
|---|---|---|---|---|
| `test` | Test: age (overs since the new ball) x pace / spin, over the existing age term | 38,049 | **-0.16** | no |
| `odi` | ODI: the new ball of the first overs and the old one at the end: ten over buckets of the bowler-type factor (first three overs, 4-10, then fives) against five | 33,313 | **-0.23** | no |
| `odi-age` | ODI: the ball's own age (over / 2 while two balls are in use, the chosen ball from over 35) x pace / spin, by era (one ball to 2011, two since) | 32,777 | **-1.14** | no |
| `t20` | T20: the first two overs as their own buckets of the bowler-type factor | 174,341 | **-0.04** | no |

Nothing beats what the engine has, so nothing was added. What is there: the Test model fits ball age directly (overs since the new ball, bins 0-4 ... 65+, the new ball taken at 80 and 160 overs; the live
Test asks the user when it is due: `test-match.ts` AGE_BINS, `new_ball` decision); a T20 or ODI ball's age is a function of the over (and, in the men's ODI, of the two balls: `ballAgeOvers`), which the over
tables and the bowler-type table already carry, so a separate age term cannot be told from them except through the era change from one ball to two, and that did not predict (`odi-age`). The T20 / ODI
tests above say that seam does not gain from the new ball, or spin from the old one, beyond the over-bucket profile in the table of section 2 (spin at overs 19-20 is hit for sixes and takes
wickets; pace at overs 7-10 is cheap). The user has no ball-age control for a T20 or ODI because the Laws leave none (the ODI's choice of ball at over 35 is not in the data as a choice).

## 4. Conditions

**Realistic default.** Nothing set: the ground's measured profile (T20 grounds `venue-data.ts`, ODI grounds `odi-venue-data.ts`, the T20I and Test host-country terms) and the match's own fitted draw (a skewed run multiplier
per match in a T20, `match-conditions.ts`; the run / wicket spread and the weather per Test) apply, as they did.

**Pitch** (`conditions.ts` `PITCH_PRESETS`, `applyConditionsToProfile`). A preset is the mean profile of the top tenth of real grounds on its dimension: flat and slow by run factor (T20: 91 measured grounds, ODI: 72 men's grounds with 15+ matches),
turning and seaming by the spin-minus-pace value of the grounds' bowler-type edges (T20 grounds with edges: 71; ODI: the 123 List A venues with 1,500+ balls in the bowler-type analysis, scaled to the T20 edges' units). It overlays the ground's run, six and
wicket factors (the wicket factor shrunk to a quarter, as the grounds' are, because wicket effects did not hold up out of sample) and its pace and spin edges, so it costs what a ground of that kind really does through `applyVenueProfile`:

| T20I (1,500 matches each) | first innings | wickets / match | pace wickets / 100 balls | spin wickets / 100 balls |
|---|---|---|---|---|
| the ground as it is | 165.5 | 12.7 | 5.99 | 5.32 |
| flat | 173.2 (+4.7%) | 11.8 | 5.40 | 4.92 |
| slow and low | 153.1 (-7.5%) | 13.7 | 6.50 | 5.79 |
| dry, turning | 160.4 (-3.1%) | 13.4 | 6.11 (+2%) | 5.82 (+9%) |
| green, seaming | 165.4 | 12.7 | 6.09 (+2%) | 5.17 (-3%) |

| ODI (800 matches each) | first innings | wickets / match | pace wickets / 100 balls | spin wickets / 100 balls |
|---|---|---|---|---|
| the ground as it is | 273.0 | 15.0 | 3.25 | 2.23 |
| flat | 294.6 (+7.9%) | 14.3 | 2.98 | 2.11 |
| slow and low | 246.2 (-9.8%) | 15.2 | 3.30 | 2.42 |
| dry, turning | 263.6 (-3.4%) | 14.9 | 3.21 | 2.29 |
| green, seaming | 276.5 | 14.8 | 3.25 | 2.14 |

(`BENCH_CONDITIONS=1`, `conditions.test.ts`. The real top-decile grounds are not extreme: a seaming ground's pace edge is about +1.5% on wickets, and that is what it plays.) A player-level pitch sensitivity is not modelled:
VENUE-SENSITIVITY.md showed per-player slopes do not predict out of sample, so every bowler of a type reads the same edge and every batter the same ground factor.

**Light (ODI).** The chasing side's edge by day against under lights, from the List A record (VENUE-CONDITIONS-REPORT.md "Day vs day/night": men's List A chasing wins +4.6% by day, -1.2% day-night, 16,245 and 3,189 matches): half the gap either way
on the engine's chase-edge term (+/-0.029). Over 4,000 simulated ODIs each, the chase wins 53.8% by day and 47.5% day-night: a 6.3-point gap against the real 5.8. The T20 gap (+2.8% against +0.9%, 12,243 and 4,587 matches) is 1.9 +- 1.7 points,
inside its noise: no T20 light control is offered. Only the user can set it; the realistic default draws none (the data has no per-ground share of day-night matches for the T20I / ODI sets).

**Weather (Test).** `clear` plays with no time lost, `unsettled` with the wettest fitted host's days-affected rate and share of play lost (the fitted country table, 20+ Tests: Sri Lanka, 22% of days).

**Pitch (Test).** A Test's pitch is its own run / wicket spread (drawn per Test: sd 0.072 on runs, 0.152 on wickets, correlation 0.10, `matchSpread`): flat / slow set it to the top-tenth mean of the run dimension (+/-1.755 sd), seaming
the wicket dimension, with the fitted correlation for the other. A turning pitch is not offered for a Test: the Test model's spin edge is a host-country term (venue country x pace / spin), not a match term; pick an Asian host.

## 5. Tail batters

By batting position the sim matches the real runs and balls from 1 to 8 (men's T20I: 1: 28.1 / 20.7 against 27.4 / 19.8; 7: 12.2 / 9.2 against 12.6 / 9.6) and the number 9 (6.4 / 5.8 against 6.3 / 5.7); numbers 10 and 11 still score
more than real tails (5.0 / 4.7 against 4.2 / 4.3, and 3.9 / 3.8 against 2.3 / 2.9; women's 4.0 / 4.5 against 2.8 / 4.1 and 3.5 / 3.6 against 1.8 / 3.2). It was not fixed: a term by batting position would
act on the order rather than the batter (a user who bats a star at 11 would get a tail-ender), and the route through ratings (the ODI model's `ODI_TAIL_WEIGHT`: a batter's shortfall below the reference counts for more) changes every low-rated batter in every
league and would need the league levels fitted again. Left over.

## Refitting

- Bowling choice: `BENCH_TACTICS=1 BENCH_EXPORT=train.json npx vitest run packages/app/src/__tests__/tactics-allocation.test.ts`, then `python3 packages/ratings/src/analysis/bowling-choice.py train.json` (needs numpy and scipy).
  `BENCH_TACTICS=1 [BENCH_REPLAYS=2] [BENCH_ONLY=...]` prints the allocation tables above (real against the sim).
- Bowler type: `python3 -I packages/ratings/src/analysis/t20-bowler-type.py --types 2 --write` (about 15 minutes; `--holdout` for the out-of-sample score, `--types 5|7` for finer types).
- Ball age: `python3 -I packages/ratings/src/analysis/ball-age.py test|odi|odi-age|t20`.
- After any of these the ODI calibration (`benchmark-odi.ts CALIBRATE=1`, with `ODI_TUNE` to try values) and the series tuning (`BENCH_FIT=1 BENCH_FIT_ON=actual BENCH_HOLDOUT=fit`) move: refit them.
