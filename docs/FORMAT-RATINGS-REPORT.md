# ODI and Test ratings

Every player the game ships carries `formatRatings.odi` and `formatRatings.test`: the eight attributes on the T20
`ratings` scale, plus `source: "data"` (measured in List A / ODI or first-class / Test cricket) or `"derived"` (translated
from his other formats for want of a record). Fielding and keeping are the player's T20 values. The ODI engine plays on
`player.forFormat("odi")`, the Test engine on `forFormat("test")` (packages/engine/src/player.ts).

Built by `src/pipeline/generate-format-ratings.ts` (tuned and checked by `format-validation.ts`), this report's tables by
`src/pipeline/format-ratings-report.ts` (`data/analysis/format-ratings-report.md`). How to regenerate: docs/RATINGS-PIPELINE.md,
"ODI and Test ratings".

| | men | women |
|---|---|---|
| ESPN pool (`all-players.ts` / `wpl-players.ts`): ODI set "data" / "derived" | 2,194 / 3,347 | 477 / 1,902 |
| ESPN pool: Test set "data" / "derived" | 1,751 / 3,790 | 122 / 2,257 |
| League squads' fallback players (`league-rosters.ts` entries not in the pool) | 51 | 87 |
| Extended pool (shards): players, of them ODI / Test "data" | 148,469; 11,290 / 10,253 | 16,966; 4,031 / 505 |

A set is "data" when the player's main discipline (his better T20 side) is measured in the format.

## Method

- **Level.** Per player, format (ODI = CricketArchive List A, Test = first-class) and side, `format-model.ts`: the player's
  latest CA rating in the format (decayed, shrunk, competition- and opponent-adjusted; internationals are split by opponent
  inside List A / first-class, so an ODI against a strong side counts for more than a domestic one-dayer), blended by
  inverse variance with a prior translated from his other formats (the most precise of T20 and the other long format;
  weighted least squares over players rated in both, residual variance added). For bowling, the T20 -> ODI / Test prior also
  uses the bowler's T20 economy and strike rate: T20 value rewards economy, the longer formats wickets, and the term lifted
  held-out accuracy (0.32 -> 0.36 ODI, 0.20 -> 0.24 Test); the same term for batting (T20 strike rate, balls per dismissal)
  lowered it, so batting has none. The rating's sd is widened for staleness (x 2^(seasons / CA half-life), at most two
  seasons, counted from the player's last senior season, so a retired player is rated as he stopped) and scaled by
  DATA_VAR, tuned on correlation over three folds (below). A side with no record is the translation shrunk toward a
  below-average prior (the 35th percentile of the format's regulars). "Data" needs half a regular's balls (List A 240,
  first-class 600; women 150) within five seasons of the player's last senior season, and 6+ balls a match.
- **Cricsheet.** The level is CA's alone: CricketArchive has every ODI and Test Cricsheet has and more (3,524 men's ODIs
  since 2000 against Cricsheet's 2,617), so adding Cricsheet's would count the same matches twice. Cricsheet adds what the
  scorecards lack, ball by ball: dot balls faced and bowled and wides + no-balls per ball in ODIs and Tests, used in the
  attribute mix.
- **Game scale.** Equipercentile link on the ESPN-pool players who are regulars of both the format (List A 480 balls,
  first-class 1,200, women 300, rated within 3 seasons) and T20 (240 balls): the k-th best of them in the format gets the
  k-th best of their T20 discipline overalls. Everyone else is read off that score -> overall curve (interpolated, clamped
  to its ends), ranked by mean - 0.5 sd as in model-ratings.ts. So among players who play both, a format rating sits where
  a T20 rating does and the engines' balance terms see the same spread; the format's ranking is its own.
- **Sides a player doesn't do.** A side with fewer than 6 balls a match in the format, over his career or over his last
  three seasons of it (the T20 pipeline's rule, plus recency: a batter who bowled leg-spin a decade ago is not a bowler
  now), keeps his T20 level at most. Without it, established batters with a few part-time overs (Pujara, Kohli, Gill,
  Smith) rose from about 30 bowling in T20 to 44-46 in ODIs and Tests, which matters because the engines pick bowlers by
  bowling overall. Batsmen who do bowl part-time in the format (Root, Head) sit at the batsman's secondary-discipline
  ceiling (about 44-46), as part-timers do in T20.
- **Caps** (as the T20 pipeline): below 7/3 K career balls in the format (K = the CA model's shrinkage) a side can't rate
  above the 95th percentile of established players; a derived side can't rate above the median of the format's regulars;
  extended-pool players rated only from lower-level cricket keep the T20 pipeline's tier ceilings; a side with no CA
  evidence anywhere (a batter who never bowls) follows his T20 overall along a line fitted on data-rated players.
- **Attributes.** From the player's own List A / first-class scorecard stats (`ca_pool_stats.parquet`; with Cricsheet dot
  balls and extras where he has 200+ international balls): each attribute's blend of z-scores (calculator.ts weights;
  running is non-boundary scoring and strike rotation, as the game's T20 running is the ratings model's running component,
  not age) against the format's current regulars (career rates are not era-adjusted, and scoring has risen since 2000),
  mapped by percentile onto the T20 attribute distribution of T20 regulars. A side with fewer than 200 balls in the format
  keeps the T20 mix. The side's attributes are then shifted together to its overall (`shiftTo`; bowling moves wicket-taking
  and economy, as in the T20 pipeline); clutch is the T20 value. Finally the engine's `normalizeRatingsForRole` (what
  createPlayerFromData does to T20 ratings: secondary discipline, clutch floor) runs with the player's T20 role, which his
  format views share, and attributes are floored at 10.
