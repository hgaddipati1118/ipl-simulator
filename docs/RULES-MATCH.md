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
