# IPL Simulator Plan

## Goal

Turn the current app from a strong IPL season simulator into a long-save cricket management game with:

- believable player ratings and auction value
- coherent auto-sim and live-sim match logic
- real multi-season roster building pressure
- FM-style decision density between matches
- a deeper world: form, development, scouting, history, narrative, expectations

The repo is not starting from zero. The engine, ratings pipeline, and app already cover a large chunk of the core loop. The plan is to tighten realism first, then add management depth on top of a stable simulation base.

## Current Progress

This plan now reflects the repo after the latest realism pass.

Completed or materially improved in code:

- engine and app retention flow now share the same IPL slot-cost logic
- user retention UI no longer relies on `marketValue * 2`
- CPU-released players re-enter the auction pool correctly
- retained players now keep their real retention cost as bid/spend
- runtime player composites now match the ratings calculator weights
- fake all-rounders are normalized more aggressively at runtime
- batting-specialist clutch floors no longer collapse to unusable values
- valuation logic is capped to a sane IPL-style range instead of exploding exponentially
- regression tests now cover retention slot costs, runtime role normalization, batting clutch floors, and rating formulas
- generated ratings were regenerated from the updated calculator and role heuristics
- part-time bowling no longer qualifies as real bowling as easily in the ESPN pipeline
- ESPN role metadata and bowling-style metadata now feed runtime players more cleanly
- Rohit/Hardik/Pooran-class edge cases are materially improved instead of relying on broken defaults
- batting-profile adjustments now damp short-burst finisher inflation and small-sample power spikes
- bowling-primary role resolution now handles close-call cases like Pat Cummins without collapsing them into batsmen
- bowling overall now leans harder on wicket-taking so strike bowlers are not punished as harshly for merely average economy
- auto-sim now applies bowling-style, batting-hand, pitch, boundary, and dew matchup modifiers instead of only a stadium scalar
- auto-sim toss logic now follows venue context for heavy dew and seaming surfaces, matching live-sim more closely
- engine tests now cover venue-aware toss rules, venue fallback behavior, and aggregate turning-vs-flat match effects
- live-match now uses the shared matchup helper for core wicket/boundary/dot venue effects instead of a separate pitch/dew/boundary table
- venue-aware toss logic is now centralized in one shared helper across both sim modes
- live-match regression tests now cover venue-aware toss logic, missing venue metadata fallback, and aggregate turning-vs-flat behavior
- the lineup screen now has an assistant-style report with form pressure, batting-slot fit, bowling-phase fit, and venue-aware selection notes
- save/load/import/export now preserve `narrativeEvents`, and the app build is back to green
- a persistent readiness/fatigue model now exists in the player layer with workload history and selection-aware effective ratings
- season simulation now applies post-match workload to active XIs, passive recovery to idle squads, and a fatigue penalty into injury risk
- squad selection now prefers fresher players when quality is close instead of blindly sorting by raw overall
- team, lineup, player, inbox, and season dashboard surfaces now expose readiness/workload context instead of hiding it behind raw ratings only
- the season page now has a manager-desk summary that pulls inbox pressure, squad readiness, and next-action context into one place
- per-player training focus and team training intensity now exist as real persistent state instead of mock FM chrome
- offseason progression now produces a training/development report, and preseason freshness is shaped by the training plan
- the app now has a dedicated training page plus player/inbox surfaces for development direction and offseason review
- a persistent scouting-confidence layer now exists in app state instead of every screen reading raw player truth
- player, ratings, auction, trade, and opponent-roster views now show report bands and market reads for external players until scouting confidence improves
- a limited scouting-assignment desk now exists with player, shortlist, and market jobs instead of only passive page-view exposure
- scouting assignments now persist in saves and deliver timed recruitment updates through the inbox

Still intentionally not solved in this pass:

- final auto-sim/live-sim numerical convergence and remaining rule parity
- deeper FM systems like shortlist workflows, contracts, academy, and multi-season development direction
- a proper batting archetype/context model for finishers versus anchors/openers
- final calibration of elite batting ordering and auction-value realism
- deeper bowler realism beyond the composite weights: yorker specialists, death overs, and phase context

## Current Baseline

### Engine

Already implemented:

- automated auction and live step-by-step auction
- season scheduling and playoffs
- live ball-by-ball match state
- injuries, trades, retention flow, impact sub support
- venue metadata and matchup helpers

Current weakness:

- auto-sim and live-sim are not yet equally rich
- auction and retention logic are partly realistic in-engine but still leak inconsistencies into app state/UI
- player valuation and role normalization are not calibrated tightly enough

