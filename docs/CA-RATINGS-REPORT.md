# CricketArchive per-year ratings, age curves and projections

Output `ca_ratings_by_year.parquet`: 266,956 player x format x year rows, 37,165 players, 2000-2026, every senior format (T20, List A, first-class), men and women. Built by `ca-player-seasons.sql` -> `ca-ratings.py` -> this report (`ca-ratings-report.py`). All values are runs per 100 balls above the average ball in the same competition-season, after competition/opponent adjustment; `*_ovr` is 65 + 11 z against that year's regulars, clipped 25-99.

## 1. Method

- **Cells.** Every senior scorecard innings since 2000 with balls recorded -> player x competition x year. Batting value = runs - balls x rpb - (outs - balls x opb) x W; bowling the mirror image; rpb/opb are the competition-season rates (blended toward the format-year average with a 3000-ball prior). W, the run value of a wicket, is 0.3 / 0.5 / 1.0 x the competition-season runs per wicket for T20 / List A / first-class.
- **Competitions.** Domestic = event name without season or group. Internationals are split by opponent (`T20I v India`), so opponent strength in international cricket is learned the same way as league strength.
- **Strength.** rate[p,c,y] = skill[p,y] - strength[c], alternating weighted least squares over player-years that played 2+ competitions that year. Each competition's strength is shrunk toward its class mean (country for domestic; full-member vs associate opponent for internationals), which is shrunk toward a full-member / associate mean, then 0. Without that hierarchy, unlinked associate competitions defaulted to "average" and associate bowlers topped the T20 list.
- **Weak-tier translation.** For the bottom 30% of balls by strength, a' = alpha + rho x a, fitted on players with balls in both tiers in the same year, with an errors-in-variables correction (raw regression pinned rho at its 0.3 floor because of noise in the weak-tier value).
- **Ratings.** `*_rating` = exponentially decayed (half-life h years) ball-weighted mean of a' up to that year, shrunk toward a prior worth K balls (the player's competition pool level + a role offset: batting position bucket, or pace/spin). `*_season` = the same shrinkage on that year alone. h, K and a trend weight were tuned on a 2020 -> 2021-22 fold.
- **Age curves.** Delta method on consecutive shrunk season values of the same player, weighted by the harmonic mean of balls, smoothed +-2 years, role curves shrunk toward the all-player curve, and centred so the mean change is zero (values are league-relative, so ageing is zero-sum; the raw mean change is survivor bias).
- **Projection.** `*_proj_next` = rating + age-curve change at the player's age (+ trend term where tuning chose one).
- **Data fix.** cricket.db's `matches.gender` marks ~2,300 men's matches as female (e.g. the 2015 World Cup); gender is taken from `levels` instead. Worth fixing in `scorecard-parse.ts`.

## 2. Validation (fit through 2023, predict each player's 2024-25 adjusted value)

Target = the player's mean adjusted value over 2024-25 (>= 100 / 200 / 500 balls for T20 / List A / FC), weighted by those balls. `corr` = weighted correlation, `mse` in (runs per 100 balls)^2. 2024-25 was not used for tuning. Caveat: the target is on this model's own adjusted scale, which favours it over the Cricsheet model; the comparison with the current model is correlation on shared players only.

