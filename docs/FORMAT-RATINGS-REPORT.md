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
| ESPN pool (`all-players.ts` / `wpl-players.ts`): ODI set "data" / "derived" | 2,254 / 3,287 | 472 / 1,907 |
| ESPN pool: Test set "data" / "derived" | 1,827 / 3,714 | 128 / 2,251 |
| League squads' fallback players (`league-rosters.ts` entries not in the pool) | 51 | 87 |
| Extended pool (shards): players, of them ODI / Test "data" | 148,469; 11,265 / 11,034 | 16,966; 3,682 / 532 |

A set is "data" when the player's main discipline in the format (by his role there, below) is measured in it.

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
- **Role in the format.** A player's role in a format comes from what he does in it, not from his T20 role (`formatRole`,
  format-model.ts): front-line if he bowls six overs an innings in the field (Tests: the Test profile's workload,
  `test-profile-data.ts`, which the Test engine picks its attack by; else his first-class record; ODIs: his List A record,
  recent seasons first), a batter if he bats in the top seven. Both: all-rounder; front-line only: bowler; otherwise
  batsman (keepers too). No record in the format: the T20 role. The role decides the normalisation below and the set's
  main side. Before round 2 the T20 role did, which squashed Shoaib Bashir's Test bowling (a T20 "batsman") to 25 / 34 / 35
  and Ben Stokes's to 42 / 39 / 26.
- **Game scale.** Equipercentile link on the ESPN-pool players who are regulars of both the format (List A 480 balls,
  first-class 1,200, women 300, rated within 3 seasons) and T20 (240 balls): the k-th best of them in the format gets the
  k-th best of their T20 discipline overalls. For bowling, both ends are front-line bowlers: front-line in the format, and a
  T20 bowler or all-rounder bowling two overs a match. A part-timer's thin record is shrunk to about average while his T20
  bowling (squashed by the runtime normalisation) sits at the bottom, so linking part-timers handed weak front-line
  bowlers part-timer ratings. Everyone else is read off that score -> overall curve (interpolated, clamped
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
- **Attributes.** The level attribute of a side (battingIQ for batting, wicketTaking for bowling) takes the side's level:
  its overall's percentile among T20 regulars, read off the T20 attribute. That is what the long formats' value measures
  (survival, wickets) and what the engines read from those attributes. The style attributes come from the player's own List
  A / first-class record against the format's current regulars, mapped by percentile onto the T20 distribution of T20
  regulars: timing from the four rate, power from the six rate, running from non-boundary scoring and strike rotation
  (Cricsheet dot balls where he has 200+ international balls), economy from runs conceded, accuracy from control. Scoring,
  survival, economy and strike rates are relative to the competition-season averages he played in (`loadRelativeRates`),
  so a Ranji Trophy seamer's economy is set against Ranji scoring and a Test bowler's against Tests; boundary rates are raw
  against today's regulars. The style attributes then absorb the rest of the side's overall (`shiftTo`; all of them only if
  they run out of room). On a format bowling side clutch takes the level too: it is 15% of bowling overall, and a copied
  T20 clutch decided how much was left for economy (Siraj's 81 against Koushik's 71). A side with fewer than 200 balls in
  the format keeps the T20 mix, shifted together. Finally the engine's `normalizeRatingsForRole` (what createPlayerFromData
  does to T20 ratings: secondary discipline, clutch floor) runs with the player's role in the format, and attributes are
  floored at 10.
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

## Round 2: roles, Test level against domestic cricket, timing

Problems found once the Test engine and its squad picker ran on the ratings, and what changed (named cases: Test set
battingIQ / timing / power / running | wicketTaking / economy / accuracy / clutch, and the Test engine's `batValue` /
`bowlValue` on its current maps, which were fitted on the round-1 ratings):

