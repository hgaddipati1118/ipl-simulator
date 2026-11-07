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
`generateBallCommentaryDetailed(params) -> { text, key }`. Only the live match path (`live-match.ts`) uses the model; the instant
simulation (`match.ts`) keeps its short built-in lines.

## 4. Regenerating

1. `commentary-sync.sh` (pull the latest scrape).
2. `python3 -I src/analysis/commentary-extract.py && python3 -I src/analysis/commentary-build.py` (from `packages/ratings`).
3. `npx vitest run` (the model tests read the committed JSON), commit `packages/app/public/data/commentary-model.json`.

## 5. Tests

`packages/engine/src/__tests__/commentary-model.test.ts` (reads the committed model): no unfilled slots; a dot never says four/six/boundary and
a four never says six; wickets match the dismissal kind; spin/pace vocabulary matches the bowler; she/her vs he/him; deterministic per seed;
the match result is identical with and without the model; distinct lines per match and no corpus line repeated; every name used belongs to
a player in the match; no real name from the source survives in any template (checked against the game's name pools).

## 6. Known limits

- Texts mention things the simulator doesn't model (a crowd, a particular kind of delivery after a field change); the filters remove the
  detectable ones, not all.
- Line / length / shot are sampled, not simulated: they make the words consistent with the outcome, they do not feed back into the result.
- Nicknames not in the corpus and typos that happen to be common survive the filters; `model-report.json` shows what is dropped, so the
  lexicon can be tuned.
