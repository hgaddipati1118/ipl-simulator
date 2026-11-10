# IPL Match Rules Reference

Comprehensive specification for match simulation engine implementation.

---

## 1. Impact Player / Impact Sub

### Overview
Introduced in IPL 2023 and continued through 2025. Allows each team to substitute one player during the match with a full replacement who can bat AND bowl.

### Mechanics
1. **Pre-match**: Each team nominates **5 substitute players** (not 4) in addition to playing XI
2. **During match**: One of these 5 can replace any member of the playing XI
3. **Replacement type**: FULL — the substitute can bat AND bowl (unlike traditional cricket subs who can only field)
4. **Replaced player**: Takes no further part in the match (not even fielding)
5. **Limit**: One substitution per team per match (may use none)

### Timing Rules
- **Before the start of an innings** (before batting/bowling commences)
- **At the fall of a wicket** (replacing the next batter due in)
- **At the end of an over** (between overs)
- **When a batter retires** (voluntary retirement)
- If Impact Player enters after a wicket falls mid-over, they **cannot bowl the remaining deliveries** of that over

### Match Length Restriction
- Impact Player substitution **cannot be used** if match shortened to less than 10 overs per side

### Overseas Player Restriction
- If 4 overseas in starting XI, Impact Player **must be Indian**
- This maintains max 4 overseas at any time

### Strategic Implications
- Teams can field batting-heavy lineups (7 batters + 4 bowlers) and sub in a 5th bowler later
- Or field bowling-heavy (5 batters + 6 bowlers) and sub in a 6th batter when chasing
- Effectively turns T20 into a 12-player-per-side game
- Has increased average first innings scores by ~10-15 runs since introduction

### AI Decision Logic (for CPU teams)
```
IF batting second AND wickets_fallen >= 4 AND required_rate > 10:
    → Substitute in best available batter (replace weakest bowler who hasn't bowled)
ELIF batting first AND score < 120 at 15 overs:
    → Substitute in best available batter (replace weakest bowler who hasn't bowled)
ELIF bowling AND economy_rate > 10 after 10 overs:
    → Substitute in best available bowler (replace batter who already batted/got out)
ELSE:
    → Default: substitute specialist based on match situation at innings break
```

### Unit Tests Required
- See TESTING-STRATEGY.md Phase 2C

---

## 2. Powerplay & Field Restrictions

### Mandatory Powerplay (Overs 1-6)
- Maximum **2 fielders** allowed outside the 30-yard circle
- More gaps in the outfield → higher boundary probability
- Typically highest scoring phase for batting teams
- Phase multipliers: 4s ×1.3, 6s ×1.1, dots ×0.85, wickets ×0.9

### Middle Overs (Overs 7-15)
- Maximum **4 fielders** outside the 30-yard circle (was 5 until 2023)
- Spinners dominate this phase
- Phase multipliers: dots ×1.1, 4s ×0.9, 6s ×0.85, wickets ×1.0

### Death Overs (Overs 16-20)
- Maximum **5 fielders** outside the 30-yard circle
- Highest six-hitting phase, yorkers and slower balls key
- Phase multipliers: 4s ×1.2, 6s ×1.4, wickets ×1.2, wides ×1.2

### Implementation Note
The current engine uses phase multipliers which is the right approach. The key refinement is ensuring the multiplier values produce realistic run distributions:
- Powerplay: ~8-10 RPO average
- Middle: ~6-8 RPO average
- Death: ~9-12 RPO average

---

## 3. Free Hit

### When Awarded
- After every **no-ball** (foot or height), the next delivery is a free hit
- This applies to ALL types of no-balls (overstepping, bouncer over head height, etc.)

### Free Hit Rules
- Batter **cannot be dismissed** by: bowled, caught, LBW, stumped, hit wicket (Law 21 / T20 playing conditions)
- Batter **can be dismissed** by: run out, obstructing the field, handled the ball, hit the ball twice
- If the free-hit ball is itself a wide or a no-ball, the next ball is **also** a free hit; a legal ball ends it
- Implemented in both engines (section 12): `freeHit` state, the legality matrix `canDismiss`, and the data's multipliers on a free hit
  (about 3x the sixes, 1.6x the fours, 0.6x the dots; dismissals fall to 11% of an ordinary ball, all run outs bar a handful of the other three)

---

## 4. Super Over

### Trigger
- When scores are tied after both innings of a T20 match

### Format (both engines, section 12)
- One over (five balls in The Hundred) each; **two wickets** end the innings; each side nominates **three batters and one bowler**
- The side that **batted second in the match bats first** in the super over (not the toss loser); the second side knows the target
- Tied again: another super over, **repeated until a winner** (`superOverTieBreaker: "repeated-super-over"`). The bowler of the previous super over
  cannot bowl in the next one (IPL playing conditions) and a batter dismissed in it is not nominated again (ICC). Which side bats first alternates.
- Rule set `"boundary-count"` (pre-2020): after one tied super over the side with more boundaries in the match and the super over wins
- Selection AI: the three best batters by batting overall and the best bowler by bowling overall who are eligible

---

## 5. Decision Review System (DRS)

### Allocation
- Each team gets **2 unsuccessful reviews per innings** (IPL-specific, more generous than ICC standard of 1)
- Successful review (decision overturned): review is **retained**
- Unsuccessful review (decision stands): review is **lost**
- "Umpire's call": decision stands but review is **retained**
- **15-second timer** to signal DRS after decision

### What Can Be Reviewed
- Caught decisions (was it a clean catch?)
- LBW decisions (was it hitting the stumps? was it pitching in line?)
- Boundary/no-boundary (did the ball cross the rope?)

