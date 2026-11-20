# Per-country validation (T20I, ODI, Test)

Each national side's simulated results against its real ones, over the window the engines were fitted on: men's and women's
T20Is and ODIs since 2019, men's Tests since 2023, matches between the twelve full members with a result (no DLS).

- **Real targets**: `docs/data/country_validation.json`, from `packages/ratings/src/analysis/country-validation.py` (from
  `packages/ratings`, needs `duckdb`). Per country: win rate overall, at home (the venue is in its own country) and away (in the
  opponent's), the mean first innings when batting first (every first innings), runs per wicket over all its innings, the
  head-to-head records of pairs with 8+ matches, and the fixture list (pairing, host or neutral, matches, wins of the first side).
- **Benchmark**: `packages/app/src/__tests__/benchmark-countries.test.ts`.
  `BENCH_COUNTRIES=1 [BENCH_REPLAYS=3] [BENCH_ONLY=t20i-men,...] [BENCH_MD=1] npx vitest run packages/app/src/__tests__/benchmark-countries.test.ts -t per-country --reporter=verbose`
  replays the real fixtures with the series' own sides (national squads on the format's ratings, the extended pool among the
  candidates), instant engine, and marks a figure OFF outside its tolerance: win rate the larger of 0.08 and two standard errors
  of the real rate (home / away 0.10), first innings the larger of 8% and two standard errors of the real mean, runs per wicket
  10%, head to head the larger of 0.15 and two standard errors. `BENCH_BEFORE=1` plays the state before the fit below.
- **Fit**: `BENCH_FIT=1 [CALIBRATE_WRITE=1] npx vitest run ... -t "series tuning fit"` (see "What was fitted").

## What was found

1. **The sides were too close** (every set). Win rates of the strongest and weakest sides were squeezed toward 0.5 (women's T20I:
   Australia 0.67 against 0.87, Zimbabwe 0.41 against 0.00; men's: Sri Lanka, West Indies, Zimbabwe 0.47-0.52 against 0.29-0.41).
   The T20 ball model's rating sensitivity was tuned on leagues, where squads are close in strength, and national sides' ratings
   are not adjusted for the level of cricket their players' records come from, so a weak side's players read as stronger than
   they play. The ODI model had a team spread (`ODI_RATING_SCALE`); the T20I had none.
2. **No home advantage** in the T20I and ODI (sim home and away win rates within 2 points of each other in most countries; real
   home sides win 55-64%).
3. **The pool**: 71 players with caps since 2024 were not matched by id; 65 of them were in the extended pool under CricketArchive
   ids (the id map has no entry for them) and 6 were missing and are now rated from Cricsheet (`generate-intl-pool.ts`): 1,557 of
   1,557 players with caps since 2024 for the app's 22 nations are in the pool (was 1,486 by id, 1,551 by name).
4. The first-innings means compared in the first version of this benchmark left out the real innings bowled out early; they are
   now every first innings.

## What was fitted

`packages/app/src/series-tuning.ts` (data: `series-tuning-data.ts`): in a T20I or ODI series match both sides' six batting and
bowling attributes are moved before the match, in both engines (`teamsForMatch`): (1) the gap between the two sides' strengths (mean
overall of the best eleven) stretched by `spread` (each moves (spread - 1) / 2 of the gap apart), (2) `home` rating points to the home
side (half up, half down for the away side) at a ground that is not neutral. Fitted per format and gender by a grid on the
log-likelihood of every real fixture's results given the simulated win probability (4 replays); of the settings within 0.01 of the
best, the smallest stretch then home advantage:

| | spread | home | log loss per real match, before -> after |
|---|---|---|---|
| men's T20I | 2 | 3 | 0.693 -> 0.650 |
| women's T20I | 3 | 3 | 0.621 -> 0.543 |
| men's ODI | 1 | 0 | no gain (0.671 at 1 / 0) |
| women's ODI | 3 | 0 | 0.526 -> 0.514 |

The T20I's own match conditions (FORMATS.md, "T20I level") were refitted on top, since the stretch widens the totals: men
0.24 / 0.24, women 0.23 / 0.46 (women 0.07 / 0.035 since the batter response, TACTICS.md section 5). T20I level against the real fixtures (3 replays): men 164.0 (sd 35.4), 200+ 15.2% (real 169.5, 37.3,
19.2%); women 140.6 (31.2), 3.1% (real 142.2, 34.6, 5.1%).

Men's ODI gained nothing from either parameter: the ODI model's own team spread and the venue tables already put its sides where the
real results are. The real ODI home advantage (65% for men) is **not** explained by a uniform rating shift (New Zealand 0.85 at home,
0.44 away; Sri Lanka 0.72 / 0.24): it is pitches and conditions of particular countries, which the neutral-ground ODI replay has no
way to carry. Left as it is.

## Realistic line-ups (men's T20I ships; the other sets do not)