- **Women's Tests.** Too few to tune or validate (24 Cricsheet Tests). The women's first-class competition strengths
  rest on almost no links (docs/CA-RATINGS-REPORT.md), so domestic multi-day cricket sits level with Tests; the first-class
  record is trusted a quarter as much (DATA_VAR 4) and the List A translation carries most of the rating.
- **ICC rankings** are a check only (`data/external-rankings-format/`, fetched for this; never an input, prior or nudge).

## Validation summary

Rated with data up to 2023, predicting each player's 2024-25 international value against full members (ODI 200+ balls,
Test 500+), ball-weighted correlation. Held out = the 2023 fold only; pooled = the 2014, 2017, 2020 and 2023 folds (the
first three chose DATA_VAR from a flat six-point grid, so mildly in-sample).

| | held out: format rating | own record only | T20 rating | best naive baseline | pooled: format rating | own only | T20 rating |
|---|---|---|---|---|---|---|---|
| men ODI batting | **0.427** (n 100) | 0.378 | 0.310 | 0.341 career intl | **0.587** (505) | 0.559 | 0.487 |
| men ODI bowling | **0.333** (108) | 0.277 | 0.324 | 0.076 last season | **0.395** (520) | 0.362 | 0.223 |
| men Test batting | **0.624** (94) | 0.616 | 0.237 | 0.605 last season | **0.616** (376) | 0.609 | 0.264 |
| men Test bowling | **0.517** (94) | 0.516 | 0.203 | 0.205 career intl | **0.451** (335) | 0.442 | 0.085 |
| women ODI batting | **0.709** (88) | 0.703 | 0.664 | 0.668 career intl | **0.703** (300) | 0.690 | 0.656 |
| women ODI bowling | **0.668** (96) | 0.656 | 0.625 | 0.441 career intl | **0.537** (326) | 0.529 | 0.443 |

- The format ratings beat the T20 ratings (what the game plays every format on without them) everywhere; by a wide margin
  in Tests (0.62 vs 0.24 batting, 0.52 vs 0.20 bowling held out), modestly in ODIs. Held-out samples are about 100 players,
  so a single cell's correlation is uncertain by about +-0.08: men's ODI bowling held out (0.333 vs 0.324) is a tie, the
  pooled folds show the gain (0.395 vs 0.223).
