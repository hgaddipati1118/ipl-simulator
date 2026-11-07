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
- Batsman **cannot be dismissed** by: bowled, caught, LBW, stumped, hit-wicket
- Batsman **can be dismissed** by: run-out, handling the ball, obstructing the field, hitting the ball twice
- Effectively: wicket probability drops to near-zero (only run-out ~2-3% chance)
- Batsman is encouraged to swing freely → higher boundary probability

### Consecutive Free Hits
- If the bowler bowls a wide or no-ball on the free hit delivery, the next ball is ALSO a free hit
- Free hit chain continues until a legal delivery is bowled

### Implementation
```typescript
interface BallState {
  isFreeHit: boolean;
  // ... other state
}

// After no-ball:
nextBallState.isFreeHit = true;

// During free hit:
if (state.isFreeHit) {
  probs.wicket *= 0.05; // Only run-out possible (~5% of normal wicket prob)
  probs["4"] *= 1.3;    // Batter swings freely
  probs["6"] *= 1.5;    // Batter swings freely
  probs.dot *= 0.7;     // Less defensive
}

// If legal delivery on free hit, free hit ends
// If no-ball/wide on free hit, free hit continues
```

---

## 4. Super Over

### Trigger
- When scores are tied after both innings of a T20 match

### Format
- Each team bats for **1 over** (6 balls maximum)
- Each team selects **3 batsmen** and **1 bowler** for the super over
- Team batting first in the super over is determined by the coin toss loser from the main match
- Second team knows the target

### If Super Over Ties
- **Current rule (since 2020)**: Another super over is played, repeating until a winner emerges
- **Old rule (pre-2020)**: Boundary count was used as tiebreaker (famously in 2019 World Cup final)
- For our simulator: use current rule (repeat super overs)

### Player Selection AI
```
Batsmen: Pick top 3 by (strike_rate * 0.6 + average * 0.4) from today's XI
Bowler: Pick best by (economy_rate_inv * 0.5 + wickets * 0.3 + clutch * 0.2)
```

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
Since we don't model fielding positions, DRS is simplified:
- When a wicket falls, there's a 10-15% chance it would have been overturned by DRS
- If the batting team has a review remaining, the decision may be reversed
- This adds drama to key moments and occasional reprieve for batters
- Probability of successful review: `bowlerAccuracy < 70 ? 0.15 : 0.08`

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

1. Before the ball is sampled, the wicket weight is multiplied by `W` (`chanceInflation`, about 1.15), and the scoring outcomes give up exactly the
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
keeper, 25 unless rated). `Team.autoSelectPlayingXI()` already placed a designated keeper in every XI when the squad has one; it now also covers a
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
