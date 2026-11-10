# Do players perform differently on different pitches? (tested, not shipped)

## What the engine already does

- A measured factor per ground for runs, sixes and (at 25%) wickets, and bowler-type edges per ground and region
  (`venues.ts`, `venue-data.ts`; docs/ENGINE-VENUES-AND-INJURIES.md; docs/VENUE-CONDITIONS-REPORT.md section 6, "Which bowler types work where": RA fast,
  fast-medium, medium, LA pace, off-spin, wrist-spin, LA orthodox, per 100 balls, shrunk). Every bowler of a type reads the same edge, every
  batter the same ground factor. The report's section 9 lists players who adapt well or badly away from home, but they are not in the engine.

## The test

`packages/ratings/src/pipeline/pitch-sensitivity.ts` (`npx tsx src/pipeline/pitch-sensitivity.ts [--split 2024]`; needs `data/analysis`). Men's T20
and T20I from Cricsheet, 2016 on, 316 venues, split at 2024: everything about a venue is measured on the years before the split.

- **Two venue dimensions.** FLAT: the log of the venue's runs per ball against the all-venue mean, shrunk (3,000 balls); its sd across venues is 0.051.
  TURNS: the share of bowlers' wickets that spin takes there against the all-venue share, shrunk (60 wickets), scaled to about one sd.
- **Player slopes as random effects.** Per side (batter, bowler), outcome (runs, wickets per ball) and dimension, a Poisson model
  `log mu = log balls + alpha_player + (beta_class + b_player) x z_venue`: beta per class (pace or spin for a bowler, all for a batter), `b_player` a
  random slope shrunk toward zero by its sampling variance against the between-player variance tau^2 (by moments), i.e. empirical Bayes. 900-980
  players per fit with 300+ training balls.
- **Held-out check.** The Poisson log-likelihood of every (player, venue, season) cell after the split with the player's slope against the class
  slope alone, per 1,000 balls, at the estimated tau and at fractions of it (a shrinkage that is too weak overfits).

## Result

| side, outcome, dimension | class slope | tau (between-player sd) | gain per 1,000 balls at tau x 1 / 0.5 / 0.25 / 0.1 |
|---|---|---|---|
| batter runs, flat | 1.05 | 1.04 | -0.730 / -0.128 / +0.033 / +0.019 |
| batter runs, turns | -0.09 | 0.23 | -0.715 / -0.157 / +0.002 / +0.009 |
| batter wickets, flat or turns | 0.29 / -0.03 | 0 | 0 |
| bowler runs, flat (pace / spin) | 1.38 / 1.75 | 1.06 / 0.99 | -1.329 / -0.406 / -0.065 / -0.002 |
| bowler runs, turns (pace / spin) | -0.07 / -0.19 | 0.24 / 0.22 | -0.443 / +0.000 / +0.067 / +0.022 |
| bowler wickets, flat or turns | | 0 | 0 |

The class slopes behave (a batter's runs move one for one with the venue's flatness: 1.05). The player slopes do not pay: at the spread the data
suggests they make the held-out likelihood **worse**; shrunk to a quarter of it the best case gains 0.03-0.07 log-likelihood per 1,000 balls, which is
noise-sized, and wickets show no between-player variation at all (tau 0). Per the rule "ship only slopes that help", **nothing was added to the ball
model**: the IPL and other league fingerprints are unchanged.

## The tails, for what they are

The raw estimates of the best-evidenced players (1,500+ training balls) look like specialists, but they are the tails of a noisy distribution the
held-out check says to distrust: bowlers whose runs per ball rose least on flat decks, T G Helm (raw slope -2.5, se 0.7, 1,736 balls), J T Ball
(-0.9, 0.5), C P Wood (-0.8, 0.6); hit hardest on flat decks, S A Abbott (+4.2, 0.7), J A Richardson (+3.9, 0.7), M G Hogan (+3.9, 0.8), M R Adair
(+3.4, 0.5), S Lamichhane (+3.5, 0.4); bowlers who concede less on spin-friendly venues, J Little (-0.48, 0.11), Hasan Ali (-0.42, 0.07), B C
Fortuin (-0.56, 0.11), D R Briggs (-0.58, 0.14); batters who score less on spin-friendly venues, L A Dawson (-0.63, 0.11), Fakhar Zaman (-0.50, 0.08),
S M Curran (-0.54, 0.11), J Charles (-0.48, 0.07); more, J P Inglis (+0.27, 0.09), D J Mitchell (+0.27, 0.10). A class slope for a batter's runs on
turning venues is -0.09: batters as a group barely notice.

## If this is revisited

More data (a decade of women's and Test cricket), a venue dimension that predicts more than scoring level and spin share (soil, grass cover and
day / night from the ground), and a held-out test per player rather than per likelihood cell would be the places to look; the pipeline takes
`--gender female` and a different `--split`.