- The translated prior adds information over the format's own record everywhere (pooled +0.01 to +0.03).
- Derived ratings (each player's format record hidden): ODI 0.39 / 0.38 men, 0.66 / 0.65 women; Test 0.49 / 0.40 men, all
  better than the raw T20 rating. They are shrunk toward a below-average prior on purpose, so on these selected players
  (who did play the format) they under-predict by 9-23 runs per 100 balls; a player without a record is, on average, one
  selectors did not pick. That selection can't be measured on players who never play the format.
- The game keeps ranks (the percentile map), so correlation is the metric; `mse` in the tables below is on the CA scale
  and mostly bias.

## Tables (format-ratings-report.ts)

### Out-of-sample validation

Rated with data up to 2023, target = ball-weighted adjusted value per 100 balls in internationals against full members in 2024-25 (ODI 200+ balls, Test 500+). `corr` = ball-weighted correlation (what the game keeps: ratings are a percentile map of the score), `mse` in (runs per 100 balls)^2 on the CA scale (T20-scale predictors are on another scale, compare their corr only). `common` = the players every predictor covers. DATA_VAR was tuned on the pooled 2014 / 2017 / 2020 folds.

**male ODI batting** (DATA_VAR 1; tuning corr by DATA_VAR: 0.25 0.602, 0.5 0.608, 1 0.610, 2 0.606, 4 0.596, own only 0.569; n 405)

| predictor | players | corr | mse | common players | corr | mse |
|---|---|---|---|---|---|---|
| format rating (own record + translated prior) | 100 | 0.427 | 388 | 71 | 0.491 | 303 |
| format rating, ranked conservatively (mean - 0.5 sd, as shipped) | 100 | 0.421 | 509 | 71 | 0.483 | 402 |
| format rating, own record only | 100 | 0.378 | 414 | 71 | 0.422 | 286 |
| T20 rating (no format ratings) | 98 | 0.310 | 520 | 71 | 0.373 | 447 |
| T20 rating translated | 98 | 0.310 | 531 | 71 | 0.373 | 491 |
| naive: career international value | 78 | 0.341 | 872 | 71 | 0.272 | 830 |
| naive: last season international value | 73 | 0.294 | 838 | 71 | 0.283 | 795 |

All four folds pooled (rated through 2014, 2017, 2020, 2023; 505 player-folds): format rating (own record + translated prior) 0.587; format rating, own record only 0.559; T20 rating (no format ratings) 0.487.

Derived ratings, checked by hiding each player's ODI record (same players):

| predictor | players | corr | mse | mean target - prediction |
|---|---|---|---|---|
| derived (translated, shrunk to the below-average prior) | 100 | 0.392 | 743 | 23.4 |
| translated, not shrunk | 100 | 0.398 | 472 | 16.3 |
| T20 rating (no format ratings) | 98 | 0.310 | 520 | 15.4 |

**male ODI bowling** (DATA_VAR 2; tuning corr by DATA_VAR: 0.25 0.393, 0.5 0.400, 1 0.407, 2 0.410, 4 0.403, own only 0.357; n 412)

| predictor | players | corr | mse | common players | corr | mse |
|---|---|---|---|---|---|---|
| format rating (own record + translated prior) | 108 | 0.333 | 359 | 72 | 0.343 | 272 |
| format rating, ranked conservatively (mean - 0.5 sd, as shipped) | 108 | 0.326 | 385 | 72 | 0.348 | 288 |
| format rating, own record only | 108 | 0.277 | 375 | 72 | 0.280 | 289 |
| T20 rating (no format ratings) | 101 | 0.324 | 348 | 72 | 0.322 | 281 |
| T20 rating translated (with T20 style) | 101 | 0.356 | 351 | 72 | 0.360 | 277 |
| naive: career international value | 79 | 0.026 | 699 | 72 | 0.107 | 552 |
| naive: last season international value | 78 | 0.076 | 993 | 72 | 0.123 | 753 |

All four folds pooled (rated through 2014, 2017, 2020, 2023; 520 player-folds): format rating (own record + translated prior) 0.395; format rating, own record only 0.362; T20 rating (no format ratings) 0.223.

Derived ratings, checked by hiding each player's ODI record (same players):

| predictor | players | corr | mse | mean target - prediction |
|---|---|---|---|---|
| derived (translated, shrunk to the below-average prior) | 107 | 0.376 | 436 | 8.9 |
| translated, not shrunk | 107 | 0.370 | 351 | 3.4 |
| T20 rating (no format ratings) | 101 | 0.324 | 348 | 2.5 |

**male Test batting** (DATA_VAR 0.5; tuning corr by DATA_VAR: 0.25 0.614, 0.5 0.616, 1 0.612, 2 0.601, 4 0.582, own only 0.514; n 282)

| predictor | players | corr | mse | common players | corr | mse |
|---|---|---|---|---|---|---|
| format rating (own record + translated prior) | 94 | 0.624 | 269 | 55 | 0.414 | 195 |
| format rating, ranked conservatively (mean - 0.5 sd, as shipped) | 94 | 0.622 | 342 | 55 | 0.407 | 249 |
| format rating, own record only | 94 | 0.616 | 263 | 55 | 0.374 | 184 |
| T20 rating (no format ratings) | 83 | 0.237 | 568 | 55 | 0.346 | 456 |
| T20 rating translated | 83 | 0.237 | 423 | 55 | 0.346 | 357 |
| naive: career international value | 76 | 0.477 | 953 | 55 | 0.182 | 741 |
| naive: last season international value | 64 | 0.605 | 839 | 55 | 0.289 | 617 |

All four folds pooled (rated through 2014, 2017, 2020, 2023; 376 player-folds): format rating (own record + translated prior) 0.616; format rating, own record only 0.609; T20 rating (no format ratings) 0.264.

Derived ratings, checked by hiding each player's Test record (same players):

| predictor | players | corr | mse | mean target - prediction |
|---|---|---|---|---|
| derived (translated, shrunk to the below-average prior) | 91 | 0.492 | 563 | 19.3 |
| translated, not shrunk | 91 | 0.493 | 402 | 14.4 |
| T20 rating (no format ratings) | 83 | 0.237 | 568 | 17.2 |

**male Test bowling** (DATA_VAR 2; tuning corr by DATA_VAR: 0.25 0.419, 0.5 0.423, 1 0.427, 2 0.428, 4 0.421, own only 0.350; n 241)

| predictor | players | corr | mse | common players | corr | mse |
|---|---|---|---|---|---|---|
| format rating (own record + translated prior) | 94 | 0.517 | 371 | 54 | 0.507 | 416 |
| format rating, ranked conservatively (mean - 0.5 sd, as shipped) | 94 | 0.518 | 432 | 54 | 0.510 | 469 |
| format rating, own record only | 94 | 0.516 | 335 | 54 | 0.467 | 384 |
| T20 rating (no format ratings) | 86 | 0.203 | 564 | 54 | 0.202 | 632 |
| T20 rating translated (with T20 style) | 86 | 0.242 | 505 | 54 | 0.249 | 618 |
| naive: career international value | 70 | 0.205 | 944 | 54 | 0.308 | 882 |
| naive: last season international value | 59 | 0.141 | 1391 | 54 | 0.133 | 1196 |

All four folds pooled (rated through 2014, 2017, 2020, 2023; 335 player-folds): format rating (own record + translated prior) 0.451; format rating, own record only 0.442; T20 rating (no format ratings) 0.085.

Derived ratings, checked by hiding each player's Test record (same players):

| predictor | players | corr | mse | mean target - prediction |
|---|---|---|---|---|
| derived (translated, shrunk to the below-average prior) | 94 | 0.400 | 605 | 16.6 |
| translated, not shrunk | 94 | 0.393 | 456 | 11.9 |
| T20 rating (no format ratings) | 86 | 0.203 | 564 | 13.9 |

**female ODI batting** (DATA_VAR 1; tuning corr by DATA_VAR: 0.25 0.695, 0.5 0.698, 1 0.700, 2 0.698, 4 0.691, own only 0.668; n 212)

| predictor | players | corr | mse | common players | corr | mse |
|---|---|---|---|---|---|---|
| format rating (own record + translated prior) | 88 | 0.709 | 282 | 64 | 0.718 | 229 |
| format rating, ranked conservatively (mean - 0.5 sd, as shipped) | 88 | 0.707 | 356 | 64 | 0.718 | 285 |
| format rating, own record only | 88 | 0.703 | 320 | 64 | 0.702 | 258 |
| T20 rating (no format ratings) | 85 | 0.664 | 319 | 64 | 0.710 | 237 |
| T20 rating translated | 85 | 0.664 | 286 | 64 | 0.710 | 225 |
| naive: career international value | 75 | 0.668 | 919 | 64 | 0.652 | 881 |
| naive: last season international value | 67 | 0.490 | 1040 | 64 | 0.466 | 1005 |

All four folds pooled (rated through 2014, 2017, 2020, 2023; 300 player-folds): format rating (own record + translated prior) 0.703; format rating, own record only 0.690; T20 rating (no format ratings) 0.656.

Derived ratings, checked by hiding each player's ODI record (same players):

| predictor | players | corr | mse | mean target - prediction |
|---|---|---|---|---|
| derived (translated, shrunk to the below-average prior) | 86 | 0.664 | 425 | 14.0 |
| translated, not shrunk | 86 | 0.659 | 293 | 7.3 |
| T20 rating (no format ratings) | 85 | 0.664 | 319 | 0.2 |

**female ODI bowling** (DATA_VAR 0.5; tuning corr by DATA_VAR: 0.25 0.468, 0.5 0.470, 1 0.469, 2 0.462, 4 0.445, own only 0.368; n 230)

| predictor | players | corr | mse | common players | corr | mse |
|---|---|---|---|---|---|---|
| format rating (own record + translated prior) | 96 | 0.668 | 245 | 63 | 0.714 | 226 |
| format rating, ranked conservatively (mean - 0.5 sd, as shipped) | 96 | 0.668 | 273 | 63 | 0.715 | 255 |
| format rating, own record only | 96 | 0.656 | 251 | 63 | 0.702 | 230 |
| T20 rating (no format ratings) | 94 | 0.625 | 209 | 63 | 0.637 | 182 |
| T20 rating translated (with T20 style) | 94 | 0.632 | 251 | 63 | 0.649 | 240 |
| naive: career international value | 74 | 0.441 | 912 | 63 | 0.467 | 910 |
| naive: last season international value | 65 | 0.387 | 1186 | 63 | 0.381 | 1190 |

All four folds pooled (rated through 2014, 2017, 2020, 2023; 326 player-folds): format rating (own record + translated prior) 0.537; format rating, own record only 0.529; T20 rating (no format ratings) 0.443.

Derived ratings, checked by hiding each player's ODI record (same players):

| predictor | players | corr | mse | mean target - prediction |
|---|---|---|---|---|
| derived (translated, shrunk to the below-average prior) | 94 | 0.647 | 352 | 11.2 |
| translated, not shrunk | 94 | 0.632 | 251 | 6.6 |
| T20 rating (no format ratings) | 94 | 0.625 | 209 | 3.7 |

**female Test batting**: too few players to validate (0).

**female Test bowling**: too few players to validate (0).

### Distributions against T20 (ESPN pool)

Final discipline overall (after attributes and normalisation) among each format's regulars (rated from data, a regular's balls, rated within 3 seasons), against the T20 overall among T20 regulars (240+ CA T20 balls in the discipline). The link is made on the players who are regulars of both, so the format rows sit where those players' T20 ratings sit; T20 regulars include many players who never play the longer formats.

