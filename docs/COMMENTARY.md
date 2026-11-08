# Ball-by-ball commentary from real matches

The live match screen writes a line for every ball. Besides the hand-written lines in
`packages/engine/src/commentary.ts`, the engine can now draw lines from a **corpus of real ESPNcricinfo
commentary**: thousands of matches (IPL, WPL, T20 World Cups, T20Is, BBL, PSL, SA20, The Hundred, CPL, ILT20, MLC, WBBL),
turned into name-free templates. Any player, including ones Cricinfo never covered (generated players, new
signings), gets realistic, varied lines.

```
 Cricinfo match pages ──scraper (oldmac)──> raw JSONL.gz ──rsync──> packages/ratings/data/commentary/   (gitignored)
        │                                                              │
        │                                          commentary-extract.py  -> balls.jsonl.gz (one row per ball)
        │                                          commentary-build.py    -> packages/app/public/data/commentary-model.json
        │                                                              │
        └─ one match at a time, human pacing                          engine: commentary-model.ts + commentary.ts
```

## 1. The scraper

Lives on `oldmac` in `/Volumes/Data/Developer/cricinfo-commentary/` (not in this repo: it is machine specific). A copy of
the script is kept in `packages/ratings/src/analysis/commentary-scraper.py`.

### How full-match commentary loads

The match page (`.../ball-by-ball-commentary`) embeds only the last ~12 balls in `__NEXT_DATA__`. Everything else comes from
`hs-consumer-api.cricinfo.com/v1/pages/match/comments?...&inningNumber=N&fromInningOver=K`, which needs an
`x-hsci-auth-token` that only the page's own JavaScript can produce (direct fetches are 403). The scraper never forges a
token. It lets the page make its own requests and records the answers:

1. `Page.addScriptToEvaluateOnNewDocument` installs a hook that wraps `fetch` and `XMLHttpRequest` and pushes every
   `/match/comments` response (status + JSON) into `window.__cmts`.
