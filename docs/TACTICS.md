# Tactics: bowling plan, bowler type by phase, ball age, conditions

What a user can set for a match and how the engines stay accurate for whatever is set. Everything below is fitted on Cricsheet ball by ball (or on the measured
grounds those data produced); a control is either a fitted effect that improved out-of-sample prediction or a way of reaching an already-fitted term. Where
the data was thin the setting is neutral or not offered, and where a test failed the term was not shipped (the tables say which).

**What a user can set** (International series: T20I, ODI, Test; men and women), on top of the XIs and the batting order (COUNTRY-VALIDATION.md, "Actual XI"):

| control | where | what it does |
|---|---|---|
| Bowling plan: who bowls the powerplay, the middle overs, the death | the side's XI screen (T20I, ODI) | bowlers listed for a phase are chosen from (T20I: by the captain's fitted model; ODI: the best of them on rating, by turns) |
| Bowling plan: fix individual overs | same, "Fix individual overs" | the over goes to that bowler when the rules allow him |
| Bowling plan, Test: who opens, spin not before over N | same (Test) | the first over from each end; no spin before the over while a seamer is free |
| Pitch: flat, green and seaming, dry and turning, slow and low | the series page, per series | the profile of the top tenth of real grounds on that dimension |
| Light: day, day-night (ODI) | same | the chasing side's edge by day against under lights |
| Weather: clear, unsettled (Test) | same | no time lost, or the wettest fitted host's rate |

Left alone, a T20I side bowls as real captains do (the ODI keeps the former rule, the best bowlers on rating by turns: section 2, "Regression on the real fixtures") and the ground plays as the real ground did: every control defaults to the realistic choice. Code:
`packages/engine/src/bowling-choice.ts`, `t20-bowler-type.ts`, `conditions.ts` (+ `test-match.ts` `chooseBowler`, `pitchConditions`); app:
`components/BowlingPlanEditor.tsx`, `InternationalPage.tsx` (`ConditionsBar`, `LineupScreen`), `international.ts` (`SeriesLineup.bowling`, `IntlSeries.conditions`).

## 1. Bowling plan

**Status.** The captain model below is the default for every T20 innings (T20I and the leagues). The **ODI does not use it by default**: it predicted the 2025+ ODIs worse than the former rule (section 2, "Regression on the real fixtures"), so the ODI keeps
the former rule (one of the best three on rating, uniformly; `captainModelFor`) with the user's plan narrowing it (fixed overs, the ODI phase lists), and the ODI figures in the tables of this section describe the model as fitted, not the ODI default. The model's plan strip in the editor
stays as a starting point for a user who wants to bowl like real captains.

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
that leave every quota finishable); the model would choose within it, but the ODI default is the former rule (Status above). The Hundred and a rain-cut innings keep the former rule (not fitted there). Both engines use the same function: the
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

**Regression on the real fixtures, and what shipped.** After the allocation and the bowler-type table went in (with the ODI calibration and the series tuning refitted for them), the win prediction on the 2025+ holdouts got worse in all four
limited-overs sets (24 replays of every real match with the XIs that played, log loss per real match, 0.693 a coin flip: men's T20I 0.592 -> 0.611, women's T20I 0.436 -> 0.471, men's ODI 0.653 -> 0.704, women's ODI 0.465 -> 0.490), while the ball-level fits
and the fit halves had barely moved. That is the number that decides, so it was chased down (the Test is untouched throughout).

*Method.* Every figure below replays each real match 48 times (96 for the final table) with the XIs that really played, through the code path a user's XI takes, and compares configurations **per match** (the same 168 / 120 / 109 / 103 holdout matches,
418 / 315 / 336 / 219 in the fit half): the difference in log loss and its standard error over the matches. The holdouts are small, so a paired standard error is 0.011-0.035; a difference is real only when it is well past that. The baseline is `7d2c5b9`
(a worktree at `7d2c5b9` itself and today's code with the four changes switched off agree: the ODI exactly, the T20I within 0.003; at 48 replays that worktree reads 0.471 for the women's T20I holdout, not the 0.436 of the 24-replay run, so single figures move by a few hundredths with the draw).

*Attribution* (holdout, difference in log loss from `7d2c5b9`, plus is worse; fit half in brackets; each row changes one thing and leaves the rest as it was at `7d2c5b9`):

| change alone | men's T20I | women's T20I | men's ODI | women's ODI |
|---|---|---|---|---|
| default allocation (the captain model) | +0.021 +- 0.014 (+0.002) | -0.010 +- 0.016 (+0.013) | +0.039 +- 0.022 (+0.007) | **+0.041 +- 0.025 (+0.042 +- 0.015)** |
| bowler-type table | +0.023 +- 0.013 (+0.009) | -0.004 +- 0.013 (+0.016) | 0 (ODI has its own table) | 0 |
| ODI calibration refit (on the old allocation) | 0 | 0 | +0.008 +- 0.019 (+0.002) | +0.030 +- 0.020 (-0.003) |
| series tuning refit (on the old engine) | +0.007 +- 0.013 (+0.026 +- 0.008) | +0.004 +- 0.011 (+0.003) | +0.012 +- 0.032 (-0.001) | +0.025 +- 0.026 (+0.021 +- 0.014) |
| all four, as shipped | **+0.025 +- 0.014** (-0.002) | **+0.020 +- 0.019** (+0.009) | **+0.058 +- 0.035** (+0.004) | **+0.018 +- 0.024 (+0.054 +- 0.018)** |

