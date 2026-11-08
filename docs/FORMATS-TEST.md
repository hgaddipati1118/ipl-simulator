# Test cricket

Two innings a side over up to five days (women's Tests: four), with the ball model and every team decision fitted from
Cricsheet's ball-by-ball Tests. Instant simulation and live play run the same state machine. ODI rules live in
FORMATS.md; this file covers Tests and is meant to be folded into it.

Files:

| file | what |
|---|---|
| `packages/engine/src/test-match.ts` | rules, ball model, fielding, DRS, captains' policies, results, scorecards, `simulateTestMatch` |
| `packages/engine/src/test-live.ts` | live driver: user decisions, skip by over / session / day / innings, situation view, save / load |
| `packages/engine/src/test-model-data.ts` | GENERATED fitted parameters (no runtime data dependency) |
| `packages/ratings/src/analysis/test-match-model.py` | the fit (DuckDB + Python, `python3 -I`) |
| `docs/data/test_model.json` | the same parameters plus the era factors, as a report |
| `packages/engine/src/__tests__/test-match.test.ts`, `test-live.test.ts` | rules, determinism, policies, seeded statistics; the live driver |
| `packages/engine/src/__tests__/benchmark-test.ts` | sim vs real Tests (section 6) |
| `packages/engine/src/__tests__/fixtures/test-squads.json` | national squads: the most-capped Test players since 2023 (women 2021) |

Shared engine pieces reused: the fielding unit and catch / stumping / run-out conversion (`fielding.ts`), run-out batter and
fielders (`delivery-rules.ts`), dismissal kinds and scorecard text (`dismissal-kinds.ts`), DRS review records and their
commentary (`drs.ts`), delivery commentary (`commentary.ts` `generateDeliveryCommentary`), the post-match injury model with
its Test/FC multiplier (`injury.ts`), `Player.forFormat("test")`. The only shared file touched is `index.ts` (one appended
export block).

---

## 1. Rules

- **Innings.** Two a side. The first-innings side bats third unless it enforces the follow-on. An innings ends all out,
  declared, when the target is reached (4th innings), or when time runs out.
- **Days and overs.** 5 days of 90 overs (women: 4 of 100), in three sessions (the day's overs in thirds: lunch, tea, stumps).
  A day's overs are 90, less what the over rate cannot fit into 6 hours plus the half hour of extra time
  (`floor(rate x 6.5)`, rate drawn per match from the fitted overs-per-hour quantiles), less time lost to weather, less 2
  overs for every change of innings (ICC Test playing conditions). Play stops at the end of the over that reaches the day's
  overs. A whole day can be washed out.
- **Result.** The 4th-innings side wins by wickets on reaching the target. All out short of it: the other side wins by runs,
  or it is a tie with the scores level. After three innings, if the side to bat last already leads, it wins by an innings and
  the difference. Time running out at any stage is a draw.
- **Follow-on (Law 14).** Available at a first-innings lead of 200 in a match of five days or more, 150 for three or four days
  (100 for two, 75 for one), after the side behind is bowled out. The leading captain chooses.
- **Declarations.** Innings 1-3, by the batting side, between deliveries (CPU sides at the end of an over).
- **New ball.** Available once 80 overs have been bowled with the current ball. The CPU takes it at the start of the 81st
  over. A user side is asked once and can take it later at any time.
- **Bowlers.** No limit on overs, but no bowler bowls two overs in a row, intervals and overnight included (Law 17.8).
  Bowlers tire (section 3.4).
- **DRS.** Three unsuccessful reviews per side per innings (umpire's call keeps the review). Reviewable: lbw and catches by
  the keeper.
- **Extras.** Wides, no-balls (one run plus what is hit, no free hit) and byes / leg byes, with the fitted Test rates and
  run distributions.
- **Retired hurt.** At the Test rate (46 in 1.73 million deliveries). The batter comes back if nobody else is left.
- **Toss.** Coin flip; the winner bats or bowls (CPU: section 4.1).

## 2. Ball model

### 2.1 Fit

Every delivery falls in one of ten classes: dot, 1, 2, 3 (3s and the rare 5), 4, 6, wicket (any dismissal on a legal ball),
wide, no-ball, bye / leg bye. Each class except the dot has its own log-linear Poisson rate, and the dot is what is left:

    P(class) = base(class) x  Π factor(class, level) x batter(class) x bowler(class) x match(class) x innings(class)

The data is men's Tests from 2006: 835 Tests, 1.61 million deliveries (Cricsheet has 899 men's Tests from 2001). It is fitted
by iterative proportional fitting (backfitting the Poisson likelihood, 16 sweeps) in DuckDB. The factors and their levels:

| factor | levels |
|---|---|
| ball age | overs since the new ball: 0-4, 5-9, 10-19, 20-34, 35-49, 50-64, 65+ (a new ball assumed at 80, 160) |
| set-ness | balls the batter has faced: 0-4, 5-9, 10-19, 20-34, 35-59, 60-99, 100-149, 150+ |
| innings | 1-4 |
| wickets down | 0-2, 3-5, 6-7, 8-9 (the tail is in), separately for each innings |
| day x pace / spin | day 1-5 for each bowler type (pitch wear) |
| spell | the bowler's over in his spell, 1-7+ (a spell ends at a gap of more than one over at his end or overnight) |
| situation | normal; push (the last 12 overs of an innings that was declared); 4th-innings runs needed per scheduled over left (5 x 90 less the overs bowled) 0-2.5, 2.5-3.5, 3.5-4.5, 4.5-6, 6+ |
| home | batting side at home / away / neutral |
| country x type | host country (IND, PAK, SL, BDESH, UAE, AUS, ENG, RSA, NZ, WI, ZIM, IRELAND, other) x pace / spin |
| era | 2006-10, 2011-14, 2015-18, 2019-22, 2023+ |
| Bazball | England batting from June 2022 |
| match | each match's own conditions (shrunk with a 1,500-ball prior) |
| batter, bowler | each player (shrunk with a 300-ball prior at the average rate) |

The player and match terms mean a context factor measures the effect for the same players in the same match. A set batter
is not just a better batter; a 4th-innings collapse is not just a worse pitch. After the fit, nested terms are re-centred
into their parents, which leaves every prediction unchanged:
- match terms within country and era;
- bowler terms within pace / spin;
- country x type within type.

Then each context factor is normalised to a mean of 1 over men's Tests since 2015, with the eras weighted 1 : 1.5 : 2
(2015-18, 2019-22, 2023+: "weight recent years"). Bazball off = 1. The base rates make the weighted prediction match the count.

Women's Tests (24 in Cricsheet) are too few to fit the structure. Their base rates are refitted on women's Tests since 2014,
with every men's context factor held as an offset (the men's structure, the women's levels).

**Days of play.** Cricsheet has no day or session markers. A ball's day is its match's cumulative legal balls divided by that
match's day length: total balls / (days played - 1 + 1 for a draw, + 0.55 for a result), clamped to 300-540 balls. The
4th-innings overs left use the same day length. Both are approximations. The first-hour / session effect is not identifiable
this way, so the engine has none.

### 2.2 Fitted factors (selected; all in `test-model-data.ts`)

The values below are from the first fit, except the wickets-down row (all innings pooled; it is now fitted per innings).
Adding wickets down and changing the chase measure (section 6.5) moved the 4th-innings chase factors and little else.
`test-model-data.ts` has the current values.

Base rates per delivery (men): 1 0.151, 2 0.035, 3 0.0089, 4 0.059, 6 0.0049, wicket 0.0181, wide 0.0022, no-ball 0.0054,
bye / leg bye 0.0094 (the dot is what is left, ~0.71; real men's Tests since 2015: 0.70).

| factor | singles | fours | sixes | wickets |
|---|---|---|---|---|
| ball age 0-4 / 20-34 / 65+ overs | 0.98 / 1.00 / 1.05 | 1.09 / 1.00 / 0.93 | 0.95 / 1.02 / 0.90 | 1.06 / 1.00 / 0.98 |
| set-ness 0-4 / 35-59 / 150+ balls | 0.72 / 1.03 / 1.31 | 0.77 / 1.04 / 1.01 | 0.49 / 0.98 / 1.41 | 1.06 / 0.98 / 0.99 |
| innings 1 / 2 / 3 / 4 | 1.02 / 0.96 / 1.05 / 0.96 | 1.00 / 1.01 / 0.99 / 0.98 | 1.15 / 0.94 / 0.92 / 0.92 | 1.08 / 0.96 / 0.91 / 1.06 |
| wickets down 0-2 / 3-5 / 6-7 / 8-9 | 0.98 / 0.99 / 1.06 / 1.05 | 0.99 / 0.97 / 1.00 / 1.15 | 0.80 / 0.81 / 1.09 / 2.72 | 0.90 / 0.92 / 1.14 / 1.61 |
| pace, day 1 / 3 / 5 | 0.77 / 0.87 / 0.92 | 1.15 / 1.11 / 1.02 | 0.39 / 0.54 / 0.67 | 0.89 / 1.10 / 1.29 |
| spin, day 1 / 3 / 5 | 1.21 / 1.24 / 1.10 | 0.86 / 0.82 / 0.76 | 1.48 / 1.74 / 1.76 | 0.64 / 0.99 / 1.18 |
| push (pre-declaration) vs normal | 1.54 / 0.99 | 1.32 / 0.98 | 3.08 / 0.96 | 1.36 / 1.02 |
| 4th inn., runs per over left < 2.5 / 3.5-4.5 / 6+ | 1.11 / 0.89 / 0.84 | 1.13 / 0.98 / 1.07 | 1.16 / 0.70 / 0.78 | 0.85 / 0.78 / 0.92 |
| home / away batting side | 1.03 / 0.97 | 1.01 / 1.00 | | 0.95 / 1.05 |
| Bazball (England from June 2022) | 1.26 | 1.14 | 1.62 | 1.04 |
| era 2015-18 / 2023+ (relative) | 0.95 / 1.09 | 1.04 / 0.99 | 0.86 / 1.17 | 0.96 / 1.06 |

Country x type (wickets, pace / spin, within type): India 0.90 / 1.06, Sri Lanka 0.96 / 1.11, Pakistan 0.86 / 0.94,
South Africa 1.14 / 1.00, England 1.04 / 0.95, Australia 0.97 / 0.81, New Zealand 0.97 / 0.87.

The match's own conditions: SD 0.071 on the scoring rate, 0.19 on the wicket rate, correlation 0.15 (true spread beyond
Poisson noise, centred within country). An innings' own scoring conditions add SD 0.09. How the pitch wears is drawn per
match too: the wicket rate on days 4-5 against 1-2 has SD 0.11 (section 6.4). Per innings the wicket rate shows no
extra spread, and nor do bowler or batter innings (no "form" overdispersion). These are drawn per match and per innings with
mean 1.

**Spell.** The fitted wicket rate rises along a spell (0.96 in the first over to 1.05 in the seventh). That is selection:
captains keep a bowler on while he is threatening. The engine takes the spell's run-rate drift (fatigue, up to +2%) and leaves
the wicket rate flat. The captain's keep-him-on behaviour is modelled in the policy instead (section 4.3).

**Tried and left out.** An innings-within-match random effect (`INNINGS_TERM=1`). It soaks up collapses: a wicket brings in a
new, vulnerable batter, so set-ness disappeared into "a bad innings". Its wicket spread drawn per innings also interacts with
exposure (bad innings are short). With it the benchmark moved further from the real Tests (draws 20%).

### 2.3 Dismissals, extras, DRS

Dismissal mix (men's Tests since 2010), as chances converted by the fielding unit (`fielding.ts` conversion rates, so a good
keeper or slip cordon takes more):

| | caught (fielder) | caught (keeper) | bowled | lbw | stumped | c & b | run out |
|---|---|---|---|---|---|---|---|
| pace | 38.9% | 25.2% | 18.2% | 14.0% | 0.05% | 1.5% | 2.1% |
| spin | 42.6% | 9.4% | 16.9% | 20.3% | 4.7% | 2.9% | 3.3% |

Women's mix is shrunk halfway to the men's (about 900 dismissals).

Extras: a wide is 1 run 86%, 5 (four wides) 11%. A no-ball's bat runs are 0 75%, 1 14%, 4 7%. Byes are 32% of bye / leg-bye
balls; a bye is four 51% of the time, a leg bye 16%.

DRS (men's Tests from 2021, three-review era): 3.36 reviews per innings, 43% by the batting side.
- Batting reviews: 35% overturned, 21% umpire's call.
- Fielding reviews: 19% overturned, 15% umpire's call.
- Kinds: batting reviews 90% lbw; fielding overturns 54% lbw, 46% caught behind.

These turn into per-wicket and per-dot-ball rates the same way `drs.ts` does for T20.

## 3. Players

### 3.1 Ratings to player terms

Players play on `player.forFormat("test")`. The fit builds two maps:
- one on the shipped Test ratings (`packages/app/public/data/format-ratings.json`), used for players who have them;
- one on the T20 ratings, the fallback for players who don't.

Each outcome's term gets an attribute mix from a sign-constrained ridge regression of each real player's observed / expected
ratio on his z-scored ratings (players with 300+ balls since 2015; bowlers standardised within pace / spin).

The mix is read off a **calibration curve**: real players with 30+ balls (tail-enders included) are put in ten bins of equal
expected events, and each bin's pooled observed / expected ratio is made monotone. So a rating means what the real players
rated like that did. The real relationship is flat across most of the range and steep at the ends (number elevens, the very
best batters), which a linear map missed.

For the wicket term only (batter survival, bowler wicket-taking), where the ratings rank players (r ≥ 0.2), the curve is
stretched about its centre to the term's true spread, at most 2x. The scoring terms keep their measured curves: stretching
every term at once made strong sides far too dominant.

| term (Test ratings) | mix | r with the real term | best / worst bin |
|---|---|---|---|
| batter wicket | battingIQ 0.89, timing 0.11 | 0.81 | 0.64x / 2.32x |
| batter singles | running | 0.53 | 1.25x / 0.85x |
| batter fours | power | 0.42 | 1.22x / 0.90x |
| bowler wicket | wicketTaking 0.72, economy 0.28 (stretch 2.0) | 0.36 | 1.41x / 0.71x |
| bowler singles | economy 0.68, accuracy 0.32 | 0.59 | 0.84x / 1.14x |

On T20 ratings the same terms correlate less (batter wicket 0.71, bowler wicket 0.24, bowler fours 0.16), so the fallback
separates teams less (section 6.2). As the ratings agent warned, `timing` in the Test sets barely tracks real boundary rates:
the fitted fours mix uses `power`.

### 3.2 XI and batting order

`pickTestXI`: the best keeper, then four front-line bowlers (two spinners in the subcontinent and UAE, one elsewhere, when the
squad has them), then the six best remaining batters. The order is by Test batting quality, keeper no higher than five, bowlers
last. Explicit XIs in batting order can be passed (`options.xi`).

**Next batter.** The CPU sends in the next in the order, except a **nightwatchman**. When a wicket falls with 4 or fewer overs
left in the day (not the last day), at most five down, and a tail-ender is due later than the next batter, it sends the
best-batting bowler still to come in 35% of the time.

Cricsheet has no day markers, so the rate cannot be fitted, and the 35% is a judgement. What the data does show: real Tests
have 0.88 tail-enders promoted above their usual place per Test (all reasons). 13% of them come in the six overs before the
estimated close, against 6% of other arrivals. The sim sends 0.24 nightwatchmen per Test.

## 4. The captains (fitted policies)

### 4.1 Toss
The share choosing to bat by host country, shrunk to the overall 68% with 10 matches' weight: India 89%, Sri Lanka 89%,
Bangladesh 85%, Pakistan 81%, Australia 77%, South Africa 70%, West Indies 54%, England 51%, New Zealand 23%.

### 4.2 Declarations and the follow-on
Declarations are hazards per end of over: logistic regressions on men's Tests since 2015, over the overs of innings 1-3.
- innings 1: runs / 100 (1.57), match overs / 90 (0.77), wickets (0.32); from 250 runs;
- innings 2: lead / 100 (1.58), overs left / 90 (-1.66), wickets (0.40);
- innings 3: lead / 100 (1.48), overs left / 90 (-1.97), lead per over left (0.015), wickets (0.22); from a lead of 100.

Real 3rd-innings declarations come at a median lead of 433 with 124 overs left. A CPU side starts its pre-declaration push
(the fitted "push" situation) once its hazard passes 2% an over.

The follow-on is enforced with probability logistic(2.86 + 1.74 x (lead - 200) / 100 - 1.16 x overs left / 90 - 3.08 x overs
just fielded / 100). Fitted on 93 chances, 42 enforced.

### 4.3 Bowling
- **Who bowls.** At a spell's end the captain picks spin with the fitted share of the overs for the region (subcontinent / UAE
  vs elsewhere), ball age and day, adjusted for spin spells being longer. He steers back if the day's share has drifted. Among
  that type he picks with weight exp(6 x quality) x (1 + 0.35 x wickets this innings) x freshness. Part-timers count at half
  weight.
- **How long.** Spell lengths are drawn from the fitted distribution (mean 3.8 overs pace, 4.9 spin). A wicket adds two overs
  to the spell, and rest follows the fitted 10th percentile (5 overs pace, 3 spin).
- **Workload.** Bowlers are kept under the fitted 99th-percentile day workloads (21 overs pace, 31 spin).

The constants are calibrated to the real share of overs and wickets by bowler rank (section 6).

**Fatigue beyond the data.** Past an 8-over spell or the 90th-percentile day (16 overs pace, 22 spin), every extra over adds 3%
to the runs and takes 3% off the wickets (capped at 30%). This is an assumption: captains rarely let it happen, so it cannot be
fitted.

### 4.4 Approach
CPU sides bat "normal" (innings 1-3), push before declaring, and take the fitted chase intent in a 4th innings. A user's
approach replaces that:
- attack = the push factors;
- defend = the 6+ required-rate (blocking) factors relative to a normal chase;
- normal = 1.

### 4.5 New ball, reviews
The CPU takes the new ball at 80 overs (the fit assumes it does). CPU reviews follow the fitted rates. A user review is
answered by the truth of the ball: overturned if he was right, struck down or umpire's call at the fitted shares if not.
The user sees a confidence hint, not the answer.

## 5. Time and weather

- **Over rate.** Overs per hour of play (CricketArchive minutes batted: an innings lasts half the sum of its batters' minutes),
  men since 2015: 10th / 50th / 90th percentile 12.8 / 13.8 / 15.8. One rate is drawn per match.
- **Weather.** Time lost = days elapsed x 6 hours less the time batted and the innings breaks (a decided match used the last day
  half; a draw used it all). Fitted per host country: the probability a day is affected (MLE from the matches that lost under
  30 minutes) and the mean share of an affected day lost. Overall 12.6% and 65%, e.g. Sri Lanka 22% / 47%, England 12.5% /
  71%, Australia 7.6% / 85%. An affected day is a wash-out with the probability that gives that mean, otherwise it loses
  5-75%. Days are independent.
- **Women's Tests.** The men's weather and over rates, with 100 overs a day.

## 6. Validation

`npx tsx packages/engine/src/__tests__/benchmark-test.ts 4000`: seeded Tests between the national squads, built the way the
game builds players (squad members from ALL_PLAYERS / WPL_PLAYERS via createPlayerFromData, Test ratings attached from
format-ratings.json with attachFormatRatings). Hosts and opponents are drawn in the real proportions since 2015. Real numbers
are Cricsheet men's Tests since 2015 (473) and since 2023 (146).

### 6.1 Men, Test ratings (4,000 Tests)

| metric | sim | real 2015+ | real 2023+ |
|---|---|---|---|
| innings 1: runs / wickets / overs | 331.5 / 9.41 / 95.5 | 331.1 / 9.44 / 97.8 | 322.6 / 9.55 / 89.6 |
| innings 2: runs / wickets / overs | 311.3 / 9.69 / 91.7 | 303.5 / 9.65 / 92.6 | 308.5 / 9.63 / 85.4 |
| innings 3: runs / wickets / overs | 249.4 / 8.45 / 72.8 | 242.9 / 8.5 / 72.3 | 247.2 / 9.04 / 69.4 |
| innings 4: runs / wickets / overs | 184.9 / 6.43 / 54.6 | 181 / 7.1 / 57.7 | 173.6 / 6.82 / 49.1 |
| innings 4 played | 79.4% | 75.1% | 78.1% |
| runs per over | 3.43 | 3.31 | 3.58 |
| balls per wicket | 55.7 | 55.8 | 50.6 |
| overs per Test | 303.0 | 304.5 | 282.8 |
| overs per day used | 78.3 | 79.6 | 78.6 |
| home win / away win / draw | 52.0% / 32.6% / 15.4% | 52.0% / 34.9% / 13.1% | 51.4% / 39.8% / 8.9% |
| ties | 0.1% | 0.0% | 0.0% |
| days: mean / <=3 / 4 / 5 | 4.29 / 15.8% / 37.9% / 46.3% | 4.26 / 19.7% / 33.4% / 46.9% | 4.05 / 27.4% / 37.0% / 35.6% |
| follow-ons per Test / enforced when available | 0.09 / 45.9% | 0.091 / 50.6% | 0.096 / 66.7% |
| declarations per Test (inn 1 / 2 / 3) | 0.17 / 0.09 / 0.28 | 0.173 / 0.093 / 0.277 | 0.144 / 0.096 / 0.178 |
| 4th-inn target 0-149: win / draw / loss | 93.8% / 4.1% / 2.1% (n 680) | 93.6% / 2.6% / 3.8% (n 78) | 93.3% / 0.0% / 6.7% (n 30) |
| 4th-inn target 150-199: win / draw / loss | 70.0% / 13.5% / 16.5% (n 303) | 74.1% / 0.0% / 25.9% (n 27) | 88.9% / 0.0% / 11.1% (n 9) |
| 4th-inn target 200-249: win / draw / loss | 51.8% / 21.7% / 26.5% (n 309) | 39.1% / 8.7% / 52.2% (n 23) | 37.5% / 0.0% / 62.5% (n 8) |
| 4th-inn target 250-299: win / draw / loss | 29.1% / 21.5% / 49.4% (n 344) | 23.4% / 21.3% / 55.3% (n 47) | 26.1% / 17.4% / 56.5% (n 23) |
| 4th-inn target 300-349: win / draw / loss | 22.8% / 21.5% / 55.6% (n 372) | 11.1% / 13.9% / 75.0% (n 36) | 0.0% / 25.0% / 75.0% (n 8) |
| 4th-inn target 350+: win / draw / loss | 6.7% / 15.8% / 77.6% (n 1168) | 4.2% / 9.0% / 86.8% (n 144) | 2.8% / 5.6% / 91.7% (n 36) |
| innings victories | 17.0% | 18.6% | 18.5% |
| centuries per Test | 1.79 | 1.732 | 1.719 |
| 50+ scores per Test | 6.30 | 6.118 | 5.952 |
| five-fors per Test | 1.02 | 1.304 | 1.459 |
| spin share of bowler wickets, day 1-5 | 28.2% 33.7% 36.5% 40.6% 45.3% | 26.9% 34.5% 40.6% 42.6% 50.7% | 27.1% 36.1% 43.2% 40.1% 50.8% |
| spin share of overs, day 1-5 | 39.8% 42.1% 44.0% 47.9% 53.4% | 34.2% 38.5% 42.6% 45.8% 51.9% | 34.6% 40.2% 44.2% 46.4% 54.2% |
| overs share of bowlers 1-6 (by overs) | 27.7% 22.5% 18.0% 13.5% 9.0% 5.3% | 29.5% 23.5% 19.6% 15.9% 9.5% 4.2% | 29.7% 23.7% 19.4% 15.4% 9.6% 4.5% |
| wicket share of bowlers 1-6 (by overs) | 32.3% 23.8% 18.1% 11.9% 7.3% 3.9% | 33.8% 26.3% 19.3% 13.3% 6.5% 2.9% | 34.3% 25.5% 19.3% 13.0% 7.1% 2.8% |
| strong v weak (Australia, India, South Africa, New Zealand v Sri Lanka, Bangladesh, West Indies, Zimbabwe): strong / draw / weak | 74.2% / 12.6% / 13.2% (n 1274) | 74.4% / 11.1% / 14.5% (n 117) | - |
| win share by team (sim / real 2015+ / 2023+) | I 57.9% E 50.5% A 72.7% SA 45.4% NZ 47.7% P 21.2% SL 24.9% WI 33.2% B 15.6% Z 7.7% | 55.8% 46.6% 57.4% 53.8% 52.8% 36.8% 36.5% 25.5% 27.8% 10.7% | 45.7% 50.0% 61.5% 72.0% 60.7% 29.2% 34.8% 23.3% 44.0% - |
| nightwatchmen per Test (real: promoted tail-enders, all reasons) | 0.26 | 0.88 | - |
| DRS reviews per innings | 3.14 | 3.362 | - |

The squads are 2023+ players, while the strong / weak lists and the 2015+ win shares are of their era; the 2023+ column is the
fairer comparison for single teams.

Reading the table:
- **Close.** Innings totals, runs per over and balls per wicket, overs per day, the home / away / draw split, the days a Test
  lasts, follow-ons, declarations, innings victories, hundreds, short chases, the bowling and wicket shares by bowler rank, and
  strong v weak (since the wickets-down factor, section 6.4).
- **Runs per over (3.42 vs 3.31).** Above the 2015+ figure by design: the base rates are weighted toward 2023+ (3.58), but
  England's Bazball is off by default, so the sim sits between the two.
- **4th-innings chases of 200-349 are won and saved too often** (200-249: 52% won vs 39%, 22% drawn vs 9%; 300-349: 23% won
  vs 11%). Section 6.5 traces it to the chasing top order scoring 17% too fast: in every innings the sim's top-order batters
  score faster than real top orders, and its tail more slowly.
- **Five-fors** are 1.02 per Test vs 1.30. The share of wickets by rank is right, but the spread within bowlers' innings is
  short. No principled change found that fixes it without breaking something else.
- **Spin.** The share of the overs runs a little high on day 1 (40% vs 34%), and of wickets a little low on days 3 and 5.
- **Draws** (16% vs 13%) lose time more evenly than real draws. 41% of sim draws lost 6-12 hours vs 18% real; 30% lost almost
  nothing vs 41%. Real weather clusters within matches; the model's days are independent.

### 6.2 Men, T20 ratings only (the fallback, 3,000 Tests)

| metric | sim | real 2015+ | real 2023+ |
|---|---|---|---|
| runs per over | 3.43 | 3.31 | 3.58 |
| balls per wicket | 57.2 | 55.8 | 50.6 |
| home win / away win / draw | 51.0% / 31.1% / 17.8% | 52.0% / 34.9% / 13.1% | 51.4% / 39.8% / 8.9% |
| days: mean / <=3 / 4 / 5 | 4.41 / 12.1% / 34.2% / 53.7% | 4.26 / 19.7% / 33.4% / 46.9% | 4.05 / 27.4% / 37.0% / 35.6% |
| innings victories | 11.7% | 18.6% | 18.5% |
| centuries per Test | 1.90 | 1.732 | 1.719 |
| five-fors per Test | 0.87 | 1.304 | 1.459 |
| strong v weak (Australia, India, South Africa, New Zealand v Sri Lanka, Bangladesh, West Indies, Zimbabwe): strong / draw / weak | 56.5% / 18.3% / 25.1% (n 967) | 74.4% / 11.1% / 14.5% (n 117) | - |
| win share by team (sim / real 2015+ / 2023+) | I 54.8% E 39.6% A 55.1% SA 40.2% NZ 42.3% P 42.6% SL 29.2% WI 37.1% B 26.2% Z 28.6% | 55.8% 46.6% 57.4% 53.8% 52.8% 36.8% 36.5% 25.5% 27.8% 10.7% | 45.7% 50.0% 61.5% 72.0% 60.7% 29.2% 34.8% 23.3% 44.0% - |

On T20 ratings the engine plays sensible Test cricket (the aggregates hold), but strong and weak sides are much less apart
(57% / 18% / 25%) and the ordering follows T20 form.

### 6.3 Women (1,500 Tests, four squads)

Real: 17 women's Tests since 2014. With so few, these are only a sanity check.

| metric | sim | real 2014+ | real 2023+ |
|---|---|---|
| innings 1: runs / wickets / overs | 333.9 / 9.44 / 104.3 | 312.2 / 9.29 / 95.8 |
| innings 2: runs / wickets / overs | 316.3 / 9.52 / 99.4 | 308.9 / 9.65 / 99.3 |
| innings 3: runs / wickets / overs | 231.9 / 7.93 / 73.6 | 225.6 / 7.71 / 80.5 |
| innings 4: runs / wickets / overs | 154.1 / 5.15 / 48.5 | 114.9 / 6 / 37.2 |
| innings 4 played | 72.4% | 64.7% |
| runs per over | 3.18 | 3.07 |
| balls per wicket | 61.2 | 58.9 |
| overs per Test | 310.7 | 299.6 |
| overs per day used | 88.3 | 87.1 |
| home win / away win / draw | 34.3% / 26.1% / 39.7% | 35.3% / 29.4% / 35.3% |
| ties | 0.0% | 0.0% |
| days: mean / <=3 / 4 / 5 | 3.82 / 16.9% / 83.1% / 0.0% | 3.76 / 29.4% / 64.7% / 5.9% |
| follow-ons per Test / enforced when available | 0.13 / 57.3% | 0.118 / 66.7% |
| declarations per Test (inn 1 / 2 / 3) | 0.18 / 0.12 / 0.31 | 0.412 / 0.294 / 0.294 |
| innings victories | 13.4% | 11.8% |
| centuries per Test | 1.53 | 1.176 |
| 50+ scores per Test | 5.86 | 5.765 |
| five-fors per Test | 0.59 | 0.824 |
| overs share of bowlers 1-6 (by overs) | 25.4% 20.5% 16.8% 13.5% 10.1% 6.9% | 27.9% 21.0% 17.1% 14.0% 11.3% 7.2% |
| wicket share of bowlers 1-6 (by overs) | 28.7% 21.9% 16.4% 13.0% 8.9% 5.8% | 34.9% 23.6% 16.3% 10.3% 7.9% 6.7% |
| DRS reviews per innings | 3.40 | 3.362 |

Women's Tests come out higher scoring than real ones (innings 1: 334 vs 312) with fewer five-fors, while the draw rate,
innings victories and days played are about right. The structure is the men's; only the base rates are women's.

### 6.4 Fourth innings, strong v weak, five-fors (second round)

Measured first, with the same definitions on real men's Tests since 2015 and on the sim (4th innings with targets of 200-349;
balls per wicket by wickets down when the ball was bowled):

| wickets down | real, 4th inn. | sim before | sim after | real, inn. 1-2 | sim inn. 1-2 before | after |
|---|---|---|---|---|---|---|
| 0-2 | 51.6 | 61.6 | 62.2 | 73.5 | 73.2 | 74.7 |
| 3-5 | 56.5 | 55.4 | 59.3 | 74.1 | 68.7 | 73.4 |
| 6-7 | 38.3 | 38.4 | 35.6 | 46.1 | 46.2 | 44.1 |
| 8-9 | 22.7 | 27.2 | 20.2 | 27.2 | 30.7 | 24.2 |

What the data showed:
- **Wickets down is a real effect the fit lacked.** With the batter's own term in, real wickets at 8-9 down fall 22-26% faster
  than the model predicted, in every innings, and middle-order stands at 3-5 down last 4-9% longer. Fitted as a factor (wickets
  ×0.90 / 0.92 / 1.14 / 1.61 from 0-2 to 8-9 down; sixes ×2.7 once the tail is in). It fixed the tail in every innings and
  brought strong v weak to the real split (81% / 11% / 9% → 74% / 14% / 13%; real 74% / 11% / 15%). It also absorbed part of
  the old 4th-innings chase factors (now 0.87-0.99 on wickets).
- **No set-ness × day or × innings interaction.** The model's residuals in real 4th innings by set-ness and by day are within
  ±3%, and its prediction for the real 4th-innings top order is on the mark (observed / expected 1.02 at 0-2 down).
- **Pitches wear differently.** Per match, the wicket rate on days 4-5 against days 1-2 has a true spread of SD 0.11 beyond
  noise. It is now drawn per match (a slope across the days, mean 1). It made no measurable difference to the chases.
- **The sim's 4th innings come a little earlier.** Mean day 4.12 vs 4.28; 34% of their balls on day 5 vs 46%. That is worth a
  few percent of wicket rate, not the 20% top-order gap.
- **Not found.** The sim's 4th-innings top order loses wickets 16% too slowly, so mid-sized chases are won and saved too often.
  The fitted factors match real 4th innings when fed real contexts, so the gap is in the contexts the sim generates for them.
  Candidates not resolved: which matches end up with such chases, and the estimated overs left / days in the data.

Five-fors stay at 1.02 vs 1.30: neither change moved them.

Before → after (4,000 Tests each): 200-249 chases won 50% → 53% (real 39%); 300-349 18% → 27% (real 11%); innings victories
19.8% → 16.9% (18.6%); draws 15.2% → 16.2% (13.1%); five-fors 1.04 → 1.02 (1.30); strong v weak 81 / 11 / 9 → 74 / 14 / 13
(74 / 11 / 15). Innings 1-3 totals and the home / away split unchanged within noise.

### 6.5 Fourth innings, third round

The four suspects were measured against the data before anything changed. "Top order" means 0-2 down; balls per wicket and
runs per over are for 4th innings with targets of 200-349.

| check | real | sim (before) | verdict |
|---|---|---|---|
| (a) overs bowled before the 4th innings, targets 200-249 / 250-299 / 300-349 | 232 / 262 / 283 | 254 / 261 / 262 | not the cause |
| (a) the day factor on 4th-innings top-order wickets (log, vs all balls) | +0.108 | +0.111 | same |
| (b) the match's wicket term on 4th-innings top-order balls (log, vs all) | +0.011 | +0.005 | small |
| (c) bowler term / tiredness on 4th-innings top-order balls (log, vs all) | +0.023 / - | +0.016 / +0.004 | not the cause |
| (d) the chase situation term on top-order wickets (log, vs all) | -0.093 | -0.080 | sim already a little harsher |
| model observed / expected, 4th-innings vs innings 1-2 top order | 1.053 vs 0.991 | (sim matches its own factors: 0.99 / 1.01) | missing interaction |
| top-order balls per wicket, targets < 200 / 200-249 / 250-299 / 300-349 | 52 / 53 / 49 / 54 | 64 / 62 / 62 / 62 | the gap, at every target |

So target selection was not the cause: the gap is the same at small targets. The real 4th-innings top order loses wickets
about 6% faster than the innings and day factors say (an innings x wickets-down interaction). Two changes:

- **Wickets down is now fitted per innings** (16 levels). The 4th-innings top-order wicket multiplier rose from 0.955 to 1.005;
  the 2nd-innings top order came out a little safer. Sim 4th-innings balls per wicket by wickets down, targets 200-349: 55.7 /
  57.8 / 36.5 / 19.6, against real 51.6 / 56.5 / 38.3 / 22.7 (before: 62.2 / 59.3 / 35.6 / 20.2).
- **The chase is measured on scheduled overs left** (5 x 90 less the overs bowled, women 4 x 100), in the fit and in the
  engine alike. The old measure took each match's own length as its time, so a chase that collapsed looked short of time and
  a long rearguard looked unhurried. The easy-chase level was partly encoding the outcome. Results moved within noise.

What is left is scoring. The sim's chasing top order scores at 3.62 an over against 3.09 real (+17%), with wickets now right.
The same decomposition on scoring (log batter term on top-order balls vs all balls) shows why:

| | sim | real |
|---|---|---|
| singles, 4th innings | +0.047 | -0.009 |
| singles, innings 1-2 | +0.058 | +0.003 |
| fours, 4th innings | +0.017 | -0.029 |
| fours, innings 1-2 | +0.021 | -0.020 |

The sim's top orders score faster than real ones in every innings, and its tails slower (8-9 down, innings 1-2: 3.1 an over
vs 3.7). Innings totals still match. Likely causes:
- the Test ratings move survival, running and power together, while real survivors do not score faster per ball;
- the benchmark squads are 2023+ regulars.

Not changed in this round: the scoring maps would need a rethink of how ratings drive scoring rate by batting position.

Before → after this round (4,000 Tests each): 200-249 chases won 52.7% → 51.8% (real 39%), drawn 16.7% → 21.7% (9%); 250-299
won 35.0% → 29.1% (23%); 300-349 won 26.6% → 22.8% (11%); 350+ won 6.5% → 6.7% (4%). Innings 1-3 totals, results (52.0 / 32.6 /
15.4) and strong v weak (74 / 13 / 13) held.

## 7. Live play

```ts
const st = startLiveTest(home, away, { userTeamId: home.id, country: "ENG", seed });  // waits for the toss call if won
decideTest(st, "bat");                          // toss / follow_on ("enforce" | "bat") / new_ball ("take" | "wait") / drs_* ("review" | ...) / next_batter (a batter id)
advanceTest(st, "ball" | "over" | "session" | "day" | "innings" | "match", { autoDecide }); // stops at the user's decisions
declareTest(st); setTestBattingApproach(st, "attack" | "defend" | "normal" | null); setTestNextBatter(st, id | null);
changeTestBowlerTo(st, id, { keepOn }); takeTestNewBall(st); testBowlingOptions(st); testSituation(st);
setTestAutoCaptain(st, true);                   // the CPU captain takes the user's decisions too
serializeTestState(st) / deserializeTestState(json); finishLiveTest(st) // -> TestMatchResult
```

The user is asked for the next batter at the nightwatchman moment (the context names the suggested nightwatchman), and at every
wicket with `pickBatters: true`. `setTestNextBatter` presets the next one in.

The state mutates in place (a Test is ~1,800 deliveries; copying it per ball would be quadratic) and is plain JSON. Its random
stream is a number in the state, so a loaded match carries on exactly as it would have. Live matches carry commentary on every
ball. Instant ones don't by default; `describeTestBall(st, innings, i)` writes it when viewed.

`simulateTestMatch(home, away, options)` plays a whole Test with CPU captains on both sides and returns innings summaries,
`InningsScorecard`s (the limited-overs shape), the event log (toss, days, sessions, weather, declarations, follow-on, new
balls, result), player of the match, and the final state with every ball. It does not touch players' season stats.
`injuries: true` runs the post-match injury checks with the Test/FC multiplier.

## 8. Refitting

```
# Cricsheet Test JSON (declared / absent-hurt flags, days played, reviews) into an empty directory
curl -O https://cricsheet.org/downloads/tests_json.zip && unzip tests_json.zip -d /path/to/tests_json
cd packages/ratings
CRICSHEET_TEST_JSON_DIR=/path/to/tests_json python3 -I src/analysis/test-match-model.py   # ~4 min
#   REUSE=1 reuses the parsed JSON and ball table, REUSE_FIT=1 also the IPF fit (re-run only the maps, policies, targets)
#   FORMAT_RATINGS=... another format-ratings.json (default: packages/app/public/data/format-ratings.json)
cd ../.. && npx tsx packages/engine/src/__tests__/benchmark-test.ts 4000   # RATINGS=t20, GENDER=female, MD=1
```

The script also needs `deliveries.parquet` / `matches.parquet`, `venue_map.csv`, `game_players.json` (data/analysis),
`people.csv` (data/cricsheet), and for bowling styles and minutes batted `espn-players.json` and `cricket.db`. Refit after the
ratings change (new Test sets): the rating maps and the squads fixture depend on them.
