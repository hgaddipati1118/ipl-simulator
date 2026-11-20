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
| ESPN pool (`all-players.ts` / `wpl-players.ts`): ODI set "data" / "derived" | 2,255 / 3,286 | 472 / 1,907 |
| ESPN pool: Test set "data" / "derived" | 1,827 / 3,714 | 128 / 2,251 |
| League squads' fallback players (`league-rosters.ts` entries not in the pool) | 51 | 87 |
| Extended pool (shards, all tiers): players, of them ODI / Test "data" | 692,106; 76,548 / 50,484 | 41,752; 6,603 / 930 |

A set is "data" when the player's main discipline in the format (by his role there, below) is measured in it.

## Method

- **Level.** Per player, format (ODI = CricketArchive List A, Test = first-class) and side, `format-model.ts`: the player's
  latest CA rating in the format (decayed, shrunk, competition- and opponent-adjusted; internationals are split by opponent
  inside List A / first-class, so an ODI against a strong side counts for more than a domestic one-dayer), blended by
  inverse variance with a prior translated from his other formats (the most precise of T20 and the other long format;
  weighted least squares over players rated in both, residual variance added). For bowling, the T20 -> ODI / Test prior also
  uses the bowler's T20 economy and strike rate: T20 value rewards economy, the longer formats wickets, and the term lifted
  held-out accuracy (0.32 -> 0.36 ODI, 0.20 -> 0.24 Test); the same linear term for batting (T20 strike rate, balls per dismissal)
  lowered it, so batting has none; the bias round (below) adds a hinge for the top hitters, a prior from T20 and List A together
  for Test batting, and a calibration of thin batting records. The rating's sd is widened for staleness (x 2^(seasons / CA half-life), at most two
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
| men ODI batting | **0.444** (n 100) | 0.378 | 0.310 | 0.341 career intl | **0.590** (505) | 0.559 | 0.487 |
| men ODI bowling | **0.333** (108) | 0.277 | 0.324 | 0.076 last season | **0.395** (520) | 0.362 | 0.223 |
| men Test batting | **0.634** (94) | 0.616 | 0.237 | 0.605 last season | **0.621** (376) | 0.609 | 0.264 |
| men Test bowling | **0.517** (94) | 0.516 | 0.203 | 0.205 career intl | **0.451** (335) | 0.442 | 0.085 |
| women ODI batting | **0.709** (88) | 0.703 | 0.664 | 0.668 career intl | **0.702** (300) | 0.690 | 0.656 |
| women ODI bowling | **0.668** (96) | 0.656 | 0.625 | 0.441 career intl | **0.537** (326) | 0.529 | 0.443 |

- The format ratings beat the T20 ratings (what the game plays every format on without them) everywhere; by a wide margin
  in Tests (0.63 vs 0.24 batting, 0.52 vs 0.20 bowling held out), modestly in ODIs. Held-out samples are about 100 players,
  so a single cell's correlation is uncertain by about +-0.08: men's ODI bowling held out (0.333 vs 0.324) is a tie, the
  pooled folds show the gain (0.395 vs 0.223).
- The translated prior adds information over the format's own record everywhere (pooled +0.01 to +0.03).
- Derived ratings (each player's format record hidden): ODI 0.42 / 0.38 men, 0.66 / 0.65 women; Test 0.53 / 0.40 men, all
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

**ODI benchmark** (`benchmark-odi.ts 2 both`, round-1 / round-2 ODI sets, real 2019+): men's first-innings total 251.9 /
240.4 (253.1), 300+ 28.4 / 20.6% (24.8%), team win-share correlation with real 0.76 / 0.77, spread of win shares 0.16 /
0.13 (0.12); women's 226.8 / 227.3 (227.4), 300+ 15.6 / 12.5% (15.6%). The ODI engine's composites (`ODI_REF`, `ODI_CAL`)
were calibrated on the round-1 sets; its step 2 recalibration (docs/FORMATS.md, ODI, Refitting) brings the totals back.

## Bias round: T20 hitters, thin records, India and Australia

Two complaints: strong T20 hitters rate too high in ODIs and Tests when their List A / first-class record is thin or old (Pollard and
Pooran 87 for ODIs, Finn Allen 88, Ishan Kishan 87 and Abhishek Sharma 83 in Tests), and India and Australia win 70% / 69% of
simulated Tests against 56% / 57% since 2015. Everything below is on-field data (ICC rankings, IPL MVP and prices were not used, even
as checks inside the fits); the evidence is `format-bias-check.ts` (`data/analysis/format-bias-check.md`), the gate for every change
is held-out correlation (the validation above) and the actual-XI country benchmark (docs/COUNTRY-VALIDATION.md).

### 1. T20 hitters

**Cause.** The translation from the T20 rating to the List A / first-class rating is one line (Test: 8.3 + 0.59 x T20 rating). Among
the 1,271 (ODI) and 1,077 (Test) players rated in both, those whose T20 rating is earned by strike rate rather than by staying in
(hitterness = T20 strike-rate z minus survival z) have a long-format rating well below that line, and the gap is steady from 2014 to
2026 (the fitted hinge below, by fold):

| hitterness (eight equal groups of players) | ODI: mean residual | Test: mean residual |
|---|---|---|
| lowest | +1.3 | +2.2 |
| 2nd to 5th | -0.3, +0.7, -1.1, -0.3 | +1.0, -0.4, +0.6, -0.6 |
| 6th | -0.3 | -1.5 |
| 7th (0.8 to 1.4) | -1.1 | -3.6 |
| highest (1.4 and up) | **-3.9** | **-6.5** |

Hinge coefficient on hitterness above 1.5 (runs per 100 balls per unit): ODI -1.4 (2014), -2.7, -3.0, -2.8, -5.7 (2026 pairs); Test
-4.5, -4.4, -5.4, -5.9, -7.7. So the prior of a pure hitter, which carries 50-90% of a thin or old record's estimate, was too high by
the amount of the hinge, and a stale List A record (Pollard's last is 2022, Pooran's 2023) leaves the prior almost all of it.

**Tried, and not shipped** (held-out correlation, men's batting, rated through 2023 and predicting 2024-25, with the other changes
in place; `format-bias-check.ts` section A):

| translation | ODI held out | ODI pooled | ODI derived | Test held out | Test pooled | Test derived |
|---|---|---|---|---|---|---|
| T20 rating only | 0.431 | 0.588 | 0.392 | 0.626 | 0.615 | 0.492 |
| **hinge above 1.5 (shipped)** | **0.444** | **0.590** | **0.417** | **0.627** | **0.615** | **0.499** |
| linear in hitterness (the earlier batting style term) | 0.413 | 0.584 | 0.366 | 0.619 | 0.614 | 0.457 |

The linear term fits the pairs best (cross-validated residual variance 83.8 against 90.4 for Test, 88.4 against 90.1 for ODI) but
lowers the held-out correlation, as the earlier round found: it lifts the players who stay in as much as it lowers the hitters, and in
2024-25 (the 2023 fold) the picked hitters did well. The hinge moves only the top hitters and does not hurt any fold. Also tried: a
slope change at the top of the T20 range (coefficients flip sign between folds), longer or shorter staleness for the sd (held-out
correlation flat from 1 to 8 seasons; on all later cricket of players whose record is 2+ seasons old, 2 seasons is the peak: 0.437,
against 0.411 with none and 0.433 with 4), and a second-source prior for List A and for bowling (below).

**Shipped.**

1. **A hinge on hitterness in the batting translation from T20** (`OPTS.hitterH0` = 1.5, `Translation.hit`; fitted with the line on
   the players rated in both, per fold, so the held-out folds never see their own pairs).
2. **A thin-record calibration** (`EstimateContext.thin`, fitted in `validate`; batting only). Against what every rated player did in
   *all* later cricket of the format (not only the internationals that selection picks), an estimate in the top fifth that rests on less
   than the caps' small-sample threshold (1,000 List A, 2,400 first-class balls) falls short of the same estimate on a thick record by
   2-4 runs per 100 balls (table below). The slope of "later minus estimate" on thinness x the excess over the median is 0.32 (List A)
   and 0.29 (first-class) on the tuning folds; the estimate is lowered by kappa x thinness x excess.
   Bowling is not calibrated (0, 0.5 and 0.8 on different folds; it lowered the pooled first-class correlation 0.451 -> 0.443).

   | format | estimate band | thin record: players, later minus estimate | thick record: players, later minus estimate |
   |---|---|---|---|
   | ODI | 80-90% | 66, 0.9 | 258, 5.6 |
   | ODI | 90-100% | 22, 3.3 | 303, 5.1 |
   | Test | 80-90% | 156, 1.4 | 439, 2.3 |
   | Test | 90-100% | 51, -2.6 | 546, 1.1 |

3. **A prior from T20 and List A together for Test batting** (`OPTS.multi`, `multiCells` = first-class batting): where a player has
   both and the pair's prior is the more precise, the first-class rating is predicted from both in one regression (0.28 T20 + 0.44 List
   A, residual variance 74 against 90), instead of from the better single source. Held-out first-class batting 0.624 -> 0.631 before the
   hinge, pooled 0.616 -> 0.623, the tuning folds +0.006. The same for List A batting lowered the held-out fold (0.427 -> 0.414; the
   other three folds rose), and for List A bowling it took Pat Cummins' ODI bowling from 91 to 87, so only the Test batting cell ships.