2. `Page.bringToFront` (without it the page's infinite scroll never fires), then the page loads.
3. The page's infinite scroll is triggered by bringing the **end of the commentary list** into view
   (`scrollIntoView({block:'center'})` on the last ball row; when fan comments / blurbs follow the last ball row the sentinel is the
   list's last child, so that is tried next, then scrolling past it), not by scrolling to the bottom of the document. Each trigger
   makes the page request the next two overs (`nextInningOver` in the response says where to resume); the innings is complete when a
   response has no `nextInningOver`. About 10 requests per innings. An innings that ends up with a missing over is re-scraped
   (up to 2 more times, merging by comment id); matches that are still incomplete are retried once on the next run.
4. The other innings is selected through the page's team drop-down (a real click on the team button, then on the other
   team's entry). That makes the page request `inningNumber=<other>` with no `fromInningOver`, and the same scroll loop
   finishes it. Super overs appear as extra innings and are picked up the same way.

A T20 takes about 75 s of page time. Between matches the scraper waits 5 to 11 s.

### What it stores

`out/comm/<seriesId>-<slug>.jsonl.gz`: gzip JSONL, **one match per line**, appended (concatenated gzip members), raw:

- `fixture`: the fixtures-list entry; `page.match` and `page.innings` (the page's own scorecard data, images stripped: batters,
  bowlers, partnerships, over summaries, fall of wickets, **player objects with `battingStyles` / `bowlingStyles` / gender**);
- `commentary["1"|"2"|...]`: every ball exactly as the API returned it (`oversActual`, `totalRuns`, `batsmanRuns`,
  `isFour/isSix/isWicket`, `dismissalType/Text`, extras, `wagonX/Y/Zone`, `pitchLine`, `pitchLength`, `shotType`,
  `shotControl`, `batsmanPlayerId/bowlerPlayerId/nonStrikerPlayerId/outPlayerId`, `title`, `commentPreTextItems`,
  `commentTextItems`, `commentPostTextItems`, `predictions`, ...);
- `stats` (balls/overs/complete per innings), `requests` (every API call with status), `secs`.

Cricinfo ids are the same as the game's `espn_<id>` ids (`batsmanPlayerId` is the player's `id`).

### Which matches

`discover()` walks the season-archive pages (`/ci/engine/series/index.html?season=2025;view=season`, every season from 2007 to 2026,
both `YYYY` and `YYYY/YY` forms) and classifies series by name; then each series' fixtures page gives its matches.
Order: IPL (all seasons, newest first), WPL, men's and women's T20 World Cups, T20I series since 2023/24 among the main
teams, then BBL, WBBL, PSL, SA20, The Hundred (men's, women's), CPL, ILT20, MLC from 2021. Only finished, non-cancelled
T20/T20I matches. Older seasons have text and tags too (the tags were back-filled), just less polished.

### Running, checking, stopping

```bash
ssh oldmac
cd /Volumes/Data/Developer/cricinfo-commentary
./run.sh &                      # start / resume (nohup it: nohup ./run.sh >/dev/null 2>&1 </dev/null &)
tail -f logs/scraper.log        # one "OK ..." line per match; "BLOCKED ..." lines when Akamai pushes back
cat out/progress.json           # done count, matches/hour, ETA for the matches known so far
touch STOP                      # graceful stop after the current match (STOP is removed on the next ./run.sh)
cat scraper.pid                 # the process
```

State is `out/state.json` (done / failed matches), so re-running resumes where it stopped. The scraper uses its own tab in
the dedicated Chrome (`BU_NAME=cricinfo-comm BU_CDP_URL=http://127.0.0.1:9224`) and never touches any other tab.
`run.sh` loops: if the daemon's CDP connection to Chrome dies mid-run (`cdp_disconnected`), the scraper stops at once
(rather than failing every remaining match), writes `RESTART`, and `run.sh` starts a fresh browser-harness run, whose
`ensure_daemon` heals the daemon. Matches that failed with a lost connection can be retried by resetting their `n` in
`out/state.json` `failed`. Some matches end in a tall editorial blurb and the page then ignores programmatic scrolling;
`wheel_down()` (real mouse-wheel events) keeps the infinite scroll going. Known gap: ties decided by a super over come back
with only a few balls (the innings dropdown does not cope with the super-over innings).

Akamai: a challenge page or "Access Denied" raises `Blocked`; the scraper backs off 1, 2, 5, 10, 20 minutes and gives up
(writes `STOPPED_BLOCKED`) if it has been blocked continuously for an hour.

### Getting the data to this Mac

```bash
packages/ratings/src/analysis/commentary-sync.sh              # once
packages/ratings/src/analysis/commentary-sync.sh loop 1800    # every 30 min
```

rsyncs into `packages/ratings/data/commentary/` (gitignored). A half-written gzip tail is skipped by the extractor.

## 2. From corpus to model

Run from `packages/ratings`:

```bash
python3 -I src/analysis/commentary-extract.py   # raw -> data/commentary/balls.jsonl.gz, names.json, corpus-stats.json
python3 -I src/analysis/commentary-build.py     # -> packages/app/public/data/commentary-model.json + data/commentary/model-report.json
```

Both are deterministic and re-runnable on the full corpus; nothing in the raw files is modified.

**extract**: one row per ball: outcome class (dot, 1, 2, 3, 4, 6, wide, noball, legbye, wicket + dismissal kind and fielder),
tags (shot, line, length, wagon zone, control), situation (phase, wickets, required rate, batter's score), bowler kind
(fast / medium / offspin / orthodox / legspin) and batter hand from the match's own player objects, the plain commentary text.

**build** turns each text into a template and drops what cannot be reused:

| step | what |
| --- | --- |
| names to slots | the ball's batter, bowler, fielder and non-striker (every spelling Cricinfo uses for them) become `{batter} {bowler} {fielder} {nonstriker}`; pronouns become `{he} {him} {his} {himself}` so women's and men's lines share one pool (women's lines containing the ambiguous "her" are dropped) |
| name leaks | any other capitalised word must be an ordinary word of the corpus. Names of players in the corpus, team and ground words, nicknames ("SKY", "Bhuvi") and unknown proper nouns drop the line (`model-report.json` lists the most common dropped tokens) |
| context | digits, "again", "earlier", "another", "this over", milestones, targets/asking rate, DRS/reviews/umpires, "new batter", hand-specific words ("left-hander"), spelled-out counts ("two wickets") ... |
| typos | lowercase words used fewer than 3 times in the whole corpus |
| outcome consistency | a dot says no four/six/boundary/single; a four no six; a bowled none of caught/lbw/stumped/run out, and must describe stumps/bails; a caught must describe a catch ... (regex guards in `commentary-build.py`) |
| bowler vocabulary | spin words (googly, flight, turn, ...) only if the source ball was bowled by a spinner; pace words (yorker, seam, bouncer, ...) only for pace |
| shape | at most `--max-len` (190) characters, trimmed at a sentence boundary; echoes of the outcome ("FOUR!") stripped because the engine prefix already says it |
| dedupe + cap | normalised text; per outcome class a variety-first sample (spread over shot / line / length / zone) up to a size budget (`--max-gz-kb`, default 1400) |

Each kept template carries the tags of its source ball packed into one integer (shot, line, length, zone, control, bowler kind,
phase, pressure, batter hand).

It also writes the **joint distribution** `P(shot, line, length, zone, control | outcome, bowler kind, batter hand)` (top 70
combinations per cell, with fallbacks to coarser cells).

## 3. In the engine

`packages/engine/src/commentary-model.ts` (data + picker) and `commentary.ts` (`generateBallCommentaryDetailed`):

- The simulator's ball has an outcome, a bowler and a batter, but no shot / line / length. For each ball the engine **samples** those
  tags from the joint distribution given the outcome, the bowler's kind and the batter's hand, so the commentary is consistent
  with the outcome by construction (a six never gets a "defended" shot).
- It then scores the outcome's templates by tag agreement (shot, length, line, zone, control, bowler kind, phase, match pressure,
  hand), takes the best ~14 and samples among them with the seeded RNG.