| player | round 1 | round 2 |
|---|---|---|
| Shoaib Bashir (T20 "batsman", England's Test spinner) | 20/21/47/18, 25/34/35/38; bowling 30, bowlValue -0.43 | 29/31/35/10, 57/42/45/61; bowling 53, bowlValue -0.39 |
| Jack Leach | 27/23/40/20, 80/84/83/72; bowling 80, bowlValue 0.30 | 29/40/26/10, 88/61/69/84; bowling 80, bowlValue 0.20 |
| Ben Stokes (T20 "batsman") | 81/82/85/76, 42/39/26/78; bowling 45, bowlValue -0.36 | 89/77/82/69, 88/53/73/82; bowling 79, bowlValue -0.10 |
| Vasuki Koushik (Karnataka) | 78/94/69/71; bowlValue 0.14 | 87/68/51/82; bowlValue -0.01 |
| Anshul Kamboj (Haryana) | 83/74/58/66; bowlValue -0.05 | 85/63/53/77; bowlValue -0.14 |
| Mohammed Siraj | 88/62/61/81; bowlValue -0.07 | 88/57/65/82; bowlValue -0.11 |
| Shubman Gill | 92/93/81/85; batValue 0.11 | 96/84/84/89; batValue 0.26 |
| Devdutt Padikkal | 95/92/73/86; batValue 0.17 | 92/87/78/99; batValue 0.15 |
| Sai Sudharsan | 98/92/61/85; batValue 0.17 | 90/85/72/99; batValue 0.10 |
| Emilio Gay | 89/86/66/80; batValue -0.05 | 86/92/63/88; batValue -0.04 |
| Zak Crawley | 76/81/78/78; batValue -0.10 | 83/90/64/76; batValue -0.12 |

1. **Roles.** Bashir and Stokes were squashed as T20 batsmen; the role in the format (method above) makes Bashir a bowler and
   Stokes an all-rounder in Tests. Bashir was also hurt by the link: weak front-line bowlers were placed among part-timers'
   T20 ratings. His Test bowling is now that of a below-average front-line spinner (first-class rating -6.0 runs per 100
   balls over 9,121 balls), below Leach's.
2. **Test level against domestic first-class.** The levels of Koushik (first-class rating 12.2), Kamboj (17.4) and Siraj
   (14.6) are close; what put the domestic seamers ahead in the engine was the attribute split: raw career economy (Ranji
   Trophy scoring is lower than Test scoring) and a copied T20 clutch deciding how much of the bowling overall was left for
   economy. With wicket-taking and clutch carrying the level and economy measured against each competition's own scoring,
   Kamboj falls below Siraj and Koushik's lead shrinks from 0.21 to 0.10 (on his better economy relative to the Ranji
   Trophy). Gill now leads Padikkal and Sudharsan (battingIQ carries the level, where raw first-class averages put
   Sudharsan's at 98). Gay still edges Crawley: his county record is the better one and the level says so.
   Whether international records are under-weighted, or a country's domestic cricket over-credited, was checked out of
   sample (table "International record against domestic cricket"): extra weight on the ODI / Test record gets a negative
   fitted weight (Test batting -0.1 to -0.9) and doesn't help held out; per-country domestic terms do lift held-out
   correlation (Test bowling 0.517 -> 0.557) but are positive for every country, largest for India and South Africa: the
   players who come from domestic cricket into Tests do better than their ratings, not worse. That mixes selection with home
   conditions in the target (the CA cells carry no venue), so neither is applied. The data don't support a penalty on Indian
   domestic cricket.
3. **Timing.** Timing now carries the four rate, power the six rate, running rotation. Jointly with battingIQ, as the Test
   engine fits its terms, Test fours load 0.76 per SD on timing (R2 0.33) and sixes 0.86 on power (R2 0.68); on the round-1
   sets timing's weight on Test fours was about 0.005 per SD (the Test engine's fit). On its own timing correlates only 0.20
   with the Test four rate: battingIQ carries the level, so the style attributes also absorb the rest of the overall.
