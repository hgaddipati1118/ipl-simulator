# Measured venues and injuries in the engine

The T20 engine now uses the venue analysis (docs/VENUE-CONDITIONS-REPORT.md) and the injury analysis
(docs/INJURY-RISK-REPORT.md). Both are trimmed into small generated engine tables:

- packages/engine/src/venue-data.ts: built by packages/ratings/src/analysis/export-engine-venues.py from
  data-export/venue-conditions.json + toss_chase.csv. Covers the IPL/WPL franchises' home grounds (17 KB).
- packages/engine/src/injury-data.ts: built by packages/ratings/src/analysis/export-engine-injury.py from
  data-export/injury-risk.json.

Check both with npx tsx packages/engine/src/__tests__/benchmark-season.ts [seasons] [--no-injuries].

## Venues (packages/engine/src/venues.ts)

- Runs and sixes use each home ground's measured factor in full; wickets keep 25% of the ground effect,
  because ground effects did not predict wickets out of sample. Bowler-type edges (per 100 balls,
  already shrunk) adjust that type's wicket and scoring rates.
- Each league's grounds are normalised to the league mean, and LEAGUE_LEVEL_RUN / LEAGUE_LEVEL_WICKET
  keep the league-wide level where the engine was calibrated with the old hand-set grounds.
- VENUE_RUN_GAIN = 1.6 makes simulated first-innings totals move one-for-one with the measured factor
  (benchmark regression slope 1.00).
- Chase: competition baseline (IPL 2024-26 +5.6%; WPL +3.7%, shrunk from +8.8% on 87 matches) plus half the
  ground's deviation from its league. The engine on its own disadvantages chasers by about 3.3 points, so
  the second-innings tilt is 0.78 x (chase advantage + 0.033).
- Toss: CPU captains field first with probability 0.5 + 5.5 x chase advantage (IPL: ~80%, as in 2024-26).
  Unmapped (custom) venues keep the old dew/pitch heuristic.
- stadiumBowlingRating, pitchType, boundarySize and dewFactor on IPL/WPL team configs are now labels
  derived from the measurements (UI, lineup advice, live-mode extras). The stadium editor still works:
  an edit applies as a ratio to the measured default, and an old save's hand-set default counts as unedited.
- PBKS's home ground is now Mullanpur (Maharaja Yadavindra Singh Stadium), their home since 2024.

## Injuries (packages/engine/src/injury.ts)

- Per-match chance = INJURY_SCALE x base(type, age band) x tilt(type) x previous-injury x gender x format,
  x a fatigue uplift (up to +50%) that only ever adds risk.
- base: the measured absence rates (confirmed + likely). tilt: a nudge toward the IPL replacement record,
  shrunk by replacements per type (w = n / (n + 20)): pace 1.21, bowling AR 1.21, batting AR 1.08,
  keeper 1.09, batter 0.96, wrist spin 0.96, finger spin 0.79, medium 0.77.
- INJURY_SCALE = 0.385: absences include rest and rotation, so the scale is set so the share of IPL
  squad-seasons with an injury of 3+ matches (5.3% simulated) matches the share that end in an injury
  replacement (192 of 3,633 = 5.3%). The data's confirmed-only floor is 0.039x and confirmed + likely is 1.0x.
- Durations follow the measured split (about 49% 1-2 matches, 41% 3-5, 10% 6+).
- Players carry injuryHistory [this season, last season] for the previous-injury multiplier.
- Healing now counts the injured player's own team matches (it used to tick on every league match).
  Live-played matches now get the same post-match injury checks as simulated ones.