- Slots are filled with commentator-style names (`Kohli`, `Rohit`, `Arshdeep`: surname, or first name for very common surnames),
  pronouns follow the match's gender. Templates needing a slot the match cannot fill (a fielder on a catch it didn't name) are skipped.
- **Seeded and sim-neutral**: commentary uses its own RNG derived from the ball's context, so wording never changes how a match plays out
  (with or without the model loaded, same seed, same scores).
- **No repeats**: the used template keys are kept in `state._internal.commentaryUsed` (JSON-safe, survives state cloning);
  a line is not reused in a match until a class runs out.
- **Fallback**: with no model loaded (or no usable template) the original lines in `commentary.ts` are used unchanged. Milestone
  (FIFTY/CENTURY), chase and powerplay-end suffixes still apply.
- The app fetches `/data/commentary-model.json` lazily when idle (`main.tsx`); the file is generated, not bundled.

API: `setCommentaryModel(json | null)`, `loadCommentaryModel(url?)`, `hasCommentaryModel()`, `pickModelCommentary(ball, rng, used)`,
`generateBallCommentaryDetailed(params) -> { text, key }` (plain outcomes and the five legacy wicket kinds) and, for every delivery the
full Laws produce, `generateDeliveryCommentary(params) -> { text, key }` (section 8). The live match path (`live-match.ts runOneBall`)
uses `generateDeliveryCommentary` for every ball; the instant simulation (`match.ts`) calls `describeDelivery` (`delivery-text.ts`,
hand-written lines) for the special deliveries and keeps its short built-in lines for plain ones while it simulates. Instant matches get
corpus lines too, lazily, when their commentary is viewed (section 9).

## 4. Regenerating

1. `commentary-sync.sh` (pull the latest scrape).
2. `python3 -I src/analysis/commentary-extract.py && python3 -I src/analysis/commentary-build.py` (from `packages/ratings`).
3. `npx vitest run` (the model tests read the committed JSON), commit `packages/app/public/data/commentary-model.json`.

## 5. Tests