### Ratings

Already implemented:

- ESPN-driven ratings pipeline
- large generated men’s player set
- WPL player data
- roster mapping into runtime app data

Current weakness:

- elite ordering is noisy
- fake all-rounders still emerge from inflated secondary skills
- batting clutch has historically been under-modeled
- runtime role labeling and pipeline role inference need to stay aligned
- auction value is not yet a believable cricket economy signal

### App

Already implemented:

- setup, season mode, live match, trades, retentions, lineups, power rankings, saves/import/export
- player/team pages and match details

Current weakness:

- management layer is thin compared with Football Manager
- no morale, contracts, academy, or staff systems yet
- scouting uncertainty, active assignments, and board expectations now exist as first-pass systems, but they still need deeper workflows and stronger long-term planning hooks
- the UI now supports readiness, inbox context, lineup pressure, offseason training direction, and first-pass scouting fog, but long-term management guidance is still shallow

## Product Gap To FM-Quality

The biggest missing jump is not more screens. It is more meaningful decisions per week of game time.

To reach FM-quality, the app needs:

1. Ratings the user can trust.
2. A single consistent simulation truth across live and auto modes.
3. Player-state systems that evolve over time.
4. Information asymmetry and reporting.
5. Narrative pressure outside the match itself.

If those five do not exist, extra UI polish will not create FM-style depth.

## Core Principles

### 1. Fix realism before adding more meta-systems

Training, morale, and scouting matter only if the underlying player model is believable.

### 2. Prefer one source of truth

Retention rules, role inference, and valuation logic must live in the engine and be consumed by the app. The UI should not reimplement cricket rules.

### 3. Separate rating from value

Overall rating answers “how good is this player in cricket terms?”

Market value answers “what should teams pay in this auction economy?”

Those should be related, but not the same formula.

### 4. Build management pressure in layers

The app should move from lineup decisions only to:

- lineup + phase plans
- lineup + phase plans + form/fitness
- lineup + form/fitness + training/scouting
- lineup + training/scouting + board/media/expectations

## Phase Plan

### Phase 0: Alignment and Documentation

Deliverables:

- refresh `PLAN.md` to match the current repo
- keep Minro aligned with real gaps, not stale assumptions
- document where the current implementation already exceeds old planning tasks

Success criteria:

- the repo plan reflects the actual codebase
- open tasks are grouped into realism, management, and UX workstreams

### Phase 1: Ratings and Data Truth

Status:

- in progress
- runtime role normalization, batting-clutch handling, and source/runtime formula parity are now materially improved
- the ESPN-generated outputs have been regenerated from the new calculator pass
- the next step is a second validation sweep focused on elite ordering, player archetypes, and auction-value realism

Goal:

Make runtime player quality feel defensible.

Work:

- tighten runtime role normalization for imported players
- reduce specialist secondary-skill inflation
- improve clutch modeling for batting specialists
- raise the bowling qualification bar so part-timers stop becoming fake all-rounders
- use profile role/style metadata more directly where the raw stats are ambiguous
- apply batting-profile context so finishers and low-sample power hitters do not overrate so easily
- keep bowling-primary players from being mislabeled when batting and bowling composites are close
- calibrate market value for a sane IPL auction economy
- add validation tests against known players and distribution ranges

Success criteria:

- obvious fake all-rounders disappear
- elite batters no longer show broken clutch values
- auction values fall in believable IPL ranges
- validation tests cover star players, role balance, and outliers

### Phase 2: Auction and Retention Coherence

Status:

- mostly complete for the current single-season flow
- engine-owned retention planning exists and the app now consumes it directly
- the remaining work is season-rule generalization so retention rules vary cleanly by year instead of being hardcoded to one IPL cycle

Goal:

Make the full retention-to-auction transition consistent across engine and UI.

Work:

- engine-owned retention planning helper
- app retention UI uses fixed IPL slot costs
- released players from CPU/user retentions re-enter the auction pool
- retained players store real retention cost as bid/spend
- future-proof retention logic for season-rule variants

Success criteria:

- no `marketValue * 2` retention logic remains in the app
- user and CPU retentions obey the same limits and cost model
- purse math remains coherent entering the auction

### Phase 3: Match-Sim Coherence

Status:

- in progress
- both auto-sim and live-match now consume the shared venue/matchup helper for core wicket/boundary/dot effects
- toss heuristics are now shared across both sim modes
- the next step is remaining rule parity work: free hit, super over edge cases, field restrictions, and deeper phase-role behavior

Goal:

Make auto-sim and live-sim tell the same cricket story.

Work:

