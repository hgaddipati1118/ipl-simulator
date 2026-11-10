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
0.24 / 0.24, women 0.23 / 0.46. T20I level against the real fixtures (3 replays): men 164.0 (sd 35.4), 200+ 15.2% (real 169.5, 37.3,
19.2%); women 140.6 (31.2), 3.1% (real 142.2, 34.6, 5.1%).

Men's ODI gained nothing from either parameter: the ODI model's own team spread and the venue tables already put its sides where the
real results are. The real ODI home advantage (65% for men) is **not** explained by a uniform rating shift (New Zealand 0.85 at home,
0.44 away; Sri Lanka 0.72 / 0.24): it is pitches and conditions of particular countries, which the neutral-ground ODI replay has no
way to carry. Left as it is.

## Left over

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

