"""
Fit the Test match model (docs/FORMATS-TEST.md) from Cricsheet ball-by-ball Tests and write it as a generated engine
table (packages/engine/src/test-model-data.ts) plus a report (docs/data/test_model.json) and the national squads the
engine's Test benchmark plays (packages/engine/src/__tests__/fixtures/test-squads.json).

What is fitted:
  1. The ball model. Per delivery outcome class (1, 2, 3, 4, 6, wicket, wide, no-ball, bye / leg bye; a dot is what is
     left) a log-linear Poisson rate with main effects for: ball age (overs since the new ball), batter set-ness (balls
     faced before the ball), innings number 1-4, day x pace / spin (pitch wear), the bowler's over in his spell (fatigue),
     the match situation (the overs before a declaration, the required rate of a 4th-innings chase), home / away / neutral
     batting side, venue country x pace / spin, era, England's batting from June 2022 ("Bazball"), and the batter and the
     bowler themselves (shrunk to average with a 300-ball prior). Fitted by iterative proportional fitting (backfitting of
     the Poisson likelihood) in DuckDB on men's Tests from 2006. The player terms soak up who faces / bowls in each
     context, so a context factor is the effect for the same players (a set batter is not just a better one).
     Women's Tests (24 in Cricsheet) are too few to fit the structure: their base rates are refitted with every men's
     factor held as an offset (the men's structure, women's levels).
  2. How player ratings map onto the batter / bowler terms: the attribute mix that best predicts each fitted player term
     (ridge regression on the game's ratings of the same players, game_players.json), scaled by reduced major axis so the
     simulated spread of player quality equals the real spread whatever the ratings' noise.
  3. Dismissal kinds by pace / spin, the extras' runs, DRS reviews per innings (Cricsheet `review` objects).
  4. The team decisions: toss choice by host country, declaration hazards (innings 1-3), follow-on enforcement, the
     spinners' share of the overs and spell lengths (bowling changes), bowler workloads, overs bowled per day and time lost
     to weather / bad light (CricketArchive minutes batted).
  5. Validation targets from real men's Tests since 2015 (and women's Tests) for the engine benchmark.

Inputs (read-only):
  data/analysis/deliveries.parquet, matches.parquet  Cricsheet ball by ball (match_type 'Test')
  data/analysis/venue_map.csv                         venue -> country / region
  data/analysis/game_players.json                     the game's players (espn ids, ratings) for the rating mapping and squads
  data/cricsheet/people.csv                           Cricsheet register (cricsheet id -> cricinfo / CricketArchive ids)
  data/scraped/espn-players.json, data/cricket.db     bowling styles (ESPN profile, CricketArchive), CricketArchive minutes
  $CRICSHEET_TEST_JSON_DIR                            raw Cricsheet Test JSON (declared / absent hurt innings flags, days
                                                      played, DRS reviews). Default packages/ratings/data/cricsheet/tests_json.
                                                      To create it: download https://cricsheet.org/downloads/tests_json.zip
                                                      and unzip into an empty directory. Files are untrusted and only json.load-ed.

Needs the `duckdb` CLI on PATH. Run from packages/ratings:
  CRICSHEET_TEST_JSON_DIR=/path/to/tests_json python3 -I src/analysis/test-match-model.py
REUSE=1 skips the JSON parse and the ball table when their outputs are still in the temp directory (TEST_MODEL_TMP).
"""
import csv
import glob
import json
import math
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPO = ROOT.parent.parent
DATA = ROOT / "data" / "analysis"
OUT_TS = ROOT.parent / "engine" / "src" / "test-model-data.ts"
OUT_JSON = REPO / "docs" / "data" / "test_model.json"
OUT_SQUADS = ROOT.parent / "engine" / "src" / "__tests__" / "fixtures" / "test-squads.json"
JSON_DIR = Path(os.environ.get("CRICSHEET_TEST_JSON_DIR", str(ROOT / "data" / "cricsheet" / "tests_json")))
TMP = Path(os.environ.get("TEST_MODEL_TMP", "/tmp/test-match-model"))
TMP.mkdir(parents=True, exist_ok=True)
DB = TMP / "tm.duckdb"
REUSE = bool(os.environ.get("REUSE"))

FIT_FROM = 2006            # first season of the ball-model fit (eras below)
VALID_FROM = 2015          # validation targets: men's Tests since 2015
BAZBALL_FROM = "2022-06-01"
SCHED_DAYS = {"male": 5, "female": 4}
DAY_OVERS = 90
TEAM_COUNTRY = {
    "India": "IND", "England": "ENG", "Australia": "AUS", "South Africa": "RSA", "New Zealand": "NZ", "Pakistan": "PAK",
    "Sri Lanka": "SL", "West Indies": "WI", "Bangladesh": "BDESH", "Zimbabwe": "ZIM", "Ireland": "IRELAND", "Afghanistan": "AFG",
}
# Engine country keys (venue country -> conditions); everything else is "other"
COUNTRIES = ["IND", "PAK", "SL", "BDESH", "UAE", "AUS", "ENG", "RSA", "NZ", "WI", "ZIM", "IRELAND"]
ERAS = [(2006, 2010, "2006-10"), (2011, 2014, "2011-14"), (2015, 2018, "2015-18"), (2019, 2022, "2019-22"), (2023, 2100, "2023+")]
OUTCOMES = ["1", "2", "3", "4", "6", "W", "wide", "nb", "bye"]
# Factor bins (lower bounds)
AGE_BINS = [0, 5, 10, 20, 35, 50, 65]          # overs since the new ball (a new ball is assumed at 80, 160)
SET_BINS = [0, 5, 10, 20, 35, 60, 100, 150]    # balls the batter has faced in the innings before this one
SPELL_MAX = 7                                  # over in the spell 1..7+
WD_BINS = [0, 3, 6, 8]                         # wickets down in the innings: 0-2, 3-5, 6-7, 8-9 (the tail is in), per innings 1-4
# 4th innings: runs needed per scheduled over left (days x overs a day less the overs bowled). Not the overs the match turned out
# to have: estimated from the match's own length, that ties a chase's "time left" to how long the chase itself lasted (a quick
# collapse looks short of time), which made the easy-chase level partly an outcome.
RR_BINS = [0, 2.5, 3.5, 4.5, 6.0]
PUSH_OVERS = 12                                # the last overs of an innings that was declared
PRIOR_BALLS = 300                              # player terms: shrink with a 300-ball prior at the average rate


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, file=sys.stderr, flush=True)


def duck(sql, json_out=True):
    args = ["duckdb", str(DB)] + (["-json"] if json_out else []) + ["-c", sql]
    p = subprocess.run(args, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"duckdb failed: {p.stderr}\n{sql[:600]}")
    rows = json.loads(p.stdout) if json_out and p.stdout.strip() else []
    num = re.compile(r"^-?\d+(\.\d+)?(e-?\d+)?$")
    return [{k: (float(v) if num.match(v) else v) if isinstance(v, str) else v for k, v in row.items()} for row in rows]


def r(x, n=4):
    return None if x is None else round(float(x), n)


# ── 1. Raw Cricsheet JSON: innings flags, days played, reviews ──────────────────────────────────────────────────────────

def parse_json():
    if REUSE and (TMP / "innings.csv").exists():
        log("json: reusing", TMP)
        return
    files = glob.glob(str(JSON_DIR / "*.json"))
    if not files:
        raise SystemExit(f"CRICSHEET_TEST_JSON_DIR {JSON_DIR} has no *.json files; see the module docstring")
    log(f"json: {len(files)} files")
    with open(TMP / "matches.csv", "w", newline="") as fm, open(TMP / "innings.csv", "w", newline="") as fi, \
            open(TMP / "reviews.csv", "w", newline="") as fr:
        wm, wi, wr = csv.writer(fm), csv.writer(fi), csv.writer(fr)
        wm.writerow(["match_id", "date", "n_dates", "gender", "venue", "city", "team1", "team2", "toss_winner", "toss_decision",
                     "winner", "by_runs", "by_wickets", "by_innings", "result", "method"])
        wi.writerow(["match_id", "inn", "team", "declared", "forfeited", "absent_hurt", "legal", "runs", "wkts"])
        wr.writerow(["match_id", "inn", "over", "by_batting", "decision", "umpires_call", "wicket_kind"])
        for f in files:
            try:
                d = json.load(open(f))
            except (OSError, ValueError):
                continue
            info = d.get("info") or {}
            if info.get("match_type") != "Test":
                continue
            mid = Path(f).stem
            out = info.get("outcome") or {}
            by = out.get("by") or {}
            teams = info.get("teams") or [None, None]
            toss = info.get("toss") or {}
            wm.writerow([mid, (info.get("dates") or [None])[0], len(info.get("dates") or []), info.get("gender"), info.get("venue"),
                         info.get("city"), teams[0], teams[1], toss.get("winner"), toss.get("decision"), out.get("winner"),
                         by.get("runs"), by.get("wickets"), 1 if by.get("innings") else 0, out.get("result"), out.get("method")])
            for i, inn in enumerate(d.get("innings") or [], start=1):
                legal = runs = wk = 0
                for o in inn.get("overs") or []:
                    for dl in o.get("deliveries") or []:
                        ex = dl.get("extras") or {}
                        if not ex.get("wides") and not ex.get("noballs"):
                            legal += 1
                        runs += (dl.get("runs") or {}).get("total", 0)
                        for w in dl.get("wickets") or []:
                            if w.get("kind") not in ("retired hurt", "retired not out"):
                                wk += 1
                        rv = dl.get("review")
                        if rv:
                            wks = dl.get("wickets") or []
                            wr.writerow([mid, i, o.get("over"), 1 if rv.get("by") == inn.get("team") else 0, rv.get("decision"),
                                         1 if rv.get("umpires_call") else 0, wks[0].get("kind") if wks else ""])
                runs += sum((inn.get("penalty_runs") or {}).values()) if isinstance(inn.get("penalty_runs"), dict) else 0
                wi.writerow([mid, i, inn.get("team"), 1 if inn.get("declared") else 0, 1 if inn.get("forfeited") else 0,
                             len(inn.get("absent_hurt") or []), legal, runs, wk])


# ── 2. The ball table ───────────────────────────────────────────────────────────────────────────────────────────────

def bin_sql(col, bins):
    parts = " ".join(f"WHEN {col} >= {b} THEN {i}" for i, b in reversed(list(enumerate(bins))))
    return f"(CASE {parts} ELSE 0 END)"