- route the richer matchup, venue, and phase logic into the main sim path
- complete bowling-style/batting-hand integration
- collapse duplicated venue logic so live-match and auto-sim use the same modifier source
- fix remaining cricket rule gaps: free hit, super over, field restrictions

Success criteria:

- live and simulated results produce similar player/team behavior
- venue and matchup metadata visibly matter
- obvious rule bugs are closed

### Phase 4: Management Layer 1

Goal:

Add the first real long-save management systems.

Work:

- player form system
- fatigue/fitness load system
- training focus between matches/seasons
- captaincy rating and phase bowling plans
- role suitability and XI feedback
- assistant-manager style advice/reporting around selection choices

Status:

- now in progress
- readiness/fatigue, workload history, and selection-aware condition penalties are in the engine
- lineup, team, player, inbox, and season dashboard views now surface condition pressure
- training focus, team intensity, preseason readiness carryover, and offseason development review are now in
- the next step is turning this into a broader weekly decision loop via planned rotation, captaincy, and richer role guidance

Success criteria:

- the user has meaningful weekly decisions even when not in auction season
- form and fitness meaningfully influence selection and performance

### Phase 5: Management Layer 2

Goal:

Add FM-style uncertainty and long-term planning.

Status:

- now in progress
- scouting confidence is now persistent app state rather than page-local chrome
- external player surfaces now render estimate bands and market reads instead of exact hidden ratings
- active scouting assignments now exist for player files, shortlist sweeps, and free-agent market scans
- the next step is deeper workflow control: team scouting jobs, watchlist-driven desk behavior, and better filtering of delivered reports

Work:

- scouting reports with partial info
- scouting progression from intent: shortlist, watchlist, target-team deep dives
- player development curves and progression history
- contract/value tension for retention and auction strategy
- academy/newgen quality bands
- replacement-level and uncapped talent pipeline

Success criteria:

- the user can build for now versus later
- the auction becomes more than “sort by OVR”

### Phase 6: World Layer

Goal:

Make the save feel alive.

Work:

- inbox/report surface
- board expectations and season objectives
- narrative events after matches
- media/form storylines
- richer season and career history views

Success criteria:

- the app explains what is happening in the world, not just the raw state
- the save develops memory and pressure across seasons

## Near-Term Execution Order

These are the next highest-leverage items:

1. Full-population ratings audit and optional ratings regeneration from the updated calculator.
2. Finish auto-sim/live-sim convergence by closing remaining rule gaps and deeper phase-role behavior.
3. Player form system.
4. Captaincy, rotation, and richer between-match management calls on top of the new fatigue/training model.
5. Scouting workflow depth beyond v1 assignments: team jobs, watchlist rules, and better report filtering.
6. Inbox/board/narrative layer.
7. Contract and retention-era value pressure.

That order matters. The management layer should land on top of trusted player and auction logic, not before it.

## Ratings Calibration Rules

The ratings system should follow these rules:

- specialists can have useful secondary skills, but not all secondary skills deserve all-rounder status
- batting clutch must not default to irrelevance for pure batters
- role labels should come from sustained two-discipline competence, not one inflated secondary composite
- market value should be capped to believable IPL auction ranges
- validation should include both star spot-checks and full-population distributions

Known failure modes to guard against:

- fake all-rounders from tiny bowling samples
- overpowered lower-order hitters with inflated batting composites
- bowlers priced like unlimited-budget fantasy assets
- pure batters getting pressure attributes that make no intuitive sense

## Validation Standard

Each realism pass should be checked against:

- targeted unit tests for formulas and retention rules
- runtime spot-checks for known IPL players
- role distribution sanity checks
- build verification across engine, ratings, and app

The app should not ship realism changes that only “feel right” in one or two spot checks.

## Minro Mapping

Existing Minro work already covers much of this plan:

- `Phase 0: Write Master Plan Document (PLAN.md)`
- ratings pipeline and validation tasks in `Phase 1D*`
- retention, squad-rule, and season-rule work in `Phase 2B`, `Phase 2D`, `Phase 4B`, `Phase 4C`
- FM-style systems like form, training, scouting, captaincy, and narrative already exist as open tasks

Missing backlog that should stay explicitly tracked:

- rating realism / role inference / market value calibration
- app-side retention follow-through where engine realism is already present but UI/state still lag

## Definition of “Good Enough”

The simulator is on the right path when:

- star players look roughly right without hand-waving
- retention and auction behavior are understandable from the UI
- auto-sim and live-sim produce similar team identities
- the user has real between-match decisions
- a 5+ season save tells a coherent story without the player inventing that story themselves