**Men**

|  | regulars | linked | p10 | p25 | p50 | p75 | p90 | max |
|---|---|---|---|---|---|---|---|---|
| ODI batting | 1144 | 872 | 30 | 50 | 68 | 75 | 80 | 93 |
| Test batting | 1123 | 730 | 30 | 40 | 67 | 74 | 79 | 93 |
| T20 batting | 1582 |  | 43 | 53 | 67 | 74 | 79 | 93 |
| ODI bowling | 1126 | 913 | 32 | 39 | 66 | 74 | 77 | 96 |
| Test bowling | 894 | 705 | 31 | 38 | 63 | 74 | 77 | 95 |
| T20 bowling | 1639 |  | 32 | 52 | 68 | 74 | 76 | 97 |

Attributes, p25 / p50 / p75 among the same regulars (men):

| attribute | ODI | Test | T20 |
|---|---|---|---|
| battingIQ | 48 / 68 / 78 | 36 / 68 / 81 | 54 / 67 / 78 |
| timing | 49 / 71 / 79 | 40 / 70 / 78 | 54 / 67 / 77 |
| power | 50 / 63 / 74 | 48 / 59 / 69 | 48 / 61 / 74 |
| running | 46 / 60 / 72 | 37 / 58 / 68 | 46 / 57 / 69 |
| wicketTaking | 35 / 70 / 84 | 33 / 63 / 80 | 55 / 74 / 81 |
| economy | 31 / 45 / 62 | 31 / 47 / 67 | 34 / 54 / 71 |
| accuracy | 25 / 47 / 60 | 26 / 48 / 60 | 38 / 51 / 61 |

**Women**

|  | regulars | linked | p10 | p25 | p50 | p75 | p90 | max |
|---|---|---|---|---|---|---|---|---|
| ODI batting | 331 | 263 | 30 | 44 | 58 | 68 | 76 | 95 |
| Test batting | 60 | 55 | 32 | 47 | 66 | 78 | 85 | 95 |
| T20 batting | 652 |  | 32 | 40 | 50 | 64 | 72 | 95 |
| ODI bowling | 308 | 281 | 32 | 36 | 69 | 73 | 76 | 87 |
| Test bowling | 67 | 64 | 41 | 71 | 73 | 75 | 77 | 82 |
| T20 bowling | 688 |  | 31 | 45 | 62 | 71 | 74 | 87 |

Attributes, p25 / p50 / p75 among the same regulars (women):

| attribute | ODI | Test | T20 |
|---|---|---|---|
| battingIQ | 42 / 59 / 75 | 51 / 70 / 84 | 42 / 53 / 68 |
| timing | 44 / 60 / 74 | 48 / 66 / 79 | 41 / 52 / 67 |
| power | 39 / 49 / 61 | 43 / 64 / 76 | 35 / 44 / 56 |
| running | 44 / 56 / 69 | 45 / 60 / 77 | 39 / 49 / 63 |
| wicketTaking | 31 / 68 / 75 | 65 / 71 / 78 | 41 / 60 / 69 |
| economy | 35 / 66 / 77 | 66 / 77 / 89 | 45 / 65 / 76 |
| accuracy | 36 / 59 / 69 | 45 / 60 / 69 | 51 / 60 / 69 |