4. **T20 ratings unchanged** (the pool shards' T20 fields are checked on write; all-players.ts, wpl-players.ts untouched).
   The levels (validation tables) are unchanged.

**Test benchmark** (`benchmark-test.ts 4000`, men, engine maps fitted on the round-1 ratings, before / after, real 2023+):
runs per over 3.58 / 3.74 (3.58); innings 1 runs 326 / 337 (323); balls per wicket 51.7 / 51.4 (50.6); hundreds per Test
1.69 / 1.84 (1.72); 50+ scores 6.05 / 6.38 (5.95); home / away / draw 55.8 / 33.5 / 10.7% against 56.8 / 33.7 / 9.4%
(51.4 / 39.8 / 8.9%); five-fors 1.05 / 0.99 (1.46); India's win share 58% / 72% (56%). The engine's per-outcome
regressions read the old attribute meanings (fours from power and running, survival from battingIQ fitted on raw averages),
so the scoring rates and the team spread need the refit (`test-match-model.py`, docs/FORMATS.md section 8).

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

### International record against domestic cricket (checked, not applied)

Same folds and target. `+ intl residual`: the estimate plus his ODI / Test-only adjusted value minus his List A / first-class rating, shrunk by balls / (balls + K), weight fitted on the tuning folds. `+ countries`: a term per domestic country on his share of balls there (runs per 100 balls for a player whose balls were all there, against international-only players), fitted on the tuning folds. Held-out correlation.

|  | players (tune / held out) | shipped estimate | + intl residual, K 250 / 1000 / 4000 (fitted weight) | + countries | + both (K 1000) | country terms |
|---|---|---|---|---|---|---|
| men Test batting | 282 / 94 | 0.624 | 0.627 (-0.11) / 0.629 (-0.31) / 0.632 (-0.87) | 0.634 | 0.635 | IND 8.1, ENG 2.6, AUS 8, RSA 1.2, NZ 14.8, PAK 17.7, SL 8.9, WI 6.6, BDESH 7.4, other 30 |
| men Test bowling | 241 / 94 | 0.517 | 0.511 (-0.16) / 0.507 (-0.33) / 0.508 (-0.75) | 0.557 | 0.546 | IND 24, ENG 9.1, AUS 11.1, RSA 22.3, NZ 5.7, PAK 5.7, SL 13.2, WI 5.7, BDESH -2.9, other -7.1 |
| men ODI batting | 405 / 100 | 0.427 | 0.413 (-0.31) / 0.412 (-0.68) / 0.413 (-1.83) | 0.448 | 0.439 | IND 12.4, ENG 11.1, AUS 10.2, RSA 8.7, NZ 15.1, PAK 25.8, SL 18.9, WI 12.1, BDESH 10, other 4 |
| men ODI bowling | 412 / 108 | 0.333 | 0.283 (0.24) / 0.290 (0.47) / 0.302 (1.14) | 0.352 | 0.326 | IND 20.2, ENG 9, AUS 13.8, RSA 13.7, NZ 18.8, PAK 3.1, SL 4.1, WI -1.9, BDESH 11.9, other 0.1 |

### Distributions against T20 (ESPN pool)

Final discipline overall (after attributes and normalisation) among each format's regulars (rated from data, a regular's balls, rated within 3 seasons), against the T20 overall among T20 regulars (240+ CA T20 balls in the discipline). The link is made on the players who are regulars of both, so the format rows sit where those players' T20 ratings sit; T20 regulars include many players who never play the longer formats.

**Men**

|  | regulars | linked | p10 | p25 | p50 | p75 | p90 | max |
|---|---|---|---|---|---|---|---|---|
| ODI batting | 1144 | 872 | 38 | 54 | 69 | 75 | 80 | 93 |
| Test batting | 1123 | 730 | 30 | 45 | 68 | 74 | 79 | 93 |
| T20 batting | 1582 |  | 43 | 53 | 67 | 74 | 79 | 93 |
| ODI bowling | 836 | 655 | 61 | 68 | 73 | 75 | 78 | 97 |
| Test bowling | 786 | 538 | 56 | 67 | 73 | 75 | 77 | 97 |
| T20 bowling | 1639 |  | 32 | 52 | 68 | 74 | 76 | 97 |

Attributes, p25 / p50 / p75 among the same regulars (men):

| attribute | ODI | Test | T20 |
|---|---|---|---|
| battingIQ | 55 / 70 / 79 | 42 / 68 / 78 | 54 / 67 / 78 |
| timing | 54 / 68 / 78 | 45 / 68 / 78 | 54 / 67 / 77 |
| power | 54 / 65 / 74 | 46 / 63 / 71 | 48 / 61 / 74 |
| running | 40 / 60 / 76 | 35 / 59 / 75 | 46 / 57 / 69 |
| wicketTaking | 75 / 80 / 84 | 74 / 80 / 84 | 55 / 74 / 81 |
| economy | 53 / 58 / 63 | 51 / 57 / 62 | 34 / 54 / 71 |
| accuracy | 49 / 60 / 68 | 49 / 58 / 66 | 38 / 51 / 61 |

**Women**

|  | regulars | linked | p10 | p25 | p50 | p75 | p90 | max |
|---|---|---|---|---|---|---|---|---|
| ODI batting | 331 | 263 | 31 | 46 | 63 | 70 | 77 | 95 |
| Test batting | 60 | 55 | 42 | 50 | 67 | 78 | 85 | 95 |
| T20 batting | 652 |  | 32 | 40 | 50 | 64 | 72 | 95 |
| ODI bowling | 184 | 167 | 67 | 70 | 72 | 75 | 77 | 82 |
| Test bowling | 63 | 54 | 71 | 72 | 74 | 75 | 78 | 82 |
| T20 bowling | 688 |  | 31 | 45 | 62 | 71 | 74 | 87 |

Attributes, p25 / p50 / p75 among the same regulars (women):

