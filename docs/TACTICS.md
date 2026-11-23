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

**Status.** The captain model below is the default for every T20 innings (T20I and the leagues; in the men's leagues but the IPL it chooses from the whole eleven with its own table, section 8). The **ODI does not use it by default**: it predicted the 2025+ ODIs worse than the former rule (section 2, "Regression on the real fixtures"), so the ODI keeps
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

**Live v instant** (`LIVE_PARITY=1`, the last-pair block of `live-parity.test.ts`): the IPL, 1,500 matches each way, innings that reached nine down: instant 622 stands of 7.23 balls and 8.21 runs, the tenth wicket 66.2%, the weaker partner 47.4% of the balls; live CPU 596 stands of 6.64 balls and 6.83 runs, 66.8%, 52.1%. Without the term (`PARITY_LP_OFF=1`): instant 6.65 / 7.83 / 69.6% / 52.2%, live 6.31 / 6.99 / 68.6% / 57.3%. The live engine's CPU sides give the weaker batters about 5 points more of the strike than the instant engine's with or without the term (its cause was not chased: it is there before this change), and the term moves both by the same amount (-4.8 and -5.2 points): the two engines read it alike. The rest of the live-v-instant table (`LIVE_PARITY=1 PARITY_MATCHES=300`, five leagues) is as before.

## 6. When wickets fall: the innings clock (wicket row shipped for the men's leagues with the league XIs of section 7)

(The women's T20I has its own wicket-row clock since docs/COUNTRY-VALIDATION.md, "Women's T20I tails": fitted the same way on women's T20Is to 2024, neutral in shares, with the context refitted after it.)

Section 5 left this open: a men's T20 league first innings in the engine reaches nine down too early, so its last pair has too long to bat, and the engine reaches 8, 9 and 10 down more often than real. The diagnosis and a fitted term follow (`packages/ratings/src/analysis/t20-wicket-timing.py`; engine `innings-clock.ts`, data `innings-clock-data.ts`; candidate tables `docs/data/t20_innings_clock.json`). **On the former XIs the term was not shipped**: it fixes when wickets fall and is much better ball by ball out of sample, but it moved the leagues' all-out shares away from real (for a reason that is not the ball model: below) and does not improve the actual-XI match benchmark. **With the league XIs of section 7 its wicket row ships for the men's leagues** (not the T20I): the end of this section.

*What real does and what the engine did* (Cricsheet, first innings of full matches of the nine men's leagues since 2021 against 3,000 engine matches a league on the game's squads, `last-pair-collect.test.ts` with `LP_LEAGUES=1 LP_MIN_WK=0`; per ball, wides out):

| over | 1 | 2-6 | 7-10 | 11-15 | 16 | 17 | 18 | 19 | 20 |
|---|---|---|---|---|---|---|---|---|---|
| real wicket rate | 3.3% | 4.3-4.8% | 3.7-4.5% | 4.4-5.3% | 6.0% | 6.9% | 7.6% | 9.5% | 14.1% |
| engine | 4.3% | 4.7-5.1% | 4.9-5.1% | 5.3-5.5% | 7.4% | 7.3% | 7.2% | 7.6% | 7.6% |
| **engine now** (league XIs, the clock's wicket row, levels refit: the end of this section) | 3.7% | 4.4-4.9% | 3.5-4.5% | 4.7-5.8% | 6.1% | 6.8% | 7.9% | 10.2% | 13.5% |
| real runs off the bat a ball | 0.95 | 1.17-1.37 | 1.15-1.22 | 1.27-1.40 | 1.48 | 1.50 | 1.61 | 1.72 | 1.83 |
| engine | 1.41 | 1.58-1.70 | 1.11-1.15 | 1.11-1.18 | 1.49 | 1.45 | 1.39 | 1.50 | 1.47 |

The engine's T20 innings has no clock beyond its three phases: `PHASE_MULTIPLIERS` (match.ts) steps at over 7 and over 16 and is flat in between, and the wickets-in-hand table (RULES-MATCH.md 12.9) is normalised within its over bands, so nothing makes the last two overs different from the 16th. Real sides swing at nearly everything in the 19th and 20th overs (a wicket every 7 to 10 balls) and are safer than the engine's through the middle overs; the engine spreads the same number of wickets evenly. The striker's rating does not explain it: the real rise from the first band to the last is about 2.5 times for the best batters (rating 0.75+: 4.1% to 10.5%) and for the tail (under 0.35: 6.5% to 15.6%) alike, where the engine's is 1.4 and 1.1 times. Outside the IPL (which has its own scoring context) the engine's powerplay is also far too fast (1.68 runs a ball against 1.42 in 2024+) and its middle overs too slow (1.11 against 1.25), its sixes in the wrong phase.

**The second cause: the game's league XIs bat less deep than real ones.** In first innings that reached nine down, the batters ranked by rating (best to worst) in the real XIs and in the engine's (`Team.autoSelectPlayingXI` on the game's squads):

| rank | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| real | 0.86 | 0.84 | 0.81 | 0.78 | 0.75 | 0.71 | 0.67 | 0.58 | 0.46 | 0.32 |
| engine | 0.86 | 0.84 | 0.82 | 0.78 | 0.74 | 0.67 | 0.55 | 0.46 | 0.37 | 0.30 |

The engine's sixth to ninth batters are 0.04-0.12 weaker (the XI is built bowling core first). Its strikers with eight and nine down are rated 0.38 and 0.32 against a real 0.49-0.52 and 0.44-0.47. The league all-out shares therefore depend on the squads as much as on the ball model, which is why the T20I (the real XIs, `LP_COLLECT`) is the cleaner test below.

*What was modelled.* A log multiplier per over (1-20) and outcome class (dot, 1, 2, 3, 4, 6, wicket; a 3 takes the 2's term; wides, no-balls and byes are the reference), per competition, in a men's T20 first innings (`applyInningsClock` in `ballProbabilities`, after the wickets-in-hand table, so the live engine plays it too; not The Hundred, a chase or a super over). Fitted by multinomial regression of the real balls on the engine's own shares in each cell (competition x over x wickets down 0-1 / 2-3 / 4-5 / 6-7 / 8-9 x the striker's rating bin x his balls faced 0-2 / 3-9 / 10-19 / 20+), so the situation and the batter are held fixed and the term is the clock alone: a pooled league term plus a shrunk offset per competition (the IPL and the T20I have their own contexts, so their engine baselines differ), a ridge on both and a penalty on second differences across overs inside each engine phase (none across the phase boundaries, where the engine steps). Then made neutral in shares: each class keeps its share over the engine's own first-innings balls, so a league's level of runs and wickets stays where `LEAGUE_LEVELS` put it and only *when* they come moves. **Fit to the end of 2023 (from 2019), judged on 2024+.** The ridge and smoothing strengths were chosen on 2023 with the fit to 2022 (the loss is flat over a 100-fold range). A wicket-only version (the wicket row alone, the run classes left to the engine) was fitted the same way.

The fitted wicket multipliers (per league, after neutralising): over 1 0.74-0.97, overs 7-15 0.9-1.17, overs 16-18 0.82-1.03, over 20 1.0-1.34 (the T20I 0.71 in over 1, 1.1-1.23 in the middle overs, 0.84-0.93 in 16-18), with the dots of the last three overs cut to 0.7 / 0.55 / 0.3 (so every other class of the 20th over rises); sixes 0.4-0.7 in the powerplay and 1.3-1.5 in the middle overs outside the IPL. The wicket-only version: 0.8-0.9 in the first six overs, 0.7-1.1 in the middle, 0.8 / 0.9 / 1.1 in overs 16-18 and 1.3-1.6 / 1.8-2.4 in the last two.

*Out of sample, per ball* (first-innings balls of rated strikers, log loss against the engine as it was, minus is better, +- its standard error over the balls):

| set | fit-half balls | held-out balls (2024+) | full term | wicket row only |
|---|---|---|---|---|
| men's leagues pooled | 140,174 | 116,078 | **-0.0250 +- 0.0007** | **-0.0015 +- 0.0002** |
| IPL | 36,724 | 26,074 | -0.0036 +- 0.0009 | -0.0016 +- 0.0004 |
| BBL / PSL / CPL / BPL | 17-33k each | 12-15k each | -0.029 to -0.038 (+- 0.002) | -0.0013 to -0.0020 |
| men's T20I | 39,579 | 31,519 | -0.0037 +- 0.0007 | -0.0016 +- 0.0003 |

*The innings shape* (first innings; real since 2021; engine 3,000 matches a league on the game's squads, the T20I the real XIs' matches replayed 8 times; all out / the ninth wicket's mean over, 0-based with the ball, 18.5 = halfway through the 19th / the share of ninth wickets in the last two overs / runs):

| set | real | engine | full term | wicket row only |
|---|---|---|---|---|
| IPL | 7.7% / 18.40 / 74% / 182.4 | 9.5% / 17.69 / 59% / 180.4 | 11.5% / 18.44 / 78% / 184.9 | 10.0% / 18.42 / 78% / 184.8 |
| BBL | 11.3% / 18.64 / 83% / 165.7 | 13.8% / 17.12 / 49% / 167.6 | 16.6% / 18.23 / 72% / 174.9 | 14.8% / 18.23 / 71% / 174.0 |
| PSL | 11.6% / 18.50 / 73% / 180.2 | 16.9% / 17.11 / 49% / 177.3 | 18.9% / 18.09 / 69% / 185.0 | 17.3% / 18.05 / 69% / 183.5 |
| SA20 | 15.3% / 17.71 / 71% / 166.5 | 17.1% / 16.76 / 40% / 160.2 | 18.0% / 17.70 / 61% / 163.4 | 17.3% / 17.70 / 58% / 162.4 |
| CPL | 12.1% / 17.98 / 68% / 166.1 | 15.1% / 16.79 / 42% / 172.2 | 17.7% / 17.82 / 60% / 175.2 | 16.9% / 17.71 / 61% / 174.7 |
| ILT20 | 10.6% / 18.31 / 70% / 162.4 | 11.1% / 17.53 / 56% / 162.5 | 12.9% / 18.23 / 73% / 166.9 | 11.6% / 18.13 / 69% / 166.4 |
| MLC | 18.4% / 18.35 / 72% / 173.1 | 18.7% / 16.60 / 38% / 176.0 | 20.4% / 17.84 / 63% / 179.7 | 19.5% / 17.77 / 63% / 178.6 |
| BPL | 14.9% / 18.16 / 75% / 159.2 | 11.9% / 17.46 / 52% / 157.5 | 15.0% / 17.87 / 67% / 161.1 | 12.6% / 18.05 / 69% / 159.1 |
| LPL | 13.5% / 18.39 / 77% / 167.3 | 17.2% / 17.03 / 45% / 178.5 | 19.3% / 17.92 / 66% / 183.8 | 16.0% / 17.97 / 67% / 183.8 |
| all-out error, nine leagues | | 2.42 points | 3.88 points | 2.79 points |
| **T20I men (real XIs)** | 12.7% / 18.42 / 78% / 169.7 | 8.6% / 17.83 / 63% / 166.3 | **10.7% / 18.31 / 75% / 167.6** | 10.3% / 18.28 / 75% / 168.1 |

When the ninth wicket falls comes to real in every set (the engine's was 0.7-1.8 overs early). With the real XIs the all-out share moves toward real too (8.6% to 10.7% against 12.7%), and wickets per innings (6.03 to 6.15 against 6.72). In the leagues the all-out shares move *away* by 1-3 points with the full term (0.4-1 with the wicket row): with the hazard now where real puts it, the game's thinner tails (above) fall at a real tail's rate in the last overs with less batting behind them. The leagues' all-out shares had been near real partly because the engine's wickets came early and spread out. A stronger last-pair wicket offset brings them back (`LP_WICKET`: -0.5 more gives a 1.89-point error), but only by making the engine's nine-down pair survive the last two overs at 9.5% a ball against a real 13.1% while being 0.12 weaker: a compensation for the squads, not a fit, so it was not taken.

*League benchmarks* (`calibrate-leagues.test.ts`, 32 seasons, both innings; full term with that last-pair offset, runs / wickets per innings, real in brackets): IPL 172.4 -> 175.2 (183.7), LPL 166.0 -> 170.4 (175.7), BBL 156.9 -> 161.7 (158.3), PSL 167.3 -> 172.8 (169.2), MLC 163.8 -> 169.3 (164.9), BPL 150.5 -> 155.4 (152.4), CPL 155.6 -> 159.4 (158.0), ILT20 154.0 -> 157.5 (154.9), SA20 150.1 -> 150.5 (153.4); runs error over the nine 3.77 -> 3.90, wickets 6.00 -> 6.10 on average (closer in seven). Fewer early wickets means better batters bat longer: every league gains 4-5 runs an innings, which helps the IPL and LPL and overshoots the rest (a level refit would follow a shipped term).

*Win prediction on the real fixtures* (`BENCH_ACTUAL=1 BENCH_MODES=actual BENCH_ONLY=t20i-men`; men's T20I, log loss per real match +- its standard error, paired difference, minus is better; before = `WT_OFF=1`):

| version | half (matches) | before | with the term | paired difference |
|---|---|---|---|---|
| full term, 256 replays | holdout 2025+ (168) | 0.574 +- 0.034 | 0.576 +- 0.033 | +0.002 +- 0.006 |
| | fit to 2024 (418) | 0.633 +- 0.020 | 0.635 +- 0.020 | +0.003 +- 0.004 |
| wicket row only, 256 replays | holdout 2025+ (168) | 0.574 +- 0.034 | 0.577 +- 0.033 | +0.003 +- 0.006 |
| | fit to 2024 (418) | 0.633 +- 0.020 | 0.633 +- 0.021 | +0.001 +- 0.004 |
| full term, 96 replays | holdout 2025+ (168) | 0.583 +- 0.035 | 0.599 +- 0.035 | +0.016 +- 0.009 |
| | fit to 2024 (418) | 0.638 +- 0.021 | 0.637 +- 0.020 | -0.001 +- 0.006 |

(At 96 replays the full term's holdout read 1.7 standard errors worse; at 256 it is within noise on both halves, as is the wicket row. Neither improves either half. The bat-first side's win share in the replays moved from 51.2% to 51.9%: the chase is untouched.)

**First verdict (on the former XIs): not shipped.** Neither version improved the actual-XI match benchmark, and both moved the leagues' all-out shares away from real. What would let it ship: league XIs as deep as real ones. Section 7 makes them so; the term was then refitted and scored again on top.

**Re-scored with the league XIs (section 7): the wicket row ships for the men's leagues.** The clock was refitted against the engine with the fitted league XIs (`t20-wicket-timing.py fit --wicket-only` and the full term, on 3,000 engine matches a league; `docs/data/t20_innings_clock.json` "wicket_only_league_xi", "full_league_xi"), fit to the end of 2023, judged on 2024+: per ball, pooled over the leagues, the wicket row -0.0017 +- 0.0002 (fit -0.0023), the full term -0.0243 +- 0.0007. Because the term is neutral in shares, a league's wickets and runs an innings move with it (fewer early wickets: longer innings); the league levels (`LEAGUE_LEVELS`, the IPL excepted) were refitted on top each time, to the real 2024-26 runs and wickets an innings (two Newton steps on a response pooled over the leagues, 16 then 32 simulated seasons). First innings, real since 2021 / the engine (3,000 matches a league, `LP_LEAGUES=1 LP_MIN_WK=0`): all out / the ninth wicket's mean over / the share of ninth wickets in the last two overs:

| set | real | engine before | league XIs, levels as they were | league XIs, levels refit | **league XIs + clock wicket row, levels refit (shipped)** | league XIs + full clock, levels as they were |
|---|---|---|---|---|---|---|
| IPL | 7.7% / 18.40 / 74% | 9.5% / 17.69 / 59% | 7.9% / 17.82 / 60% | 7.9% / 17.82 / 60% | **8.2% / 18.47 / 77%** | 9.5% / 18.50 / 79% |
| BBL | 11.3% / 18.64 / 83% | 13.8% / 17.12 / 49% | 12.0% / 17.16 / 48% | 14.9% / 17.05 / 47% | **14.0% / 18.18 / 71%** | 13.3% / 18.36 / 72% |
| PSL | 11.6% / 18.50 / 73% | 16.9% / 17.11 / 49% | 14.2% / 17.24 / 49% | 16.9% / 16.94 / 44% | **15.3% / 17.91 / 65%** | 16.9% / 18.05 / 68% |
| SA20 | 15.3% / 17.71 / 71% | 17.1% / 16.76 / 40% | 14.5% / 16.59 / 38% | 21.5% / 16.39 / 35% | **20.2% / 17.45 / 54%** | 16.2% / 17.60 / 57% |
| CPL | 12.1% / 17.98 / 68% | 15.1% / 16.79 / 42% | 12.9% / 16.77 / 40% | 20.8% / 16.49 / 37% | **18.3% / 17.72 / 59%** | 15.0% / 17.95 / 65% |
| ILT20 | 10.6% / 18.31 / 70% | 11.1% / 17.53 / 56% | 10.7% / 17.25 / 52% | 13.1% / 17.15 / 49% | **11.0% / 18.06 / 70%** | 12.4% / 18.13 / 70% |
| MLC | 18.4% / 18.35 / 72% | 18.7% / 16.60 / 38% | 17.1% / 16.49 / 36% | 20.2% / 16.48 / 37% | **20.5% / 17.49 / 58%** | 19.0% / 17.87 / 63% |
| BPL | 14.9% / 18.16 / 75% | 11.9% / 17.46 / 52% | 11.4% / 17.27 / 48% | 11.5% / 17.27 / 50% | **11.5% / 18.01 / 70%** | 13.2% / 17.99 / 66% |
| LPL | 13.5% / 18.39 / 77% | 17.2% / 17.03 / 45% | 13.4% / 17.02 / 42% | 19.4% / 16.84 / 42% | **15.9% / 18.02 / 68%** | 15.8% / 18.10 / 69% |
| all-out error, nine leagues | | 2.42 points | **1.13** | 4.15 | **2.92** | 2.13 |

The deeper XIs alone bring the all-out shares close to real (2.42 to 1.13 points) but leave the leagues 0.24 wickets an innings short of real (`calibrate-leagues.test.ts`, below): the former levels' wicket factors (0.84-0.90) had been set with the thin tails. Refitting the levels for the wickets without the clock puts them back up (0.86-0.95) and the all-outs go to 4.15 points: the engine's extra wickets come through the innings and the ninth still falls 1.3 overs early, so tails are bowled out. With the clock's wicket row the same refit lands the wickets late, as real ones do: against the XIs with refit levels the all-out error falls from 4.15 to 2.92 points (32 seasons: 3.51 to 2.76) and the ninth wicket comes to real (16.4-17.8 overs to 17.5-18.5; real 17.7-18.6), runs and wickets an innings unchanged or better, so by this file's rule the term earns its place on top of the league XIs. The full term (runs by the over too) fixes the same timing, but at the same levels its all-outs were further from real than the wicket row's (2.13 points against 1.28) and it was not taken. (Both add 3-7 runs a first innings at the former levels: fewer early wickets; the refit takes them back.)

*League benchmarks* (`CALIBRATE_LEAGUES=1 CAL_SEASONS=32`, whole seasons with rain, both innings; real 2024-26; the first-innings all-out share against the real 2021+ share above; before = origin/main, after = shipped):

| league | runs / innings: real, before, after | wickets / innings: real, before, after | first-innings all out: real, before, after |
|---|---|---|---|
| IPL | 183.7, 171.9, **176.6** | 6.05, 5.95, **5.94** | 7.7%, 9.2%, **8.0%** |
| BBL | 158.3, 156.5, **161.1** | 6.47, 6.30, **6.44** | 11.3%, 13.4%, **14.9%** |
| PSL | 169.2, 167.3, **169.7** | 6.47, 6.41, **6.49** | 11.6%, 16.5%, **15.2%** |
| SA20 | 153.4, 148.7, **151.3** | 6.21, 5.96, **6.08** | 15.3%, 14.2%, **16.6%** |
| CPL | 158.0, 158.2, **159.7** | 6.27, 6.10, **6.35** | 12.1%, 15.6%, **19.6%** |
| ILT20 | 154.9, 153.2, **156.4** | 6.18, 6.11, **6.15** | 10.6%, 10.4%, **9.2%** |
| MLC | 164.9, 165.2, **166.6** | 6.38, 6.30, **6.37** | 18.4%, 19.3%, **20.2%** |
| BPL | 152.4, 151.1, **152.9** | 6.40, 6.37, **6.25** | 14.9%, 13.4%, **11.6%** |
| LPL | 175.7, 165.0, **177.4** | 6.64, 6.34, **6.48** | 13.5%, 15.7%, **15.5%** |
| mean absolute error, nine | 3.82 -> **2.18** | 0.137 -> **0.080** | 1.99 -> **2.76** points |

**What does not improve: the leagues' all-out error against the engine before both changes** (2.42 to 2.92 points on the 3,000-match collector, 1.99 to 2.76 on the 32 seasons: 1.3-1.8 standard errors of the difference, mostly CPL, SA20 and MLC). Everything else moves toward real: runs and wickets an innings, the depth of the XIs (section 7), when the wickets fall, the IPL's all-out share (9.5% to 8.2%, real 7.7%). The men's T20I has no clock table (its candidate did not improve the actual-XI benchmark, above), so the T20I plays exactly as before (every simulated ball of the actual-XI replays is identical: `LP_COLLECT`, the same csv hash with and without both changes). Second innings were not fitted: the chase has the same flat phases (the engine's middle overs too dangerous, its powerplay too fast outside the IPL) but a required-rate state that the cells would have to carry.

## 7. League XIs: how the CPU picks a franchise XI

Section 6 found the game's league XIs batting less deep than real ones: `Team.autoSelectPlayingXI` locks in a keeper and the five best bowlers by bowling overall, then fills by overall, so its sixth to ninth batters were 0.04-0.12 weaker than a real side's and its XIs carried 6.7 bowling options (bowling overall 60+) against a real 5.1. The realistic line-ups of the T20I (`realistic-xi.ts`) cannot be reused here: they sample real players by their real selection rates, which a career-mode squad (traded, aged, generated players) does not have. What carries over is the approach (a fitted distribution of XIs, sampled per match); what is fitted is how franchises trade batting depth against bowling.

**Data** (`packages/ratings/src/pipeline/generate-league-xi.ts` -> `docs/data/league_xi.json`): every match of the nine men's leagues since 2021 (1,822), each side's players from the Cricsheet json in the order of the batting card, the overs each bowled, and with an impact player (IPL since 2023, ILT20 since 2023/24, LPL 2026) the one of the twelve who was not in the side while it batted. Players are keyed to the game's pool (`espn_` / `ca_`, the CricketArchive senior and tier-0 shards; 254 of 40,942 places unmatched) and rated with the game's own ratings. A real squad is the union of a franchise's XIs over its season; a player is available for a match between his first and last XI of that season (late arrivals and early departures for national duty are out of the choice). `packages/app/src/__tests__/league-xi.test.ts` (`LXI_OUT=xi.json`) builds the players and the CPU's picks from the same squads.

**The model** (`packages/ratings/src/analysis/league-xi.py`, engine `xi-selection.ts`). The value of an XI is rank-weighted: U = sum_k a_k * (the XI's k-th best batting overall) + sum_j c_j * (its j-th best bowling overall) + f * (the eleven's fielding worth, `fieldingValueBonus`) + g * (the best designated keeper's keeping worth), ratings / 100, fatigue-adjusted. Fitted by conditional logit: each real XI against every legal XI one swap away from the players available that day (the same overseas limit, a designated keeper if the real XI had one), 1,579 XIs to the end of 2024 (choices with fewer than twelve available left out), judged on 1,034 from 2025 on; a penalty on second differences across ranks (strength chosen by fitting to 2023 and scoring 2024; flat across a 300-fold range, the smallest taken) and a small ridge. Held-out log likelihood per XI -2.90 against -3.08 for a uniform choice among the same alternatives (most one-swap alternatives are near-equivalent fringe swaps; what matters for the game is the composition, below).

| rank | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| batting weight a_k | 4.80 | 4.43 | 4.27 | 4.39 | 4.29 | 4.12 | 2.64 | 0.89 | 0.12 | 0.11 | 0.80 |
| bowling weight c_j | 6.39 | 5.68 | 4.50 | 3.03 | 1.74 | 0.50 | -0.11 | | | | |

(fielding 4.19, keeping 1.56.) Real franchises value six batters fully, a seventh at 60% and an eighth at 20%, and five bowlers with steeply falling weights and a sixth barely: the seventh batting place weighs more than the fifth bowling place (2.64 against 1.74). The engine's selection was the opposite (five bowlers first, at any batting cost).

**How the CPU uses it.** The single most likely XI bats deeper than real sides do (an argmax picks the extremes of what real franchises do only sometimes: rotation, form, matchups and rating error all spread real choices), so a CPU side in a men's T20 league **draws** its XI for each match from P(XI) proportional to exp(U) over the legal XIs (Metropolis over single swaps from the most likely XI, 400 steps, seeded by the match and the side: the same XI instant and live, `matchXiOptions`). The user's own auto-pick (the Lineup page's Auto Select, and a user side that picked nothing) is the most likely XI, never drawn. Internationals, ODIs, The Hundred and the women's leagues keep the former selection (not fitted here; the T20I's realistic line-ups are unchanged). `LEAGUE_XI_SWITCH.off` (`LXI_OFF=1` in the benchmarks) plays the former selection everywhere.

*Batting rating by rank in the XI* ((battingOvr + timing) / 200, best to worst; bowling options = bowling overall 60+):

| XIs | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | bowling options |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| real squads, held out 2025+ (1,034): **real XIs** | 0.86 | 0.84 | 0.81 | 0.79 | 0.75 | 0.71 | 0.64 | 0.54 | 0.42 | 0.33 | 0.24 | 5.13 |
| the CPU before, same available players | 0.86 | 0.84 | 0.82 | 0.79 | 0.75 | 0.70 | 0.60 | 0.48 | 0.39 | 0.31 | 0.23 | 5.99 |
| the most likely XI | 0.87 | 0.84 | 0.82 | 0.79 | 0.76 | 0.73 | 0.68 | 0.56 | 0.44 | 0.36 | 0.27 | 5.25 |
| **drawn (shipped)** | 0.86 | 0.84 | 0.81 | 0.78 | 0.75 | 0.70 | 0.62 | 0.51 | 0.41 | 0.32 | 0.24 | 5.27 |
| the game's squads (nine leagues): **real XIs of the squads' season** (544) | 0.86 | 0.83 | 0.81 | 0.78 | 0.75 | 0.70 | 0.63 | 0.53 | 0.42 | 0.34 | 0.25 | 5.12 |
| the CPU before | 0.86 | 0.84 | 0.82 | 0.78 | 0.74 | 0.68 | 0.55 | 0.45 | 0.38 | 0.31 | 0.22 | 6.66 |
| the most likely XI (the user's auto-pick) | 0.86 | 0.84 | 0.82 | 0.80 | 0.77 | 0.75 | 0.70 | 0.60 | 0.47 | 0.40 | 0.30 | 5.31 |
| **drawn (shipped)** | 0.86 | 0.83 | 0.80 | 0.77 | 0.73 | 0.68 | 0.61 | 0.52 | 0.43 | 0.34 | 0.25 | 5.18 |
| first innings that reached nine down: real (2021+) | 0.86 | 0.83 | 0.81 | 0.78 | 0.75 | 0.71 | 0.66 | 0.58 | 0.47 | 0.35 | 0.25 | |
| engine before | 0.86 | 0.84 | 0.82 | 0.78 | 0.74 | 0.67 | 0.55 | 0.46 | 0.38 | 0.30 | 0.23 | |
| **engine now** | 0.86 | 0.83 | 0.80 | 0.77 | 0.73 | 0.68 | 0.61 | 0.52 | 0.43 | 0.34 | 0.26 | |

(The game's squads as the app loads them, CricketArchive records for players without a Cricinfo profile (`prepareLeaguePool`); per league the drawn XI's seventh and eighth batters are within 0.07 of the real XIs' (0.03 on average over the nine), the former CPU's up to 0.16 weaker (0.08 on average). The most likely XI's overlap with the real XI of the day, held out: 9.37 players of 11, the former CPU 9.25, a draw 9.14. Nine-down innings are a selection of the weaker XIs, real and engine alike.) The overseas players in an XI are left to the value and the league's limit, as before.

*Bowling* (the leagues' innings of 19+ overs since 2024, real; the engine 1,000 matches a league on the game's squads, `LXI_SIM=1`; part-timer overs = overs by bowlers rated under 50 with the ball):

| | bowlers used | 6+ bowlers | 7+ bowlers | part-timer overs an innings | XIs with fewer than 5 bowlers rated 60+ |
|---|---|---|---|---|---|
| real | 6.04 | 85% | 18% | 2.23 | 27% (held out) |
| engine before | 6.63 | 93% | 50% | 0.02 | 0% |
| **engine now** | 5.74 | 55% | 16% | 1.37 | 29% |

No side is ever short of overs: an XI with four front-line bowlers bowls its part-timers (`autoBowlingOrder`), as about a quarter of real XIs do. What the change leaves: real captains use a sixth bowler for an over or two in 85% of innings, the engine now in 55% (before, its XIs carried two extra bowlers and used seven in half its innings). Who joins the attack was `autoBowlingOrder`'s rule (bowlers and all-rounders, part-timers only when short), not a fitted choice; the captain model of section 1 chose within the attack. Section 8 fits it (the men's leagues but the IPL: 6.00 bowlers, 80% six or more, 19% seven or more, 2.51 part-timer overs).

Saves: nothing new is stored (the XI is chosen at match time); old saves load and their CPU sides pick the new way. Tests: `packages/engine/src/__tests__/xi-selection.test.ts`.

## 8. The bowling attack: who bowls, and when a sixth or seventh bowler comes on (shipped for the men's leagues; the IPL since section 9)

Section 7 left the attack's size to a hand rule: the captain model of section 1 chose each over among `Team.autoBowlingOrder` (bowlers and all-rounders, part-timers only when short of five), because it had been fitted over the bowlers who did bowl in each real innings (the attack known in advance). On the game's squads that bowled 5.74 bowlers an innings against a real 6.04, a sixth in 55% of innings (real 85%) and 1.37 overs an innings by part-timers (bowlers rated under 50; real 2.23).

**The fit** (`packages/ratings/src/analysis/bowling-attack.py`, generated `packages/engine/src/bowling-attack-data.ts`, report `docs/data/bowling_attack.json`; data `docs/data/bowling_overs.json` from `packages/ratings/src/pipeline/generate-bowling-overs.ts`). The same conditional logit as section 1, one over at a time, but its choice set is **every player of the eleven** who may bowl the over (keepers apart, as the rank is; the cap and the no-two-in-a-row rule), so the model also decides who joins the attack. On top of section 1's features (rank, type by phase and over, overs used, the gap since his last over, the slack of the front-line overs, the death pace reserve) it reads: the lower ranks (6th, 7th, 8th+) and, for a bowler outside the best five or a batter who bowls, his bowling rating (bins at 30 / 40 / 50 / 60), the wickets the attack has taken, the run rate so far and whether it is the chase; for a bowler not yet on, how many bowlers have bowled (he would be the 5th or earlier / 6th / 7th / 8th, by phase); for one who has, the runs off his last over (0-6 / 7-10 / 11-14 / 15+), his runs an over so far and his wickets. Data: every over of the nine men's leagues since 2021 (Cricsheet, the players keyed and rated as in section 7) and the men's T20Is of `actual_xi.json` (rated as the engine plays them), one table for the leagues and one for the T20I, ridge chosen by fitting to 2023 and scoring 2024, **fitted to the end of 2024, judged on 2025+**.

*Played forward, the per-over fit uses too many bowlers.* It is calibrated on the real histories (its predicted sixth-bowler entries on the fit half 1,649 against 1,650 real), but played forward on the same elevens its choices compound: a real captain plans his twenty overs, the model chooses one at a time, and brought on a sixth bowler in 93% and a seventh in 34% of the fit half's innings (real 81% and 18%). So three offsets (the sixth bowler's entry, the seventh's and later, a bowler rated under 50) were fitted by moment matching on the fit half (each real eleven played forward twice, the overs' runs and wickets drawn from the real overs of that index, so the forward play needs no ball model), to the fit half's real share of innings with six and seven bowlers and its part-timer overs. Then judged on 2025+:

| | held out: choices | log likelihood per choice (2025+) | bowlers used / 6+ / 7+ / part-timer overs, the 2025+ elevens played forward |
|---|---|---|---|
| leagues, real | 22,885 | | 6.05 / 86% / 18% / 2.37 |
| fitted, calibrated (shipped) | | **-1.436** | **6.05 / 84% / 20% / 2.34** |
| fitted, before the calibration | | -1.423 | 6.32 / 94% / 34% / 2.75 |
| section 1's features alone, refitted over the eleven | | -1.492 | |
| section 1's model as shipped, over the eleven | | -1.810 | |
| uniform | | -2.135 | |
| men's T20I, real | 5,996 | | 5.96 / 81% / 15% / 0.50 |
| fitted, calibrated | | **-1.344** | 5.94 / 79% / 14% / 0.70 |
| section 1's features alone, refitted over the eleven / as shipped / uniform | | -1.397 / -1.702 / -2.086 | |

(The calibration costs 0.013 a choice of likelihood and is what makes the shape right; the attack terms gain 0.06 a choice over section 1's features refitted on the same choice sets, 0.37 over section 1's model as it was.)

**In the engine** (`attackTableFor`, `attackFeatures`, `attackTally` in `bowling-choice.ts`; `simulateInnings` in match.ts and `pickNextBowler` in live-match.ts). A men's full-length T20 innings of a CPU side, or of a user side that has not set its own bowling order, chooses each over from the eleven by the table: the rest of the eleven join the side's order as candidates (the impact-player decision still reads the side's own order). The user's controls keep working as before: a bowling order the user set is the attack (the table chooses within it, as section 1's model did), a bowling plan narrows the choice first (fixed overs, the phase lists), the caps and the consecutive-over rule always hold. The live engine plays it for its CPU sides (the user picks his own bowlers there). The Hundred, a rain-cut innings, the women, the ODI and the Test are untouched.

*The game's squads* (`LXI_SIM=1`, 1,000 matches a league, innings of 19+ overs, part-timer = bowling rating under 50; real = the leagues' innings since 2024):

| | bowlers used | 6+ bowlers | 7+ bowlers | part-timer overs an innings |
|---|---|---|---|---|
| nine leagues: real | 6.04 | 85% | 18% | 2.23 |
| before | 5.77 | 57% | 17% | 1.47 |
| **now** (the IPL as before) | **6.00** | **80%** | **19%** | **2.51** |
| eight leagues (no IPL): real | 6.06 | 86% | 19% | 2.48 |
| before | 5.72 | 54% | 16% | 1.60 |
| **now** | **5.98** | **80%** | **18%** | **2.78** |
| IPL: real (since 2024) | 5.99 | 83% | 15% | 1.42 |
| IPL as before (kept) | 6.14 | 82% | 26% | 0.52 |
| IPL with the table (not shipped) | 6.35 | 92% | 39% | 2.13 |

Per league (now): BBL 5.99 / 81% / 18% / 3.18 (real 6.08 / 90% / 17% / 3.06), PSL 6.01 / 81% / 19% / 2.34 (6.01 / 84% / 17% / 1.88), SA20 5.92 / 77% / 15% / 2.42 (5.94 / 79% / 14% / 2.13), CPL 6.00 / 79% / 19% / 4.00 (6.04 / 87% / 16% / 3.68), ILT20 6.00 / 82% / 18% / 1.86 (6.15 / 87% / 25% / 1.45), MLC 6.00 / 81% / 19% / 2.91 (6.05 / 83% / 21% / 3.21), BPL 5.96 / 79% / 16% / 2.85 (6.06 / 86% / 18% / 2.40), LPL 6.00 / 80% / 19% / 2.71 (6.29 / 93% / 32% / 1.88). Part-timers bowl 0.3 overs an innings more than real on these squads (the calibration matched them on the real elevens).

**Why not the IPL.** The IPL's real sides bowl with twelve to choose from: the impact player comes on at the break, so a side's bowling eleven has a sixth front-line bowler (rated 61 on average, against the engine's 53; its seventh 49 against 39). The engine's IPL sides bring their impact player on mid-innings at best (`evaluateBowlingImpact`: over 13+, or earlier when the run rate is high; 21% of bowling innings) and bowl with the eleven they picked, so with the table they used seven bowlers in 39% of innings against a real 15% (12% bowling first, 23% second), the IPL's extras went 9.3 to 9.6 an innings (real 8.9) and its wickets 5.95 to 5.82 (real 6.05; its runs 176 to 180, real 184). That is the engine's impact-player timing, not the attack, so the IPL keeps the former attack (`ATTACK_MODEL.except`) until the impact player comes on as real sides use him. **Section 9 does that, and the IPL now plays the table.**

**Why not the T20I.** Its own table fixes the T20I's shape (`tactics-allocation.test.ts`, `BENCH_ATTACK=t20i`, 4 replays: overs by the sixth and seventh most used bowler 1.10 / 0.14 against a real 1.13 / 0.15, before 1.28 / 0.34) but does not improve the actual-XI match benchmark (`BENCH_ACTUAL=1 BENCH_MODES=actual BENCH_REPLAYS=256 BENCH_ATTACK=t20i`, per-match log loss, paired, minus is better): holdout 2025+ (168 matches) 0.576 -> 0.578, **+0.002 +- 0.006**; fit to 2024 (418) 0.635 -> 0.638, **+0.003 +- 0.004**. Both within noise but neither better, and the mechanism is the one of section 2: the best-rated bowler bowls less (3.31 overs against 3.41 before and a real 3.60), which narrows the sides. So the T20I is off (`ATTACK_MODEL.t20i`; its table is in the file). The men's T20I benchmark plays exactly as before.

*League benchmarks* (`CALIBRATE_LEAGUES=1 CAL_SEASONS=64`, both innings; real 2024-26; first-innings all out against the real 2021+ share of section 6). More part-timers mean more runs and fewer wickets (+2 runs, -0.08 wickets an innings on the former levels), so the eight leagues' `LEAGUE_LEVELS` were refitted to the same targets (a common correction from the response pooled over the leagues, then one Newton step per league at 64 seasons; wicket factors up 0.025-0.055, dot factors -0.024 to +0.037; the IPL has no levels):

| league | runs / innings: real, before, after | wickets / innings: real, before, after | first-innings all out: real, before, after |
|---|---|---|---|
| IPL (unchanged) | 183.7, 176.3, 176.4 | 6.05, 5.95, 6.00 | 7.7%, 8.4%, 9.1% |
| BBL | 158.3, 159.9, **158.9** | 6.47, 6.39, **6.47** | 11.3%, 13.7%, 13.9% |
| PSL | 169.2, 169.7, **169.1** | 6.47, 6.43, 6.43 | 11.6%, 14.9%, 14.7% |
| SA20 | 153.4, 152.7, **153.1** | 6.21, 6.13, **6.27** | 15.3%, 18.4%, 19.4% |
| CPL | 158.0, 159.4, **158.1** | 6.27, 6.25, 6.23 | 12.1%, 19.8%, **18.7%** |
| ILT20 | 154.9, 155.2, **154.8** | 6.18, 6.14, **6.21** | 10.6%, 11.2%, 10.8% |
| MLC | 164.9, 166.4, **165.9** | 6.38, 6.33, **6.45** | 18.4%, 18.0%, 20.5% |
| BPL | 152.4, 153.4, **152.4** | 6.40, 6.28, **6.43** | 14.9%, 11.5%, 11.7% |
| LPL | 175.7, 177.5, **174.7** | 6.64, 6.48, **6.58** | 13.5%, 16.3%, 16.9% |
| mean absolute error, nine | 1.80 -> **1.17** | 0.077 -> **0.042** | 2.71 -> 2.97 points |

(Two 64-season runs of the same engine differ by about 1 run and 1 point of all-out in a league, 0.2-0.3 points in the all-out error: the IPL, unchanged, read 8.4% and 9.1%.) Runs and wickets an innings come closer to real; the all-out error is level within that noise (a second 64-season run of the shipped engine read 2.78), so **section 6's open problem (the leagues' all-out error, mostly CPL, SA20 and MLC) is not fixed by the attack**. Extras an innings on the game's squads are unchanged (8.54 -> 8.54, all leagues; the IPL, unchanged, 9.3 against a real 8.9): a part-timer bowls 0.07 more wides and no-balls an over than a front-line bowler in the engine, as in the real record (0.34 against 0.27 an over, bowlers rated under 50 against 70+, the leagues since 2024), and the level refit took the small rise back.

*Match prediction.* There is no actual-XI benchmark for the leagues (career squads are not the real ones), so the out-of-sample case for the leagues is the held-out choice likelihood and the 2025+ shape above, plus the T20I's own test of the same mechanism, which costs nothing measurable (+0.002 +- 0.006, +0.003 +- 0.004) and is not shipped there. The T20I, the ODI and the Test play exactly as before.

**Live v instant.** The two engines draw the same attack: PSL, 1,500 matches each, innings of 19+ overs, instant / live CPU: bowlers used 6.00 / 6.01, seven or more 19% / 18%, part-timer overs 2.88 / 2.88, runs an over 9.00 / 9.04 (with the former attack 5.72 / 5.72 bowlers and 8.89 / 8.96 runs an over, 400 matches). The live-v-instant table (`LIVE_PARITY=1 PARITY_MATCHES=600 PARITY_ONLY=bbl,psl`, runs / wickets an innings, instant / live CPU): BBL 161.8 / 162.1 and 6.76 / 6.73, PSL 168.9 / 173.3 and 6.48 / 6.55 (`PARITY_ATTACK_OFF=1`: BBL 159.2 / 159.5, PSL 169.2 / 169.7; the PSL gap of 600 matches is noise: 0.04 an over at 1,500).

Switches: `ATTACK_MODEL` (`league`, `t20i`, `except`); `ATTACK_OFF=1` in `calibrate-leagues.test.ts`, `LXI_ATTACK_OFF=1` in the `LXI_SIM` collector, `BENCH_ATTACK=off|t20i` in `benchmark-countries.test.ts` (and `t20i` in `tactics-allocation.test.ts`). Tests: `packages/app/src/__tests__/bowling-attack.test.ts`. Saves: nothing new is stored.

## 9. The Impact Player: when and for whom IPL sides use him (shipped; the IPL joins the bowling attack of section 8; its level refitted in section 10)

Section 8 kept the IPL on the former attack because of its impact player: the engine brought him on mid-innings at best (`evaluateBowlingImpact`: over 13+, or earlier when the run rate was high; in 21% of bowling innings), and gave each side a sub in each innings by hand rules, so its IPL sides bowled with the eleven they had picked. Real sides use him to field a different eleven from the one that bats. This section measures how (Cricsheet, every IPL match since 2023, the Impact Player era), fits the CPU's decision to it, and ships it with the IPL on the attack table.

**Data** (`packages/ratings/src/pipeline/generate-impact-player.ts` -> `docs/data/impact_player.json`): 293 matches (2023-26), each side's twelve in batting-card order with what each did, and the substitution as Cricsheet records it (`replacements.match`, reason `impact_player`, on the delivery before which he comes on; six concussion substitutes left out). Cricsheet does not record the five named substitutes, only the one who came on. Rated with the game's own ratings (`IMP_OUT=rows.json npx vitest run packages/app/src/__tests__/impact-player.test.ts`, the season squad that day as the bench, as in section 7).

*What real sides do* (293 matches; X = the player of the batting eleven who does not field, Y = the one who fields but does not bat for the side):

| side | share | when (where Cricsheet records it) | X (out of the field) | Y (comes on) |
|---|---|---|---|---|
| batting first: a bowler on at the break for a batter who batted | 74% (216) | start of the second innings 163, when he first bowls later in it 53 | batter 81 (bowling 35), batted 2nd on average, 19 balls | bowler 73 (batting 33) |
| batting first: a batter in at a wicket for a batter who is out | 25% (73) | at 6+ down in 52, mean 5.8 down, over 14 (0-based) | batter 82, out already | batting all-rounder 67 (bowling 52), bats 7th-8th, bowls 1.3 overs |
| batting first: no sub | 1% (4) | | | |
| fielding first: a bowler fields, then a batter bats in his place | 91% (266) | during the first innings once the bowler's overs are done 84, at the start of the chase 73, at a wicket in the chase (when the batter walks in) 109 | batter 81 (bowling 34), bats 2nd-3rd | bowler 76 (batting 25), bowled 3.5 overs |
| fielding first: no sub | 9% (27) | | | |

So the batter-for-bowler swap is the rule in both halves, made at the break (batting first) or before the match (fielding first, the sub's timing in the chase only marks when the batter walks in). The only decision taken during play is the mid-innings batter of a side batting first, which comes after a late collapse. The bowling eleven that results has a sixth bowler rated 63.0 and a seventh 49.4 (fit half; 59.9 / 48.6 held out), against 52 / 40 for the eleven that bats.

**The model** (`packages/ratings/src/analysis/impact-player.py`, generated `packages/engine/src/impact-player-data.ts`, report `docs/data/impact_player_fit.json`; engine `impact-player.ts`). The engine's XI is the eleven that bats (section 7). Each side draws a plan once per match (seeded by the match, so the instant and live engines play the same subs):
- **X**, the batter who does not field: conditional logit over the batting eleven (keepers apart) on batting, bowling and fielding rating, overseas, batting place, with a fielding-first interaction. Weights: batting +4.9, bowling -5.8, fielding -5.8 (a top-order batter who neither bowls nor fields well; fielding first, batting counts 2.3 less).
- **Y**, the bowler who comes on: the best bowler on the bench (ties: the weaker batter) within the overseas limit, as the former engine chose him. A fitted Y choice is not identified: the bench of a real side that day (the season squad, the five named subs are not recorded) offers 2.45 options on average, and on them a logit puts no weight on bowling at all (it separates by batting), which on a game squad of 20 would bring on any non-batter. On the real benches the best-bowler rule picks the real Y 68% of the time held out (a rule by the bowling value of the eleven, section 7's weights, 63%).
- **The mid-innings batter** (batting first only): a hazard at each first-innings wicket (logistic on wickets down 5 / 6 / 7+ and over 12 / 15 / 17+: +3.8 at six down, -1.8 from over 15), the batter drawn from the bench by a logit on batting (and bowling, overseas; the eleven's overseas limit holds), and X drawn among the batters who are out by the X weights. He bats next and stays in the side for the second innings.
- No sub: 1.4% of sides batting first, 9.0% fielding first (fit half shares).

*Out of sample* (fit to the end of 2024, judged on 2025+, per choice):

| choice | held-out choices | log likelihood: fitted / uniform | top-1 hit: fitted / the former engine's rule |
|---|---|---|---|
| X (from 9.5 on average) | 241 | **-1.544** / -2.246 | **33.6%** / 28.2% (the weakest bowler) |
| Y (best bowler; from 2.45) | 242 | | 67.8% |
| mid-innings batter (from 3.05) | 38 | -0.931 / -1.003 | 60.5% |
| mid-innings hazard, per wicket | 829 wickets (38 subs) | **-0.156** / -0.186 (a constant rate) | |

The bowling eleven's sixth / seventh bowler with X and Y drawn from the model on the real twelves and benches: held out 60.2 / 48.4 (real 59.9 / 48.6), fit half 63.2 / 49.4 (real 63.0 / 49.4).

**In the engine.** Instant (`simulateMatch`): once the toss is known the side fielding first takes the field with Y for X, and X bats in the chase in Y's place (`impactSubs` records him when he first comes to the crease); the side batting first is asked at each wicket of its innings (`InningsExtra.impactBat`, in `arrive`) whether its bench batter comes in now, and otherwise fields from the break with Y for X. Both sides of an instant match play the plan, as both used the former subs. Live (`createMatchState`, the toss decision, `afterWicket`, `startSecondInnings`): the CPU sides play the same plan (`_internal.impactPlans`, `impactPending`); their five named subs hold the players the plan may bring on. The user's own side is untouched: the Impact Sub button, the bench batter offered at a wicket and the innings-break modal work as before (a sub made at the break now leaves the match at the break, where it used to resume play: a fix). The IPL now plays the attack table of section 8 (`ATTACK_MODEL.except` is empty). `IMPACT_MODEL.off` plays the former subs (`IMPACT_OFF=1` in the collectors, `ATTACK_EXCEPT=ipl` for the former attack).

*The IPL in play* (`IMP_SIM=1 IMP_MATCHES=4000`, the game's IPL squads, innings of 19+ overs for the bowling columns; real: the IPL since 2024 for the bowling and extras, since 2023 for the subs):

| | bowlers used | 6+ bowlers | 7+ bowlers | part-timer overs (rated under 50) | extras an innings | batting first: break / mid-innings / none | fielding first: sub / none | bowling eleven's 6th / 7th bowler | Y's bowling / X's batting |
|---|---|---|---|---|---|---|---|---|---|
| real | 5.99 | 83% | 15% | 1.42 | 8.9 | 74% / 25% / 1% | 91% / 9% | 63.0 / 49.4 (2023-24), 59.9 / 48.6 (2025+) | 73-76 / 81 |
| engine before | 6.15 | 82% | 27% | 0.52 | 9.35 | a sub in each innings by the hand rules (both sides, both innings) | | 53 / 39 (section 8) | |
| the former subs with the attack table (section 8, not shipped) | 6.32 | 91% | 37% | 2.10 | 9.57 | | | | |
| the fitted subs, former attack | 6.24 | 80% | 36% | 0.45 | 9.37 | | | | |
| **shipped** (fitted subs, attack table, IPL wicket level) | **6.05** | **83%** | **20%** | **1.44** | **9.36** | **71% / 27% / 2%** | **92% / 8%** | **63.6 / 49.9** | 78 / 81 |

The attack alone made the IPL use seven bowlers in 37% of innings and its extras rise (9.35 to 9.57); with the fitted subs the bowling eleven has its sixth front-line bowler and the shape comes to real except the seventh bowler (20% against 15%, before 27%), with extras unchanged (9.35 to 9.36; real 8.9, a gap from before). (The impact subs alone, on the former attack, fix the bowling eleven but not the attack: the former order-based attack still brings on a seventh in 36%.)

*League level* (`CALIBRATE_LEAGUES=1 CAL_SEASONS=64 CAL_ONLY=none`, whole IPL seasons, both innings; real 2024-26): the change took the IPL's wickets an innings from 6.01 to 5.88 (real 6.05; the extra bowling depth), so the IPL got a wicket level of its own (`LEAGUE_LEVELS.ipl`, wicket 1.05, from 32-season runs at 1.03 and 1.06 and two 64-season checks; its neutral grounds keep no profile, as before). The IPL's run level did not move its runs (1.04 and 1.07 read the same within noise), so the runs were left. (It was not the phase context: two bugs in how the level reached the ball, fixed in section 10, where the level is refitted.)

| IPL | runs / innings | wickets / innings | first-innings all out |
|---|---|---|---|
| real | 183.7 | 6.05 | 7.7% (2021+) |
| before (origin/main) | 176.5 | 6.01 | 8.9% |
| the change, former level | 177.7 | 5.88 | 7.5% |
| **shipped** (wicket level 1.05; two runs) | **175.8 / 175.7** | **6.08 / 6.06** | **9.7% / 9.7%** |

(Two 64-season runs of one engine differ by about 1 run and 1 point of all-out, section 8.) Wickets come to real, runs and the all-out share stay within that noise of before (the IPL's 8-run gap and its all-out share are as they were).

*Live v instant* (`LIVE_PARITY=1 PARITY_MATCHES=1000 PARITY_ONLY=ipl`, before the wicket level; runs / wickets / extras an innings / all out): instant 180.7 / 6.09 / 9.3 / 13.9%, live CPU 181.2 / 5.97 / 9.5 / 12.7%, live with a user side 182.4 / 5.90 / 9.5 / 12.1%.

**Match prediction: the IPL actual-XI benchmark** (`IPL_BENCH=1 IPL_REPLAYS=1024 IPL_ARMS=old,new`, in `impact-player.test.ts`; the leagues had no match-level benchmark). Every decided IPL match since 2023 replayed with the players who really played: each side's eleven that batted, in the real batting order, with the twelfth (the impact player, or the man he replaced) as its only bench player, so each engine decides when and for whom to use him; the real home side (neutral when neither is at home); the engine's toss; the same seeds in every arm. Log loss per match of the real winner, p = (wins + 1) / (replays + 2) clamped to [0.03, 0.97]; paired difference against the engine before (the former subs, the former attack and level), minus is better:

| arm | fit half 2023-24 (144 matches) | paired | holdout 2025+ (144 matches) | paired |
|---|---|---|---|---|
| a coin (p = 0.5) | 0.6931 | | 0.6931 | |
| **1,024 replays** | | | | |
| before: the former subs, the former attack, the former wicket level | 0.7143 +- 0.0140 | | 0.7045 +- 0.0135 | |
| **shipped**: the fitted subs, the attack table, the IPL wicket level | 0.7123 +- 0.0120 | **-0.0019 +- 0.0051** | 0.7039 +- 0.0137 | **-0.0005 +- 0.0038** |
| **256 replays** (before the wicket level; the arms apart) | | | | |
| before | 0.7046 +- 0.0143 | | 0.7069 +- 0.0139 | |
| the fitted subs + the attack table | 0.7053 | +0.0007 +- 0.0067 | 0.7028 | -0.0041 +- 0.0073 |
| the fitted subs, the former attack | 0.7041 | -0.0005 +- 0.0070 | 0.7084 | +0.0015 +- 0.0066 |
| the former subs + the attack table (section 8's rejected IPL) | 0.6995 | -0.0052 +- 0.0069 | 0.7067 | -0.0002 +- 0.0069 |

(Bat-first win share of the replays 0.505 / 0.499 on the fit half, 0.512 / 0.506 held out, before / shipped; runs an innings 175.5 / 175.1 and 178.8 / 178.2. The paired standard error at 1,024 replays is 0.004-0.005, under the 0.006 aimed for; at 256 the replays' own noise was most of it.)

**Verdict: shipped.** Out of sample the fitted choices beat the former rules and uniform (X, the hazard), the bowling eleven and the IPL's allocation shape come to real on the 2025+ elevens and the game's squads, the league level is refitted for wickets, and the new match benchmark does not get worse on either half (-0.0019 +- 0.0051 fitted, -0.0005 +- 0.0038 held out: level, a shade better on both). What it cannot show: an IPL match is close to a coin flip for the engine with the real twelves (0.704-0.714 per match against a coin's 0.693, before and after alike: the engine's IPL predictions are more spread than real IPL results, on the fit half and the holdout), so the benchmark has little power to see a change of this size either way.

Saves: a live match saved before this change has no plans in its state, so its CPU sides use no sub (the user's side as before); nothing else is stored. Tests: `packages/engine/src/__tests__/impact-player.test.ts`.


## 10. IPL match prediction and the IPL's run level (the run level shipped; no separation term)

Section 9 left two findings: the engine has no skill on IPL matches with the real twelves (0.7123 fit half 2023-24, 0.7039 holdout 2025+, a coin 0.6931), and the IPL's run level did not move its runs (1.04 and 1.07 read the same), leaving the IPL about 8 runs an innings short. The first is diagnosed here (no term ships: the data does not support one that keeps the game a game, below); the second was two bugs, both fixed, and the IPL's level is refitted on 2024 and judged on 2025+.

### 10.1 Why the engine has no skill on IPL matches

**Calibration** (the IPL actual-XI benchmark of section 9 at 256 replays, `IPL_DUMP`; p = the engine's probability for the side it favours, observed = how often that side won):

| favourite's p | fit 2023-24: matches / mean p / observed | holdout 2025+: matches / mean p / observed |
|---|---|---|
| 0.50-0.55 | 70 / 0.522 / 0.400 | 61 / 0.525 / 0.328 |
| 0.55-0.60 | 52 / 0.570 / 0.481 | 47 / 0.574 / 0.574 |
| 0.60-0.65 | 17 / 0.626 / 0.706 | 27 / 0.615 / 0.444 |
| 0.65+ | 5 / 0.687 / 0.200 | 9 / 0.679 / 0.667 |
| log loss (coin 0.6931) | 0.7094 | 0.7082 |
| slope of the real result on the engine's logit (1 = calibrated, 0 = no skill) | -0.25 | -0.03 |

The engine is not spreading its IPL predictions wide: they sit at 0.50-0.65 (mean distance from a coin 0.06, sd of the logit 0.30-0.34, a quarter of it the replays' own noise). What fails is the ordering: the real result does not follow it at all (slopes -0.25 and -0.03), so any separation costs log loss. Shrinking the engine's logit by a factor k: 0.7094 / 0.7082 at k = 1, 0.6986 / 0.6972 at 0.5, 0.6952 / 0.6943 at 0.25, the coin at 0. The best k fitted on the fit half is 0.

**The ratings against the results, without the engine** (every match since 2021 of the league benchmark below, the eleven that batted for each side, logistic regression of the result on the difference in the XIs' mean overall (or in their overseas and domestic players' means together), with the home side; per rating point, +- its standard error; the engine's slope is that of its logit on the same difference):

| league (matches 2021+) | XI mean overall | overseas players' mean | domestic players' mean | the engine's own slope per point (fit / holdout) |
|---|---|---|---|---|
| IPL (418) | **+0.018 +- 0.037** | -0.042 +- 0.023 | +0.061 +- 0.033 | 0.080 / 0.067 |
| PSL (191) | +0.158 +- 0.058 | +0.095 +- 0.034 | +0.072 +- 0.046 | 0.104 / 0.071 |
| BBL (269) | +0.124 +- 0.040 | -0.018 +- 0.022 | +0.116 +- 0.033 | 0.111 / 0.102 |

The difference between two real IPL elevens (sd 2.7 points of mean overall, as in the PSL) does not predict the result: +0.018 +- 0.037 a point, where the PSL and BBL show 0.12-0.16 and the engine plays 0.07-0.11 in all three. The engine treats the IPL as it treats the other leagues; the IPL's results do not follow the ratings. Candidates checked:
- *Look-ahead* (the game's ratings are today's, applied to 2021-24 matches): with point-in-time ratings (each player's real T20 batting and bowling of the years up to the one before the match, `rating-history.json`) the slope is -0.009 +- 0.021 on the fit half and +0.020 +- 0.035 held out (the game's ratings +0.010 / -0.024): not the cause.
- *Domestic against overseas players*: in the IPL the overseas players' ratings point the wrong way (-0.042 +- 0.023) and the Indian players' the right way (+0.061 +- 0.033); the BBL shows the same pattern (overseas -0.018, domestic +0.116), the PSL does not (+0.095 / +0.072). Every side fields four overseas players, so this is a difference between overseas players, not their level against Indian ones; at 2 standard errors in one league it is a lead for the ratings, not a term.
- *Home advantage*: the real IPL home side won 0.496 (fit, 129 matches) and 0.444 (holdout, 117); the engine gives it 0.498. Nothing to fit.
- *Toss and dew*: the side batting first won 0.521 of 2023-24 matches and 0.431 of 2025+; the engine's replays 0.499 and 0.506. The halves disagree; the engine sits between them.
- *The IPL's phase context and level terms* move every side alike and cannot reorder two sides.

**No league has a series tuning**: `SERIES_TUNING` ({spread, home}) is applied to T20I, ODI and Test series only (`series-tuning.ts`); league matches play the ratings as they are. Below, k is the factor on the engine's logit fitted on the fit half (the post-hoc equivalent of a spread: at these gaps the engine's logit is linear in the rating gap), so the competitions' own separations can be compared.

**The league actual-XI benchmark** (new, `LEAGUE_BENCH=1` in `league-bench.test.ts`; data `docs/data/league_xi.json` + `docs/data/league_results.json` from `generate-league-results.ts`): every decided match since 2021 of seven men's leagues replayed with the elevens that batted, the IPL's twelfth on the bench, the real home side where the ground is one of a side's home grounds (else neutral), the league's rules; 128 replays, log loss per match:

| league | fit to 2024 / holdout 2025+ (matches) | engine: fit / holdout | k fitted on the fit half | holdout at that k | home side won, real fit / holdout (engine) |
|---|---|---|---|---|---|
| IPL | 276 / 142 | 0.7100 / 0.6948 | 0.00 | 0.6931 | 0.496 / 0.444 (0.498) |
| PSL | 116 / 75 | **0.6645 / 0.6675** | 1.31 | 0.6661 | 0.549 / 0.586 (0.515) |
| BBL | 205 / 64 | **0.6854 / 0.6778** | 0.65 | 0.6746 | 0.608 / 0.571 (0.509) |
| SA20 | 59 / 57 | 0.7117 / 0.7223 | 0.00 | 0.6931 | 0.574 / 0.571 (0.499) |
| CPL | 119 / 61 | 0.7077 / 0.7148 | 0.05 | 0.6927 | 0.513 / 0.618 (0.486) |
| ILT20 | 44 / 66 | 0.6318 / 0.7057 | 1.84 | 0.7439 | (home grounds shared) |
| MLC | 36 / 41 | 0.6684 / 0.7082 | 1.08 | 0.7112 | (mostly neutral) |

(Matches are left out where a player is not in the pool, the result was by D/L or a franchise is not the game's: 3-26 a half. The IPL rows here run from 2021 with 128 replays; section 9's benchmark, from 2023 at 1,024, is the gate.)

So the engine has skill in the PSL and the BBL (where, as in the T20I, it separates a little too little or about right) and none in the IPL, SA20 or CPL. The right separation is competition-specific, as the T20I's spread of 3 suggested, and for the IPL the data's answer is no separation: a fitted IPL spread would play every IPL match close to a coin whatever the squads, which a management game whose point is building a better squad cannot ship. **Not shipped; a decision for Harsha** (below).

The home side is the one thing the engine misses in the other leagues: the real home side won 0.55-0.62 in the PSL, BBL, SA20 and CPL on both halves, the engine 0.49-0.52. A home logit shift fitted on the four leagues' fit halves (+0.30, +0.074 win probability for equal sides) gives the holdout -0.011 +- 0.008 per match pooled (PSL -0.004, BBL -0.006, SA20 -0.007, CPL -0.028; with ILT20 and MLC, whose home grounds are shared or neutral, -0.003 +- 0.005). Suggestive, not yet decisive, and not the IPL (whose home side wins half): **not shipped; a candidate** (below).

### 10.2 The IPL's run level

**Why it did nothing: two bugs.**
1. *The stadium labels cancelled it.* A league's run level was folded into each ground's `runMult`, and `runMult` also derives the team's stadium label (`deriveStadiumBowlingRating`), which a team's config stores at load (and a save keeps). `stadiumRatingFor` compares the stored rating with the one the profile now implies and applies the difference as the legacy stadium effect on dots and wickets. With the IPL's run level at 1.10 the IPL grounds' implied rating fell, the stored one did not, and the stadium effect rose to 1.07 on dots and wickets: the level was mostly cancelled (`LEVELS_FILE` overrides, used for every level fit, hit it always; a code change would have hit every save).
2. *Only the non-six classes carried it, under a clamp.* `applyVenueProfile` puts the ground's run factor on sixes through the six factor (which the level did not touch) and the rest on 1-4, clamped at 1.25; past a level of about 1.12 the IPL's batting grounds hit the clamp (1.12 to 1.16: +0.9 runs).

**The fix** (`venues.ts`): the level rides on the profile as `levelRun` (the league's run level over the one its grounds' `runMult` is set at, `labelRunLevel`: the IPL's 1.04, the extra leagues' 1), a multiplier on every scoring class including sixes at the ground gain (1.6), applied after the ground. `runMult` and so every stadium label stay where they were: a stored rating still equals the measured default and the stadium effect stays neutral. At the former levels `levelRun` is 1 everywhere, so the fix alone changes nothing ball for ball (the IPL benchmark with it, at the former level and the IPL's neutral grounds as before, reproduced section 9's 0.7123 / 0.7039 to the fourth decimal). Also: the IPL's neutral grounds (playoffs) now take the league's level like the extra leagues' do (they had no profile, and would have played some 25 runs under its home grounds), and a T20I at a franchise ground leaves out the IPL's levels and any `levelRun` (the T20I has its own level; the extra leagues' wicket and dot levels stay in T20Is at their grounds as before, since the T20I level was fitted with them).

**The refit** (`CALIBRATE_LEAGUES=1 CAL_ONLY=none`, whole IPL seasons, both innings, `LEVELS_FILE`). Fitted to 2024 (182.9 runs an innings), keeping the wickets an innings where section 9 shipped them (6.06-6.08; the run level takes wickets down, so the wicket level moves with it):

| IPL run / wicket level | seasons | runs / innings | wickets / innings | first-innings all out |
|---|---|---|---|---|
| before the fix: 1.04 / 1.05 | 32 | 175.7 | 6.10 | 9.7% |
| before the fix: 1.10 / 1.05 | 32 | 180.6 | 5.79 | 7.6% |
| 1.04 / 1.05 (the fix, the former level) | 32 | 176.4 | 6.02 | 8.5% |
| 1.10 / 1.05 | 32 | 182.6 | 5.85 | 7.1% |
| 1.10 / 1.12 | 32 | 179.6 | 6.10 | 10.3% |
| 1.16 / 1.12 | 32 | 185.8 | 5.82 | 8.3% |
| 1.15 / 1.18 | 64 | 182.3 | 6.04 | 10.5% |
| **1.17 / 1.21 (shipped)** | 64 | **182.7** | **6.06** | 10.8% |
| real 2024 (fit) | | 182.9 | 6.22 | |
| real 2025-26 (holdout) | | 184.1 | 5.96 | |

(Calibration runs are not seeded alike: two runs of one engine differ by up to about 1 run, so the 175.7 and 176.4 of the former level are the same engine.) The level is fitted on 2024; on 2025-26 the IPL is now 1.4 runs under real (it was 8.3) and 0.10 wickets over (0.12).

*The IPL actual-XI benchmark* (section 9's, 1,024 replays, the same seeds; paired against origin/main; minus is better):

| arm | fit half 2023-24 (144) | paired | holdout 2025+ (144) | paired | runs an innings (fit / holdout) |
|---|---|---|---|---|---|
| before (origin/main) | 0.7123 +- 0.0120 | | 0.7039 +- 0.0137 | | 175.1 / 178.2 |
| the former level, the IPL's neutral grounds on it | 0.7135 | +0.0011 +- 0.0012 | 0.7022 | -0.0018 +- 0.0009 | 175.2 / 178.3 |
| **shipped**: run 1.17, wicket 1.21 | **0.7128** | **+0.0004 +- 0.0037** | **0.7017** | **-0.0023 +- 0.0038** | 182.9 / 186.3 |

(Real: 178.8 runs an innings in 2023-24, 184.1 in 2025-26.) Level on the fit half, a shade better held out: the IPL still has no skill (section 10.1), and the level does not need it.

*The men's T20I benchmark* (`BENCH_ACTUAL=1 BENCH_MODES=actual BENCH_REPLAYS=256 BENCH_ONLY=t20i-men`, `BENCH_DUMP`, paired per match against origin/main): fit 0.6301 -> 0.6310 (+0.0009 +- 0.0010), holdout 0.5760 -> 0.5752 (-0.0009 +- 0.0016). Only the T20Is at IPL grounds move (39 and 18 matches): they lose the IPL's wicket level, which had reached them since section 9 (1.05), and never get the new one.

**Verdict: the run-level fix and the IPL's refit shipped.** The level now moves the IPL's runs, the IPL comes to its real runs (175.8 to 182.7 against 182.9 in 2024 and 184.1 since) with its wickets kept, and neither match benchmark gets worse on either half. The first-innings all-out share rises (9.7% to 10.8%; real 7.7% since 2021): with more runs the wicket level must rise to keep the wickets, and those wickets fall in the last overs. Ratings, saves and stadium labels are unchanged (a team's stored stadium rating still matches; `levelRun` is computed, never stored). Tests: `packages/engine/src/__tests__/league-run-level.test.ts`.

### 10.3 For Harsha

1. **An IPL separation term** (the league equivalent of the T20I's spread). The data says none: fitted to 2024 it is 0 (every IPL match a coin whatever the squads), which would take most of the point out of building an IPL squad. Not shipped. If a smaller, game-friendly compression is wanted (e.g. half the engine's separation, k = 0.5: 0.7094 to 0.6986 on the fit half, 0.7082 to 0.6972 held out, post hoc), it needs a league strength term in both engines (the series tuning moves player copies, which league play does not have).
2. **A home advantage for the other men's leagues**: the real home side wins 0.55-0.62 in the PSL, BBL, SA20 and CPL on both halves, the engine 0.49-0.52; a pooled term fitted to 2024 improves 2025+ by -0.011 +- 0.008 a match (4 leagues). Worth building as a ball-level home term (both engines, like the chase edge), then judged on this benchmark at more replays. **Built and judged since** (docs/LEAGUES.md, "Home advantage"): with The Hundred added, the fitted pooled edge does not help 2025+ (+0.0023 +- 0.0039 a match; the IPL +0.018 +- 0.008) and is not shipped.
3. **Overseas players' ratings in franchise cricket**: in the IPL and BBL the overseas players' rating differences do not predict results (IPL -0.042 +- 0.023, BBL -0.018 +- 0.022 a point) where the domestic players' do (+0.061, +0.116). A lead for the ratings pipeline (validation only, nothing in the engine).
4. **The extra leagues' wicket and dot levels still reach T20Is at their grounds** (the T20I level was fitted with them, so they were left): the IPL's no longer do.


## 11. The innings shape: all-outs, extras and the seventh bowler (a chase wicket term shipped for the men's leagues)

Three gaps were left open by sections 6-10: too many innings ending all out (the IPL's first innings 10.8% against "7.7%", the leagues' mean all-out error 1.99 -> 2.76 points with section 6), the IPL's extras (9.36 an innings against 8.9) and the IPL's innings with seven or more bowlers (20% against 15%). Each was checked against the real record in the window the engine's levels are fitted on, and with the real elevens.

**What the real numbers are** (Cricsheet, every IPL match of the year, both innings; super overs out):

| IPL | 2021-23 | 2024 (fit) | 2025-26 (holdout) | the engine (origin/main, 128 seasons) |
|---|---|---|---|---|
| first innings all out | 6.3% (208) | 8.5% (71) | 8.8% (148) | 10.8% |
| second innings all out | 10.6% | 15.5% | 15.9% | 18.8% |
| extras an innings (wides / no-balls / byes / leg byes) | 8.46 | 9.25 (5.99 / 0.53 / 0.58 / 2.15) | 8.59 (5.90 / 0.45 / 0.45 / 1.78) | 8.08 (5.55 / 0.44 / 0.54 / 1.53) |
| innings of 19+ overs with 7+ bowlers | 7.6% (2021-22), 22.3% (2023) | 23.0% | 11.2% | 22.2% |

The "real" figures the gaps were stated against mix eras: the all-out share since 2021 includes the IPL before the Impact Player (6.3% in 2021-23, 8.5-8.8% since), and 15% seven-bowler innings is the average of a 2024 at 23% and a 2025-26 at 11%. Two of the three gaps had also moved: since section 10's run level the engine's IPL extras are 8.1, below real, not above it.

**With the real elevens the engine shows the same shape**, so the CPU's XIs are not the cause. The IPL actual-XI replays of section 9 (the real twelves and batting orders, 32 replays): first innings all out 10.8% (2023-24) / 10.3% (2025+), second 17.8% / 18.7%, seven or more bowlers 20.3% / 20.4%, extras 8.06 / 8.18 (`IPL_BENCH`, which now prints this shape line).

### 11.1 All-outs: the chase collapses too often (a wicket term by the state of the chase, shipped)

*Where the engine's wickets differ from real ones.* Every first and second innings of the nine men's leagues since 2021 (Cricsheet, full matches, the striker rated with the game's ratings: `t20-wicket-timing.py build`) against 3,000 engine matches a league (`last-pair-collect.test.ts`, `LP_LEAGUES=1 LP_MIN_WK=0`), the real wickets over the engine's expected number in the same cell (competition, state, striker rating bin and balls-faced bin), pooled over the leagues:

| chase: real wickets / the engine's, 2021-24 / 2025+ | 0-2 down | 3-4 down | 5-6 down | 7-8 down | 9 down |
|---|---|---|---|---|---|
| comfortable (pressure <= -0.25) | 1.09 / 1.11 | 0.97 / 1.00 | 1.04 / 0.93 | | |
| level (0-0.25) | 0.92 / 0.95 | 0.78 / 0.88 | 1.05 / 1.01 | | |
| behind (0.5-1) | 0.86 / 0.87 | 1.00 / 0.88 | 0.93 / 0.96 | 0.92 / 0.83 | |
| far behind (1+) | 0.81 / 0.67 | 0.97 / 1.16 | 0.95 / 0.89 | 0.88 / 0.88 | 0.98 / 0.98 |

(pressure = (required rate - current rate) / 8, the engine's own measure in `chaseAdjustment`.) A real side chasing behind the rate, or seven or eight down, loses fewer wickets than the engine's, and a comfortable one more: the engine's chase adjustment raises the wicket rate by hand-set steps with the pressure (up to +45%) and with five or seven down (+15% / +30%), and lowers it when comfortable. The engine's chase wickets also come early: pooled, its sixth to tenth wickets fell 0.5-0.8 overs before real ones (the ninth 16.43 against 17.25, 0-based), so its tails had more balls to face and the chase ended all out 21.9% of the time against 18.3% (3,000 matches a league, no rain; real: full matches 2024+). With the term: the ninth wicket at 16.86, the tenth at 17.24 (real 17.58), all out 19.5%; the IPL's 18.7% to 16.3% (real 16.1%). In the first innings the same comparison shows the engine losing a few more wickets with three to six down in the middle overs (0.75-0.94) in 2021-23 and 2025+, but not in 2024 (0.87-1.01): see the verdict below.

*The term* (`packages/ratings/src/analysis/state-wickets.py`; engine `state-wickets.ts`, generated `state-wickets-data.ts`; report `docs/data/state_wickets.json`). A log multiplier on the wicket class per cell of a chase, pressure (6 bins) x over band (1-6, 7-11, 12-15, 16-18, 19-20) x wickets down (0-2, 3-4, 5-6, 7-8, 9), pooled over the nine leagues: a wickets-down main effect plus a ridge-shrunk cell effect, fitted by maximum likelihood (each real ball's wicket against the engine's own rate in its cell, competition, striker rating and balls faced), **fitted to the end of 2024 (from 2021), judged on 2025+**, the ridge chosen by fitting to 2023 and scoring 2024. Then made neutral per league over the engine's own chase balls (a factor of 1.04-1.05), so each league's wickets per innings stay where its levels put them and only *when* they fall moves. It multiplies the wicket weight after the chase adjustment (`ballProbabilities`, so the live engine plays it too), in a men's league T20 only: a T20I, The Hundred, the women, a super over and every first innings play exactly as before. A second step of the same fit, on the engine with the term, did not predict 2024 better (converged). The same fit for the first innings (over band x wickets down) was not taken: fitted to 2023 it did not predict 2024 better at any ridge (-0.08e-4 a ball at its best), though it scored +0.55e-4 +- 0.32e-4 a ball on 2025+.

The fitted multipliers (the IPL's factor included): seven or eight down 0.73-0.92 in every state but the last two overs of a comfortable chase (about 1); nine down about 1 (0.85-1.20, the last pair's own term acts there); none to two down 0.92-1.29 after the powerplay (more wickets than the engine, most of all behind the rate in overs 12-15) and 0.89-0.92 in the powerplay behind the rate; three to six down 0.70-1.29 by cell.

*Out of sample, per ball* (chase balls of rated strikers, log likelihood of the wicket against the engine as it was, plus is better, +- its standard error over the balls):

| version (chase state) | 2024, fitted to 2023 (chosen ridge) | holdout 2025+ (67,833 balls), fitted to 2024 |
|---|---|---|
| pressure x over band x wickets down (**shipped**) | +4.2e-4 +- 1.6e-4 | **+3.6e-4 +- 1.2e-4** |
| pressure x wickets down | +1.0e-4 +- 0.7e-4 | +1.6e-4 +- 0.6e-4 |
| over band x wickets down | +2.3e-4 +- 1.2e-4 | +1.6e-4 +- 0.8e-4 |
| first innings, over band x wickets down (not taken) | -0.08e-4 +- 0.48e-4 | +0.55e-4 +- 0.32e-4 |

The holdout gain is positive in eight of the nine leagues (BBL +7.1, ILT20 +8.5, SA20 +5.1, MLC +5.0, CPL +4.8, LPL +5.2, BPL +1.9, PSL +0.8 e-4 a ball); the IPL's is flat (-0.15e-4 +- 2.5e-4).

*Levels.* The term is neutral on the engine's own balls but chases that collapse less last longer, so the leagues' wickets rose 0.03-0.16 an innings; the eight extra leagues' `wicket` and `dot` levels were refitted to the same 2024-26 targets as before (one Newton step on the response pooled over the leagues: wicket factors -2.8% to +0.8%, dot factors -2.3% to +3.6%). The IPL's level was left as section 10 fitted it (its runs and wickets moved within the noise). The balls-per-innings target the levels were first fitted with (LEAGUES.md, "Calibration") cannot be reached through the levels: at fixed runs and wickets the response of balls to the run, wicket and dot levels is nearly singular (bringing SA20 up 1.3 balls would take all three up 20-40%), so balls an innings follows the all-outs, not the levels.

*The leagues* (`CALIBRATE_LEAGUES=1 CAL_SEASONS=128`, whole seasons with rain, both innings; before = origin/main, after = shipped; real runs and wickets 2024-26, all out 2024+ with the innings in brackets):

| league | runs / innings: real, before, after | wickets / innings: real, before, after | 1st innings all out: real, before, after | 2nd innings all out: real, before, after |
|---|---|---|---|---|
| IPL | 183.7, 183.6, **184.1** | 6.05, 6.11, **6.09** | 8.7% (219), 10.8%, **10.8%** | 15.7% (216), 18.8%, **15.8%** |
| BBL | 158.3, 158.7, **158.6** | 6.47, 6.49, **6.42** | 12.0% (108), 14.2%, **12.8%** | 18.9% (106), 24.2%, **19.9%** |
| PSL | 169.2, 168.5, **168.5** | 6.47, 6.42, **6.45** | 13.8% (109), 14.2%, **14.1%** | 25.0% (108), 21.2%, **17.9%** |
| SA20 | 153.4, 153.2, **152.3** | 6.21, 6.29, **6.21** | 12.4% (97), 20.7%, **18.2%** | 21.7% (92), 22.5%, **20.8%** |
| CPL | 158.0, 158.3, **158.3** | 6.27, 6.27, **6.21** | 13.5% (104), 18.1%, **18.3%** | 13.5% (104), 21.1%, **17.5%** |
| ILT20 | 154.9, 155.1, **155.3** | 6.18, 6.25, **6.26** | 11.8% (102), 11.3%, **11.3%** | 12.7% (102), 18.9%, **15.6%** |
| MLC | 164.9, 164.0, **165.2** | 6.38, 6.41, **6.31** | 18.9% (90), 20.5%, **18.0%** | 16.7% (90), 22.3%, **17.9%** |
| BPL | 152.4, 153.0, **151.9** | 6.40, 6.42, **6.36** | 16.0% (125), 12.3%, **11.4%** | 17.6% (125), 20.9%, **17.9%** |
| LPL | 175.7, 174.3, **176.8** | 6.64, 6.58, **6.63** | 14.6% (48), 16.9%, **17.1%** | 17.0% (47), 24.7%, **23.4%** |
| mean absolute error (bias), nine | 0.53 -> **0.57** | 0.043 -> **0.041** | 2.87 (+1.94) -> **2.48 (+1.16)** | 4.82 (+3.97) -> **2.66 (+0.87)** |
| against 2021+ (the former measure) | | | 3.81 (+3.26) -> 3.24 (+2.48) | 3.79 (+3.21) -> 1.87 (+0.11) |
| against 2025+ only (the holdout years) | | | 3.79 (+0.86) -> 3.55 (+0.08) | 5.07 (+3.64) -> 2.91 (+0.54) |

The second innings' all-outs come to real (the pooled bias +3.97 points to +0.87; the IPL 18.8% to 15.8% against 15.7%), the first innings' move a little with the level refit (bias +1.94 to +1.16; the IPL's stays at 10.8% against 8.7%), runs and wickets an innings stay where they were (a 128-season run of one engine differs from another by about 0.5 runs and 0.4 points of all-out a league). Balls an innings come up 0.1-1.3 (MLC 110.3 to 111.6, real 111.6; SA20 108.1 to 108.6, real 110.2). Per league the real shares carry a sampling error of 3-5 points (48-125 innings since 2024), so a mean absolute error of 2.5 points is about what an engine matching every league's true share would show; the pooled bias is the measure that has the power, and it is the one that moves. Extras and bowlers used are unchanged (IPL 8.08 to 8.07 extras, 22.2% to 22.2% seven-bowler innings).

*Match prediction* (paired per real match, minus is better; before = `SW_OFF=1` with the former levels, the same seeds):

| benchmark | fit half | paired | holdout 2025+ | paired |
|---|---|---|---|---|
| IPL actual XI (section 9: the real twelves, 1,024 replays) | 2023-24 (144): 0.7131 -> 0.7148 | +0.0017 +- 0.0021 | 144: 0.7016 -> 0.7045 | +0.0029 +- 0.0022 |
| league actual XI (section 10: seven leagues, 256 replays), pooled | to 2024 (855): 0.6931 -> 0.6949 | +0.0018 +- 0.0023 | 506: 0.6927 -> 0.6923 | **-0.0004 +- 0.0031** |
| of which the IPL | 276: 0.7098 -> 0.7108 | +0.0010 +- 0.0032 | 142: 0.6942 -> 0.6981 | +0.0039 +- 0.0041 |
| men's T20I actual XI (`BENCH_ACTUAL=1 BENCH_MODES=actual BENCH_ONLY=t20i-men`; only the T20Is at the extra leagues' grounds move, through their refitted levels), 96 replays | to 2024 (418): 0.6324 -> 0.6359 | +0.0034 +- 0.0040 | 168: 0.5829 -> 0.5866 | +0.0037 +- 0.0056 |
| the same, 256 replays | 0.6313 -> 0.6318 | +0.0006 +- 0.0025 | 0.5744 -> 0.5764 | +0.0020 +- 0.0027 |

With the real twelves (the IPL rows, 1,024 replays) the chase's all-outs fall from 18.3% / 17.7% to 15.4% / 14.9% (2023-24 / 2025+; real 14.1% / 15.9%), the first innings' stay at 11.1% / 10.2% (real 6.3% / 8.8%), runs an innings 182.9 / 186.3 to 183.5 / 186.9 (real 178.8 / 184.1).

**Verdict: shipped (the chase term and the level refit), as level within noise while clearly fixing a calibration gap.** Out of sample the term predicts the 2025+ chase balls better (+3.6e-4 +- 1.2e-4 a ball, three standard errors, eight leagues of nine), and the gap it targets closes: the leagues' second-innings all-out bias from +4.0 to +0.9 points (their mean error 4.8 to 2.7), the IPL's chase all-outs to real with the game's squads and with the real twelves. No match benchmark moves outside its noise on either half (the league benchmark's holdout -0.0004 +- 0.0031; the IPL's +0.0029 +- 0.0022 and +0.0039 +- 0.0041, the IPL having no skill either way, section 10.1; the T20I +0.0020 +- 0.0027 at 256). Runs and wickets an innings stay as they were (mean error 0.53 to 0.57 runs, 0.043 to 0.041 wickets: within the 128-season noise). **What is not fixed: the IPL's first-innings all-outs** (10.8% against 8.7% since 2024, about one standard error of the real share): the first-innings state term did not predict 2024 and was not taken, and with the striker held fixed the IPL's first-innings wickets are within 2.5% of real ball by ball (real / engine 0.975 in both halves), so what is left is in who is batting and when, not in the hazard.

### 11.2 Extras: the IPL's run level dilutes them (not changed)

The IPL's extras went from 9.36 an innings (section 9) to 8.1 with section 10's run level, with no change to any extras rate: the level multiplies every scoring class by 1.17^1.6 = 1.29 in the ball's weights, and the wides, no-balls and leg byes, which it leaves alone, lose share when the weights are normalised (the impact player collector, `IMP_SIM=1 IMP_MATCHES=3000`: 8.27 now). Undoing the dilution (the level acting on the legal ball only) would bring the IPL back to about 9.3: the 2024 figure (9.25), 0.7 over 2025-26 (8.59), where the engine is now 0.5 under; by kind, wides 5.55 would go to about 6.3 (real 5.99 / 5.90), leg byes 1.53 to about 1.75 (2.15 / 1.78). No better on the holdout, so not done; the other leagues' levels leave extras alone (their run level is 1). Real IPL extras fell from 2024 to 2025-26 mostly in the leg byes and byes (2.73 to 2.23), which nothing fitted on 2024 could see.

### 11.3 The seventh bowler: an IPL change of habit in 2025 (not changed)

Real IPL sides used seven or more bowlers in 7.6% of innings in 2021-22, 22-23% in 2023-24 (the first Impact Player seasons) and 11.2% in 2025-26 (242 innings). The attack table of section 8, fitted on all the leagues to 2024, plays 22.2% on the game's squads and 20.3% / 20.4% on the real IPL elevens of 2023-24 and 2025+: it matches the fit era and the real 2025+ elevens do not tell it that captains changed (the IPL's real batting elevens carried slightly fewer bowlers in 2025+, 4.95 rated 60+ against 5.23, and the model still brings on a seventh in 20%). An IPL offset fitted on 2023-24 would be about zero; one fitted on 2025+ would be fitted on the holdout. Left as it is; the other leagues are within 1-3 points of real (section 8).

### 11.4 For Harsha

1. **Window of the all-out targets.** Real all-out shares rose after 2021-23 in most leagues (IPL first innings 6.3% to 8.8%); the comparisons above use 2024+ like the runs and wickets. Per league the real share has a sampling error of 3-5 points (70-150 innings), so a mean error near 2.5-3.5 points is what a perfect engine would show; the pooled bias is the cleaner measure.
2. **The IPL's extras** (11.2): undo the run level's dilution if 9.3 an innings (2024-like) is preferred to 8.1 (now); neither is closer to 2025-26 (8.6).
3. **The seventh bowler** (11.3): a 2025 change of IPL habit; an IPL-only offset could be fitted on 2025-26 if the game should follow the latest season rather than the fit window.
4. **A first-innings state term** (over band x wickets down, 11.1) is a candidate: it scored +0.55e-4 +- 0.32e-4 a ball on 2025+ but failed the 2024 check it was chosen by, so it is in the data file as zeros; with more seasons it could be scored again (`state-wickets.py` takes it when the 2024 check passes).
5. **The calibration harness** (`calibrate-leagues.test.ts`, like `last-pair-collect.test.ts`) plays the extra leagues without the CricketArchive pool the app loads (`prepareLeaguePool`), so their squads have stand-ins where the app has real players; the levels are fitted on those squads.

Saves: nothing new is stored. Tests: `packages/engine/src/__tests__/state-wickets.test.ts`.

## Refitting

- League XIs (section 7): `cd packages/ratings && npx tsx src/pipeline/generate-league-xi.ts` (after a Cricsheet update), `LXI_OUT=xi.json npx vitest run packages/app/src/__tests__/league-xi.test.ts`, then
  `python3 -I packages/ratings/src/analysis/league-xi.py fit xi.json` (needs numpy and scipy) and copy the weights into `LEAGUE_XI_VALUE` (xi-selection.ts). `LXI_SIM=sim.json` (with `LXI_OFF=1` for the former selection) collects the bowling and depth table of the XIs in play.
  After a change, refit the innings clock (`t20-wicket-timing.py fit ... --wicket-only --write`, without its `t20i-male` table) and the league levels (`LEVELS_FILE=levels.json` in `calibrate-leagues.test.ts` / `last-pair-collect.test.ts` plays other levels without a rebuild).

- Bowling attack (section 8): `cd packages/ratings && npx tsx src/pipeline/generate-bowling-overs.ts` (after `generate-league-xi.ts` / `generate-actual-xi.ts`), `LXI_TRAIN=league.json npx vitest run packages/app/src/__tests__/league-xi.test.ts -t "training rows"`, `BENCH_TACTICS=1 BENCH_ONLY=t20i-men BENCH_REPLAYS=0 BENCH_EXPORT=t20i.json npx vitest run packages/app/src/__tests__/tactics-allocation.test.ts`, then `python3 -I packages/ratings/src/analysis/bowling-attack.py league.json t20i.json --write` (needs numpy and scipy; about two minutes, the forward calibration included). `LXI_SIM=sim.json` (`LXI_ATTACK_OFF=1` for the former attack) collects the allocation table; after a refit the league levels move (`calibrate-leagues.test.ts`, `LEVELS_FILE`).
- Impact Player (section 9): `cd packages/ratings && npx tsx src/pipeline/generate-impact-player.ts` (after a Cricsheet update), `IMP_OUT=rows.json npx vitest run packages/app/src/__tests__/impact-player.test.ts -t rows`, then
  `python3 -I packages/ratings/src/analysis/impact-player.py rows.json --write` (needs numpy and scipy; seconds). `IMP_SIM=1 [IMPACT_OFF=1] [ATTACK_OFF=1]` collects the IPL's allocation and subs on the game's squads; `IPL_BENCH=1 IPL_REPLAYS=1024 IPL_ARMS=old,new` is the IPL actual-XI match benchmark (`IPL_DUMP=prefix` writes the per-match counts). After a refit check the IPL's run and wicket levels (`LEAGUE_LEVELS.ipl`; `calibrate-leagues.test.ts` with `CAL_ONLY=none`, `LEVELS_FILE`, section 10); `IPL_LEVEL='{"run":..,"wicket":..,"dot":1}'` adds a benchmark arm `level` with another IPL level.
- The chase's state term (section 11): `cd packages/ratings && python3 -I src/analysis/t20-wicket-timing.py build work.duckdb` (the real table, once),
  `SW_OFF=1 LP_LEAGUES=1 LP_MIN_WK=0 LP_MATCHES=3000 LP_ONLY=ipl,bbl,psl,sa20,cpl,ilt20,mlc,bpl,lpl LP_OUT=sim npx vitest run packages/app/src/__tests__/last-pair-collect.test.ts`
  (the engine without the term), then `python3 -I src/analysis/state-wickets.py fit work.duckdb sim --write` (needs numpy and scipy; seconds; `--chase pressure|over`
  for the candidates). A further step: collect with the term in play and fit with `--prev docs/data/state_wickets.json`. The collectors and benchmarks take
  `SW_OFF=1`, `SW_CHASE_OFF=1`, `SW_FILE=state_wickets.json` (`state-wickets-env.ts`). After a refit, refit the league levels (`calibrate-leagues.test.ts`, `LEVELS_FILE`,
  which also prints the innings shape: all-outs by innings, extras by kind, bowlers used).
- League match prediction (section 10): `cd packages/ratings && npx tsx src/pipeline/generate-league-results.ts` (after `generate-league-xi.ts`), then `LEAGUE_BENCH=1 [LB_LEAGUES=ipl,psl,bbl,sa20,cpl,ilt20,mlc] [LB_REPLAYS=128] [LB_DUMP=prefix] [LEVELS_FILE=...] npx vitest run packages/app/src/__tests__/league-bench.test.ts`, the men's league actual-XI benchmark (the dump has each match's sides with their players' ratings, for calibration and the ratings-against-results regressions).
- Bowling choice: `BENCH_TACTICS=1 BENCH_EXPORT=train.json npx vitest run packages/app/src/__tests__/tactics-allocation.test.ts`, then `python3 packages/ratings/src/analysis/bowling-choice.py train.json` (needs numpy and scipy).
  `BENCH_TACTICS=1 [BENCH_REPLAYS=2] [BENCH_ONLY=...]` prints the allocation tables above (real against the sim).
- Bowler type: `python3 -I packages/ratings/src/analysis/t20-bowler-type.py --types 2 --write` (about 15 minutes; `--holdout` for the out-of-sample score, `--types 5|7` for finer types).
- Ball age: `python3 -I packages/ratings/src/analysis/ball-age.py test|odi|odi-age|t20`.
- Batter response (section 5): `python3 -I packages/ratings/src/analysis/t20-batter-response.py real real.json` (the real counts; needs numpy and the `duckdb` CLI); the simulated counts **from the engine with a zero table** (`BENCH_NO_RESPONSE=1` does not apply to this collector: zero `batter-response-data.ts` first) with
  `TAIL_COLLECT=1 TAIL_OUT=sim.json npx vitest run packages/app/src/__tests__/tail-response.test.ts` (split with `TAIL_ONLY=` and pass several files to `fit`); then `python3 -I packages/ratings/src/analysis/t20-batter-response.py fit real.json sim.json[,more.json] --write`
  (it adds its step to `docs/data/t20_batter_response.json` if that exists: delete it to fit from nothing). The powers are `RESPONSE_POWER` / `WICKET_POWER` in the script; `BENCH_BR_FILE=table.json` (the json `BR_DUMP=` writes) plays another table in the benchmarks without a rebuild.
- After any of these the ODI calibration (`benchmark-odi.ts CALIBRATE=1`, with `ODI_TUNE` to try values; it is fitted on the ODI's former allocation) and the series tuning (`BENCH_FIT=1 BENCH_FIT_ON=actual BENCH_HOLDOUT=fit`) move: refit them, with 32+ replays and the whole grid in view (the minimum of a flat grid, not the smallest value within 0.01 of it), then judge the change **per match on the holdout with a paired standard error** (`BENCH_DUMP=<prefix>` writes the per-match replay counts; `BENCH_CAL_FILE` / `BENCH_TUNING_FILE` replace the ODI calibration / the series tuning from a json file to compare settings without a rebuild).