### Top 25 (ESPN pool)

`~` = derived (no usable record in the format), `*` = capped. T20 = the same player's T20 discipline overall.

**Men, ODI batting**: Shubman Gill (India) 93 [T20 87], Virat Kohli (India) 92 [T20 87], Harry Brook (England) 92 [T20 93], KL Rahul (India) 91 [T20 87], Heinrich Klaasen (South Africa) 90 [T20 88], Abhishek Sharma (India) 89 [T20 92], Travis Head (Australia) 89 [T20 85], Rohit Sharma (India) 89 [T20 80], Joe Root (England) 89 [T20 72], Finn Allen (New Zealand) 88 [T20 91], Mitchell Marsh (Australia) 88 [T20 88], Jos Buttler (England) 88 [T20 88], Shreyas Iyer (India) 88 [T20 88], Lhuan-dre Pretorius (South Africa) 88 [T20 85], David Miller (South Africa) 88 [T20 84], David Warner (Australia) 88 [T20 87], Will Jacks (England) 87 [T20 87], Nicholas Pooran (West Indies) 87 [T20 89], Ryan Rickelton (South Africa) 87 [T20 89], Ishan Kishan (India) 87 [T20 89], Glenn Phillips (New Zealand) 87 [T20 87], Dewald Brevis (South Africa) 87 [T20 87], Tom Banton (England) 87 [T20 82], Ben Duckett (England) 87 [T20 81], Kieron Pollard (West Indies) 87 [T20 89]

**Men, ODI bowling**: Jasprit Bumrah (India) 96 [T20 97], Rashid Khan (Afghanistan) 93 [T20 92], Mitchell Starc (Australia) 91 [T20 79], Pat Cummins (Australia) 91 [T20 77], Matt Henry (New Zealand) 89 [T20 74], Josh Hazlewood (Australia) 88 [T20 84], Kuldeep Yadav (India) 87 [T20 87], Kagiso Rabada (South Africa) 87 [T20 79], Trent Boult (New Zealand) 86 [T20 82], Varun Chakravarthy (India) 85* [T20 87], Wanindu Hasaranga (Sri Lanka) 85 [T20 91], Sunil Narine (West Indies) 85 [T20 93], Mohammed Shami (India) 85 [T20 78], Shaheen Shah Afridi (Pakistan) 85 [T20 81], Joel Paris (Australia) 85 [T20 76], Mitchell Santner (New Zealand) 84 [T20 85], Adam Zampa (Australia) 84 [T20 85], Nathan Coulter-Nile (Australia) 84 [T20 77], Scott Boland (Australia) 84 [T20 73], Jofra Archer (England) 83 [T20 86], Yuzvendra Chahal (India) 83 [T20 85], Nathan Ellis (Australia) 83 [T20 80], Ravichandran Ashwin (India) 83 [T20 84], Peter Siddle (Australia) 83 [T20 77], Kyle Abbott (South Africa) 83 [T20 72]

**Men, Test batting**: Harry Brook (England) 93 [T20 93], Joe Root (England) 92 [T20 72], Travis Head (Australia) 89 [T20 85], Ben Duckett (England) 89 [T20 81], Steven Smith (Australia) 89 [T20 84], Shubman Gill (India) 88 [T20 87], Virat Kohli (India) 88 [T20 87], Rishabh Pant (India) 88 [T20 82], Ryan Rickelton (South Africa) 87 [T20 89], Ishan Kishan (India) 87 [T20 89], Cameron Green (Australia) 87 [T20 84], KL Rahul (India) 87 [T20 87], Yashasvi Jaiswal (India) 87 [T20 83], Dhruv Jurel (India) 87 [T20 80], David Warner (Australia) 87 [T20 87], Dan Lawrence (England) 87 [T20 81], Jamie Smith (England) 87 [T20 79], Kane Williamson (New Zealand) 87 [T20 78], Alex Carey (Australia) 87 [T20 70], David Bedingham (South Africa) 87 [T20 69], Quinton de Kock (South Africa) 86 [T20 84], Mitchell Marsh (Australia) 86 [T20 88], Ravindra Jadeja (India) 86 [T20 80], Jos Buttler (England) 86 [T20 88], Rachin Ravindra (New Zealand) 86 [T20 77]

**Men, Test bowling**: Jasprit Bumrah (India) 95 [T20 97], Mitchell Starc (Australia) 91 [T20 79], Kyle Abbott (South Africa) 91 [T20 72], Pat Cummins (Australia) 88 [T20 77], Matt Henry (New Zealand) 87 [T20 74], Scott Boland (Australia) 86 [T20 73], Josh Hazlewood (Australia) 85 [T20 84], Trent Boult (New Zealand) 85 [T20 82], Kagiso Rabada (South Africa) 85 [T20 79], Joel Paris (Australia) 85 [T20 76], Sam Cook (England) 85 [T20 74], Ollie Robinson (England) 85 [T20 70], Mohammed Shami (India) 84 [T20 78], Jofra Archer (England) 83 [T20 86], Ravichandran Ashwin (India) 83 [T20 84], Shaheen Shah Afridi (Pakistan) 83 [T20 81], Michael Neser (Australia) 83 [T20 73], Matthew Potts (England) 83 [T20 72], Daniel Worrall (England) 82 [T20 80], Peter Siddle (Australia) 82 [T20 77], Chris Tremain (Australia) 82 [T20 73], Ben Sanderson (England) 82 [T20 74], Jamie Porter (England) 82 [T20 68], Rashid Khan (Afghanistan) 81* [T20 92], Ravindra Jadeja (India) 81 [T20 83]