`packages/engine/src/__tests__/commentary-model.test.ts` (reads the committed model): no unfilled slots; a dot never says four/six/boundary and
a four never says six; wickets match the dismissal kind; spin/pace vocabulary matches the bowler; she/her vs he/him; deterministic per seed;
the match result is identical with and without the model; distinct lines per match and no corpus line repeated; every name used belongs to
a player in the match; no real name from the source survives in any template (checked against the game's name pools).

## 6. Status (when this was written)

- Scraper: measured ~45 matches/hour (about 70 s of page time + 5-11 s pacing per T20, 0 Akamai blocks in the first hours). Planned set is roughly
  1,250 IPL, ~90 WPL, ~550 World Cup (incl. women's), ~560 T20Is since 2023/24 and ~1,900 league matches since 2021, about 4,300 matches, i.e. around 4 days
  of scraping; the IPL alone is ~27 hours.
- The committed model is built from 37 matches (IPL 2026, 8,619 balls: 100% with text, 99.4% with shot tags, 100% with line and length):
  5,583 templates, 0.62 MB raw / 159 KB gzipped. Run outs: 12 striker and 10 non-striker run-out balls in the corpus gave 7 striker and
  8 non-striker templates; 9 caught-and-bowled balls gave 6 templates; hit wicket, obstructing, handled, hit twice and timed out have no
  corpus lines at all (hand-written, section 8). Common outcomes are well covered; rare dismissals (stumped, lbw, run out) and 3s have few lines
  and fall back to the built-in text (the picker steps aside when fewer than 4 unused lines are left). Regenerate on the full corpus to fill those
  in; the size budget (`--max-gz-kb`) caps the file at ~1.4 MB gzipped.

## 7. Known limits

- Texts mention things the simulator doesn't model (a crowd, a particular kind of delivery after a field change); the filters remove the
  detectable ones, not all.
- Line / length / shot are sampled, not simulated: they make the words consistent with the outcome, they do not feed back into the result.
- Nicknames not in the corpus and typos that happen to be common survive the filters; `model-report.json` shows what is dropped, so the
  lexicon can be tuned.

## 8. Every delivery of the full Laws (situation lines)

The engines simulate the complete Laws (`delivery-rules.ts`, RULES-MATCH.md section 12): twelve dismissal kinds, a run out of the striker OR the
non-striker, wides of 1 to 5, no-balls with runs / byes / the two-run cost, free hits, byes vs leg byes of 1 to 5, overthrows, penalty runs,
a Mankad, retirements. The corpus covers only a few of those, so one entry point decides per delivery:

```ts
generateDeliveryCommentary({
  detail,                      // DeliveryDetail (expandDelivery): outcome, wides, noBalls, byes, legByes, overthrow, penalty, wideKind, dismissal{kind,out,substitute}
  bowlerName, batterName,      // batterName = the STRIKER (who played the ball), not necessarily who is out
  nonStrikerName, fielderName, fielder2Name, substitute, freeHit, deadBall,   // deadBall = Mankad (no ball bowled)
  over, ball, score, wickets, isSecondInnings, target, bowlingStyle, battingHand, gender, batterRuns, batterBalls, boundaryShot,
  rng, usedLines,
}) -> { text, key? }            // key = corpus line used (remember it in usedLines)
```

| delivery | line |
| --- | --- |
| dot / 1 / 2 / 3 / 4 / 6, leg bye of 1, wide of 1 (off or leg), bowled, caught, lbw, stumped, striker run out, caught and bowled, non-striker run out | **corpus** line when the model has at least `MIN_UNUSED` unused fitting lines (a substitute catch / run out only takes templates that name `{fielder}`; a wide down the leg side only takes templates that say "leg"); else the built-in line (plain balls, bowled / caught / lbw / stumped) or the hand-written line |
| everything else: hit wicket, obstructing, handled, hit twice, run out with two fielders, any dismissal off a wide / no-ball, wides of 2 to 5 and wides for height, every no-ball, byes, leg byes of 2 to 5, overthrows, penalty runs, the Mankad, a caught by a substitute without a corpus line | **hand-written** (`delivery-text.ts describeDelivery`, 2 to 4 variants each, picked with the ball's seeded RNG) |
| a free hit | every line starts with `FREE HIT!`; a wide or no-ball on a free hit also says the free hit stays; every no-ball says the free hit follows |

Rules for the hand-written text: only the people of the ball are named (bowler, striker, non-striker, the fielder(s)); the opening is
"Bowler to Batter" with the names as given and the body uses commentator short names; no pronouns (the same line fits men's and women's
matches); no em dashes. A substitute fielder is "substitute Name" (`ModelBall.substitute` does the same inside corpus lines, on the first
mention); a two-fielder relay run out names both ("A gathers, relays to B"). A non-striker run out always names the non-striker as
the one who is out and says the striker survives; a Mankad names the bowler and the non-striker and says no ball is bowled.
Retirements have their own helpers (`retiredHurtLine`, `retiredOutLine`, `timedOutLine`, `superOverLine`) for the engine to call
where it records those events.

Wrappers (milestones, "Need N more", end of the powerplay, "a duck for X") are added to every line; they are skipped when the striker is
not the batter who is out. A fielding-note line (`fieldingCommentary`: great catch, direct hit) replaces the generated line in
`runOneBall` only for a striker caught / run out by one regular fielder; everything else keeps the new line.

### Run-out tagging

Corpus run outs are split into two classes by **who was out**, decided in `commentary-build.py run_out_class` from the ball's `outPlayerId`:

| class | out | slots | rules enforced by `run_out_tag_ok` |
| --- | --- | --- | --- |
| `W:run_out` | the striker | `{batter}` = out | no `{nonstriker}` playing the shot; the partner is never the one out |
| `W:run_out_ns` | the non-striker | `{batter}` = the striker who played the shot (and survives), `{nonstriker}` = out | every template contains `{nonstriker}`; no `{batter}` dismissal ("{batter} is run out", "{batter}'s run out"); the partner never plays the shot |

Both classes also drop lines that name a particular fielder or a referral ("from the bowler", "upstairs", "third umpire"), because the
engine's fielder can be anyone. `ModelBall.outNonStriker` selects the class (`DeliveryDetail.dismissal.out === "nonStriker"`); the joint tag
distribution of a thin class falls back to its parent (`W:run_out_ns` to `W:run_out`, `W:caught_and_bowled` to `W:caught`). Caught and bowled is
its own class (`W:caught_and_bowled`): the bowler is the catcher, so the build drops the `{fielder}` role (it used to make every name
ambiguous and lose the lines) and rejects templates with `{fielder}`.

Tests: `commentary-situations.test.ts` (every dismissal kind and extras situation: clean line, right people named, free hit says free hit,
deterministic, no repeated corpus key, with and without the model; whole matches with forced non-striker run outs and forced kinds) and
the run-out tagging tests in `commentary-model.test.ts` and `commentary_build.test.py`.

Known gap: the DRS review lines in `live-match.ts` (run out "Batter was short / IN") are written without regard to who was out; they are
outside this module.

## 9. Instant-simulated matches (lazy model commentary)

What the UI shows for an instantly simulated match: the season match page (`/match/:idx`, `MatchPage.tsx`) has a collapsible
"Ball-by-Ball Commentary" panel that lists `DetailedMatchResult.ballLog[].commentary` over by over. The detailed result is passed in the route
state right after the match, or read back from IndexedDB (`match-db.ts`). That is the only place instant-sim ball text appears (the news
feed and season pages use scores, not ball text; Draft Match and multiplayer show results only). Live-viewed matches already carry model lines.

The instant engine still writes its cheap built-in lines while it simulates. Model lines are produced only for a match someone opens:

1. `attachCommentaryCues(result, players, gender)` (`instant-commentary.ts`, called from `game-state.ts playNextMatch`) stores on
   `result.detailed.commentaryCues` the facts the detailed ball log lacks: non-striker, extras split, bat boundary, overthrow, wide kind,
   non-striker out, the real fielder(s), substitute, dead ball, fielding note, and each player's bowling style / batting hand. It copies fields
   only (~0.1 ms a match, ~8 KB stored with the match, about 11% of its detailed record).
2. When the commentary panel is opened, the page loads the model if it is not loaded yet (`commentary-loader.ts ensureCommentaryModel`,
   shared with the idle preload in `main.tsx`) and calls `withModelCommentary(detailed)`: each delivery is rebuilt (`DeliveryDetail`) and
   passed to `generateDeliveryCommentary` with the score, wickets, target, batter's runs / balls before the ball, the legal ball of the over,
   style, hand and gender, on an RNG seeded by the match and ball. A ball takes the new line only when it is a corpus line (the result has a
   `key`); keys are remembered so no line repeats in the match. About 12 ms a match.
3. Unchanged: balls the corpus cannot describe (they keep their hand-written `describeDelivery` line), a missed chance that did not end in a
   wicket (its fielding line says what happened), the Mankad, and any line mentioning DRS. Matches stored before cues existed, and every
   match when the model failed to load, show the built-in lines as before.

Only the `commentary` strings change: runs, wickets, scores and every other field are identical (tests:
`packages/engine/src/__tests__/instant-commentary.test.ts`).