| attribute | ODI | Test | T20 |
|---|---|---|---|
| battingIQ | 50 / 67 / 78 | 53 / 73 / 89 | 42 / 53 / 68 |
| timing | 45 / 63 / 73 | 50 / 64 / 77 | 41 / 52 / 67 |
| power | 41 / 55 / 64 | 49 / 64 / 76 | 35 / 44 / 56 |
| running | 43 / 61 / 74 | 49 / 63 / 75 | 39 / 49 / 63 |
| wicketTaking | 69 / 73 / 76 | 74 / 76 / 78 | 41 / 60 / 69 |
| economy | 70 / 74 / 77 | 66 / 72 / 76 | 45 / 65 / 76 |
| accuracy | 66 / 72 / 77 | 61 / 67 / 79 | 51 / 60 / 69 |

### Top 25 (ESPN pool)

`~` = derived (no usable record in the format), `*` = capped. T20 = the same player's T20 discipline overall.

**Men, ODI batting**: Shubman Gill (India) 93 [T20 87], Virat Kohli (India) 92 [T20 87], Harry Brook (England) 92 [T20 93], KL Rahul (India) 91 [T20 87], Heinrich Klaasen (South Africa) 90 [T20 88], Abhishek Sharma (India) 89 [T20 92], Travis Head (Australia) 89 [T20 85], Rohit Sharma (India) 89 [T20 80], Joe Root (England) 89 [T20 72], Finn Allen (New Zealand) 88 [T20 91], Mitchell Marsh (Australia) 88 [T20 88], Jos Buttler (England) 88 [T20 88], Shreyas Iyer (India) 88 [T20 88], Lhuan-dre Pretorius (South Africa) 88 [T20 85], David Miller (South Africa) 88 [T20 84], David Warner (Australia) 88 [T20 87], Will Jacks (England) 87 [T20 87], Nicholas Pooran (West Indies) 87 [T20 89], Ryan Rickelton (South Africa) 87 [T20 89], Ishan Kishan (India) 87 [T20 89], Glenn Phillips (New Zealand) 87 [T20 87], Dewald Brevis (South Africa) 87 [T20 87], Tom Banton (England) 87 [T20 82], Ben Duckett (England) 87 [T20 81], Kieron Pollard (West Indies) 87 [T20 89]

**Men, ODI bowling**: Jasprit Bumrah (India) 97 [T20 97], Rashid Khan (Afghanistan) 93 [T20 92], Mitchell Starc (Australia) 92 [T20 79], Pat Cummins (Australia) 91 [T20 77], Matt Henry (New Zealand) 89 [T20 74], Josh Hazlewood (Australia) 88 [T20 84], Kuldeep Yadav (India) 87 [T20 87], Kagiso Rabada (South Africa) 87 [T20 79], Trent Boult (New Zealand) 86 [T20 82], Varun Chakravarthy (India) 85* [T20 87], Wanindu Hasaranga (Sri Lanka) 85 [T20 91], Sunil Narine (West Indies) 85 [T20 93], Mohammed Shami (India) 85 [T20 78], Shaheen Shah Afridi (Pakistan) 85 [T20 81], Joel Paris (Australia) 85 [T20 76], Mitchell Santner (New Zealand) 84 [T20 85], Adam Zampa (Australia) 84 [T20 85], Nathan Coulter-Nile (Australia) 84 [T20 77], Scott Boland (Australia) 84 [T20 73], Jofra Archer (England) 83 [T20 86], Yuzvendra Chahal (India) 83 [T20 85], Nathan Ellis (Australia) 83 [T20 80], Ravichandran Ashwin (India) 83 [T20 84], Peter Siddle (Australia) 83 [T20 77], Kyle Abbott (South Africa) 83 [T20 72]

**Men, Test batting**: Harry Brook (England) 93 [T20 93], Joe Root (England) 92 [T20 72], Travis Head (Australia) 89 [T20 85], Ben Duckett (England) 89 [T20 81], Steven Smith (Australia) 89 [T20 84], Shubman Gill (India) 88 [T20 87], Virat Kohli (India) 88 [T20 87], Rishabh Pant (India) 88 [T20 82], Ryan Rickelton (South Africa) 87 [T20 89], Ishan Kishan (India) 87 [T20 89], Cameron Green (Australia) 87 [T20 84], KL Rahul (India) 87 [T20 87], Yashasvi Jaiswal (India) 87 [T20 83], Dhruv Jurel (India) 87 [T20 80], David Warner (Australia) 87 [T20 87], Dan Lawrence (England) 87 [T20 81], Jamie Smith (England) 87 [T20 79], Kane Williamson (New Zealand) 87 [T20 78], Alex Carey (Australia) 87 [T20 70], David Bedingham (South Africa) 87 [T20 69], Quinton de Kock (South Africa) 86 [T20 84], Mitchell Marsh (Australia) 86 [T20 88], Ravindra Jadeja (India) 86 [T20 80], Jos Buttler (England) 86 [T20 88], Rachin Ravindra (New Zealand) 86 [T20 77]

