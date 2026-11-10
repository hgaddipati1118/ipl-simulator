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