def build_balls():
    if REUSE and DB.exists():
        try:
            if duck("SELECT count(*) n FROM tb")[0]["n"] > 0:
                log("balls: reusing", DB)
                return
        except SystemExit:
            pass
    if DB.exists():
        DB.unlink()
    log("balls: building")
    team_map = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in TEAM_COUNTRY.items())
    era_sql = " ".join(f"WHEN yr BETWEEN {a} AND {b} THEN {i}" for i, (a, b, _) in enumerate(ERAS))
    duck(f"""
LOAD sqlite; ATTACH '{ROOT / 'data/cricket.db'}' AS ca (TYPE sqlite, READ_ONLY);
CREATE TABLE mx AS SELECT * FROM read_csv('{TMP / 'matches.csv'}', header=true, all_varchar=true);
CREATE TABLE inn AS SELECT match_id, inn::INT inn, team, declared::INT declared, forfeited::INT forfeited, absent_hurt::INT absent_hurt,
  legal::INT legal, runs::INT runs, wkts::INT wkts FROM read_csv('{TMP / 'innings.csv'}', header=true, all_varchar=true);
CREATE TABLE rev AS SELECT match_id, inn::INT inn, "over"::INT ov, by_batting::INT by_batting, decision, umpires_call::INT uc, wicket_kind
  FROM read_csv('{TMP / 'reviews.csv'}', header=true, all_varchar=true);
CREATE TABLE vmap AS SELECT raw_venue, coalesce(raw_city,'') raw_city, any_value(country) country, any_value(region) region
  FROM read_csv('{DATA / 'venue_map.csv'}', header=true, all_varchar=true) WHERE source='cs' GROUP BY 1,2;
-- bowling type per Cricsheet player (ESPN profile first, CricketArchive second); the same rules as venue-conditions.py
CREATE MACRO btype_of(st) AS (CASE
    WHEN st IS NULL OR st = '' THEN NULL
    WHEN st LIKE '%fast%' OR st LIKE '%medium%' THEN 'pace'
    WHEN st LIKE '%orthodox%' OR st LIKE '%legbreak%' OR st LIKE '%wrist%' OR st LIKE '%googly%' OR st LIKE '%offbreak%' OR st LIKE '%slow%' THEN 'spin'
    ELSE NULL END);
CREATE MACRO norm_style(x) AS replace(replace(lower(split_part(coalesce(x,''), ',', 1)), 'off-break', 'offbreak'), 'leg-break', 'legbreak');
CREATE TABLE espn AS SELECT * FROM read_csv('{TMP / 'espn_styles.csv'}', header=true, all_varchar=true);
CREATE TABLE pc AS SELECT identifier cs, TRY_CAST(key_cricinfo AS BIGINT) ci, TRY_CAST(key_cricketarchive AS BIGINT) ca_id
  FROM read_csv('{ROOT / 'data/cricsheet/people.csv'}', header=true, all_varchar=true);
CREATE TABLE ptype AS SELECT pc.cs, pc.ci, coalesce(btype_of(norm_style(e.bowl)), btype_of(norm_style(pl.bowling_style))) btype
  FROM pc LEFT JOIN espn e ON TRY_CAST(e.espn_id AS BIGINT) = pc.ci LEFT JOIN ca.players pl ON pl.id = pc.ca_id;
CREATE TABLE m AS
SELECT x.match_id mid, x.date::DATE date, year(x.date::DATE) yr, x.n_dates::INT n_dates, x.gender, x.team1, x.team2, x.toss_winner, x.toss_decision,
  x.winner, TRY_CAST(x.by_runs AS INT) by_runs, TRY_CAST(x.by_wickets AS INT) by_wickets, x.by_innings::INT by_innings, x.result, x.venue,
  coalesce(v.country, 'UNK') country, coalesce(v.region, 'Other') region,
  (SELECT count(*) FROM inn WHERE inn.match_id = x.match_id) n_inn
FROM mx x LEFT JOIN vmap v ON v.raw_venue = x.venue AND v.raw_city = coalesce(x.city, '');
-- per-match day length (legal balls a day): a decided match used D-1 days and on average about half of the last one
CREATE TABLE mlen AS
SELECT m.mid, sum(i.legal) balls, m.n_dates,
  greatest(300, least(540, sum(i.legal) / (m.n_dates - 1 + CASE WHEN m.result IN ('draw') THEN 1.0 ELSE 0.55 END))) day_balls
FROM m JOIN inn i ON i.match_id = m.mid GROUP BY m.mid, m.n_dates, m.result;
CREATE TABLE b0 AS
SELECT d.match_id mid, d.innings inn, d.over ov, d.ball, d.batter_id bat, d.bowler_id bowl, d.batting_team bteam, d.bowling_team fteam,
  d.runs_batter rb, d.wides, d.noballs, d.byes, d.legbyes, coalesce(d.penalty,0) pen, d.runs_total rt, d.is_wicket, d.wicket_kind wk,
  coalesce(d.non_boundary,0) nonb, d.player_out_id pout, d.fielder_ids fids, d.non_striker_id nst,
  CASE WHEN d.wides=0 AND d.noballs=0 THEN 1 ELSE 0 END legal, CASE WHEN d.wides=0 THEN 1 ELSE 0 END faced,
  row_number() OVER (PARTITION BY d.match_id ORDER BY d.innings, d.over, d.ball) seq
FROM '{DATA / 'deliveries.parquet'}' d JOIN m ON m.mid = d.match_id WHERE coalesce(d.super_over,0) = 0;
CREATE TABLE b1 AS
SELECT b0.*,
  sum(legal) OVER (PARTITION BY mid ORDER BY seq ROWS UNBOUNDED PRECEDING) - legal cum_legal,
  sum(legal) OVER (PARTITION BY mid, inn ORDER BY seq ROWS UNBOUNDED PRECEDING) - legal inn_legal,
  sum(faced) OVER (PARTITION BY mid, inn, bat ORDER BY seq ROWS UNBOUNDED PRECEDING) - faced setb,
  sum(rt) OVER (PARTITION BY mid, inn ORDER BY seq ROWS UNBOUNDED PRECEDING) - rt inn_runs,
  sum(CASE WHEN is_wicket=1 AND coalesce(wk,'') NOT IN ('retired hurt','retired not out') THEN 1 ELSE 0 END)
    OVER (PARTITION BY mid, inn ORDER BY seq ROWS UNBOUNDED PRECEDING)
    - CASE WHEN is_wicket=1 AND coalesce(wk,'') NOT IN ('retired hurt','retired not out') THEN 1 ELSE 0 END inn_wkts
FROM b0;
DROP TABLE b0;
-- the bowler's spell: overs he bowls every other over without a break (a day break also ends it)
CREATE TABLE bov AS SELECT mid, inn, ov, bowl, min(seq) s0, min(cum_legal) cum0 FROM b1 GROUP BY ALL;
CREATE TABLE bov2 AS
SELECT bov.*, ml.day_balls, least(m.n_dates, 1 + floor(cum0 / ml.day_balls)::INT) dy,
  ov - lag(ov) OVER (PARTITION BY mid, inn, bowl ORDER BY ov) gap
FROM bov JOIN mlen ml USING(mid) JOIN m USING(mid);
CREATE TABLE bov3 AS SELECT *, sum(CASE WHEN gap IS NULL OR gap > 2 OR dy <> lag_dy THEN 1 ELSE 0 END)
  OVER (PARTITION BY mid, inn, bowl ORDER BY ov ROWS UNBOUNDED PRECEDING) spell_id
FROM (SELECT *, lag(dy) OVER (PARTITION BY mid, inn, bowl ORDER BY ov) lag_dy FROM bov2);
CREATE TABLE bov4 AS SELECT *, row_number() OVER (PARTITION BY mid, inn, bowl, spell_id ORDER BY ov) spell_pos,
  count(*) OVER (PARTITION BY mid, inn, bowl, spell_id) spell_len,
  row_number() OVER (PARTITION BY mid, inn, bowl ORDER BY ov) bowl_inn_over
FROM bov3;
-- previous innings totals for the lead / target
CREATE TABLE prevrun AS
SELECT i.match_id mid, i.inn,
  coalesce((SELECT sum(j.runs) FROM inn j WHERE j.match_id = i.match_id AND j.inn < i.inn AND j.team = i.team), 0) own_prev,
  coalesce((SELECT sum(j.runs) FROM inn j WHERE j.match_id = i.match_id AND j.inn < i.inn AND j.team <> i.team), 0) opp_prev,
  i.declared, i.legal inn_total_legal, i.runs inn_total_runs, i.wkts inn_total_wkts, i.absent_hurt
FROM inn i;
CREATE TABLE tb AS
SELECT b1.*, m.gender, m.yr, m.date, m.country, m.region, m.n_dates, ml.day_balls,
  CASE {era_sql} ELSE 0 END era,
  CASE WHEN b1.bteam = 'England' AND m.date >= DATE '{BAZBALL_FROM}' THEN 1 ELSE 0 END baz,
  coalesce(pt.btype, 'unknown') btype, pt.ci bowl_ci, pb.ci bat_ci,
  least(m.n_dates, 1 + floor(b1.cum_legal / ml.day_balls)::INT) dy,
  CASE WHEN (CASE b1.bteam {team_map} ELSE 'X' END) = m.country THEN 'home'
       WHEN (CASE b1.fteam {team_map} ELSE 'X' END) = m.country THEN 'away' ELSE 'neutral' END home,
  o.spell_pos, o.spell_len, o.bowl_inn_over, o.spell_id,
  pr.own_prev, pr.opp_prev, pr.declared inn_declared, pr.inn_total_legal, pr.inn_total_runs, pr.inn_total_wkts,
  pr.own_prev + b1.inn_runs - pr.opp_prev lead,
  CASE WHEN b1.inn = 4 THEN pr.opp_prev - pr.own_prev + 1 - b1.inn_runs END need,
  greatest(0, (CASE WHEN m.gender='female' THEN {SCHED_DAYS['female']} ELSE {SCHED_DAYS['male']} END) * ml.day_balls - b1.cum_legal) / 6.0 overs_left
FROM b1 JOIN m USING(mid) JOIN mlen ml USING(mid)
LEFT JOIN ptype pt ON pt.cs = b1.bowl LEFT JOIN ptype pb ON pb.cs = b1.bat
LEFT JOIN bov4 o ON o.mid = b1.mid AND o.inn = b1.inn AND o.ov = b1.ov AND o.bowl = b1.bowl
LEFT JOIN prevrun pr ON pr.mid = b1.mid AND pr.inn = b1.inn;
DROP TABLE b1;
SELECT gender, count(*) n FROM tb GROUP BY 1;""", json_out=False)


