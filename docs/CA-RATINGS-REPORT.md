# CricketArchive per-year ratings, age curves and projections

Output `ca_ratings_by_year.parquet`: 266,961 player x format x year rows, 37,165 players, 2000-2026, every senior format (T20, List A, first-class), men and women. Built by `ca-player-seasons.sql` -> `ca-ratings.py` -> this report (`ca-ratings-report.py`). All values are runs per 100 balls above the average ball in the same competition-season, after competition/opponent adjustment; `*_ovr` is 65 + 11 z against that year's regulars, clipped 25-99.

## 1. Method

- **Cells.** Every senior scorecard innings since 2000 with balls recorded -> player x competition x year. Batting value = runs - balls x rpb - (outs - balls x opb) x W; bowling the mirror image; rpb/opb are the competition-season rates (blended toward the format-year average with a 3000-ball prior). W, the run value of a wicket, is 0.3 / 0.5 / 1.0 x the competition-season runs per wicket for T20 / List A / first-class.
- **Competitions.** Domestic = event name without season or group. Internationals are split by opponent (`T20I v India`), so opponent strength in international cricket is learned the same way as league strength.
- **Strength.** rate[p,c,y] = skill[p,y] - strength[c], alternating weighted least squares over player-years that played 2+ competitions that year. Each competition's strength is shrunk toward its class mean (country for domestic; full-member vs associate opponent for internationals), which is shrunk toward a full-member / associate mean, then 0. Without that hierarchy, unlinked associate competitions defaulted to "average" and associate bowlers topped the T20 list.
- **Match-level opponent adjustment.** Each innings is credited with its competition-season's mean batting/bowling level and this opponent's deviation from it, from the bottom-up index (`match_strength.parquet`, built from every player's pre-match rating). Without it, associate competitions, which are linked to the elite game by few players, kept close to league-average levels. The index was built from the previous ratings, so this is one fixed-point step; rebuild the index after big changes.
- **Franchise leagues in associate countries** (ILT20, MLC, Global Super League) get their own class, grouped with the full members; before, they sat in the UAE/USA domestic class and pulled the associate prior up.
- **Weak-tier translation.** For the bottom 30% of balls by strength plus every associate competition, a' = alpha + rho x a, fitted on players with balls in both tiers in the same year, with an errors-in-variables correction. The associate tier and the weak full-member tier get separate fits.
- **The Hundred's bowling** is counted (its cards give balls, not overs).
- **Ratings.** `*_rating` = exponentially decayed (half-life h years) ball-weighted mean of a' up to that year, shrunk toward a prior worth K balls (the player's competition pool level + a role offset: batting position bucket, or pace/spin). `*_season` = the same shrinkage on that year alone. h, K and a trend weight were tuned on a 2020 -> 2021-22 fold.
- **Age curves.** Delta method on consecutive shrunk season values of the same player, weighted by the harmonic mean of balls, smoothed +-2 years, role curves shrunk toward the all-player curve, and centred so the mean change is zero (values are league-relative, so ageing is zero-sum; the raw mean change is survivor bias).
- **Projection.** `*_proj_next` = rating + age-curve change at the player's age (+ trend term where tuning chose one).
- **Data fix.** cricket.db's `matches.gender` marks ~2,300 men's matches as female (e.g. the 2015 World Cup); gender is taken from `levels` instead. Worth fixing in `scorecard-parse.ts`.

## 2. Validation (fit through 2023, predict each player's 2024-25 adjusted value)

Target = the player's mean adjusted value over 2024-25 (>= 100 / 200 / 500 balls for T20 / List A / FC), weighted by those balls. `corr` = weighted correlation, `mse` in (runs per 100 balls)^2. 2024-25 was not used for tuning. Caveat: the target is on this model's own adjusted scale, which favours it over the Cricsheet model; the comparison with the current model is correlation on shared players only.

