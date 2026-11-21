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

## In-match injuries (packages/engine/src/in-match-injury.ts)

Built by packages/ratings/src/analysis/concussion-subs.py (Cricsheet + the CricketArchive spells of injury-risk.py) into
packages/engine/src/in-match-injury-data.ts; rates, benchmark and live UI in RULES-MATCH.md section 13.9.

- Concussion substitutes in all three engines (instant, live, Test), every format and both genders: per legal ball, fitted on
  Cricsheet's 2023-24 `concussion_substitute` replacements (T20 3.2e-5, ODI 5.4e-5, Test 3.3e-5; 36% of them a batter at the
  crease). The like-for-like replacement comes from the rest of the squad (never a player already in the match; in the IPL it is
  separate from the Impact Player and keeps the overseas limit).
- Before, a retired-hurt batter and a bowler who broke down mid-over were fit for the next match unless the ordinary post-match
  roll happened to injure them. Now every in-match injury goes through `applyInMatchInjuries` before the post-match checks:
  - concussion: the measured team matches missed after a concussion substitution (117 with a next match: 0 35%, 1 30%, 2 17%,
    3 9%, 4-5 4%, 6+ 4%);
  - retired hurt: misses the next match with the measured "confirmed" share (T20 64%, ODI / List A 58%, Test / first-class 63%;
    CricketArchive spells of regulars), then the measured layoff (1 match 40%, 2 21%, 3 11%, 4 8%, 5 5%, 6+ 15%; mean 2.4);
  - a mid-over breakdown: misses the next match with the bowlers' confirmed share (67%), the same layoff.
- They are in the match result's `injuries` (`inMatch`: concussion / retired_hurt / bowler_breakdown; listed even when the
  player is fit for the next match, `matchesRemaining` 0), in the live season path (applyLiveResult) and in simulateTestMatch
  with `injuries`. The match page, the season page and the inbox show them ("concussion (in the match), out 2 matches").
- What the links add over a season (benchmark-season.ts, 40 IPL seasons each, `IMI_OFF=1` for before): per IPL side and match
  about 0.010 retired hurt, 0.015 mid-over breakdowns and 0.003 concussions, two thirds of them then missing a match. The share of
  squad-seasons (players who played) with any injury rises (batters 4.2% -> 6.0%, all-rounders 5.5% -> 9.4%, keepers 4.4% -> 7.0%,
  pace 7.8% -> 8.8%), mostly one- and two-match absences; the share with an injury of 3+ matches, INJURY_SCALE's target, moves
  2.8% -> 3.05% over all types (one standard error is 0.18 points). INJURY_SCALE is unchanged: the post-match model's measured
  absences include the confirmed in-match ones (5.6% of them), so lowering it by about that share would hold the 3+ share exactly.