**Men, Test bowling**: Jasprit Bumrah (India) 97 [T20 97], Mitchell Starc (Australia) 92 [T20 79], Kyle Abbott (South Africa) 91 [T20 72], Pat Cummins (Australia) 88 [T20 77], Matt Henry (New Zealand) 87 [T20 74], Scott Boland (Australia) 86 [T20 73], Josh Hazlewood (Australia) 85 [T20 84], Trent Boult (New Zealand) 85 [T20 82], Kagiso Rabada (South Africa) 85 [T20 79], Joel Paris (Australia) 85 [T20 76], Sam Cook (England) 85 [T20 74], Ollie Robinson (England) 85 [T20 70], Mohammed Shami (India) 84 [T20 78], George Hill (England) 84 [T20 37], Jofra Archer (England) 83 [T20 86], Ravichandran Ashwin (India) 83 [T20 84], Shaheen Shah Afridi (Pakistan) 83 [T20 81], Michael Neser (Australia) 83 [T20 73], Matthew Potts (England) 83 [T20 72], Craig Overton (England) 82 [T20 41], Daniel Worrall (England) 82 [T20 80], Chris Woakes (England) 82 [T20 74], Peter Siddle (Australia) 82 [T20 77], Chris Tremain (Australia) 82 [T20 73], Ben Sanderson (England) 82 [T20 74]

**Women, ODI batting**: Shafali Verma (India) 95 [T20 92], Beth Mooney (Australia) 94 [T20 87], Nat Sciver-Brunt (England) 92 [T20 95], Smriti Mandhana (India) 92 [T20 92], Phoebe Litchfield (Australia) 87 [T20 94], Grace Harris (Australia) 87 [T20 87], Alyssa Healy (Australia) 87 [T20 79], Danni Wyatt-Hodge (England) 85 [T20 85], Annabel Sutherland (Australia) 85 [T20 80], Meg Lanning (Australia) 85 [T20 81], Georgia Voll (Australia) 85 [T20 81], Sophie Devine (New Zealand) 83 [T20 82], Ellyse Perry (Australia) 82 [T20 87], Ashleigh Gardner (Australia) 82 [T20 85], Laura Wolvaardt (South Africa) 82 [T20 82], Marizanne Kapp (South Africa) 81 [T20 78], Freya Kemp (England) 81 [T20 79], Jemimah Rodrigues (India) 81 [T20 80], Harmanpreet Kaur (India) 81 [T20 79], Rachael Haynes (Australia) 81 [T20 77], Georgia Wareham (Australia) 80 [T20 85], Hayley Matthews (West Indies) 80 [T20 80], Lizelle Lee (South Africa) 80 [T20 83], Maia Bouchier (England) 80 [T20 79], Amelia Kerr (New Zealand) 79 [T20 80]

**Women, ODI bowling**: Sophie Ecclestone (England) 82 [T20 82], Jess Jonassen (Australia) 81 [T20 76], Alana King (Australia) 80 [T20 77], Ashleigh Gardner (Australia) 79 [T20 76], Sophie Molineux (Australia) 79 [T20 79], Megan Schutt (Australia) 79 [T20 78], Amanda-Jade Wellington (Australia) 79 [T20 78], Lauren Cheatle (Australia) 78 [T20 32], Hayley Matthews (West Indies) 78 [T20 77], Annabel Sutherland (Australia) 78 [T20 77], Charlie Dean (England) 78 [T20 78], Poonam Yadav (India) 78 [T20 75], Molly Strano (Australia) 78 [T20 77], Anesu Mushangwe (Zimbabwe) 78 [T20 74], Amelia Kerr (New Zealand) 77 [T20 79], Deepti Sharma (India) 77 [T20 79], Kim Garth (Australia) 77 [T20 77], Nicola Carey (Australia) 77 [T20 72], Shabnim Ismail (South Africa) 77 [T20 81], Leigh Kasperek (New Zealand) 77 [T20 75], Linsey Smith (England) 77 [T20 75], Anya Shrubsole (England) 77 [T20 76], Salma Khatun (Bangladesh) 77 [T20 74], Afy Fletcher (West Indies) 77 [T20 74], Belinda Vakarewa (Australia) 77 [T20 77]