### Implementation for Simulator
(Superseded by section 13.4: both engines now use reviews fitted from Cricsheet `review` records. The original sketch follows.)
Since we don't model fielding positions, DRS is simplified:
- When a wicket falls, there's a 10-15% chance it would have been overturned by DRS
- If the batting team has a review remaining, the decision may be reversed
- This adds drama to key moments and occasional reprieve for batters
- Probability of successful review: `bowlerAccuracy < 70 ? 0.15 : 0.08`
- (The live viewer's reviews are described in section 12.)

---

## 6. Strategic Timeout

### Rules
- **2 per innings** (one per team)
- **Bowling team**: must take between **overs 6 and 9**
- **Batting team**: must take between **overs 13 and 16**
- Duration: 2.5-3 minutes
- Auto-called at end of window if not used

### Implementation
- Model as a potential momentum shift
- After timeout: slight random adjustment to subsequent outcomes
- Adds realism without major gameplay impact
- Can display in ball-by-ball commentary: "Strategic timeout called by {team}"

---

## 7. Extras System

### Wides
- Ball pitched too far from the batter (wide of off stump or down leg side)
- Penalty: **1 run** added to total (not credited to batter)
- Ball does **not count** as a legal delivery (extra ball bowled)
- T20 wide rule is stricter than Tests (narrower acceptable zone)

### No-Balls
- Bowler overstepping the crease, bouncer above head height, etc.
- Penalty: **1 run** added to total + **free hit** next ball
- Ball does **not count** as a legal delivery
- Batter keeps any runs scored off the no-ball

### Leg Byes
- Ball hits batter's body (not bat) and runs are taken
- Runs added to total but **not credited** to batter
- Counts as a legal delivery

### Byes
- Ball misses everything and runs are taken (keeper misfield)
- Rare in T20s, can model as part of leg bye probability

---

## 8. NRR (Net Run Rate) Calculation

```
NRR = (Total runs scored / Total overs faced) - (Total runs conceded / Total overs bowled)
```

### Special Cases
- If a team is bowled out before 20 overs, their overs faced = 20 (for NRR purposes)
- If a team chases successfully, their actual overs count (not 20)
- Example: Team scores 150 in 18.2 overs chasing 149 → overs = 18.333 (not 20)

### Implementation
Currently the engine tracks `ballsFacedFor` and `ballsFacedAgainst`. Need to ensure:
- Bowled-out team: use 120 balls (20 overs) for denominator
- Successful chase: use actual balls faced

---

## 9. Toss Rules

### Current Implementation
- 50/50 coin toss (correct)
- 60% chance toss winner chooses to bowl (chase) — this is accurate for T20s
- Some stadiums/conditions may favor batting first (dew factor)

### Potential Enhancement
- Stadium-specific toss preference (e.g., Wankhede dew makes chasing easier → 70% choose to bowl)
- This can be modeled as a per-venue toss bias

---

## 10. Injury Rules

### Current Implementation
- 2% chance per player per match (reasonable)
- Injury lasts 1-3 games

### Enhancement
- Pace bowlers: higher injury risk (3-4%)
- Young players: slightly lower injury risk
- Players returning from injury: higher re-injury risk for first 2 matches
- Injury replacement: team can call up squad member (not playing XI replacement mid-match)

---

## 11. Fielding and wicketkeeping

Implemented in `packages/engine/src/fielding.ts`, shared by the season engine (`match.ts`) and the live engine (`live-match.ts`). Ratings:
`PlayerRatings.fielding` (catching, ground fielding, run-out threat) and `.keeping` (taking the ball cleanly, stumpings, catches behind), both 0-99 with
50 average and **optional**: absent fielding means 50; absent keeping means 50 for a designated keeper and 25 for anyone else. Where the numbers come
from: RATINGS-PIPELINE.md, "Fielding and wicketkeeping ratings".

### Dismissal chances

The base model's wicket probability `p` is the probability of a dismissal that stands. Catches, stumpings and run-outs are really *chances*
that are sometimes put down, so the engine models them that way:

1. (The dismissal mix quoted here, 55 / 20 / 15 / 7 / 3, is the engine's old one: since section 12 it is the Cricsheet mix per gender, with c&b, hit wicket and the other kinds.)
   Before the ball is sampled, the wicket weight is multiplied by `W` (`chanceInflation`, about 1.15), and the scoring outcomes give up exactly the
   mass of chances an average side puts down, so the total is unchanged. `W` comes from the dismissal mix: caught 55%, bowled 20%, lbw 15%,
   run out 7%, stumped 3% (stumped 6% when the bowler is a spinner, 1.4% for pace; the rest scaled), with caught chances inflated by 1/0.82, run-out
   chances by 1/0.75 and stumping chances by 1/0.90 (the conversion of an average fielder).
2. A "wicket" draw is a chance. Its kind is drawn from those weights. For a catch the fielder is picked at random from the XI minus the bowler
   (the keeper counts 1.7x: keepers take ~15% of catches); a stumping falls to the keeper; a run-out to a random fielder.
3. The chance is converted with probability `conv(skill)`: catches `0.82 + 0.004 (rating - 50)` (clamped 0.55-0.97; the keeper uses `keeping`),
   stumpings `0.90 + 0.003 (keeping - 50)`, run-outs `0.75 + 0.005 (fielding - 50)`. A converted chance is the dismissal (and is recorded: the
   `BallEvent` has `wicketType`, `fielderId`, and the scorecard reads "c Pooran b Bumrah", "st Pant b Chahal", "run out (Jadeja)"). A miss is a
   *dropped catch* / *missed stumping* / *run-out missed*: the batter survives and the ball becomes dot, 1, 2, 3, 4 or 6 in proportion to the
   ball's probabilities, with its own commentary line. A great catch (a taken catch by a 72+ fielder) and a direct hit get a commentary line too.
4. For a side of average fielders, `p * W * (average conversion) = p`, so wickets, runs and boundaries are exactly the base model's, with
   the difference that about one catch chance in six is visibly put down. Better fielders convert more (more wickets, fewer runs), worse fewer.

### Runs saved and byes

- The XI's mean fielding rating, against `TEAM_FIELDING_PIVOT` = 48 (a typical XI sits a little under 50 because of its four or five bowlers:
  IPL 2026 XIs average 46.3, WPL XIs 50.1), gives `q = (mean - 48) / 50`. Fours are scaled by `1 - 0.10 q`, twos and threes by `1 - 0.15 q`, dots by
  `1 + 0.04 q`. With the catch/run-out conversion above, a side whose every fielder is 20 points below the pivot concedes about 7-8 runs more an
  innings and takes ~0.3 fewer wickets than an average one; 20 points above, about 6 runs fewer and ~0.25 more wickets. Real sides differ by a few
  points (IPL XI means 39.9-52.5), so the usual swing between two sides is a run or two.
- The keeper's `keeping` scales the leg-bye / bye probability by `1 - 0.9 (keeping - 50) / 50` (clamped 0.4-1.8): a 20 keeper concedes ~1.8x the leg byes/byes
  of a 50 (about +0.9 runs an innings), an 85 keeper ~0.4x. With his stumping and catch conversion, an 85 keeper against a 20 is worth ~2 runs and
  ~0.25 wickets an innings.

### Keeper selection

`pickKeeper(xi)` returns the designated keeper with the best `keeping`; if the XI has none, the player with the best `keeping` rating (an emergency
keeper, 25 unless rated). `Team.autoSelectPlayingXI()` places a designated keeper in every XI when the squad has one, choosing among several by
selection value plus keeping worth (`keeperSelectionValue`, RULES-SQUAD.md section 5); it also covers a
squad with none (or an injured keeper): the squad's best-keeping player is brought into the XI when he is clearly better (10+ points) than anyone already
in it, subject to the overseas limit. A user-chosen XI still has to contain a designated keeper to be used as is. Impact-player substitutions update
the fielding unit (the substitute fields, the player replaced does not).

### Balance

60,000 simulated matches (120,000 innings) between the ten IPL 2026 squads built the way the game builds them (`getRealPlayers()` ->
`createPlayerFromData`), random pairings, injuries off, per innings. "Before" is the engine at the commit this work branched from.
`packages/engine/src/__tests__/benchmark-fielding.ts` reproduces it (`NO_FK=1` strips the ratings; `ENGINE=` points at another build).

| per innings | before | after, ratings stripped (all defaults) | after, with ratings |
|---|---|---|---|
| runs | 165.70 | 165.05 (-0.4%) | 166.09 (+0.2%) |
| wickets | 6.895 | 6.924 (+0.4%) | 6.884 (-0.2%) |
| fours | 16.47 | 16.38 (-0.5%) | 16.55 (+0.5%) |
| sixes | 7.634 | 7.610 (-0.3%) | 7.646 (+0.2%) |
| extras | 4.361 | 4.354 (-0.2%) | 4.242 (-2.7%, keepers concede fewer byes than the 50 default) |
| legal balls | 110.02 | 109.89 | 110.08 |
| chasing side wins | 55.4% | 55.8% | 55.5% |

Sampling noise on these means is ~0.1% (runs +-0.15, wickets +-0.01). After the change a typical innings also contains 3.76 caught, 0.47 run-out and
0.26 stumped dismissals, ~0.84 put-down catches and a great catch every 40 innings. The engine test `fielding.test.ts` re-checks neutrality with 1,500-match
samples and the direction of the effects (elite vs poor fielding sides).

The wicket draw now also decides how the batter got out, so the scorecard's dismissals name the fielder who took the catch / made the stumping /
threw at the stumps instead of a random fielder; the random draws that used to assign the kind after the match no longer happen, so a given seed plays out
differently from before the change.


---

## 12. The Laws and the T20 playing conditions: audit, model, balance

Audit of both match engines (`match.ts`, the instant sim; `live-match.ts`, the live viewer with its own ball logic) against the Laws of Cricket, the
ICC / IPL T20 conditions and Cricsheet. Every rate is **fitted from Cricsheet T20 / IT20 ball-by-ball data** (14,745 matches, 3.36 million deliveries,
182,668 dismissals) by `packages/ratings/src/analysis/match-rules.py` and exported as `packages/engine/src/match-rules-data.ts` (report:
`data/analysis/match_rules.json`). Run from `packages/ratings`: `python3 -I src/analysis/match-rules.py` (needs the `duckdb` CLI).

### 12.1 How a delivery is built

1. The engine samples the coarse outcome from its own probabilities (dot, 1, 2, 3, 4, 6, wicket, wide, no-ball, bye / leg bye). A free hit first
   reweights them (`applyFreeHitToProbs`).
2. A "wicket" draw is a dismissal *chance* (section 11): its kind comes from the fitted mix (per gender; stumpings by bowler type), the fielders are
   picked, the chance is converted or put down. A free hit only allows run out / obstructing / handled / hit twice.
3. `expandDelivery` (`delivery-rules.ts`) turns the outcome into a complete delivery (`DeliveryDetail`): wides (1-5), the no-ball cost and what the bat hit
   off it, byes against leg byes (1-5), overthrow boundaries, penalty runs, wides / no-balls dismissals, the run out's batter, completed runs and fielders,
   and who faces next.
4. The engine applies it: score, extras by type, bowler runs (bat + wides + no-balls only), balls faced (not wides), strike, the new batter's end,
   free-hit state, wickets (bowler credit only for bowler wickets), the scorecard text (`dismissalText`).
5. Between balls: mid-over bowler injury (another bowler finishes the over and sits out the next), retired hurt (may return at a wicket), tactical
   retired out, timed out on arrival, and a Mankad before the delivery.

`BallEvent` / `DetailedBallEvent` gained only optional fields (`playerOutId`, `nonStriker`, `wides`, `noBalls`, `byes`, `legByes`, `penaltyRuns`, `boundary`,
`overthrow`, `freeHit`, `wideKind`, `runsRun`, `newBatterFaces`, `fielder2Id`, `substitute`, `deadBall`), `wicketType` widened to `DismissalKind`.
Saved games and old match records load: absent fields read as before (extras fall back to outcome + extras; the dismissed batter is the striker).
A given seed plays out differently from before.

### 12.2 Situation table

"Before" is the engine at the commit this work branched from. "Rate" is Cricsheet T20 (men, 2019+ for the dismissal mix; all years for extras).
`I` = instant engine, `L` = live engine.

| Situation | Before | After | Real rate (source) |
|---|---|---|---|
| **Dismissals** | | | |
| bowled | I, L | I, L | 19.2% of men's dismissals (25% women) |
| caught (fielder, keeper 1.7x weight, substitute) | I, L; substitute no | I, L; substitute fielder from the bench | 61.4% men / 44% women; keeper 16.8% of catches; 0.15% by a fielder not in the registry (substitute proxy) |
| caught and bowled | no (counted in caught, a random catcher) | I, L: the bowler, "c & b Bowler" | 3.0% men / 4.0% women |
| lbw | 15% (too high) | 7.1% | 7.1% men / 9.2% women (not off a no-ball or free hit) |
| stumped | 3.8%, also off a wide: no | 2.5%, off a wide yes, never off a no-ball or free hit | 2.4% men / 5.0% women; 0.44% of wides end in a wicket, 73% of those stumpings |
| run out, striker | I, L | I, L | 53% of run outs |
| run out, non-striker | **no** | I, L | **47%** of run outs (11,187 of 23,227 in all formats): 50% with no run completed, 42% after one run |
| run out off a wide / no-ball / free hit | no | I, L: wide 0.27 of wide wickets, no-ball 0.52% of no-balls, free hit 0.6% | as shown |
| run out: runs completed first, relay | none | 0 / 1 / 2 runs (64 / 34 / 2%) credited to the striker; one fielder or a relay "(A/B)" (52%); bowler involved 34%, keeper 34% | Cricsheet |
| hit wicket | no | I, L; off a wide yes, not off a no-ball | 0.10% (185) |
| obstructing the field | no | I, L; legal on any ball | 0.01% (19) |
| handled the ball | no | I, L (data-faithful, now "obstructing" in the Laws) | 1 in IT20 |
| hit the ball twice | no | I, L; not credited to the bowler | 1 |
| timed out | no | I, L: a batter can be timed out on arrival (a wicket, no bowler credit) | 0 in T20; rate 1.4e-6 per wicket (Jeffreys over every format's wickets) |
| retired hurt (resumes) | no (instant), no | I, L: not out, replaced, may return at a wicket; the innings ends when no partner is left | 261 events, 4.1e-5 per batter-ball (0.0085 an innings); 0 of 247 resumed, so the return chance is the Jeffreys 0.2% |
| retired out (cannot return, not a wicket) | L only (death-over rule) | I, L | 108 events, 0.0067 an innings since 2022, mean over 14.6 |
| Mankad (dead ball, nobody bowled) | no | I, L: a non-striker run out by the bowler, no legal ball counted, no bowler credit | not separable in Cricsheet (recorded as an ordinary run out): ~20 known T20 cases, 6e-6 per delivery (an assumption) |
| **Extras** | | | |
| wides | +1 only | I, L: 1-5 (91% / 4.5% / 1% / 0.1% / 3.5% men: the 5 is a boundary wide); kind off / leg / over the head ("wide for height", 12% in the corpus); batter does not face it | 3.36% of deliveries (men), 4.9% women; mean 1.21 runs |
| no-balls | +1 only, nothing off the bat | I, L: cost 1 (2 in The Hundred); the bat's 0-6 (44% 0, 27% 1, 12% 4, 7% 6), byes / leg byes; batter faces it; free hit next | 0.43% of deliveries; The Hundred 85% cost 2 |
| free hit | state missing in live, instant had none | I, L: carries through a wide / no-ball on it; multipliers on scoring, dismissals restricted | 0.45% of balls; sixes 2.95x, fours 1.57x, dots 0.62x |
| byes and leg byes | one leg bye of 1 run counted as a legal ball, no strike change | I, L: byes 19% / leg byes 81% of the class, 1-5 runs, boundary byes; odd runs change the strike; not charged to the bowler | 1.83% of deliveries (men): leg byes 1.49%, byes 0.35%, mean 1.3 / 1.9 runs |
| penalty runs (5) | no | I, L: extras not charged to the bowler | 1.4e-5 per delivery |
| overthrows, boundaries | no | I, L: +4 after a run or a dot, not a four | 3.9e-4 after a run, 1.6e-4 after a dot (overthrows of single runs are inside the 2s and 3s) |
| short run, dead ball other than a Mankad | no | **not modelled** (no data for a short-run rate) | |
| **Batting** | | | |
| odd runs swap strike | bat runs only | bat, byes, leg byes, wides, no-balls (physical runs; boundaries do not count) | |
| new batter's end | the new batter always faced | catch, bowled, lbw, stumped, hit wicket: new batter faces, except at an over's end (the survivor does); run out follows Cricsheet (new batter faces 58% / 24% when the non-striker is out after an even / odd number of runs, 39% / 83% for the striker) | Law 18.11 (2022), Cricsheet since Oct 2022: 100% for catches |
| batters crossing on a catch | irrelevant | irrelevant (2022 Laws) | |
| last man standing | instant: ended at 10 wickets only | the innings ends when no partner is left (retired out / hurt batters count as unavailable) | |
| all out at 10 | yes | yes | |
| **Bowling** | | | |
| 4 overs, no consecutive overs, Hundred 5 or 10 balls | yes | yes | |
| over left incomplete by injury | no | I, L: another bowler finishes it and cannot bowl the next over; the part-bowled over counts towards both; the injured bowler is done | 0.090% of overs (0.0007 per ball) |
| slow over-rate in-field penalty | no | not modelled: the engine has no clock | |
| **Match** | | | |
| tie to a super over | instant: one over, ten wickets, same batters and bowler again, the side that batted first bats first; live: boundary count / coin flip | I, L: one over each, two wickets, three batters and one bowler, the side that batted second bats first, repeated while tied, previous bowler and dismissed batters out | 208 super-over innings: 10.3 runs, 0.74 wickets; the engine's 10.0 / 0.69 after the super-over factors (1.15% of matches tie, real 0.7%) |
| DLS / rain | live only | unchanged (live only; the instant sim has no rain) | |
| no result | live (abandoned under 5 overs) | unchanged | |
| impact player | I, L | unchanged; the scorecard now includes the impact player's batting and bowling (it used to omit them) | |
| DRS (two reviews per innings) | L: lbw, wide, no-ball, run out | unchanged, plus: no review of an lbw on a free hit, only plain wides / no-balls are reviewed, a run out review names who was out | |
| **Stats and scorecards** | | | |
| bowler credited | every wicket | only bowled, caught, c&b, lbw, stumped, hit wicket | ICC |
| balls faced | legal balls | legal balls and no-balls, not wides | |
| bowler runs | bat + all extras on legal balls | bat + wides + no-balls (not byes, leg byes, penalty) | |
| maidens / dots | wide-aware | a maiden is six legal balls with nothing charged; byes do not spoil it | |
| scorecard text | five kinds | all kinds (`dismissalText`: "c & b X", "run out (A/B)", "c sub (X) b Y", "hit wicket b X", "obstructing the field", "retired hurt" ...) | Cricinfo |
| extras line | w, nb, lb | b, lb, w, nb, pen | |
| fielding credits | catches | catches, c&b to the bowler, stumpings, run outs (optional stats) | |
| fantasy points | none for fielding | +8 catch, +12 stumping, +12 run out (+6 each for a relay), +8 bowled / lbw to the bowler | Dream11 |
| **Commentary** | | | docs/COMMENTARY.md section 8 |

### 12.3 Calibrations that are not straight fits

- `EXTRAS_RATE_CAL` (wide x1.55, no-ball x1.6, bye / leg bye x1.45): the engine's base rates were below Cricsheet (wides 2.15% of deliveries against 3.36%).
- `RUNNING_RUNS_CAL` (singles, twos, threes x0.94, the mass goes to dots): see the balance note below.
- `STUMPED_ENGINE_SCALE` (0.72): the game's XIs carry about half spin overs, the data a third.
- `SUPER_OVER_CAL` (wickets x2.7, boundaries x1.4): the base model gives a super over 0.30 wickets, the data 0.74.
- The women's leagues use the women's extras and dismissal mixes but the men's base rates of wides, no-balls and byes (women's real wide rate is 4.9%).

### 12.4 Balance

60,000 simulated matches (120,000 innings) between the ten IPL 2026 squads built the way the game builds them, random pairings, injuries off, per innings.
`benchmark-rules.ts` (instant) and `benchmark-live-rules.ts` (live) reproduce it (`ENGINE=` points at another build).

| per innings | before | after | Cricsheet IPL 2023-26 |
|---|---|---|---|
| runs | 166.08 | 168.33 (+1.4%) | 174-186 |
| wickets | 6.884 | 6.866 (-0.3%) | 5.9-6.2 |
| fours | 16.54 | 16.66 (+0.7%) | 14.7-15.8 |
| sixes | 7.645 | 7.734 (+1.2%) | 7.6-9.6 |
| extras | 4.24 | 8.05 | 8.2-9.3 |
| wides (balls) | 2.46 | 3.81 | ~5.0 |
| no-balls | 0.31 | 0.50 | ~0.5 |
| bye / leg-bye balls | 1.47 | 2.11 | ~1.9 |
| free hits | 0.32 | 0.51 | |
| chasing side wins | 55.5% | 55.0% | |
| super overs (share of matches) | not recorded | 1.15% | 0.7% |

The engine **was wrong** about extras: 4.2 an innings against 8.2-9.3 in the IPL since 2022 (the other half went into its batters' runs). Bringing the extras to
the data adds 3.8 runs (+2.9%); the running-runs trim takes that to +1.4%. The dismissal mix before: caught 54.6%, bowled 19.8%, lbw 14.9%, run out 6.9%,
stumped 3.8% (lbw twice the data, caught 9 points low, no c&b); after: caught 61.4%, c&b 3.0%, bowled 19.1%, lbw 7.1%, run out 6.8%, stumped 2.5%, hit wicket
0.11%, against 61.4 / 3.0 / 19.2 / 7.1 / 6.7 / 2.4 / 0.10 in Cricsheet men's T20 since 2019.

The **live engine** (5,000 CPU-vs-CPU live matches each, 10,000 innings, sampling noise about 0.3% on the runs) before and after:

| per innings | before | after |
|---|---|---|
| runs | 241.25 | 242.17 (+0.4%) |
| wickets | 6.018 | 6.087 (+1.1%) |
| fours | 25.88 | 25.72 (-0.6%) |
| sixes | 14.77 | 14.82 (+0.3%) |
| extras | 4.18 | 7.89 |
| wides / no-balls / byes (balls) | 2.49 / 0.40 / 1.29 | 3.81 / 0.63 / 1.89 |
| chasing side wins | 62.5% | 62.8% |

The live engine's scoring level (241 an innings with fours 25.9 and sixes 14.8, against 174-186 in the IPL since 2023) is its own pre-existing calibration (an
"IPL 2025 scoring era" boost on top of the base model, a chase win rate of 62%); that was left alone, the rules change moves it by +0.4%. Its extras were just as
low (4.2) and are now at the data (7.9). Its dismissal mix after the change matches the instant engine's.

**The live engine now plays at the instant engine's level** (November 2026). The 241-run live level above is gone: a live ball comes from the instant
engine's own chain, `ballProbabilities` in `match.ts` (the T20 tables or the ODI model, phase multipliers, the ground, the chase edge, matchups, the
ball-change rule, chase context, clutch, morale, super over, over-rate restriction, free hit), and the live engine adds only the user's decisions on
top: the batting approach, as a relative change (what the old live model's aggression term did to a middle-of-the-road matchup, so BAL 50 is neutral and
DEF / ATK move scoring from the calibrated level), and the field setting (standard = none). Gone from the live ball, because the instant engine has none
of them: the live engine's own base matrix and phase table, the "IPL 2025 scoring era" boost, the home and day/night edges, the boundary-running and dew
tables, the batter's form, and the set-batter / bowler-fatigue terms. Around the ball the live engine now does what the instant one does: a CPU side bowls
one of its three best bowlers by rating each over, the first over too (a user's own phase plan still comes first; the old automatic phase plan for CPU
sides is gone), each side bats and bowls in its team's order in both innings (the toss and the innings break no longer re-sort the XI), a neutral venue
(playoffs, a neutral series) has no ground effects, and rain comes only with the `rain` option, from the instant engine's fitted plan (the league's
rates, DLS on T20 resources); the old once-an-innings rain check is gone. The season's live matches pass `rain` and neutral playoff grounds as the season's
instant matches do, and every CPU bowling choice uses the match's seeded generator.