**Women, ODI batting**: Shafali Verma (India) 95 [T20 92], Beth Mooney (Australia) 94 [T20 87], Nat Sciver-Brunt (England) 92 [T20 95], Smriti Mandhana (India) 92 [T20 92], Phoebe Litchfield (Australia) 87 [T20 94], Grace Harris (Australia) 87 [T20 87], Alyssa Healy (Australia) 87 [T20 79], Danni Wyatt-Hodge (England) 85 [T20 85], Annabel Sutherland (Australia) 85 [T20 80], Meg Lanning (Australia) 85 [T20 81], Georgia Voll (Australia) 85 [T20 81], Sophie Devine (New Zealand) 83 [T20 82], Ellyse Perry (Australia) 82 [T20 87], Ashleigh Gardner (Australia) 82 [T20 85], Laura Wolvaardt (South Africa) 82 [T20 82], Marizanne Kapp (South Africa) 81 [T20 78], Freya Kemp (England) 81 [T20 79], Jemimah Rodrigues (India) 81 [T20 80], Harmanpreet Kaur (India) 81 [T20 79], Rachael Haynes (Australia) 81 [T20 77], Georgia Wareham (Australia) 80 [T20 85], Hayley Matthews (West Indies) 80 [T20 80], Lizelle Lee (South Africa) 80 [T20 83], Maia Bouchier (England) 80 [T20 79], Amelia Kerr (New Zealand) 79 [T20 80]

**Women, ODI bowling**: Sophie Ecclestone (England) 87 [T20 82], Jess Jonassen (Australia) 82 [T20 76], Alana King (Australia) 81 [T20 77], Amanda-Jade Wellington (Australia) 80 [T20 78], Sophie Molineux (Australia) 79* [T20 79], Marizanne Kapp (South Africa) 79 [T20 87], Ashleigh Gardner (Australia) 79 [T20 76], Megan Schutt (Australia) 79 [T20 78], Georgia Wareham (Australia) 78 [T20 81], Hayley Matthews (West Indies) 78 [T20 77], Annabel Sutherland (Australia) 78 [T20 77], Poonam Yadav (India) 78 [T20 75], Molly Strano (Australia) 78 [T20 77], Anesu Mushangwe (Zimbabwe) 78 [T20 74], Amelia Kerr (New Zealand) 77 [T20 79], Deepti Sharma (India) 77 [T20 79], Kim Garth (Australia) 77 [T20 77], Charlie Dean (England) 77 [T20 78], Shabnim Ismail (South Africa) 77 [T20 81], Shaquana Quintyne (West Indies) 77 [T20 77], Leigh Kasperek (New Zealand) 77 [T20 75], Linsey Smith (England) 77 [T20 75], Anya Shrubsole (England) 77 [T20 76], Rajeshwari Gayakwad (India) 77 [T20 74], Ekta Bisht (India) 77 [T20 75]

**Women, Test batting**: Nat Sciver-Brunt (England) 95 [T20 95], Shafali Verma (India) 94 [T20 92], Smriti Mandhana (India) 92 [T20 92], Beth Mooney (Australia) 92 [T20 87], Phoebe Litchfield (Australia) 87 [T20 94], Ellyse Perry (Australia) 87 [T20 87], Danni Wyatt-Hodge (England) 85 [T20 85], Annabel Sutherland (Australia) 85 [T20 80], Laura Wolvaardt (South Africa) 85 [T20 82], Meg Lanning (Australia) 85 [T20 81], Heather Knight (England) 82 [T20 82], Jemimah Rodrigues (India) 82 [T20 80], Harmanpreet Kaur (India) 81 [T20 79], Sophia Dunkley (England) 80 [T20 85], Alyssa Healy (Australia) 80 [T20 79], Marizanne Kapp (South Africa) 79 [T20 78], Ashleigh Gardner (Australia) 79 [T20 85], Richa Ghosh (India) 78 [T20 81], Alice Capsey (England) 77 [T20 76], Tahlia McGrath (Australia) 77 [T20 75], Maia Bouchier (England) 77 [T20 79], Anneke Bosch (South Africa) 76 [T20 78], Jess Jonassen (Australia) 76 [T20 76], Rachael Haynes (Australia) 76 [T20 77], Tazmin Brits (South Africa) 75 [T20 75]

**Women, Test bowling**: Deepti Sharma (India) 82 [T20 79], Ashleigh Gardner (Australia) 79 [T20 76], Sophie Ecclestone (England) 79 [T20 82], Vaishnavi Sharma (India) 79 [T20 76], Alana King (Australia) 78 [T20 77], Sophie Molineux (Australia) 78 [T20 79], Nahida Akter (Bangladesh) 78 [T20 73], Annabel Sutherland (Australia) 77 [T20 77], Jess Jonassen (Australia) 77 [T20 76], Poonam Yadav (India) 77 [T20 75], Salma Khatun (Bangladesh) 77 [T20 74], Rabeya Khan (Bangladesh) 76 [T20 74], Tanuja Kanwar (India) 76 [T20 75], Minnu Mani (India) 76 [T20 73], Jannatul Ferdus (Bangladesh) 76 [T20 73], Marizanne Kapp (South Africa) 75 [T20 87], Ellyse Perry (Australia) 75 [T20 74], Charlie Dean (England) 75 [T20 78], Lauren Bell (England) 75 [T20 79], Rajeshwari Gayakwad (India) 75 [T20 74], Sultana Khatun (Bangladesh) 75 [T20 74], Kim Garth (Australia) 74 [T20 77], Tahlia McGrath (Australia) 74 [T20 72], Darcie Brown (Australia) 74 [T20 78], Radha Yadav (India) 74 [T20 75]