*(Numbers in this section are from the first version of the check, before the actual-XI refit below, which supersedes the shipped tuning; the sets that ship are updated in the next section.)* Series fielded each nation's best eleven, so weak sides (West Indies with Pooran / Russell / Hope, Sri Lanka, Zimbabwe) won more than
they did. Realistic line-ups (`packages/app/src/realistic-xi.ts`, data `intl-availability-data.ts` from
`packages/ratings/src/pipeline/generate-intl-availability.ts`, real Cricsheet selection since 2024-01-01: the share of a side's matches a
player played): each match's XI is sampled from the side's pool of recent players with inclusion probabilities from those rates
raised to a sharpening power `gamma` (1 = the real rates; large = the usual XI), always eleven, a keeper and 5 bowling options.
Availability only decides who plays; no rating changes (the elite-player check is untouched). Only watched series use it (the
user's own side keeps his XI) and the setup page offers it as an opt-in checkbox.

**Check.** `gamma` fitted on the real fixtures up to 2024 (rates from 2024 matches only, `BENCH_HOLDOUT=fit`), judged on the 2025+
fixtures with the same 2024-only rates, so nothing leaks (`BENCH_HOLDOUT=1 BENCH_REALISTIC=1 BENCH_AVAIL_2024=1 BENCH_GAMMA=g`; real
targets `docs/data/country_validation_to2024.json` / `country_validation_2025.json`, rates `docs/data/intl_availability_2024.json`).
24 replays of every fixture. Log loss per real match (lower is better) and countries OFF:

| set | fit half (to 2024): best XI | realistic, gamma | holdout (2025+): best XI | realistic, same gamma | decision |
|---|---|---|---|---|---|
| men's T20I | 0.655 (14 OFF) | 0.6405 (13), g 3 | 0.623 (23 OFF) | 0.611 (19) | **ships** (better in every setting tried, both halves) |
| women's T20I | 0.562 (22) | 0.547 (21), g 2 | 0.471 (27) | 0.486 (24) | no: worse out of sample |
| men's ODI | 0.633 (16) | none better (best 0.644, g 1) | 0.686 (15) | 0.676 at g 1 only, 0.70-0.72 at the others | no |
| women's ODI | 0.514 (20) | 0.501 (18), g 2 | 0.479 (18) | 0.473 (19) | no: gain inside the noise (about 0.01) |
| men's Test | 0.593 (10) | none better (best 0.610, g 3) | 0.587 (12) | 0.619-0.638 | no (58 holdout matches; a worse log loss both halves) |

The noise of one cell is about 0.01 (the curve over gamma is not smooth), so only men's T20I is a clear gain; its weak sides move the
right way: West Indies 0.50 -> 0.40 win rate in the holdout (real 0.38), 0.51 -> 0.44 in the fit half (real 0.42); Sri Lanka 0.49 -> 0.47
(real 0.37) and Zimbabwe 0.39 -> 0.36 (real 0.23) move less; Bangladesh moves the wrong way (0.39 -> 0.46, real 0.36). Shipped:
`XI_SHARPEN = { "t20i-men": 3 }`; sets without an entry ignore the option. The shipped rates cover every match since 2024-01-01.

## Actual XI: what the sim does with the line-ups a user sets (and a refit on them)

**The benchmark.** `docs/data/actual_xi.json` (`packages/ratings/src/pipeline/generate-actual-xi.ts`, from the Cricsheet ball-by-ball json,
which lists each side's players) holds, for every match of the per-country benchmark (same filters: full members, a result, no DLS), the
eleven each side fielded, the batting order it used (order of arrival at the crease in its first innings, then the non-batters), the host and
the ground, the bowlers' overs and each batter's runs and balls. 99.8% of the 63,000 places map to a player in the pool; the rest, and the
handful of matches with fewer than eleven listed, are filled from the side's best. `BENCH_ACTUAL=1 npx vitest run
packages/app/src/__tests__/benchmark-countries.test.ts -t "actual XI" --reporter=verbose` plays every real match 24 times with the XIs that
really played through `IntlSeries.lineups` (the code path a user's XI takes in the app) and the real ground (`IntlSeries.ground`), and scores
the win log loss per real match against the best XI and the realistic sampler (`BENCH_MODES`, `BENCH_ONLY`, `BENCH_LIST=1` prints the
figures OFF). Totals and runs per wicket by country are scored as in the country benchmark (the OFF counts). Fit on matches to 2024,
judged on 2025+; the realistic sampler uses the rates of 2024 matches only. `BENCH_FIT_ON=actual` makes the three fit tests
(`BENCH_FIT`, `BENCH_FITHOME`, `BENCH_EVAL`) fit on actual-XI play, `BENCH_HOLDOUT=fit` on the fit half only. `BENCH_POSITIONS=1` compares
runs and balls by batting position.

**A bug found on the way (ODI).** The ODI engine plays a player on his ODI set (`Player.forFormat("odi")`), but the squad builder had made a
copy of that set, so the ODI opposition adjust and the series tuning (strength stretch, home advantage) moved a copy the engine never
read: in an ODI they only moved who was picked. `buildNationSquad` and `teamsForMatch` now keep the player's ODI set and his ratings as one
object, and a test checks it (`set-lineups.test.ts`). The ODI tuning had therefore been fitted on nothing, and was refitted. The adjust now
does what it was shipped to do; on actual-XI play it helps women's ODI in the fit half and is neutral for men's, and ships unchanged.

**Refit on actual-XI play** (fit half only, 6-8 replays, `BENCH_FIT` then `BENCH_FITHOME`; ratings are untouched). The best-XI tuning was
fitted on sides that were stronger than the ones that played, so it stretched and rewarded home more than real XIs need:

| set | before (best-XI fit): spread / home | after (actual-XI fit, to 2024): spread / home |
|---|---|---|
| men's T20I | 2 / 4 | 2.5 / 6 (Australia 12, New Zealand 10, Pakistan 2, Zimbabwe 4, Ireland 2, South Africa 0, Sri Lanka 0) |
| women's T20I | 3 / 6 | 3.5 / 2 (India 4, Ireland 6, South Africa 4, Sri Lanka 4, Bangladesh 0, West Indies 0, Zimbabwe 0) |
| men's ODI | 1 / 8 | 1 / 2 (Australia 4, Pakistan 4, New Zealand 4, West Indies 4, Sri Lanka 8, Ireland 0, Zimbabwe 0) |
| women's ODI | 3 / 12 | 1.5 / 2 (Australia 6, South Africa 6, Bangladesh 4, Ireland 4, West Indies 4, India 0, New Zealand 0) |

The ODI home advantages fall because the real ground now carries them (the ODI venue tables). The T20I conditions (FORMATS.md, "T20I level")
were not refitted.

**Result.** Log loss per real match (0.693 is a coin flip; lower is better), 24 replays of every match, the same tuning (the refit one) in
every column, countries OFF in brackets. Ratings are those of the extended pool rebuilt on 2026-11-17.

| set | half | best XI | realistic sampler | actual XI | actual XI, engine's batting order |
|---|---|---|---|---|---|
| men's T20I | fit (to 2024) | 0.650 (14) | 0.631 (13), g 3 | 0.634 (10) | 0.634 (10) |
| | **holdout (2025+)** | **0.629 (19)** | **0.596 (16)** | **0.592 (17)** | 0.612 (19) |
| women's T20I | fit | 0.553 (19) | 0.536 (16), g 1 | 0.524 (18) | 0.538 (16) |
| | **holdout** | **0.478 (25)** | **0.468 (20)** | **0.436 (21)** | 0.471 (22) |
| men's ODI | fit | 0.587 (22) | none better (0.602-0.604) | 0.575 (6) | 0.585 (8) |
| | **holdout** | **0.645 (19)** | 0.665-0.671 | **0.653 (17)** | 0.665 (17) |
| women's ODI | fit | 0.481 (13) | 0.476-0.486 | 0.497 (15) | 0.492 (16) |
| | **holdout** | **0.446 (14)** | 0.448-0.460 | **0.465 (10)** | 0.460 (12) |
| men's Test | fit | 0.636 (11) | 0.660-0.678 | 0.578 (6) | = |
| | **holdout** | **0.574 (10)** | 0.600-0.616 | **0.592 (12)** | = |

Before the refit and the ODI fix (the numbers of the realistic-line-ups section, on the refreshed ratings), the holdout read: men's T20I best
0.617, realistic 0.611, actual 0.599; women's T20I 0.475 / 0.475 / 0.460; men's ODI 0.680 / - / 0.682; women's ODI 0.494 / - / 0.471; Test
0.574 / - / 0.592.

What this says:

- **The ratings and the engine are right where the XI is right.** In T20I, men's and women's, the XIs that really played give the best
  predictions on the holdout by a clear margin (0.592 against 0.629, 0.436 against 0.478), and in the fit half for men's ODI (0.575 against
  0.587) and Test (0.578 against 0.636). The remaining misses in the best-XI column are the line-ups, not the players.
- **Women's ODI and the Test holdout**: the actual XI is not better than the best XI (0.465 against 0.446; 0.592 against 0.574). Both are
  within the noise of the sample (about 0.03 for 95 women's ODIs and 58 Tests), the fit halves go the other way for the Test, and nothing
  in the engine points at a cause; open.
- **Batting order is worth playing as set.** The real order beats the engine's order for the same eleven on the holdout in every limited-overs
  set but women's ODI (men's T20I 0.592 against 0.612, women's T20I 0.436 against 0.471, men's ODI 0.653 against 0.665). By batting
  position the sim matches the real runs and balls well from 1 to 7 (men's T20I: 27.1 / 20.4 against 27.4 / 19.8 for the opener, 12.5 / 9.5
  against 12.6 / 9.6 at seven); the tail (9-11) scores 1-2 runs more than real tails.
- **Realistic line-ups still help men's T20I, and now women's T20I** (better than the best XI in both halves at every sharpening tried, so
  `XI_SHARPEN` has `"t20i-women": 1`, the fit half's best; the gain is 0.01-0.016, small). They do not help the ODI or the Test. With the
  refit tuning, the realistic sampler for men's T20I is 0.033 better than the best XI on the holdout (it was 0.012): the best-XI column is
  worse than before the refit because the tuning now fits the line-ups real sides field.
- Countries OFF fall for actual XIs in most cells (men's ODI fit half 22 to 6, Test fit half 11 to 6); the exceptions are women's ODI in
  the fit half (13 to 15) and the Test holdout (10 to 12). Totals and runs per wicket by country stay as they were (the weakest women's sides
  still score too much, Left over below).

**What the user can do.** `IntlSeries.lineups` (and the user's own `lineup`) set an XI and a batting order for either side of a series, in
every format and gender, instant or live; a realistic series does not sample a side that has one; the series page has "Set / Edit XI" for both
sides and "Back to the realistic XI" (`InternationalPage.tsx`). The ground can be named (`IntlSeries.ground`, a `homeGrounds` entry).

**Done since** (docs/TACTICS.md): the bowling plan for the instant engine (a fitted captain's choice by default in a T20I, a user's plan on top), bowler type by phase refitted from Cricsheet, ball age tested out of
sample (nothing beat the engine's terms, so nothing shipped), and the user-selectable pitch / light / weather. The allocation changed what the sim does with a given XI (the powerplay no longer has spin bowling half
the overs), and the first refit of the series tuning on it scored **worse** on the 2025+ holdouts in all four limited-overs sets (0.592 -> 0.611, 0.436 -> 0.471, 0.653 -> 0.704, 0.465 -> 0.490 at 24 replays). That was traced and repaired
(TACTICS.md, section 2, "Regression on the real fixtures"): the captain model narrows the gap between the sides, which cost the ODI most, so **the ODI keeps the former allocation and its calibration and tuning (identical to the table above)**; the T20I keeps the model
and the men's T20I tuning is refitted (spread 3, home 2; women's unchanged). Final, paired against the table above's engine at 96 replays (the "actual XI" column of the Result table, re-read at that many replays; minus is better):

| set | holdout (2025+) before -> now | paired difference (holdout) | fit half before -> now |
|---|---|---|---|
| men's T20I | 0.596 -> 0.590 | -0.005 +- 0.015 | 0.632 -> 0.632 |
| women's T20I | 0.462 -> 0.476 | +0.014 +- 0.014 | 0.520 -> 0.521 |
| men's ODI | 0.673 -> 0.673 | 0 (identical) | 0.587 -> 0.587 |
| women's ODI | 0.435 -> 0.435 | 0 (identical) | 0.501 -> 0.501 |

(The 24-replay figures of the Result table above are single draws; the same engine reads 0.596 / 0.462 / 0.673 / 0.435 at 96 replays. Differences of a few hundredths between replay counts are noise; the paired standard errors are the yardstick.)
**Tail batters and the batter response** (TACTICS.md section 5). The T20 ball model's response to a batter's rating was refitted from Cricsheet ball by ball (a piecewise-linear correction per gender, no positional term, neutral in shares, run rows at x1.25 men / x1.5 women, no wicket row) with the women's T20I context, conditions and tuning refit for it. Paired per match against the engine before it, 96 replays of every real match with the XIs that played (minus is better):

| set | holdout (2025+) before -> now | paired difference (holdout) | fit half before -> now |
|---|---|---|---|
| men's T20I | 0.590 -> 0.580 | -0.010 +- 0.013 | 0.632 -> 0.636 (+0.004 +- 0.007) |
| women's T20I | 0.476 -> 0.449 | -0.027 +- 0.018 | 0.521 -> 0.523 (+0.003 +- 0.013) |
| ODI, Test | not touched | | |

Men's number 10 now scores the real runs (4.3 against 4.2, was 5.3) and number 11 3.2 against 2.3 (was 3.9); balls faced and the women's tails are not materially closer (the survival of the last pair is a state, not a rating). The women's T20I tuning is now spread 1.5 / home 2 (was 3.5 / 4), the men's unchanged at 3 / 2; the ODI and Test engines are untouched (their number 11, TACTICS.md section 5, is the same last-pair excess).
The women's T20I holdout: the captain model and the bowler-type table stay (switching either off is not better on the fit half; captain off loses 0.032 +- 0.014 on the holdout).

## Test and ODI series tuning (the Test gets one; the ODI is refitted)

`BENCH_SERIES=1 BENCH_KEY=test-men|odi-men|odi-women BENCH_HALF=fit|hold|all BENCH_REPLAYS=256 BENCH_OUT=out.json [BENCH_TUNE='{"test":{"men":{"spread":1,"home":-1.5}}}'] npx vitest run packages/app/src/__tests__/benchmark-series-fit.test.ts`
(`benchmark-series-fit.test.ts`) plays every real match with the XIs that played (as "Actual XI" above), writes the per-match record
(wins of the real winner, decided replays, draws) and prints the log loss, the draw rate and the home share of decided matches.
`BENCH_COMPARE=a.json,b.json` gives the paired per-match difference and its standard error. Fits use the fit half (to 2024) only; the
2025+ holdout is read to judge, not to choose. A match's loss is -log((wins + 1) / (decided replays + 2)) of the real winner.

**The Test's home advantage was not 57.5% against 51.4%.** That pair mixed bases: the real 51.4% is home wins of all Tests *including draws*
(146 Tests since 2023: 51.4 / 39.8 / 8.9% home / away / draw); the sim's 57.5% was of *decided* Tests. On decided Tests the real hosted share of
the 133 benchmark matches is **57.3%** (fit half 59.5%, holdout 54.4%; SE about 4 points), and the sim with the real XIs gave **62.8%**
(64.9% / 60.1%). So the sim's home edge is about 5 points too big, in both halves, and its draw rate is right (9.0% against 8.9%).
The toss is not it (a fair coin, then the host country's fitted bat-first share) and neither are draws. The Test ball model carries a
fitted home / away factor on every ball (the home batting side: wickets x0.954, sixes x1.049, singles x1.032; away x1.045 / 0.956 / 0.970,
`test-model-data.ts`), a per-host pace / spin table, and the players' own ratings, whose records are themselves mostly home matches (a plausible
second count of the same edge, not separated here); a ball-level factor compounded over 1,800 balls gives a bigger match-level
edge than the results show (India at home 82% against 59% real). The ball model is a clean fit and was left alone; the match-level
correction belongs in the series tuning, which is what it is for.

**Fit** (fit half, 75 Tests, 96 then 192 replays; paired against no tuning; plus is worse):

| stretch \ home | -4 | -3 | -2 | -1 | 0 | +2 |
|---|---|---|---|---|---|---|
| 0.75 | +0.009 | -0.001 | -0.026 | -0.012 | -0.028 | +0.051 |
| 1 | +0.024 | -0.008 | **-0.033** | -0.028 | 0 | +0.014 |
| 1.25 | +0.004 | -0.001 | -0.002 | -0.001 | -0.016 | +0.009 |

(standard errors 0.02-0.05 per cell; home share of decided Tests in the sim 44-51% at -4, 57% at -2, 61% at -1, 65% at 0, 72% at +2). A stretch
is not worth having (0.75 and 1 are equal within the noise, 1.25 and 0.5 are worse, so the sides stay as rated), and the home term's best region is -2 to -1, where the sim's home share matches the real 59.5%.
Shipped first: **`test.men = { spread: 1, home: -1.5 }`** (the home side's six attributes 0.75 points down, the away side's 0.75 up); a strength term for South Africa follows below. Women's Tests
(17 real) have no entry.

**Per-country home terms were tested and not shipped.** Each host country's loss over a grid of home terms (192 replays, prior sd 1.5 / 2 / 3
rating points around the uniform best): at 5-13 hosted matches a country's curve is flat to within replay noise, and the three it moves
(South Africa to -1, Bangladesh -3, England -1) are not better than the uniform term out of sample (paired on the holdout, 256 replays:
-0.006 +- 0.010 against the uniform -2, and each country's change is a log-likelihood of 0.3-1.0). South Africa is the real signal, and it
is not a home effect: they win 75% / 82% against a sim 61% / 51% in both halves **away as well as at home** (away 0.73 real against 0.51
sim), so it is a strength shortfall of the side, not a ground term.

**A strength term for South Africa (shipped), none for the others.** `SeriesTuning.strengthBy` adds rating points to a country's side wherever
it plays (the stretch cannot do it: it moves sides apart in proportion to the gap, and South Africa and New Zealand are mid-table sides the
ratings under-rate while India and England are over-rated). Fit half only, one country at a time (192 replays; the loss of the matches that
country played, plus offset^2 / (2 sd^2), sd 1.5 / 2 / 3):

| offset (rating points) | -4 | -2 | 0 | +2 | +4 | +6 | chosen (every sd) |
|---|---|---|---|---|---|---|---|
| South Africa (12 fit Tests): log-lik | 7.28 | 5.42 | 4.12 | 2.93 | 2.68 | 2.92 | **+2** (win rate 0.58 -> 0.67; real 0.75) |
| New Zealand (18) | 17.27 | 15.84 | 14.35 | 14.18 | 14.33 | 15.27 | 0 |
| India (20) | 14.65 | 14.49 | 15.30 | 15.84 | 19.01 | 20.52 | 0 (-2 at sd 2 and 3, a gain of 0.8) |
| England (24) | 16.22 | 16.34 | 15.84 | 17.46 | 19.50 | 22.90 | 0 |

Only South Africa has a gain worth 1 log-likelihood point and it is the one whose shortfall repeats away and at home in both halves; the
holdout (512 replays, read once for this) confirms it: with South Africa +2, paired against the home term alone, **-0.029 +- 0.016**
(South Africa's 11 holdout Tests: win rate 0.51 -> 0.61, real 0.82), fit half -0.015 +- 0.008 (chosen there). India -2 was added and
did not help the holdout further (-0.030 +- 0.023 against home alone, the same as South Africa alone), so it is not shipped. New
Zealand (real 0.65, 26 Tests; the fit half says 0.56 against a sim 0.49 and the loss is flat) has no evidence to ship. **This is a
side-level offset on the ratings' order of one country, fitted on 23 Tests: it is the thing to drop when the Test ratings are next
refitted, and it follows any XI a user sets for South Africa. Open decision.**

**Result** (actual XIs, 512 replays of every match; log loss per real match, 0.693 a coin flip; SE of the mean over matches in
brackets; "paired" is the difference of the same matches and its standard error, minus is better):

| | before (no tuning) | home -1.5 only | shipped (home -1.5, South Africa +2) | paired, shipped against before |
|---|---|---|---|---|
| fit half (75) | 0.605 (0.080) | 0.592 (0.078) | 0.577 (0.078) | -0.028 +- 0.017 |
| **holdout 2025+ (58)** | **0.615 (0.088)** | **0.609 (0.081)** | **0.580 (0.078)** | **-0.035 +- 0.028** |
| all 133 | 0.609 (0.059) | 0.599 (0.056) | 0.578 (0.056) | -0.031 +- 0.016 |
| home share of decided Tests, sim (real 57.3%) | 62.8% | 57.4% | 57.7% | |
| draw rate, sim (real 8.9%) | 9.0% | 9.1% | 8.8% | |

The log loss moves less than its error because it is mostly a statement about who wins, and the home term moves a few points of win
probability on a third of the matches; what moves is the bias: home share of decided Tests 62.8% -> 57.4% (real 57.3%; holdout 60.1 ->
54.6 against 54.4, fit half 64.9 -> 59.5 against 59.5). Win rate by country with the XIs that played (133 Tests; real / before / shipped;
home and away):

| country | win | home | away |
|---|---|---|---|
| Australia | 0.69 / 0.72 / 0.72 | 0.75 / 0.82 / 0.78 | 0.65 / 0.62 / 0.66 |
| Bangladesh | 0.46 / 0.44 / 0.42 | 0.50 / 0.57 / 0.50 | 0.40 / 0.26 / 0.32 |
| England | 0.53 / 0.62 / 0.62 | 0.68 / 0.77 / 0.72 | 0.33 / 0.44 / 0.51 |
| India | 0.53 / 0.66 / 0.64 | 0.59 / 0.82 / 0.77 | 0.50 / 0.47 / 0.51 |
| New Zealand | 0.65 / 0.52 / 0.51 | 0.62 / 0.59 / 0.51 | 0.69 / 0.45 / 0.50 |
| Pakistan | 0.30 / 0.26 / 0.25 | 0.44 / 0.37 / 0.30 | 0.21 / 0.18 / 0.22 |
| South Africa | 0.78 / 0.55 / 0.64 | 0.82 / 0.63 / 0.67 | 0.73 / 0.51 / 0.64 |
| Sri Lanka | 0.40 / 0.42 / 0.41 | 0.50 / 0.57 / 0.51 | 0.30 / 0.27 / 0.31 |
| West Indies | 0.28 / 0.31 / 0.30 | 0.30 / 0.43 / 0.36 | 0.27 / 0.23 / 0.26 |
| Zimbabwe | 0.18 / 0.15 / 0.13 | 0.14 / 0.18 / 0.12 | 0.25 / 0.10 / 0.15 |
| Ireland | 0.22 / 0.29 / 0.30 | 0.50 / 0.59 / 0.50 | 0.14 / 0.20 / 0.24 |

Home rates move toward the real ones in 8 of 11 countries (the exceptions are New Zealand, Pakistan and South Africa, which the ratings place
wrongly; India's 0.77 against 0.59 is still far off); South Africa goes 0.55 -> 0.64 against 0.78 and no longer stands out. The order of the
rest is as the ratings give it (there is no stretch): India and England are still 9-11 points too high, New Zealand 14 too low. With the best eleven of each squad (the country
benchmark, 64 replays): 10 figures OFF -> 7, South Africa 0.58 -> 0.67 (no longer OFF, real 0.78), India at home 0.83 -> 0.76 (no longer OFF),
log loss 0.5965 -> 0.5833.

**ODI refit** (the ODI engine, ratings of 3748662, the former bowler rule; actual XIs, fit half only). A grid of stretch (0.75, 1, 1.5, 2) x
home (0, 2, 4, 6) at **64 replays of every real match** (the shipped fit used 6-8 and took the smallest stretch within 0.01 of the best loss,
which on a flat grid is arbitrary), the surface smoothed by a quadratic as a check on grid noise, then each host's own home term from its
hosted matches' loss against a prior (sd 3 rating points around the uniform best):

| set | grid minimum (loss) | smoothed surface minimum | per-country terms with the prior | shipped |
|---|---|---|---|---|
| men's ODI (336 fit matches) | stretch 1, home 4 (0.596; the shipped stretch 1, home 2 is 0.609) | 1.4, 4.25 (0.598) | New Zealand 6, India 6, Sri Lanka 6, Pakistan 6, Australia 2, Bangladesh 2, Zimbabwe 0 | stretch 1, home 4 and those |
| women's ODI (219) | stretch 1.5, home 2 (0.509) | 1.6, 1.75 | Australia 6, West Indies 4, Bangladesh 4, India 0, Sri Lanka 0, Pakistan 0 | stretch 1.5, home 2 and those |

The stretches (1, 1.5) are the ones that were shipped; men's home 2 -> 4; the per-country terms changed (the old ones were fitted at 6-8 replays on the
old ratings). Log loss per real match, paired against the tuning that was shipped (256 replays on the holdout, 128 on the fit half; minus is better):

| set | holdout 2025+: shipped -> refit | paired | fit half: shipped -> refit | paired |
|---|---|---|---|---|
| men's ODI (109 / 336) | 0.660 (0.041) -> 0.645 (0.048) | -0.015 +- 0.014 | 0.587 -> 0.584 | -0.003 +- 0.009 |
| women's ODI (103 / 219) | 0.447 (0.064) -> 0.437 (0.063) | -0.010 +- 0.018 | 0.505 -> 0.502 | -0.003 +- 0.012 |

Neither is a significant change, which is the point: the refit confirms the stretches and the shipped home terms were not far off, moves them
the way the evidence says and leaves the held-out loss where it was or a little better. The sim's home share of decided ODIs matches the real
(men's 64.7% against 63.5% on the holdout, women's 63.1% against 65.1%). Uniform home terms alone (no per-country terms) were as good on the
men's holdout (-0.005 +- 0.014) and worse on the women's fit half (+0.022 +- 0.014); the prior-shrunk per-country terms did not lose on either.
A tighter prior (sd 2, two to three countries moved) was no better (men's holdout +0.002 +- 0.015, fit half +0.005 +- 0.009; women's fit half +0.006 +- 0.011), so the sd-3 terms ship.

**Conditions (pitch, light, weather).** The series tuning moves the two sides' ratings (a rating shift); a pitch, light or weather setting acts
on the ground's profile (ODI: `applyConditionsToProfile` replaces the ground's run / six / wicket factors and bowler edges) or on the Test's
match-level run / wicket spread, and never on the sides' ratings. The home term was fitted with the real ground in place, so it is what is
left over after the ground's own effect; a preset replaces the ground's effect and the home term stays as it was, so nothing is counted twice.
`series-tuning.test.ts` checks that the sides' shifts are identical with and without a pitch / light / weather setting, in a Test and an ODI.

## Left over

- Men's Test with the elevens that played (133 Tests since 2023): before the Test tuning (above) India won 66% against a real 53%, England
  62% against 53%, South Africa 55% against 78%, New Zealand 52% against 65%, Australia 72% against 69%, and home sides 62.8% of decided
  Tests against 57.3% real (the "57.5% against 51.4%" of the bias round compared decided with all matches). The home term brings the home
  share to 57.4% and the away rates closer; South Africa's strength term brings its win rate to 0.64 (real 0.78). Left: **New Zealand
  (0.51 against 0.65) is underrated and India and England (0.64 and 0.62 against 0.53) overrated** as sides, with no ground term, stretch or
  well-supported offset that fixes them (New Zealand and India were tried; the loss is flat on the fit half); that is a question for the Test ratings, which the
  bias round checked for India and Australia and did not find wrong. The South Africa offset is the one thing here that stands in for a
  ratings error; drop it when the Test ratings are next refitted.
- Sri Lanka, West Indies and Zimbabwe men's T20I still win 0.40-0.49 against 0.29-0.41: their squads rate higher than they played
  over 2019-26 (an order-of-sides error, not a spread one).
- Women's Zimbabwe and Bangladesh (real 0.00 and 0.18) are still too strong at 0.19 / 0.37, and score 20-25 runs more per
  innings than they did: the weakest sides' players, rated from their domestic and associate-level cricket, read too high.
- ODI home advantage by country (above) and the Test first innings of New Zealand (300 against 394), Bangladesh (305 against 236)
  and England (378 against 328), each from 8-22 real matches.

## Tables (6 replays of each real fixture)

### Men's T20I (2019+, 586 matches)

Figures outside tolerance (OFF): before 33, after 20 (of about 6 per country plus the head-to-heads).

Before (no series tuning, the T20I conditions as first fitted):

| country | win rate sim / real | home sim / real | away sim / real | 1st inns sim / real | runs per wicket sim / real |
|---|---|---|---|---|---|
| Australia | 0.49 / 0.60 OFF | 0.48 / 0.67 (n 30) OFF | 0.49 / 0.54 (n 56) | 167 / 177 | 29.5 / 26.5 OFF |
| Bangladesh | 0.40 / 0.41 | 0.42 / 0.58 (n 43) OFF | 0.42 / 0.36 (n 33) | 159 / 143 OFF | 25.6 / 20.8 OFF |
| England | 0.51 / 0.63 OFF | 0.45 / 0.72 (n 36) OFF | 0.51 / 0.57 (n 56) | 166 / 190 OFF | 27.5 / 28.4 |
| India | 0.60 / 0.70 OFF | 0.60 / 0.73 (n 73) OFF | 0.60 / 0.63 (n 54) | 166 / 188 OFF | 27.4 / 30.4 |
| Ireland | 0.48 / 0.28 OFF | 0.44 / 0.27 (n 22) | 0.55 / 0.38 (n 16) | 161 / 156 | 24.6 / 20.2 OFF |
| New Zealand | 0.49 / 0.53 | 0.51 / 0.56 (n 63) | 0.49 / 0.48 (n 46) | 166 / 174 | 26.3 / 25.9 |
| Pakistan | 0.52 / 0.52 | 0.54 / 0.66 (n 47) | 0.55 / 0.42 (n 57) | 165 / 164 | 27.3 / 24.6 OFF |
| South Africa | 0.45 / 0.51 | 0.46 / 0.38 (n 32) | 0.41 / 0.50 (n 50) | 165 / 172 | 27.5 / 26.2 |
| Sri Lanka | 0.51 / 0.36 OFF | 0.49 / 0.37 (n 35) | 0.49 / 0.29 (n 48) OFF | 167 / 152 OFF | 28.6 / 20.6 OFF |
| West Indies | 0.52 / 0.41 OFF | 0.52 / 0.48 (n 63) | 0.52 / 0.34 (n 41) OFF | 168 / 177 | 29.3 / 24.9 OFF |
| Zimbabwe | 0.44 / 0.29 OFF | 0.40 / 0.32 (n 37) | 0.49 / 0.21 (n 24) OFF | 165 / 144 OFF | 26.6 / 19.2 OFF |

After:

| country | win rate sim / real | home sim / real | away sim / real | 1st inns sim / real | runs per wicket sim / real |
|---|---|---|---|---|---|
| Australia | 0.51 / 0.60 | 0.56 / 0.67 (n 30) | 0.48 / 0.54 (n 56) | 169 / 177 | 29.8 / 26.5 OFF |
| Bangladesh | 0.34 / 0.41 | 0.37 / 0.58 (n 43) OFF | 0.35 / 0.36 (n 33) | 155 / 143 OFF | 24.4 / 20.8 OFF |
| England | 0.54 / 0.63 | 0.61 / 0.72 (n 36) | 0.52 / 0.57 (n 56) | 167 / 190 OFF | 27.3 / 28.4 |
| India | 0.65 / 0.70 | 0.69 / 0.73 (n 73) | 0.57 / 0.63 (n 54) | 171 / 188 OFF | 29.1 / 30.4 |
| Ireland | 0.35 / 0.28 | 0.32 / 0.27 (n 22) | 0.38 / 0.38 (n 16) | 157 / 156 | 24.3 / 20.2 OFF |
| New Zealand | 0.50 / 0.53 | 0.54 / 0.56 (n 63) | 0.45 / 0.48 (n 46) | 163 / 174 | 25.4 / 25.9 |
| Pakistan | 0.57 / 0.52 | 0.66 / 0.66 (n 47) | 0.53 / 0.42 (n 57) | 164 / 164 | 27.3 / 24.6 OFF |
| South Africa | 0.44 / 0.51 | 0.46 / 0.38 (n 32) | 0.36 / 0.50 (n 50) | 165 / 172 | 27.6 / 26.2 |
| Sri Lanka | 0.48 / 0.36 OFF | 0.56 / 0.37 (n 35) OFF | 0.39 / 0.29 (n 48) | 165 / 152 OFF | 26.6 / 20.6 OFF |
| West Indies | 0.51 / 0.41 OFF | 0.55 / 0.48 (n 63) | 0.46 / 0.34 (n 41) | 168 / 177 | 28.7 / 24.9 OFF |
| Zimbabwe | 0.40 / 0.29 OFF | 0.41 / 0.32 (n 37) | 0.41 / 0.21 (n 24) OFF | 159 / 144 OFF | 24.0 / 19.2 OFF |

Head to head (sim / real win rate of the first side) outside tolerance: before 7 of 37, after 2 of 37: after: England v Sri Lanka: 0.60 / 1.00 (n 9); New Zealand v Sri Lanka: 0.46 / 0.77 (n 13).

### Women's T20I (2019+, 435)

Figures outside tolerance (OFF): before 37, after 29 (of about 6 per country plus the head-to-heads).

Before (no series tuning, the T20I conditions as first fitted):

| country | win rate sim / real | home sim / real | away sim / real | 1st inns sim / real | runs per wicket sim / real |
|---|---|---|---|---|---|
| Australia | 0.67 / 0.87 OFF | 0.67 / 0.83 (n 35) OFF | 0.65 / 0.87 (n 30) OFF | 145 / 169 OFF | 28.7 / 31.9 |
| Bangladesh | 0.45 / 0.18 OFF | 0.45 / 0.15 (n 20) OFF | 0.49 / 0.13 (n 15) OFF | 133 / 112 OFF | 23.1 / 15.0 OFF |
| England | 0.64 / 0.74 OFF | 0.64 / 0.71 (n 56) | 0.58 / 0.75 (n 32) OFF | 142 / 158 OFF | 26.4 / 25.5 |
| India | 0.47 / 0.56 OFF | 0.50 / 0.52 (n 33) | 0.41 / 0.50 (n 50) | 145 / 153 | 26.0 / 25.6 |
| Ireland | 0.46 / 0.45 | 0.45 / 0.45 (n 20) | 0.47 / 0.59 (n 17) | 138 / 138 | 24.0 / 21.5 OFF |
| New Zealand | 0.49 / 0.49 | 0.51 / 0.56 (n 36) | 0.43 / 0.31 (n 32) | 137 / 145 | 23.7 / 22.6 |
| Pakistan | 0.41 / 0.34 | 0.42 / 0.61 (n 23) | 0.41 / 0.29 (n 31) | 133 / 136 | 22.9 / 19.2 OFF |
| South Africa | 0.54 / 0.53 | 0.55 / 0.61 (n 39) | 0.53 / 0.40 (n 45) | 139 / 149 | 26.5 / 26.6 |
| Sri Lanka | 0.33 / 0.41 | 0.37 / 0.50 (n 20) | 0.31 / 0.39 (n 31) | 132 / 113 OFF | 22.1 / 19.5 OFF |
| West Indies | 0.50 / 0.40 | 0.51 / 0.35 (n 34) | 0.49 / 0.44 (n 34) | 133 / 118 OFF | 24.9 / 20.2 OFF |
| Zimbabwe | 0.41 / 0.00 OFF | 0.36 / 0.00 (n 13) OFF | 0.46 / 0.00 (n 12) OFF | 133 / 103 OFF | 23.0 / 14.7 OFF |

After:

| country | win rate sim / real | home sim / real | away sim / real | 1st inns sim / real | runs per wicket sim / real |
|---|---|---|---|---|---|
| Australia | 0.79 / 0.87 | 0.80 / 0.83 (n 35) | 0.75 / 0.87 (n 30) | 151 / 169 OFF | 33.3 / 31.9 |
| Bangladesh | 0.37 / 0.18 OFF | 0.43 / 0.15 (n 20) OFF | 0.34 / 0.13 (n 15) OFF | 124 / 112 OFF | 20.2 / 15.0 OFF |
| England | 0.72 / 0.74 | 0.73 / 0.71 (n 56) | 0.64 / 0.75 (n 32) | 147 / 158 | 28.8 / 25.5 OFF |
| India | 0.53 / 0.56 | 0.53 / 0.52 (n 33) | 0.44 / 0.50 (n 50) | 147 / 153 | 26.8 / 25.6 |
| Ireland | 0.37 / 0.45 | 0.43 / 0.45 (n 20) | 0.33 / 0.59 (n 17) OFF | 134 / 138 | 22.4 / 21.5 |
| New Zealand | 0.44 / 0.49 | 0.49 / 0.56 (n 36) | 0.30 / 0.31 (n 32) | 137 / 145 | 22.4 / 22.6 |
| Pakistan | 0.29 / 0.34 | 0.36 / 0.61 (n 23) OFF | 0.23 / 0.29 (n 31) | 129 / 136 | 20.3 / 19.2 |
| South Africa | 0.66 / 0.53 OFF | 0.73 / 0.61 (n 39) | 0.60 / 0.40 (n 45) OFF | 143 / 149 | 28.6 / 26.6 |
| Sri Lanka | 0.24 / 0.41 OFF | 0.31 / 0.50 (n 20) | 0.21 / 0.39 (n 31) OFF | 129 / 113 OFF | 20.5 / 19.5 |
| West Indies | 0.50 / 0.40 | 0.49 / 0.35 (n 34) | 0.51 / 0.44 (n 34) | 133 / 118 OFF | 24.3 / 20.2 OFF |
| Zimbabwe | 0.20 / 0.00 OFF | 0.23 / 0.00 (n 13) OFF | 0.15 / 0.00 (n 12) OFF | 121 / 103 OFF | 19.4 / 14.7 OFF |

Head to head (sim / real win rate of the first side) outside tolerance: before 13 of 24, after 8 of 24: after: Ireland v Zimbabwe: 0.67 / 1.00 (n 10); Bangladesh v India: 0.26 / 0.08 (n 13); England v West Indies: 0.79 / 0.94 (n 18); Bangladesh v Sri Lanka: 0.52 / 0.09 (n 11); New Zealand v South Africa: 0.41 / 0.71 (n 14); India v West Indies: 0.66 / 0.91 (n 11); England v South Africa: 0.55 / 0.82 (n 11); Pakistan v South Africa: 0.13 / 0.39 (n 18).

### Men's ODI (2019+, 445)

Figures outside tolerance (OFF): before 15, after 15 (of about 6 per country plus the head-to-heads).

Before (no series tuning, the T20I conditions as first fitted):

| country | win rate sim / real | home sim / real | away sim / real | 1st inns sim / real | runs per wicket sim / real |
|---|---|---|---|---|---|
| Australia | 0.54 / 0.59 | 0.59 / 0.65 (n 26) | 0.52 / 0.46 (n 50) | 262 / 276 | 32.9 / 33.7 |
| Bangladesh | 0.54 / 0.47 | 0.52 / 0.68 (n 28) | 0.55 / 0.34 (n 38) OFF | 244 / 258 | 30.1 / 31.0 |
| England | 0.58 / 0.51 | 0.59 / 0.67 (n 48) | 0.57 / 0.35 (n 34) OFF | 285 / 294 | 38.3 / 35.4 |
| India | 0.71 / 0.65 | 0.69 / 0.71 (n 52) | 0.73 / 0.52 (n 46) OFF | 283 / 298 | 38.2 / 41.3 |
| Ireland | 0.30 / 0.31 | 0.36 / 0.36 (n 14) | 0.32 / 0.33 (n 15) | 223 / 248 | 26.7 / 29.1 |
| New Zealand | 0.46 / 0.62 OFF | 0.48 / 0.85 (n 33) OFF | 0.47 / 0.44 (n 43) | 260 / 277 | 32.6 / 34.9 |
| Pakistan | 0.48 / 0.52 | 0.50 / 0.72 (n 36) OFF | 0.44 / 0.40 (n 30) | 261 / 266 | 32.9 / 35.0 |
| South Africa | 0.53 / 0.53 | 0.54 / 0.60 (n 38) | 0.46 / 0.38 (n 24) | 271 / 284 | 35.3 / 37.0 |
| Sri Lanka | 0.40 / 0.43 | 0.39 / 0.72 (n 32) OFF | 0.41 / 0.24 (n 41) OFF | 248 / 251 | 30.4 / 29.1 |
| West Indies | 0.32 / 0.30 | 0.33 / 0.50 (n 38) OFF | 0.29 / 0.14 (n 35) OFF | 239 / 239 | 27.2 / 29.8 |
| Zimbabwe | 0.39 / 0.26 | 0.39 / 0.27 (n 26) | 0.40 / 0.20 (n 15) | 232 / 224 | 27.1 / 25.6 |

After:

| country | win rate sim / real | home sim / real | away sim / real | 1st inns sim / real | runs per wicket sim / real |
|---|---|---|---|---|---|
| Australia | 0.54 / 0.59 | 0.59 / 0.65 (n 26) | 0.52 / 0.46 (n 50) | 262 / 276 | 32.9 / 33.7 |
| Bangladesh | 0.54 / 0.47 | 0.52 / 0.68 (n 28) | 0.55 / 0.34 (n 38) OFF | 244 / 258 | 30.1 / 31.0 |
| England | 0.58 / 0.51 | 0.59 / 0.67 (n 48) | 0.57 / 0.35 (n 34) OFF | 285 / 294 | 38.3 / 35.4 |
| India | 0.71 / 0.65 | 0.69 / 0.71 (n 52) | 0.73 / 0.52 (n 46) OFF | 283 / 298 | 38.2 / 41.3 |
| Ireland | 0.30 / 0.31 | 0.36 / 0.36 (n 14) | 0.32 / 0.33 (n 15) | 223 / 248 | 26.7 / 29.1 |
| New Zealand | 0.46 / 0.62 OFF | 0.48 / 0.85 (n 33) OFF | 0.47 / 0.44 (n 43) | 260 / 277 | 32.6 / 34.9 |
| Pakistan | 0.48 / 0.52 | 0.50 / 0.72 (n 36) OFF | 0.44 / 0.40 (n 30) | 261 / 266 | 32.9 / 35.0 |
| South Africa | 0.53 / 0.53 | 0.54 / 0.60 (n 38) | 0.46 / 0.38 (n 24) | 271 / 284 | 35.3 / 37.0 |
| Sri Lanka | 0.40 / 0.43 | 0.39 / 0.72 (n 32) OFF | 0.41 / 0.24 (n 41) OFF | 248 / 251 | 30.4 / 29.1 |
| West Indies | 0.32 / 0.30 | 0.33 / 0.50 (n 38) OFF | 0.29 / 0.14 (n 35) OFF | 239 / 239 | 27.2 / 29.8 |
| Zimbabwe | 0.39 / 0.26 | 0.39 / 0.27 (n 26) | 0.40 / 0.20 (n 15) | 232 / 224 | 27.1 / 25.6 |

Head to head (sim / real win rate of the first side) outside tolerance: before 5 of 25, after 5 of 25: after: Pakistan v South Africa: 0.34 / 0.67 (n 15); New Zealand v Sri Lanka: 0.66 / 0.90 (n 10); Bangladesh v New Zealand: 0.49 / 0.19 (n 16); Australia v South Africa: 0.57 / 0.25 (n 16); Pakistan v Sri Lanka: 0.62 / 0.89 (n 9).

### Women's ODI (2019+, 323)

Figures outside tolerance (OFF): before 22, after 22 (of about 6 per country plus the head-to-heads).

Before (no series tuning, the T20I conditions as first fitted):

| country | win rate sim / real | home sim / real | away sim / real | 1st inns sim / real | runs per wicket sim / real |
|---|---|---|---|---|---|
| Australia | 0.78 / 0.94 OFF | 0.77 / 0.97 (n 32) OFF | 0.78 / 0.89 (n 28) | 297 / 290 | 48.5 / 44.0 OFF |
| Bangladesh | 0.20 / 0.29 | 0.30 / 0.42 (n 12) | 0.15 / 0.21 (n 14) | 150 / 180 OFF | 15.8 / 21.2 OFF |
| England | 0.70 / 0.63 | 0.70 / 0.68 (n 34) | 0.67 / 0.59 (n 27) | 264 / 257 | 39.2 / 31.3 OFF |
| India | 0.63 / 0.58 | 0.66 / 0.64 (n 36) | 0.60 / 0.50 (n 36) | 282 / 259 OFF | 42.2 / 34.6 OFF |
| Ireland | 0.30 / 0.20 | 0.31 / 0.27 (n 15) | 0.28 / 0.17 (n 23) | 194 / 219 OFF | 22.5 / 23.9 |
| New Zealand | 0.47 / 0.39 | 0.53 / 0.51 (n 39) | 0.39 / 0.18 (n 22) OFF | 244 / 230 | 31.9 / 26.2 OFF |
| Pakistan | 0.42 / 0.35 | 0.47 / 0.56 (n 23) | 0.41 / 0.27 (n 26) | 194 / 214 | 22.2 / 25.8 OFF |
| South Africa | 0.53 / 0.63 | 0.67 / 0.79 (n 24) | 0.47 / 0.55 (n 38) | 237 / 229 | 32.1 / 33.1 |
| Sri Lanka | 0.41 / 0.37 | 0.34 / 0.42 (n 19) | 0.45 / 0.30 (n 23) | 185 / 198 | 21.3 / 24.9 OFF |
| West Indies | 0.32 / 0.40 | 0.25 / 0.33 (n 30) | 0.37 / 0.44 (n 27) | 205 / 187 | 24.4 / 23.0 |
| Zimbabwe | 0.24 / 0.09 OFF | 0.35 / 0.18 (n 11) | 0.13 / 0.00 (n 11) OFF | 203 / 154 OFF | 23.0 / 16.9 OFF |

After:

| country | win rate sim / real | home sim / real | away sim / real | 1st inns sim / real | runs per wicket sim / real |
|---|---|---|---|---|---|
| Australia | 0.76 / 0.94 OFF | 0.74 / 0.97 (n 32) OFF | 0.76 / 0.89 (n 28) OFF | 295 / 290 | 47.7 / 44.0 |
| Bangladesh | 0.19 / 0.29 | 0.28 / 0.42 (n 12) | 0.10 / 0.21 (n 14) | 150 / 180 OFF | 16.1 / 21.2 OFF |
| England | 0.68 / 0.63 | 0.69 / 0.68 (n 34) | 0.67 / 0.59 (n 27) | 266 / 257 | 38.8 / 31.3 OFF |
| India | 0.63 / 0.58 | 0.63 / 0.64 (n 36) | 0.61 / 0.50 (n 36) | 285 / 259 OFF | 42.6 / 34.6 OFF |
| Ireland | 0.28 / 0.20 | 0.28 / 0.27 (n 15) | 0.27 / 0.17 (n 23) | 191 / 219 OFF | 21.6 / 23.9 |
| New Zealand | 0.50 / 0.39 | 0.57 / 0.51 (n 39) | 0.39 / 0.18 (n 22) OFF | 244 / 230 | 33.0 / 26.2 OFF |
| Pakistan | 0.47 / 0.35 OFF | 0.58 / 0.56 (n 23) | 0.40 / 0.27 (n 26) | 204 / 214 | 23.6 / 25.8 |
| South Africa | 0.55 / 0.63 | 0.72 / 0.79 (n 24) | 0.48 / 0.55 (n 38) | 238 / 229 | 32.9 / 33.1 |
| Sri Lanka | 0.37 / 0.37 | 0.33 / 0.42 (n 19) | 0.38 / 0.30 (n 23) | 178 / 198 OFF | 20.2 / 24.9 OFF |
| West Indies | 0.31 / 0.40 | 0.30 / 0.33 (n 30) | 0.34 / 0.44 (n 27) | 207 / 187 | 24.7 / 23.0 |
| Zimbabwe | 0.25 / 0.09 OFF | 0.44 / 0.18 (n 11) OFF | 0.05 / 0.00 (n 11) | 206 / 154 OFF | 23.3 / 16.9 OFF |

Head to head (sim / real win rate of the first side) outside tolerance: before 5 of 13, after 4 of 13: after: Australia v New Zealand: 0.75 / 1.00 (n 12); Australia v England: 0.56 / 0.93 (n 14); New Zealand v South Africa: 0.67 / 0.20 (n 10); Pakistan v West Indies: 0.57 / 0.29 (n 14).

### Men's Test (2023+, 133)

Figures outside tolerance (OFF): before 7, after 7 (of about 6 per country plus the head-to-heads).

Before (no series tuning, the T20I conditions as first fitted):

| country | win rate sim / real | home sim / real | away sim / real | 1st inns sim / real | runs per wicket sim / real |
|---|---|---|---|---|---|
| Australia | 0.67 / 0.69 | 0.81 / 0.75 (n 16) | 0.55 / 0.65 (n 17) | 348 / 329 | 30.9 / 29.7 |
| Bangladesh | 0.42 / 0.46 | 0.59 / 0.50 (n 14) | 0.20 / 0.40 (n 10) | 308 / 236 OFF | 27.8 / 26.4 |
| England | 0.67 / 0.53 | 0.80 / 0.68 (n 22) | 0.51 / 0.33 (n 18) | 386 / 328 OFF | 37.1 / 32.9 OFF |
| India | 0.59 / 0.53 | 0.76 / 0.59 (n 17) | 0.36 / 0.50 (n 12) | 305 / 314 | 30.7 / 31.3 |
| Ireland | 0.15 / 0.22 | 0.30 / 0.50 (n 2) | 0.10 / 0.14 (n 7) | 273 / 285 | 23.1 / 26.0 OFF |
| New Zealand | 0.51 / 0.65 | 0.55 / 0.61 (n 13) | 0.46 / 0.69 (n 13) | 301 / 394 OFF | 31.5 / 33.2 |
| Pakistan | 0.24 / 0.30 | 0.45 / 0.44 (n 9) | 0.14 / 0.21 (n 14) | 288 / 310 | 26.9 / 27.1 |
| South Africa | 0.69 / 0.78 | 0.78 / 0.82 (n 11) | 0.62 / 0.73 (n 11) | 327 / 354 | 29.4 / 32.3 |
| Sri Lanka | 0.43 / 0.40 | 0.63 / 0.50 (n 10) | 0.25 / 0.30 (n 10) | 292 / 359 | 27.6 / 32.1 OFF |
| West Indies | 0.24 / 0.28 | 0.44 / 0.30 (n 10) | 0.11 / 0.27 (n 15) | 246 / 244 | 22.8 / 21.6 |
| Zimbabwe | 0.22 / 0.18 | 0.26 / 0.14 (n 7) | 0.16 / 0.25 (n 4) | 260 / 165 OFF | 23.0 / 21.0 |

After:

| country | win rate sim / real | home sim / real | away sim / real | 1st inns sim / real | runs per wicket sim / real |
|---|---|---|---|---|---|
| Australia | 0.67 / 0.69 | 0.81 / 0.75 (n 16) | 0.55 / 0.65 (n 17) | 348 / 329 | 30.9 / 29.7 |
| Bangladesh | 0.42 / 0.46 | 0.59 / 0.50 (n 14) | 0.20 / 0.40 (n 10) | 308 / 236 OFF | 27.8 / 26.4 |
| England | 0.67 / 0.53 | 0.80 / 0.68 (n 22) | 0.51 / 0.33 (n 18) | 386 / 328 OFF | 37.1 / 32.9 OFF |
| India | 0.59 / 0.53 | 0.76 / 0.59 (n 17) | 0.36 / 0.50 (n 12) | 305 / 314 | 30.7 / 31.3 |
| Ireland | 0.15 / 0.22 | 0.30 / 0.50 (n 2) | 0.10 / 0.14 (n 7) | 273 / 285 | 23.1 / 26.0 OFF |
| New Zealand | 0.51 / 0.65 | 0.55 / 0.61 (n 13) | 0.46 / 0.69 (n 13) | 301 / 394 OFF | 31.5 / 33.2 |
| Pakistan | 0.24 / 0.30 | 0.45 / 0.44 (n 9) | 0.14 / 0.21 (n 14) | 288 / 310 | 26.9 / 27.1 |
| South Africa | 0.69 / 0.78 | 0.78 / 0.82 (n 11) | 0.62 / 0.73 (n 11) | 327 / 354 | 29.4 / 32.3 |
| Sri Lanka | 0.43 / 0.40 | 0.63 / 0.50 (n 10) | 0.25 / 0.30 (n 10) | 292 / 359 | 27.6 / 32.1 OFF |
| West Indies | 0.24 / 0.28 | 0.44 / 0.30 (n 10) | 0.11 / 0.27 (n 15) | 246 / 244 | 22.8 / 21.6 |
| Zimbabwe | 0.22 / 0.18 | 0.26 / 0.14 (n 7) | 0.16 / 0.25 (n 4) | 260 / 165 OFF | 23.0 / 21.0 |

Head to head (sim / real win rate of the first side) outside tolerance: before 0 of 4, after 0 of 4.

# Round 2: weak-nation ratings, home advantage per country, pitch sensitivity

Figures outside tolerance (OFF), 6 replays of each real fixture, before (the tables above) and after this round:

| set | before | after |
|---|---|---|
| men's T20I | 20 | 17 |
| women's T20I | 29 | 22 |
| men's ODI | 15 | 13 |
| women's ODI | 22 | 21 |
| men's Test | 7 | 7 |

Log loss per real match at the shipped tuning (8 replays; 0.693 is a coin flip): men's T20I 0.620 (0.650 at the end of round 1), women's
T20I 0.523 (0.543), men's ODI 0.643 (0.671 with no tuning), women's ODI 0.486 (0.514). The home advantages are fitted on the same
fixtures they are scored on, so part of that gain is in-sample.

## Weak-nation ratings: the evidence did not support a T20 cut

`packages/ratings/src/pipeline/generate-intl-adjust.ts` asks, for every player with caps since 2024 (the app's nations), what his
record against STRONG opposition says. Strong = the national teams at or above the median full member by Bradley-Terry strength of the real
results since 2019 (men: India, Australia, England, New Zealand, South Africa, Pakistan; women: Australia, New Zealand, India, England,
South Africa, Sri Lanka) plus every ball of the top franchise leagues (IPL, BBL, PSL, SA20, CPL, ILT20, MLC, The Hundred, WPL, WBBL). That
record becomes a rating estimate E (the shrunk log-rate score of the strong record, mapped to the game's rating by a fit on the pooled players
with 300+ strong balls; R = 0.71 for men's T20 batting, 0.56 for bowling). The adjustment would be -0.7 x weakness x max(0, rating - E - 5), where
weakness is the share of his balls against weak opposition (rescaled), never positive, at most 20 points; an ODI cut is at most the player's T20 cut.

What it found: **the weaker nations' players are not rated too high by that evidence.** Mean E against rating, men's T20 batting: Zimbabwe 65.8
against 64.2, Sri Lanka 67.2 against 59.7, Bangladesh 65.7 against 59.7, West Indies 72.1 against 69.3. Only the women's weakest sides and the
associates show a shortfall (Zimbabwe women E 51.6 against 56.7, Netherlands women 46.8 against 52). Computing the T20 cut anyway and replaying the
real T20I fixtures made the fit slightly worse (log loss per match: men 0.637 to 0.642, women 0.545 to 0.553); the ODI cut made it slightly
better (men 0.662 to 0.652, women 0.498 to 0.496). So **only the ODI cut ships** (`adjust` in `format-ratings.json`, applied to national sides in
`buildNationSquad`; league play, the T20 ratings and so the league fingerprints are untouched). It moves 468 players by about 1 point on average
(Sri Lanka men's mean ODI cut 1.2, Bangladesh 1.4, Zimbabwe women 1.5, Scotland women 2.2).

The men's T20I sides that win too often (Sri Lanka, West Indies, Zimbabwe) are therefore not an individual-rating problem. West Indies' best eleven
rates 86.3 against New Zealand's 84.7 because Pooran, Russell, Hope and others are elite by every measure, while the side's results are those of its
real, often depleted line-ups: a selection and availability effect the benchmark's best-eleven squads cannot carry. Left as it is.

**The elite players keep their standing.** `packages/app/src/__tests__/elite-players.test.ts` fails if a named elite's shipped cut exceeds 2 points,
and `ELITE_TABLE=1` prints the table for every weaker nation. Afghanistan's players (Rashid Khan, Gurbaz, Omarzai) have no international record
in the Cricsheet data since 2024, so there is no evidence either way and they are not moved. The named players present in the data:

| player | country | craft | T20 rating | estimate from his record vs strong opposition | strong balls | weak share | ODI rating before -> after | T20 rating after |
|---|---|---|---|---|---|---|---|---|
| Mustafizur Rahman | Bangladesh | bowl | 82 | 77 | 1965 | 0.58 | 82 -> 82 | 82 |
| Shakib Al Hasan | Bangladesh | bowl | 80 | 73 | 1374 | 0.61 | 82 -> 81 | 80 |
| Chamari Athapaththu | Sri Lanka W | bat | 79 | 76 | 2278 | 0.55 | 78 -> 78 | 79 |
| Wanindu Hasaranga | Sri Lanka | bowl | 91 | 83 | 2964 | 0.41 | 85 -> 84 | 91 |
| Kusal Mendis | Sri Lanka | bat | 83 | 80 | 1563 | 0.55 | 87 -> 87 | 83 |
| Pathum Nissanka | Sri Lanka | bat | 85 | 81 | 1505 | 0.51 | 84 -> 84 | 85 |
| Hayley Matthews | West Indies W | bat | 80 | 79 | 3845 | 0.33 | 80 -> 80 | 80 |
| Nicholas Pooran | West Indies | bat | 89 | 86 | 6602 | 0.09 | 87 -> 87 | 89 |
| Andre Russell | West Indies | bat | 88 | 81 | 3181 | 0.17 | - | 88 |
| Blessing Muzarabani | Zimbabwe | bowl | 83 | 79 | 1361 | 0.48 | 75 -> 75 | 83 |
| Sikandar Raza | Zimbabwe | bat | 79 | 75 | 2151 | 0.48 | 81 -> 81 | 79 |


The best players of each weaker nation (top four by rating; "estimate" is what his record against strong opposition alone says, in rating points;
the ODI column is the shipped change, T20 ratings are unchanged):

| player | country | craft | T20 rating | estimate from his record vs strong opposition | strong balls | weak share | ODI rating before -> after | T20 rating after |
|---|---|---|---|---|---|---|---|---|
| Nahida Akter | Bangladesh W | bowl | 73 | 68 | 866 | 0.49 | 77 -> 77 | 73 |
| Rabeya Khan | Bangladesh W | bowl | 74 | 71 | 542 | 0.54 | 76 -> 76 | 74 |
| Sultana Khatun | Bangladesh W | bowl | 73 | 70 | 330 | 0.31 | 76 -> 76 | 73 |
| Fahima Khatun | Bangladesh W | bowl | 74 | 70 | 510 | 0.45 | 74 -> 74 | 74 |
| Towhid Hridoy | Bangladesh | bat | 82 | 75 | 464 | 0.82 | 85 -> 85 | 82 |
| Tanzid Hasan | Bangladesh | bat | 79 | 67 | 198 | 0.89 | 83 -> 82 | 79 |
| Mustafizur Rahman | Bangladesh | bowl | 82 | 77 | 1965 | 0.58 | 82 -> 82 | 82 |
| Shakib Al Hasan | Bangladesh | bowl | 80 | 73 | 1374 | 0.61 | 82 -> 81 | 80 |
| Terisha Lavia | Canada W | bowl | 68 | 53 | 0 | 1 | - | 68 |
| Tiffany Thorpe | Canada W | bowl | 64 | 53 | 0 | 1 | 66 -> 46 | 64 |
| Achini Perera | Canada W | bowl | 64 | 53 | 0 | 1 | - | 64 |
| Amarpal Kaur | Canada W | bowl | 64 | 53 | 0 | 1 | - | 64 |
| Yuvraaj Samra | Canada | bat | 78 | 78 | 73 | 0.84 | 71 -> 56 | 78 |
| Dilon Heyliger | Canada | bat | 75 | 71 | 19 | 0.92 | 40 -> 40 | 75 |
| Ammar Khalid | Canada | bowl | 75 | 54 | 0 | 1 | 63 -> 43 | 75 |
| Nikhil Dutta | Canada | bowl | 74 | 54 | 0 | 1 | 67 -> 47 | 74 |
| Gaby Lewis | Ireland W | bat | 75 | 71 | 517 | 0.8 | 75 -> 75 | 75 |
| Amy Hunter | Ireland W | bat | 72 | 51 | 74 | 0.95 | 75 -> 75 | 72 |
| Orla Prendergast | Ireland W | bat | 73 | 67 | 451 | 0.76 | 72 -> 72 | 73 |
| Arlene Kelly | Ireland W | bowl | 72 | 66 | 290 | 0.86 | 71 -> 70 | 72 |
| Curtis Campher | Ireland | bat | 77 | 66 | 229 | 0.81 | 79 -> 79 | 77 |
| Gareth Delany | Ireland | bat | 77 | 71 | 178 | 0.87 | 68 -> 65 | 77 |
| Harry Tector | Ireland | bat | 72 | 70 | 502 | 0.79 | 76 -> 76 | 72 |
| Mark Adair | Ireland | bat | 76 | 64 | 281 | 0.7 | 48 -> 48 | 76 |
| Wilka Mwatile | Namibia W | bowl | 66 | 60 | 12 | 0.99 | - | 66 |
| Victoria Hamunyela | Namibia W | bowl | 66 | 58 | 6 | 0.99 | - | 66 |
| Jurriene Diergaardt | Namibia W | bowl | 65 | 53 | 0 | 1 | - | 65 |
| Kayleen Green | Namibia W | bowl | 64 | 62 | 12 | 0.99 | - | 64 |
| Gerhard Erasmus | Namibia | bat | 76 | 69 | 549 | 0.76 | 71 -> 71 | 76 |
| David Wiese | Namibia | bat | 76 | 75 | 1069 | 0.53 | 75 -> 75 | 76 |
| JJ Smit | Namibia | bat | 75 | 59 | 76 | 0.92 | 43 -> 43 | 75 |
| Bernard Scholtz | Namibia | bowl | 74 | 63 | 120 | 0.93 | 73 -> 56 | 74 |
| Sita Rana Magar | Nepal W | bowl | 67 | 62 | 24 | 0.98 | - | 67 |
| Rubina Chhetry | Nepal W | bowl | 67 | 57 | 6 | 1 | - | 67 |
| Kabita Kunwar | Nepal W | bowl | 65 | 58 | 12 | 0.99 | - | 65 |
| Indu Barma | Nepal W | bowl | 65 | 60 | 24 | 0.97 | - | 65 |
| Dipendra Singh Airee | Nepal | bat | 82 | 72 | 55 | 0.97 | 69 -> 65 | 82 |
| Sandeep Lamichhane | Nepal | bowl | 81 | 79 | 1598 | 0.59 | 79 -> 79 | 81 |
| Kushal Bhurtel | Nepal | bat | 75 | 69 | 70 | 0.96 | 66 -> 65 | 75 |
| Sher Malla | Nepal | bowl | 74 | 61 | 18 | 0.96 | - | 74 |
| Iris Zwilling | Netherlands W | bowl | 67 | 62 | 72 | 0.96 | 71 -> 58 | 67 |
| Sterre Kalis | Netherlands W | bat | 70 | 69 | 463 | 0.86 | 67 -> 67 | 70 |
| Caroline de Lange | Netherlands W | bowl | 67 | 64 | 72 | 0.96 | 69 -> 62 | 67 |
| Annemijn van Beuge | Netherlands W | bowl | 68 | 53 | 0 | 1 | 32 -> 31 | 68 |
| Bas de Leede | Netherlands | bat | 76 | 72 | 229 | 0.81 | 73 -> 73 | 76 |
| Aryan Dutt | Netherlands | bowl | 74 | 68 | 48 | 0.94 | 75 -> 73 | 74 |
| Roelof van der Merwe | Netherlands | bowl | 74 | 77 | 705 | 0.77 | 75 -> 75 | 74 |
| Timm van der Gugten | Netherlands | bat | 59 | 67 | 1 | 1 | 50 -> 50 | 59 |
| Cynthia Saldanha | Oman W | bat | 40 | 38 | 0 | 1 | - | 40 |
| Aamer Kaleem | Oman | bowl | 66 | 68 | 42 | 0.93 | 74 -> 54 | 66 |
| Naseem Khushi | Oman | bat | 58 | 67 | 0 | 1 | 62 -> 53 | 58 |
| Mohammad Nadeem | Oman | bowl | 53 | 61 | 24 | 0.97 | 32 -> 27 | 53 |
| Kirstie Gordon | Scotland W | bowl | 75 | 72 | 841 | 0.68 | 75 -> 75 | 75 |
| Kathryn Bryce | Scotland W | bat | 73 | 66 | 601 | 0.8 | 72 -> 71 | 73 |
| Saskia Horley | Scotland W | bat | 73 | 54 | 80 | 0.77 | 69 -> 54 | 73 |
| Abtaha Maqsood | Scotland W | bowl | 68 | 64 | 284 | 0.85 | 73 -> 53 | 68 |
| Brandon McMullen | Scotland | bat | 81 | 76 | 322 | 0.72 | 77 -> 77 | 81 |
| Josh Davey | Scotland | bowl | 71 | 54 | 0 | 1 | 76 -> 56 | 71 |
| Richie Berrington | Scotland | bat | 75 | 74 | 176 | 0.86 | 69 -> 63 | 75 |
| Hamza Tahir | Scotland | bowl | 75 | 64 | 66 | 0.76 | 74 -> 59 | 75 |
| Chamari Athapaththu | Sri Lanka W | bat | 79 | 76 | 2278 | 0.55 | 78 -> 78 | 79 |
| Kavisha Dilhari | Sri Lanka W | bowl | 74 | 68 | 674 | 0.58 | 73 -> 73 | 74 |
| Sugandika Kumari | Sri Lanka W | bowl | 73 | 65 | 643 | 0.59 | 72 -> 71 | 73 |
| Inoshi Fernando | Sri Lanka W | bowl | 73 | 68 | 341 | 0.49 | 73 -> 73 | 73 |
| Wanindu Hasaranga | Sri Lanka | bowl | 91 | 83 | 2964 | 0.41 | 85 -> 84 | 91 |
| Kusal Mendis | Sri Lanka | bat | 83 | 80 | 1563 | 0.55 | 87 -> 87 | 83 |
| Dasun Shanaka | Sri Lanka | bat | 87 | 76 | 1561 | 0.44 | 82 -> 82 | 87 |
| Pathum Nissanka | Sri Lanka | bat | 85 | 81 | 1505 | 0.51 | 84 -> 84 | 85 |
| Suraksha Kotte | UAE W | bowl | 66 | 62 | 36 | 0.96 | 73 -> 53 | 66 |
| Katie Thompson | UAE W | bowl | 69 | 53 | 0 | 1 | 73 -> 53 | 69 |
| Michelle Botha | UAE W | bowl | 68 | 53 | 0 | 1 | 71 -> 51 | 68 |
| Kavisha Egodage | UAE W | bowl | 70 | 63 | 42 | 0.95 | - | 70 |
| Alishan Sharafu | UAE | bat | 79 | 76 | 737 | 0.62 | 69 -> 69 | 79 |
| Aayan Afzal Khan | UAE | bowl | 77 | 79 | 395 | 0.6 | 75 -> 75 | 77 |
| Muhammad Waseem | UAE | bat | 77 | 79 | 1139 | 0.62 | 69 -> 69 | 77 |
| Ajay Kumar | UAE | bowl | 76 | 74 | 270 | 0.08 | 73 -> 53 | 76 |
| Aditiba Chudasama | USA W | bowl | 64 | 61 | 24 | 0.97 | 71 -> 51 | 64 |
| Tara Norris | USA W | bowl | 71 | 70 | 392 | 0.79 | 71 -> 71 | 71 |
| Saanvi Immadi | USA W | bowl | 63 | 62 | 24 | 0.94 | 71 -> 51 | 63 |
| Sainavi Kambalapalli | USA W | bowl | 68 | 53 | 0 | 1 | - | 68 |
| Andries Gous | USA | bat | 84 | 83 | 1541 | 0.36 | 80 -> 80 | 84 |
| Hassan Khan | USA | bat | 82 | 76 | 820 | 0 | - | 82 |
| Harmeet Singh | USA | bowl | 78 | 76 | 824 | 0.55 | 74 -> 74 | 78 |
| Shubham Ranjane | USA | bat | 77 | 81 | 647 | 0.38 | 75 -> 75 | 77 |
| Hayley Matthews | West Indies W | bat | 80 | 79 | 3845 | 0.33 | 80 -> 80 | 80 |
| Chinelle Henry | West Indies W | bat | 79 | 70 | 836 | 0.37 | 76 -> 75 | 79 |
| Afy Fletcher | West Indies W | bowl | 74 | 71 | 1086 | 0.52 | 77 -> 77 | 74 |
| Deandra Dottin | West Indies W | bat | 75 | 75 | 1608 | 0.46 | 74 -> 74 | 75 |
| Shimron Hetmyer | West Indies | bat | 90 | 81 | 4320 | 0.07 | 85 -> 85 | 90 |
| Nicholas Pooran | West Indies | bat | 89 | 86 | 6602 | 0.09 | 87 -> 87 | 89 |
| Romario Shepherd | West Indies | bat | 88 | 79 | 1577 | 0.1 | 48 -> 48 | 88 |
| Andre Russell | West Indies | bat | 88 | 81 | 3181 | 0.17 | - | 88 |
| Mary-Anne Musonda | Zimbabwe W | bat | 70 | 46 | 6 | 0.99 | 64 -> 52 | 70 |
| Lindokuhle Mabhero | Zimbabwe W | bowl | 66 | 60 | 41 | 0.93 | 69 -> 49 | 66 |
| Josephine Nkomo | Zimbabwe W | bowl | 68 | 61 | 30 | 0.97 | 32 -> 31 | 68 |
| Michelle Mavunga | Zimbabwe W | bat | 68 | 58 | 75 | 0.42 | 30 -> 30 | 68 |
| Blessing Muzarabani | Zimbabwe | bowl | 83 | 79 | 1361 | 0.48 | 75 -> 75 | 83 |
| Brian Bennett | Zimbabwe | bat | 81 | 76 | 438 | 0.69 | 77 -> 77 | 81 |
| Sikandar Raza | Zimbabwe | bat | 79 | 75 | 2151 | 0.48 | 81 -> 81 | 79 |
| Ryan Burl | Zimbabwe | bat | 78 | 70 | 419 | 0.8 | 73 -> 71 | 78 |


## Home advantage per country

The ODI engine already carries the measured conditions of each country's grounds (`homeGrounds`, `getOdiVenueProfile`), and they apply to both sides
alike, which is why the real home edge (men's ODI home sides win 65%) did not appear. `series-tuning.ts` now has the home advantage per host
country (`homeBy`): every fixture replayed at a grid of home advantages, a country's loss the log-likelihood of the real results of the fixtures it
hosted plus a pull toward the set's own best uniform value (a prior of 4 rating points). The uniform value rose (men's T20I 4, women's 6, men's ODI 8,
women's 12: the first fit's grid stopped too early) and the countries that differ are few: Australia 8 and India 6 (men's T20I), Pakistan 12 and
India 8 (women's T20I), Bangladesh, Australia, England, Sri Lanka and Zimbabwe 10-12 (men's ODI), Australia, New Zealand, West Indies and South
Africa 14 (women's ODI). With 10-60 hosted matches a country the data cannot separate stays on the uniform value. This is a rating shift, **not** a
model of pitches: the pace / spin balance and scoring of each ground were already in the ODI engine, and a home-specific pitch effect did not show up
beyond them.

## Pitch sensitivity of players: tested, not shipped

What the engine already has (docs/ENGINE-VENUES-AND-INJURIES.md, VENUE-CONDITIONS-REPORT.md): a measured run / six / wicket factor per ground (the
wicket effect at 25%) and bowler-type edges (pace and spin types) per ground and region. Players are not individual: every bowler of a type reads the
same edge. docs/VENUE-SENSITIVITY.md tests per-player slopes (empirical-Bayes random effects on how a batter's or bowler's rate moves with the
venue's flatness and with its spin-friendliness, validated on the seasons after 2024): they do not improve out-of-sample likelihood at the estimated
between-player spread, and gain at most 0.07 log-likelihood per 1,000 balls under heavy shrinkage. Nothing was added to the ball model, so the IPL and
the other league fingerprints are unchanged.

## Tables after round 2

### Men's T20I, after round 2

| country | win rate sim / real | home sim / real | away sim / real | 1st inns sim / real | runs per wicket sim / real |
|---|---|---|---|---|---|
| Australia | 0.52 / 0.60 | 0.62 / 0.67 (n 30) | 0.46 / 0.54 (n 56) | 171 / 177 | 30.5 / 26.5 OFF |
| Bangladesh | 0.38 / 0.41 | 0.47 / 0.58 (n 43) | 0.34 / 0.36 (n 33) | 157 / 143 OFF | 24.2 / 20.8 OFF |
| England | 0.55 / 0.63 | 0.66 / 0.72 (n 36) | 0.48 / 0.57 (n 56) | 166 / 190 OFF | 26.5 / 28.4 |
| India | 0.68 / 0.70 | 0.75 / 0.73 (n 73) | 0.58 / 0.63 (n 54) | 172 / 188 OFF | 29.4 / 30.4 |
| Ireland | 0.36 / 0.28 | 0.36 / 0.27 (n 22) | 0.36 / 0.38 (n 16) | 158 / 156 | 23.7 / 20.2 OFF |
| New Zealand | 0.50 / 0.53 | 0.55 / 0.56 (n 63) | 0.43 / 0.48 (n 46) | 164 / 174 | 25.9 / 25.9 |
| Pakistan | 0.54 / 0.52 | 0.62 / 0.66 (n 47) | 0.49 / 0.42 (n 57) | 164 / 164 | 27.0 / 24.6 OFF |
| South Africa | 0.42 / 0.51 | 0.41 / 0.38 (n 32) | 0.36 / 0.50 (n 50) | 165 / 172 | 27.6 / 26.2 |
| Sri Lanka | 0.46 / 0.36 OFF | 0.52 / 0.37 (n 35) | 0.35 / 0.29 (n 48) | 165 / 152 OFF | 26.4 / 20.6 OFF |
| West Indies | 0.49 / 0.41 | 0.54 / 0.48 (n 63) | 0.43 / 0.34 (n 41) | 167 / 177 | 28.3 / 24.9 OFF |
| Zimbabwe | 0.39 / 0.29 | 0.39 / 0.32 (n 37) | 0.41 / 0.21 (n 24) OFF | 158 / 144 OFF | 23.9 / 19.2 OFF |

Head to head outside tolerance: 3 of 37: Bangladesh v Pakistan: 0.29 / 0.13 (n 16); Bangladesh v Zimbabwe: 0.53 / 0.74 (n 19); England v Sri Lanka: 0.68 / 1.00 (n 9).

### Women's T20I, after round 2

| country | win rate sim / real | home sim / real | away sim / real | 1st inns sim / real | runs per wicket sim / real |
|---|---|---|---|---|---|
| Australia | 0.81 / 0.87 | 0.81 / 0.83 (n 35) | 0.77 / 0.87 (n 30) | 151 / 169 OFF | 32.6 / 31.9 |
| Bangladesh | 0.35 / 0.18 OFF | 0.39 / 0.15 (n 20) OFF | 0.30 / 0.13 (n 15) | 125 / 112 OFF | 20.2 / 15.0 OFF |
| England | 0.70 / 0.74 | 0.72 / 0.71 (n 56) | 0.59 / 0.75 (n 32) OFF | 148 / 158 | 28.8 / 25.5 OFF |
| India | 0.54 / 0.56 | 0.57 / 0.52 (n 33) | 0.43 / 0.50 (n 50) | 147 / 153 | 27.3 / 25.6 |
| Ireland | 0.39 / 0.45 | 0.42 / 0.45 (n 20) | 0.38 / 0.59 (n 17) | 132 / 138 | 21.8 / 21.5 |
| New Zealand | 0.50 / 0.49 | 0.59 / 0.56 (n 36) | 0.35 / 0.31 (n 32) | 138 / 145 | 23.1 / 22.6 |
| Pakistan | 0.32 / 0.34 | 0.50 / 0.61 (n 23) | 0.21 / 0.29 (n 31) | 129 / 136 | 21.2 / 19.2 OFF |
| South Africa | 0.63 / 0.53 OFF | 0.74 / 0.61 (n 39) | 0.53 / 0.40 (n 45) | 142 / 149 | 27.9 / 26.6 |
| Sri Lanka | 0.25 / 0.41 OFF | 0.40 / 0.50 (n 20) | 0.17 / 0.39 (n 31) OFF | 129 / 113 OFF | 20.3 / 19.5 |
| West Indies | 0.46 / 0.40 | 0.48 / 0.35 (n 34) | 0.41 / 0.44 (n 34) | 132 / 118 OFF | 24.3 / 20.2 OFF |
| Zimbabwe | 0.15 / 0.00 OFF | 0.22 / 0.00 (n 13) OFF | 0.04 / 0.00 (n 12) | 118 / 103 | 19.0 / 14.7 OFF |

Head to head outside tolerance: 5 of 24: Ireland v Zimbabwe: 0.70 / 1.00 (n 10); Bangladesh v Sri Lanka: 0.48 / 0.09 (n 11); India v West Indies: 0.58 / 0.91 (n 11); England v South Africa: 0.58 / 0.82 (n 11); England v New Zealand: 0.64 / 0.81 (n 21).

### Men's ODI, after round 2

| country | win rate sim / real | home sim / real | away sim / real | 1st inns sim / real | runs per wicket sim / real |
|---|---|---|---|---|---|
| Australia | 0.59 / 0.59 | 0.61 / 0.65 (n 26) | 0.56 / 0.46 (n 50) | 262 / 276 | 32.3 / 33.7 |
| Bangladesh | 0.52 / 0.47 | 0.53 / 0.68 (n 28) | 0.50 / 0.34 (n 38) OFF | 246 / 258 | 29.8 / 31.0 |
| England | 0.56 / 0.51 | 0.56 / 0.67 (n 48) | 0.55 / 0.35 (n 34) OFF | 285 / 294 | 38.1 / 35.4 |
| India | 0.69 / 0.65 | 0.68 / 0.71 (n 52) | 0.72 / 0.52 (n 46) OFF | 281 / 298 | 37.5 / 41.3 |
| Ireland | 0.29 / 0.31 | 0.34 / 0.36 (n 14) | 0.31 / 0.33 (n 15) | 233 / 248 | 27.1 / 29.1 |
| New Zealand | 0.47 / 0.62 OFF | 0.49 / 0.85 (n 33) OFF | 0.49 / 0.44 (n 43) | 257 / 277 | 32.5 / 34.9 |
| Pakistan | 0.44 / 0.52 | 0.46 / 0.72 (n 36) OFF | 0.45 / 0.40 (n 30) | 256 / 266 | 32.2 / 35.0 |
| South Africa | 0.52 / 0.53 | 0.54 / 0.60 (n 38) | 0.48 / 0.38 (n 24) | 269 / 284 | 34.3 / 37.0 |
| Sri Lanka | 0.44 / 0.43 | 0.47 / 0.72 (n 32) OFF | 0.41 / 0.24 (n 41) OFF | 255 / 251 | 31.4 / 29.1 |
| West Indies | 0.32 / 0.30 | 0.35 / 0.50 (n 38) | 0.28 / 0.14 (n 35) OFF | 237 / 239 | 27.2 / 29.8 |
| Zimbabwe | 0.38 / 0.26 | 0.39 / 0.27 (n 26) | 0.36 / 0.20 (n 15) | 236 / 224 | 28.1 / 25.6 |

Head to head outside tolerance: 4 of 25: New Zealand v Sri Lanka: 0.60 / 0.90 (n 10); Bangladesh v New Zealand: 0.49 / 0.19 (n 16); Australia v South Africa: 0.56 / 0.25 (n 16); Pakistan v Sri Lanka: 0.51 / 0.89 (n 9).

### Women's ODI, after round 2

| country | win rate sim / real | home sim / real | away sim / real | 1st inns sim / real | runs per wicket sim / real |
|---|---|---|---|---|---|
| Australia | 0.81 / 0.94 OFF | 0.79 / 0.97 (n 32) OFF | 0.80 / 0.89 (n 28) | 295 / 290 | 48.6 / 44.0 OFF |
| Bangladesh | 0.21 / 0.29 | 0.28 / 0.42 (n 12) | 0.20 / 0.21 (n 14) | 161 / 180 | 16.9 / 21.2 OFF |
| England | 0.64 / 0.63 | 0.64 / 0.68 (n 34) | 0.63 / 0.59 (n 27) | 273 / 257 | 40.8 / 31.3 OFF |
| India | 0.64 / 0.58 | 0.66 / 0.64 (n 36) | 0.60 / 0.50 (n 36) | 285 / 259 OFF | 40.3 / 34.6 OFF |
| Ireland | 0.32 / 0.20 | 0.31 / 0.27 (n 15) | 0.33 / 0.17 (n 23) | 204 / 219 | 24.2 / 23.9 |
| New Zealand | 0.50 / 0.39 | 0.53 / 0.51 (n 39) | 0.44 / 0.18 (n 22) OFF | 243 / 230 | 32.5 / 26.2 OFF |
| Pakistan | 0.48 / 0.35 OFF | 0.59 / 0.56 (n 23) | 0.43 / 0.27 (n 26) | 212 / 214 | 26.0 / 25.8 |
| South Africa | 0.51 / 0.63 OFF | 0.68 / 0.79 (n 24) | 0.44 / 0.55 (n 38) | 234 / 229 | 30.8 / 33.1 |
| Sri Lanka | 0.37 / 0.37 | 0.35 / 0.42 (n 19) | 0.38 / 0.30 (n 23) | 179 / 198 | 19.9 / 24.9 OFF |
| West Indies | 0.31 / 0.40 | 0.26 / 0.33 (n 30) | 0.35 / 0.44 (n 27) | 209 / 187 | 24.6 / 23.0 |
| Zimbabwe | 0.21 / 0.09 | 0.30 / 0.18 (n 11) | 0.11 / 0.00 (n 11) OFF | 209 / 154 OFF | 24.2 / 16.9 OFF |

Head to head outside tolerance: 6 of 13: Australia v New Zealand: 0.82 / 1.00 (n 12); Australia v England: 0.70 / 0.93 (n 14); New Zealand v South Africa: 0.60 / 0.20 (n 10); Australia v India: 0.65 / 0.83 (n 18); England v New Zealand: 0.59 / 0.81 (n 16); Pakistan v West Indies: 0.61 / 0.29 (n 14).

### Men's Test, after round 2

| country | win rate sim / real | home sim / real | away sim / real | 1st inns sim / real | runs per wicket sim / real |
|---|---|---|---|---|---|
| Australia | 0.67 / 0.69 | 0.81 / 0.75 (n 16) | 0.55 / 0.65 (n 17) | 348 / 329 | 30.9 / 29.7 |
| Bangladesh | 0.42 / 0.46 | 0.59 / 0.50 (n 14) | 0.20 / 0.40 (n 10) | 308 / 236 OFF | 27.8 / 26.4 |
| England | 0.67 / 0.53 | 0.80 / 0.68 (n 22) | 0.51 / 0.33 (n 18) | 386 / 328 OFF | 37.1 / 32.9 OFF |
| India | 0.59 / 0.53 | 0.76 / 0.59 (n 17) | 0.36 / 0.50 (n 12) | 305 / 314 | 30.7 / 31.3 |
| Ireland | 0.15 / 0.22 | 0.30 / 0.50 (n 2) | 0.10 / 0.14 (n 7) | 273 / 285 | 23.1 / 26.0 OFF |
| New Zealand | 0.51 / 0.65 | 0.55 / 0.61 (n 13) | 0.46 / 0.69 (n 13) | 301 / 394 OFF | 31.5 / 33.2 |
| Pakistan | 0.24 / 0.30 | 0.45 / 0.44 (n 9) | 0.14 / 0.21 (n 14) | 288 / 310 | 26.9 / 27.1 |
| South Africa | 0.69 / 0.78 | 0.78 / 0.82 (n 11) | 0.62 / 0.73 (n 11) | 327 / 354 | 29.4 / 32.3 |
| Sri Lanka | 0.43 / 0.40 | 0.63 / 0.50 (n 10) | 0.25 / 0.30 (n 10) | 292 / 359 | 27.6 / 32.1 OFF |
| West Indies | 0.24 / 0.28 | 0.44 / 0.30 (n 10) | 0.11 / 0.27 (n 15) | 246 / 244 | 22.8 / 21.6 |
| Zimbabwe | 0.22 / 0.18 | 0.26 / 0.14 (n 7) | 0.16 / 0.25 (n 4) | 260 / 165 OFF | 23.0 / 21.0 |

Head to head outside tolerance: 0 of 4.