**bat/FC/female** (half-life 3.0 y, K 500 balls, trend 0.0; translation rho 1.0, 1 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 6 | 0.788 | 1012.9 |
| new: + age curve | 6 | 0.788 | 1012.9 |
| new: + age curve + trend (final) | 6 | 0.788 | 1012.9 |
| naive: career raw value to cutoff | 6 | 0.868 | 781.3 |
| naive: last season raw value | 1 |  | 677.7 |
| new (final), same players as last-season baseline | 1 |  | 2217.4 |

**bat/FC/male** (half-life 2.0 y, K 1000 balls, trend 0.0; translation rho 1.0, 895 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 1217 | 0.67 | 239.4 |
| new: + age curve | 1217 | 0.672 | 243.9 |
| new: + age curve + trend (final) | 1217 | 0.672 | 243.9 |
| naive: career raw value to cutoff | 1217 | 0.172 | 5758.8 |
| naive: last season raw value | 763 | 0.44 | 391.5 |
| new (final), same players as last-season baseline | 763 | 0.647 | 197.2 |

**bat/ListA/female** (half-life 2.0 y, K 200 balls, trend 0.0; translation rho 0.867, 348 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 788 | 0.782 | 275.5 |
| new: + age curve | 788 | 0.778 | 281.9 |
| new: + age curve + trend (final) | 788 | 0.778 | 281.9 |
| naive: career raw value to cutoff | 788 | 0.548 | 1534.7 |
| naive: last season raw value | 436 | 0.681 | 368.2 |
| new (final), same players as last-season baseline | 436 | 0.778 | 230.5 |

**bat/ListA/male** (half-life 1.0 y, K 400 balls, trend 0.0; translation rho 1.0, 2292 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 1008 | 0.578 | 325.1 |
| new: + age curve | 1008 | 0.581 | 326.5 |
| new: + age curve + trend (final) | 1008 | 0.581 | 326.5 |
| naive: career raw value to cutoff | 1008 | 0.229 | 2652.9 |
| naive: last season raw value | 660 | 0.412 | 545.4 |
| new (final), same players as last-season baseline | 660 | 0.59 | 289.9 |

**bat/T20/female** (half-life 2.0 y, K 100 balls, trend 0.0; translation rho 0.739, 512 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 1042 | 0.871 | 293.3 |
| new: + age curve | 1042 | 0.874 | 291.1 |
| new: + age curve + trend (final) | 1042 | 0.874 | 291.1 |
| naive: career raw value to cutoff | 1042 | 0.778 | 837.0 |
| current Cricsheet model (T20 only) | 171 | 0.803 |  |
| new (final), same players as current model | 171 | 0.868 | 208.6 |
| naive: last season raw value | 619 | 0.821 | 472.7 |
| new (final), same players as last-season baseline | 619 | 0.889 | 244.2 |

**bat/T20/male** (half-life 3.0 y, K 400 balls, trend 0.0; translation rho 0.818, 1037 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 1420 | 0.743 | 362.1 |
| new: + age curve | 1420 | 0.745 | 361.7 |
| new: + age curve + trend (final) | 1420 | 0.745 | 361.7 |
| naive: career raw value to cutoff | 1420 | 0.544 | 1307.7 |
| naive: last season raw value | 812 | 0.579 | 624.5 |
| new (final), same players as last-season baseline | 812 | 0.748 | 292.4 |
| current Cricsheet model (T20 only) | 519 | 0.611 |  |
| new (final), same players as current model | 519 | 0.707 | 236.4 |

**bowl/FC/female** (half-life 5.0 y, K 500 balls, trend 0.0; translation rho 1.0, 1 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 6 | 0.735 | 442.1 |
| new: + age curve | 6 | 0.735 | 442.1 |
| new: + age curve + trend (final) | 6 | 0.735 | 442.1 |
| naive: career raw value to cutoff | 6 | 0.734 | 424.6 |
| naive: last season raw value | 3 | 0.736 | 1097.7 |
| new (final), same players as last-season baseline | 3 | 0.873 | 735.5 |

**bowl/FC/male** (half-life 3.0 y, K 2000 balls, trend 0.0; translation rho 0.583, 900 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 1013 | 0.498 | 187.0 |
| new: + age curve | 1013 | 0.492 | 189.1 |
| new: + age curve + trend (final) | 1013 | 0.492 | 189.1 |
| naive: career raw value to cutoff | 1013 | 0.338 | 412.8 |
| naive: last season raw value | 679 | 0.391 | 389.0 |
| new (final), same players as last-season baseline | 679 | 0.523 | 158.5 |

**bowl/ListA/female** (half-life 5.0 y, K 1600 balls, trend 0.0; translation rho 0.637, 424 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 729 | 0.559 | 214.0 |
| new: + age curve | 729 | 0.552 | 216.2 |
| new: + age curve + trend (final) | 729 | 0.552 | 216.2 |
| naive: career raw value to cutoff | 729 | 0.368 | 658.4 |
| naive: last season raw value | 473 | 0.406 | 401.3 |
| new (final), same players as last-season baseline | 473 | 0.601 | 190.6 |

**bowl/ListA/male** (half-life 5.0 y, K 1600 balls, trend 0.0; translation rho 0.678, 1786 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 1028 | 0.287 | 308.6 |
| new: + age curve | 1028 | 0.285 | 309.9 |
| new: + age curve + trend (final) | 1028 | 0.285 | 309.9 |
| naive: career raw value to cutoff | 1028 | 0.18 | 609.5 |
| naive: last season raw value | 714 | 0.196 | 649.1 |
| new (final), same players as last-season baseline | 714 | 0.332 | 259.6 |

**bowl/T20/female** (half-life 5.0 y, K 800 balls, trend 0.0; translation rho 1.0, 428 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 1024 | 0.654 | 302.9 |
| new: + age curve | 1024 | 0.653 | 302.0 |
| new: + age curve + trend (final) | 1024 | 0.653 | 302.0 |
| naive: career raw value to cutoff | 1024 | 0.446 | 705.1 |
| naive: last season raw value | 661 | 0.365 | 645.2 |
| new (final), same players as last-season baseline | 661 | 0.685 | 248.9 |
| current Cricsheet model (T20 only) | 140 | 0.599 |  |
| new (final), same players as current model | 140 | 0.664 | 170.4 |

**bowl/T20/male** (half-life 3.0 y, K 1600 balls, trend 0.25; translation rho 0.763, 1391 links)

| predictor | players | corr | mse |
|---|---|---|---|
| new: rating only | 1374 | 0.491 | 301.5 |
| new: + age curve | 1374 | 0.488 | 302.5 |
| new: + age curve + trend (final) | 1374 | 0.491 | 301.6 |
| naive: career raw value to cutoff | 1374 | 0.292 | 776.3 |
| naive: last season raw value | 864 | 0.272 | 721.8 |
| new (final), same players as last-season baseline | 864 | 0.522 | 253.6 |
| current Cricsheet model (T20 only) | 483 | 0.498 |  |
| new (final), same players as current model | 483 | 0.535 | 203.7 |

## 2b. Associate calibration (vs the bottom-up league index)

The index puts associate-v-associate T20Is about 19 runs/100 balls below full-member T20Is for bowling (2024-25). The fitted competition pools give the same gap, and associate-heavy players (>= 70% of their 2023+ T20 balls in associate T20Is) sit well below full-member regulars. On one target for every variant (raw 2024-25 value in elite competitions only) the match-level adjustment neither helps nor hurts prediction (corr 0.43-0.51 men); it is there for calibration.

## 3. Age curves

Peak = age with the highest cumulative level (ages with enough pairs only). Cumulative change from 22 to the peak and from the peak to 34 (runs per 100 balls):

| side | format | gender | role | peak age | 22 -> peak | peak -> 34 |
|---|---|---|---|---|---|---|
| bat | FC | female | all |  |  |  |
| bat | FC | female | top |  |  |  |
| bat | FC | female | middle |  |  |  |
| bat | FC | male | all | 27 | 1.6 | -3.1 |
| bat | FC | male | top | 28 | 1.6 | -4.3 |
| bat | FC | male | middle | 27 | 1.8 | -2.4 |
| bat | FC | male | lower | 26 | 1.1 | -2.2 |
| bat | ListA | female | all | 25 | 0.8 | -8.8 |
| bat | ListA | female | top | 26 | 0.9 | -9.9 |
| bat | ListA | female | lower |  |  |  |
| bat | ListA | female | middle | 27 | 1.1 | -6.8 |
| bat | ListA | male | all | 28 | 1.7 | -3.3 |
| bat | ListA | male | middle | 26 | 1.5 | -3.0 |
| bat | ListA | male | top | 28 | 2.0 | -4.2 |
| bat | ListA | male | lower | 27 | 2.2 | -1.1 |
| bat | T20 | female | all | 26 | 1.2 | -8.9 |
| bat | T20 | female | top | 27 | 1.6 | -10.2 |
| bat | T20 | female | middle | 26 | 1.3 | -6.6 |
| bat | T20 | female | lower |  |  |  |
| bat | T20 | male | all | 28 | 3.2 | -3.1 |
| bat | T20 | male | top | 28 | 3.2 | -3.7 |
| bat | T20 | male | middle | 27 | 3.5 | -2.5 |
| bat | T20 | male | lower | 28 | 2.1 | -5.3 |
| bowl | FC | female | all |  |  |  |
| bowl | FC | female | pace |  |  |  |
| bowl | FC | female | spin |  |  |  |
| bowl | FC | male | all | 28 | 1.0 | -1.4 |
| bowl | FC | male | spin | 20 | 0.1 | -1.5 |
| bowl | FC | male | pace | 28 | 1.7 | -1.5 |
| bowl | FC | male | unknown | 23 | 4.3 | -22.7 |
| bowl | ListA | female | all | 23 | 0.0 | -2.4 |
| bowl | ListA | female | pace | 23 | 0.1 | -3.1 |
| bowl | ListA | female | spin | 23 | 0.1 | -1.4 |
| bowl | ListA | female | unknown | 16 | 0.9 | -5.5 |
| bowl | ListA | male | all | 27 | 0.5 | -1.9 |
| bowl | ListA | male | spin | 27 | 0.1 | -1.2 |
| bowl | ListA | male | pace | 27 | 0.8 | -2.5 |
| bowl | ListA | male | unknown |  |  |  |
| bowl | T20 | female | all | 25 | 0.5 | -5.2 |
| bowl | T20 | female | pace | 25 | 0.6 | -4.3 |
| bowl | T20 | female | spin | 25 | 0.5 | -6.5 |
| bowl | T20 | female | unknown | 19 | 0.7 | -4.8 |
| bowl | T20 | male | all | 28 | 0.7 | -0.8 |
| bowl | T20 | male | spin | 40 | 0.4 | -0.6 |
| bowl | T20 | male | pace | 28 | 1.0 | -1.2 |
| bowl | T20 | male | unknown |  |  |  |

Honest read: the age adjustment barely moves out-of-sample accuracy (see section 2, `+ age curve` vs `rating only`), so the curves are useful for projecting multi-year growth/decline in the game, not as a big accuracy gain.

## 4. Strongest and weakest competitions (T20, men, batting side)

| comp | comp_class | balls | strength | weak_tier |
|---|---|---|---|---|
| champions league | dom_IND | 35218 | 7.99 | False |
| international league twenty20 | franchise | 23187 | 6.32 | False |
| indian premier league | dom_IND | 279416 | 6.25 | False |
| csa t20 challenge | dom_RSA | 48086 | 5.3 | False |
| major league cricket | franchise | 20186 | 5.07 | False |
| the men's hundred | dom_ENG | 37555 | 4.88 | False |
| sa20 | dom_RSA | 28080 | 4.12 | False |
| ram slam t20 challenge | dom_RSA | 33270 | 4.1 | False |
| standard bank pro20 series | dom_RSA | 34502 | 4.02 | False |
| lanka premier league | dom_SL | 31781 | 3.45 | False |
| caribbean premier league | dom_WI | 101184 | 3.27 | False |
| friends life t20 | dom_ENG | 68811 | 2.67 | False |
| faysal bank t-20 cup | dom_PAK | 26255 | -2.45 | True |
| T20I v India | intl_full | 33669 | -2.76 | True |
| T20I v Bangladesh | intl_full | 24379 | -3.77 | True |
| csa provincial t20 | dom_RSA | 29117 | -4.71 | True |
| sri lanka cricket major clubs t20 tournament | dom_SL | 50245 | -5.09 | True |
| shpageeza t20 tournament | dom_AFG | 34072 | -5.25 | True |
| icc world twenty20 qualifier | dom_UAE | 35502 | -5.27 | True |
| sri lanka cricket twenty20 tournament | dom_SL | 63420 | -7.1 | True |

## 5. Sanity examples (latest year played, T20)

| player | year | age | bat balls | bat ovr | bat next | bowl balls | bowl ovr | bowl next |
|---|---|---|---|---|---|---|---|---|
| Virat Kohli | 2026 | 37.7 | 407 | 85 | 84 | 0 |  |  |
| Shubman Gill | 2026 | 26.8 | 449 | 83 | 84 | 0 |  |  |
| Vaibhav Suryavanshi | 2026 | 15.3 | 486 | 96 | 96 | 0 |  |  |
| Jasprit Bumrah | 2026 | 32.6 | 10 | 61 | 60 | 648 | 97 | 96 |
| Rashid Khan (Afg) | 2026 | 27.8 | 179 | 64 | 64 | 972 | 99 | 99 |
| Noor Ahmad | 2026 | 21.5 | 62 | 49 | 49 | 838 | 89 | 88 |
| Digvesh Rathi | 2026 | 26.5 | 5 | 62 | 62 | 234 | 81 | 80 |
| Sandeep Lamichhane (Nep) | 2026 | 25.9 | 20 | 48 | 48 | 329 | 83 | 83 |
| Aarif Sheikh (Nep) | 2026 | 28.7 | 46 | 60 | 60 | 0 |  |  |
| Smriti Mandhana | 2026 | 30.0 | 960 | 88 | 88 | 0 |  |  |
| Ellyse Perry | 2026 | 35.7 | 538 | 89 | 89 | 129 | 77 | 77 |
| Nat Sciver-Brunt | 2026 | 33.9 | 490 | 92 | 91 | 156 | 75 | 75 |
| Shafali Verma | 2026 | 22.4 | 801 | 89 | 90 | 332 | 74 | 74 |

Per-year history, Virat Kohli T20 batting:

| year | age | bat_balls | bat_season | bat_rating | bat_ovr |
|---|---|---|---|---|---|
| 2007 | 18.7 | 136 | 13.84 | 13.84 | 64 |
| 2008 | 19.7 | 157 | 22.66 | 17.77 | 66 |
| 2009 | 20.7 | 270 | 30.55 | 24.12 | 73 |
| 2010 | 21.7 | 305 | 39.28 | 32.22 | 83 |
| 2011 | 22.7 | 734 | 40.59 | 38.19 | 85 |
| 2012 | 23.7 | 681 | 30.55 | 35.53 | 84 |
| 2013 | 24.7 | 481 | 46.05 | 39.99 | 88 |
| 2014 | 25.7 | 582 | 36.84 | 39.99 | 88 |
| 2015 | 26.7 | 414 | 38.82 | 40.44 | 90 |
| 2016 | 27.7 | 1097 | 56.27 | 49.07 | 97 |
| 2017 | 28.7 | 448 | 32.77 | 46.32 | 95 |
| 2018 | 29.7 | 554 | 35.08 | 44.23 | 93 |
| 2019 | 30.7 | 643 | 42.77 | 45.12 | 94 |
| 2020 | 31.7 | 596 | 35.32 | 43.37 | 88 |
| 2021 | 32.7 | 564 | 35.56 | 42.14 | 90 |
| 2022 | 33.7 | 859 | 29.76 | 39.19 | 87 |
| 2023 | 34.7 | 457 | 41.46 | 40.27 | 86 |
| 2024 | 35.7 | 630 | 40.99 | 41.38 | 87 |
| 2025 | 36.7 | 454 | 40.8 | 41.95 | 86 |
| 2026 | 37.7 | 407 | 49.49 | 44.81 | 85 |

Top 12 in 2026, T20 men, batting (>= 200 balls that year):

| name | age | balls | ovr |
|---|---|---|---|
| Vaibhav Suryavanshi | 15.3 | 486 | 96 |
| Abhishek Sharma | 25.8 | 835 | 93 |
| Finn Allen | 27.2 | 908 | 89 |
| Harry Brook | 27.4 | 506 | 87 |
| Ryan Rickelton | 30.0 | 817 | 85 |
| Tim David | 30.3 | 456 | 85 |
| Virat Kohli | 37.7 | 407 | 85 |
| Jos Buttler | 35.8 | 961 | 85 |
| Surya Yadav | 35.8 | 483 | 85 |
| Nye Donald | 29.5 | 307 | 85 |
| Heinrich Klaasen | 34.9 | 746 | 85 |
| Faf du Plessis | 42.0 | 574 | 84 |

Top 12 in 2026, T20 men, bowling (>= 200 balls that year):

| name | age | balls | ovr |
|---|---|---|---|
| Sunil Narine | 38.1 | 934 | 99 |
| Rashid Khan | 27.8 | 972 | 99 |
| Jasprit Bumrah | 32.6 | 648 | 97 |
| Usman Tariq | 28.5 | 1036 | 95 |
| Imran Tahir | 47.3 | 426 | 94 |
| Wanindu Hasaranga | 28.9 | 618 | 94 |
| Varun Chakravarthy | 34.8 | 570 | 93 |
| Sufiyan Muqeem | 26.6 | 900 | 93 |
| Kuldeep Yadav | 31.5 | 354 | 93 |
| Adil Rashid | 38.4 | 558 | 91 |
| Imad Wasim | 37.5 | 449 | 90 |
| Noor Ahmad | 21.5 | 838 | 89 |

Top 12 in 2026, T20 women, batting (>= 200 balls that year):

| name | age | balls | ovr |
|---|---|---|---|
| Nat Sciver-Brunt | 33.9 | 490 | 92 |
| Laura Harris | 35.9 | 262 | 91 |
| Phoebe Litchfield | 23.2 | 539 | 90 |
| Beth Mooney | 32.5 | 750 | 90 |
| Ellyse Perry | 35.7 | 538 | 89 |
| Shafali Verma | 22.4 | 801 | 89 |
| Danni Wyatt-Hodge | 35.2 | 312 | 89 |
| Grace Harris | 32.8 | 245 | 89 |
| Georgia Wareham | 27.1 | 405 | 88 |
| Smriti Mandhana | 30.0 | 960 | 88 |
| Lizelle Lee | 34.2 | 508 | 88 |
| Georgia Voll | 22.9 | 607 | 88 |

Top 12 in 2026, T20 women, bowling (>= 200 balls that year):

| name | age | balls | ovr |
|---|---|---|---|
| Sophie Ecclestone | 27.2 | 603 | 90 |
| Marizanne Kapp | 36.5 | 633 | 89 |
| Amelia Kerr | 25.7 | 727 | 87 |
| Sam Bates | 33.9 | 284 | 87 |
| Shabnim Ismail | 37.7 | 462 | 85 |
| Shree Charani | 21.9 | 792 | 84 |
| Georgia Wareham | 27.1 | 514 | 84 |
| Sophie Molineux | 28.5 | 431 | 84 |
| Jess Jonassen | 33.7 | 423 | 84 |
| Hayley Matthews | 28.3 | 612 | 84 |
| Amanda-Jade Wellington | 29.1 | 420 | 84 |
| Charlie Dean | 25.5 | 545 | 84 |