**Named players** (overall in the format, before -> after):

| player | T20 bat | ODI batting | Test batting |
|---|---|---|---|
| Finn Allen (New Zealand) | 91 | 88 -> 82 | 83 -> 72 |
| Abhishek Sharma (India) | 92 | 89 -> 85 | 83 -> 76 |
| Aneurin Donald (England) | 86 | 87 -> 77 | 78 -> 69 |
| Tim David (Australia) | 92 | 84 -> 82 | 68 -> 68 |
| Glenn Maxwell (Australia) | 86 | 85 -> 82 | 82 -> 78 |
| Rachin Ravindra (New Zealand) | 77 | 83 -> 81 | 86 -> 82 |
| Tilak Varma (India) | 89 | 81 -> 82 | 85 -> 82 |
| Ishan Kishan (India) | 89 | 87 -> 88 | 87 -> 87 |
| Kieron Pollard (West Indies) | 89 | 87 -> 87 | 68 -> 68 |
| Nicholas Pooran (West Indies) | 89 | 87 -> 87 | 68 -> 68 |

Maxwell and Ravindra are real regulars who are also hitters by style (hitterness 2.5 and 2.4); their prior was as inflated as the
others', and their own records pull them back only part of the way. **Pollard, Pooran and Kishan do not move, and the data give no reason
to move them.** Pollard's and Pooran's hitterness is 1.4 (just under the hinge) and their List A records are real, 3,668 and 2,914 balls,
but stale (2022, 2023): the staleness rule gives the translated T20 prior 90% and 80% of the weight, and no staleness rule beat it out of
sample. Kishan's Test 87 is mostly his first-class record, not his T20: his first-class rating rose from 21 to 30 in the latest
season, and the T20 prior (0.47 of the weight) agrees with it. Making a record older than three seasons "derived" (rating capped at the
median of the format's regulars, 69 for ODI batting) would put Pollard and Pooran at 69; it is a judgement, not a measured
correction, and is left to Harsha.

**The elite players keep their standing.** Joe Root 92, Virat Kohli 88, Steven Smith 89, Kane Williamson 87 (Tests; ODIs 89 / 92 / 87 /
82), Jasprit Bumrah 97, Pat Cummins 88 / 91, Kagiso Rabada 85 / 87, Mitchell Starc 92 / 92, Ravichandran Ashwin 83 / 83, Ravindra
Jadeja 86 / 84, Harry Brook 93 / 92, Shubman Gill 89 / 93: no change beyond one point. Of every ESPN-pool player at 85 or more in a
format, the ones that drop by more than 2 are the hitters in the table above (Allen, Abhishek Sharma, Donald, Maxwell in ODIs; Ravindra in
Tests) and Tilak Varma in Tests (85 -> 82, through the two-source prior and the thin-record calibration).

### 2. India and Australia in Tests

**What was found** (nothing in the ratings is changed for this):

- *The comparison.* The 70% / 69% is the simulated win share of the best eleven of every nation, all pairings, against real win shares
  since 2015 with draws counted (2026 squads against history). On the real fixtures of the 133 Tests since 2023 (decisive results; 256
  replays), the best elevens win 68% for India against a real 53% and 70% for Australia against a real 69%; with the elevens that really
  played, 66% and 73% (512 replays). Australia is not out of line in either window; India is 1.5 standard errors above (standard error
  about 9 points on 30 Tests), and who played explains two of its fifteen points. England (63% against 52%) is as far out; South Africa
  (55% against 78%) and New Zealand (55% against 65%) are far below.
- *Player ratings are not inflated.* Test value in the next two seasons minus the estimate, pooled over three held-out folds, against
  the mean over all teams (batting): India -0.9, Australia -2.7, England -2.6, South Africa -2.3, New Zealand +7.6, Pakistan +6.0, Sri
  Lanka +2.9 (bowling): India +3.6, Australia -0.2, South Africa +9.0. Standard error 3-4. India's and Australia's players do as the
  ratings say or better; the teams the ratings under-rate are South Africa (bowlers) and New Zealand (batters), which are also the
  sides whose simulated results are furthest below their real ones (South Africa 54% against 78%, New Zealand 52% against 65%).
- *Home conditions do not inflate their records.* Ground factors (100 = average ground; Tests): India 95.3 runs, 98.8 wickets
  (domestic first-class 97.2 / 98.0), Australia 100.6 / 102.6 (domestic 97.7 / 103.6), England 103.3 / 104.4, South Africa 101.1 / 106.8.
  India's grounds take runs and, if anything, wickets away: a Test record made there is harder, not easier. The most a home share can
  add to an Australian seamer's wickets is about 1.5%.
- *No domestic competition is over-credited, and Ranji and Sheffield Shield least.* The per-country domestic terms of the
  international-record check (above) are India 10, Australia 9.2, England 3.4, South Africa 2.2 for batting: England's and South
  Africa's domestic cricket are the generous ones.
- *Opposition adjustment for Tests would move the wrong teams.* The ODI adjustment lowers players of weak nations whose record is
  mostly against weak opposition. For Tests it could only lower West Indies, Bangladesh, Zimbabwe and Pakistan, which would raise India
  and Australia's win rates. Not built.
- *Where the gap sits.* The Test engine's home sides win 57.5% against a real 51.4% (away 34.4% against 39.8%); India at home wins 83%
  of the real fixtures' replays against 59% real, away 50% against 50%. That is the engine's home advantage and the spread of team
  strength (no Test entry in `series-tuning-data.ts`), not the ratings. Test batting ratings are also over-dispersed against what
  followed: later value on the estimate has slope 0.76 (1 = calibrated; 0.76-0.87 on every fold), which over-states the gap between
  the top and the middle teams. A fix that corrects it by compressing the top would cost Root, Brook and Smith 4-5 points, which the
  elite rule rules out; it belongs in the engine's team spread.

### Benchmarks before and after

Win prediction on the real fixtures (`bench-rb`-style replays of every real match with the elevens that played, through the code path a
user's XI takes; log loss per real match, 0.693 a coin flip, +- standard error over the matches; the difference is paired per match,
minus is better; 512 replays for the Test, 256 for the ODI; both columns on the same seeds, `origin/main` 72374c1 against the
regenerated ratings):

| set | half (matches) | before | after | difference |
|---|---|---|---|---|
| men's Test | holdout 2025+ (58) | 0.629 +- 0.091 | 0.624 +- 0.090 | **-0.005 +- 0.008** |
| | fit to 2024 (75) | 0.600 +- 0.080 | 0.591 +- 0.079 | -0.009 +- 0.008 |
| | all (133) | 0.612 +- 0.060 | 0.605 +- 0.059 | -0.007 +- 0.006 |
| men's ODI | holdout 2025+ (109) | 0.671 +- 0.043 | 0.660 +- 0.042 | **-0.011 +- 0.007** |
| | fit to 2024 (336) | 0.583 +- 0.023 | 0.587 +- 0.023 | +0.005 +- 0.004 |

The ODI fit half is the half its series tuning was fitted on (with the old ratings), which is where a ratings change reads worst; the
holdout is the decision. Noise: the same baseline at 64 replays and three seeds reads 0.627 / 0.587 / 0.584 on the Test fit half, so a
single run at 16-64 replays cannot rank changes of 0.03 (the screening of the variants above used them only to rule out large
harm).

Simulated Test win rates by team (decisive results, the 133 real Tests since 2023, elevens that played, 512 replays) and, for the
two teams of the complaint, the best eleven (256 replays):

| team | real | before | after | best eleven before -> after |
|---|---|---|---|---|
| India | 53.3% | 65.6% | 66.0% | 68.1% -> 68.1% |
| Australia | 68.6% | 72.5% | 72.6% | 69.1% -> 69.6% |
| England | 52.5% | 63.1% | 62.5% | 63.2% -> 62.2% |
| South Africa | 78.3% | 54.1% | 54.7% | 55.6% -> 55.7% |
| New Zealand | 65.4% | 52.2% | 51.3% | 55.2% -> 54.8% |

(`benchmark-test.ts 4000`, the best eleven of every nation in the real proportions of fixtures, against real shares since 2015:
India 74.0% -> 72.7% and Australia 72.8% -> 71.6% against 55.8% and 57.4%; runs per over 3.68 -> 3.69, balls per wicket 49.5 -> 49.4,
innings 1 324 -> 326, hundreds 1.64 -> 1.63, five-fors 1.45 -> 1.45: the Test engine's maps stand.)

**Not done, and why.** Pollard and Pooran (above); the Test spread / home entry of the series tuning (the engine's side of the
India and England gap, and South Africa's and New Zealand's shortfall); the ODI series tuning was not refitted on the new ratings
(`series-tuning-data.ts` belongs to the tuning work; the holdout above is with the shipped tuning).

## Test ratings by country: South Africa, New Zealand, India, England

With the real elevens of the 133 Tests since 2023 the sim's win rates were off for four sides: South Africa 64% against a real 78% (the
64% already included the side-level `strengthBy: { "South Africa": 2 }` of the series tuning, fitted on 23 Tests; 54% without it), New
Zealand 50% against 65%, India 64% against 53%, England 62% against 53% (decisive results, 512 replays; the standard error of one side's
rate is about 9 points). Spread, home and ground terms did not close them (docs/COUNTRY-VALIDATION.md, "Test and ODI series tuning"), so the
question was whether the Test ratings of those sides' players are wrong. Everything below is on-field data; ICC rankings were not used.
The evidence is `test-country-check.ts` (`data/analysis/test-country-check.md`).

**Method.** Rate every first-class player with data to Y (the shipped estimate: tuned DATA_VAR, thin-record calibration), for Y = 2014, 2017,
2020 (the tuning folds) and 2023 (the held-out fold), and compare it with what he did in Tests against full members in Y+1..Y+2
(opposition-adjusted value per 100 balls, the validation's own target, 500+ balls), by the side he played for. 335 bowling and 376 batting
player-folds. "Later minus estimate" is read against the mean of all sides (the target scale sits 7-8 above the estimate for everyone).

| side | bowling: all folds (SE) | 2014 | 2017 | 2020 | 2023 | batting: all folds (SE) | 2014 | 2017 | 2020 | 2023 |
|---|---|---|---|---|---|---|---|---|---|---|
| South Africa | **+8.2 (3.0)** | +9.6 | -0.7 | +14.8 | +10.3 | -3.6 (2.2) | -3.4 | -9.9 | -3.9 | +4.3 |
| India | +5.1 (2.5) | +9.7 | +3.7 | +3.4 | +3.5 | -1.5 (1.6) | -2.5 | +2.5 | -4.7 | -1.6 |
| England | -1.6 (1.4) | +0.4 | -0.2 | -0.8 | -6.2 | -2.8 (1.8) | -2.5 | -5.4 | -4.6 | +2.3 |
| New Zealand | -2.4 (2.6) | -5.4 | -1.2 | -3.3 | +2.0 | +4.2 (2.2) | +1.7 | +6.3 | +7.4 | +1.9 |
| Australia | +0.4 (2.3) | +2.1 | -3.3 | -3.4 | +9.5 | -0.8 (2.1) | +4.8 | -1.1 | +1.4 | -10.3 |
| Pakistan | -1.7 (2.7) | -4.6 | +1.5 | -0.6 | +0.6 | +3.6 (2.1) | +1.9 | +7.5 | +9.0 | -8.9 |
| Bangladesh | **-7.9 (1.5)** | -0.2 | -7.1 | -9.8 | -9.3 | +0.8 (1.7) | +4.0 | +2.0 | -3.0 | +1.8 |

**What it says.**

- *India and England players are not over-rated.* India's bowlers did better than their ratings (+5.1) and its batters as rated (-1.5);
  England's bowlers as rated (-1.6) and its batters 2.8 below, which does not repeat (+2.3 in 2023). The 64% / 62% against 53% is a result of
  the side, not of its players' ratings: a rating change for them would move it the wrong way (India's bowlers, if anything, are under-rated).
- *New Zealand's batters did 4.2 better than rated, in all four folds, but it does not persist as a thing to correct*: batting side effects
  do not carry from fold to fold (the effect fitted on three folds predicts the fourth with slope 0.09, correlation 0.05), and adding a
  batting term lowers held-out correlation in three of four folds (table below). Not shipped; New Zealand stays 50% against 65%.
- *Bowling is different.* The side effects on bowling repeat (the same slope 0.68, correlation 0.49): South Africa +8.2 (SE 3.0, positive
  in three of four folds, 2023 +10.3), Bangladesh -7.9 (SE 1.5), Zimbabwe -6.0, India +5.1. South Africa's bowlers are under-rated.

**What does not explain it** (each added to a regression of later minus estimate on side effects; the South Africa effect stays +6.8 to +9.1
every time, Bangladesh -5 to -10):

- *Home conditions in the records.* The CA cells carry no ground, so this was checked in the target and in the history: the share of
  Test balls played at home (+6.9, SE 4.3 for bowling), and the ground run and wicket factors of the Tests he played (venue effect in
  runs per 100 balls: +0.6, SE 0.7). South Africa's Test grounds take 6.8% more wickets and the effect is about 3 runs per 100 balls,
  not 8, and the sides' home shares are 0.44-0.56 anyway.
- *Opposition mix.* The mean strength of the opposition faced, in the history -0.3 (SE 0.4) and in the target +0.1 (0.7).
- *Domestic competition strengths.* Within one player and one season, with 300+ balls in Tests and in his domestic competition (2012-26),
  the Test-minus-domestic value by country should be the same if the strengths are right. Bowling: South Africa 1.9, India 1.7, New Zealand
  2.4, England 2.5, West Indies 2.4, Sri Lanka 1.5, Zimbabwe 2.9, Bangladesh 5.5, Australia 6.3, Pakistan 8.5; batting: South Africa -0.4,
  New Zealand 1.8, India 2.0, England -2.2, Australia -2.7, West Indies 5.4, Sri Lanka 4.8, Pakistan 6.8. South Africa's and India's domestic
  bowling is not under-credited: it is credited at the generous end (a small gap), so a refit of the competition strengths (CSA 4-Day,
  Plunket Shield against the Ranji Trophy and the County Championship) would not move these sides' bowlers the way the shortfall needs.
- *Pace against spin* (spin -2.8, SE 1.5; South Africa +7.8 either way: pace +18.0, spin +13.5 raw), *the strength of the attack* (teammates'
  mean estimate +0.38, SE 0.54, once the side effects are in), *thin records* (log balls -0.1).
- A player who has played mostly domestic cricket does 12.5 (SE 4.1) per full share better than his estimate in every country, which
  is who gets 500 Test balls in two seasons (selection on the outcome), not a country's competition.

So the cause is not a competition strength, a ground, an opposition mix or the era, and it is not in the batters. What remains is a
**national-side effect on bowling** that repeats across four eras and their attacks: South Africa's Test bowlers have done about
8 runs per 100 balls better than their records said, at home and away alike (3 of 4 folds; the odd fold is 2017). We do not know the
mechanism (the attack's depth, a selection effect specific to a small domestic pool, a real difference in how its bowlers' first-class
records translate); the term is an empirical correction with its evidence, not an explanation.

**What changed** (`test-bowling-terms.ts`, generated by `test-country-check.ts --write`; read by `generate-format-ratings.ts`):

- A term on men's Test bowling for a side whose effect on the tuning folds (2014 / 2017 / 2020 only: the 2023 fold and the Tests since 2025
  stay held out) is 2 standard errors from zero, shrunk by n / (n + 8): **South Africa +5.8** (raw +7.6, SE 3.2, 25 player-folds) and
  Bangladesh -5.2 (raw -7.4, SE 1.7). It is added to the player's score where the score is read off the link to the game's scale; the link
  curve itself is made from the scores as they are, so **no other player's rating moves** (first attempt, the term added to the score before
  the curve was made, pushed Bumrah 97 -> 91 and Starc 92 -> 88 down by displacing them in the rank-based link: rejected on the elite rule).
  It applies to the national sides' players in the ESPN pool, who are the regulars it was measured on, not to domestic players of the
  extended pool. TEST_BOWLING_TERMS=off in the environment switches it off.