Parity (`packages/app/src/__tests__/live-parity.test.ts`, `LIVE_PARITY=1`): the game's own squads per league (`createGameState`), the same pairings and
seeds, injuries and rain off, per innings; "live user" is a user side on default settings whose decisions the CPU takes (`simulateRemaining`). Before:
300 matches per row; after: 600 (noise about 1% on the runs, 3 points on batting-first wins).

| league / engine | runs | wkts | 4s | 6s | extras | RR 1-6 / 7-15 / 16-20 | all out | bat 1st wins |
|---|---|---|---|---|---|---|---|---|
| IPL instant | 170.3 | 6.89 | 16.5 | 8.0 | 8.0 | 10.64 / 7.74 / 10.68 | 27.0% | 51.8% |
| IPL live CPU, before | 245.2 | 5.91 | 25.9 | 15.1 | 7.6 | 14.83 / 11.70 / 15.29 | 19.7% | 39.0% |
| IPL live user, before | 253.7 | 5.84 | 26.6 | 15.8 | 7.8 | 14.90 / 12.02 / 15.68 | 18.0% | 39.5% |
| IPL instant (600) | 169.8 | 6.86 | 16.4 | 8.0 | 7.9 | 10.54 / 7.72 / 10.60 | 25.8% | 47.3% |
| IPL live CPU, after | 168.3 | 6.86 | 16.4 | 7.7 | 8.0 | 10.54 / 7.69 / 10.44 | 25.1% | 45.8% |
| IPL live user, after | 172.7 | 6.74 | 16.8 | 8.0 | 8.0 | 10.53 / 7.82 / 10.75 | 23.0% | 43.2% |
| WPL instant (600) | 163.7 | 6.99 | 16.2 | 7.4 | 7.0 | 10.46 / 7.33 / 10.03 | 27.8% | 51.9% |
| WPL live CPU, before / after | 224.2 / 159.3 | 6.41 / 6.93 | 24.1 / 15.8 | 12.8 / 7.1 | 6.7 / 6.7 | 14.05 / 10.73 / 13.77 → 10.28 / 7.24 / 10.07 | 23.7% / 28.4% | 43.6% / 46.3% |
| BBL instant (600) | 159.2 | 6.45 | 15.0 | 7.7 | 8.5 | 9.77 / 7.05 / 9.57 | 18.9% | 49.0% |
| BBL live CPU, before / after | 230.9 / 158.3 | 5.81 / 6.50 | 23.3 / 14.9 | 14.6 / 7.6 | 8.5 / 8.5 | 13.83 / 10.70 / 14.26 → 9.76 / 7.08 / 9.50 | 18.5% / 20.8% | 40.3% / 49.0% |
| WBBL instant (600) | 141.1 | 6.21 | 13.7 | 6.6 | 6.6 | 8.74 / 6.08 / 8.81 | 16.4% | 49.9% |
| WBBL live CPU, before / after | 208.5 / 142.0 | 5.82 / 6.26 | 21.6 / 13.7 | 12.5 / 6.7 | 7.2 / 6.6 | 12.55 / 9.42 / 13.12 → 8.73 / 6.07 / 8.78 | 15.2% / 16.2% | 41.1% / 51.4% |
| PSL instant (600) | 170.4 | 6.40 | 16.1 | 8.4 | 8.8 | 10.39 / 7.70 / 10.40 | 20.8% | 48.0% |
| PSL live CPU, before / after | 246.4 / 171.4 | 5.80 / 6.29 | 25.2 / 16.3 | 15.6 / 8.4 | 8.7 / 8.9 | 14.79 / 11.46 / 15.04 → 10.49 / 7.64 / 10.53 | 16.5% / 17.3% | 42.8% / 42.5% |