**Women, Test batting**: Nat Sciver-Brunt (England) 95 [T20 95], Shafali Verma (India) 94 [T20 92], Smriti Mandhana (India) 92 [T20 92], Beth Mooney (Australia) 92 [T20 87], Phoebe Litchfield (Australia) 87 [T20 94], Ellyse Perry (Australia) 87 [T20 87], Danni Wyatt-Hodge (England) 85 [T20 85], Annabel Sutherland (Australia) 85 [T20 80], Laura Wolvaardt (South Africa) 85 [T20 82], Meg Lanning (Australia) 85 [T20 81], Heather Knight (England) 82 [T20 82], Jemimah Rodrigues (India) 82 [T20 80], Harmanpreet Kaur (India) 81 [T20 79], Sophia Dunkley (England) 80 [T20 85], Alyssa Healy (Australia) 80 [T20 79], Marizanne Kapp (South Africa) 79 [T20 78], Ashleigh Gardner (Australia) 79 [T20 85], Richa Ghosh (India) 78 [T20 81], Alice Capsey (England) 77 [T20 76], Tahlia McGrath (Australia) 77 [T20 75], Maia Bouchier (England) 77 [T20 79], Anneke Bosch (South Africa) 76 [T20 78], Jess Jonassen (Australia) 76 [T20 76], Rachael Haynes (Australia) 76 [T20 77], Tazmin Brits (South Africa) 75 [T20 75]

**Women, Test bowling**: Deepti Sharma (India) 82 [T20 79], Ashleigh Gardner (Australia) 79 [T20 76], Sophie Ecclestone (England) 79 [T20 82], Vaishnavi Sharma (India) 79 [T20 76], Alana King (Australia) 78 [T20 77], Sophie Molineux (Australia) 78 [T20 79], Nahida Akter (Bangladesh) 78 [T20 73], Annabel Sutherland (Australia) 77 [T20 77], Jess Jonassen (Australia) 77 [T20 76], Poonam Yadav (India) 77 [T20 75], Salma Khatun (Bangladesh) 77 [T20 74], Rabeya Khan (Bangladesh) 76 [T20 74], Tanuja Kanwar (India) 76 [T20 75], Minnu Mani (India) 76 [T20 73], Jannatul Ferdus (Bangladesh) 76 [T20 73], Lauren Cheatle (Australia) 75 [T20 32], Marizanne Kapp (South Africa) 75 [T20 87], Ellyse Perry (Australia) 75 [T20 74], Charlie Dean (England) 75 [T20 78], Lauren Bell (England) 75 [T20 79], Sneh Rana (India) 75 [T20 72], Rajeshwari Gayakwad (India) 75 [T20 74], Sultana Khatun (Bangladesh) 75 [T20 74], Ekta Bisht (India) 74~* [T20 75], Gouher Sultana (India) 74~* [T20 73]

### Specialists

| player | T20 bat / bowl (overall) | ODI | Test |
|---|---|---|---|
| Cheteshwar Pujara | 76 / 28 (76) | 79 / 28 (79) | 82 / 28 (82) |
| Nathan Lyon | 53 / 78 (80) | 42 / 78 (79) | 31 / 80 (80) |
| Joe Root | 72 / 44 (73) | 89 / 46 (89) | 92 / 45 (92) |
| Steven Smith | 84 / 31 (84) | 87 / 31 (87) | 89 / 31 (89) |
| Kane Williamson | 78 / 31 (78) | 82 / 31 (82) | 87 / 31 (87) |
| Marnus Labuschagne | 68 / 40 (69) | 82 / 46 (83) | 82 / 46 (83) |
| Usman Khawaja | 82 / 30 (82) | 81 / 30 (81) | 86 / 30 (86) |
| Ajinkya Rahane | 76 / 31 (76) | 79 / 31 (79) | 77 / 31 (77) |
| Tom Latham | 72 / 31 (72) | 78 / 31 (78) | 82 / 31 (82) |
| Scott Boland | 49 / 73 (75) | 40 / 84 (84) | 30 / 86 (86) |
| Josh Hazlewood | 27 / 84 (84) | 27 / 88 (88) | 31 / 85 (85) |
| Andre Russell | 88 / 71 (91) | 69 / 73 (79, derived) | 68 / 73 (79, derived) |
| Sunil Narine | 34 / 93 (93) | 34 / 85 (85) | 49 / 73 (75, derived) |
| Kieron Pollard | 89 / 71 (92) | 87 / 46 (88) | 68 / 41 (69, derived) |
| Nicholas Pooran | 89 / 31 (89) | 87 / 31 (87) | 68 / 31 (68, derived) |
| Tim David | 92 / 30 (92) | 84 / 45 (85) | 68 / 30 (68, derived) |
| Rovman Powell | 86 / 30 (86) | 81 / 45 (82) | 68 / 65 (74, derived) |
| Sherfane Rutherford | 87 / 30 (87) | 82 / 30 (82) | 68 / 64 (73, derived) |
| Romario Shepherd | 88 / 45 (88) | 48 / 72 (73) | 47 / 71 (72, derived) |
| Abhishek Sharma | 92 / 45 (92) | 89 / 45 (89) | 83 / 45 (84) |
| Rinku Singh | 87 / 29 (87) | 84 / 45 (85) | 82 / 45 (83) |
| Varun Chakravarthy | 21 / 87 (87) | 21 / 85 (85) | 21 / 73 (73, derived) |
| Liam Livingstone | 83 / 68 (87) | 83 / 46 (84) | 77 / 73 (84) |