def write_espn_styles():
    src = ROOT / "data" / "scraped" / "espn-players.json"
    with open(TMP / "espn_styles.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["espn_id", "bowl", "bat"])
        if src.exists():
            for x in json.load(open(src)):
                p = x.get("profile") or {}
                bs = p.get("bowlingStyles") or []
                bt = p.get("battingStyles") or []
                w.writerow([p.get("espnId"), bs[0] if bs else "", bt[0] if bt else ""])



# ── 3. The ball model: IPF on the log-linear Poisson rates ─────────────────────────────────────────────────────────

COUNTRY_IDX = {c: i for i, c in enumerate(COUNTRIES)}
# INNINGS_TERM adds an innings-within-match random effect. Tried and left out: it soaks up collapses (a wicket brings in a new,
# vulnerable batter, so the set-ness effect vanishes into "a bad innings"), and its large wicket spread drawn per innings in
# the engine runs into exposure (bad innings are short), which put the benchmark further from the real Tests.
INNINGS_TERM = bool(os.environ.get("INNINGS_TERM"))
FACTORS = ["age", "set", "inn", "wd", "dt", "spell", "sit", "home", "ct", "era", "baz", "match"] + (["innid"] if INNINGS_TERM else []) + ["bat", "bowl"]
PLAYER_FACTORS = {"bat", "bowl"}
# a match's own conditions (pitch, weather, ball) beyond its country: a random effect shrunk with a 1500-ball prior
MATCH_PRIOR_BALLS = 1500
# an innings' own conditions within its match (so the situation factors are measured within innings: a chase going well is
# not mistaken for the effect of needing few runs an over), shrunk with a 400-ball prior
INNINGS_PRIOR_BALLS = 400
# which factors each outcome class is fitted with (extras do not depend on the batter; byes not on the bowler either)
OUTCOME_FACTORS = {k: FACTORS for k in ["1", "2", "3", "4", "6", "W"]}
OUTCOME_FACTORS.update({k: [f for f in FACTORS] for k in ["1", "2", "3", "4", "6", "W"]})
OUTCOME_FACTORS.update({
    "wide": ["age", "set", "inn", "dt", "spell", "sit", "home", "ct", "era", "match", "bowl"],
    "nb": ["age", "inn", "dt", "spell", "home", "ct", "era", "match", "bowl"],
    "bye": ["age", "inn", "dt", "home", "ct", "era", "match"],
})
ITERS = int(os.environ.get("IPF_ITERS", "10"))


def build_fit_table():
    ct_case = " ".join(f"WHEN '{c}' THEN {i}" for c, i in COUNTRY_IDX.items())
    duck(f"""
CREATE OR REPLACE TABLE fb AS
SELECT row_number() OVER () rid, gender, yr, mid, inn,
  {bin_sql('(ov - 80 * floor(ov / 80))', AGE_BINS)} f_age,
  {bin_sql('setb', SET_BINS)} f_set,
  inn - 1 f_inn,
  (inn - 1) * {len(WD_BINS)} + {bin_sql('inn_wkts', WD_BINS)} f_wd,
  (least(dy, 5) - 1) * 2 + CASE WHEN btype = 'spin' THEN 1 ELSE 0 END f_dt,
  least(coalesce(spell_pos, 1), {SPELL_MAX}) - 1 f_spell,
  CASE WHEN inn <= 3 AND inn_declared = 1 AND inn_total_legal - inn_legal <= {PUSH_OVERS * 6} THEN 1
       WHEN inn = 4 THEN 2 + {bin_sql(f'need / greatest(CASE WHEN gender = {chr(39)}female{chr(39)} THEN {SCHED_DAYS["female"] * 100} ELSE {SCHED_DAYS["male"] * DAY_OVERS} END - cum_legal / 6.0, 1.0)', RR_BINS)}
       ELSE 0 END f_sit,
  CASE home WHEN 'home' THEN 0 WHEN 'away' THEN 1 ELSE 2 END f_home,
  coalesce(CASE country {ct_case} END, {len(COUNTRIES)}) * 2 + CASE WHEN btype = 'spin' THEN 1 ELSE 0 END f_ct,
  era f_era, baz f_baz,
  dense_rank() OVER (ORDER BY mid) - 1 f_match, dense_rank() OVER (ORDER BY mid, inn) - 1 f_innid, dense_rank() OVER (ORDER BY bat) - 1 f_bat, dense_rank() OVER (ORDER BY bowl) - 1 f_bowl,
  CASE WHEN wides > 0 THEN 'wide' WHEN noballs > 0 THEN 'nb'
       WHEN is_wicket = 1 AND coalesce(wk, '') NOT IN ('retired hurt', 'retired not out') THEN 'W'
       WHEN byes + legbyes > 0 AND rb = 0 THEN 'bye'
       WHEN rb = 6 THEN '6' WHEN rb = 4 AND nonb = 0 THEN '4' WHEN rb >= 3 THEN '3' WHEN rb = 2 THEN '2' WHEN rb = 1 THEN '1'
       ELSE 'dot' END cls,
  bat, bowl, bat_ci, bowl_ci, btype
FROM tb WHERE yr >= {FIT_FROM} AND (gender = 'female' OR yr >= {FIT_FROM});""", json_out=False)


def fit_outcome(k):
    """IPF for one outcome class on men's balls; returns {factor: {level: log multiplier}} and the log base rate."""
    facs = OUTCOME_FACTORS[k]
    rate = duck(f"SELECT avg(CASE WHEN cls = '{k}' THEN 1.0 ELSE 0 END) p FROM fb WHERE gender = 'male'")[0]["p"]
    cols = ", ".join(f"f_{f}" for f in facs)
    zero = ", ".join(f"0.0::DOUBLE l_{f}" for f in facs)
    sql = [f"""CREATE OR REPLACE TABLE w AS SELECT rid, {cols}, CASE WHEN cls = '{k}' THEN 1.0 ELSE 0.0 END y, {zero},
  ln({rate}) lm FROM fb WHERE gender = 'male';"""]
    for it in range(ITERS):
        for f in facs:
            a = (PRIOR_BALLS * rate if f in PLAYER_FACTORS else MATCH_PRIOR_BALLS * rate if f == "match"
                 else INNINGS_PRIOR_BALLS * rate if f == "innid" else 0.5)
            sql.append(f"""CREATE OR REPLACE TABLE u AS SELECT f_{f} lv, ln((sum(y) + {a}) / (sum(exp(lm - l_{f})) + {a})) nl FROM w GROUP BY 1;
UPDATE w SET lm = w.lm - w.l_{f} + u.nl, l_{f} = u.nl FROM u WHERE w.f_{f} = u.lv;""")
    sql.append(f"CREATE OR REPLACE TABLE fit_{k} AS SELECT * FROM w;")
    if REUSE and os.environ.get("REUSE_FIT"):
        try:
            duck(f"SELECT count(*) FROM fit_{k}")
            return
        except SystemExit:
            pass
    t0 = time.time()
    duck("\n".join(sql), json_out=False)
    log(f"ipf {k}: {time.time() - t0:.0f}s")



# The engine's baseline era: the base rates are those of men's Tests from 2023 (the game is played today). Every era from 2006
# still informs the context factors; only the level is the modern one. (Up to round 4 the base was a 1 : 1.5 : 2 mix of
# 2015-18, 2019-22 and 2023+, which made a ~2020 level that the benchmark then compared with all Tests since 2015.)
ERA_WEIGHTS = [0.0, 0.0, 0.0, 0.0, 1.0]
CONTEXT = ["age", "set", "inn", "wd", "dt", "spell", "sit", "home", "ct", "era", "baz"]


def ref_where():
    return f"gender = 'male' AND yr >= {VALID_FROM}"


def recentre(k):
    """Copy outcome k's fitted log terms into table z (men's balls) and move the means of the nested terms into their parents,
    which leaves every prediction unchanged: match terms are centred within country and within era (so the engine can draw a
    match's own conditions around zero), bowler terms within pace / spin and the country x type terms within type (so a
    bowler's rating maps onto a type-free quality and the type's own level sits in the day x type factor)."""
    facs = OUTCOME_FACTORS[k]
    wcase = "CASE fb.f_era " + " ".join(f"WHEN {i} THEN {w}" for i, w in enumerate(ERA_WEIGHTS)) + " END"
    cols = ", ".join(f"w.f_{f}, w.l_{f} a_{f}" for f in facs) + "".join(f", w.l_{f} l_{f}_raw" for f in ("bat", "bowl") if f in facs)
    duck(f"""CREATE OR REPLACE TABLE z AS SELECT w.rid, w.y, w.lm, {cols}, fb.yr, fb.f_dt % 2 spin, fb.f_ct // 2 cty, fb.f_era era_,
  {wcase} wt, fb.yr >= {VALID_FROM} isref, fb.bat, fb.bowl, fb.bat_ci, fb.bowl_ci, fb.mid
FROM fit_{k} w JOIN fb USING(rid) WHERE fb.gender = 'male';""", json_out=False)

    def move(term, parent, group, where=""):
        duck(f"""CREATE OR REPLACE TABLE c AS SELECT {group} g, ln(sum(wt2 * exp(a_{term})) / sum(wt2)) c FROM
  (SELECT *, {'wt' if where else '1.0'} wt2 FROM z {where}) GROUP BY 1;
UPDATE z SET a_{term} = z.a_{term} - c.c, a_{parent} = z.a_{parent} + c.c FROM c WHERE z.{group} = c.g;""", json_out=False)

    if "innid" in facs:
        move("innid", "match", "mid")
    if "match" in facs:
        for _ in range(3):
            move("match", "ct", "cty")
            move("match", "era", "era_")
    if "bowl" in facs:
        move("bowl", "dt", "spin", "WHERE isref")
    move("ct", "dt", "spin", "WHERE isref")


def extract(k):
    """Normalised factor tables for outcome k: every context factor has weighted mean 1 over men's Tests since 2015
    (eras weighted by ERA_WEIGHTS), Bazball off = 1; players and the match term likewise; the base makes the weighted
    prediction match the weighted count."""
    facs = OUTCOME_FACTORS[k]
    recentre(k)
    out = {"factors": {}}
    means = {}
    for f in facs:
        if f == "baz":
            means[f] = math.exp(duck("SELECT any_value(a_baz) l FROM z WHERE f_baz = 0")[0]["l"])
        elif f in PLAYER_FACTORS or f == "match":
            # players and matches are centred over all Tests since 2015, the pool the rating maps are centred on; the base
            # then carries the modern level for players as the maps rate them
            means[f] = duck(f"SELECT avg(exp(a_{f})) m FROM z WHERE isref")[0]["m"]
        else:
            means[f] = duck(f"SELECT sum(wt * exp(a_{f})) / sum(wt) m FROM z WHERE isref")[0]["m"]
        if f in CONTEXT:
            rows = duck(f"SELECT f_{f} lv, any_value(a_{f}) l, count(*) n FROM z GROUP BY 1 ORDER BY 1")
            out["factors"][f] = {int(x["lv"]): math.exp(x["l"]) / means[f] for x in rows}
    norm = " + ".join(f"a_{f} - ln({means[f]})" for f in facs)
    b = duck(f"SELECT sum(wt * y) o, sum(wt * exp({norm})) e FROM z WHERE isref")[0]
    out["base"] = b["o"] / b["e"]
    # player terms (log, normalised) with the balls behind them
    for f, idc, cic in (("bat", "bat", "bat_ci"), ("bowl", "bowl", "bowl_ci")):
        if f not in facs:
            continue
        rows = duck(f"""SELECT {idc} id, any_value({cic}) ci, any_value(spin) spin, count(*) n, sum(CASE WHEN isref THEN 1 ELSE 0 END) n_ref,
  any_value(a_{f}) - ln({means[f]}) l, sum(y) o, sum(exp(lm - l_{f}_raw)) e FROM z GROUP BY 1""")
        # [cricinfo id, spin, balls, balls since 2015, log term, observed, expected without the term]
        out[f] = {x["id"]: [x["ci"], int(x["spin"]), int(x["n"]), int(x["n_ref"]), x["l"], x["o"], x["e"]] for x in rows}
    # a match's own conditions: the raw observed / expected ratio against everything but the match term, centred within
    # country; its spread less the Poisson sampling noise is the true spread the engine draws from
    if "match" in facs:
        rows = duck(f"""WITH t AS (SELECT mid, any_value(cty) cty, bool_or(isref) isref, sum(y) o, sum(exp(lm - a_match)) e,
    sum(exp({norm})) e_norm FROM z GROUP BY 1)
  SELECT mid, cty, isref, o, e, ln((o + 0.5) / (e + 0.5)) raw FROM t""")
        out["match"] = {x["mid"]: [int(x["cty"]), bool(x["isref"]), x["o"], x["e"], x["raw"]] for x in rows}
    if "innid" in facs:
        # an innings' own conditions: observed / expected without the innings term, per (match, innings)
        rows = duck("""SELECT mid, f_innid, sum(y) o, sum(exp(lm - a_innid)) e FROM z GROUP BY 1, 2""")
        out["innings"] = {f"{x['mid']}|{int(x['f_innid'])}": [x["o"], x["e"]] for x in rows}
    out["means"] = means
    return out


def fit_all():
    cache = TMP / "model_fit.json"
    if REUSE and os.environ.get("REUSE_FIT") and cache.exists():
        log("ipf: reusing", cache)
        return json.load(open(cache))
    model = {}
    for k in OUTCOMES:
        fit_outcome(k)
        model[k] = extract(k)
    json.dump(model, open(cache, "w"))
    return model



# ── 4. Ratings -> player terms ─────────────────────────────────────────────────────────────────────────────────────

BAT_ATTRS = ["battingIQ", "timing", "power", "running"]
BOWL_ATTRS = ["wicketTaking", "economy", "accuracy"]
# attributes allowed for each player term, with the sign a better player must have (a wrong-signed weight is dropped)
BAT_MIX = {"1": {"battingIQ": 1, "timing": 1, "running": 1}, "2": {"battingIQ": 1, "timing": 1, "running": 1},
           "3": {"battingIQ": 1, "timing": 1, "running": 1}, "4": {"timing": 1, "power": 1, "battingIQ": 1},
           "6": {"power": 1, "timing": 1}, "W": {"battingIQ": -1, "timing": -1, "running": -1}}
BOWL_MIX = {k: {"economy": -1, "accuracy": -1, "wicketTaking": -1} for k in ["1", "2", "3", "4", "6"]}
BOWL_MIX.update({"W": {"wicketTaking": 1, "economy": 1, "accuracy": 1}, "wide": {"accuracy": -1}, "nb": {"accuracy": -1}})
MIN_BALLS_MAP = 300
CURVE_MIN_BALLS = 30
CURVE_BINS = 10
STRETCH_MIN_R = 0.2
STRETCH_MAX = 2.0
STRETCH_TERMS = {"W"}
RIDGE = 0.05


def solve(A, b):
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        piv = max(range(c, n), key=lambda q: abs(M[q][c]))
        M[c], M[piv] = M[piv], M[c]
        for q in range(n):
            if q != c and M[c][c] != 0:
                f = M[q][c] / M[c][c]
                for j in range(c, n + 1):
                    M[q][j] -= f * M[c][j]
    return [M[i][n] / M[i][i] if M[i][i] else 0.0 for i in range(n)]


FORMAT_RATINGS = Path(os.environ.get("FORMAT_RATINGS", str(REPO / "packages" / "app" / "public" / "data" / "format-ratings.json")))
CORE_KEYS = ["battingIQ", "timing", "power", "running", "wicketTaking", "economy", "accuracy", "clutch"]


def load_test_sets():
    """The players' Test ratings (packages/app/public/data/format-ratings.json from the ratings pipeline: sourceId -> [odi, test],
    each set the eight attributes then 1 = measured / 0 = derived), or {} when the file is not there."""
    if not FORMAT_RATINGS.exists():
        log("no format ratings at", FORMAT_RATINGS, "- Test players are rated on their T20 ratings only")
        return {}
    f = json.load(open(FORMAT_RATINGS))
    out = {}
    for sid, sets in (f.get("players") or {}).items():
        t = sets[1] if len(sets) > 1 else None
        if t and len(t) >= 9:
            out[sid] = {"ratings": dict(zip(CORE_KEYS, t[:8])), "source": "data" if t[8] == 1 else "derived"}
    log(f"format ratings: {len(out)} Test sets from {FORMAT_RATINGS}")
    return out


def load_game_players(kind, test_sets):
    """The game's players by espn id, men only (the Test fit is men's), rated on their T20 ratings (kind "t20") or on their Test
    ratings (kind "test": only players who have a Test set)."""
    out = {}
    for p in json.load(open(DATA / "game_players.json")):
        if p.get("g", "male") != "male":
            continue
        if kind == "test":
            t = test_sets.get(p["id"])
            if t:
                out[p["id"]] = {**p, "r": t["ratings"]}
        else:
            out[p["id"]] = p
    return out


def pav(xs, ws, increasing):
    """Pool-adjacent-violators: the weighted monotone (non-decreasing or non-increasing) fit to xs"""
    blocks = [[x if increasing else -x, w, 1] for x, w in zip(xs, ws)]
    out = []
    for b in blocks:
        out.append(b)
        while len(out) > 1 and out[-2][0] > out[-1][0]:
            v2, w2, n2 = out.pop()
            v1, w1, n1 = out.pop()
            out.append([(v1 * w1 + v2 * w2) / (w1 + w2), w1 + w2, n1 + n2])
    res = []
    for v, w, n in out:
        res += [v if increasing else -v] * n
    return res


def rating_map(model, gp):
    """For each player term: an attribute mix and a calibration curve from it to the term.
    The mix is a sign-constrained ridge regression of the player's raw observed / expected ratio on his z-scored ratings
    (precision weighted, players with 300+ balls since 2015). The curve maps the mix onto the term empirically: players with
    30+ balls (tail-enders included) in CURVE_BINS bins of equal expected events, each bin's pooled observed / expected
    ratio, made monotone, then centred so the ball-weighted mean over the pool is 1. So a rating means what the real players
    with that rating did: steep at the ends (a number eleven, the very best batters), flat where ratings barely tell players
    apart. Bowlers' attributes are standardised within pace / spin, as their fitted terms are."""
    res = {"bat": {}, "bowl": {}, "pool": {}}
    for f, attrs, mixes in (("bat", BAT_ATTRS, BAT_MIX), ("bowl", BOWL_ATTRS, BOWL_MIX)):
        pools = {}
        for k in mixes:
            rows = []
            for cs, v in model[k][f].items():
                ci, spin, n, nref, l, o, e = v
                if nref < CURVE_MIN_BALLS or not ci:
                    continue
                p = gp.get(f"espn_{int(ci)}")
                if p:
                    g = ("spin" if spin else "pace") if f == "bowl" else "all"
                    rows.append((p, nref, math.log((o + 0.5) / (e + 0.5)), 1 / (e + 0.5), g, o, e))
            reg = [x for x in rows if x[1] >= MIN_BALLS_MAP]
            if not pools:
                for g in sorted(set(x[4] for x in reg)):
                    xs = [x for x in reg if x[4] == g]
                    mu = {a: sum(x[0]["r"][a] for x in xs) / len(xs) for a in attrs}
                    sd = {a: math.sqrt(sum((x[0]["r"][a] - mu[a]) ** 2 for x in xs) / len(xs)) or 1 for a in attrs}
                    pools[g] = {"n": len(xs), "mean": {a: r(mu[a], 2) for a in attrs}, "sd": {a: r(sd[a], 2) for a in attrs}}
            zof = lambda x, a: (x[0]["r"][a] - pools[x[4]]["mean"][a]) / pools[x[4]]["sd"][a]
            N = len(reg)
            mr = {g: sum(x[2] for x in reg if x[4] == g) / max(1, sum(1 for x in reg if x[4] == g)) for g in pools}
            dev = [x[2] - mr[x[4]] for x in reg]
            tau2 = max(1e-4, sum(d_ * d_ for d_ in dev) / N - sum(x[3] for x in reg) / N)
            use = dict(mixes[k])
            beta = []
            for _ in range(len(use) + 1):
                names = list(use)
                Z = [[zof(x, a) for a in names] for x in reg]
                w = [1 / (tau2 + x[3]) for x in reg]
                A = [[sum(w[i] * Z[i][p_] * Z[i][q] for i in range(N)) + (RIDGE * sum(w) if p_ == q else 0) for q in range(len(names))] for p_ in range(len(names))]
                beta = solve(A, [sum(w[i] * Z[i][p_] * dev[i] for i in range(N)) for p_ in range(len(names))])
                wrong = [a for a, b_ in zip(names, beta) if b_ * use[a] < 0]
                if not wrong:
                    break
                for a in wrong:
                    use.pop(a)
                if not use:
                    break
            if not use:
                res[f][k] = {"weights": {}, "knots": [[0, 0]], "c": 0 if f == "bat" else {g: 0 for g in pools}, "tau": r(math.sqrt(tau2)), "r": 0, "n": N}
                continue
            names = list(use)
            # the mix in "z units": weights normalised to sum to 1 in absolute value, sign kept
            norm_ = sum(abs(b_) for b_ in beta)
            wts = {a: b_ / norm_ for a, b_ in zip(names, beta)}
            comp = lambda x: sum(wts[a] * zof(x, a) for a in names)
            pts = sorted(((comp(x), x) for x in rows), key=lambda t: t[0])
            tot_e = sum(x[6] for _, x in pts)
            bins, cur, acc = [], [], 0.0
            for c_, x in pts:
                cur.append((c_, x))
                acc += x[6]
                if acc >= tot_e / CURVE_BINS and len(bins) < CURVE_BINS - 1:
                    bins.append(cur); cur, acc = [], 0.0
            if cur:
                bins.append(cur)
            kx = [sum(c_ * x[6] for c_, x in b) / sum(x[6] for _, x in b) for b in bins]
            ky = [math.log((sum(x[5] for _, x in b) + 0.5) / (sum(x[6] for _, x in b) + 0.5)) for b in bins]
            kw = [sum(x[6] for _, x in b) for b in bins]
            ky = pav(ky, kw, increasing=True)  # the mix is oriented so a higher value means a higher rate
            # In the game a rating is the player's skill. For the wicket term (a batter's survival, a bowler's wicket-taking)
            # the measured curve, which regresses to the mean as far as the ratings are noisy, is stretched about its centre to
            # the term's true spread (at most STRETCH_MAX times) where the ratings do rank players (r >= STRETCH_MIN_R). The
            # scoring terms keep their measured curves: stretching every term at once (all driven by the same ratings) made
            # strong sides far too dominant (benchmark-test.ts, docs/FORMATS-TEST.md section 5).
            ybar = sum(y_ * w_ for y_, w_ in zip(ky, kw)) / sum(kw)
            stretch = 1.0
            ky0 = list(ky)
            curve = lambda c_: ky[0] if c_ <= kx[0] else ky[-1] if c_ >= kx[-1] else next(
                ky[i] + (ky[i + 1] - ky[i]) * (c_ - kx[i]) / (kx[i + 1] - kx[i]) for i in range(len(kx) - 1) if kx[i] <= c_ <= kx[i + 1])
            cs_ = {}
            for g in pools:
                xs = [x for _, x in pts if x[4] == g]
                tot = sum(x[1] for x in xs)
                cs_[g] = r(-math.log(sum(x[1] * math.exp(curve(comp(x))) for x in xs) / tot))
            pred = [curve(comp(x)) for x in reg]
            mp = sum(pred) / N
            my = sum(dev) / N
            sp = math.sqrt(sum((v - mp) ** 2 for v in pred) / N) or 1
            sy = math.sqrt(sum((v - my) ** 2 for v in dev) / N)
            corr = sum((a_ - mp) * (b_ - my) for a_, b_ in zip(pred, dev)) / N / sp / sy
            if k in STRETCH_TERMS and corr >= STRETCH_MIN_R and sp < math.sqrt(tau2):
                stretch = min(STRETCH_MAX, math.sqrt(tau2) / sp)
                ky = [ybar + stretch * (y_ - ybar) for y_ in ky0]
                for g in pools:
                    xs = [x for _, x in pts if x[4] == g]
                    tot = sum(x[1] for x in xs)
                    cs_[g] = r(-math.log(sum(x[1] * math.exp(curve(comp(x))) for x in xs) / tot))
                pred = [curve(comp(x)) for x in reg]
                mp = sum(pred) / N
                sp = math.sqrt(sum((v - mp) ** 2 for v in pred) / N) or 1
            res[f][k] = {"weights": {a: r(w_) for a, w_ in wts.items()}, "knots": [[r(a_, 3), r(b_)] for a_, b_ in zip(kx, ky)],
                         "c": cs_["all"] if f == "bat" else cs_, "tau": r(math.sqrt(tau2)), "spread": r(sp), "stretch": r(stretch, 3), "r": r(corr, 3), "n": len(rows)}
        res["pool"][f] = pools["all"] if f == "bat" else pools
    return res


ALL_ATTRS = ["battingIQ", "timing", "power", "running", "wicketTaking", "economy", "accuracy", "clutch"]
POS_GROUPS = ["1-3", "4-6", "7-11"]
HOLDOUT_FROM = 2023
REG_RIDGE = 0.10
REG_MIN_BALLS = 300


def player_periods(term, k):
    """Per player: observed and expected (without his own term) count of outcome k, before HOLDOUT_FROM and from it."""
    col = "bat" if term == "bat" else "bowl"
    rows = duck(f"""SELECT f.{col} id, CASE WHEN f.yr >= {HOLDOUT_FROM} THEN 1 ELSE 0 END recent, sum(w.y) o, sum(exp(w.lm - w.l_{col})) e, count(*) n
FROM fit_{k} w JOIN fb f USING(rid) WHERE f.gender = 'male' GROUP BY 1, 2""")
    out = {}
    for x in rows:
        out.setdefault(x["id"], {})["test" if int(x["recent"]) == 1 else "train"] = (x["o"], x["e"], int(x["n"]))
    return out


def usual_positions():
    """A batter's usual place in the order: his median order of arrival over his Test innings (men, 2006 on)"""
    duck("""CREATE OR REPLACE TABLE arrp_all AS WITH fb_ AS (SELECT mid, inn, p, min(seq) s FROM (SELECT mid, inn, bat p, seq FROM tb WHERE gender = 'male'
  UNION ALL SELECT mid, inn, nst p, seq FROM tb WHERE gender = 'male') GROUP BY ALL) SELECT mid, inn, p, row_number() OVER (PARTITION BY mid, inn ORDER BY s, p) pos FROM fb_""", json_out=False)
    return {x["p"]: x["mp"] for x in duck("SELECT p, median(pos) mp FROM arrp_all GROUP BY 1")}


def pos_group(pos):
    return 0 if pos <= 3 else 1 if pos <= 6 else 2


def wls(X, y, w, ridge):
    """Weighted ridge least squares (no penalty on the intercept, column 0)"""
    n_ = len(X[0])
    A = [[sum(w[i] * X[i][a] * X[i][b] for i in range(len(X))) + (ridge * sum(w) if a == b and a > 0 else 0) for b in range(n_)] for a in range(n_)]
    return solve(A, [sum(w[i] * X[i][a] * y[i] for i in range(len(X))) for a in range(n_)])


def rating_regression(model, gp, ratings_kind):
    """For each player term: a precision-weighted ridge regression of the player's observed / expected ratio on all eight of his
    z-scored ratings, and for batters on the position group he usually bats in (1-3, 4-6, 7-11), so survival comes from the
    attributes that predict real survival, scoring from those that predict real scoring, and the group takes the role effects
    (a tail-ender swinging). Fitted on players with REG_MIN_BALLS+ balls; checked out of sample (fitted on the terms before
    HOLDOUT_FROM, scored against the same players' terms from it, against the curve map and against no map at all). The
    intercept makes the ball-weighted mean term 1 over the pool (bowlers per type)."""
    pos = usual_positions()
    res = {"bat": {}, "bowl": {}, "pool": {}, "holdout": {}}
    for f, mix in (("bat", BAT_MIX), ("bowl", BOWL_MIX)):
        pools = {}
        for k in mix:
            per = player_periods(f, k)
            rows = []
            for cs, v in model[k][f].items():
                ci, spin, n, nref, l, o, e = v
                p = gp.get(f"espn_{int(ci)}") if ci else None
                if not p or n < 60:
                    continue
                g = ("spin" if spin else "pace") if f == "bowl" else "all"
                grp = pos_group(pos.get(cs, 7)) if f == "bat" else 0
                rows.append({"p": p, "g": g, "grp": grp, "o": o, "e": e, "n": n, "nref": nref, "per": per.get(cs, {})})
            if not pools:
                for g in sorted(set(x["g"] for x in rows)):
                    xs = [x for x in rows if x["g"] == g and x["n"] >= REG_MIN_BALLS]
                    mu = {a: sum(x["p"]["r"][a] for x in xs) / len(xs) for a in ALL_ATTRS}
                    sd = {a: math.sqrt(sum((x["p"]["r"][a] - mu[a]) ** 2 for x in xs) / len(xs)) or 1 for a in ALL_ATTRS}
                    pools[g] = {"n": len(xs), "mean": {a: r(mu[a], 2) for a in ALL_ATTRS}, "sd": {a: r(sd[a], 2) for a in ALL_ATTRS}}
            zof = lambda x, a: (x["p"]["r"][a] - pools[x["g"]]["mean"][a]) / pools[x["g"]]["sd"][a]
            feats = lambda x: [1.0] + [zof(x, a) for a in ALL_ATTRS] + ([1.0 if x["grp"] == 1 else 0.0, 1.0 if x["grp"] == 2 else 0.0] if f == "bat" else [])
            def fit_on(sel, oe):
                xs = [x for x in rows if sel(x)]
                ys = [math.log((oe(x)[0] + 0.5) / (oe(x)[1] + 0.5)) for x in xs]
                my = sum(ys) / len(ys)
                tau2 = max(1e-4, sum((y_ - my) ** 2 for y_ in ys) / len(ys) - sum(1 / (oe(x)[1] + 0.5) for x in xs) / len(xs))
                ws = [1 / (tau2 + 1 / (oe(x)[1] + 0.5)) for x in xs]
                return wls([feats(x) for x in xs], ys, ws, REG_RIDGE), tau2
            # out of sample: fit before HOLDOUT_FROM, score on the same players from it
            tr = lambda x: x["per"].get("train", (0, 0, 0))
            te = lambda x: x["per"].get("test", (0, 0, 0))
            beta_tr, _ = fit_on(lambda x: tr(x)[2] >= REG_MIN_BALLS, tr)
            ev = [x for x in rows if te(x)[1] >= 1.0 and tr(x)[2] >= REG_MIN_BALLS]
            if ev:
                yt = [math.log((te(x)[0] + 0.5) / (te(x)[1] + 0.5)) for x in ev]
                wt = [te(x)[1] for x in ev]
                pr = [sum(b_ * v for b_, v in zip(beta_tr, feats(x))) for x in ev]
                # deviance of the Poisson counts: no map (each player at the period mean), and the regression's prediction
                def dev(pred):
                    tot = 0.0
                    m0 = math.log(sum(te(x)[0] for x in ev) / sum(te(x)[1] for x in ev))
                    for x, q in zip(ev, pred):
                        o_, e_ = te(x)[0], te(x)[1]
                        mu_ = e_ * math.exp(q if q is not None else m0)
                        tot += 2 * ((o_ * math.log(o_ / mu_) if o_ > 0 else 0) - (o_ - mu_))
                    return tot
                # the regression's predictions recentred to the test period's mean (the hold-out checks the ranking, not the era level)
                shift = math.log(sum(te(x)[0] for x in ev) / sum(te(x)[1] * math.exp(q) for x, q in zip(ev, pr)))
                d0, d1 = dev([None] * len(ev)), dev([q + shift for q in pr])
                res["holdout"].setdefault(f, {})[k] = {"players": len(ev), "devianceNoMap": r(d0, 1), "devianceRegression": r(d1, 1), "gain": r(1 - d1 / d0, 4)}
            beta, tau2 = fit_on(lambda x: x["n"] >= REG_MIN_BALLS, lambda x: (x["o"], x["e"], x["n"]))
            # the wicket term: as with the curves, the attribute part is stretched to the term's true spread (at most
            # STRETCH_MAX): in the game the rating is the player's skill, and the regression regresses to the mean as far as
            # the ratings are noisy (strong sides were too weak without it); the position offsets stay as fitted
            stretch = 1.0
            if k in STRETCH_TERMS:
                xs0 = [x for x in rows if x["n"] >= REG_MIN_BALLS]
                att = [sum(b_ * zof(x, a) for b_, a in zip(beta[1:9], ALL_ATTRS)) for x in xs0]
                ma = sum(att) / len(att)
                sa = math.sqrt(sum((q - ma) ** 2 for q in att) / len(att)) or 1
                stretch = max(1.0, min(STRETCH_MAX, math.sqrt(tau2) / sa))
                beta = [beta[0]] + [b_ * stretch for b_ in beta[1:9]] + list(beta[9:])
            weights = {a: r(b_, 4) for a, b_ in zip(ALL_ATTRS, beta[1:9])}
            posw = [0.0] + [r(b_, 4) for b_ in beta[9:]] if f == "bat" else None
            lin = lambda x: sum(b_ * v for b_, v in zip(beta[1:], feats(x)[1:]))
            cs_ = {}
            for g in pools:
                xs = [x for x in rows if x["g"] == g and x["nref"] >= 30]
                tot = sum(x["nref"] for x in xs)
                cs_[g] = r(-math.log(sum(x["nref"] * math.exp(lin(x)) for x in xs) / tot))
            xs = [x for x in rows if x["n"] >= REG_MIN_BALLS]
            pred = [lin(x) for x in xs]
            mp = sum(pred) / len(pred)
            res[f][k] = {"weights": weights, **({"pos": posw} if posw else {}), "c": cs_["all"] if f == "bat" else cs_,
                         "tau": r(math.sqrt(tau2)), "spread": r(math.sqrt(sum((q - mp) ** 2 for q in pred) / len(pred))), "stretch": r(stretch, 3), "n": len(xs)}
        res["pool"][f] = pools["all"] if f == "bat" else pools
    log(f"rating regression ({ratings_kind}): out-of-sample deviance gain " + ", ".join(f"{f}.{k} {v['gain']:.3f}" for f, d in res["holdout"].items() for k, v in d.items()))
    return res


# Which player terms take the per-outcome regression (all eight attributes, plus the batting-position group) rather than the
# single-composite calibration curve (docs/FORMATS-TEST.md section 6.6): every batter term, so scoring rate comes from the
# attributes that predict real scoring and survival from those that predict survival, and the position group carries role
# effects (an opener's survival is no better than a number five's despite better ratings). Out of sample the regression beats
# the curve on scoring and comes close on survival (0.46 vs 0.50 deviance gain), where only it has the position term. The
# bowler's wicket term keeps its stretched curve (it carries the team spread), his threes and no-balls their near-flat curves
# (the regression did worse than no map there).
REGRESSION_TERMS = {"bat": ["1", "2", "3", "4", "6"], "bowl": ["1", "2", "4", "6", "wide"]}


def curve_value(term, pool, ratings):
    x = sum(w * (ratings[a] - pool["mean"][a]) / (pool["sd"][a] or 1) for a, w in term["weights"].items())
    k = term["knots"]
    if x <= k[0][0]:
        return k[0][1]
    if x >= k[-1][0]:
        return k[-1][1]
    for i in range(len(k) - 1):
        if k[i][0] <= x <= k[i + 1][0]:
            return k[i][1] + (k[i + 1][1] - k[i][1]) * (x - k[i][0]) / ((k[i + 1][0] - k[i][0]) or 1)
    return k[-1][1]


def curve_position_offsets(model, gp, curves):
    """Batting-position offsets on top of the batter's wicket curve: the curve's precision-weighted mean residual (observed /
    expected against the curve) by the group the player usually bats in (1-3, 4-6, 7-11), relative to 1-3; then the intercept
    is reset so the ball-weighted mean term is 1 again."""
    pos = usual_positions()
    term = curves["bat"]["W"]
    pool = curves["pool"]["bat"]
    acc = [[0.0, 0.0], [0.0, 0.0], [0.0, 0.0]]
    pts = []
    for cs, v in model["W"]["bat"].items():
        ci, spin, n, nref, l, o, e = v
        p = gp.get(f"espn_{int(ci)}") if ci else None
        if not p or n < REG_MIN_BALLS:
            continue
        g = pos_group(pos.get(cs, 7))
        res_ = math.log((o + 0.5) / (e + 0.5)) - curve_value(term, pool, p["r"])
        w = 1 / (term["tau"] ** 2 + 1 / (e + 0.5))
        acc[g][0] += w * res_
        acc[g][1] += w
        pts.append((p, g, nref))
    means = [a / b if b else 0 for a, b in acc]
    offs = [0.0, r(means[1] - means[0], 4), r(means[2] - means[0], 4)]
    tot = sum(q[2] for q in pts)
    c = -math.log(sum(q[2] * math.exp(curve_value(term, pool, q[0]["r"]) + offs[q[1]]) for q in pts) / tot)
    return offs, r(c)


def with_regressions(curves, reg, model=None, gp=None):
    for f, ks in REGRESSION_TERMS.items():
        for k in ks:
            curves[f][k] = {**reg[f][k], "pool": reg["pool"][f]}
    if model is not None:
        offs, c = curve_position_offsets(model, gp, curves)
        curves["bat"]["W"] = {**curves["bat"]["W"], "pos": offs, "c": c}
    curves["holdout"] = reg["holdout"]
    return curves


# ── 5. Dismissals, extras, DRS ─────────────────────────────────────────────────────────────────────────────────────

def dismissals_extras():
    out = {}
    duck("""
CREATE OR REPLACE TABLE stumpers AS SELECT DISTINCT trim(f) pid FROM (SELECT unnest(string_split(fids, ';')) f FROM tb WHERE wk = 'stumped' AND fids IS NOT NULL);
CREATE OR REPLACE TABLE ccount AS SELECT mid, fteam, trim(f) pid, count(*) n FROM (SELECT mid, fteam, unnest(string_split(fids, ';')) f FROM tb
  WHERE wk IN ('caught', 'stumped') AND fids IS NOT NULL) GROUP BY ALL;
CREATE OR REPLACE TABLE keeper AS SELECT mid, fteam, arg_max(pid, n) pid FROM ccount WHERE pid IN (SELECT pid FROM stumpers) GROUP BY ALL;""", json_out=False)
    rows = duck(f"""SELECT gender, CASE WHEN btype = 'spin' THEN 'spin' ELSE 'pace' END t,
  CASE WHEN wk = 'caught' AND trim(fids) = k.pid THEN 'caught_keeper' WHEN wk = 'caught' THEN 'caught' WHEN wk = 'caught and bowled' THEN 'caught_and_bowled'
       WHEN wk IN ('bowled', 'lbw', 'stumped', 'hit wicket') THEN replace(wk, ' ', '_') WHEN wk = 'run out' THEN 'run_out' ELSE 'other' END kind, count(*) n
FROM tb LEFT JOIN keeper k ON k.mid = tb.mid AND k.fteam = tb.fteam
WHERE is_wicket = 1 AND coalesce(wk, '') NOT IN ('retired hurt', 'retired not out') AND yr >= {VALID_FROM - 5} GROUP BY ALL""")
    mix = {}
    for x in rows:
        mix.setdefault(x["gender"], {}).setdefault(x["t"], {})[x["kind"]] = x["n"]
    for g in mix:
        for t in mix[g]:
            tot = sum(mix[g][t].values())
            mix[g][t] = {k: r(v / tot, 4) for k, v in sorted(mix[g][t].items())}
    # women's Tests have ~900 dismissals: their mix is shrunk halfway to the men's (same bowler type)
    for t in ("pace", "spin"):
        f_, m_ = mix["female"].get(t, {}), mix["male"][t]
        keys = set(f_) | set(m_)
        mix["female"][t] = {k_: r(0.5 * f_.get(k_, 0) + 0.5 * m_.get(k_, 0), 4) for k_ in sorted(keys)}
    out["dismissal"] = mix
    # runs off a wide, a no-ball (bat runs), a bye / leg bye ball (men's Tests since 2010)
    def dist(sql):
        rr = duck(sql)
        tot = sum(x["n"] for x in rr)
        return {str(int(x["v"])): r(x["n"] / tot, 4) for x in rr}
    out["wideRuns"] = dist(f"SELECT wides v, count(*) n FROM tb WHERE wides > 0 AND gender = 'male' AND yr >= 2010 GROUP BY 1 ORDER BY 1")
    out["noBallBat"] = dist(f"SELECT least(rb, 6) v, count(*) n FROM tb WHERE noballs > 0 AND gender = 'male' AND yr >= 2010 GROUP BY 1 ORDER BY 1")
    out["noBallByes"] = r(duck(f"SELECT avg(CASE WHEN byes + legbyes > 0 THEN 1.0 ELSE 0 END) p FROM tb WHERE noballs > 0 AND rb = 0 AND gender = 'male' AND yr >= 2010")[0]["p"])
    b = duck(f"SELECT avg(CASE WHEN byes > 0 THEN 1.0 ELSE 0 END) p FROM tb WHERE wides = 0 AND noballs = 0 AND rb = 0 AND byes + legbyes > 0 AND gender = 'male' AND yr >= 2010")[0]
    out["byeShare"] = r(b["p"])
    out["byeRuns"] = dist(f"SELECT byes v, count(*) n FROM tb WHERE wides = 0 AND noballs = 0 AND rb = 0 AND byes > 0 AND gender = 'male' AND yr >= 2010 GROUP BY 1 ORDER BY 1")
    out["legByeRuns"] = dist(f"SELECT legbyes v, count(*) n FROM tb WHERE wides = 0 AND noballs = 0 AND rb = 0 AND legbyes > 0 AND gender = 'male' AND yr >= 2010 GROUP BY 1 ORDER BY 1")
    out["threeRuns"] = dist(f"SELECT rb v, count(*) n FROM tb WHERE wides = 0 AND noballs = 0 AND rb IN (3, 5) AND gender = 'male' AND yr >= 2010 GROUP BY 1 ORDER BY 1")
    # DRS: reviews per innings in the three-review era (from 2021), by side, kind and outcome
    rv = duck("""SELECT by_batting, CASE WHEN wicket_kind = 'lbw' THEN 'lbw' WHEN wicket_kind IN ('caught', 'caught and bowled') THEN 'caught' WHEN wicket_kind = '' THEN 'none' ELSE 'other' END kind,
  decision, uc, count(*) n FROM rev JOIN m ON m.mid = rev.match_id WHERE m.gender = 'male' AND m.yr >= 2021 GROUP BY ALL""")
    n_inn = duck("SELECT count(*) n FROM inn JOIN m ON m.mid = inn.match_id WHERE m.gender = 'male' AND m.yr >= 2021")[0]["n"]
    wk = duck("""SELECT CASE WHEN wk = 'lbw' THEN 'lbw' ELSE 'caught' END kind, count(*) n FROM tb LEFT JOIN keeper k ON k.mid = tb.mid AND k.fteam = tb.fteam
  WHERE gender = 'male' AND yr >= 2021 AND (wk = 'lbw' OR (wk = 'caught' AND trim(fids) = k.pid)) GROUP BY 1""")
    legal = duck("SELECT sum(legal) n, sum(CASE WHEN legal = 1 AND rb = 0 AND byes + legbyes = 0 AND is_wicket = 0 THEN 1 ELSE 0 END) dots FROM tb WHERE gender = 'male' AND yr >= 2021")[0]
    d = {"innings": int(n_inn), "legalBallsPerInnings": r(legal["n"] / n_inn, 1), "dotShare": r(legal["dots"] / legal["n"], 4),
         "wicketsPerInnings": {x["kind"]: r(x["n"] / n_inn, 3) for x in wk}}
    def cnt(**kw):
        return sum(x["n"] for x in rv if all(x[k_] == v_ for k_, v_ in kw.items()))
    # batting side: reviews of an out decision. Struck down (wicket stands; umpire's call keeps the review) or upheld (overturned, not out)
    bat_tot = cnt(by_batting=1)
    field_tot = cnt(by_batting=0)
    d["reviewsPerInnings"] = r((bat_tot + field_tot) / n_inn, 3)
    d["battingShare"] = r(bat_tot / (bat_tot + field_tot), 3)
    bat_stood = {k_: cnt(by_batting=1, decision="struck down", kind=k_) for k_ in ("lbw", "caught")}
    d["batting"] = {
        "overturned": r(cnt(by_batting=1, decision="upheld") / bat_tot, 3),
        "umpiresCall": r(cnt(by_batting=1, decision="struck down", uc=1) / bat_tot, 3),
        "kindShare": {k_: r(v_ / max(1, sum(bat_stood.values())), 3) for k_, v_ in bat_stood.items()},
    }
    field_out = {k_: cnt(by_batting=0, decision="upheld", kind=k_) for k_ in ("lbw", "caught")}
    d["fielding"] = {
        "overturned": r(cnt(by_batting=0, decision="upheld") / field_tot, 3),
        "umpiresCall": r(cnt(by_batting=0, decision="struck down", uc=1) / field_tot, 3),
        "kindShare": {k_: r(v_ / max(1, sum(field_out.values())), 3) for k_, v_ in field_out.items()},
    }
    out["drs"] = d
    return out


# ── 6. Team decisions, time ────────────────────────────────────────────────────────────────────────────────────────

def logistic(X, y, l2=1e-3, iters=30):
    """Logistic regression by Newton's method (IRLS); X rows include the intercept."""
    p_ = len(X[0])
    beta = [0.0] * p_
    for _ in range(iters):
        g = [0.0] * p_
        H = [[0.0] * p_ for _ in range(p_)]
        for xi, yi in zip(X, y):
            z = sum(b_ * v for b_, v in zip(beta, xi))
            mu = 1 / (1 + math.exp(-max(-30, min(30, z))))
            w = mu * (1 - mu)
            for a in range(p_):
                g[a] += (yi - mu) * xi[a]
                for c in range(p_):
                    H[a][c] += w * xi[a] * xi[c]
        for a in range(p_):
            g[a] -= l2 * beta[a]
            H[a][a] += l2
        step = solve(H, g)
        beta = [b_ + s_ for b_, s_ in zip(beta, step)]
        if max(abs(s_) for s_ in step) < 1e-6:
            break
    return beta


def policies():
    out = {}
    W = f"m.gender = 'male' AND m.yr >= {VALID_FROM}"
    # toss: bat first share by host country, shrunk to the overall share with 10 matches' weight
    rows = duck(f"SELECT m.country, sum(CASE WHEN toss_decision = 'bat' THEN 1 ELSE 0 END) b, count(*) n FROM m WHERE {W} GROUP BY 1")
    allb = sum(x["b"] for x in rows) / sum(x["n"] for x in rows)
    out["toss"] = {"all": r(allb, 3), "byCountry": {x["country"]: r((x["b"] + 10 * allb) / (x["n"] + 10), 3) for x in rows if x["country"] in COUNTRIES}}
    # declarations: at the end of each over of innings 1-3, was the innings declared there (its last over)?
    duck(f"""CREATE OR REPLACE TABLE eo AS
SELECT tb.mid, tb.inn, tb.ov, max(seq) s, arg_max(inn_runs + rt, seq) runs, arg_max(inn_wkts + CASE WHEN is_wicket = 1 AND coalesce(wk,'') NOT IN ('retired hurt','retired not out') THEN 1 ELSE 0 END, seq) wkts,
  arg_max(lead + rt, seq) lead, arg_min(overs_left, seq) - 1 overs_left, any_value(inn_declared) declared, max(ov) OVER (PARTITION BY tb.mid, tb.inn) last_ov, any_value(dy) dy,
  any_value(cum_legal) / 6.0 match_overs
FROM tb JOIN m ON m.mid = tb.mid WHERE {W} AND tb.inn <= 3 GROUP BY tb.mid, tb.inn, tb.ov;""", json_out=False)
    dec = {}
    specs = {
        1: ("runs >= 250", lambda x: [1, x["runs"] / 100, x["match_overs"] / 90, x["wkts"]], ["intercept", "runs/100", "matchOvers/90", "wickets"]),
        2: ("lead >= -50", lambda x: [1, x["lead"] / 100, x["overs_left"] / 90, x["wkts"]], ["intercept", "lead/100", "oversLeft/90", "wickets"]),
        3: ("lead >= 100", lambda x: [1, x["lead"] / 100, x["overs_left"] / 90, x["lead"] / max(x["overs_left"], 10), x["wkts"]],
            ["intercept", "lead/100", "oversLeft/90", "lead/oversLeft", "wickets"]),
    }
    for i, (where, feats, names) in specs.items():
        rows = duck(f"SELECT runs, wkts, lead, overs_left, match_overs, CASE WHEN declared = 1 AND ov = last_ov THEN 1 ELSE 0 END y FROM eo WHERE inn = {i} AND wkts < 10 AND {where}")
        X = [feats(x) for x in rows]
        y = [x["y"] for x in rows]
        beta = logistic(X, y)
        dec[f"inn{i}"] = {"coef": {n_: r(b_, 4) for n_, b_ in zip(names, beta)}, "overs": len(rows), "declared": int(sum(y))}
    # what sides declare on: innings 3 lead and overs left at the declaration
    q = duck(f"""SELECT quantile_cont(lead, [0.1, 0.25, 0.5, 0.75, 0.9]) lead, quantile_cont(overs_left, [0.1, 0.25, 0.5, 0.75, 0.9]) ol, count(*) n
FROM eo WHERE inn = 3 AND declared = 1 AND ov = last_ov""")[0]
    dec["inn3At"] = {"lead": [r(v, 0) for v in q["lead"]], "oversLeft": [r(v, 1) for v in q["ol"]], "n": int(q["n"])}
    out["declare"] = dec
    # follow-on: lead of 200+ after two innings (5-day Tests); enforced when the same side bats again
    rows = duck(f"""WITH t AS (SELECT i1.match_id mid, i1.team t1, i1.runs - i2.runs lead, i3.team t3, i2.legal / 6.0 ov2, i1.legal / 6.0 ov1,
  m.n_dates, ml.day_balls FROM inn i1 JOIN inn i2 ON i2.match_id = i1.match_id AND i2.inn = 2 JOIN m ON m.mid = i1.match_id JOIN mlen ml ON ml.mid = m.mid
  LEFT JOIN inn i3 ON i3.match_id = i1.match_id AND i3.inn = 3 WHERE i1.inn = 1 AND {W})
SELECT lead, ov2, greatest(0, 5 * day_balls / 6.0 - ov1 - ov2) overs_left, CASE WHEN t3 IS NULL THEN NULL WHEN t3 = t1 THEN 0 ELSE 1 END enforced
FROM t WHERE lead >= 200""")
    rows = [x for x in rows if x["enforced"] is not None]
    X = [[1, (x["lead"] - 200) / 100, x["overs_left"] / 90, x["ov2"] / 100] for x in rows]
    beta = logistic(X, [x["enforced"] for x in rows])
    out["followOn"] = {"coef": dict(zip(["intercept", "(lead-200)/100", "oversLeft/90", "oversFielded/100"], [r(b_, 4) for b_ in beta])),
                       "eligible": len(rows), "enforced": int(sum(x["enforced"] for x in rows))}
    # bowling: spinners' share of the overs by ball age and day, subcontinent vs elsewhere; spell lengths and rests; workloads
    rows = duck(f"""SELECT CASE WHEN tb.region = 'Subcontinent' OR tb.country = 'UAE' THEN 'sub' ELSE 'other' END reg, {bin_sql('(ov - 80 * floor(ov / 80))', AGE_BINS)} ab,
  least(dy, 5) dy, avg(CASE WHEN btype = 'spin' THEN 1.0 ELSE 0 END) p, count(*) n FROM tb JOIN m ON m.mid = tb.mid WHERE {W} AND btype <> 'unknown' AND legal = 1 GROUP BY ALL""")
    share = {}
    for x in rows:
        share.setdefault(x["reg"], [[0.0] * 5 for _ in AGE_BINS])[int(x["ab"])][int(x["dy"]) - 1] = r(x["p"], 3)
    out["spinShare"] = share
    rows = duck(f"""WITH s AS (SELECT o.mid, o.inn, o.bowl, o.spell_id, any_value(o.spell_len) len, any_value(t.btype) bt, min(o.ov) first_ov, max(o.ov) last_ov
  FROM bov4 o JOIN m ON m.mid = o.mid JOIN (SELECT DISTINCT bowl, btype FROM tb) t ON t.bowl = o.bowl WHERE {W} GROUP BY ALL)
SELECT CASE WHEN bt = 'spin' THEN 'spin' ELSE 'pace' END bt, least(len, 20) len, count(*) n FROM s GROUP BY ALL ORDER BY ALL""")
    spells = {}
    for x in rows:
        spells.setdefault(x["bt"], {})[int(x["len"])] = x["n"]
    out["spellLength"] = {t: {k_: r(v_ / sum(d_.values()), 4) for k_, v_ in sorted(d_.items())} for t, d_ in spells.items()}
    rows = duck(f"""WITH s AS (SELECT o.mid, o.inn, o.bowl, o.spell_id, min(o.ov) first_ov, max(o.ov) last_ov, any_value(dy) dy FROM bov4 o JOIN m ON m.mid = o.mid WHERE {W} GROUP BY ALL),
g AS (SELECT bowl, first_ov - lag(last_ov) OVER (PARTITION BY mid, inn, bowl ORDER BY spell_id) gap, dy = lag(dy) OVER (PARTITION BY mid, inn, bowl ORDER BY spell_id) same_day FROM s)
SELECT CASE WHEN t.btype = 'spin' THEN 'spin' ELSE 'pace' END bt, quantile_cont(gap, [0.1, 0.25, 0.5]) q FROM g JOIN (SELECT DISTINCT bowl, btype FROM tb) t ON t.bowl = g.bowl
WHERE gap IS NOT NULL AND same_day GROUP BY 1""")
    # innings overs between the end of a bowler's spell and the start of his next (same day): 10th, 25th, 50th percentile
    out["restOvers"] = {x["bt"]: [r(v, 1) for v in x["q"]] for x in rows}
    rows = duck(f"""WITH b AS (SELECT o.mid, o.inn, o.bowl, count(*) ov, any_value(t.btype) bt FROM bov4 o JOIN m ON m.mid = o.mid JOIN (SELECT DISTINCT bowl, btype FROM tb) t ON t.bowl = o.bowl
  WHERE {W} GROUP BY ALL), d AS (SELECT o.mid, o.inn, o.bowl, o.dy, count(*) ov, any_value(t.btype) bt FROM bov2 o JOIN m ON m.mid = o.mid JOIN (SELECT DISTINCT bowl, btype FROM tb) t ON t.bowl = o.bowl
  WHERE {W} GROUP BY ALL)
SELECT 'innings' AS sc, CASE WHEN bt = 'spin' THEN 'spin' ELSE 'pace' END bt, quantile_cont(ov, [0.5, 0.9, 0.99]) q FROM b GROUP BY ALL
UNION ALL SELECT 'day', CASE WHEN bt = 'spin' THEN 'spin' ELSE 'pace' END, quantile_cont(ov, [0.5, 0.9, 0.99]) FROM d GROUP BY ALL""")
    out["workload"] = {f"{x['sc']}_{x['bt']}": [r(v, 1) for v in x["q"]] for x in rows}
    out["time"] = time_model()
    return out


def time_model():
    """Overs per hour and time lost to weather / bad light, from CricketArchive minutes batted (an innings lasts half the sum
    of its batters' minutes). A decided match used D-1 days and, on average, half of the last; a draw used all of them."""
    duck(f"""LOAD sqlite; ATTACH '{ROOT / 'data/cricket.db'}' AS ca (TYPE sqlite, READ_ONLY);
CREATE OR REPLACE TABLE catime AS SELECT m.id ca_id, m.date::DATE date, m.team1, m.team2, b.innings, sum(coalesce(b.mins, 0)) / 2.0 mins
FROM ca.matches m JOIN ca.batting b ON b.match_id = m.id WHERE m.levels LIKE '%Test%' AND m.gender <> 'female' GROUP BY ALL;
CREATE OR REPLACE TABLE mt AS SELECT x.mid, x.country, x.n_dates, coalesce(x.result, 'decided') result, x.n_inn, sum(c.mins) mins,
  (SELECT sum(legal) FROM inn WHERE inn.match_id = x.mid) / 6.0 overs
FROM m x JOIN catime c ON c.date = x.date AND ((c.team1 = x.team1 AND c.team2 = x.team2) OR (c.team1 = x.team2 AND c.team2 = x.team1))
WHERE x.gender = 'male' AND x.yr >= {VALID_FROM} GROUP BY ALL HAVING sum(c.mins) > 300;
CREATE OR REPLACE TABLE mt2 AS SELECT *, n_dates - 1 + CASE WHEN result = 'draw' THEN 1.0 ELSE 0.5 END days_used,
  greatest(0, (n_dates - 1 + CASE WHEN result = 'draw' THEN 1.0 ELSE 0.5 END) * 360 - mins - 10 * (n_inn - 1)) lost FROM mt;""", json_out=False)
    q = duck("SELECT quantile_cont(overs / (mins / 60), [0.1, 0.25, 0.5, 0.75, 0.9]) q, count(*) n FROM mt2")[0]
    rows = duck("SELECT country, days_used, lost FROM mt2")
    # per day: with probability p some time is lost, a share X of the day (mean xbar). MLE of p from the matches that
    # lost under 30 minutes ((1-p)^days), the mean share from the minutes lost; shrunk to the overall rate with 8 matches.
    def fit(rs):
        lo, hi = 1e-4, 0.999
        for _ in range(60):
            p_ = (lo + hi) / 2
            gsum = 0.0
            for x in rs:
                n_ = x["days_used"]
                if x["lost"] < 30:
                    gsum += -n_ / (1 - p_)
                else:
                    q_ = (1 - p_) ** n_
                    gsum += n_ * (1 - p_) ** (n_ - 1) / max(1e-9, 1 - q_)
            if gsum > 0:
                lo = p_
            else:
                hi = p_
        p_ = (lo + hi) / 2
        xbar = sum(x["lost"] for x in rs) / (360 * p_ * sum(x["days_used"] for x in rs))
        return p_, xbar, len(rs)
    p_all, x_all, n_all = fit(rows)
    by = {}
    for c in COUNTRIES:
        rs = [x for x in rows if x["country"] == c]
        if len(rs) >= 4:
            p_, xb, n_ = fit(rs)
            k_ = 8
            by[c] = {"p": r((p_ * n_ + p_all * k_) / (n_ + k_), 3), "share": r(min(1, (xb * n_ + x_all * k_) / (n_ + k_)), 3), "n": n_}
    dist = duck("""SELECT CASE WHEN lost < 30 THEN 0 WHEN lost < 120 THEN 1 WHEN lost < 360 THEN 2 WHEN lost < 720 THEN 3 ELSE 4 END b, count(*) n
FROM mt2 WHERE result = 'draw' GROUP BY 1 ORDER BY 1""")
    return {"oversPerHour": [r(v, 2) for v in q["q"]], "matches": int(q["n"]), "weather": {"p": r(p_all, 3), "share": r(x_all, 3), "byCountry": by},
            "drawLostMinutes": {"<30": 0, "30-120": 0, "120-360": 0, "360-720": 0, "720+": 0} | {["<30", "30-120", "120-360", "360-720", "720+"][int(x["b"])]: int(x["n"]) for x in dist}}



# ── 7. Real targets for the benchmark ──────────────────────────────────────────────────────────────────────────────

CHASE_BINS = [0, 150, 200, 250, 300, 350]


def team_country_sql(col):
    return "CASE " + col + " " + " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in TEAM_COUNTRY.items()) + " ELSE 'X' END"


def real_targets(gender, since):
    W = f"m.gender = '{gender}' AND m.yr >= {since}"
    out = {"since": since}
    n = duck(f"SELECT count(*) n FROM m WHERE {W}")[0]["n"]
    out["tests"] = int(n)
    rows = duck(f"SELECT inn, count(*) n, avg(runs) runs, avg(wkts) wkts, avg(legal / 6.0) overs FROM inn JOIN m ON m.mid = inn.match_id WHERE {W} GROUP BY 1 ORDER BY 1")
    out["innings"] = {int(x["inn"]): {"n": int(x["n"]), "runs": r(x["runs"], 1), "wickets": r(x["wkts"], 2), "overs": r(x["overs"], 1)} for x in rows}
    x = duck(f"""SELECT 6.0 * sum(rt) / sum(legal) rpo, sum(legal) * 1.0 / sum(CASE WHEN is_wicket = 1 AND coalesce(wk, '') NOT IN ('retired hurt', 'retired not out') THEN 1 ELSE 0 END) bpw,
  sum(legal) / 6.0 / {n} overs_per_test FROM tb JOIN m ON m.mid = tb.mid WHERE {W}""")[0]
    out["runsPerOver"] = r(x["rpo"], 3)
    out["ballsPerWicket"] = r(x["bpw"], 1)
    out["oversPerTest"] = r(x["overs_per_test"], 1)
    x = duck(f"""SELECT sum(CASE WHEN winner IS NOT NULL AND {team_country_sql('winner')} = country THEN 1 ELSE 0 END) home,
  sum(CASE WHEN winner IS NOT NULL AND {team_country_sql('winner')} <> country AND ({team_country_sql('team1')} = country OR {team_country_sql('team2')} = country) THEN 1 ELSE 0 END) away,
  sum(CASE WHEN winner IS NOT NULL AND {team_country_sql('team1')} <> country AND {team_country_sql('team2')} <> country THEN 1 ELSE 0 END) neutral,
  sum(CASE WHEN result = 'draw' THEN 1 ELSE 0 END) draw, sum(CASE WHEN result = 'tie' THEN 1 ELSE 0 END) tie, count(*) n,
  avg(n_dates) ndays, sum(CASE WHEN n_dates <= 3 THEN 1 ELSE 0 END) d3, sum(CASE WHEN n_dates = 4 THEN 1 ELSE 0 END) d4, sum(CASE WHEN n_dates >= 5 THEN 1 ELSE 0 END) d5
FROM m WHERE {W}""")[0]
    out["results"] = {k_: r(x[k_] / x["n"], 3) for k_ in ("home", "away", "neutral", "draw", "tie")}
    out["days"] = {"mean": r(x["ndays"], 2), "upTo3": r(x["d3"] / x["n"], 3), "four": r(x["d4"] / x["n"], 3), "five": r(x["d5"] / x["n"], 3)}
    x = duck(f"""SELECT sum(CASE WHEN i3.team = i2.team THEN 1 ELSE 0 END) fo, sum(CASE WHEN i1.runs - i2.runs >= {200 if gender == 'male' else 150} AND i2.wkts >= 10 THEN 1 ELSE 0 END) avail
FROM inn i1 JOIN inn i2 ON i2.match_id = i1.match_id AND i2.inn = 2 JOIN m ON m.mid = i1.match_id LEFT JOIN inn i3 ON i3.match_id = i1.match_id AND i3.inn = 3 WHERE i1.inn = 1 AND {W}""")[0]
    out["followOnsPerTest"] = r(x["fo"] / n, 3)
    out["followOnEnforcedShare"] = r(x["fo"] / max(1, x["avail"]), 3)
    rows = duck(f"SELECT inn, sum(declared) d FROM inn JOIN m ON m.mid = inn.match_id WHERE {W} GROUP BY 1 ORDER BY 1")
    out["declarationsPerTest"] = {int(x["inn"]): r(x["d"] / n, 3) for x in rows if x["inn"] <= 3}
    rows = duck(f"""SELECT i4.team, (SELECT sum(j.runs) FROM inn j WHERE j.match_id = i4.match_id AND j.team <> i4.team) - (SELECT coalesce(sum(j.runs), 0) FROM inn j WHERE j.match_id = i4.match_id AND j.team = i4.team AND j.inn < 4) + 1 AS target,
  m.winner, m.result FROM inn i4 JOIN m ON m.mid = i4.match_id WHERE i4.inn = 4 AND {W}""")
    ch = {}
    for x in rows:
        b = max(i for i, lo in enumerate(CHASE_BINS) if x["target"] >= lo)
        o = "win" if x["winner"] == x["team"] else "draw" if x["result"] in ("draw", "tie") else "loss"
        ch.setdefault(b, {"n": 0, "win": 0, "draw": 0, "loss": 0})
        ch[b]["n"] += 1
        ch[b][o] += 1
    out["chases"] = {f"{CHASE_BINS[b]}+": {"n": v["n"], "win": r(v["win"] / v["n"], 3), "draw": r(v["draw"] / v["n"], 3), "loss": r(v["loss"] / v["n"], 3)} for b, v in sorted(ch.items())}
    x = duck(f"""WITH bt AS (SELECT tb.mid, inn, bat, sum(rb) runs FROM tb JOIN m ON m.mid = tb.mid WHERE {W} GROUP BY ALL),
  bw AS (SELECT tb.mid, inn, bowl, sum(CASE WHEN is_wicket = 1 AND wk IN ('bowled', 'caught', 'lbw', 'stumped', 'caught and bowled', 'hit wicket') THEN 1 ELSE 0 END) w FROM tb JOIN m ON m.mid = tb.mid WHERE {W} GROUP BY ALL)
SELECT (SELECT count(*) FROM bt WHERE runs >= 100) c100, (SELECT count(*) FROM bt WHERE runs >= 50) c50, (SELECT count(*) FROM bw WHERE w >= 5) f5""")[0]
    out["centuriesPerTest"] = r(x["c100"] / n, 3)
    out["fiftiesPlusPerTest"] = r(x["c50"] / n, 3)
    out["fiveForsPerTest"] = r(x["f5"] / n, 3)
    rows = duck(f"""SELECT least(dy, 5) dy, avg(CASE WHEN btype = 'spin' THEN 1.0 ELSE 0 END) p, count(*) n FROM tb JOIN m ON m.mid = tb.mid
WHERE {W} AND is_wicket = 1 AND wk IN ('bowled', 'caught', 'lbw', 'stumped', 'caught and bowled', 'hit wicket') AND btype <> 'unknown' GROUP BY 1 ORDER BY 1""")
    out["spinWicketShareByDay"] = [r(x["p"], 3) for x in rows]
    rows = duck(f"""SELECT least(dy, 5) dy, avg(CASE WHEN btype = 'spin' THEN 1.0 ELSE 0 END) p FROM tb JOIN m ON m.mid = tb.mid
WHERE {W} AND legal = 1 AND btype <> 'unknown' GROUP BY 1 ORDER BY 1""")
    out["spinOverShareByDay"] = [r(x["p"], 3) for x in rows]
    # how the bowling is shared: overs and wickets of an innings' bowlers ranked by overs (innings of 50+ overs)
    rows = duck(f"""WITH b AS (SELECT tb.mid, inn, bowl, sum(legal) balls, sum(CASE WHEN is_wicket = 1 AND wk IN ('bowled', 'caught', 'lbw', 'stumped', 'caught and bowled', 'hit wicket') THEN 1 ELSE 0 END) w
  FROM tb JOIN m ON m.mid = tb.mid WHERE {W} GROUP BY ALL),
  q AS (SELECT *, row_number() OVER (PARTITION BY mid, inn ORDER BY balls DESC) rk, sum(balls) OVER (PARTITION BY mid, inn) tot, sum(w) OVER (PARTITION BY mid, inn) totw FROM b)
SELECT rk, sum(balls) / sum(tot) so, sum(w) / sum(totw) sw FROM q WHERE tot >= 300 AND rk <= 6 GROUP BY 1 ORDER BY 1""")
    out["oversShareByRank"] = [r(x["so"], 3) for x in rows]
    out["wicketShareByRank"] = [r(x["sw"], 3) for x in rows]
    out["inningsWins"] = r(duck(f"SELECT avg(CASE WHEN by_innings = 1 THEN 1.0 ELSE 0 END) p FROM m WHERE {W}")[0]["p"], 3)
    # scoring and survival by batting position (order of arrival in the innings): runs off the bat per six balls faced, balls
    # faced per dismissal, share of the balls faced
    duck(f"""CREATE OR REPLACE TABLE arrp AS WITH fb_ AS (SELECT mid, inn, p, min(seq) s FROM (SELECT mid, inn, bat p, seq FROM tb
  UNION ALL SELECT mid, inn, nst p, seq FROM tb) GROUP BY ALL) SELECT mid, inn, p, row_number() OVER (PARTITION BY mid, inn ORDER BY s, p) pos FROM fb_""", json_out=False)
    rows = duck(f"""SELECT CASE WHEN a.pos <= 3 THEN '1-3' WHEN a.pos <= 6 THEN '4-6' ELSE '7-11' END grp, 6.0 * sum(t.rb) / sum(t.faced) rpo,
  sum(t.faced) * 1.0 / sum(CASE WHEN t.is_wicket = 1 AND t.pout = t.bat AND coalesce(t.wk, '') NOT IN ('retired hurt', 'retired not out') THEN 1 ELSE 0 END) bpw,
  sum(t.faced) bf FROM tb t JOIN m ON m.mid = t.mid JOIN arrp a ON a.mid = t.mid AND a.inn = t.inn AND a.p = t.bat WHERE {W} GROUP BY 1 ORDER BY 1""")
    tot = sum(x["bf"] for x in rows)
    out["byPosition"] = {x["grp"]: {"runsPer6": r(x["rpo"], 3), "ballsPerDismissal": r(x["bpw"], 1), "ballShare": r(x["bf"] / tot, 3)} for x in rows}
    x = duck(f"""SELECT sum((SELECT sum(legal) FROM inn WHERE inn.match_id = m.mid) / 6.0) / sum(n_dates - 1 + CASE WHEN result = 'draw' THEN 1.0 ELSE 0.5 END) opd FROM m WHERE {W}""")[0]
    out["oversPerDayUsed"] = r(x["opd"], 1)
    if gender == "male":
        rows = duck(f"""WITH t AS (SELECT team1 team, winner FROM m WHERE {W} UNION ALL SELECT team2, winner FROM m WHERE {W})
SELECT team, count(*) n, avg(CASE WHEN winner = team THEN 1.0 ELSE 0 END) w FROM t GROUP BY 1 HAVING count(*) >= 20 ORDER BY w DESC""")
        strong = [x["team"] for x in rows[:4]]
        weak = [x["team"] for x in rows[-4:]]
        xs = duck(f"""SELECT count(*) n, sum(CASE WHEN winner IN ({','.join("'" + t + "'" for t in strong)}) THEN 1 ELSE 0 END) sw,
  sum(CASE WHEN winner IN ({','.join("'" + t + "'" for t in weak)}) THEN 1 ELSE 0 END) ww, sum(CASE WHEN result = 'draw' THEN 1 ELSE 0 END) d
FROM m WHERE {W} AND ((team1 IN ({','.join("'" + t + "'" for t in strong)}) AND team2 IN ({','.join("'" + t + "'" for t in weak)}))
  OR (team2 IN ({','.join("'" + t + "'" for t in strong)}) AND team1 IN ({','.join("'" + t + "'" for t in weak)})))""")[0]
        out["strongVsWeak"] = {"strong": strong, "weak": weak, "n": int(xs["n"]), "strongWin": r(xs["sw"] / xs["n"], 3),
                               "draw": r(xs["d"] / xs["n"], 3), "weakWin": r(xs["ww"] / xs["n"], 3)}
        out["teamWinShare"] = {x["team"]: r(x["w"], 3) for x in rows}
        out["teamTests"] = {x["team"]: int(x["n"]) for x in rows}
        # how often each side hosts: the benchmark draws fixtures in the real proportions
        hs = duck(f"""SELECT CASE WHEN {team_country_sql('team1')} = country THEN team1 WHEN {team_country_sql('team2')} = country THEN team2 END host, count(*) n
FROM m WHERE {W} GROUP BY 1""")
        out["hostTests"] = {x["host"]: int(x["n"]) for x in hs if x["host"]}
    return out


# ── 8. Squads for the engine benchmark ─────────────────────────────────────────────────────────────────────────────

def squads(gp_all, test_sets):
    teams = {"male": list(TEAM_COUNTRY), "female": ["India", "England", "Australia", "South Africa"]}
    out = []
    for g, since in (("male", 2023), ("female", 2021)):
        rows = duck(f"""WITH a AS (SELECT DISTINCT tb.mid, bteam team, bat_ci ci FROM tb WHERE gender = '{g}' AND yr >= {since}
  UNION SELECT DISTINCT tb.mid, fteam, bowl_ci FROM tb WHERE gender = '{g}' AND yr >= {since})
SELECT team, ci, count(*) n FROM a WHERE ci IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 3 DESC""")
        for t in teams[g]:
            picked = []
            for x in rows:
                if x["team"] != t:
                    continue
                p = gp_all.get(f"espn_{int(x['ci'])}")
                if not p or p.get("g", "male") != g:
                    continue
                picked.append({"id": p["id"], "name": p["name"], "age": p.get("age", 28), "country": t, "role": p["role"],
                               "isWicketKeeper": bool(p.get("wk")), "bowlingStyle": p.get("bs", "unknown"), "battingHand": p.get("bh", "right"),
                               "ratings": p["r"], "tests": int(x["n"]),
                               **({"formatRatings": {"test": test_sets[p["id"]]}} if p["id"] in test_sets else {})})
                if len(picked) >= 16:
                    break
            if len(picked) >= 12 and any(q["isWicketKeeper"] for q in picked):
                out.append({"team": t, "gender": g, "country": TEAM_COUNTRY.get(t, "UNK"), "players": picked})
    return out


# ── 9. Output ──────────────────────────────────────────────────────────────────────────────────────────────────────

def match_spread(model):
    runs = {"1": 1, "2": 2, "3": 3, "4": 4, "6": 6}
    per = {}
    for k in list(runs) + ["W"]:
        for mid, (cty, isref, o, e, raw) in model[k]["match"].items():
            per.setdefault(mid, {"cty": cty})[k] = (o, e)
    pts = []
    for mid, d in per.items():
        if not all(k in d for k in list(runs) + ["W"]):
            continue
        orr = sum(v * d[k][0] for k, v in runs.items())
        err = sum(v * d[k][1] for k, v in runs.items())
        svr = sum(v * v * d[k][1] for k, v in runs.items()) / err ** 2
        ow, ew = d["W"]
        pts.append((d["cty"], math.log((orr + 1) / (err + 1)), math.log((ow + 0.5) / (ew + 0.5)), svr, 1 / (ew + 0.5)))
    # centre within country
    for c in set(x[0] for x in pts):
        xs = [x for x in pts if x[0] == c]
        mr = sum(x[1] for x in xs) / len(xs)
        mw = sum(x[2] for x in xs) / len(xs)
        pts = [(x[0], x[1] - mr, x[2] - mw, x[3], x[4]) if x[0] == c else x for x in pts]
    N = len(pts)
    vr = sum(x[1] ** 2 for x in pts) / N - sum(x[3] for x in pts) / N
    vw = sum(x[2] ** 2 for x in pts) / N - sum(x[4] for x in pts) / N
    cov = sum(x[1] * x[2] for x in pts) / N
    return {"run": r(math.sqrt(max(vr, 0))), "wicket": r(math.sqrt(max(vw, 0))), "corr": r(cov / math.sqrt(max(vr, 1e-6) * max(vw, 1e-6)), 3), "matches": N}


def innings_spread(model):
    if not INNINGS_TERM:
        return innings_spread_residual()
    return innings_spread_term(model)


def innings_spread_residual():
    """An innings' own scoring conditions beyond everything else (match term included): the spread of the observed / expected
    runs per innings less its sampling noise (Poisson-like: the expected sum of squared runs), for innings of 60+ expected runs.
    The wickets are left alone: per innings their observed / expected ratio is no more spread than chance."""
    x = duck(f"""CREATE OR REPLACE TABLE er AS SELECT f.mid, f.inn, f.yr,
  exp(a.lm) + 2 * exp(b.lm) + 3 * exp(c.lm) + 4 * exp(d.lm) + 6 * exp(e.lm) mu_r, exp(a.lm) + 4 * exp(b.lm) + 9 * exp(c.lm) + 16 * exp(d.lm) + 36 * exp(e.lm) mu_r2,
  CASE f.cls WHEN '1' THEN 1 WHEN '2' THEN 2 WHEN '3' THEN 3 WHEN '4' THEN 4 WHEN '6' THEN 6 ELSE 0 END y_r
FROM fb f JOIN fit_1 a USING(rid) JOIN fit_2 b USING(rid) JOIN fit_3 c USING(rid) JOIN fit_4 d USING(rid) JOIN fit_6 e USING(rid) WHERE f.gender = 'male';
WITH t AS (SELECT mid, inn, sum(y_r) o, sum(mu_r) e, sum(mu_r2) v FROM er WHERE yr >= 2010 GROUP BY ALL HAVING sum(mu_r) > 60)
SELECT count(*) n, var_pop(ln(o / e)) raw, avg(v / (e * e)) samp FROM t""")[0]
    return {"run": r(math.sqrt(max(0, x["raw"] - x["samp"]))), "wicket": 0, "corr": 0, "innings": int(x["n"])}


def innings_spread_term(model):
    """An innings' own conditions within its match: the spread of the observed / expected runs and wickets per innings
    (expected without the innings term), centred within the match, less the sampling noise; innings of 60+ expected runs."""
    runs = {"1": 1, "2": 2, "3": 3, "4": 4, "6": 6}
    per = {}
    for k in list(runs) + ["W"]:
        for key, (o, e) in model[k]["innings"].items():
            per.setdefault(key, {})[k] = (o, e)
    pts = []
    for key, d in per.items():
        if not all(k in d for k in list(runs) + ["W"]):
            continue
        orr = sum(v * d[k][0] for k, v in runs.items())
        err = sum(v * d[k][1] for k, v in runs.items())
        if err < 60:
            continue
        svr = sum(v * v * d[k][1] for k, v in runs.items()) / err ** 2
        ow, ew = d["W"]
        pts.append((key.split("|")[0], math.log((orr + 1) / (err + 1)), math.log((ow + 0.5) / (ew + 0.5)), svr, 1 / (ew + 0.5)))
    for mid in set(x[0] for x in pts):
        xs = [x for x in pts if x[0] == mid]
        if len(xs) < 2:
            continue
        mr = sum(x[1] for x in xs) / len(xs)
        mw = sum(x[2] for x in xs) / len(xs)
        n_ = len(xs)
        # centring within the match takes 1/n of the variance out: scale back up
        f_ = math.sqrt(n_ / (n_ - 1))
        pts = [(x[0], (x[1] - mr) * f_, (x[2] - mw) * f_, x[3], x[4]) if x[0] == mid else x for x in pts]
    N = len(pts)
    vr = sum(x[1] ** 2 for x in pts) / N - sum(x[3] for x in pts) / N
    vw = sum(x[2] ** 2 for x in pts) / N - sum(x[4] for x in pts) / N
    cov = sum(x[1] * x[2] for x in pts) / N
    return {"run": r(math.sqrt(max(vr, 0))), "wicket": r(math.sqrt(max(vw, 0))),
            "corr": r(cov / math.sqrt(max(vr, 1e-6) * max(vw, 1e-6)), 3) if vr > 0 and vw > 0 else 0, "innings": N}


def pitch_wear():
    """How differently pitches wear: per match, the wicket rate on days 4-5 against days 1-2 (observed / expected under the full
    model, the match term included), its spread less the Poisson noise of both halves. Matches with 5+ expected wickets in each."""
    x = duck("""CREATE OR REPLACE TABLE rw2 AS SELECT f.mid, least(t.dy, 5) dy, w.y, exp(w.lm) mu FROM fit_W w JOIN fb f USING(rid)
  JOIN (SELECT row_number() OVER () rid, dy FROM tb WHERE yr >= 2006) t USING(rid) WHERE f.gender = 'male';
WITH m AS (SELECT mid, sum(CASE WHEN dy <= 2 THEN y END) oe, sum(CASE WHEN dy <= 2 THEN mu END) ee, sum(CASE WHEN dy >= 4 THEN y END) ol,
  sum(CASE WHEN dy >= 4 THEN mu END) el FROM rw2 GROUP BY 1)
SELECT count(*) n, var_pop(ln((ol + 0.5) / (el + 0.5)) - ln((oe + 0.5) / (ee + 0.5))) raw, avg(1 / (el + 0.5) + 1 / (ee + 0.5)) samp
FROM m WHERE ee > 5 AND el > 5""")[0]
    return {"wicket": r(math.sqrt(max(0, x["raw"] - x["samp"]))), "matches": int(x["n"])}


def women_base(model):
    """Women's base rate per outcome with every men's context factor as an offset (players and the match term at 1)."""
    out = {}
    for k in OUTCOMES:
        facs = [f for f in OUTCOME_FACTORS[k] if f in CONTEXT and f not in ("era", "baz")]
        t = model[k]["factors"]
        cases = " * ".join(
            "(CASE f_" + f + " " + " ".join(f"WHEN {lv} THEN {v}::DOUBLE" for lv, v in t[f].items()) + " ELSE 1.0::DOUBLE END)" for f in facs)
        x = duck(f"SELECT sum(CASE WHEN cls = '{k}' THEN 1.0 ELSE 0 END) o, sum({cases}) e FROM fb WHERE gender = 'female' AND yr >= 2014")[0]
        out[k] = x["o"] / x["e"]
    return out


def tables(model):
    """The factor tables in the engine's shape: outcome -> multipliers by level."""
    def lv(f, k, levels):
        t = model[k]["factors"].get(f)
        return [r(t.get(str(i), t.get(i, 1.0)) if t else 1.0) for i in levels]
    T = {}
    T["age"] = {k: lv("age", k, range(len(AGE_BINS))) for k in OUTCOMES}
    T["set"] = {k: lv("set", k, range(len(SET_BINS))) for k in OUTCOMES}
    T["innings"] = {k: lv("inn", k, range(4)) for k in OUTCOMES}
    # wickets down by innings: [innings 1-4][0-2, 3-5, 6-7, 8-9] (a 4th-innings top order goes quicker than the main effects say)
    T["wicketsDown"] = {k: [lv("wd", k, range(i * len(WD_BINS), (i + 1) * len(WD_BINS))) for i in range(4)] for k in OUTCOMES}
    T["day"] = {t: {k: lv("dt", k, [d * 2 + (1 if t == "spin" else 0) for d in range(5)]) for k in OUTCOMES} for t in ("pace", "spin")}
    T["spell"] = {k: lv("spell", k, range(SPELL_MAX)) for k in OUTCOMES}
    T["situation"] = {"normal": {k: lv("sit", k, [0])[0] for k in OUTCOMES}, "push": {k: lv("sit", k, [1])[0] for k in OUTCOMES},
                      "chase": [{k: lv("sit", k, [2 + i])[0] for k in OUTCOMES} for i in range(len(RR_BINS))]}
    T["home"] = {h: {k: lv("home", k, [i])[0] for k in OUTCOMES} for i, h in enumerate(["home", "away", "neutral"])}
    T["country"] = {c: {t: {k: lv("ct", k, [i * 2 + (1 if t == "spin" else 0)])[0] for k in OUTCOMES} for t in ("pace", "spin")}
                    for i, c in enumerate(COUNTRIES + ["other"])}
    T["era"] = {name: {k: lv("era", k, [i])[0] for k in OUTCOMES} for i, (_, _, name) in enumerate(ERAS)}
    T["bazball"] = {k: lv("baz", k, [1])[0] for k in OUTCOMES}
    return T


def write(model, rmap, dx, pol, real, spread, wbase):
    data = {
        "source": f"Cricsheet ball-by-ball men's Tests {FIT_FROM}-, IPF fit (packages/ratings/src/analysis/test-match-model.py)",
        "outcomes": OUTCOMES,
        "base": {"male": {k: r(model[k]["base"], 5) for k in OUTCOMES}, "female": {k: r(wbase[k], 5) for k in OUTCOMES}},
        "bins": {"age": AGE_BINS, "set": SET_BINS, "wicketsDown": WD_BINS, "spell": SPELL_MAX, "chaseRate": RR_BINS, "pushOvers": PUSH_OVERS},
        "factors": tables(model),
        "matchSpread": spread,
        "inningsSpread": innings_spread(model),
        "wearSpread": pitch_wear(),
        "players": rmap,
        **dx,
        "policy": pol,
        "real": real,
    }
    body = json.dumps(data, indent=1)
    header = f"""/**
 * GENERATED by packages/ratings/src/analysis/test-match-model.py from Cricsheet Test ball-by-ball data. Do not edit by hand.
 *
 * The Test ball model (docs/FORMATS-TEST.md): per-delivery base rates for the outcome classes (a dot is what is left) and
 * multiplicative factors for ball age, batter set-ness, innings, day x pace / spin, spell, situation, home side, venue
 * country x pace / spin, era, plus the rating -> player-term mapping, dismissal kinds, extras, DRS, the team-decision
 * policies (toss, declarations, follow-on, bowling, time and weather) and the real targets the benchmark compares with.
 */

export const TEST_MODEL = {body} as const;

export type TestModel = typeof TEST_MODEL;
"""
    OUT_TS.write_text(header)
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    json.dump({**data, "eraFactors": data["factors"]["era"]}, open(OUT_JSON, "w"), indent=1)
    log("wrote", OUT_TS, OUT_JSON)


def main():
    parse_json()
    write_espn_styles()
    build_balls()
    build_fit_table()
    model = fit_all()
    test_sets = load_test_sets()
    gp_t20 = load_game_players("t20", test_sets)
    rmap = {"t20": with_regressions(rating_map(model, gp_t20), rating_regression(model, gp_t20, "t20"), model, gp_t20)}
    if test_sets:
        gp_test = load_game_players("test", test_sets)
        rmap["test"] = with_regressions(rating_map(model, gp_test), rating_regression(model, gp_test, "test"), model, gp_test)
    dx = dismissals_extras()
    pol = policies()
    real = {"male": real_targets("male", VALID_FROM), "male2023": real_targets("male", 2023), "male2022": real_targets("male", 2022),
            "female": real_targets("female", 2014)}
    spread = match_spread(model)
    wbase = women_base(model)
    write(model, rmap, dx, pol, real, spread, wbase)
    gp_all = {p["id"]: p for p in json.load(open(DATA / "game_players.json"))}
    sq = squads(gp_all, test_sets)
    OUT_SQUADS.write_text(json.dumps({"source": "test-match-model.py: most-capped Test players since 2023 (women 2021) in game_players.json", "squads": sq}, indent=1))
    log("squads:", ", ".join(f"{x['team']} ({x['gender']}, {len(x['players'])})" for x in sq))


if __name__ == "__main__":
    main()