### Specialists

| player | T20 bat / bowl (overall) | ODI | Test |
|---|---|---|---|
| Cheteshwar Pujara | 76 / 28 (76) | 79 / 28 (79) | 82 / 28 (82) |
| Nathan Lyon | 53 / 78 (80) | 42 / 78 (79) | 30 / 80 (80) |
| Joe Root | 72 / 44 (73) | 89 / 46 (89) | 92 / 46 (92) |
| Steven Smith | 84 / 31 (84) | 87 / 31 (87) | 89 / 31 (89) |
| Kane Williamson | 78 / 31 (78) | 82 / 31 (82) | 87 / 31 (87) |
| Marnus Labuschagne | 68 / 40 (69) | 82 / 45 (83) | 82 / 45 (83) |
| Usman Khawaja | 82 / 30 (82) | 81 / 30 (81) | 86 / 30 (86) |
| Ajinkya Rahane | 76 / 31 (76) | 79 / 31 (79) | 77 / 31 (77) |
| Tom Latham | 72 / 31 (72) | 78 / 31 (78) | 82 / 31 (82) |
| Scott Boland | 49 / 73 (75) | 40 / 84 (84) | 30 / 86 (86) |
| Josh Hazlewood | 27 / 84 (84) | 27 / 88 (88) | 30 / 85 (85) |
| Andre Russell | 88 / 71 (91) | 69 / 71 (78, derived) | 68 / 71 (77, derived) |
| Sunil Narine | 34 / 93 (93) | 34 / 85 (85) | 47 / 71 (72, derived) |
| Kieron Pollard | 89 / 71 (92) | 87 / 75 (91) | 68 / 71 (77, derived) |
| Nicholas Pooran | 89 / 31 (89) | 87 / 31 (87) | 68 / 31 (68, derived) |
| Tim David | 92 / 30 (92) | 84 / 45 (85) | 68 / 30 (68, derived) |
| Rovman Powell | 86 / 30 (86) | 81 / 46 (82) | 68 / 40 (69, derived) |
| Sherfane Rutherford | 87 / 30 (87) | 82 / 30 (82) | 68 / 39 (69, derived) |
| Romario Shepherd | 88 / 45 (88) | 76 / 46 (77) | 68 / 41 (69, derived) |
| Abhishek Sharma | 92 / 45 (92) | 89 / 37 (89) | 83 / 37 (83) |
| Rinku Singh | 87 / 29 (87) | 84 / 39 (84) | 82 / 35 (82) |
| Varun Chakravarthy | 21 / 87 (87) | 21 / 85 (85) | 21 / 71 (71, derived) |
| Liam Livingstone | 83 / 68 (87) | 83 / 74 (88) | 77 / 72 (83) |

| player | T20 bat / bowl (overall) | ODI | Test |
|---|---|---|---|
| Ellyse Perry | 87 / 74 (91) | 82 / 76 (88) | 87 / 75 (91) |
| Nat Sciver-Brunt | 95 / 73 (96) | 92 / 74 (94) | 95 / 73 (96) |
| Smriti Mandhana | 92 / 31 (92) | 92 / 31 (92) | 92 / 31 (92) |
| Beth Mooney | 87 / 31 (87) | 94 / 31 (94) | 92 / 31 (92) |
| Meg Lanning | 81 / 32 (81) | 85 / 32 (85) | 85 / 32 (85) |
| Heather Knight | 82 / 72 (87) | 79 / 72 (85) | 82 / 72 (87) |
| Sophie Ecclestone | 47 / 82 (83) | 43 / 87 (87) | 30 / 79 (79) |
| Deepti Sharma | 77 / 79 (86) | 76 / 77 (85) | 73 / 82 (87) |
| Chinelle Henry | 79 / 46 (80) | 76 / 45 (77) | 68 / 39 (69, derived) |
| Deandra Dottin | 75 / 72 (82) | 74 / 72 (81) | 68 / 71 (77, derived) |

Bowling overall of specialist batsmen (T20 role batsman; 3834 men, 324 of them with a T20 batting overall of 75+), p10 / p25 / p50 / p75 / p90 / max. A side the player doesn't do in the format (under 6 balls a match over his career or his last three seasons of it) keeps his T20 level; batsmen who do bowl part-time in the format sit at the batsman's secondary-discipline ceiling (about 44-46), as part-timers do in T20.

|  | T20 | ODI | Test |
|---|---|---|---|
| all specialist batsmen | 26 / 28 / 30 / 31 / 32 / 46 | 27 / 29 / 30 / 30 / 32 / 46 | 27 / 29 / 30 / 30 / 32 / 46 |
| T20 batting 75+ | 28 / 28 / 30 / 32 / 45 / 46 | 28 / 28 / 30 / 37 / 45 / 46 | 28 / 29 / 30 / 35 / 44 / 46 |

Men, by group (mean rating of the group in each format). The T20 ratings of first-class specialists with a thin T20 record were themselves rated from their first-class cricket by the T20 pipeline (T20-unproven sides), so those groups' T20 and Test means coincide; the players above show the movement for specialists with a real T20 record.