| player | T20 bat / bowl (overall) | ODI | Test |
|---|---|---|---|
| Ellyse Perry | 87 / 74 (91) | 82 / 45 (83) | 87 / 75 (91) |
| Nat Sciver-Brunt | 95 / 73 (96) | 92 / 45 (92) | 95 / 73 (96) |
| Smriti Mandhana | 92 / 31 (92) | 92 / 31 (92) | 92 / 31 (92) |
| Beth Mooney | 87 / 31 (87) | 94 / 31 (94) | 92 / 31 (92) |
| Meg Lanning | 81 / 32 (81) | 85 / 32 (85) | 85 / 32 (85) |
| Heather Knight | 82 / 72 (87) | 79 / 46 (80) | 82 / 46 (83) |
| Sophie Ecclestone | 47 / 82 (83) | 43 / 82 (83) | 30 / 79 (79) |
| Deepti Sharma | 77 / 79 (86) | 76 / 77 (85) | 73 / 82 (87) |
| Chinelle Henry | 79 / 46 (80) | 76 / 45 (77) | 68 / 39 (69, derived) |
| Deandra Dottin | 75 / 72 (82) | 74 / 45 (75) | 68 / 72 (78, derived) |

Bowling overall of specialist batsmen (T20 role batsman; 3834 men, 324 of them with a T20 batting overall of 75+), p10 / p25 / p50 / p75 / p90 / max. A side the player doesn't do in the format (under 6 balls a match over his career or his last three seasons of it) keeps his T20 level; batsmen who do bowl part-time in the format sit at the batsman's secondary-discipline ceiling (about 44-46), as part-timers do in T20.

|  | T20 | ODI | Test |
|---|---|---|---|
| all specialist batsmen | 26 / 28 / 30 / 31 / 32 / 46 | 27 / 29 / 30 / 30 / 41 / 83 | 27 / 29 / 30 / 30 / 45 / 84 |
| T20 batting 75+ | 28 / 28 / 30 / 32 / 45 / 46 | 28 / 28 / 30 / 40 / 45 / 79 | 28 / 29 / 30 / 40 / 64 / 79 |

Men, by group (mean rating of the group in each format). The T20 ratings of first-class specialists with a thin T20 record were themselves rated from their first-class cricket by the T20 pipeline (T20-unproven sides), so those groups' T20 and Test means coincide; the players above show the movement for specialists with a real T20 record.

| group | players | T20 | ODI | Test | rating |
|---|---|---|---|---|---|
| Test batting specialists: 4000+ first-class balls at 40+ a match, under 1500 T20 balls | 300 | 66.0 | 68.1 | 69.0 | batting |
| Test bowling specialists: 6000+ first-class balls bowled, under 1200 T20 balls | 150 | 58.7 | 66.0 | 69.2 | bowling |
| White-ball only: T20 overall 75+, no first-class ball (94 derived in Tests) | 94 | 77.8 | 68.6 | 68.4 | overall |
| T20 only: T20 overall 75+, no List A or first-class ball (45 derived in ODIs) | 45 | 77.9 | 70.0 | 69.3 | overall |

### Attribute mix

Men with 1,000+ Cricsheet balls in the format (career, so in-sample: a consistency check, not a validation): correlation of a batting attribute with the stat it stands for in that format, for the format's own set and for the player's T20 set.

| format | players | attribute | stat in the format | format set | T20 set |
|---|---|---|---|---|---|
| ODI | 147 | power | six % | 0.735 | 0.664 |
| ODI | 147 | timing | four % | 0.625 | 0.320 |
| ODI | 147 | timing | boundary % | 0.423 | 0.225 |
| ODI | 147 | battingIQ | balls per dismissal | 0.277 | 0.248 |
| ODI | 147 | battingIQ | average | 0.586 | 0.460 |
| ODI | 147 | running | fewer dot balls | 0.560 | 0.304 |
| ODI | 147 | batting overall | average | 0.591 | 0.460 |
| Test | 163 | power | six % | 0.037 | 0.249 |
| Test | 163 | timing | four % | 0.198 | 0.265 |
| Test | 163 | timing | boundary % | 0.036 | 0.173 |
| Test | 163 | battingIQ | balls per dismissal | 0.685 | 0.538 |
| Test | 163 | battingIQ | average | 0.792 | 0.669 |
| Test | 163 | running | fewer dot balls | 0.434 | 0.183 |
| Test | 163 | batting overall | average | 0.801 | 0.660 |