**bat/FC/female** (half-life 2.0 y, K 500 balls, trend 0.0; translation rho 1.0, 1 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 6 | 0.514 | 1161.4 |
| new: + age curve | 6 | 0.514 | 1161.4 |
| new: + age curve + trend (final) | 6 | 0.514 | 1161.4 |
| naive: career raw value to cutoff | 6 | 0.65 | 860.1 |
| naive: last season raw value | 1 | nan | 1049.9 |
| new (final), same players as last-season baseline | 1 | nan | 2839.0 |

**bat/FC/male** (half-life 3.0 y, K 1000 balls, trend 0.0; translation rho 1.0, 659 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 1217 | 0.63 | 253.6 |
| new: + age curve | 1217 | 0.632 | 255.0 |
| new: + age curve + trend (final) | 1217 | 0.632 | 255.0 |
| naive: career raw value to cutoff | 1217 | 0.137 | 5815.7 |
| naive: last season raw value | 763 | 0.314 | 458.5 |
| new (final), same players as last-season baseline | 763 | 0.595 | 212.0 |

**bat/ListA/female** (half-life 2.0 y, K 200 balls, trend 0.0; translation rho 0.747, 184 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 788 | 0.727 | 267.4 |
| new: + age curve | 788 | 0.722 | 273.4 |
| new: + age curve + trend (final) | 788 | 0.722 | 273.4 |
| naive: career raw value to cutoff | 788 | 0.4 | 1558.8 |
| naive: last season raw value | 436 | 0.481 | 472.7 |
| new (final), same players as last-season baseline | 436 | 0.735 | 216.4 |

**bat/ListA/male** (half-life 1.0 y, K 400 balls, trend 0.0; translation rho 1.0, 1295 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 1008 | 0.539 | 309.3 |
| new: + age curve | 1008 | 0.541 | 309.2 |
| new: + age curve + trend (final) | 1008 | 0.541 | 309.2 |
| naive: career raw value to cutoff | 1008 | 0.175 | 2605.0 |
| naive: last season raw value | 660 | 0.282 | 565.8 |
| new (final), same players as last-season baseline | 660 | 0.545 | 272.8 |

**bat/T20/female** (half-life 5.0 y, K 200 balls, trend 0.0; translation rho 0.383, 260 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 1042 | 0.789 | 267.7 |
| new: + age curve | 1042 | 0.791 | 267.8 |
| new: + age curve + trend (final) | 1042 | 0.791 | 267.8 |
| naive: career raw value to cutoff | 1042 | 0.573 | 888.5 |
| naive: last season raw value | 619 | 0.551 | 610.5 |
| new (final), same players as last-season baseline | 619 | 0.803 | 237.7 |
| current Cricsheet model (T20 only) | 171 | 0.751 |  |
| new (final), same players as current model | 171 | 0.801 | 209.6 |

**bat/T20/male** (half-life 2.0 y, K 400 balls, trend 0.0; translation rho 0.95, 947 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 1420 | 0.637 | 356.8 |
| new: + age curve | 1420 | 0.64 | 354.9 |
| new: + age curve + trend (final) | 1420 | 0.64 | 354.9 |
| naive: career raw value to cutoff | 1420 | 0.412 | 1277.6 |
| naive: last season raw value | 812 | 0.371 | 704.0 |
| new (final), same players as last-season baseline | 812 | 0.634 | 288.7 |
| current Cricsheet model (T20 only) | 519 | 0.562 |  |
| new (final), same players as current model | 519 | 0.633 | 229.4 |

**bowl/FC/female** (half-life 5.0 y, K 500 balls, trend 0.0; translation rho 1.0, 1 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 6 | 0.722 | 444.3 |
| new: + age curve | 6 | 0.722 | 444.3 |
| new: + age curve + trend (final) | 6 | 0.722 | 444.3 |
| naive: career raw value to cutoff | 6 | 0.706 | 427.9 |
| naive: last season raw value | 3 | 0.743 | 1311.7 |
| new (final), same players as last-season baseline | 3 | 0.891 | 760.9 |

**bowl/FC/male** (half-life 5.0 y, K 4000 balls, trend 0.5; translation rho 0.497, 901 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 1013 | 0.437 | 194.9 |
| new: + age curve | 1013 | 0.431 | 196.5 |
| new: + age curve + trend (final) | 1013 | 0.432 | 196.5 |
| naive: career raw value to cutoff | 1013 | 0.256 | 437.3 |
| naive: last season raw value | 679 | 0.318 | 408.0 |
| new (final), same players as last-season baseline | 679 | 0.465 | 165.4 |

**bowl/ListA/female** (half-life 5.0 y, K 1600 balls, trend 0.0; translation rho 0.437, 234 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 729 | 0.5 | 248.5 |
| new: + age curve | 729 | 0.496 | 249.5 |
| new: + age curve + trend (final) | 729 | 0.496 | 249.5 |
| naive: career raw value to cutoff | 729 | 0.262 | 680.7 |
| naive: last season raw value | 473 | 0.267 | 484.5 |
| new (final), same players as last-season baseline | 473 | 0.547 | 217.4 |

**bowl/ListA/male** (half-life 5.0 y, K 1600 balls, trend 0.5; translation rho 1.0, 1411 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 1028 | 0.276 | 332.9 |
| new: + age curve | 1028 | 0.273 | 334.3 |
| new: + age curve + trend (final) | 1028 | 0.266 | 336.9 |
| naive: career raw value to cutoff | 1028 | 0.141 | 632.3 |
| naive: last season raw value | 714 | 0.161 | 676.3 |
| new (final), same players as last-season baseline | 714 | 0.31 | 291.4 |

**bowl/T20/female** (half-life 5.0 y, K 1600 balls, trend 0.0; translation rho 1.0, 274 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 1023 | 0.481 | 319.2 |
| new: + age curve | 1023 | 0.481 | 318.4 |
| new: + age curve + trend (final) | 1023 | 0.481 | 318.4 |
| naive: career raw value to cutoff | 1023 | 0.268 | 810.0 |
| naive: last season raw value | 659 | 0.187 | 798.1 |
| new (final), same players as last-season baseline | 659 | 0.524 | 261.3 |
| current Cricsheet model (T20 only) | 140 | 0.451 |  |
| new (final), same players as current model | 140 | 0.588 | 175.5 |

**bowl/T20/male** (half-life 3.0 y, K 1600 balls, trend 0.25; translation rho 1.0, 587 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 1371 | 0.448 | 339.1 |
| new: + age curve | 1371 | 0.445 | 340.1 |
| new: + age curve + trend (final) | 1371 | 0.449 | 338.9 |
| naive: career raw value to cutoff | 1371 | 0.182 | 905.8 |
| naive: last season raw value | 860 | 0.152 | 905.9 |
| new (final), same players as last-season baseline | 860 | 0.485 | 283.3 |
| current Cricsheet model (T20 only) | 483 | 0.487 |  |
| new (final), same players as current model | 483 | 0.531 | 223.1 |

## 3. Age curves

Peak = age with the highest cumulative level (ages with enough pairs only). Cumulative change from 22 to the peak and from the peak to 34 (runs per 100 balls):

| side | format | gender | role | peak age | 22 -> peak | peak -> 34 |
|---|---|---|---|---|---|---|
| bat | FC | female | all |  |  |  |
| bat | FC | female | top |  |  |  |
| bat | FC | female | middle |  |  |  |
| bat | FC | male | all | 27 | 1.5 | -2.8 |
| bat | FC | male | middle | 27 | 1.6 | -1.9 |
| bat | FC | male | top | 28 | 1.6 | -4.0 |
| bat | FC | male | lower | 27 | 0.9 | -2.0 |
| bat | ListA | female | all | 26 | 0.9 | -8.7 |
| bat | ListA | female | top | 26 | 0.8 | -10.0 |
| bat | ListA | female | middle | 28 | 1.5 | -6.5 |
| bat | ListA | female | lower |  |  |  |
| bat | ListA | male | all | 28 | 1.6 | -3.0 |
| bat | ListA | male | middle | 26 | 1.3 | -2.5 |
| bat | ListA | male | top | 28 | 1.9 | -3.8 |
| bat | ListA | male | lower | 27 | 2.1 | -1.6 |
| bat | T20 | female | all | 25 | 1.0 | -8.2 |
| bat | T20 | female | top | 25 | 1.4 | -9.6 |
| bat | T20 | female | middle | 25 | 0.8 | -5.8 |
| bat | T20 | female | lower |  |  |  |
| bat | T20 | male | all | 28 | 3.2 | -3.1 |
| bat | T20 | male | top | 28 | 3.4 | -3.5 |
| bat | T20 | male | middle | 27 | 3.3 | -2.7 |
| bat | T20 | male | lower | 28 | 2.3 | -5.7 |
| bowl | FC | female | all |  |  |  |
| bowl | FC | female | spin |  |  |  |
| bowl | FC | female | pace |  |  |  |
| bowl | FC | male | all | 27 | 0.8 | -1.1 |
| bowl | FC | male | spin | 28 | 0.0 | -1.0 |
| bowl | FC | male | pace | 27 | 1.2 | -1.2 |
| bowl | FC | male | unknown | 24 | 4.9 | -14.1 |
| bowl | ListA | female | all | 23 | 0.1 | -2.2 |
| bowl | ListA | female | pace | 23 | 0.1 | -2.7 |
| bowl | ListA | female | spin | 23 | 0.1 | -1.6 |
| bowl | ListA | female | unknown | 16 | 0.2 | -3.2 |
| bowl | ListA | male | all | 27 | 0.4 | -1.7 |
| bowl | ListA | male | spin | 28 | 0.2 | -1.1 |
| bowl | ListA | male | pace | 27 | 0.6 | -2.2 |
| bowl | ListA | male | unknown |  |  |  |
| bowl | T20 | female | all | 25 | 0.4 | -3.4 |
| bowl | T20 | female | pace | 27 | 0.6 | -2.7 |
| bowl | T20 | female | spin | 25 | 0.3 | -4.4 |
| bowl | T20 | female | unknown | 18 | 1.1 | -5.1 |
| bowl | T20 | male | all | 28 | 0.9 | -0.8 |
| bowl | T20 | male | spin | 31 | 0.6 | -0.4 |
| bowl | T20 | male | pace | 28 | 1.2 | -1.2 |
| bowl | T20 | male | unknown |  |  |  |

Honest read: the age adjustment barely moves out-of-sample accuracy (see section 2, `+ age curve` vs `rating only`), so the curves are useful for projecting multi-year growth/decline in the game, not as a big accuracy gain.

## 4. Strongest and weakest competitions (T20, men, batting side)

| comp | comp_class | balls | strength | weak_tier |
|---|---|---|---|---|
| indian premier league | dom_IND | 279416 | 20.97 | False |
| international league twenty20 | dom_UAE | 23187 | 15.62 | False |
| champions league | dom_IND | 35218 | 14.98 | False |
| T20I v Pakistan | intl_full | 33903 | 14.76 | False |
| the men's hundred | dom_ENG | 37555 | 14.57 | False |
| major league cricket | dom_USA | 20186 | 14.2 | False |
| sa20 | dom_RSA | 28080 | 13.93 | False |
| T20I v Australia | intl_full | 25717 | 13.39 | False |
| T20I v India | intl_full | 33669 | 13.11 | False |
| T20I v England | intl_full | 25681 | 12.65 | False |
| T20I v South Africa | intl_full | 26214 | 12.64 | False |
| caribbean premier league | dom_WI | 101184 | 12.26 | False |
| syed mushtaq ali trophy | dom_IND | 384545 | -7.43 | False |
| national t20 cup | dom_PAK | 53547 | -8.2 | True |
| africa t20 cup | dom_RSA | 25900 | -8.51 | True |
| icc world twenty20 qualifier | dom_UAE | 35502 | -11.56 | True |
| csa provincial t20 | dom_RSA | 29117 | -13.29 | True |
| shpageeza t20 tournament | dom_AFG | 34072 | -15.73 | True |
| sri lanka cricket twenty20 tournament | dom_SL | 63420 | -23.48 | True |
| sri lanka cricket major clubs t20 tournament | dom_SL | 50245 | -25.22 | True |

## 5. Sanity examples (latest year played, T20)

| player | year | age | bat balls | bat ovr | bat next | bowl balls | bowl ovr | bowl next |
|---|---|---|---|---|---|---|---|---|
| Virat Kohli | 2026 | 37.7 | 407 | 87 | 86 | 0 |  |  |
| Shubman Gill | 2026 | 26.8 | 449 | 86 | 86 | 0 |  |  |
| Vaibhav Suryavanshi | 2026 | 15.3 | 486 | 99 | 99 | 0 |  |  |
| Jasprit Bumrah | 2026 | 32.6 | 10 | 58 | 57 | 648 | 92 | 91 |
| Rashid Khan (Afg) | 2026 | 27.8 | 179 | 61 | 61 | 877 | 96 | 96 |
| Noor Ahmad | 2026 | 21.5 | 62 | 43 | 44 | 645 | 88 | 87 |
| Digvesh Rathi | 2026 | 26.5 | 5 | 59 | 59 | 234 | 80 | 79 |
| Sandeep Lamichhane (Nep) | 2026 | 25.9 | 20 | 43 | 43 | 329 | 81 | 81 |
| Aarif Sheikh (Nep) | 2026 | 28.7 | 46 | 60 | 60 | 0 |  |  |
| Smriti Mandhana | 2026 | 30.0 | 960 | 90 | 90 | 0 |  |  |
| Ellyse Perry | 2026 | 35.7 | 538 | 92 | 91 | 119 | 77 | 77 |
| Nat Sciver-Brunt | 2026 | 33.9 | 490 | 94 | 93 | 156 | 75 | 74 |
| Shafali Verma | 2026 | 22.4 | 801 | 92 | 92 | 332 | 73 | 74 |

Per-year history, Virat Kohli T20 batting:

| year | age | bat_balls | bat_season | bat_rating | bat_ovr |
|---|---|---|---|---|---|
| 2007 | 18.7 | 136 | 25.71 | 25.71 | 76 |
| 2008 | 19.7 | 157 | 18.27 | 19.97 | 70 |
| 2009 | 20.7 | 270 | 24.4 | 21.7 | 74 |
| 2010 | 21.7 | 305 | 34.56 | 29.28 | 84 |
| 2011 | 22.7 | 734 | 35.54 | 34.29 | 86 |
| 2012 | 23.7 | 681 | 28.38 | 32.18 | 85 |
| 2013 | 24.7 | 481 | 42.01 | 37.11 | 90 |
| 2014 | 25.7 | 582 | 31.84 | 36.06 | 89 |
| 2015 | 26.7 | 414 | 34.26 | 36.34 | 91 |
| 2016 | 27.7 | 1097 | 53.01 | 46.86 | 99 |
| 2017 | 28.7 | 448 | 29.85 | 43.19 | 97 |
| 2018 | 29.7 | 554 | 31.12 | 40.17 | 93 |
| 2019 | 30.7 | 643 | 40.15 | 41.64 | 96 |
| 2020 | 31.7 | 596 | 30.19 | 38.64 | 88 |
| 2021 | 32.7 | 564 | 30.88 | 36.8 | 91 |
| 2022 | 33.7 | 859 | 28.95 | 34.57 | 88 |
| 2023 | 34.7 | 457 | 36.49 | 35.83 | 87 |
| 2024 | 35.7 | 630 | 35.45 | 36.68 | 88 |
| 2025 | 36.7 | 454 | 34.5 | 36.78 | 87 |
| 2026 | 37.7 | 407 | 42.2 | 39.77 | 87 |

Top 12 in 2026, T20 men, batting (>= 200 balls that year):

| name | age | balls | ovr |
|---|---|---|---|
| Vaibhav Suryavanshi | 15.3 | 486 | 99 |
| Abhishek Sharma | 25.8 | 835 | 99 |
| Finn Allen | 27.2 | 908 | 92 |
| Harry Brook | 27.4 | 506 | 91 |
| Nye Donald | 29.5 | 307 | 88 |
| Ryan Rickelton | 30.0 | 817 | 88 |
| Tim David | 30.3 | 456 | 87 |
| Virat Kohli | 37.7 | 407 | 87 |
| Jos Buttler | 35.8 | 961 | 87 |
| Ishan Kishan | 28.0 | 1009 | 87 |
| Heinrich Klaasen | 34.9 | 746 | 87 |
| Mitchell Marsh | 34.7 | 968 | 86 |

Top 12 in 2026, T20 men, bowling (>= 200 balls that year):

| name | age | balls | ovr |
|---|---|---|---|
| Sunil Narine | 38.1 | 934 | 97 |
| Rashid Khan | 27.8 | 877 | 96 |
| Jasprit Bumrah | 32.6 | 648 | 92 |
| Usman Tariq | 28.5 | 901 | 91 |
| Imran Tahir | 47.3 | 426 | 91 |
| Sufiyan Muqeem | 26.6 | 900 | 90 |
| Wanindu Hasaranga | 28.9 | 618 | 90 |
| Varun Chakravarthy | 34.8 | 570 | 89 |
| Kuldeep Yadav | 31.5 | 354 | 89 |
| Noor Ahmad | 21.5 | 645 | 88 |
| Mitchell Santner | 34.4 | 780 | 87 |
| Abrar Ahmed | 27.6 | 522 | 86 |

Top 12 in 2026, T20 women, batting (>= 200 balls that year):

| name | age | balls | ovr |
|---|---|---|---|
| Laura Harris | 35.9 | 262 | 96 |
| Nat Sciver-Brunt | 33.9 | 490 | 94 |
| Beth Mooney | 32.5 | 750 | 94 |
| Danni Wyatt-Hodge | 35.2 | 312 | 92 |
| Ellyse Perry | 35.7 | 538 | 92 |
| Sophie Devine | 36.8 | 523 | 92 |
| Shafali Verma | 22.4 | 801 | 92 |
| Phoebe Litchfield | 23.2 | 539 | 92 |
| Grace Harris | 32.8 | 245 | 92 |
| Lizelle Lee | 34.2 | 508 | 91 |
| Meg Lanning | 34.3 | 835 | 91 |
| Smriti Mandhana | 30.0 | 960 | 90 |

Top 12 in 2026, T20 women, bowling (>= 200 balls that year):

| name | age | balls | ovr |
|---|---|---|---|
| Sophie Ecclestone | 27.2 | 463 | 90 |
| Amelia Kerr | 25.7 | 582 | 88 |
| Marizanne Kapp | 36.5 | 498 | 87 |
| Georgia Wareham | 27.1 | 365 | 85 |
| Charlie Dean | 25.5 | 395 | 85 |
| Sarah Glenn | 27.3 | 216 | 85 |
| Hayley Matthews | 28.3 | 483 | 84 |
| Rabeya Khan | 21.3 | 441 | 84 |
| Shree Charani | 21.9 | 792 | 84 |
| Shabnim Ismail | 37.7 | 462 | 84 |
| Jess Jonassen | 33.7 | 258 | 83 |
| Sophie Molineux | 28.5 | 276 | 83 |