| group | players | T20 | ODI | Test | rating |
|---|---|---|---|---|---|
| Test batting specialists: 4000+ first-class balls at 40+ a match, under 1500 T20 balls | 300 | 66.0 | 65.7 | 66.3 | batting |
| Test bowling specialists: 6000+ first-class balls bowled, under 1200 T20 balls | 150 | 58.7 | 58.9 | 57.9 | bowling |
| White-ball only: T20 overall 75+, no first-class ball (94 derived in Tests) | 94 | 77.8 | 65.5 | 61.1 | overall |
| T20 only: T20 overall 75+, no List A or first-class ball (45 derived in ODIs) | 45 | 77.9 | 65.0 | 63.4 | overall |

### Attribute mix

Men with 1,000+ Cricsheet balls in the format (career, so in-sample: a consistency check, not a validation): correlation of a batting attribute with the stat it stands for in that format, for the format's own set and for the player's T20 set.

| format | players | attribute | stat in the format | format set | T20 set |
|---|---|---|---|---|---|
| ODI | 147 | power | six % | 0.733 | 0.664 |
| ODI | 147 | power | boundary % | 0.745 | 0.477 |
| ODI | 147 | timing | boundary % | 0.350 | 0.225 |
| ODI | 147 | battingIQ | balls per dismissal | 0.591 | 0.248 |
| ODI | 147 | battingIQ | average | 0.669 | 0.460 |
| ODI | 147 | running | fewer dot balls | 0.714 | 0.304 |
| ODI | 147 | batting overall | average | 0.558 | 0.460 |
| Test | 163 | power | six % | 0.380 | 0.249 |
| Test | 163 | power | boundary % | 0.568 | 0.294 |
| Test | 163 | timing | boundary % | 0.007 | 0.173 |
| Test | 163 | battingIQ | balls per dismissal | 0.744 | 0.538 |
| Test | 163 | battingIQ | average | 0.730 | 0.669 |
| Test | 163 | running | fewer dot balls | 0.572 | 0.183 |
| Test | 163 | batting overall | average | 0.740 | 0.660 |

### ICC rankings (validation only)

Latest ICC top 100 (2026-11-02/03) matched to the ESPN pool by name (and team where names repeat). Spearman correlation of ICC points with our format overall and with the same players' T20 overall; `top 25 overlap` = ICC top 25 players (matched) who are also in our top 25 for the format. Rankings weigh recent international form only and cover the top 100 only, so a modest correlation is expected.

| ranking | ICC players | matched | Spearman (format rating) | Spearman (T20 rating) | top 25 overlap |
|---|---|---|---|---|---|
| male ODI batting | 101 | 98 | 0.571 | 0.421 | 8 / 25 |
| male ODI bowling | 100 | 99 | 0.449 | 0.423 | 9 / 25 |
| male Test batting | 100 | 95 | 0.565 | 0.333 | 12 / 25 |
| male Test bowling | 100 | 89 | 0.579 | 0.323 | 8 / 25 |
| female ODI batting | 100 | 98 | 0.608 | 0.575 | 14 / 25 |
| female ODI bowling | 100 | 94 | 0.622 | 0.632 | 11 / 25 |

### Sources

male: {"espn":{"odiData":2194,"testData":1751,"odiDerived":3347,"testDerived":3790},"extended":{"odiData":11290,"testData":10253},"league":{"odiData":27,"testData":25,"players":51}}
female: {"espn":{"odiData":477,"testData":122,"odiDerived":1902,"testDerived":2257},"extended":{"odiData":4031,"testData":505},"league":{"odiData":82,"testData":22,"players":87}}

## Known gaps

- **T20 weight on ODI batting.** The translated prior is validated (it raises held-out correlation), but with a noisy or
  stale List A record a strong T20 hitter is rated mostly from T20: Pollard and Pooran rate 87 for ODIs (their List A records
  are four and three seasons old), Finn Allen 88. The same holds for strong T20 batters' Tests via their domestic
  first-class record (Abhishek Sharma 83 after the small-sample cap, Ishan Kishan 87). A batting style term would lower
  them but lowered held-out accuracy (in 2024-25 the hitters picked for Tests did well), so it is left out.
- **Women's Tests** are a judgement (DATA_VAR 4, untuned): the women's first-class strengths are unreliable, Indian and
  Bangladeshi domestic multi-day bowlers reach the women's Test bowling top 25, and the women's Test bowling curve is
  compressed (64 linked players). Women's ODIs are validated.
- **Distributions.** The format overall matches T20 at the median and above among each format's regulars (tables above);
  the lower quartile is lower because List A / first-class regulars include tail-enders who bat long enough to count
  (a T20 tail-ender rarely reaches 240 balls). Among the linked players the format's ODI economy and wicket-taking sit
  a little below their T20 values (their T20 bowling is better than their one-day bowling ranks among List A regulars).
- **Attribute mix.** Test timing hardly tracks Test boundary rate (0.01; T20 timing 0.17): calculator.ts's timing is mostly
  average and survival, which is what the Test balance term should see, but an engine that draws fours from timing will
  get Test boundary rates from it only loosely.
- **Static in career mode.** Format sets don't progress with `Player.progress()`; after some seasons a player's ODI / Test
  ratings lag his T20 development. Generated players (regens, youth, generated pools) have none and play every format on
  their T20 ratings.
- **The Test specialists group check** (format-ratings-report.ts) shows no group-level lift: first-class specialists with a
  thin T20 record were already rated from first-class cricket by the T20 pipeline. Named specialists with real T20 records
  do move (Root +20, Labuschagne +14, Latham +10, Williamson +9, Pujara +6 batting overall).
- **Validation target** is on the CA model's own adjusted scale, with competition strengths fitted on every year, the
  target years included (the same caveat as docs/CA-RATINGS-REPORT.md).