Live user sides after (WPL / BBL / WBBL / PSL): 161.2 / 158.8 / 142.9 / 170.9 runs. A user side scores a little more than a CPU one because the CPU's
answers to its decisions take the best batter available and the best bowler (not one of the best three). Left: the WPL live level is 2.7% under the
instant one (the other leagues within 1%), batting first wins 0-6 points less often live than instant (within about two standard errors in each
league), CPU sides do not use the Impact Player in the live engine (the instant engine's do; worth under a run an innings there), and the live DRS and
CPU retire-out rules are still the live engine's own.

The batting approach on that level (the same file, second table: the IPL, 400 matches, a user side batting DEF / BAL / ATK all match, its innings only):

| approach | runs | wickets | run rate | 4s | 6s | all out |
|---|---|---|---|---|---|---|
| DEF (20) | 169.7 | 5.74 | 8.86 | 16.2 | 7.4 | 12.3% |
| BAL (50) | 174.7 | 6.49 | 9.38 | 16.9 | 8.0 | 19.8% |
| ATK (80) | 176.2 | 7.34 | 9.84 | 17.4 | 8.5 | 32.3% |

DEF scores half a run an over slower and loses three-quarters of a wicket less; ATK half a run an over faster for nearly a wicket more, so over a whole
innings it adds only a run and a half (a third of ATK innings are bowled out). At the old live level the same relative changes sat on 245-run innings.

### 12.5 Verified in the live viewer

Headless Chromium (Playwright's own, against a Vite dev server on port 3877) played a full live match with the rule rates raised through `setRuleOverrides`:
the FREE HIT badge shows after a no-ball, the ball log carries "FREE HIT!" lines, penalty runs, a Mankad ("whips the bails off at the non-striker's end ...
no ball is bowled") with the scorecard row "run out (bowler)", retired hurt, non-striker run outs, "c & b", lbw and run-out scorecard text, the match completes
(PBKS 202/10) with the extras row split. Super overs in the viewer are covered by the engine tests (the match page shows `state.result`).

### 12.6 Not modelled (at the time of section 12)

Short runs; the slow over-rate in-field penalty; DLS and no-result in the instant sim; DRS for caught-behind edges; bouncers per over (a third bouncer is a
no-ball); the Hundred's ends changing every ten balls (strike still changes every set); the live viewer has no Hundred; user decisions for a mid-over bowler
replacement and for a returning retired-hurt batter (both automatic). **Section 13 adds all of these except bouncers per over and a live Hundred.**

### 12.7 Women's league levels

The women's leagues used to play on the league tables with a level fitted on runs, wickets and balls per innings only
(`LEAGUE_LEVELS`, the WPL's scoring multiplier): totals near the real ones, but a powerplay two to three runs an over too
fast, middle overs too slow and two to four times the real sixes. Each now has a scoring context on top of the tables,
the same kind as the T20I's (`scoring-context.ts`; docs/FORMATS.md, "T20I level"): per phase (overs 1-6, 7-15, 16-20; the
Hundred's sets 1-5, 6-15, 16-20, as `phaseOver` maps them) a multiplier on each outcome class, in both engines.

- **Data** (`packages/ratings/src/analysis/t20i-level.py`, `docs/data/t20i_validation.json` `womensLeagues2024`): each
  league's full matches since 2024 in Cricsheet: WPL 66, WBBL 77, women's Hundred 98.
- **Fit** (`packages/app/src/__tests__/calibrate-contexts.test.ts`, `CALIBRATE_LEAGUES=1`): the game's own squads
  (`createGameState`), 600 instant matches a round, six rounds of proportional fitting of each phase's class shares. A
  league's real shares are shrunk toward the three leagues' pooled shares with the weight of 1,500 deliveries a phase (the
  WPL's powerplay has about 4,700). Written to `womens-league-context-data.ts`.
- **Which matches:** the WPL, WBBL and women's Hundred read their own table; any other women's T20 or Hundred (a custom
  women's league) reads `default`, the delivery-weighted geometric mean of the three. Men's leagues, mixed leagues, the ODI
  and T20Is (which have their own) read none: the men's T20 and Hundred fingerprint lines are unchanged; the women's line
  (the IPL squads under women's rules, on the pooled table) moved from `44cb21795e248267` to `7d214ad967890a1c`.

First innings (sd), real / before / after (instant; live CPU after in brackets):

| | runs | RR 1-6 / 7-15 / 16-20 | wickets / all out | 4s / 6s an innings (all innings) |
|---|---|---|---|---|
| WPL real (66) | 162.0 (29.3) | 7.40 / 7.82 / 9.54 | 6.79 / 12.1% | 18.2 / 4.1 |
| WPL before | 172.6 (29.9) | 10.62 / 7.40 / 9.96 | 7.28 / 26.5% | 16.2 / 7.4 |
| WPL after | 158.8 (23.6) [158.6] | 7.28 / 7.94 / 9.43 | 6.40 / 15.8% | 17.7 / 3.7 |
| WBBL real (77) | 155.0 (25.5) | 7.03 / 7.55 / 9.09 | 6.92 / 15.6% | 16.2 / 2.5 |
| WBBL before | 147.8 (27.6) | 8.73 / 6.06 / 8.88 | 6.33 / 13.5% | 13.7 / 6.6 |
| WBBL after | 151.2 (22.5) [151.6] | 6.99 / 7.61 / 8.97 | 6.68 / 16.8% | 16.1 / 2.5 |
| Hundred women real (98) | 126.2 (24.5) | 6.97 / 7.42 / 8.61 | 6.53 / 11.2% | 13.3 / 1.8 |
| Hundred women before | 124.1 (20.0) | 8.71 / 6.24 / 8.96 | 6.08 / 9.3% | 11.3 / 5.6 |
| Hundred women after | 126.4 (17.7) | 7.15 / 7.45 / 8.67 | 6.13 / 10.5% | 13.5 / 1.9 |

(The Hundred's run rates are per six legal balls.) Left: the WPL and WBBL first innings sit 3-4 runs under the real ones
(the WPL's targets are pulled a little toward the lower-scoring pool), all-out shares are a point or three high, and the
spread of totals is narrow in every league (see 12.8).

### 12.8 The spread of innings totals: the IPL's shape and match conditions

Simulated totals were too even. T20Is between full members had a first-innings standard deviation of 24 against a real 37,
the men's leagues were 3-13 runs short, and 200 came up too rarely. A first version (a symmetric day multiplier) matched
the standard deviations but made the low tail far too heavy (IPL under 120: 6.6% to 9.2%). This is the revision.

**The real shape** (`packages/ratings/src/analysis/t20-spread.py`, `docs/data/t20_spread.json`). Each league's first
innings since 2021 are centred on their season's mean, because seasons drift by up to 30 runs (the IPL from about 160
in 2021 to 190 in 2024-25) and the engine plays one era. Centred, real totals are not right-skewed. The IPL's are close
to symmetric (skew -0.14; 10th / 90th percentile -41 / +43), as are the other leagues' (skew -0.4 to +0.3). The raw
right tail was the seasons' drift. So the engine is compared with the real shape at the engine's own league mean: sd,
the 10th / 25th / 50th / 75th / 90th percentiles of the deviation, and the 200+ and under-120 shares that shape gives at
the engine's mean (The Hundred: 167+ / under 100). The means are the league calibration's and stay as they are.

**The low tail is the engine's collapses, most of all in the IPL.** With no term, IPL first innings were all out 27%
of the time against a real 7.7%, and nearly all of the engine's under-120 innings were all-outs. Against the real IPL
since 2023, by phase and wickets down, the engine's powerplay wicket rate was 37% too high and its middle-overs rate 24%
too high. Its powerplay was a run an over too fast and its middle overs 1.7 an over too slow, and it barely slowed down
after early wickets (the real middle-overs rate falls from 9.7 an over at 0-2 down to 7.1 at 5-6 down; the engine's
from 8.0 to 7.3). The other men's leagues' wickets per innings already sit near their real ones (`LEAGUE_LEVELS` fits
them), and their all-out excess is smaller (17-21% against 11-19%).

**The IPL's shape** (`mens-league-context-data.ts`, read through `scoring-context.ts`; fitted by
`calibrate-contexts.test.ts`, `CALIBRATE_MEN=1`). The IPL now has a scoring context like the women's leagues', fitted on
its matches since 2024 (211), but at the engine's own scoring level. The real run-class shares are scaled together (by
0.93) so the mean first innings stays where it was (177.0 against 176.7). Wickets per innings 7.33 to 6.38 (real 6.35),
all out 27.9% to 13.8% (real 9.0%), run rate by phase 10.56 / 7.70 / 10.51 to 8.87 / 8.48 / 10.22 (real 9.54 / 8.97 /
11.24, at 0.93 of the level). The other men's leagues stay on the league tables. A shape fitted to them (`CAL_ONLY`)
leaves their all-outs where they are and narrows their totals.

**The conditions term** (`match-conditions.ts`, both engines). Each T20 and Hundred match draws a run multiplier on the
scoring classes, shared by both innings, like the Test engine's match conditions. Its log is two-piece normal: sd `lo`
below a centre and `hi` above it, so it can be skewed. The shape `hi / lo` is pooled over the men's leagues; the scale
and the centre are per league (`match-conditions-data.ts`, fitted by `calibrate-spread.test.ts`, `CAL_FIT=1`).
- Each men's league is played at a grid of fixed multipliers (log -0.6 to +0.8, 800 matches each). A candidate term's
  totals are the grid mixture weighted by its density.
- The pooled shape and each league's scale minimise the squared distance of the five percentiles plus four times that of
  the two shares, in points.
- Each centre is then set on 5,000 drawn matches so the mean first innings equals the one without a term.
- The fitted shape is `hi = 2 lo` (refitted to `lo = 2 hi` with the wickets-in-hand table, 12.9), a mild right skew that
  offsets the engine's own left tail. A league fitting better
  with none keeps none (the BBL). Other men's T20s, T20Is included, use the median league's. The women get none: the
  first version's small fitted term (0.037) changed nothing, and their real match term (7.9) is the engine's own (6.5).

First innings, 1,500 instant matches a league, the game's own squads: mean (sd); deviation from the mean at the 10th /
50th / 90th percentile; 200+; under 120. "Real" is the season-centred real shape at the engine's mean; "before" is no
IPL shape and no term; "after" is this version.

| league | real | before | after |
|---|---|---|---|
| IPL | (33.9) -41 / 0 / +43; 22.4%; 4.3% | 175.6 (32.3) -45 / +4 / +36; 21.3%; 6.6% | 175.0 (33.0) -42 / +1 / +42; 21.7%; 5.2% |
| BBL | (29.5) -35 / -3 / +38; 11.3%; 4.2% | 165.5 (27.8) -35 / +3 / +34; 9.7%; 6.2% | no term: as before |
| PSL | (33.3) -44 / +3 / +40; 21.3%; 5.8% | 178.1 (30.3) -38 / +3 / +36; 23.3%; 3.8% | 176.4 (31.7) -41 / +3 / +39; 22.9%; 5.4% |
| SA20 | (38.6) -47 / -1 / +51; 12.7%; 14.4% | 159.7 (25.6) -33 / +1 / +31; 4.9%; 6.9% | 158.0 (34.7) -46 / +1 / +43; 10.6%; 13.2% |
| CPL | (32.4) -38 / -1 / +42; 15.9%; 4.9% | 171.9 (26.8) -34 / +2 / +32; 13.3%; 4.2% | 171.3 (31.6) -40 / +2 / +38; 17.5%; 5.9% |
| ILT20 | (30.3) -38 / +2 / +30; 6.1%; 9.8% | 159.7 (26.7) -31 / +1 / +32; 5.3%; 7.1% | 159.6 (27.2) -37 / +1 / +31; 5.9%; 7.7% |
| MLC | (34.4) -40 / 0 / +45; 19.4%; 5.8% | 174.4 (27.4) -35 / +3 / +34; 17.0%; 3.5% | 172.7 (31.9) -41 / +1 / +38; 18.7%; 6.3% |
| BPL | (32.1) -40 / 0 / +35; 5.9%; 10.9% | 159.1 (26.3) -33 / +2 / +31; 5.3%; 7.1% | 157.3 (30.0) -38 / +2 / +37; 7.3%; 10.1% |
| LPL | (31.8) -39 / +4 / +39; 21.6%; 6.3% | 178.1 (29.4) -37 / +3 / +35; 22.9%; 4.3% | 176.1 (31.9) -41 / +3 / +39; 22.5%; 5.3% |
| Hundred men | (27.4) -37 / -1 / +34; 20.0%; 6.3% | 144.0 (23.6) -29 / 0 / +29; 16.5%; 3.3% | 143.5 (27.1) -35 / 0 / +33; 20.3%; 6.1% |

The "after" means differ from "before" by up to 2 runs on these 1,500 matches: noise. On 5,000 matches the IPL is 177.0
with neither change and 177.2 with both. The IPL now matches its real shape within a point on 200+ and a run on the sd
and the 90th percentile. Under 120 is 5.2% against 4.3%, and all out 16.6% against 7.7% (27% before). Left over:
- BBL, ILT20 and BPL are still a couple of points heavy below the median, from collapses (all out 18% against 11-15%)
  that their shapes do not touch.
- SA20 and MLC are still short of spread (real sd 38.6 and 34.4).
- The IPL's match term in the first ten overs is now 87 against a real 104. Other leagues' terms come out at 23-106
  against real 18-146: the scales are fitted to the totals, not to that term.
- T20I men (fixture replays): 167.2 (26.3) against a real 169.5 (37.3). The default term; the rest is grounds and how far
  apart the sides are (see 12.7 for the women).
- The live engine follows: IPL live CPU 172.3 runs an innings against instant 169.7 (400 matches; 1.4 runs of noise each).
- The IPL's extras follow the real league's per-ball rates: 9.1 an innings with the game's squads against the real 8.9.

Fingerprint: the men's T20 lines and the Hundred line move; the women's line does not. Instant men `48ec01dbb07dbc66`, men
with rain `a4b19bc607589f48`, women `7d214ad967890a1c`, Hundred `35656ed4f9692502`; live CPU `c6092d833b2d11a6`, user
`b8cea85a7ee08af0`; combined `efa2366c3cb4e486`.

### 12.9 Collapses: how sides bat by wickets in hand

After 12.8 the engine still bowled sides out too often: IPL first innings 16.6% against a real 7.7%; BBL, PSL, ILT20 and
LPL 18-21% against 11-14%. The engine also barely slowed down after early wickets. Real sides consolidate (fewer
boundaries, fewer wickets, more singles) and accelerate late with wickets in hand; the engine's batters played the same
way at any score.

**The table** (`packages/ratings/src/analysis/t20-wickets-in-hand.py`; `docs/data/t20_wickets_in_hand.json`, generated
`wickets-in-hand-data.ts`). First innings of the men's T20 leagues since 2021 (IPL, BBL, PSL, SA20, CPL, ILT20, MLC, BPL,
LPL) and the women's (WPL, WBBL), full matches. Each outcome class's rate is fitted by iterative proportional fitting:

  league-season level by over band × state (over band × wickets down) × batter × bowler

The batter and bowler terms hold who is at the crease fixed. A side seven down has its tail in; that is the batters, not
the situation, and the engine already has its tail-enders through their ratings. The batter shrinkage is light (5
pseudo-events), so a tail-ender's own few balls set his effect. With 20, the eight-down death cells came out about 0.07
lower: tail quality leaking into the state term. The state term is normalised to a mean of 1 within each over band, so
it only moves rates between states. Over bands: overs 1-6, 7-11, 12-15, 16-18, 19-20; wickets down 0 to 7, 8+.

Men, selected cells (fours / sixes / wickets, relative to the band's mean):
- **Overs 7-11:** none down 1.16 / 1.54 / 1.21; four down 0.83 / 0.60 / 0.82 (consolidation).
- **Overs 16-18:** two down 1.16 / 1.25 / 1.15; eight or more down 0.68 / 0.57 / 0.82 (the late push needs wickets in hand).

The women's table has the same shape, milder.

**In the engine** (`wickets-in-hand.ts`, the instant chain the live engine follows). Every T20 and Hundred first innings
multiplies each class by the table's cell raised to the competition's power, times a factor per band and class that keeps
the competition's phase rates and mean first innings where they were (`wickets-in-hand-norm-data.ts`, fitted by
`packages/app/src/__tests__/calibrate-collapses.test.ts`). A chase already has its own wickets-down terms
(`chaseAdjustment`), and the ODI has its own model, so neither uses the table.
- **The power** per competition is chosen from 0 (none), 0.5, 0.75 and 1 on 2,500 matches each. It is the one whose
  all-out share and under-120 and 200+ shares (at the engine's mean) are nearest the real league's; a spread above the
  real one counts as a miss.
- **Fitted powers:** IPL 1, BBL 0.5, PSL 0.5, SA20 1, men's Hundred 0.75, CPL 0.75, ILT20 0.5, MLC 0.5, BPL 0.75, LPL 0.5,
  T20I men 1; WPL 1, WBBL 0.75, women's Hundred 1, T20I women 1. Other competitions use their gender's default (the median
  power).
- **Women:** they had the same all-out gap (WBBL 20% against 12%), so they are included.

The match conditions (12.8) were refitted on top. The table now supplies most of the spread, so the term is small: IPL sd
0.11 below the centre and 0.055 above, SA20 0.27 / 0.135, the others 0.02-0.08, pooled shape `lo = 2 hi`.

First innings, 1,500 instant matches a league, the game's own squads. Columns: all out; wickets; under 120; 200+; sd. The
Hundred uses under 100 / 167+. Real: all out since 2021, wickets since 2024, the shares from the season-centred real shape
at the engine's mean, the centred sd. Before is main as of 12.8; after is with the table and the refitted conditions.

| league | real | before | after |
|---|---|---|---|
| IPL | 7.7%; 6.35; 3.6%; 25.0%; 33.9 | 16.6%; 6.37; 5.2%; 21.7%; 33.0 | 12.4%; 6.41; 4.6%; 25.6%; 33.4 |
| BBL | 11.3%; 7.13; 3.4%; 11.7%; 29.5 | 18.1%; 6.82; 6.2%; 9.7%; 27.8 | 15.5%; 6.78; 7.5%; 12.8%; 30.3 |
| PSL | 11.6%; 6.61; 5.8%; 21.3%; 33.3 | 21.5%; 6.88; 5.4%; 22.9%; 31.7 | 17.3%; 6.78; 5.8%; 23.0%; 32.5 |
| SA20 | 15.3%; 6.38; 14.4%; 12.7%; 38.6 | 15.4%; 6.46; 13.2%; 10.6%; 34.7 | 10.8%; 6.42; 14.4%; 12.5%; 36.0 |
| CPL | 12.1%; 6.83; 5.5%; 15.9%; 32.4 | 14.7%; 6.27; 5.9%; 17.5%; 31.6 | 12.1%; 6.51; 6.3%; 16.4%; 31.1 |
| ILT20 | 10.6%; 6.66; 8.3%; 6.8%; 30.3 | 17.7%; 6.66; 7.7%; 5.9%; 27.2 | 12.3%; 6.50; 8.9%; 9.2%; 30.1 |
| MLC | 18.4%; 6.99; 4.9%; 19.4%; 34.4 | 18.5%; 6.77; 6.3%; 18.7%; 31.9 | 17.5%; 6.88; 6.1%; 19.6%; 31.9 |
| BPL | 14.9%; 6.78; 10.9%; 5.9%; 32.1 | 18.3%; 6.68; 10.1%; 7.3%; 30.0 | 13.5%; 6.67; 10.1%; 6.7%; 30.5 |
| LPL | 13.5%; 6.87; 6.3%; 21.6%; 31.8 | 20.7%; 6.95; 5.3%; 22.5%; 31.9 | 16.9%; 6.84; 5.7%; 23.7%; 32.8 |
| Hundred men | 8.4%; 6.56; 5.8%; 20.5%; 27.4 | 11.9%; 6.13; 6.1%; 20.3%; 27.1 | 9.3%; 6.25; 5.7%; 20.3%; 27.4 |
| WPL | 14.8%; 6.79; 12.5%; 9.1%; 30.6 | 15.7%; 6.54; 5.2%; 3.0%; 23.6 | 15.5%; 6.49; 7.7%; 4.7%; 26.4 |
| WBBL | 12.1%; 6.92; 14.3%; 3.0%; 28.1 | 20.3%; 6.82; 8.4%; 1.3%; 22.7 | 17.4%; 6.65; 10.5%; 1.5%; 24.7 |
| Hundred women | 9.4%; 6.53; 10.5%; 4.4%; 23.6 | 10.9%; 6.05; 7.1%; 1.0%; 18.5 | 8.0%; 6.04; 5.9%; 1.9%; 19.3 |

- **All-outs** come down in every league, by 2-6 points; IPL 16.6% to 12.4%, BPL 18.3% to 13.5%, ILT20 17.7% to 12.3%.
  On 5,000 matches: IPL 17.6% to 11.0%, BBL 18.8% to 15.7%, PSL 21.2% to 16.7%, WBBL 19.2% to 16.6%.
- **Wickets per innings** barely move, because the table moves wickets between states, not their number.
- **Means** stay within the noise of the game's squads: on 5,000 matches, IPL 175.4 to 177.4, the others within 1.6 runs.
  New squads are drawn for each run, and that alone moves a mean by about 2.
- **SD** moves toward the real one in most leagues.
- **The low tail** is where it was: IPL under 120 is 4.6%, the BBL's still 7.5% against 3.4%.

Left over:
- The IPL is still bowled out 12% of the time against 7.7% with the right wickets per innings. Its wickets are more
  bunched by innings than the real ones; the table moves how a side bats after wickets, not how often they cluster.
- BBL, PSL and LPL are still 4-5 points high on all-outs.
- The women's spreads stay narrow (12.7).
- The table is fitted on first innings only.

Fingerprint: every line moves, the women's too (the women's table and default factors). Instant men `c3ec93bf630671cb`,
men with rain `c7eb7766f258c4a9`, women `bc0c2eaf9dd01cf8`, Hundred `85a482996e20d465`; live CPU `81b3d54bfe0ed362`, user
`b12b68652253c070`; combined `fa1132e42d640731`.

### 12.10 Wicket clustering: new batters play themselves in

After 12.9 the IPL's first innings were still bowled out 12% of the time against a real 7.7%, though wickets per innings
were right. The wickets came too close together.

**What was measured** (first innings, IPL 2023+ real against 2,000 engine matches with the game's squads):
- **Gap between wickets:** 6 legal balls or fewer 29.1% real, 32.8% engine.
- **Opening stand:** 25.0 balls real, 20.5 engine.
- **Eighth-wicket stand:** 6.4 real, 9.5 engine.
- **Dismissal hazard by the striker's balls faced:** the decisive one.

| balls faced | 0 | 1-2 | 3-5 | 6-9 | 10-19 | 20-29 | 30+ |
|---|---|---|---|---|---|---|---|
| real | 4.4% | 3.9% | 4.6% | 5.1% | 5.0% | 5.4% | 7.2% |
| engine before | 5.2% | 5.3% | 4.9% | 5.1% | 5.1% | 5.4% | 5.8% |
| engine after | 3.6% | 4.2% | 4.7% | 5.1% | 5.4% | 5.6% | 6.8% |

Real new batters are the safest batters on the field and set ones the most exposed. The engine's hazard was flat, so a
wicket brought in a batter as likely to fall at once as a set one, and wickets bunched. The two other candidates show
nothing to fix. The engine's hazard by batting position rises smoothly from 4.7% (openers) to 8% (the tail), with no
weak batter placed high; the order is the team's own. The T20 chain has no bowler-streak or pressure term (only the
clutch window late in a close chase).

**The term.** The wickets-in-hand fit (12.9) now also carries a set term: the striker's balls faced before the ball (0,
1-2, 3-5, 6-9, 10-19, 20-29, 30+), with the situation, the batter and the bowler held fixed, mean 1 over the real
deliveries (`WICKETS_IN_HAND_SET`). Men's wickets run 0.67 / 0.79 / 0.93 / 1.03 / 1.06 / 1.11 / 1.23; fours 0.59 to 1.19;
sixes 0.26 to 1.30. A new batter plays himself in and a set one takes risks. Women's are similar. It applies in full
wherever the table does (first innings). The powers and factors and the match conditions were all refitted on top. Powers:
IPL 1, SA20 1, T20I men 1, WPL 1, WBBL 1, T20I women 1, women's Hundred 0.75, BBL / PSL / ILT20 / BPL / LPL / men's Hundred
0.5. CPL and MLC fit best with neither the table nor the set term. The conditions came out one-sided: a day can only be
better than the centre.

**IPL first innings after:** all out 8.2% on 4,000 matches (real 7.7%). Wickets within 6 balls of the last 29.8% (real
29.1%). Wickets per innings 2 to 10 come within two points of the real distribution in every bin (6 down: 19.1% against
16.3%). Opening stand 20.4 balls (real 25.0): still short.

Per league, 1,500 matches each. Columns: all out; wickets; under 120; 200+; sd. Real as in 12.9; before is main as of
12.9.

| league | real | before | after |
|---|---|---|---|
| IPL | 7.7%; 6.35; 3.6%; 25.0%; 33.9 | 12.4%; 6.41; 4.6%; 25.6%; 33.4 | 9.9%; 6.33; 5.1%; 26.3%; 34.1 |
| BBL | 11.3%; 7.13; 3.8%; 11.3%; 29.5 | 15.5%; 6.78; 7.5%; 12.8%; 30.3 | 12.7%; 6.80; 8.0%; 14.3%; 32.3 |
| PSL | 11.6%; 6.61; 5.3%; 21.3%; 33.3 | 17.3%; 6.78; 5.8%; 23.0%; 32.5 | 16.8%; 6.96; 6.3%; 26.7%; 35.3 |
| SA20 | 15.3%; 6.38; 14.4%; 12.7%; 38.6 | 10.8%; 6.42; 14.4%; 12.5%; 36.0 | 8.2%; 6.23; 15.3%; 12.5%; 37.4 |
| CPL | 12.1%; 6.83; 4.9%; 17.0%; 32.4 | 12.1%; 6.51; 6.3%; 16.4%; 31.1 | 13.3%; 6.22; 5.0%; 17.5%; 30.1 |
| ILT20 | 10.6%; 6.66; 8.3%; 6.8%; 30.3 | 12.3%; 6.50; 8.9%; 9.2%; 30.1 | 12.3%; 6.62; 9.0%; 8.8%; 29.7 |
| MLC | 18.4%; 6.99; 2.9%; 19.4%; 34.4 | 17.5%; 6.88; 6.1%; 19.6%; 31.9 | 17.9%; 6.58; 5.1%; 20.7%; 31.2 |
| BPL | 14.9%; 6.78; 10.9%; 6.4%; 32.1 | 13.5%; 6.67; 10.1%; 6.7%; 30.5 | 12.1%; 6.68; 11.0%; 8.8%; 31.4 |
| LPL | 13.5%; 6.87; 6.3%; 21.6%; 31.8 | 16.9%; 6.84; 5.7%; 23.7%; 32.8 | 14.8%; 6.92; 5.0%; 25.7%; 34.2 |
| Hundred men | 8.4%; 6.56; 5.8%; 20.5%; 27.4 | 9.3%; 6.25; 5.7%; 20.3%; 27.4 | 8.4%; 6.24; 6.1%; 21.3%; 28.4 |
| WPL | 14.8%; 6.79; 11.4%; 10.2%; 30.6 | 15.5%; 6.49; 7.7%; 4.7%; 26.4 | 12.2%; 6.50; 6.7%; 5.9%; 26.1 |
| WBBL | 12.1%; 6.92; 13.4%; 3.9%; 28.1 | 17.4%; 6.65; 10.5%; 1.5%; 24.7 | 14.9%; 6.57; 10.4%; 3.1%; 25.7 |
| Hundred women | 9.4%; 6.53; 11.0%; 3.9%; 23.6 | 8.0%; 6.04; 5.9%; 1.9%; 19.3 | 8.1%; 6.03; 7.1%; 1.9%; 19.6 |

Most leagues come down another 1-3 points of all-outs, and the women's spreads widen a little. Left over:
- PSL, LPL and BBL now have spreads 2-3 runs above the real ones, even with no or almost no conditions term. The set
  term's late acceleration widens totals there.
- ~~SA20 is now bowled out less often than the real one (8% against 15%).~~ Fixed in 12.11.

**Chases (measured, not changed).** The men's leagues since 2021, second innings, against 400 engine matches a league.
Hazard by phase and wickets down already follows the real one: middle overs 0-2 down 4.8% against 4.6%, 5-6 down 6.4%
against 6.3%, 7-9 down 7.7% against 7.3%; death overs within a point. Real chasers do not consolidate the way first-innings
sides do (their hazard rises with wickets down), and the engine's `chaseAdjustment` already plays it that way. Chases are
all out 19.1% (engine) against 18.1% (real). Extending the table to chases would double-count the chase terms, so it
stays first-innings only. The chase gaps that remain are phase rates (powerplay 9.7 an over against 8.4, middle overs 7.3
against 8.4, in the leagues without a shape); those are league levels, not collapses.

Fingerprint: every line moves. Instant men `fb77411d4def97b1`, men with rain `fcd1034152f2d622`, women `a620d4744798119a`,
Hundred `19c5499b6b2e0689`; live CPU `affd24e1d22c9d81`, user `253902f78c7f51a5`; combined `8323aef815cac7df`.

### 12.11 SA20 all-outs: no table, a wider conditions term

After 12.10 the SA20 was bowled out in 8% of first innings against a real 15.3% (wickets 6.23 against 6.38). Played with no
wickets-in-hand table the SA20 is bowled out 14.3% of the time (6.47 wickets): the table (and the set term with it) takes the
collapses out, at any power (0.25: 9.2%, 0.5: 9.6%, 0.75: 7.8%, 1: 7.0%). It had been chosen because its loss, measured with the
conditions term off, rewarded the spread the table adds (200+ 5.4% to 10.4%); the conditions term supplies that spread, and unlike
the table leaves the collapses alone. So the SA20 now has power 0 (no table) and its conditions refitted (grid log -0.6 to +1.0,
shapes `hi / lo` 0.5 to 6): `lo` 0.09, `hi` 0.54, centre -0.357 (was `hi` 0.3).

First innings, 3,500 matches, the game's squads: all out; wickets; under 120; 200+; sd.

| SA20 | all out | wickets | under 120 | 200+ | sd |
|---|---|---|---|---|---|
| real | 15.3% | 6.38 | 13.6% | 14.4% | 38.6 |
| before (12.10) | 8.2% | 6.23 | 15.3% | 12.5% | 37.4 |
| after | 15.5% | 6.32 | 14.1% | 14.6% | 38.1 |

The other leagues are untouched (the men's / women's T20 and Hundred fingerprints, which do not play the SA20, are unchanged).

---

## 13. Rain and DLS, DRS, fielding errors and the rarer plays

Second pass over both engines (`match.ts` instant, `live-match.ts` live viewer). New shared modules: `dls.ts` (rewritten), `drs.ts`,
`special-plays.ts`; the fielding errors live in `fielding.ts`. New rates are fitted by `packages/ratings/src/analysis/match-rules-extra.py`
into `packages/engine/src/match-rules-extra-data.ts` (report without commentary excerpts: `docs/data/match_rules_extra.json`). Inputs: the
Cricsheet parquet tables (rain, extras), the raw Cricsheet JSON for the `review` records (`CRICSHEET_JSON_DIR`, downloaded from
cricsheet.org: IPL, WPL, BBL, WBBL, PSL, CPL, SA20, ILT20, MLC, Hundred, BPL, LPL, T20Is) and the ESPNcricinfo ball-by-ball commentary of IPL
2025-26 (76 matches, 17,587 balls; its structured `DROPPED_CATCH` / `RUN_OUT_CHANCE` / `STUMPING_CHANCE` events and text regexes, hand-checked).
Run from `packages/ratings`: `CRICSHEET_JSON_DIR=/path/to/json python3 -I src/analysis/match-rules-extra.py`.

### 13.1 Audit table

`I` = instant engine, `L` = live engine. "Before" is the branch point (2a262f1).

| Situation | Before | After | Rate / source |
|---|---|---|---|
| **Fielding errors** (item 8) | | | |
| dropped catch | I, L: chance put down at 18% (assumed); ball resampled from the whole outcome mix (a ring drop could be a six); line in the commentary only. L: not on the raw ball log, so no stats; live matches credited no catches at all | I, L: drop share 20.9% for an average fielder, moved by the catcher's `fielding` (keeper: `keeping`); a deep (rope) drop goes 6 / 4 / 1 / 2 (20 / 15 / 40 / 25%), a ring drop dot / 1 / 2, a keeper's drop dot / 1 / 4 (off the gloves) / 2; batter survives; `fieldingNote`, `fielderId`, `deepChance` on the ball (both engines); deep-drop lines | 180 drops v 682 catches (commentary events), CricViz T20 catch efficiency 75-80% |
| missed stumping | I, L (assumed 10%) | I, L: 16.7% of stumping chances, keeper's `keeping` drives it; dot or single | 2 v 12 (thin, Jeffreys) |
| run-out chance missed | I, L (assumed 25%) | I, L: 60% of run-out chances (Cricinfo tags every missed direct-hit chance); the runs are completed (1 / 2 / 3); fielding rating drives it | 62 v 41 |
| drops in the scorecard | no | I, L: batting row "dropped on 23 (Jadeja)", "missed stumping on 12 (Pant)", "run out chance missed on 4" (`BatterInnings.lives`); shown in the match page and the live scorecard | |
| drops in the stats | no | I, L: `PlayerStats.drops`, `missedStumpings`, `missedRunOuts`, `misfields` (player page: Ct, St, RO, Drops); live matches now also credit catches, stumpings and run outs | |
| misfield (a run or the four given away) | no | I, L: label on 1 / 2 / 3 / 4 balls (runs unchanged: the base model's runs already contain them), weaker fielders and weaker sides fumble more; fielder named, stats | 0.76% of deliveries, 32% to the boundary (commentary) |
| catch on the boundary rope | no | I, L: `boundaryCatch` (47.5% of outfield catches), corpus lines filtered to deep catches, hand-written fallback | commentary, 0.91 precision |
| relay catch | no | I, L: one fielder parries, the other completes it (credited); `fielder2Id` | 0.46% of boundary catches (1 in 321, Jeffreys) |
| six saved on the rope | no | I, L: a hit for six palmed back, 1 or 2 run (six weight raised by 1/(1-share) so sixes stay at the base rate) | 0.41% of six-bound hits (6 of 1,442; low confidence) |
| **Running and dead balls** | | | |
| short run (item 1) | no | I, L: "one short", a run off the bat not counted; the batters still change ends by what they ran | none signalled in 17,587 balls: Jeffreys 2.8e-5 per delivery (~0.003 an innings) |
| ball lodged in helmet / pads (dead ball) | no | I, L: legal ball, nothing scored, dead-ball line | 1 in 17,587 (Jeffreys 8.5e-5) |
| ball hits the keeper's helmet on the ground (5 penalty) | I, L: penalty runs without a reason | I, L: penalty reason drawn: helmet 60% / illegal fielding 30% / other 10% (assumption; Laws 28.3, 41.5), each with its line | 1.4e-5 per delivery (Cricsheet) |
| **Bowling** | | | |
| no-ball reason | I, L: random wording ("overstepped" / "high full toss") | I, L: `noBallKind` front foot 62.6% / height 35.3% / fielding restriction 2.2%, the line says which | 68 no-balls in the commentary |
| beamer, warning, removal | no | I, L: beamers are height no-balls (1.05e-3 per delivery); first: warning; second in the innings: the bowler is removed from the attack (Law 41.7), another bowler finishes the over (L: the user picks when it is his side) | 17 beamers |
| leg-side wide | I, L (section 12: wide kinds off / leg / height) | unchanged | 36.7% of wides |
| slow over-rate restriction (item 2) | no | I, L: drawn per innings: 7.9% of innings, from the last over (75%), the last two (17%) or the last four (8%); in those overs one more fielder inside the circle: fours x1.10, sixes x1.04, dots x0.97; announced in the commentary; `overRatePenalty` on the balls | commentary IPL 2025-26: 12 of 151 innings; effect sizes an assumption |
| mid-over bowler injury | I, L automatic | I unchanged; L: the user picks who finishes the over (same panel as an over's start, "Who finishes the over?") | |
| no consecutive overs | I: fixed on main (another XI player bowls first) | L: the same (`ensureFreshBowlerOption`) | |
| **Batting** | | | |
| retired hurt returning | I, L automatic (return 0.2%) | L: on the user's side the user decides whether a retired-hurt batter resumes (or ends the innings when nobody else is left); CPU unchanged | |
| striker run out on a free hit | I, L (section 12) | unchanged | |
| **Umpiring** | | | |
| DRS lbw (item 4) | L: 20% of lbw given out auto-overturned (it removed wickets); not-out appeals on 8% of dots; I: none | I, L: fitted model (13.4), umpire's call keeps the review, two reviews per side per innings (one in a super over), reset each innings | Cricsheet: 6,679 reviews |
| DRS caught behind | no | I, L: batting reviews of a keeper catch given out; fielding reviews of a not-out caught-behind appeal; UltraEdge lines | 95% of reviewed catches are the keeper's |
| wrong decision with no review left | no | I, L: a wrong out stands (a wicket), an out given not out stands (no wicket) | |
| DRS for wides / no-balls / run outs | L | L unchanged (live only) | |
| **Match** | | | |
| rain, DLS, no result in the instant sim (item 3) | no | I: per league p(no result), p(reduced) (13.3); DLS par / revised target; a point each and out of the NRR for a no result; DLS NRR | Cricsheet 4,696 league matches |
| DLS resource table | made-up parameters | I, L: the Standard Edition model fitted to the published table | 40 published cells, rms 0.03 |
| washed-out knockout | n/a | I, L: the higher-placed (home) side goes through | IPL playing conditions |
| The Hundred: ends (item 6) | ends changed every set of five | I: every ten balls (strike carries across a set boundary inside a ten) | Hundred playing conditions |
| women's extras (item 5) | men's base rates | I, L: scaled to the women's per-delivery rates of the women's T20 leagues since 2019: wides x0.894, no-balls x0.974, byes / leg byes x0.918 | 145,917 women's deliveries; women's T20Is excluded (associate nations double the wide rate) |
| strategic timeout | L (bowling side overs 6-9, batting 13-16, user choice, small rating boost) | I: IPL innings record the two timeouts (after overs 7 and 14) without an effect; L unchanged | IPL playing conditions |
| impact player | I, L | unchanged | |
| super overs in the viewer (item 7) | played but not shown (the result text only) | L: the result panel lists every super over: side, three batters v bowler, each ball, score | |
| **Not added** | | | |
| bouncers per over (a third is a no-ball), concussion substitutes, the ICC stop clock (T20Is only), batters deliberately running on the pitch (5 penalty against the batting side), the live Hundred | | | see 13.8 |

### 13.2 How the plays fit on a delivery

`simulateBall` (instant) and `runOneBall` (live) now do, after the base model: women's extras factor; the over-rate factor; the fielding chance
resolution (drops by where the chance went); DRS (`applyDrs` in the instant engine, the review block of `stepBall` in the live one); `expandDelivery`;
then `applySpecialPlays` (no-ball and penalty reasons, beamers, boundary / relay catches, six saved, misfield, short run, lodged ball). Labels (misfield,
boundary catch, reasons) never change the runs, so the scores stay on the base model; a short run takes one off, a six saved turns six into one or two (and
the six weight is raised to keep the sixes that clear the rope at the base rate). A chance that was put down only gets the labels.

New optional `BallEvent` fields: `noBallKind`, `beamer`, `penaltyReason`, `shortRun`, `lodged`, `boundaryCatch`, `deepChance`, `review`,
`overRatePenalty`; `fieldingNote` gained `misfield` and `six_saved`. `InningsScore`: `overRatePenaltyFrom`, `drsLeft`, `timeouts`, `scheduledOvers`,
`dlsTarget`, `suspendedBowlers`. `MatchResult.rain`. Old logs load unchanged. Instant matches' lazily generated commentary (`instant-commentary.ts`)
carries the new facts in its cues and keeps the play lines.

Test hooks (`setRuleOverrides`): `shortRunPerDelivery`, `lodgedPerDelivery`, `misfieldPerDelivery`, `sixSavedShare`, `boundaryCatchShare`,
`relayCatchShare`, `forceBeamer`, `noBallRateFactor`, `overRatePenaltyPerInnings`, `rainNoResult`, `rainReduced`, `drsRateFactor`,
`forceCoarseOutcome` (with `forceOutcomeSparesSuperOver`: a forced tie, then real super overs).

### 13.3 Rain, DLS and no result

**Rates** (per match, shrunk towards the pooled 13 leagues with 20 pseudo-matches; Cricsheet leaves out matches abandoned without a ball, so p(no result)
is a lower bound):

| league | matches | p(no result) | p(reduced, a result) |
|---|---|---|---|
| IPL | 1,243 | 0.74% | 2.68% |
| WPL | 88 | 0.27% | 0.76% |
| BBL | 662 | 1.66% | 5.99% |
| WBBL | 527 | 3.16% | 7.28% |
| PSL | 357 | 0.87% | 3.14% |
| SA20 | 130 | 4.86% | 3.88% |
| Hundred (men / women) | 201 / 188 | 3.30% / 1.10% | 2.63% / 2.80% |
| CPL | 445 | 1.57% | 7.70% |
| ILT20 / MLC / BPL / LPL | 134 / 109 / 469 / 143 | 0.84% / 1.00% / 0.06% / 2.02% | 1.18% / 5.29% / 0.78% / 6.64% |

A reduced match is cut before the start (54%: both sides get N overs), during the first innings (12%: the first innings stops at over s, is cut to N
overs, the chase gets N overs and a DLS target) or during the chase (34%: at over s with w down the chase is cut to N overs and the target revised); N
follows the data (5-19 overs, roughly flat). A no result is abandoned in the first innings, or in the chase before the five overs a result needs.

**DLS.** `dls.ts` uses the Duckworth-Lewis model behind the Standard Edition table, Z(u, w) = Z0 F(w) [1 - exp(-b u / F(w))], with b = 0.0274093
and F(w) = 1, 0.885, 0.760, 0.630, 0.500, 0.375, 0.262, 0.164, 0.089, 0.035 fitted to the published Standard Edition values (the 50, 40, 30, 25, 20,
10 and 5 overs-left rows at 0 / 2 / 5 / 7 / 9 down, and the whole 50-overs row: 100, 93.4, 85.1, 74.9, 62.7, 49.0, 34.9, 22.0, 11.9, 4.7); it reproduces
all of them to 0.1 (rms 0.03). A T20 is the bottom of the table rescaled so 20 overs = 100% (e.g. 10 overs, none down = 56.7%); The Hundred counts
balls / 6. Target: R2 < R1: floor(S R2 / R1) + 1; R2 >= R1: floor(S + G (R2 - R1) / 100) + 1 with G = 160 (x the league's scoring multiplier, x 100/120
in The Hundred). The live engine's rain (its own checks, unchanged) now uses these resources too.

**Results and tables.** A DLS win reads "by 12 runs (DLS method)"; a tie on DLS goes to a super over. A no result is a point each (`ties`, which the
standings already counted as tie / NR) and is left out of the NRR. When DLS revised the target, the side batting first is credited with the target minus
one off the overs the chase was given (ICC NRR rule); each side is charged the overs it had. A knockout cannot end without a winner: the higher-placed side
(the home side of this game's playoff fixtures) goes through. Rain is on for every league and playoff match the season engine plays (`schedule.ts` passes `MatchOptions.rain`); a direct
`simulateMatch` call (tests, benchmarks) plays a full match unless it asks for rain, so innings compare like for like. With rain on, 60,000 IPL matches had 2.7% shortened and 0.72% no results, as fitted.

### 13.4 DRS

From 6,679 Cricsheet reviews in 3,042 matches with reviews recorded: 1.10 reviews an innings (both sides), 38.7% by the batting side. Batting side, given
out: lbw 91.5% / caught 8.5% of its reviews; overturned 34.5%, umpire's call 17.8% (lbw; none for catches), the rest struck down. Fielding side, given not
out: lbw 59.8% / caught 40.2%; overturned 20.4% (lbw) / 25.9% (caught), umpire's call 21.3% (lbw). 95% of reviewed catches are the keeper's, so
"caught" reviews are caught behind (catches by the keeper). Overturned batting reviews and struck-down fielding reviews carry no dismissal kind in Cricsheet;
they are split by the kinds of the others.

`drs.ts` turns these into per-ball rates with the engine's average lbw (0.5) and keeper-catch (0.7) wickets an innings:
- a drawn lbw / keeper-catch wicket was given not out and overturned on the fielding side's review (lbw 16% of them, caught behind 10%); with no review
  left the batter survives (a dot);
- otherwise the batting side may review it (struck down, or umpire's call which keeps the review);
- on a dot ball (not a free hit): a wrong out decision overturned on the batting side's review (with no review left it stands: a wicket), or a fielding-side
  review of a not-out that fails (struck down / umpire's call).
Only a struck-down review is lost; two per side per innings (one in a super over), reset at the innings break (the live engine had kept the count over
both innings). The live viewer asks the user on his side's decisions: "Given out LBW / caught behind!" (review or walk; a wrong decision not reviewed is a
wicket), "LBW / caught-behind appeal!" (review or accept); fast-forward reviews what the CPU would. The old live-only reviews of wides, no-balls and run
outs are unchanged. Simulated: 0.98 reviews an innings (fewer than 1.10 because sides run out).

### 13.5 Fielding errors: audit and model

Before: both engines resolved catch / stumping / run-out chances in `fielding.ts` with assumed conversions (82 / 90 / 75%), and a miss resampled the
ball from the whole outcome mix (so a ring drop could become a six). The instant engine logged `fieldingNote` and the fielder; the live engine put the
drop only in the commentary (its raw ball log had no `fieldingNote`), so live matches recorded no drops, and the live path into the season stats
credited no catches, stumpings or run outs at all. No scorecard or stat showed a drop. After: conversions from the commentary (13.1), the outcome of a
miss by where the chance went, the ball logs of both engines carry the note and the fielder, `fieldingTally` / `battingLives` feed the stats and the
"dropped on N" scorecard lines in both engines. A side of average fielders still gives the base model's wickets (the chance inflation uses the new
conversions). Simulated per innings: 0.72 catches put down (0.45 of them in the deep), 0.71 run-out chances missed, 0.028 stumpings missed, 0.85
misfields, 1.67 catches on the rope, 0.03 sixes saved.

### 13.6 Live viewer

Mid-over bowler changes (injury, two beamers) and retired-hurt returns pause for the user on his side ("Who finishes the over?" lists the bowlers who may
bowl, not the previous over's bowler; "Who bats next?" has a "Retired hurt: send back in?" section and, when nobody else is left, "end the innings").
The match-complete panel lists the super overs ball by ball.

Smoke test (Playwright's own headless Chromium, Vite dev server on port 3891, killed by PID afterwards; script kept outside the repo): a Draft Match v
CPU with raised rates through `setRuleOverrides` (imported from the same engine module the page uses): 8 "Who finishes the over?" panels (7 injuries, one
second beamer) each answered, 3 retired-hurt returns chosen, "Given out LBW!" reviewed, lbw appeals and a wide check reviewed, and the feed showing "pulls
up mid-over", retirements, DRS reviews, misfields, beamers and "removed from the attack", no page errors. A forced 0-0 tie (`forceCoarseOutcome: "dot"`,
`forceOutcomeSparesSuperOver`) ended "Your XI won by Super Over (17/0 v 15/1)" with both super overs listed ball by ball.

### 13.7 Balance

Same setup as 12.4: the ten IPL 2026 squads, random pairings, injuries off, rain off (`benchmark-rules.ts`; `RAIN=1` turns it on, `GENDER=women`
plays the same squads under the women's rates). "Before" is 2a262f1; "after" is this work before merging main; "after + main" includes main's own changes
(features-2: keeper / XI selection and the consecutive-overs fix), which move the byes.

Instant engine, 60,000 matches (120,000 innings):

| per innings | before | after | after + main | Cricsheet IPL 2023-26 |
|---|---|---|---|---|
| runs | 168.33 | 167.98 (-0.2%) | 168.68 (+0.2%) | 174-186 |
| wickets | 6.866 | 6.843 (-0.3%) | 6.875 (+0.1%) | 5.9-6.2 |
| fours | 16.66 | 16.44 (-1.3%) | 16.53 (-0.8%) | 14.7-15.8 |
| sixes | 7.734 | 7.684 (-0.6%) | 7.759 (+0.3%) | 7.6-9.6 |
| extras | 8.05 | 8.04 | 7.85 | 8.2-9.3 |
| wides / no-balls / bye-legbye balls | 3.81 / 0.50 / 2.11 | 3.80 / 0.50 / 2.11 | 3.82 / 0.50 / 1.97 | |
| chasing side wins | 55.0% | 55.1% | 55.0% | |
| super overs | 1.15% | 1.18% | 1.18% | 0.7% |

The fours move most (-1.3%): a put-down catch now ends in a boundary less often than the old proportional resample gave it, and the over-rate
restriction (+10% fours in about 1.3 overs an innings in 7.9% of innings) only gives part of it back. With rain on (60,000 matches): 2.7% of matches
shortened and 0.72% no results (IPL fitted: 2.68% / 0.74%), runs 166.2 an innings over all innings. Women's rates on the same squads (20,000 matches):
extras 8.03 -> 7.27, wides 3.83 -> 3.41 balls an innings, runs 168.8 -> 167.2.

Live engine, 5,000 CPU-v-CPU matches (10,000 innings; noise about 0.3% on the runs):

| per innings | before | after + main |
|---|---|---|
| runs | 242.21 | 242.13 |
| wickets | 6.088 | 6.035 (-0.9%) |
| fours | 25.72 | 25.61 |
| sixes | 14.82 | 14.78 |
| extras | 7.89 | 7.62 |
| lbw share of dismissals | 8.0% | 7.2% (the old live DRS added lbws; the fitted one does not) |
| chasing side wins | 62.8% | 62.6% |

Rates of the new events per innings (instant, after): reviews 0.98 (batting lbw struck down 0.15, overturned 0.12, umpire's call 0.06; fielding lbw struck
down 0.21, overturned 0.08, umpire's call 0.08; fielding caught struck down 0.18, overturned 0.07), dropped catches 0.72 (0.45 in the deep), run-out chances
missed 0.71, misfields 0.85, catches on the rope 1.67, no-balls: front foot 0.31 / height 0.18 / fielding 0.011, beamers 0.13, bowlers removed for two
beamers 0.0014, innings under the over-rate restriction 7.8%, sixes saved 0.032, missed stumpings 0.028, lodged balls 0.009, short runs 0.003, penalty runs
(helmet) 0.001.

### 13.8 Not done

- Bouncers per over (a third bouncer a no-ball, `maxBouncersPerOver`): the engines have no ball lengths; height no-balls stand in.
- Concussion substitutes, the ICC stop clock (T20Is only, not in the franchise leagues), penalty runs against the batting side.
- The live engine still has no Hundred (so the ten-ball ends are instant-only). Its rain is now the instant engine's fitted plan, per league, when
  the match is created with `rain` (12.4). Users do not nominate super-over batters / bowler (the AI picks).
- The instant sim's strategic timeouts are records only (no effect); misfields are labels (they do not add runs: the base model's runs already contain them).
- Thin rates (stumping misses, relay catches, sixes saved, short runs, lodged balls) are order-of-magnitude (Jeffreys); the over-rate effect sizes and
  penalty-reason split are assumptions.
- The live engine's scoring level is now the instant engine's (section 12.4, November 2026; it was about 242 an innings). Still the live engine's own:
  its DRS and CPU retire-out rules; its CPU sides do not use the Impact Player; a live super over is played at the death-overs rates (the instant one at
  the first over's).