The same players, each rate regressed on the four batting attributes together (ball-weighted, z-scored attributes, weights in SDs of the rate per SD of the attribute), as the Test engine fits its scoring terms. A format set's battingIQ carries its level, so timing, power and running carry the style given the level: fours through timing, sixes through power, singles through running.

| format | ratings | players | four %: battingIQ / timing / power / running | six %: battingIQ / timing / power / running |
|---|---|---|---|---|
| ODI | ODI set | 147 | -0.05 / 0.81 / 0.17 / -0.43 (R2 0.65) | 0.18 / -0.26 / 0.69 / -0.30 (R2 0.75) |
| ODI | T20 set | 147 | -0.04 / 0.42 / 0.29 / -0.14 (R2 0.30) | 0.07 / 0.03 / 0.52 / -0.24 (R2 0.61) |
| Test | Test set | 163 | -0.33 / 0.76 / 0.26 / -0.47 (R2 0.33) | -0.19 / -0.38 / 0.86 / -0.45 (R2 0.68) |
| Test | T20 set | 163 | -0.28 / 0.56 / 0.27 / -0.23 (R2 0.37) | -0.49 / 0.26 / 0.42 / -0.13 (R2 0.54) |

### ICC rankings (validation only)

Latest ICC top 100 (2026-11-02/03) matched to the ESPN pool by name (and team where names repeat). Spearman correlation of ICC points with our format overall and with the same players' T20 overall; `top 25 overlap` = ICC top 25 players (matched) who are also in our top 25 for the format. Rankings weigh recent international form only and cover the top 100 only, so a modest correlation is expected.

| ranking | ICC players | matched | Spearman (format rating) | Spearman (T20 rating) | top 25 overlap |
|---|---|---|---|---|---|
| male ODI batting | 101 | 98 | 0.579 | 0.421 | 8 / 25 |
| male ODI bowling | 100 | 99 | 0.465 | 0.421 | 9 / 25 |
| male Test batting | 100 | 95 | 0.625 | 0.333 | 12 / 25 |
| male Test bowling | 100 | 89 | 0.615 | 0.324 | 7 / 25 |
| female ODI batting | 100 | 98 | 0.547 | 0.575 | 14 / 25 |
| female ODI bowling | 100 | 94 | 0.592 | 0.629 | 11 / 25 |

### Sources

male: {"espn":{"odiData":2254,"testData":1827,"odiDerived":3287,"testDerived":3714},"extended":{"odiData":11265,"testData":11034},"league":{"odiData":41,"testData":35,"players":51}}
female: {"espn":{"odiData":472,"testData":128,"odiDerived":1907,"testDerived":2251},"extended":{"odiData":3682,"testData":532},"league":{"odiData":80,"testData":23,"players":87}}

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
- **Attribute mix.** battingIQ / wicketTaking carry the level and the style attributes the rest of the overall, so on their
  own timing and power correlate only loosely with the Test four and six rates (0.20 and 0.04); given battingIQ they carry
  them (0.76 and 0.86 per SD). Boundary and dot-ball rates are raw career rates against today's regulars (not competition-
  relative: the CA cells have no boundaries).
- **Domestic against Test level.** The out-of-sample check finds no over-credited domestic competition; it can't separate
  home conditions or selection from level, and Koushik still edges Siraj in the engine's bowling value on Ranji economy.
- **Part-timers** who bowl 6+ balls a match in a format sit at the batsman's secondary ceiling (about 45) whatever their
  T20 bowling (Tim David, Rinku Singh, Travis Head); front-line bowlers by workload are bowlers or all-rounders in that
  format even when their T20 role is batsman (Romario Shepherd, Chamika Karunaratne, Cameron Green, Shivam Dube).
- **Static in career mode.** Format sets don't progress with `Player.progress()`; after some seasons a player's ODI / Test
  ratings lag his T20 development. Generated players (regens, youth, generated pools) have none and play every format on
  their T20 ratings.
- **The Test specialists group check** (format-ratings-report.ts) shows no group-level lift: first-class specialists with a
  thin T20 record were already rated from first-class cricket by the T20 pipeline. Named specialists with real T20 records
  do move (Root +20, Labuschagne +14, Latham +10, Williamson +9, Pujara +6 batting overall).
- **Validation target** is on the CA model's own adjusted scale, with competition strengths fitted on every year, the
  target years included (the same caveat as docs/CA-RATINGS-REPORT.md).