*Mechanism.* Not a leak or a bug: the benchmark plays the same XIs, bowling plan (none) and ground as the app path, and `7d2c5b9`'s numbers reproduce. The allocation is the main cause, in the ODI above all. The fitted captain spreads the overs over the attack
the way real captains do: by rating rank, the sim's k-th best bowler now bowls 3.40 / 3.40 / 3.29 / 3.12 / 2.95 overs of a men's T20I against 3.60 / 3.29 / 3.20 / 3.07 / 2.78 real, where the former rule (one of the best three on rating) gave 3.85 / 3.84 / 3.71 / 3.44 / 2.53.
That is faithful to what captains do, but captains pick on what they know of the bowlers and the ratings only partly capture it, so the real overs are less tied to the ratings than the sim's ratings need: with the model the stronger side's best-rated bowlers bowl a smaller
share and the gap between the sides narrows (the full members' win rate against associates in the ODI fell from 57% to 54%, which is why `odi.test.ts` had to be loosened). The slope of the sim's win probability on the real result confirms it where it matters: men's ODI holdout 0.65 -> 0.39
(1 would be calibrated), women's ODI fit half 0.82 -> 0.65, while the T20I's slopes are above 1 (more spread would help: men's holdout 1.27 -> 1.39). The ODI's loss is in discrimination, not only in scale (with the allocation alone the area under the ROC curve of the sim's probability falls 0.658 -> 0.613 men's holdout,
0.867 -> 0.848 women's fit half), so a refit of the spread cannot repair it; the T20I's is mostly scale.

*What was tried to fix it* (all fit-half decisions, holdout read once):

- **Refit the series tuning on the new engine, fit half only, more replays.** The shipped refit used 6-8 replays (finite replays make a sharp probability look worse, which pulls the spread down) and picked the smallest spread within 0.01 of the best loss, which in a flat grid is an arbitrary
  low value. At 32 replays on the fit half the loss over spread x home is flat to within noise for the men's T20I (best at spread 3, home 2-4; the old pick was 2) and has its minimum at the old women's value (3.5, home 4). Men's T20I: spread 2 -> 3, home 4 -> 2, country homes refitted (Australia 4, India 4,
  New Zealand 4, Pakistan 0, Zimbabwe 0). Women's T20I: unchanged. For the ODI no spread helps (running the new engine with the spread cut or left alone: women's holdout +0.055 / +0.075, men's +0.049).
- **Make the default choose by quality as the old rule did** (the model's rank weights x3 and x8; the model restricted to the best three or four on rating): the ODI loss closes by half at best (women's ODI holdout +0.041 -> +0.013 to +0.021, men's +0.039 -> +0.011 to +0.024) and the fit halves stay worse in all four sets; the T20I moves by less than its noise. Nothing reaches the old rule's level. Not shipped.
- **Old allocation on the new tuning and the other way round**, to see whether the refit alone caused it: the new engine on the old tuning scores the same as on the new (men's T20I +0.020 +- 0.013 against +0.025), so it is not the tuning.

*What shipped.*

- **ODI: the former allocation is the default again** (`captainModelFor`: one of the best three on rating, uniformly, with the user's plan narrowing it: fixed overs and the phase lists still work, in both engines), and `ODI_CAL` and the ODI series tuning are the values
  of `7d2c5b9` (fitted on that allocation; a refit on the model's went with the model). The ODI play with no plan is then identical to `7d2c5b9`'s, ball for ball. The plan editor says so (the strip shows how real captains share the overs, as a starting point).
- **T20I and every T20 league: the captain model and the fitted bowler-type table stay** (the realistic allocation: spin 24% of powerplay overs, not 51%), with the men's T20I tuning refitted above. On the holdout they are level with `7d2c5b9`, not better; the fit halves are level too.
  They stay because the ball-level fits are out-of-sample better, the league benchmarks are unchanged or a little closer (below) and the users' controls rest on them; if the next holdout (2026 matches) goes against them, `captainModelFor` is the one switch.

**Win prediction on the real fixtures, final** (`BENCH_ACTUAL=1 BENCH_REPLAYS=96 BENCH_DUMP=...`; log loss per real match, +- standard error over the matches; difference is paired against `7d2c5b9`, minus is better):

| set | half (matches) | `7d2c5b9` | now | difference |
|---|---|---|---|---|
| men's T20I | holdout 2025+ (168) | 0.596 +- 0.026 | 0.590 +- 0.027 | **-0.005 +- 0.015** |
| | fit to 2024 (418) | 0.632 +- 0.016 | 0.632 +- 0.017 | +0.000 +- 0.009 |
| women's T20I | holdout (120) | 0.462 +- 0.037 | 0.476 +- 0.043 | +0.014 +- 0.014 |
| | fit (315) | 0.520 +- 0.026 | 0.521 +- 0.028 | +0.001 +- 0.009 |
| men's ODI | holdout (109) | 0.673 +- 0.040 | 0.673 +- 0.040 | 0 (identical) |
| | fit (336) | 0.587 +- 0.022 | 0.587 +- 0.022 | 0 |
| women's ODI | holdout (103) | 0.435 +- 0.061 | 0.435 +- 0.061 | 0 |
| | fit (219) | 0.501 +- 0.050 | 0.501 +- 0.050 | 0 |

(Single-draw figures at fewer replays move by +-0.008: the same `7d2c5b9` read 0.588 at 48 replays and 0.596 at 96 for the men's T20I holdout.) The women's T20I holdout is the one set not at or better than `7d2c5b9`: 0.014 worse, one standard error. The men's T20I and the ODI sets are at or better.


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

Real tails score and survive less than the sim's. Men's T20I numbers 10 and 11 made 4.2 / 4.3 and 2.3 / 2.9 runs / balls in the real matches against the sim's 5.3 / 5.0 and 3.9 / 3.7 before this section; women's 2.8 / 4.1 and 1.8 / 3.2 against 4.0 / 4.5 and 3.5 / 3.6. Two things were suspected: the T20 ball model's response to a batter's rating is too shallow at the bottom (rating by position 0.80 0.80 0.81 0.80 0.79 0.77 0.73 0.60 0.44 0.34 0.31: the tail is rated as the tail), and a tail-ender survives too long. A crude fix tried first (count the shortfall below 0.45 at double weight, `ODI_TAIL_WEIGHT` the other way round) helped number 10, not number 11, left survival alone and cost 1.8 runs an innings.

**The refit** (`packages/ratings/src/analysis/t20-batter-response.py`, `packages/app/src/__tests__/tail-response.test.ts`, `batter-response.ts`, `docs/data/t20_batter_response.json`). The correction is a multiplier on each outcome class of the T20 ball model, piecewise linear in the striker's batting rating `(battingOvr + timing) / 200` (knots 0.25, 0.40, 0.55, 0.70, 0.85), per gender: `p'(class) = p(class) x exp(s_class(rating))`. It acts on the rating wherever the batter bats: **there is no positional term**, so a star at number 11 bats like a star and a tail-ender who opens like a tail-ender.
- *Data.* Real: every ball since 2016 of the men's T20 leagues (IPL, BBL, PSL, SA20, CPL, ILT20, MLC, BPL, LPL, The Hundred) and since 2019 of T20Is between full members, and the women's WPL, WBBL, The Hundred and T20Is, whose striker the game rates (Cricsheet id to the game's player, on the game's own ratings and, in a T20I, the opposition adjust a national side's batters carry): 457,000 men's and 127,000 women's balls to the end of 2023, 306,000 and 93,000 from 2024. Counted by competition x phase (overs 1-6, 7-15, 16-20) x rating bin (0.05 wide) x outcome class. Simulated: the same counts from the engine as it was (the game's squads in every league, the series' sides in the T20Is, 2,000 matches a league, 2 replays of the T20I fixtures).
- *Fit.* Within a competition and phase, a rating bin's share of each class relative to the phase's overall share, real over simulated, is the response the engine is missing at that rating. It is regressed on the piecewise-linear function (weights = inverse Poisson variances, a second-difference penalty on the knots, the wide / no-ball / bye shares as the reference, pooled over competitions and phases within a gender), on balls to 2023 only. A 3 takes the 2's response. Fitted to 2023, the response left in the 2024+ cells falls 2.1% (men) and 18% (women) in squared error: the women's sim hit far too many fours and sixes at middling ratings (at the applied strength the multiplier on fours is 0.26 at rating 0.25, 0.51 at 0.55 and 1.25 at 0.85; men's 0.72, 0.85 and 1.08).
- *Neutral.* Each class gets a constant so that over the simulated balls its share of all deliveries is what it was: the response moves runs and wickets from batter to batter, it does not move a league's level, its wickets or its all-outs (the tables the engine already carries were fitted without it).

| log multiplier at rating | 0.25 | 0.40 | 0.55 | 0.70 | 0.85 |
|---|---|---|---|---|---|
| men, fours | -0.32 | -0.25 | -0.16 | -0.05 | +0.07 |
| men, sixes | -0.27 | -0.15 | -0.06 | +0.00 | +0.03 |
| men, dots | +0.16 | +0.09 | +0.02 | -0.01 | -0.02 |
| women, fours | -1.34 | -1.01 | -0.66 | -0.26 | +0.22 |
| women, sixes | -0.99 | -0.72 | -0.46 | -0.15 | +0.18 |
| women, dots | -0.17 | -0.11 | -0.07 | -0.02 | +0.03 |

**Two things the fit does not give, and what was chosen instead.**
1. *The wicket row is not applied.* Fitted on its own it moves wickets from the top of the order to the tail (+0.24 at 0.25, -0.09 at 0.85 for men), and it is what moves a tail's survival most (men's number 11 from 3.9 / 3.7 to 3.0 / 3.5 runs / balls with the wicket row at half strength, number 10 to 4.1 / 4.5). But the real tail dies at a rate that, played with the real top and middle order, bowls the sim out too often: a men's T20I first innings is all out 15-16% of the time against a real 11.5% (12.7% before), the league all-out shares rise by 2-5 points, and refitting the wickets-in-hand tables on top (`calibrate-collapses.test.ts`) cannot take them back. The real hazards by wickets down match the sim's with the row on (0.076 / 0.093 / 0.099 / 0.112 a ball at 6 to 9 down); the sim reaches 8, 9 and 10 down more often (0.36 / 0.25 / 0.15 against 0.33 / 0.20 / 0.11 of innings), which is a matter of when wickets fall, not of the tail's rating. So the tail's survival (balls) is left where it was and a row-less correction is applied: the all-out shares, wickets per innings and totals stay at their former level.
2. *The strength is a power.* At the fitted strength the cells agree but positions barely move (the real tails bat at the very end of innings, at nine down, where the phase cells do not look); the run rows are applied at a power fitted on the position table of the 2023-and-earlier / 2024+ halves and the sd of totals: **men x1.25, women x1.5**. Higher moves number 9 down with it (men x2: number 9 5.5 runs against a real 6.8) and widens the totals (sd 38-40 against 37.3 real); women's x2 widens the sd to 37.5 against 33.5 and no conditions term can narrow it.

**By batting position** (`BENCH_POSITIONS=1`, the matches the real XIs played, real batting order, runs / balls; 2024+ matches in brackets, the out-of-sample half):

| position | men real | men before | men after | women real | women before | women after |
|---|---|---|---|---|---|---|
| 8 | 8.7 / 7.0 (8.7 / 7.1) | 8.8 / 7.2 (8.9 / 7.1) | 8.5 / 7.2 (8.6 / 7.2) | 6.8 / 6.7 (7.3 / 6.8) | 7.0 / 6.9 (7.1 / 6.9) | 7.5 / 7.4 (7.6 / 7.6) |
| 9 | 6.3 / 5.7 (6.8 / 6.1) | 6.6 / 5.9 (6.7 / 6.0) | 5.9 / 5.8 (5.7 / 5.6) | 4.8 / 5.6 (4.6 / 5.2) | 5.5 / 5.7 (5.5 / 5.6) | 5.4 / 5.9 (5.4 / 5.9) |
| 10 | 4.2 / 4.3 (4.6 / 4.7) | 5.3 / 5.0 (5.0 / 4.9) | 4.3 / 4.9 (4.2 / 4.8) | 2.8 / 4.1 (2.8 / 4.2) | 4.2 / 4.4 (4.1 / 4.3) | 4.0 / 4.6 (3.8 / 4.6) |
| 11 | 2.3 / 2.9 (2.2 / 2.8) | 3.9 / 3.7 (3.9 / 3.7) | 3.2 / 3.7 (3.6 / 3.9) | 1.8 / 3.2 (2.1 / 3.6) | 3.1 / 3.4 (3.3 / 3.4) | 2.9 / 3.5 (2.8 / 3.5) |

(10 replays of every match; the real sample at number 11 is 286 men's and 141 women's innings, 145 and 67 from 2024, so a figure at number 11 carries a standard error near 0.3 runs; the sim's own noise is about 0.1.) Number 10 comes to the real runs for men (4.3 against 4.2; the out-of-sample half 4.2 against 4.6; it was 5.3 and 5.0) and number 11 loses 0.7 runs (3.9 to 3.2 against a real 2.3); the balls faced do not move (men's number 11 3.7 against a real 2.9) and **women's tails are not materially closer** (number 10 4.0 / 4.6 against a real 2.8 / 4.1, was 4.2 / 4.4). Number 9 is where the response costs: men's 6.6 / 5.9 to 5.9 / 5.8 (real 6.3 / 5.7; 6.7 to 5.7 against 6.8 in the half after 2023). What is left of the tail is the survival of number 11 and the women's runs at 10 and 11: neither is something the rating of the batter can fix (below).

**What it moved and what was refit.** Neutral in shares, so the men's tables, contexts and conditions stay as they were. The women's T20I context was refit (it is the one set whose batters sit low on the rating scale: the response shifted its level 3 runs; `CALIBRATE_T20I=1 CAL_GENDER=women CAL_ITER=8 CAL_REPLAYS=4`), its conditions term refit (`calibrate-spread.test.ts`, `CAL_T20I=1`: `lo` 0.23 / `hi` 0.46 became 0.07 / 0.035; the response supplies the spread the term had), the women's league contexts refit (`CALIBRATE_LEAGUES=1`, 8 rounds of 1,500 matches), the men's league levels held at their former means by a recentre of the first-innings factors of the wickets-in-hand table (`CAL_RECENTRE=1 CAL_TARGETS=...`, `CAL_GAIN=2`; BBL, PSL, BPL, LPL, ILT20) and the series tuning refit on the fit half (men's T20I unchanged at spread 3 / home 2, women's T20I spread 3.5 / home 4 to 1.5 / 2: the response separates sides more).

**What it did to the numbers that were already right.** First innings, 2,000-5,000 instant matches (the league contexts report; real in brackets), before -> after: men's T20I 167.2 -> 167.8 (169.5), sd 35.6 -> 37.3 (37.3), all out 12.7% -> 13.4% (11.5%); women's T20I 141.9 -> 142.0 (142.2), all out 12.8% -> 8.4% (9.2%), sd 32.9 -> 28.7 (34.6: the new series tuning, below, and the lower stretch it fits, narrows the sides; before the tuning the totals' sd was 35); the WPL 161.0 -> 161.4 (162.0), WBBL 154.8 -> 152.9 (155.0), Hundred women 126.7 -> 127.4 (126.2); the IPL 178.7 -> 180.6 (192.8, whose shape is fitted at the engine's own level); the other men's leagues within 2 runs of before (BBL 168.1 -> 167.4, PSL 180.1 -> 177.8, BPL 157.6 -> 157.6, LPL 179.3 -> 179.4, ILT20 163.4 -> 161.8, SA20 160.9 -> 159.2, CPL 172.1 -> 173.7, MLC 175.3 -> 176.3, Hundred men 146.7 -> 146.4). First-innings all-out shares move by up to 2.5 points either way (BPL 12.9% -> 10.4%, real 16.0%; WBBL 15.9% -> 17.5%, real 15.6%).

*League benchmarks* (`calibrate-leagues.test.ts`, 32 simulated seasons, runs / wickets per innings in both innings, real in brackets):

| league | runs / innings before -> after (real) | wickets / innings before -> after (real) |
|---|---|---|
| IPL | 170.4 -> 171.9 (183.7) | 5.99 -> 5.92 (6.05) |
| WPL | 153.3 -> 152.7 (157.8) | 6.33 -> 6.02 (6.2) |
| BBL | 158.0 -> 157.1 (158.3) | 6.30 -> 6.31 (6.47) |
| WBBL | 143.0 -> 138.9 (141) | 6.14 -> 6.10 (6.37) |
| PSL | 168.0 -> 167.6 (169.2) | 6.47 -> 6.40 (6.47) |
| SA20 | 150.3 -> 151.1 (153.4) | 5.81 -> 5.84 (6.21) |
| Hundred (m) | 135.8 -> 135.3 (137.3) | 5.85 -> 5.85 (5.88) |
| Hundred (w) | 121.8 -> 120.1 (120.5) | 5.85 -> 5.85 (5.97) |
| CPL | 158.0 -> 156.5 (158) | 6.16 -> 6.18 (6.27) |
| ILT20 | 156.4 -> 153.4 (154.9) | 6.12 -> 6.19 (6.18) |
| MLC | 166.6 -> 163.7 (164.9) | 6.23 -> 6.17 (6.38) |
| BPL | 153.3 -> 151.4 (152.4) | 6.45 -> 6.39 (6.4) |
| LPL | 170.1 -> 166.5 (175.7) | 6.34 -> 6.36 (6.64) |

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

Real tails score and survive less than the sim's. Men's T20I numbers 10 and 11 made 4.2 / 4.3 and 2.3 / 2.9 runs / balls in the real matches against the sim's 5.3 / 5.0 and 3.9 / 3.7 before this section; women's 2.8 / 4.1 and 1.8 / 3.2 against 4.0 / 4.5 and 3.5 / 3.6. Two things were suspected: the T20 ball model's response to a batter's rating is too shallow at the bottom (rating by position 0.80 0.80 0.81 0.80 0.79 0.77 0.73 0.60 0.44 0.34 0.31: the tail is rated as the tail), and a tail-ender survives too long. A crude fix tried first (count the shortfall below 0.45 at double weight, `ODI_TAIL_WEIGHT` the other way round) helped number 10, not number 11, left survival alone and cost 1.8 runs an innings.

**The refit** (`packages/ratings/src/analysis/t20-batter-response.py`, `packages/app/src/__tests__/tail-response.test.ts`, `batter-response.ts`, `docs/data/t20_batter_response.json`). The correction is a multiplier on each outcome class of the T20 ball model, piecewise linear in the striker's batting rating `(battingOvr + timing) / 200` (knots 0.25, 0.40, 0.55, 0.70, 0.85), per gender: `p'(class) = p(class) x exp(s_class(rating))`. It acts on the rating wherever the batter bats: **there is no positional term**, so a star at number 11 bats like a star and a tail-ender who opens like a tail-ender.
- *Data.* Real: every ball since 2016 of the men's T20 leagues (IPL, BBL, PSL, SA20, CPL, ILT20, MLC, BPL, LPL, The Hundred) and since 2019 of T20Is between full members, and the women's WPL, WBBL, The Hundred and T20Is, whose striker the game rates (Cricsheet id to the game's player, on the game's own ratings and, in a T20I, the opposition adjust a national side's batters carry): 457,000 men's and 127,000 women's balls to the end of 2023, 306,000 and 93,000 from 2024. Counted by competition x phase (overs 1-6, 7-15, 16-20) x rating bin (0.05 wide) x outcome class. Simulated: the same counts from the engine as it was (the game's squads in every league, the series' sides in the T20Is, 2,000 matches a league, 2 replays of the T20I fixtures).
- *Fit.* Within a competition and phase, a rating bin's share of each class relative to the phase's overall share, real over simulated, is the response the engine is missing at that rating. It is regressed on the piecewise-linear function (weights = inverse Poisson variances, a second-difference penalty on the knots, the wide / no-ball / bye shares as the reference, pooled over competitions and phases within a gender), on balls to 2023 only. A 3 takes the 2's response. Fitted to 2023, the response left in the 2024+ cells falls 2.1% (men) and 18% (women) in squared error: the women's sim hit far too many fours and sixes at middling ratings (at the applied strength the multiplier on fours is 0.26 at rating 0.25, 0.51 at 0.55 and 1.25 at 0.85; men's 0.72, 0.85 and 1.08).
- *Neutral.* Each class gets a constant so that over the simulated balls its share of all deliveries is what it was: the response moves runs and wickets from batter to batter, it does not move a league's level, its wickets or its all-outs (the tables the engine already carries were fitted without it).

| log multiplier at rating | 0.25 | 0.40 | 0.55 | 0.70 | 0.85 |
|---|---|---|---|---|---|
| men, fours | -0.32 | -0.25 | -0.16 | -0.05 | +0.07 |
| men, sixes | -0.27 | -0.15 | -0.06 | +0.00 | +0.03 |
| men, dots | +0.16 | +0.09 | +0.02 | -0.01 | -0.02 |
| women, fours | -1.34 | -1.01 | -0.66 | -0.26 | +0.22 |
| women, sixes | -0.99 | -0.72 | -0.46 | -0.15 | +0.18 |
| women, dots | -0.17 | -0.11 | -0.07 | -0.02 | +0.03 |

**Two things the fit does not give, and what was chosen instead.**
1. *The wicket row is not applied.* Fitted on its own it moves wickets from the top of the order to the tail (+0.24 at 0.25, -0.09 at 0.85 for men), and it is what moves a tail's survival most (men's number 11 from 3.9 / 3.7 to 3.0 / 3.5 runs / balls with the wicket row at half strength, number 10 to 4.1 / 4.5). But the real tail dies at a rate that, played with the real top and middle order, bowls the sim out too often: a men's T20I first innings is all out 15-16% of the time against a real 11.5% (12.7% before), the league all-out shares rise by 2-5 points, and refitting the wickets-in-hand tables on top (`calibrate-collapses.test.ts`) cannot take them back. The real hazards by wickets down match the sim's with the row on (0.076 / 0.093 / 0.099 / 0.112 a ball at 6 to 9 down); the sim reaches 8, 9 and 10 down more often (0.36 / 0.25 / 0.15 against 0.33 / 0.20 / 0.11 of innings), which is a matter of when wickets fall, not of the tail's rating. So the tail's survival (balls) is left where it was and a row-less correction is applied: the all-out shares, wickets per innings and totals stay at their former level.
2. *The strength is a power.* At the fitted strength the cells agree but positions barely move (the real tails bat at the very end of innings, at nine down, where the phase cells do not look); the run rows are applied at a power fitted on the position table of the 2023-and-earlier / 2024+ halves and the sd of totals: **men x1.25, women x1.5**. Higher moves number 9 down with it (men x2: number 9 5.5 runs against a real 6.8) and widens the totals (sd 38-40 against 37.3 real); women's x2 widens the sd to 37.5 against 33.5 and no conditions term can narrow it.

**By batting position** (`BENCH_POSITIONS=1`, the matches the real XIs played, real batting order, runs / balls; 2024+ matches in brackets, the out-of-sample half):

| position | men real | men before | men after | women real | women before | women after |
|---|---|---|---|---|---|---|
| 8 | 8.7 / 7.0 (8.7 / 7.1) | 8.8 / 7.2 (8.9 / 7.1) | 8.5 / 7.2 (8.6 / 7.2) | 6.8 / 6.7 (7.3 / 6.8) | 7.0 / 6.9 (7.1 / 6.9) | 7.5 / 7.4 (7.6 / 7.6) |
| 9 | 6.3 / 5.7 (6.8 / 6.1) | 6.6 / 5.9 (6.7 / 6.0) | 5.9 / 5.8 (5.7 / 5.6) | 4.8 / 5.6 (4.6 / 5.2) | 5.5 / 5.7 (5.5 / 5.6) | 5.4 / 5.9 (5.4 / 5.9) |
| 10 | 4.2 / 4.3 (4.6 / 4.7) | 5.3 / 5.0 (5.0 / 4.9) | 4.3 / 4.9 (4.2 / 4.8) | 2.8 / 4.1 (2.8 / 4.2) | 4.2 / 4.4 (4.1 / 4.3) | 4.0 / 4.6 (3.8 / 4.6) |
| 11 | 2.3 / 2.9 (2.2 / 2.8) | 3.9 / 3.7 (3.9 / 3.7) | 3.2 / 3.7 (3.6 / 3.9) | 1.8 / 3.2 (2.1 / 3.6) | 3.1 / 3.4 (3.3 / 3.4) | 2.9 / 3.5 (2.8 / 3.5) |

(10 replays of every match; the real sample at number 11 is 286 men's and 141 women's innings, 145 and 67 from 2024, so a figure at number 11 carries a standard error near 0.3 runs; the sim's own noise is about 0.1.) Number 10 comes to the real runs for men (4.3 against 4.2; the out-of-sample half 4.2 against 4.6; it was 5.3 and 5.0) and number 11 loses 0.7 runs (3.9 to 3.2 against a real 2.3); the balls faced do not move (men's number 11 3.7 against a real 2.9) and **women's tails are not materially closer** (number 10 4.0 / 4.6 against a real 2.8 / 4.1, was 4.2 / 4.4). Number 9 is where the response costs: men's 6.6 / 5.9 to 5.9 / 5.8 (real 6.3 / 5.7; 6.7 to 5.7 against 6.8 in the half after 2023). What is left of the tail is the survival of number 11 and the women's runs at 10 and 11: neither is something the rating of the batter can fix (below).

**What it moved and what was refit.** Neutral in shares, so the men's tables, contexts and conditions stay as they were. The women's T20I context was refit (it is the one set whose batters sit low on the rating scale: the response shifted its level 3 runs; `CALIBRATE_T20I=1 CAL_GENDER=women CAL_ITER=8 CAL_REPLAYS=4`), its conditions term refit (`calibrate-spread.test.ts`, `CAL_T20I=1`: `lo` 0.23 / `hi` 0.46 became 0.07 / 0.035; the response supplies the spread the term had), the women's league contexts refit (`CALIBRATE_LEAGUES=1`, 8 rounds of 1,500 matches), the men's league levels held at their former means by a recentre of the first-innings factors of the wickets-in-hand table (`CAL_RECENTRE=1 CAL_TARGETS=...`, `CAL_GAIN=2`; BBL, PSL, BPL, LPL, ILT20) and the series tuning refit on the fit half (men's T20I unchanged at spread 3 / home 2, women's T20I spread 3.5 / home 4 to 1.5 / 2: the response separates sides more).

**What it did to the numbers that were already right.** First innings, 2,000-5,000 instant matches (the league contexts report; real in brackets), before -> after: men's T20I 167.2 -> 167.8 (169.5), sd 35.6 -> 37.3 (37.3), all out 12.7% -> 13.4% (11.5%); women's T20I 141.9 -> 142.0 (142.2), all out 12.8% -> 8.4% (9.2%), sd 32.9 -> 28.7 (34.6: the new series tuning, below, and the lower stretch it fits, narrows the sides; before the tuning the totals' sd was 35); the WPL 161.0 -> 161.4 (162.0), WBBL 154.8 -> 152.9 (155.0), Hundred women 126.7 -> 127.4 (126.2); the IPL 178.7 -> 180.6 (192.8, whose shape is fitted at the engine's own level); the other men's leagues within 2 runs of before (BBL 168.1 -> 167.4, PSL 180.1 -> 177.8, BPL 157.6 -> 157.6, LPL 179.3 -> 179.4, ILT20 163.4 -> 161.8, SA20 160.9 -> 159.2, CPL 172.1 -> 173.7, MLC 175.3 -> 176.3, Hundred men 146.7 -> 146.4). First-innings all-out shares move by up to 2.5 points either way (BPL 12.9% -> 10.4%, real 16.0%; WBBL 15.9% -> 17.5%, real 15.6%).

*League benchmarks* (`calibrate-leagues.test.ts`, 32 simulated seasons, runs / wickets per innings in both innings, real in brackets):

| league | runs / innings before -> after (real) | wickets / innings before -> after (real) |
|---|---|---|
| IPL | 170.4 -> 172.3 (183.7) | 5.99 -> 5.89 (6.05) |
| WPL | 153.3 -> 152.0 (157.8) | 6.33 -> 6.15 (6.20) |
| BBL | 158.0 -> 156.6 (158.3) | 6.30 -> 6.29 (6.47) |
| WBBL | 143.0 -> 139.6 (141.0) | 6.14 -> 6.13 (6.37) |
| PSL | 168.0 -> 168.3 (169.2) | 6.47 -> 6.45 (6.47) |
| SA20 | 150.3 -> 149.3 (153.4) | 5.81 -> 5.90 (6.21) |
| Hundred (m) | 135.8 -> 135.2 (137.3) | 5.85 -> 5.82 (5.88) |
| Hundred (w) | 121.8 -> 120.4 (120.5) | 5.85 -> 5.74 (5.97) |
| CPL | 158.0 -> 157.4 (158.0) | 6.16 -> 6.06 (6.27) |
| ILT20 | 156.4 -> 155.2 (154.9) | 6.12 -> 6.12 (6.18) |
| MLC | 166.6 -> 166.4 (164.9) | 6.23 -> 6.09 (6.38) |
| BPL | 153.3 -> 152.8 (152.4) | 6.45 -> 6.42 (6.40) |
| LPL | 170.1 -> 167.8 (175.7) | 6.34 -> 6.30 (6.64) |

Mean absolute error against the real innings: runs 2.84 -> 3.15, wickets 0.139 -> 0.148: the runs error is a little higher (two runs of the same engine differ by 0.2-0.3), the wickets level. The response is neutral in shares, yet 32 seasons read 0.06 wickets an innings low (the sampler's clamps and the first-innings tables read the shifted weights), so the wicket row carries +0.012 (`WICKET_OFFSET`). The seasons draw their own squads, so a league's mean moves by about 2 between two runs of the same engine (RULES-MATCH.md 12.9).

*Win prediction on the real fixtures* (`BENCH_ACTUAL=1 BENCH_REPLAYS=96 BENCH_DUMP=...`; the XIs that played, log loss per real match +- its standard error, difference paired per match, minus is better; the old engine read at 96 replays too):

| set | half (matches) | before | after | paired difference |
|---|---|---|---|---|
| men's T20I | holdout 2025+ (168) | 0.590 +- 0.027 | 0.580 +- 0.035 | **-0.010 +- 0.013** |
| | fit to 2024 (418) | 0.632 +- 0.017 | 0.636 +- 0.021 | +0.004 +- 0.007 |
| women's T20I | holdout (120) | 0.476 +- 0.043 | 0.449 +- 0.041 | **-0.027 +- 0.018** |
| | fit (315) | 0.521 +- 0.028 | 0.523 +- 0.031 | +0.003 +- 0.013 |

(The men's T20I series tuning is unchanged. The women's T20I tuning grid at the new engine: spread 1.5 / home 2 against 3.5 / 4, nll on the fit half 0.539 against 0.602; spread 2.5 would leave the holdout where it is, the fit half 0.021 worse.)

**Women's T20I holdout (section 2).** The women's holdout log loss had gone 0.462 -> 0.476 with the captain model and the bowler-type table (+0.014 +- 0.014). On the engine above it reads 0.449 (the paired difference to the old engine -0.027 +- 0.018), all of it from the batter response and the refit that goes with it, so the two things that were suspected were tested on the new engine, each against the shipped setting (48 replays, paired):

| women's T20I, switched off | holdout | fit half |
|---|---|---|
| captain model off (`CAPTAIN_MODEL.womenT20I = false`: the former rule, in both engines) | +0.032 +- 0.014 (worse) | +0.003 +- 0.010 |
| women's bowler-type table off (neutral) | -0.006 +- 0.012 | +0.001 +- 0.010 |

Neither is better on the fit half and the captain model's removal loses on the holdout, so **the captain model and the table stay for the women's T20I** (`captainModelFor(odi, womenT20I)` and `CAPTAIN_MODEL.womenT20I` are the switch if a later holdout argues otherwise; `BENCH_CAPTAIN_WOMEN=off`, `BENCH_WTYPE=neutral` reproduce the table). A women-specific refit of either was not run: the table has no measurable effect on the women's win prediction either way, and the captain model already has its own women's coefficients (`BOWLING_CHOICE`, per gender).


**ODI and Test.** Both have their own ball models (`odi-model.ts`, `test-match.ts`) and both show the same symptom at one place only: number 11 (ODI 4.8 / 7.2 against 2.9 / 4.9; Test 6.4 / 12.1 against 4.6 / 10.6; men's) while number 10 is right (ODI 6.8 / 9.9 against 6.6 / 9.1; Test 8.9 / 16.7 against 9.7 / 18.8). A batter's rating cannot do that: tens and elevens sit at the same rating (ODI 0.32 and 0.29, T20I 0.34 and 0.31). The same cell fit on the ODI (men and women, 2019+, the ODI sets) shows the opposite at the very bottom for men (the real tail hits more sixes and takes fewer singles than the model) and a large shortfall in women's scoring, which the position tables do not share, and an ODI wicket row moves the already too frequent all-outs further (51% against 41% in the benchmark). Nothing is applied to the ODI or the Test (the ODI table in `odi-batter-response-data.ts` is zero, wired so a future fit can use it). What is left is number 11 alone, a state (the last pair, nine down) rather than a rating, in all three formats.

**The last pair (nine down).** What is left of number 11 is a state, so it was fitted as one (`packages/ratings/src/analysis/last-pair.py`, `last-pair.ts`, generated `last-pair-data.ts`, `docs/data/last_pair.json`; collectors `packages/app/src/__tests__/last-pair-collect.test.ts`; tests `last-pair.test.ts`, the last-pair block of `live-parity.test.ts`).

*What real last pairs do differently* (Cricsheet ball by ball, a delivery counted by the wickets down before it; men's T20 leagues since 2016 and T20Is since 2019 between full members, The Hundred left out, ODIs since 2019, Tests since 2016):

| per ball, wides left out | T20 men 8 down | T20 men 9 down | ODI men 8 down | ODI men 9 down | Test men 8 down | Test men 9 down |
|---|---|---|---|---|---|---|
| wicket | 10.0% | 11.0% | 5.8% | 7.3% | 3.3% | 4.8% |
| runs off the bat | 1.23 | 1.02 | 0.84 | 0.78 | 0.54 | 0.58 |
| dots | 32.2% | 39.0% | 48.6% | 53.9% | 69.1% | 69.0% |
| singles | 31.7% | 28.5% | 28.7% | 22.3% | 14.8% | 12.4% |
| fours and sixes | 15.5% | 12.7% | 9.2% | 9.8% | 6.9% | 8.4% |

(The engine at nine down, before the term, in the same classes: T20 men 45.7% dots, 22.8% singles, 13.4% fours and sixes; ODI men 50.8 / 27.4 / 8.2; Test men 66.9 / 15.4 / 7.7: a singles-heavy, dot-light last pair where the real one is dot-heavy.) The two partners behave differently, and that is not a rating effect:
1. **The senior partner (the higher batting rating) farms the strike and attacks.** He refuses singles early in the over and takes one on the last ball to keep the end; the junior partner takes them early and refuses the last ball's, so the over's end hands the strike to the senior one. Singles per ball by ball of the over (1-3, 4-5, 6), men: T20 senior 23.6 / 27.5 / 35.7%, junior 31.6 / 34.0 / 19.9%; ODI senior 19.1 / 25.4 / 27.6%, junior 25.0 / 22.6 / 15.3%; Test senior 10.0 / 22.1 / 19.8%, junior 13.4 / 9.0 / 6.7%. The engine's are flat (about 30 / 30 / 30% in the T20). The senior hits 17.1% of his balls for four or six against the junior's 7.7% (ODI 12.8% against 7.0%, Test 9.7% against 6.8%) and is dismissed less often (T20 10.6% a ball against 11.7%, ODI 7.1% against 7.7%, Test 4.0% against 5.3%).
2. **So the junior partner faces about 45% of the balls**, not half: 45.1% of the rated pairs' balls in the men's T20 (47.2% women's), 45.7% in the ODI (49.1%), 43.9% in the Test. Number 11, who is nearly always the junior one, faces 37% of a stand's balls from its fourth on in the men's T20 leagues and 33% in the T20Is (2022-10 on, after the Law that gives the new batter the strike; he takes it 81% of the time after the ninth wicket, as the sim's rule does). The engine's batters split the strike evenly whatever they are: its number 11 faced 57 / 54 / 52% of a last pair's balls in the T20I, ODI and Test replays of the real XIs against 44 / 46 / 47% real, and from the fourth ball on 50% in the T20 and the ODI.
3. The strike effect is there at every gap, and the scoring effect grows with how much better the senior batter is (number 11's share of a stand's balls from its fourth on: 34% when the rating gap is 0.15 or more, 39% when it is smaller; men's T20 leagues, 2022-10 on), which is why the strike term follows `tanh(gap / 0.05)` and the scoring term `clamp(gap / 0.30)`.

*What was modelled* (`last-pair.ts`; `ballProbabilities` for the T20 and the ODI, `testBallProbs` for the Test, so the live engine plays it too; the live parity block checks both). With nine wickets down (the tenth is the last), a log multiplier on each outcome class (dot, 1, 2, 3, 4, 6, wicket; the extras are the bowler's and are left alone):

    log m(class) = a[ball of the over][class] + s1 x b[class] + s2 x c[ball of the over][class]
    s1 = clamp((striker rating - partner rating) / 0.30, -1, 1)      how much better the striker is: the pair's scoring
    s2 = tanh((striker rating - partner rating) / 0.05)              who the senior one is, by a little or a lot: the strike classes
    ball of the over: 0-2 | 3-4 | 5 legal balls already bowled; c is nonzero for dots and singles only

with the rating the one the ball model reads (`(battingOvr + timing) / 200`), so **there is no positional term**: a star at number 11 with a tail-ender partner is the senior one and bats and farms as himself, and a pair of equals shows only `a`. Fitted by multinomial regression of the real balls on the engine's own shares in each cell (competition x the striker's rating bin x phase x ball of the over x rating gap), the engine as it was (the same actual-XI matches and the leagues' own squads, `last-pair-collect.test.ts`, competitions re-weighted to the real nine-down balls) as the baseline, ridge-shrunk, the strike classes' ball-of-the-over terms shared by the sexes of a format; the men's T20I table is the league one plus a shrunk offset (the T20I context plays a different level at nine down); the men's T20 wicket level is made neutral (the pair's total hazard stays where the engine had it: a wicket row moves the all-outs, as above) and the wicket term moves the hazard between the two batters only. **Fit to the end of 2023, judged on 2024+.**

*Out of sample, per ball* (the held-out balls with nine down, log loss per ball against the engine as it was, minus is better, +- its standard error over the balls):

| set | fit-half balls | held-out balls | engine -> with the term | difference |
|---|---|---|---|---|
| T20 men, leagues | 2,818 | 2,542 | 1.7620 -> 1.7391 | **-0.0228 +- 0.0048** |
| T20I men | 809 | 1,025 | 1.7639 -> 1.7483 | **-0.0156 +- 0.0062** |
| T20I women | 374 | 443 | 1.6202 -> 1.5703 | **-0.0500 +- 0.0199** |
| Test men | 9,437 | 6,565 | 1.1639 -> 1.1554 | **-0.0085 +- 0.0027** |
| ODI men (term made neutral in shares) | 3,857 | 1,407 | 1.5207 -> 1.5048 | -0.0159 +- 0.0036 |
| ODI women | 1,889 | 1,637 | 1.4022 -> 1.4007 | -0.0015 +- 0.0029 (nothing) |

**Strength.** A power on what separates the batters and the balls of the over (not on the pair's level) was scanned at 0.5 / 1 / 1.5 / 2 / 3 times the fitted term on the position tables of both halves: the men's T20I number 11 stops improving at 1 (2024+ half: 3.5 / 3.9 off, 3.0 / 3.6 at 1, 3.0 / 3.6 at 2, 3.0 / 3.7 at 3), the ODI's and the women's likewise. **Every table is played as fitted** (`LAST_PAIR_STRENGTH` 1; `LAST_PAIR_SWITCH.scale` and `BENCH_LP_SCALE` try others).

**By batting position** (`BENCH_POSITIONS=1`, the matches the real XIs played in their real batting order, runs / balls; 2024+ matches in brackets, the out-of-sample half; 12 replays of every match; before = `BENCH_LP_OFF=t20,odi,test`, the engine as it was):

| position | men's T20I real | before | after | men's Test real | before | after |
|---|---|---|---|---|---|---|
| 8 | 8.7 / 7.0 (8.7 / 7.1) | 8.4 / 7.2 (8.5 / 7.2) | 8.5 / 7.2 (8.7 / 7.2) | 18.5 / 34.2 (18.2 / 34.0) | 18.4 / 34.5 (18.4 / 34.6) | 18.2 / 34.4 (18.6 / 34.3) |
| 9 | 6.3 / 5.7 (6.8 / 6.1) | 5.9 / 5.8 (6.0 / 5.7) | 5.9 / 5.8 (6.1 / 5.8) | 15.5 / 28.3 (15.6 / 28.8) | 14.0 / 27.3 (15.0 / 28.8) | 13.8 / 27.1 (14.6 / 27.9) |
| 10 | 4.2 / 4.3 (4.6 / 4.7) | 4.4 / 4.9 (4.2 / 4.8) | 4.4 / 4.9 (4.3 / 4.9) | 9.7 / 18.8 (9.9 / 19.1) | 9.2 / 16.9 (9.7 / 17.6) | 9.0 / 16.7 (9.6 / 17.3) |
| 11 | 2.3 / 2.9 (2.2 / 2.8) | 3.3 / 3.7 (3.5 / 4.0) | **3.0 / 3.6 (3.0 / 3.6)** | 4.6 / 10.6 (4.8 / 11.1) | 6.2 / 12.0 (6.6 / 12.5) | **4.7 / 10.2 (5.0 / 10.3)** |

Not shipped, for the record (the same tables with the term fitted for them): women's T20I number 11 2.9 / 3.5 (2.7 / 3.4) to 2.2 / 3.5 (2.1 / 3.6) against a real 1.8 / 3.2 (2.1 / 3.6), number 10 4.1 / 4.7 to 3.9 / 4.8 (real 2.8 / 4.1); men's ODI number 11 4.8 / 7.1 to 4.5 / 7.0 (real 2.9 / 4.9) with its level made neutral, 4.4 / 6.6 with its level; women's ODI 3.8 / 7.4 to 3.6 / 7.4 (real 2.8 / 6.2).

**The Test's number 11 comes to the real runs and balls on both halves** (4.7 / 10.2 against 4.6 / 10.6; 2024+ 5.0 / 10.3 against 4.8 / 11.1; it was 6.2 / 12.0 and 6.6 / 12.5), with number 10 and the rest where they were. **The men's T20I number 11 loses 0.3-0.5 runs and 0.1-0.4 balls and stays 0.7 runs and 0.7 balls above the real one** (3.0 / 3.6 against 2.3 / 2.9; 2024+ 3.0 / 3.6 against 2.2 / 2.8): a third of the gap in runs and an eighth of the balls over all matches, half of each on 2024+. What is left is not the last pair's own behaviour but *when it forms*: a men's T20 league first innings reaches nine down in the engine on average at over 16.8 against a real 17.6 (41% of the engine's last pairs start from the 19th over against a real 56%), so the engine's number 11 has about 0.8 of an over more to face. The same is true of the leagues (their last pairs are 7.0-8.3 balls long against a real 5.2-6.9 even with the term). That is a matter of when wickets fall (the engine reaches 8, 9 and 10 down more often: above), not of the last pair, and a fix would have to move earlier wickets (the 12.9 / 12.10 tables), which was not what was asked. The strength scan above shows no more is to be had from a stronger term.

**What it did to the last wicket's partnership, the all-out shares and the innings totals** (instant engine, the real XIs' matches replayed 16 times in the internationals and 2,500 matches a league on the game's squads; real: leagues since 2021, T20Is since 2019, Tests since 2023; first innings; before -> after):

| set | last wicket: balls, runs, ends in the 10th wicket (real) | before | after | first-innings all out (real) | first-innings runs (real) |
|---|---|---|---|---|---|
| IPL | 6.4, 6.95, 60.7% | 6.6, 7.74, 68.9% | 7.0, 7.93, 67.3% | 9.5% -> 9.4% (7.6%) | 180.8 -> 180.7 (181.3) |
| BBL | 6.3, 7.04, 70.1% | 7.7, 8.04, 70.0% | 7.8, 7.31, 71.2% | 13.1% -> 13.4% (10.9%) | 167.8 -> 167.6 (163.5) |
| PSL | 6.4, 6.56, 76.3% | 7.4, 8.08, 69.7% | 7.7, 7.79, 69.1% | 16.6% -> 16.7% (11.4%) | 177.6 -> 177.5 (179.7) |
| SA20 | 5.2, 5.43, 69.8% | 7.5, 7.65, 73.6% | 7.8, 7.32, 73.3% | 16.2% -> 16.5% (14.4%) | 160.4 -> 160.3 (162.4) |
| CPL | 6.9, 8.28, 75.0% | 7.4, 8.88, 71.3% | 8.3, 9.32, 70.2% | 15.5% -> 14.7% (11.8%) | 172.0 -> 172.1 (164.6) |
| ILT20 | 6.0, 6.33, 68.8% | 7.2, 6.68, 68.8% | 7.6, 6.92, 66.2% | 12.0% -> 11.2% (10.4%) | 162.3 -> 162.3 (161.1) |
| MLC | 6.0, 7.04, 76.0% | 7.5, 8.86, 73.2% | 7.8, 8.55, 72.4% | 18.6% -> 18.2% (17.9%) | 176.3 -> 176.1 (171.5) |
| BPL | 6.1, 6.73, 65.3% | 7.3, 7.06, 70.1% | 7.5, 7.01, 68.7% | 12.0% -> 11.6% (14.9%) | 157.5 -> 157.6 (159.2) |
| LPL | 5.7, 6.00, 69.5% | 7.1, 7.92, 74.6% | 7.6, 7.85, 73.6% | 16.8% -> 16.8% (12.8%) | 179.0 -> 179.0 (166.3) |
| T20I men | 6.7, 7.93, 73.4% | 6.1, 6.57, 71.3% | 6.2, 6.95, 70.4% | 9.3% -> 9.1% (10.8%) | 165.8 -> 165.9 (165.4) |
| Test men | 20.7, 12.93, 97.6% | 22.1, 13.65, 96.9% | 20.2, 11.99, 97.5% | 85.6% -> 86.4% (86.1%) | 319.9 -> 318.3 (320.6) |

The last wicket's runs come closer to real in six of the nine men's leagues (BBL 8.04 -> 7.31 against 7.04, PSL 8.08 -> 7.79 against 6.56, SA20 7.65 -> 7.32 against 5.43, MLC, BPL, LPL a little) and move away in three (IPL 7.74 -> 7.93 against 6.95, CPL, ILT20: 0.2-0.4 runs); its length does not come closer (a league's stand is 0.1-0.9 of a ball longer, for the timing above) and the T20I's 6.1 -> 6.2 balls and 6.57 -> 6.95 runs go toward the real 6.7 and 7.93. **The all-out shares do not move away from real**: a league's first-innings all-out share moves by -0.8 to +0.3 points (mean absolute error against the real shares 2.7 -> 2.6 points over the nine leagues), the T20I's 9.3% -> 9.1% (real 10.8%), the Test's 85.6% -> 86.4% (86.1%); first-innings runs stay within 0.2 runs and wickets an innings within 0.02 in the leagues, within 0.1 runs in the T20Is, 1.6 in the Test. This was the thing the first attempt broke (a flat wicket offset, as at the start of this section, pushed the men's T20I first-innings all-out share to 15-16%): the men's T20 wicket level is made neutral on the real balls and then calibrated on the leagues' own all-out shares (`LP_WICKET`: -0.10; at 0 the nine leagues rose by 0.4 points on average).

*League benchmarks* (`calibrate-leagues.test.ts`, 32 simulated seasons; runs / wickets per innings, real in brackets; the Hundred, which has no term, moves with the seasons' own squad draws, 1-1.5 runs):

| league | runs / innings before -> after (real) | wickets / innings before -> after (real) |
|---|---|---|
| IPL | 172.2 -> 170.9 (183.7) | 5.95 -> 5.94 (6.05) |
| WPL | 152.0 -> 152.1 (157.8) | 6.12 -> 6.10 (6.20) |
| BBL | 155.1 -> 156.7 (158.3) | 6.30 -> 6.33 (6.47) |
| WBBL | 138.0 -> 138.1 (141.0) | 6.04 -> 6.07 (6.37) |
| PSL | 170.2 -> 167.0 (169.2) | 6.52 -> 6.42 (6.47) |
| SA20 | 146.9 -> 151.6 (153.4) | 5.88 -> 5.91 (6.21) |
| Hundred (m) | 136.9 -> 135.3 (137.3) | 5.88 -> 5.88 (5.88) |
| Hundred (w) | 119.5 -> 120.1 (120.5) | 5.83 -> 5.85 (5.97) |
| CPL | 157.0 -> 157.2 (158.0) | 6.00 -> 6.00 (6.27) |
| ILT20 | 152.9 -> 153.7 (154.9) | 6.16 -> 6.18 (6.18) |
| MLC | 163.5 -> 163.7 (164.9) | 6.32 -> 6.27 (6.38) |
| BPL | 151.2 -> 152.0 (152.4) | 6.42 -> 6.36 (6.40) |
| LPL | 166.7 -> 165.8 (175.7) | 6.54 -> 6.50 (6.64) |

Mean absolute error against the real innings: runs 3.62 -> 3.30, wickets 0.128 -> 0.129 (two runs of the same engine differ by 1-1.5 runs a league: the PSL's -3.2 and the SA20's +4.7 are the largest moves, both toward the real level, and the women's leagues, which have no term, moved by 0.1).

*Win prediction on the real fixtures* (`BENCH_ACTUAL=1 BENCH_MODES=actual BENCH_REPLAYS=96`, 256 for the Tests; the XIs that played, log loss per real match +- its standard error, difference paired per match, minus is better; before = `BENCH_LP_OFF=t20,odi,test`):

| set | half (matches) | before | after | paired difference |
|---|---|---|---|---|
| men's T20I | holdout 2025+ (168) | 0.580 +- 0.035 | 0.583 +- 0.035 | +0.002 +- 0.002 |
| | fit to 2024 (418) | 0.636 +- 0.021 | 0.638 +- 0.021 | +0.002 +- 0.002 |
| men's Test | holdout 2025+ (58) | 0.571 +- 0.077 | 0.553 +- 0.071 | **-0.018 +- 0.013** |
| | fit to 2024 (75) | 0.568 +- 0.078 | 0.556 +- 0.077 | -0.012 +- 0.009 |

(The men's T20I is within noise of before on both halves, so it is not worse and not better at match level, the term acting on the last two wickets; the Test improves on both. **Not shipped, their holdouts:** women's T20I with the term +0.003 +- 0.002 on 2025+ (120 matches; fit half -0.001 +- 0.002), men's ODI with its level made neutral +0.001 +- 0.006 (109; fit half +0.002 +- 0.003) and +0.013 +- 0.009 with its level as fitted (fit half -0.004 +- 0.004), women's ODI with the term -0.003 +- 0.005 (103; fit half +0.000 +- 0.004): none of the three improves out of sample, so they stay off (`SHIPPED` in `last-pair.py`; the tables are in `docs/data/last_pair.json`, `"shipped": false`).)

**Live v instant** (`LIVE_PARITY=1`, the last-pair block of `live-parity.test.ts`): @@PARITY@@

## Refitting

- Bowling choice: `BENCH_TACTICS=1 BENCH_EXPORT=train.json npx vitest run packages/app/src/__tests__/tactics-allocation.test.ts`, then `python3 packages/ratings/src/analysis/bowling-choice.py train.json` (needs numpy and scipy).
  `BENCH_TACTICS=1 [BENCH_REPLAYS=2] [BENCH_ONLY=...]` prints the allocation tables above (real against the sim).
- Bowler type: `python3 -I packages/ratings/src/analysis/t20-bowler-type.py --types 2 --write` (about 15 minutes; `--holdout` for the out-of-sample score, `--types 5|7` for finer types).
- Ball age: `python3 -I packages/ratings/src/analysis/ball-age.py test|odi|odi-age|t20`.
- Batter response (section 5): `python3 -I packages/ratings/src/analysis/t20-batter-response.py real real.json` (the real counts; needs numpy and the `duckdb` CLI); the simulated counts **from the engine with a zero table** (`BENCH_NO_RESPONSE=1` does not apply to this collector: zero `batter-response-data.ts` first) with
  `TAIL_COLLECT=1 TAIL_OUT=sim.json npx vitest run packages/app/src/__tests__/tail-response.test.ts` (split with `TAIL_ONLY=` and pass several files to `fit`); then `python3 -I packages/ratings/src/analysis/t20-batter-response.py fit real.json sim.json[,more.json] --write`
  (it adds its step to `docs/data/t20_batter_response.json` if that exists: delete it to fit from nothing). The powers are `RESPONSE_POWER` / `WICKET_POWER` in the script; `BENCH_BR_FILE=table.json` (the json `BR_DUMP=` writes) plays another table in the benchmarks without a rebuild.
- After any of these the ODI calibration (`benchmark-odi.ts CALIBRATE=1`, with `ODI_TUNE` to try values; it is fitted on the ODI's former allocation) and the series tuning (`BENCH_FIT=1 BENCH_FIT_ON=actual BENCH_HOLDOUT=fit`) move: refit them, with 32+ replays and the whole grid in view (the minimum of a flat grid, not the smallest value within 0.01 of it), then judge the change **per match on the holdout with a paired standard error** (`BENCH_DUMP=<prefix>` writes the per-match replay counts; `BENCH_CAL_FILE` / `BENCH_TUNING_FILE` replace the ODI calibration / the series tuning from a json file to compare settings without a rebuild).