- **Bangladesh's term is not shipped** (`NOT_SHIPPED`): it passes the player-level check (held-out fold -9.3), but the replays of its 24 Tests do
  move (paired +0.000 +- 0.038) and its win rate falls from 0.41 to 0.33 against a real 0.46 (Ireland's nine matches, mostly against it, get
  0.06 worse). The out-of-sample evidence is for its bowlers, not its results. Open decision.
- **The South Africa +2 `strengthBy` of the series tuning is removed** (`series-tuning-data.ts`: `test.men = { spread: 1, home: -1.5 }`); the
  mechanism stays in `series-tuning.ts`, tested with a term set in the test. The home term was checked against the new ratings on the fit half
  (256 replays; loss 0.569 at home -1.5, 0.581 at -3, 0.592 at 0; stretch 1.5: 0.595): it stands.

**Held-out correlation** (format-validation's target; the term of each fold fitted on the other three, K 8; correlation with the later value):

| | 2014 | 2017 | 2020 | 2023 (held out) |
|---|---|---|---|---|
| Test bowling: estimate | 0.485 | 0.402 | 0.391 | 0.517 |
| + terms kept at 2 SE (South Africa, Bangladesh) | 0.512 (+0.027) | 0.409 (+0.007) | 0.432 (+0.041) | 0.548 (+0.031) |
| + the shipped term only (South Africa, fitted on 2014 / 2017 / 2020) | | | | 0.533 (+0.016) |
| Test batting: estimate | 0.642 | 0.626 | 0.583 | 0.634 |
| + terms kept at 2 SE | 0.642 (0) | 0.626 (0) | 0.583 (0) | 0.613 (-0.021) |
| + every side's term (K 8) | 0.629 (-0.012) | 0.637 (+0.011) | 0.598 (+0.015) | 0.596 (-0.038) |

Bowling gains in all four folds (mean +0.027); batting terms do not (mean -0.006 to -0.010), which is why there is none.

**Test holdout** (actual XIs, 133 Tests since 2023, 512 replays of every match, the same seeds; log loss per real match, 0.693 a coin flip,
standard error over matches; paired = the same matches, minus is better). "Before" is the shipped state (ratings of 3748662 with the South
Africa +2); "without the offset" is the same ratings with it removed; "after" is the new ratings with no offset:

| | before (offset) | without the offset | after (ratings, no offset) | paired after - before | paired after - without |
|---|---|---|---|---|---|
| holdout 2025+ (58) | 0.580 (0.078) | 0.609 (0.081) | **0.568 (0.078)** | **-0.012 +- 0.012** | -0.041 +- 0.028 |
| fit to 2024 (75) | 0.577 (0.078) | 0.592 (0.078) | 0.573 (0.078) | -0.004 +- 0.004 | -0.019 +- 0.011 |
| all 133 | 0.578 (0.055) | 0.599 (0.056) | 0.571 (0.056) | -0.008 +- 0.006 | -0.029 +- 0.014 |

The ratings carry what the offset carried, and a little more, with no free parameter fitted on those Tests: the term comes from 2014-22 data.
The comparison with "before" is within the noise (the holdout is 58 matches); the comparison that matters is with no offset, which the
ratings now beat. Draw rate 8.5% (real 8.9%), home share of decided Tests 54.8% holdout / 61.0% fit against a real 54.4% / 59.5%.

Win rate by country (decisive results; real / before / without the offset / after):

| country | real | before | without offset | after |
|---|---|---|---|---|
| South Africa | 0.78 | 0.64 | 0.54 | **0.70** (home 0.74, away 0.67; real 0.82 / 0.73) |
| New Zealand | 0.65 | 0.50 | 0.50 | 0.50 |
| India | 0.53 | 0.64 | 0.66 | 0.64 |
| England | 0.53 | 0.62 | 0.62 | 0.62 |
| Australia | 0.69 | 0.72 | 0.74 | 0.71 |
| Bangladesh | 0.46 | 0.41 | 0.42 | 0.41 |
| Pakistan | 0.30 | 0.24 | 0.26 | 0.23 |
| Sri Lanka | 0.40 | 0.41 | 0.42 | 0.40 |
| West Indies | 0.28 | 0.29 | 0.30 | 0.29 |
| Ireland / Zimbabwe | 0.22 / 0.18 | 0.30 / 0.12 | 0.30 / 0.13 | 0.30 / 0.12 |

**Named players** (Test bowling overall, before -> after; nobody else's rating moved, no drop of an elite player): Kagiso Rabada 85 -> 97,
Marco Jansen 81 -> 85, Keshav Maharaj 80 -> 84, Simon Harmer 79 -> 84, Lungi Ngidi 78 -> 82, Anrich Nortje 77 -> 82, Wiaan Mulder 76 -> 81 (and
about 90 other South African players of the pool with a Test bowling set, by 1-16, the steepest at the thin tail: Shane Dadswell 55 -> 71). Unchanged: Joe Root 92, Virat
Kohli 88, Steven Smith 89, Kane Williamson 87, Jasprit Bumrah 97, Pat Cummins 88, Mitchell Starc 92, Ravichandran Ashwin 83, Ravindra Jadeja
81, Matt Henry 87, Tim Southee 78, Trent Boult 85, Harry Brook 93, Ben Stokes 81, Mohammed Siraj 79 (every Test set outside South Africa is as
before). Rabada's +12 is the scale, not the size of the term (5.8 runs per 100 balls): at the top of the link a unit of score is worth two
rating points and the next bowler is far off, so he now sits level with Bumrah. Open decision: cap a term's effect at +8 rating points?

**Still off, and why it is not the ratings.** New Zealand (0.50 against 0.65, the sides as rated; the batters' record beyond the ratings does
not persist), India and England (0.64 and 0.62 against 0.53: their players did as rated or better, so these two gaps are the engine's
spread of team strength or the luck of 30-40 Tests, not a rating a data fit can move), and South Africa itself at 0.70 against 0.78.

## Tables (format-ratings-report.ts)

### Out-of-sample validation

Rated with data up to 2023, target = ball-weighted adjusted value per 100 balls in internationals against full members in 2024-25 (ODI 200+ balls, Test 500+). `corr` = ball-weighted correlation (what the game keeps: ratings are a percentile map of the score), `mse` in (runs per 100 balls)^2 on the CA scale (T20-scale predictors are on another scale, compare their corr only). `common` = the players every predictor covers. DATA_VAR was tuned on the pooled 2014 / 2017 / 2020 folds.

**male ODI batting** (DATA_VAR 1; tuning corr by DATA_VAR: 0.25 0.602, 0.5 0.608, 1 0.610, 2 0.606, 4 0.597, own only 0.570; n 405)

| predictor | players | corr | mse | common players | corr | mse |
|---|---|---|---|---|---|---|
| format rating (own record + translated prior) | 100 | 0.444 | 386 | 71 | 0.496 | 304 |
| format rating, ranked conservatively (mean - 0.5 sd, as shipped) | 100 | 0.438 | 507 | 71 | 0.488 | 403 |
| format rating, own record only | 100 | 0.378 | 414 | 71 | 0.422 | 286 |
| T20 rating (no format ratings) | 98 | 0.310 | 520 | 71 | 0.373 | 447 |
| T20 rating translated | 98 | 0.310 | 524 | 71 | 0.373 | 484 |
| naive: career international value | 78 | 0.341 | 872 | 71 | 0.272 | 830 |
| naive: last season international value | 73 | 0.294 | 838 | 71 | 0.283 | 795 |

All four folds pooled (rated through 2014, 2017, 2020, 2023; 505 player-folds): format rating (own record + translated prior) 0.590; format rating, own record only 0.559; T20 rating (no format ratings) 0.487.

Derived ratings, checked by hiding each player's ODI record (same players):

| predictor | players | corr | mse | mean target - prediction |
|---|---|---|---|---|
| derived (translated, shrunk to the below-average prior) | 100 | 0.417 | 737 | 23.4 |
| translated, not shrunk | 100 | 0.425 | 465 | 16.3 |
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

**male Test batting** (DATA_VAR 0.5; tuning corr by DATA_VAR: 0.25 0.618, 0.5 0.621, 1 0.620, 2 0.612, 4 0.600, own only 0.559; n 282)

| predictor | players | corr | mse | common players | corr | mse |
|---|---|---|---|---|---|---|
| format rating (own record + translated prior) | 94 | 0.634 | 256 | 55 | 0.406 | 191 |
| format rating, ranked conservatively (mean - 0.5 sd, as shipped) | 94 | 0.633 | 325 | 55 | 0.400 | 239 |
| format rating, own record only | 94 | 0.616 | 263 | 55 | 0.374 | 184 |
| T20 rating (no format ratings) | 83 | 0.237 | 568 | 55 | 0.346 | 456 |
| T20 rating translated | 83 | 0.237 | 409 | 55 | 0.346 | 344 |
| naive: career international value | 76 | 0.477 | 953 | 55 | 0.182 | 741 |
| naive: last season international value | 64 | 0.605 | 839 | 55 | 0.289 | 617 |

All four folds pooled (rated through 2014, 2017, 2020, 2023; 376 player-folds): format rating (own record + translated prior) 0.621; format rating, own record only 0.609; T20 rating (no format ratings) 0.264.

Derived ratings, checked by hiding each player's Test record (same players):

| predictor | players | corr | mse | mean target - prediction |
|---|---|---|---|---|
| derived (translated, shrunk to the below-average prior) | 91 | 0.525 | 468 | 16.9 |
| translated, not shrunk | 91 | 0.533 | 332 | 12.1 |
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

**female ODI batting** (DATA_VAR 1; tuning corr by DATA_VAR: 0.25 0.694, 0.5 0.698, 1 0.699, 2 0.696, 4 0.690, own only 0.667; n 212)

| predictor | players | corr | mse | common players | corr | mse |
|---|---|---|---|---|---|---|
| format rating (own record + translated prior) | 88 | 0.709 | 284 | 64 | 0.716 | 231 |
| format rating, ranked conservatively (mean - 0.5 sd, as shipped) | 88 | 0.707 | 358 | 64 | 0.715 | 287 |
| format rating, own record only | 88 | 0.703 | 320 | 64 | 0.702 | 258 |
| T20 rating (no format ratings) | 85 | 0.664 | 319 | 64 | 0.710 | 237 |
| T20 rating translated | 85 | 0.664 | 282 | 64 | 0.710 | 220 |
| naive: career international value | 75 | 0.668 | 919 | 64 | 0.652 | 881 |
| naive: last season international value | 67 | 0.490 | 1040 | 64 | 0.466 | 1005 |

All four folds pooled (rated through 2014, 2017, 2020, 2023; 300 player-folds): format rating (own record + translated prior) 0.702; format rating, own record only 0.690; T20 rating (no format ratings) 0.656.

Derived ratings, checked by hiding each player's ODI record (same players):

| predictor | players | corr | mse | mean target - prediction |
|---|---|---|---|---|
| derived (translated, shrunk to the below-average prior) | 86 | 0.660 | 429 | 14.1 |
| translated, not shrunk | 86 | 0.655 | 296 | 7.4 |
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
| men Test batting | 282 / 94 | 0.632 | 0.635 (-0.11) / 0.637 (-0.32) / 0.640 (-0.91) | 0.643 | 0.644 | IND 10, ENG 3.4, AUS 9.2, RSA 2.2, NZ 16.9, PAK 18.2, SL 10.3, WI 8.8, BDESH 8.7, other 30.9 |
| men Test bowling | 241 / 94 | 0.517 | 0.511 (-0.16) / 0.507 (-0.33) / 0.508 (-0.75) | 0.557 | 0.546 | IND 24, ENG 9.1, AUS 11.1, RSA 22.3, NZ 5.7, PAK 5.7, SL 13.2, WI 5.7, BDESH -2.9, other -7.1 |
| men ODI batting | 405 / 100 | 0.439 | 0.427 (-0.30) / 0.426 (-0.67) / 0.427 (-1.81) | 0.462 | 0.453 | IND 12, ENG 11.2, AUS 10.2, RSA 8.6, NZ 15.2, PAK 25.7, SL 19.1, WI 12.2, BDESH 9.9, other 4 |
| men ODI bowling | 412 / 108 | 0.333 | 0.283 (0.24) / 0.290 (0.47) / 0.302 (1.14) | 0.352 | 0.326 | IND 20.2, ENG 9, AUS 13.8, RSA 13.7, NZ 18.8, PAK 3.1, SL 4.1, WI -1.9, BDESH 11.9, other 0.1 |

### Distributions against T20 (ESPN pool)

Final discipline overall (after attributes and normalisation) among each format's regulars (rated from data, a regular's balls, rated within 3 seasons), against the T20 overall among T20 regulars (240+ CA T20 balls in the discipline). The link is made on the players who are regulars of both, so the format rows sit where those players' T20 ratings sit; T20 regulars include many players who never play the longer formats.

**Men**

|  | regulars | linked | p10 | p25 | p50 | p75 | p90 | max |
|---|---|---|---|---|---|---|---|---|
| ODI batting | 1144 | 872 | 39 | 54 | 69 | 75 | 80 | 93 |
| Test batting | 1123 | 730 | 30 | 46 | 68 | 74 | 79 | 93 |
| T20 batting | 1582 |  | 43 | 53 | 67 | 74 | 79 | 93 |
| ODI bowling | 836 | 655 | 61 | 68 | 73 | 75 | 78 | 97 |
| Test bowling | 786 | 538 | 56 | 67 | 73 | 75 | 77 | 97 |
| T20 bowling | 1639 |  | 32 | 52 | 68 | 74 | 76 | 97 |

Attributes, p25 / p50 / p75 among the same regulars (men):

| attribute | ODI | Test | T20 |
|---|---|---|---|
| battingIQ | 55 / 70 / 79 | 44 / 68 / 78 | 54 / 67 / 78 |
| timing | 48 / 61 / 71 | 45 / 67 / 76 | 54 / 67 / 77 |
| power | 58 / 69 / 78 | 48 / 64 / 72 | 48 / 61 / 74 |
| running | 50 / 71 / 87 | 36 / 63 / 79 | 46 / 57 / 69 |
| wicketTaking | 77 / 82 / 86 | 75 / 82 / 86 | 55 / 74 / 81 |
| economy | 47 / 51 / 54 | 49 / 54 / 56 | 34 / 54 / 71 |
| accuracy | 53 / 61 / 71 | 50 / 57 / 65 | 38 / 51 / 61 |

**Women**

|  | regulars | linked | p10 | p25 | p50 | p75 | p90 | max |
|---|---|---|---|---|---|---|---|---|
| ODI batting | 331 | 263 | 31 | 46 | 63 | 70 | 77 | 95 |
| Test batting | 60 | 55 | 42 | 50 | 68 | 78 | 85 | 95 |
| T20 batting | 652 |  | 32 | 40 | 50 | 64 | 72 | 95 |
| ODI bowling | 184 | 167 | 67 | 70 | 72 | 75 | 77 | 82 |
| Test bowling | 63 | 54 | 71 | 72 | 74 | 75 | 78 | 82 |
| T20 bowling | 688 |  | 31 | 45 | 62 | 71 | 74 | 87 |

Attributes, p25 / p50 / p75 among the same regulars (women):

| attribute | ODI | Test | T20 |
|---|---|---|---|
| battingIQ | 50 / 67 / 78 | 53 / 74 / 89 | 42 / 53 / 68 |
| timing | 47 / 63 / 72 | 49 / 63 / 78 | 41 / 52 / 67 |
| power | 41 / 55 / 63 | 49 / 64 / 77 | 35 / 44 / 56 |
| running | 45 / 64 / 78 | 48 / 65 / 75 | 39 / 49 / 63 |
| wicketTaking | 69 / 73 / 76 | 74 / 76 / 78 | 41 / 60 / 69 |
| economy | 68 / 72 / 75 | 67 / 71 / 76 | 45 / 65 / 76 |
| accuracy | 68 / 74 / 80 | 62 / 68 / 77 | 51 / 60 / 69 |

### Top 25 (ESPN pool)

`~` = derived (no usable record in the format), `*` = capped. T20 = the same player's T20 discipline overall.

**Men, ODI batting**: Shubman Gill (India) 93 [T20 87], Virat Kohli (India) 92 [T20 87], Harry Brook (England) 92 [T20 93], KL Rahul (India) 91 [T20 87], Heinrich Klaasen (South Africa) 90 [T20 88], Mitchell Marsh (Australia) 89 [T20 88], Travis Head (Australia) 89 [T20 85], Rohit Sharma (India) 89 [T20 80], Joe Root (England) 89 [T20 72], Ishan Kishan (India) 88 [T20 89], Jos Buttler (England) 88 [T20 88], Shreyas Iyer (India) 88 [T20 88], David Miller (South Africa) 88 [T20 84], Ben Duckett (England) 88 [T20 81], David Warner (Australia) 88 [T20 87], Daryl Mitchell (New Zealand) 88 [T20 80], Nicholas Pooran (West Indies) 87 [T20 89], Ryan Rickelton (South Africa) 87 [T20 89], Glenn Phillips (New Zealand) 87 [T20 87], Dewald Brevis (South Africa) 87 [T20 87], Lhuan-dre Pretorius (South Africa) 87 [T20 85], Josh Inglis (Australia) 87 [T20 84], Quinton de Kock (South Africa) 87 [T20 84], Tom Banton (England) 87 [T20 82], Matthew Breetzke (South Africa) 87 [T20 80]

**Men, ODI bowling**: Jasprit Bumrah (India) 97 [T20 97], Rashid Khan (Afghanistan) 93 [T20 92], Mitchell Starc (Australia) 92 [T20 79], Pat Cummins (Australia) 91 [T20 77], Matt Henry (New Zealand) 89 [T20 74], Josh Hazlewood (Australia) 88 [T20 84], Kuldeep Yadav (India) 87 [T20 87], Kagiso Rabada (South Africa) 87 [T20 79], Trent Boult (New Zealand) 86 [T20 82], Varun Chakravarthy (India) 85* [T20 87], Wanindu Hasaranga (Sri Lanka) 85 [T20 91], Sunil Narine (West Indies) 85 [T20 93], Mohammed Shami (India) 85 [T20 78], Shaheen Shah Afridi (Pakistan) 85 [T20 81], Joel Paris (Australia) 85 [T20 76], Mitchell Santner (New Zealand) 84 [T20 85], Adam Zampa (Australia) 84 [T20 85], Nathan Coulter-Nile (Australia) 84 [T20 77], Scott Boland (Australia) 84 [T20 73], Jofra Archer (England) 83 [T20 86], Yuzvendra Chahal (India) 83 [T20 85], Nathan Ellis (Australia) 83 [T20 80], Ravichandran Ashwin (India) 83 [T20 84], Peter Siddle (Australia) 83 [T20 77], Kyle Abbott (South Africa) 83 [T20 72]

**Men, Test batting**: Harry Brook (England) 93 [T20 93], Joe Root (England) 92 [T20 72], Shubman Gill (India) 89 [T20 87], Ben Duckett (England) 89 [T20 81], Steven Smith (Australia) 89 [T20 84], Virat Kohli (India) 88 [T20 87], Travis Head (Australia) 88 [T20 85], Rishabh Pant (India) 88 [T20 82], David Bedingham (South Africa) 88 [T20 69], Ryan Rickelton (South Africa) 87 [T20 89], Ishan Kishan (India) 87 [T20 89], Cameron Green (Australia) 87 [T20 84], KL Rahul (India) 87 [T20 87], Yashasvi Jaiswal (India) 87 [T20 83], Dhruv Jurel (India) 87 [T20 80], Rohit Sharma (India) 87 [T20 80], David Warner (Australia) 87 [T20 87], Dan Lawrence (England) 87 [T20 81], Daryl Mitchell (New Zealand) 87 [T20 80], Kane Williamson (New Zealand) 87 [T20 78], Alex Carey (Australia) 87 [T20 70], Mitchell Marsh (Australia) 86 [T20 88], Ravindra Jadeja (India) 86 [T20 80], Jos Buttler (England) 86 [T20 88], Quinton de Kock (South Africa) 86 [T20 84]

**Men, Test bowling**: Jasprit Bumrah (India) 97 [T20 97], Mitchell Starc (Australia) 92 [T20 79], Kyle Abbott (South Africa) 91 [T20 72], Pat Cummins (Australia) 88 [T20 77], Matt Henry (New Zealand) 87 [T20 74], Scott Boland (Australia) 86 [T20 73], Josh Hazlewood (Australia) 85 [T20 84], Trent Boult (New Zealand) 85 [T20 82], Kagiso Rabada (South Africa) 85 [T20 79], Joel Paris (Australia) 85 [T20 76], Sam Cook (England) 85 [T20 74], Ollie Robinson (England) 85 [T20 70], Mohammed Shami (India) 84 [T20 78], George Hill (England) 84 [T20 37], Jofra Archer (England) 83 [T20 86], Ravichandran Ashwin (India) 83 [T20 84], Shaheen Shah Afridi (Pakistan) 83 [T20 81], Michael Neser (Australia) 83 [T20 73], Matthew Potts (England) 83 [T20 72], Craig Overton (England) 82 [T20 41], Daniel Worrall (England) 82 [T20 80], Chris Woakes (England) 82 [T20 74], Peter Siddle (Australia) 82 [T20 77], Chris Tremain (Australia) 82 [T20 73], Ben Sanderson (England) 82 [T20 74]

**Women, ODI batting**: Shafali Verma (India) 95 [T20 92], Beth Mooney (Australia) 94 [T20 87], Nat Sciver-Brunt (England) 92 [T20 95], Smriti Mandhana (India) 92 [T20 92], Phoebe Litchfield (Australia) 87 [T20 94], Meg Lanning (Australia) 87 [T20 81], Alyssa Healy (Australia) 87 [T20 79], Grace Harris (Australia) 85 [T20 87], Sophie Devine (New Zealand) 85 [T20 82], Annabel Sutherland (Australia) 85 [T20 80], Georgia Voll (Australia) 85 [T20 81], Danni Wyatt-Hodge (England) 83 [T20 85], Ellyse Perry (Australia) 82 [T20 87], Jemimah Rodrigues (India) 82 [T20 80], Laura Wolvaardt (South Africa) 82 [T20 82], Marizanne Kapp (South Africa) 81 [T20 78], Georgia Wareham (Australia) 81 [T20 85], Ashleigh Gardner (Australia) 81 [T20 85], Harmanpreet Kaur (India) 81 [T20 79], Rachael Haynes (Australia) 81 [T20 77], Hayley Matthews (West Indies) 80 [T20 80], Freya Kemp (England) 80 [T20 79], Lizelle Lee (South Africa) 80 [T20 83], Maia Bouchier (England) 80 [T20 79], Amelia Kerr (New Zealand) 79 [T20 80]

**Women, ODI bowling**: Sophie Ecclestone (England) 82 [T20 82], Jess Jonassen (Australia) 81 [T20 76], Alana King (Australia) 80 [T20 77], Ashleigh Gardner (Australia) 79 [T20 76], Sophie Molineux (Australia) 79 [T20 79], Megan Schutt (Australia) 79 [T20 78], Amanda-Jade Wellington (Australia) 79 [T20 78], Lauren Cheatle (Australia) 78 [T20 32], Hayley Matthews (West Indies) 78 [T20 77], Annabel Sutherland (Australia) 78 [T20 77], Charlie Dean (England) 78 [T20 78], Poonam Yadav (India) 78 [T20 75], Molly Strano (Australia) 78 [T20 77], Anesu Mushangwe (Zimbabwe) 78 [T20 74], Amelia Kerr (New Zealand) 77 [T20 79], Deepti Sharma (India) 77 [T20 79], Kim Garth (Australia) 77 [T20 77], Nicola Carey (Australia) 77 [T20 72], Shabnim Ismail (South Africa) 77 [T20 81], Leigh Kasperek (New Zealand) 77 [T20 75], Linsey Smith (England) 77 [T20 75], Anya Shrubsole (England) 77 [T20 76], Salma Khatun (Bangladesh) 77 [T20 74], Afy Fletcher (West Indies) 77 [T20 74], Belinda Vakarewa (Australia) 77 [T20 77]

**Women, Test batting**: Nat Sciver-Brunt (England) 95 [T20 95], Shafali Verma (India) 94 [T20 92], Smriti Mandhana (India) 92 [T20 92], Beth Mooney (Australia) 92 [T20 87], Phoebe Litchfield (Australia) 87 [T20 94], Ellyse Perry (Australia) 87 [T20 87], Danni Wyatt-Hodge (England) 85 [T20 85], Annabel Sutherland (Australia) 85 [T20 80], Laura Wolvaardt (South Africa) 85 [T20 82], Meg Lanning (Australia) 85 [T20 81], Heather Knight (England) 82 [T20 82], Jemimah Rodrigues (India) 82 [T20 80], Harmanpreet Kaur (India) 81 [T20 79], Sophia Dunkley (England) 80 [T20 85], Alyssa Healy (Australia) 80 [T20 79], Marizanne Kapp (South Africa) 79 [T20 78], Ashleigh Gardner (Australia) 79 [T20 85], Richa Ghosh (India) 78 [T20 81], Tahlia McGrath (Australia) 77 [T20 75], Maia Bouchier (England) 77 [T20 79], Alice Capsey (England) 77 [T20 76], Anneke Bosch (South Africa) 76 [T20 78], Jess Jonassen (Australia) 76 [T20 76], Rachael Haynes (Australia) 76 [T20 77], Sune Luus (South Africa) 75 [T20 75]

**Women, Test bowling**: Deepti Sharma (India) 82 [T20 79], Ashleigh Gardner (Australia) 79 [T20 76], Sophie Ecclestone (England) 79 [T20 82], Vaishnavi Sharma (India) 79 [T20 76], Alana King (Australia) 78 [T20 77], Sophie Molineux (Australia) 78 [T20 79], Nahida Akter (Bangladesh) 78 [T20 73], Annabel Sutherland (Australia) 77 [T20 77], Jess Jonassen (Australia) 77 [T20 76], Poonam Yadav (India) 77 [T20 75], Salma Khatun (Bangladesh) 77 [T20 74], Rabeya Khan (Bangladesh) 76 [T20 74], Tanuja Kanwar (India) 76 [T20 75], Minnu Mani (India) 76 [T20 73], Jannatul Ferdus (Bangladesh) 76 [T20 73], Lauren Cheatle (Australia) 75 [T20 32], Marizanne Kapp (South Africa) 75 [T20 87], Ellyse Perry (Australia) 75 [T20 74], Charlie Dean (England) 75 [T20 78], Lauren Bell (England) 75 [T20 79], Sneh Rana (India) 75 [T20 72], Rajeshwari Gayakwad (India) 75 [T20 74], Sultana Khatun (Bangladesh) 75 [T20 74], Ekta Bisht (India) 74~* [T20 75], Gouher Sultana (India) 74~* [T20 73]

### Specialists

| player | T20 bat / bowl (overall) | ODI | Test |
|---|---|---|---|
| Cheteshwar Pujara | 76 / 28 (76) | 79 / 28 (79) | 82 / 28 (82) |
| Nathan Lyon | 53 / 78 (80) | 43 / 78 (79) | 32 / 80 (80) |
| Joe Root | 72 / 44 (73) | 89 / 46 (89) | 92 / 45 (92) |
| Steven Smith | 84 / 31 (84) | 87 / 31 (87) | 89 / 31 (89) |
| Kane Williamson | 78 / 31 (78) | 82 / 31 (82) | 87 / 31 (87) |
| Marnus Labuschagne | 68 / 40 (69) | 82 / 46 (83) | 83 / 46 (84) |
| Usman Khawaja | 82 / 30 (82) | 81 / 30 (81) | 86 / 30 (86) |
| Ajinkya Rahane | 76 / 31 (76) | 80 / 31 (80) | 77 / 31 (77) |
| Tom Latham | 72 / 31 (72) | 79 / 31 (79) | 82 / 31 (82) |
| Scott Boland | 49 / 73 (75) | 40 / 84 (84) | 30 / 86 (86) |
| Josh Hazlewood | 27 / 84 (84) | 27 / 88 (88) | 31 / 85 (85) |
| Andre Russell | 88 / 71 (91) | 69 / 73 (79, derived) | 68 / 73 (79, derived) |
| Sunil Narine | 34 / 93 (93) | 34 / 85 (85) | 49 / 73 (75, derived) |
| Kieron Pollard | 89 / 71 (92) | 87 / 46 (88) | 68 / 41 (69, derived) |
| Nicholas Pooran | 89 / 31 (89) | 87 / 31 (87) | 68 / 31 (68, derived) |
| Tim David | 92 / 30 (92) | 82 / 45 (83) | 68 / 30 (68, derived) |
| Rovman Powell | 86 / 30 (86) | 81 / 45 (82) | 68 / 65 (74, derived) |
| Sherfane Rutherford | 87 / 30 (87) | 83 / 30 (83) | 68 / 64 (73, derived) |
| Romario Shepherd | 88 / 45 (88) | 48 / 72 (73) | 47 / 71 (72, derived) |
| Abhishek Sharma | 92 / 45 (92) | 85 / 45 (86) | 76 / 45 (77) |
| Rinku Singh | 87 / 29 (87) | 85 / 45 (86) | 82 / 45 (83) |
| Varun Chakravarthy | 21 / 87 (87) | 21 / 85 (85) | 21 / 73 (73, derived) |
| Liam Livingstone | 83 / 68 (87) | 83 / 45 (84) | 78 / 73 (84) |

| player | T20 bat / bowl (overall) | ODI | Test |
|---|---|---|---|
| Ellyse Perry | 87 / 74 (91) | 82 / 45 (83) | 87 / 75 (91) |
| Nat Sciver-Brunt | 95 / 73 (96) | 92 / 45 (92) | 95 / 73 (96) |
| Smriti Mandhana | 92 / 31 (92) | 92 / 31 (92) | 92 / 31 (92) |
| Beth Mooney | 87 / 31 (87) | 94 / 31 (94) | 92 / 31 (92) |
| Meg Lanning | 81 / 32 (81) | 87 / 32 (87) | 85 / 32 (85) |
| Heather Knight | 82 / 72 (87) | 79 / 46 (80) | 82 / 46 (83) |
| Sophie Ecclestone | 47 / 82 (83) | 43 / 82 (83) | 30 / 79 (79) |
| Deepti Sharma | 77 / 79 (86) | 76 / 77 (85) | 73 / 82 (87) |
| Chinelle Henry | 79 / 46 (80) | 76 / 45 (77) | 68 / 39 (69, derived) |
| Deandra Dottin | 75 / 72 (82) | 74 / 45 (75) | 68 / 72 (78, derived) |

Bowling overall of specialist batsmen (T20 role batsman; 3834 men, 324 of them with a T20 batting overall of 75+), p10 / p25 / p50 / p75 / p90 / max. A side the player doesn't do in the format (under 6 balls a match over his career or his last three seasons of it) keeps his T20 level; batsmen who do bowl part-time in the format sit at the batsman's secondary-discipline ceiling (about 44-46), as part-timers do in T20.

|  | T20 | ODI | Test |
|---|---|---|---|
| all specialist batsmen | 26 / 28 / 30 / 31 / 32 / 46 | 27 / 29 / 30 / 30 / 41 / 83 | 27 / 29 / 30 / 30 / 45 / 84 |
| T20 batting 75+ | 28 / 28 / 30 / 32 / 45 / 46 | 28 / 28 / 30 / 39 / 45 / 79 | 28 / 29 / 30 / 40 / 64 / 79 |

Men, by group (mean rating of the group in each format). The T20 ratings of first-class specialists with a thin T20 record were themselves rated from their first-class cricket by the T20 pipeline (T20-unproven sides), so those groups' T20 and Test means coincide; the players above show the movement for specialists with a real T20 record.

| group | players | T20 | ODI | Test | rating |
|---|---|---|---|---|---|
| Test batting specialists: 4000+ first-class balls at 40+ a match, under 1500 T20 balls | 300 | 66.0 | 68.3 | 69.3 | batting |
| Test bowling specialists: 6000+ first-class balls bowled, under 1200 T20 balls | 150 | 58.7 | 66.0 | 69.2 | bowling |
| White-ball only: T20 overall 75+, no first-class ball (94 derived in Tests) | 94 | 77.8 | 68.6 | 68.2 | overall |
| T20 only: T20 overall 75+, no List A or first-class ball (45 derived in ODIs) | 45 | 77.9 | 69.9 | 69.0 | overall |

### Attribute mix

Men with 1,000+ Cricsheet balls in the format (career, so in-sample: a consistency check, not a validation): correlation of a batting attribute with the stat it stands for in that format, for the format's own set and for the player's T20 set.

| format | players | attribute | stat in the format | format set | T20 set |
|---|---|---|---|---|---|
| ODI | 147 | power | six % | 0.691 | 0.664 |
| ODI | 147 | timing | four % | 0.635 | 0.320 |
| ODI | 147 | timing | boundary % | 0.423 | 0.225 |
| ODI | 147 | battingIQ | balls per dismissal | 0.302 | 0.248 |
| ODI | 147 | battingIQ | average | 0.599 | 0.460 |
| ODI | 147 | running | fewer dot balls | 0.474 | 0.304 |
| ODI | 147 | batting overall | average | 0.602 | 0.460 |
| Test | 163 | power | six % | 0.049 | 0.249 |
| Test | 163 | timing | four % | 0.184 | 0.265 |
| Test | 163 | timing | boundary % | 0.018 | 0.173 |
| Test | 163 | battingIQ | balls per dismissal | 0.690 | 0.538 |
| Test | 163 | battingIQ | average | 0.789 | 0.669 |
| Test | 163 | running | fewer dot balls | 0.410 | 0.183 |
| Test | 163 | batting overall | average | 0.800 | 0.660 |

The same players, each rate regressed on the four batting attributes together (ball-weighted, z-scored attributes, weights in SDs of the rate per SD of the attribute), as the Test engine fits its scoring terms. A format set's battingIQ carries its level, so timing, power and running carry the style given the level: fours through timing, sixes through power, singles through running.

| format | ratings | players | four %: battingIQ / timing / power / running | six %: battingIQ / timing / power / running |
|---|---|---|---|---|
| ODI | ODI set | 147 | 0.04 / 0.70 / 0.15 / -0.40 (R2 0.61) | 0.22 / -0.27 / 0.63 / -0.38 (R2 0.73) |
| ODI | T20 set | 147 | -0.04 / 0.42 / 0.29 / -0.14 (R2 0.30) | 0.07 / 0.03 / 0.52 / -0.24 (R2 0.61) |
| Test | Test set | 163 | -0.44 / 0.88 / 0.24 / -0.49 (R2 0.34) | -0.15 / -0.43 / 0.89 / -0.49 (R2 0.71) |
| Test | T20 set | 163 | -0.28 / 0.56 / 0.27 / -0.23 (R2 0.37) | -0.49 / 0.26 / 0.42 / -0.13 (R2 0.54) |

### ICC rankings (validation only)

Latest ICC top 100 (2026-11-02/03) matched to the ESPN pool by name (and team where names repeat). Spearman correlation of ICC points with our format overall and with the same players' T20 overall; `top 25 overlap` = ICC top 25 players (matched) who are also in our top 25 for the format. Rankings weigh recent international form only and cover the top 100 only, so a modest correlation is expected.

| ranking | ICC players | matched | Spearman (format rating) | Spearman (T20 rating) | top 25 overlap |
|---|---|---|---|---|---|
| male ODI batting | 101 | 98 | 0.585 | 0.423 | 11 / 25 |
| male ODI bowling | 100 | 99 | 0.465 | 0.421 | 9 / 25 |
| male Test batting | 100 | 95 | 0.623 | 0.331 | 11 / 25 |
| male Test bowling | 100 | 89 | 0.615 | 0.324 | 7 / 25 |
| female ODI batting | 100 | 98 | 0.550 | 0.575 | 14 / 25 |
| female ODI bowling | 100 | 94 | 0.592 | 0.629 | 11 / 25 |

### Sources

male: {"espn":{"odiData":2255,"testData":1827,"odiDerived":3286,"testDerived":3714},"extended":{"odiData":76548,"testData":50484},"league":{"odiData":46,"testData":37,"players":51}}
female: {"espn":{"odiData":472,"testData":128,"odiDerived":1907,"testDerived":2251},"extended":{"odiData":6603,"testData":930},"league":{"odiData":80,"testData":23,"players":87}}

## Known gaps

- **T20 weight on ODI batting.** The translated prior is validated (it raises held-out correlation), and a stale List A record
  leaves it most of the weight. The bias round (above) lowered the top hitters (Finn Allen ODI 88 -> 82, Test 83 -> 72; Abhishek
  Sharma 89 -> 85 / 83 -> 76) and thin records, not Pollard and Pooran (87 for ODIs: real records of 3,668 and 2,914 balls, 3-4 seasons
  old, hitterness just under the hinge) nor Ishan Kishan (Test 87: his first-class rating itself rose to 30 this season). A linear
  batting style term would lower more of them but lowers held-out accuracy (0.431 -> 0.413 ODI): in 2024-25 the hitters picked did well.
  Treating a record older than three seasons as "derived" (capped at the format median) would put Pollard and Pooran at 69 for ODIs;
  it is a judgement, not a measured correction.
- **India and England win too often in simulated Tests, South Africa and New Zealand too rarely** (elevens that played, 133 Tests
  since 2023: India 66% against 53%, England 63% against 52%, South Africa 55% against 78%, New Zealand 51% against 65%; Australia
  73% against 69% is level). The ratings do not explain it (bias round, section 2); the Test engine's home advantage (home sides win
  57.5% against 51.4%) and team spread do. Test batting estimates have a later-value slope of 0.76, so they over-spread the teams, but
  compressing them would cost Root, Brook and Smith 4-5 points.
- **Maxwell, Ravindra and other hitting all-rounders** with real records fall 3-4 points with the hitters (Maxwell ODI 85 -> 82,
  Ravindra Test 86 -> 82): their prior was as high as the others'; their records pull them back only part of the way.
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
- **Career mode** (was a gap: sets did not progress, and generated players had none): sets now develop with the T20 ratings and
  generated players get derived sets; see docs/RATINGS-PIPELINE.md, "ODI and Test ratings in career mode". Remaining
  judgement: the share of a T20 change that carries over (`FORMAT_COUPLING`) is a stated point between the slope on the
  measured change and the slope on the true change, and a format's own noise (a Test average drifting for reasons T20 does
  not see) is not simulated.
- **The Test specialists group check** (format-ratings-report.ts) shows no group-level lift: first-class specialists with a
  thin T20 record were already rated from first-class cricket by the T20 pipeline. Named specialists with real T20 records
  do move (Root +20, Labuschagne +14, Latham +10, Williamson +9, Pujara +6 batting overall).
- **Validation target** is on the CA model's own adjusted scale, with competition strengths fitted on every year, the
  target years included (the same caveat as docs/CA-RATINGS-REPORT.md).

