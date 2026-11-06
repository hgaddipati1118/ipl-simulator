"""
Bottom-up league and match strength: rate everyone on the pitch in every senior scorecard, then average.

Idea: a competition is as strong as the players who actually take the field in it.  Every player in every senior
match (2000+, T20 / List A / first-class, men and women) gets a PRE-MATCH rating = his CricketArchive rating
(ca_ratings_by_year.parquet, from ca-ratings.py) as of the end of the previous calendar year, so the match itself
never feeds the strength it is scored with.

Inputs (packages/ratings):
    data/cricket.db                              matches / batting / bowling
    data/analysis/ca_ratings_by_year.parquet     per player x format x year ratings (runs per 100 balls above the
                                                 average ball in that format, league-adjusted)
    src/analysis/competition_aliases.csv         event name -> canonical competition (sponsor renames)
Outputs (data/analysis/):
    match_strength.parquet        one row per match: both XIs' batting / bowling / total strength, coverage
    team_strength_by_season.csv   per team x competition x season
    league_strength_index.csv     per competition x season x format x gender: strength, SE, index
    competition_aliases.csv       copy of the alias table used
    league-strength-report.md     method, anchors, headline tables, trends, comparison with top-down strengths

Method
 1. Pre-match rating per player, side and format: latest year < match year with a rating (batting and bowling
    separately; a bowling rating only exists once a player has bowled).  Fallbacks, in order:
      a. cross-format: the player's latest prior rating in another format, mapped linearly to this format
         (regression fitted on player-years rated in both formats with regular-size samples);
      b. debutant prior: the mean end-of-debut-year rating of players who debuted in the same format x gender x
         class (domestic country / international full member vs associate) x batting-position bucket; then the
         full/associate super-class; then format x gender.
 2. XI strength.  Batting = mean of the XI's batting ratings weighted by EXPECTED usage at their batting position
    (share of team balls faced at that position, format x gender; uses the card's position, so "did not bat"
    players still count).  Bowling = mean of bowling ratings weighted by balls actually bowled.  Team strength =
    batting + bowling (runs per 100 balls above an average team).  A gap of 10 between two teams ~ the stronger
    side wins each 100 balls batted and bowled by ~10 runs.
 3. League-season strength = mean team strength over its matches; SE = sd of match means / sqrt(matches)
    (matches share teams, so treat SEs as lower bounds).  Index = 100 + (strength - anchor strength); anchors:
      T20 men  : Indian Premier League 2024          T20 women : Women's Premier League 2024
      List A   : ODIs between full members, 2024     FC men    : Tests between full members, 2024
      FC women : Women's Tests between full members, all seasons pooled (too few per year)
    Indexes are comparable within a format x gender, not across.
 4. Season = the season label's last year (BBL 2023-24 -> 2024), except that a two-year label in a competition that otherwise
    uses single-year labels means its first year (the UAE IPL of 2020 is labelled "2020-21" -> 2020); internationals by
    calendar year.  Seasons labelled 2026-27 or later are flagged in_progress.
    Internationals are grouped by pairing class (FM v FM, FM v Assoc, Assoc v Assoc; Ireland and Afghanistan full
    members from 22 June 2017) and reported per team in team_strength_by_season.csv.

Run from packages/ratings:  python3 -I src/analysis/league-strength-index.py
"""
import csv, json, math, os, subprocess, sys, time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
ALIASES = Path(__file__).resolve().parent / "competition_aliases.csv"
TMP = Path(os.environ.get("STRENGTH_WORK", "/Volumes/Data/tmp/strength"))
TMP.mkdir(parents=True, exist_ok=True)

ANCHORS = {
    ("T20", "male"): ("Indian Premier League", [2024]),
    ("T20", "female"): ("Women's Premier League", [2024]),
    ("ListA", "male"): ("ODI (FM v FM)", [2024]),
    ("ListA", "female"): ("ODI (FM v FM)", [2024]),
    ("FC", "male"): ("Test (FM v FM)", [2024]),
    ("FC", "female"): ("Test (FM v FM)", list(range(2000, 2027))),
}
REG = {"T20": 120, "ListA": 240, "FC": 600}
CURRENT = 2026   # latest season label year treated as complete; "2026-27" seasons are still in progress
FM = "('Australia','Bangladesh','England','India','New Zealand','Pakistan','South Africa','Sri Lanka','West Indies','Zimbabwe')"


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)


def duck_script(sql):
    out = subprocess.run(["duckdb"], input=sql, capture_output=True, text=True, cwd=ROOT)
    if out.returncode:
        sys.exit(out.stderr[-4000:])
    return out.stdout


def duck_rows(sql):
    out = subprocess.run(["duckdb", "-csv", "-nullvalue", "", "-c", sql], capture_output=True, text=True, cwd=ROOT)
    if out.returncode:
        sys.exit(out.stderr[-4000:])
    return list(csv.DictReader(out.stdout.splitlines()))


def team_class(col, date_col):
    t = f"regexp_replace({col}, ' Women$', '')"
    return (f"CASE WHEN {t} IN {FM} OR ({t} IN ('Ireland','Afghanistan') AND {date_col} >= DATE '2017-06-22') "
            f"THEN 'FM' ELSE 'Assoc' END")


BUILD = f"""
LOAD sqlite;
ATTACH 'data/cricket.db' AS c (TYPE sqlite, READ_ONLY);
SET threads = 2;
SET memory_limit = '2GB';
SET temp_directory = '{TMP}/duckdb';
SET preserve_insertion_order = false;

CREATE TEMP TABLE alias AS SELECT format, gender, event_key, try_cast(season_from AS INT) s0, try_cast(season_to AS INT) s1, competition, tier
FROM read_csv('{ALIASES}', header = true, all_varchar = true);

CREATE TEMP TABLE m0 AS
SELECT id, date::DATE AS date, year(date::DATE) AS year, team1, team2, country, levels,
       CASE WHEN levels LIKE '%Women%' THEN 'female' ELSE 'male' END AS gender,
       CASE WHEN levels LIKE '%Twenty20%' THEN 'T20' WHEN levels LIKE '%List A%' THEN 'ListA'
            WHEN levels LIKE '%First-Class%' THEN 'FC' END AS format,
       (levels LIKE '%International%' OR levels LIKE '%Test"%' OR levels LIKE '%ODI%') AS intl,
       levels LIKE '%Test"%' AS is_test,
       CASE WHEN regexp_matches(coalesce(season, ''), '^[0-9]{{4}}-[0-9]{{2,4}}$') THEN try_cast(left(season, 4) AS INT) + 1
            ELSE coalesce(try_cast(left(season, 4) AS INT), year(date::DATE)) END AS label_year,
       coalesce(season, '') AS season_label,
       lower(trim(regexp_replace(regexp_replace(regexp_replace(coalesce(event, 'misc ' || coalesce(country, '')),
             '\\s*\\([^)]*\\)\\s*$', ''), '\\b(19|20)\\d{{2}}(/\\d{{2,4}})?\\b', '', 'g'), '\\s+', ' ', 'g'))) AS event_key
FROM c.matches
WHERE date IS NOT NULL AND try_cast(date AS DATE) IS NOT NULL AND year(date::DATE) >= 2000
  AND (levels LIKE '%Twenty20%' OR levels LIKE '%List A%' OR levels LIKE '%First-Class%');

CREATE TEMP TABLE m1 AS
SELECT m0.*, {team_class('team1', 'm0.date')} AS cls1, {team_class('team2', 'm0.date')} AS cls2,
       CASE WHEN m0.intl THEN
              (CASE WHEN m0.format = 'T20' THEN 'T20I' WHEN m0.format = 'ListA' THEN 'ODI'
                    WHEN m0.is_test THEN 'Test' ELSE 'FC international' END) || ' (' ||
              CASE WHEN {team_class('team1', 'm0.date')} = 'FM' AND {team_class('team2', 'm0.date')} = 'FM' THEN 'FM v FM'
                   WHEN {team_class('team1', 'm0.date')} = 'FM' OR {team_class('team2', 'm0.date')} = 'FM' THEN 'FM v Assoc'
                   ELSE 'Assoc v Assoc' END || ')'
            ELSE coalesce(a.competition, m0.event_key) END AS competition,
       CASE WHEN m0.intl THEN 'international' ELSE coalesce(a.tier, 'domestic') END AS tier,
       CASE WHEN m0.intl THEN (CASE WHEN m0.format = 'T20' THEN 'T20I' WHEN m0.format = 'ListA' THEN 'ODI'
                                    WHEN m0.is_test THEN 'Test' ELSE 'FC international' END)
            ELSE coalesce(a.competition, m0.event_key) END AS team_group
FROM m0 LEFT JOIN alias a
  ON a.format = m0.format AND a.gender = m0.gender AND a.event_key = m0.event_key
 AND (a.s0 IS NULL OR m0.label_year >= a.s0) AND (a.s1 IS NULL OR m0.label_year <= a.s1)
WHERE m0.format IS NOT NULL;

-- season = the label's last year ("2023-24" -> 2024), except that a two-year label in a competition that otherwise uses
-- single-year labels means its first year (the UAE IPL of Sept-Nov 2020 is labelled "2020-21"; IPL 2021 is "2021").
-- Internationals by calendar year.
CREATE TEMP TABLE single_years AS
SELECT DISTINCT format, gender, competition, label_year FROM m1 WHERE regexp_matches(season_label, '^[0-9]{{4}}$');
CREATE TEMP TABLE m AS
SELECT m1.*, CASE WHEN m1.intl THEN year(m1.date)
                  WHEN regexp_matches(m1.season_label, '^[0-9]{{4}}-') AND sy.label_year IS NOT NULL THEN m1.label_year - 1
                  ELSE m1.label_year END AS season_year,
       (NOT m1.intl AND m1.label_year > {CURRENT}) AS in_progress
FROM m1 LEFT JOIN single_years sy ON sy.format = m1.format AND sy.gender = m1.gender AND sy.competition = m1.competition
                                AND sy.label_year = m1.label_year;
DROP TABLE m1; DROP TABLE single_years;

-- one row per player per match-team: card position, balls faced, balls bowled
CREATE TEMP TABLE bat_app AS
SELECT b.match_id, b.team, b.player_id, min(b.position) AS pos, sum(coalesce(b.balls, 0)) AS bf, bool_or(b.balls IS NOT NULL) AS has_balls
FROM c.batting b WHERE b.match_id IN (SELECT id FROM m) AND b.player_id IS NOT NULL GROUP BY ALL;
-- balls bowled from overs; Hundred cards have no overs, and their economy is runs per 100 balls
CREATE TEMP TABLE bowl_app AS
SELECT w.match_id, w.team, w.player_id,
       sum(CASE WHEN nullif(w.overs, '') IS NOT NULL
                THEN try_cast(split_part(w.overs, '.', 1) AS INT) * 6 + coalesce(try_cast(nullif(split_part(w.overs, '.', 2), '') AS INT), 0)
                WHEN w.economy > 0 THEN round(w.runs * (CASE WHEN m.event_key LIKE '%hundred%' THEN 100.0 ELSE 6.0 END) / w.economy)::INT END) AS bb
FROM c.bowling w JOIN m ON m.id = w.match_id
WHERE w.player_id IS NOT NULL AND (nullif(w.overs, '') IS NOT NULL OR w.economy > 0) GROUP BY ALL;

CREATE TEMP TABLE apps AS
SELECT coalesce(b.match_id, w.match_id) AS match_id, coalesce(b.team, w.team) AS team, coalesce(b.player_id, w.player_id) AS player_id,
       b.pos, coalesce(b.bf, 0) AS bf, coalesce(b.has_balls, false) AS has_balls, coalesce(w.bb, 0) AS bb
FROM bat_app b FULL OUTER JOIN bowl_app w ON b.match_id = w.match_id AND b.team = w.team AND b.player_id = w.player_id;

CREATE TEMP TABLE a AS
SELECT x.*, m.date, m.year, m.year - 1 AS prev_year, m.format, m.gender, m.intl, m.country,
       CASE WHEN m.intl THEN 'intl_' || CASE WHEN x.team = m.team1 THEN m.cls1 ELSE m.cls2 END
            ELSE 'dom_' || coalesce(m.country, '?') END AS cls,
       CASE WHEN x.pos IS NULL THEN 'none' WHEN x.pos <= 3 THEN 'top' WHEN x.pos <= 7 THEN 'mid' ELSE 'low' END AS bucket
FROM apps x JOIN m ON m.id = x.match_id;
DROP TABLE apps; DROP TABLE bat_app; DROP TABLE bowl_app;

-- expected batting usage by card position (share of team balls faced), format x gender
CREATE TEMP TABLE pos_share AS
WITH tm AS (SELECT match_id, team, format, gender, sum(bf) tb FROM a WHERE has_balls GROUP BY ALL HAVING sum(bf) > 0),
     ps AS (SELECT a.format, a.gender, a.pos, sum(a.bf) pb FROM a JOIN tm USING (match_id, team, format, gender) WHERE a.pos IS NOT NULL GROUP BY ALL),
     tot AS (SELECT format, gender, sum(tb) t FROM tm GROUP BY ALL)
SELECT ps.format, ps.gender, ps.pos, ps.pb / tot.t AS share FROM ps JOIN tot USING (format, gender);

CREATE TEMP TABLE r AS SELECT player_id, format, gender, year, bat_rating, bowl_rating, bat_balls, bowl_balls
FROM 'data/analysis/ca_ratings_by_year.parquet';
CREATE TEMP TABLE rbat AS SELECT player_id, format, year, bat_rating AS v FROM r WHERE bat_rating IS NOT NULL;
CREATE TEMP TABLE rbowl AS SELECT player_id, format, year, bowl_rating AS v FROM r WHERE bowl_rating IS NOT NULL;

-- cross-format maps: target ~ intercept + slope * source, same player-year, regular samples in both
CREATE TEMP TABLE xmap AS
WITH b AS (SELECT * FROM r WHERE bat_balls >= CASE format WHEN 'T20' THEN {REG['T20']} WHEN 'ListA' THEN {REG['ListA']} ELSE {REG['FC']} END),
     w AS (SELECT * FROM r WHERE bowl_balls >= CASE format WHEN 'T20' THEN {REG['T20']} WHEN 'ListA' THEN {REG['ListA']} ELSE {REG['FC']} END)
SELECT 'bat' side, t.gender, t.format tf, s.format sf, regr_intercept(t.bat_rating, s.bat_rating) ic, regr_slope(t.bat_rating, s.bat_rating) sl, count(*) n
FROM b t JOIN b s ON s.player_id = t.player_id AND s.year = t.year AND s.format <> t.format GROUP BY ALL
UNION ALL
SELECT 'bowl', t.gender, t.format, s.format, regr_intercept(t.bowl_rating, s.bowl_rating), regr_slope(t.bowl_rating, s.bowl_rating), count(*)
FROM w t JOIN w s ON s.player_id = t.player_id AND s.year = t.year AND s.format <> t.format GROUP BY ALL;

-- same-format pre-match ratings
CREATE TEMP TABLE pre AS
SELECT a.*, sb.v AS bat_same, sw.v AS bowl_same
FROM a
ASOF LEFT JOIN rbat sb ON sb.player_id = a.player_id AND sb.format = a.format AND a.prev_year >= sb.year
ASOF LEFT JOIN rbowl sw ON sw.player_id = a.player_id AND sw.format = a.format AND a.prev_year >= sw.year;
DROP TABLE a;

-- cross-format candidates (latest prior rating in each other format)
CREATE TEMP TABLE pre2 AS
WITH fx AS (SELECT * FROM (VALUES ('T20','ListA',1),('T20','FC',2),('ListA','T20',1),('ListA','FC',2),('FC','ListA',1),('FC','T20',2)) t(tf, sf, pri))
SELECT p.match_id, p.team, p.player_id, fx.sf, fx.pri, xb.v AS bat_src, xw.v AS bowl_src
FROM pre p JOIN fx ON fx.tf = p.format
ASOF LEFT JOIN rbat xb ON xb.player_id = p.player_id AND xb.format = fx.sf AND p.prev_year >= xb.year
ASOF LEFT JOIN rbowl xw ON xw.player_id = p.player_id AND xw.format = fx.sf AND p.prev_year >= xw.year
WHERE p.bat_same IS NULL OR (p.bowl_same IS NULL AND p.bb > 0);

CREATE TEMP TABLE xf AS
SELECT x.match_id, x.team, x.player_id,
       arg_min(mb.ic + mb.sl * x.bat_src, x.pri) FILTER (WHERE x.bat_src IS NOT NULL AND mb.sl IS NOT NULL) AS bat_cross,
       arg_min(mw.ic + mw.sl * x.bowl_src, x.pri) FILTER (WHERE x.bowl_src IS NOT NULL AND mw.sl IS NOT NULL) AS bowl_cross
FROM pre2 x JOIN pre p USING (match_id, team, player_id)
LEFT JOIN xmap mb ON mb.side = 'bat' AND mb.gender = p.gender AND mb.tf = p.format AND mb.sf = x.sf AND mb.n >= 200 AND mb.sl > 0
LEFT JOIN xmap mw ON mw.side = 'bowl' AND mw.gender = p.gender AND mw.tf = p.format AND mw.sf = x.sf AND mw.n >= 200 AND mw.sl > 0
GROUP BY ALL;
DROP TABLE pre2;

-- debutant priors: mean end-of-debut-year rating by format x gender x class x bucket (batting) / class (bowling)
CREATE TEMP TABLE first_bat AS SELECT player_id, format, min(year) y0 FROM rbat GROUP BY ALL;
CREATE TEMP TABLE first_bowl AS SELECT player_id, format, min(year) y0 FROM rbowl GROUP BY ALL;
CREATE TEMP TABLE deb_bat AS
SELECT p.format, p.gender, p.cls, p.bucket, avg(rb.v) v, count(DISTINCT p.player_id) n
FROM pre p JOIN first_bat f ON f.player_id = p.player_id AND f.format = p.format AND f.y0 = p.year
JOIN rbat rb ON rb.player_id = p.player_id AND rb.format = p.format AND rb.year = p.year
GROUP BY ALL;
CREATE TEMP TABLE deb_bowl AS
SELECT p.format, p.gender, p.cls, avg(rw.v) v, count(DISTINCT p.player_id) n
FROM pre p JOIN first_bowl f ON f.player_id = p.player_id AND f.format = p.format AND f.y0 = p.year
JOIN rbowl rw ON rw.player_id = p.player_id AND rw.format = p.format AND rw.year = p.year
WHERE p.bb > 0 GROUP BY ALL;

CREATE TEMP TABLE supcls AS SELECT DISTINCT cls,
  CASE WHEN cls IN ('intl_FM','dom_ENG','dom_IND','dom_RSA','dom_AUS','dom_PAK','dom_SL','dom_NZ','dom_WI','dom_BDESH','dom_ZIM','dom_IRELAND','dom_AFG','dom_UAE','dom_USA') THEN 'full' ELSE 'assoc' END AS sup
FROM pre;
CREATE TEMP TABLE deb_bat_sup AS SELECT d.format, d.gender, s.sup, d.bucket, sum(d.v * d.n) / sum(d.n) v FROM deb_bat d JOIN supcls s USING (cls) GROUP BY ALL;
CREATE TEMP TABLE deb_bat_all AS SELECT format, gender, bucket, sum(v * n) / sum(n) v FROM deb_bat GROUP BY ALL;
CREATE TEMP TABLE deb_bowl_sup AS SELECT d.format, d.gender, s.sup, sum(d.v * d.n) / sum(d.n) v FROM deb_bowl d JOIN supcls s USING (cls) GROUP BY ALL;
CREATE TEMP TABLE deb_bowl_all AS SELECT format, gender, sum(v * n) / sum(n) v FROM deb_bowl GROUP BY ALL;

CREATE TEMP TABLE rated AS
SELECT p.match_id, p.team, p.player_id, p.format, p.gender, p.pos, p.bb, p.cls,
       coalesce(ps.share, 0) AS w_bat,
       coalesce(p.bat_same, x.bat_cross, d1.v, d2.v, d3.v) AS bat,
       CASE WHEN p.bat_same IS NOT NULL THEN 'same' WHEN x.bat_cross IS NOT NULL THEN 'cross' ELSE 'debut' END AS bat_src,
       CASE WHEN p.bb > 0 THEN coalesce(p.bowl_same, x.bowl_cross, e1.v, e2.v, e3.v) END AS bowl,
       CASE WHEN p.bb = 0 THEN NULL WHEN p.bowl_same IS NOT NULL THEN 'same' WHEN x.bowl_cross IS NOT NULL THEN 'cross' ELSE 'debut' END AS bowl_src
FROM pre p
LEFT JOIN xf x USING (match_id, team, player_id)
LEFT JOIN pos_share ps ON ps.format = p.format AND ps.gender = p.gender AND ps.pos = p.pos
LEFT JOIN supcls s ON s.cls = p.cls
LEFT JOIN deb_bat d1 ON d1.format = p.format AND d1.gender = p.gender AND d1.cls = p.cls AND d1.bucket = p.bucket AND d1.n >= 20
LEFT JOIN deb_bat_sup d2 ON d2.format = p.format AND d2.gender = p.gender AND d2.sup = s.sup AND d2.bucket = p.bucket
LEFT JOIN deb_bat_all d3 ON d3.format = p.format AND d3.gender = p.gender AND d3.bucket = p.bucket
LEFT JOIN deb_bowl e1 ON e1.format = p.format AND e1.gender = p.gender AND e1.cls = p.cls AND e1.n >= 20
LEFT JOIN deb_bowl_sup e2 ON e2.format = p.format AND e2.gender = p.gender AND e2.sup = s.sup
LEFT JOIN deb_bowl_all e3 ON e3.format = p.format AND e3.gender = p.gender;

CREATE TEMP TABLE team_str AS
SELECT match_id, team,
       sum(w_bat * bat) / nullif(sum(w_bat) FILTER (WHERE bat IS NOT NULL), 0) AS bat_xi,
       sum(bb * bowl) / nullif(sum(bb) FILTER (WHERE bowl IS NOT NULL), 0) AS bowl_xi,
       count(*) AS n_players,
       count(*) FILTER (WHERE bat_src = 'same') AS n_bat_same,
       count(*) FILTER (WHERE bat_src = 'cross') AS n_bat_cross,
       count(*) FILTER (WHERE bat_src = 'debut') AS n_bat_debut,
       sum(w_bat) FILTER (WHERE bat_src = 'same') / nullif(sum(w_bat), 0) AS bat_w_same,
       sum(bb) FILTER (WHERE bowl_src = 'same') / nullif(sum(bb), 0) AS bowl_w_same,
       sum(bb) AS team_bb
FROM rated GROUP BY ALL;

CREATE TEMP TABLE ms AS
SELECT m.id AS match_id, m.date, m.season_year, m.season_label, m.in_progress, m.format, m.gender, m.competition, m.tier, m.team_group, m.country, m.intl,
       m.team1, m.team2, m.cls1, m.cls2,
       t1.bat_xi AS bat1, t1.bowl_xi AS bowl1, t1.bat_xi + t1.bowl_xi AS str1,
       t2.bat_xi AS bat2, t2.bowl_xi AS bowl2, t2.bat_xi + t2.bowl_xi AS str2,
       (t1.bat_xi + t1.bowl_xi + t2.bat_xi + t2.bowl_xi) / 2 AS match_str,
       t1.n_players + t2.n_players AS n_players,
       t1.n_bat_same + t2.n_bat_same AS n_rated, t1.n_bat_cross + t2.n_bat_cross AS n_cross, t1.n_bat_debut + t2.n_bat_debut AS n_debut,
       (coalesce(t1.bat_w_same, 0) + coalesce(t2.bat_w_same, 0)) / 2 AS bat_w_rated,
       (coalesce(t1.bowl_w_same, 0) + coalesce(t2.bowl_w_same, 0)) / 2 AS bowl_w_rated
FROM m JOIN team_str t1 ON t1.match_id = m.id AND t1.team = m.team1
       JOIN team_str t2 ON t2.match_id = m.id AND t2.team = m.team2
WHERE t1.bat_xi IS NOT NULL AND t2.bat_xi IS NOT NULL AND t1.bowl_xi IS NOT NULL AND t2.bowl_xi IS NOT NULL;

COPY ms TO 'data/analysis/match_strength.parquet' (FORMAT parquet);

COPY (
  SELECT format, gender, competition, tier, season_year, bool_or(in_progress) AS in_progress, count(*) AS matches,
         avg(match_str) AS strength, stddev_samp(match_str) / sqrt(count(*)) AS se,
         avg((bat1 + bat2) / 2) AS bat, avg((bowl1 + bowl2) / 2) AS bowl,
         avg(bat_w_rated) AS bat_w_rated, avg(bowl_w_rated) AS bowl_w_rated,
         sum(n_rated)::DOUBLE / sum(n_players) AS share_rated, sum(n_cross)::DOUBLE / sum(n_players) AS share_cross,
         sum(n_debut)::DOUBLE / sum(n_players) AS share_debut,
         count(DISTINCT team1) + count(DISTINCT team2) AS team_slots
  FROM ms GROUP BY ALL
) TO '{TMP}/league_raw.csv' (HEADER, DELIMITER ',');

COPY (
  WITH t AS (
    SELECT format, gender, team_group, season_year, team1 AS team, str1 AS str, bat1 AS bat, bowl1 AS bowl FROM ms
    UNION ALL SELECT format, gender, team_group, season_year, team2, str2, bat2, bowl2 FROM ms)
  SELECT format, gender, team_group AS competition, team, season_year, count(*) AS matches, avg(str) AS strength,
         stddev_samp(str) / sqrt(count(*)) AS se, avg(bat) AS bat, avg(bowl) AS bowl
  FROM t GROUP BY ALL
) TO '{TMP}/team_raw.csv' (HEADER, DELIMITER ',');

-- sanity check: does the pre-match strength gap predict the winner?
COPY (
  WITH x AS (SELECT s.format, s.gender, abs(s.str1 - s.str2) AS gap,
                    CASE WHEN mm.result LIKE s.team1 || ' won%' THEN (s.str1 > s.str2)
                         WHEN mm.result LIKE s.team2 || ' won%' THEN (s.str2 > s.str1) END AS stronger_won
             FROM ms s JOIN c.matches mm ON mm.id = s.match_id)
  SELECT format, gender,
         CASE WHEN gap < 3 THEN '0-3' WHEN gap < 6 THEN '3-6' WHEN gap < 10 THEN '6-10' WHEN gap < 15 THEN '10-15' ELSE '15+' END AS gap_bucket,
         count(*) AS decided, avg(stronger_won::INT) AS stronger_win_rate
  FROM x WHERE stronger_won IS NOT NULL GROUP BY ALL
  UNION ALL
  SELECT format, gender, 'all', count(*), avg(stronger_won::INT) FROM x WHERE stronger_won IS NOT NULL GROUP BY ALL
) TO '{TMP}/predict.csv' (HEADER, DELIMITER ',');

COPY (SELECT * FROM xmap ORDER BY ALL) TO '{TMP}/xmap.csv' (HEADER, DELIMITER ',');
COPY (SELECT format, gender, pos, round(share, 4) share FROM pos_share ORDER BY ALL) TO '{TMP}/pos_share.csv' (HEADER, DELIMITER ',');
COPY (SELECT rated.format, rated.gender, year(m.date) yr, count(*) apps,
             avg((bat_src = 'same')::INT) same, avg((bat_src = 'cross')::INT) cross_, avg((bat_src = 'debut')::INT) debut
      FROM rated JOIN m ON m.id = rated.match_id GROUP BY ALL ORDER BY ALL) TO '{TMP}/coverage.csv' (HEADER, DELIMITER ',');
"""


def read_csv(p):
    with open(p, newline="") as f:
        return list(csv.DictReader(f))


def fnum(x):
    return float(x) if x not in (None, "") else float("nan")


def wlinfit(xs, ys, ws):
    sw = sum(ws)
    mx = sum(x * w for x, w in zip(xs, ws)) / sw
    my = sum(y * w for y, w in zip(ys, ws)) / sw
    sxx = sum(w * (x - mx) ** 2 for x, w in zip(xs, ws))
    sxy = sum(w * (x - mx) * (y - my) for x, y, w in zip(xs, ys, ws))
    b = sxy / sxx if sxx else 0.0
    return my - b * mx, b


def corr(xs, ys, ws=None):
    ws = ws or [1.0] * len(xs)
    sw = sum(ws)
    if len(xs) < 3 or sw == 0:
        return float("nan")
    mx = sum(x * w for x, w in zip(xs, ws)) / sw
    my = sum(y * w for y, w in zip(ys, ws)) / sw
    cxy = sum(w * (x - mx) * (y - my) for x, y, w in zip(xs, ys, ws))
    cxx = sum(w * (x - mx) ** 2 for x, w in zip(xs, ws))
    cyy = sum(w * (y - my) ** 2 for y, w in zip(ys, ws))
    return cxy / math.sqrt(cxx * cyy) if cxx > 0 and cyy > 0 else float("nan")


def main():
    t0 = time.time()
    (TMP / "duckdb").mkdir(exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)
    log("building match strength (duckdb)")
    duck_script(BUILD)
    log(f"duckdb done in {time.time() - t0:.0f}s")

    # ── league-season index ─────────────────────────────────────────────────────
    raw = read_csv(TMP / "league_raw.csv")
    anchor_val = {}
    for (fmt, g), (comp, years) in ANCHORS.items():
        rows = [r for r in raw if r["format"] == fmt and r["gender"] == g and r["competition"] == comp and int(r["season_year"]) in years
                and r["in_progress"] != "true"]
        n = sum(int(r["matches"]) for r in rows)
        if not n:
            sys.exit(f"anchor missing: {fmt} {g} {comp} {years}")
        anchor_val[(fmt, g)] = sum(fnum(r["strength"]) * int(r["matches"]) for r in rows) / n
    out = []
    for r in raw:
        a = anchor_val[(r["format"], r["gender"])]
        s = fnum(r["strength"])
        out.append({
            "format": r["format"], "gender": r["gender"], "competition": r["competition"], "tier": r["tier"],
            "season": int(r["season_year"]), "in_progress": r["in_progress"] == "true", "matches": int(r["matches"]),
            "strength": round(s, 3), "se": round(fnum(r["se"]), 3) if r["se"] else "",
            "index": round(100 + s - a, 2), "index_lo95": round(100 + s - a - 1.96 * fnum(r["se"]), 2) if r["se"] else "",
            "index_hi95": round(100 + s - a + 1.96 * fnum(r["se"]), 2) if r["se"] else "",
            "bat": round(fnum(r["bat"]), 3), "bowl": round(fnum(r["bowl"]), 3),
            "share_rated": round(fnum(r["share_rated"]), 3), "share_cross_format": round(fnum(r["share_cross"]), 3),
            "share_debut_prior": round(fnum(r["share_debut"]), 3),
            "bat_usage_rated": round(fnum(r["bat_w_rated"]), 3), "bowl_usage_rated": round(fnum(r["bowl_w_rated"]), 3),
        })
    out.sort(key=lambda r: (r["format"], r["gender"], r["competition"], r["season"]))
    with open(DATA / "league_strength_index.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
        w.writeheader()
        w.writerows(out)

    teams = read_csv(TMP / "team_raw.csv")
    tout = []
    for r in teams:
        a = anchor_val[(r["format"], r["gender"])]
        s = fnum(r["strength"])
        tout.append({"format": r["format"], "gender": r["gender"], "competition": r["competition"], "team": r["team"],
                     "season": int(r["season_year"]), "matches": int(r["matches"]), "strength": round(s, 3),
                     "se": round(fnum(r["se"]), 3) if r["se"] else "", "index": round(100 + s - a, 2),
                     "bat": round(fnum(r["bat"]), 3), "bowl": round(fnum(r["bowl"]), 3)})
    tout.sort(key=lambda r: (r["format"], r["gender"], r["competition"], r["team"], r["season"]))
    with open(DATA / "team_strength_by_season.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(tout[0].keys()))
        w.writeheader()
        w.writerows(tout)
    with open(ALIASES) as src, open(DATA / "competition_aliases.csv", "w") as dst:
        dst.write(src.read())
    log(f"{len(out)} league-seasons, {len(tout)} team-seasons")

    report(out, tout, anchor_val)
    log(f"done in {time.time() - t0:.0f}s")


# ── report ────────────────────────────────────────────────────────────────────

T20M_KEY = ["Indian Premier League", "Big Bash League", "Pakistan Super League", "Caribbean Premier League", "SA20",
            "ILT20", "Major League Cricket", "The Hundred (men)", "T20 Blast", "Bangladesh Premier League",
            "Lanka Premier League", "Syed Mushtaq Ali Trophy", "Super Smash", "CSA T20 Challenge",
            "Pakistan National T20 Cup", "T20I (FM v FM)", "T20I (FM v Assoc)", "T20I (Assoc v Assoc)"]
T20F_KEY = ["Women's Premier League", "Women's Big Bash League", "The Hundred (women)", "Women's Cricket Super League",
            "Women's Caribbean Premier League", "Charlotte Edwards Cup", "Women's Vitality Blast (tier 1)",
            "Women's Super Smash", "Senior Women's T20 Trophy (India)", "CSA Women's Pro T20", "Women's County T20",
            "T20I (FM v FM)", "T20I (FM v Assoc)", "T20I (Assoc v Assoc)"]
YEARS = [2008, 2012, 2015, 2018, 2021, 2023, 2024, 2025, 2026]


def series(out, fmt, g, comp, min_matches=8):
    return {r["season"]: r for r in out if r["format"] == fmt and r["gender"] == g and r["competition"] == comp
            and r["matches"] >= min_matches and not r["in_progress"]}


def trend(s, since=2015):
    pts = [(y, r["index"], r["matches"]) for y, r in s.items() if since <= y]
    if len(pts) < 3:
        return float("nan")
    a, b = wlinfit([p[0] for p in pts], [p[1] for p in pts], [p[2] for p in pts])
    return b


def fmt_cell(r):
    return f"{r['index']:.1f}" if r else "–"


def league_table(out, fmt, g, comps):
    lines = ["| competition | " + " | ".join(str(y) for y in YEARS) + " | latest (season, matches, ±95%) | trend since 2015 /yr |",
             "|---|" + "---|" * (len(YEARS) + 2)]
    rows = []
    for comp in comps:
        s = series(out, fmt, g, comp)
        if not s:
            rows.append((float("-inf"), f"| {comp} | " + " | ".join("–" for _ in YEARS) + " | not in senior CricketArchive data | – |"))
            continue
        done = list(s)
        if not done:
            continue
        ly = max(done)
        lr = s[ly]
        ci = f"±{1.96 * lr['se']:.1f}" if lr["se"] != "" else ""
        tr = trend(s)
        rows.append((lr["index"], f"| {comp} | " + " | ".join(fmt_cell(s.get(y)) for y in YEARS) +
                     f" | **{lr['index']:.1f}** ({ly}, {lr['matches']}, {ci}) | {'–' if math.isnan(tr) else f'{tr:+.2f}'} |"))
    rows.sort(key=lambda x: -x[0])
    return "\n".join(lines + [r[1] for r in rows])


def top_table(out, fmt, g, season, n=20, min_matches=15):
    rows = [r for r in out if r["format"] == fmt and r["gender"] == g and r["season"] == season and r["matches"] >= min_matches and not r["in_progress"]]
    rows.sort(key=lambda r: -r["index"])
    lines = ["| # | competition | index | ±95% | matches | rated share | bat | bowl |", "|---|---|---|---|---|---|---|---|"]
    for i, r in enumerate(rows[:n], 1):
        ci = f"±{1.96 * r['se']:.1f}" if r["se"] != "" else ""
        lines.append(f"| {i} | {r['competition']} | {r['index']:.1f} | {ci} | {r['matches']} | {r['share_rated']:.0%} | {r['bat']:+.1f} | {r['bowl']:+.1f} |")
    return "\n".join(lines)


def compare_topdown(out):
    """Pooled bottom-up strength per domestic competition vs the top-down fitted strengths."""
    alias = {}
    with open(ALIASES, newline="") as f:
        for r in csv.DictReader(f):
            alias[(r["format"], r["gender"], r["event_key"])] = r["competition"]
    bu = defaultdict(lambda: [0.0, 0])
    for r in out:
        if r["tier"] == "international":
            continue
        k = (r["format"], r["gender"], r["competition"])
        bu[k][0] += r["strength"] * r["matches"]
        bu[k][1] += r["matches"]
    bu = {k: (v[0] / v[1], v[1]) for k, v in bu.items() if v[1] >= 40}

    # CricketArchive model (ca_comp_strength.csv): bat-side + bowl-side strength, ball-weighted by canonical comp
    td = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))
    for r in read_csv(DATA / "ca_comp_strength.csv"):
        if r["comp"].startswith(("T20I v", "ListAI v", "FCI v")):
            continue
        canon = alias.get((r["format"], r["gender"], r["comp"]), r["comp"])
        if r["comp"] == "kfc twenty20 big bash":
            canon = "Big Bash League"
        t = td[(r["format"], r["gender"], canon)][r["side"]]
        t[0] += float(r["strength"]) * float(r["balls"])
        t[1] += float(r["balls"])
    ca = {k: v["bat"][0] / v["bat"][1] + v["bowl"][0] / v["bowl"][1] for k, v in td.items() if v["bat"][1] and v["bowl"][1]}

    cs_names = {
        "Indian Premier League": "Indian Premier League", "Big Bash League": "Big Bash League",
        "Pakistan Super League": "Pakistan Super League", "Caribbean Premier League": "Caribbean Premier League",
        "Bangladesh Premier League": "Bangladesh Premier League", "Lanka Premier League": "Lanka Premier League",
        "SA20": "SA20", "International League T20": "ILT20", "Major League Cricket": "Major League Cricket",
        "The Hundred Men's Competition": "The Hundred (men)", "Vitality Blast": "T20 Blast",
        "Syed Mushtaq Ali Trophy": "Syed Mushtaq Ali Trophy", "Super Smash": "Super Smash",
        "CSA T20 Challenge": "CSA T20 Challenge", "Mzansi Super League": "Mzansi Super League",
        "Women's Premier League": "Women's Premier League", "Women's Big Bash League": "Women's Big Bash League",
        "The Hundred Women's Competition": "The Hundred (women)", "Women's Cricket Super League": "Women's Cricket Super League",
        "Women's Caribbean Premier League": "Women's Caribbean Premier League", "Charlotte Edwards Cup": "Charlotte Edwards Cup",
        "Women's Super Smash": "Women's Super Smash",
    }
    cs = {}
    for r in read_csv(DATA / "league_strength.csv"):
        canon = cs_names.get(r["competition"])
        if canon:
            cs[("T20", r["gender"], canon)] = float(r["batting_strength"]) + float(r["bowling_strength"])

    def pair_stats(td_map, keys_filter):
        ks = [k for k in bu if k in td_map and keys_filter(k)]
        if len(ks) < 4:
            return None
        res = {}
        # centre each gender/format separately (each model has its own zero)
        groups = defaultdict(list)
        for k in ks:
            groups[(k[0], k[1])].append(k)
        xs, ys, ws, lab = [], [], [], []
        for gk, kk in groups.items():
            if len(kk) < 3:
                continue
            mx = sum(td_map[k] for k in kk) / len(kk)
            my = sum(bu[k][0] for k in kk) / len(kk)
            for k in kk:
                xs.append(td_map[k] - mx); ys.append(bu[k][0] - my); ws.append(math.sqrt(bu[k][1])); lab.append(k)
        if len(xs) < 4:
            return None
        a, b = wlinfit(xs, ys, ws)
        resid = sorted(((ys[i] - (a + b * xs[i]), lab[i], xs[i], ys[i]) for i in range(len(xs))), key=lambda t: -abs(t[0]))
        return {"n": len(xs), "r": corr(xs, ys, ws), "slope": b, "resid": resid}

    sec = []
    for name, tdm, flt in [
        ("CricketArchive top-down (ca_comp_strength.csv), domestic competitions, all formats", ca, lambda k: True),
        ("CricketArchive top-down, T20 only", ca, lambda k: k[0] == "T20"),
        ("Cricsheet ball-level top-down (league_strength.csv), T20 leagues", cs, lambda k: True),
    ]:
        st = pair_stats(tdm, flt)
        if not st:
            continue
        sec.append(f"**{name}**: {st['n']} competitions with ≥40 matches, weighted r = {st['r']:.2f}, slope (bottom-up per "
                   f"1 run of top-down) = {st['slope']:.2f}.  Biggest disagreements (bottom-up minus fit, runs/100 balls):\n")
        sec.append("| competition | format | gender | top-down (centred) | bottom-up (centred) | gap |\n|---|---|---|---|---|---|")
        for res, k, x, y in st["resid"][:10]:
            sec.append(f"| {k[2]} | {k[0]} | {k[1]} | {x:+.1f} | {y:+.1f} | {res:+.1f} |")
        sec.append("")
    return "\n".join(sec)


def report(out, tout, anchor_val):
    cov = read_csv(TMP / "coverage.csv")
    xmap = read_csv(TMP / "xmap.csv")
    L = []
    L.append("# League and match strength index (bottom-up, CricketArchive scorecards)\n")
    L.append("Generated by `src/analysis/league-strength-index.py`. Every player in every senior scorecard since 2000 gets a "
             "pre-match rating (their CricketArchive rating at the end of the previous calendar year, `ca_ratings_by_year.parquet`). "
             "A team's strength is its XI's usage-weighted batting rating plus its overs-weighted bowling rating, in runs per 100 "
             "balls above an average team. A competition-season's strength is the mean over its matches.\n")
    L.append("**Index** = 100 + (strength − anchor). One index point ≈ one run per 100 balls batted *and* bowled, so a side from a "
             "90 league would expect to lose to a side from a 100 league by roughly 10 runs per 100 balls each way. Indexes compare "
             "within a format × gender only.\n")
    L.append("| format | gender | anchor (= 100) | anchor strength |\n|---|---|---|---|")
    for (fmt, g), (comp, yrs) in ANCHORS.items():
        ys = f"{yrs[0]}" if len(yrs) == 1 else "all seasons pooled"
        L.append(f"| {fmt} | {g} | {comp}, {ys} | {anchor_val[(fmt, g)]:+.2f} |")
    L.append("\nA domestic season is labelled by its season label's last year (BBL 2023-24 = 2024, WBBL 2025-26 = 2026; the UAE IPL of Sept-Nov 2020, labelled 2020-21, = 2020); internationals by calendar year. Seasons still under way (labelled 2026-27 or later) are in the CSV with `in_progress` = true but left out of the tables. ± is 1.96 SE over matches; matches share "
             "teams, so the real uncertainty is somewhat wider.\n")

    L.append("## T20 men: key leagues over time\n")
    L.append(league_table(out, "T20", "male", T20M_KEY))
    L.append("\nNepal Premier League: not in the senior CricketArchive data (it is not a senior-status T20 there), so it has no "
             "bottom-up index here. The Cricsheet top-down model does rate it (league_strength.csv).\n")
    latest_m = max(r["season"] for r in out if r["format"] == "T20" and r["gender"] == "male" and r["competition"] == "Indian Premier League")
    for yr in (latest_m, latest_m - 1):
        L.append(f"### Strongest T20 men's competitions, {yr} (≥15 matches)\n")
        L.append(top_table(out, "T20", "male", yr))
        L.append("")

    L.append("## T20 women: key leagues over time\n")
    L.append(league_table(out, "T20", "female", T20F_KEY))
    latest_f = max(r["season"] for r in out if r["format"] == "T20" and r["gender"] == "female" and r["competition"] == "Women's Premier League")
    L.append(f"\n### Strongest T20 women's competitions, {latest_f} (≥10 matches)\n")
    L.append(top_table(out, "T20", "female", latest_f, min_matches=10))
    L.append("")

    for fmt, g, comps, title in [
        ("ListA", "male", ["ODI (FM v FM)", "ODI (FM v Assoc)", "Vijay Hazare Trophy", "English One-Day Cup", "Australian One-Day Cup",
                           "Ford Trophy", "CSA One-Day Cup (franchise)", "WI Super50", "SL Major Clubs List A"], "List A men"),
        ("FC", "male", ["Test (FM v FM)", "County Championship", "Sheffield Shield", "Ranji Trophy", "Plunket Shield",
                        "CSA 4-Day Series", "Quaid-e-Azam Trophy", "WI 4-Day Championship", "Bangladesh National Cricket League",
                        "SL Premier / Major League (tier A)"], "First-class men"),
    ]:
        L.append(f"## {title}: key competitions over time\n")
        L.append(league_table(out, fmt, g, comps))
        L.append("")

    # trends
    L.append("## Trends\n")
    ipl = series(out, "T20", "male", "Indian Premier League")
    others = ["Big Bash League", "Pakistan Super League", "Caribbean Premier League", "SA20", "ILT20", "The Hundred (men)",
              "Major League Cricket", "T20 Blast", "Bangladesh Premier League"]
    L.append("**Has the IPL pulled away?** IPL index minus the best other franchise league that season (≥15 matches):\n")
    L.append("| season | IPL | best other | gap | second-best league |\n|---|---|---|---|---|")
    for y in sorted(ipl):
        if y < 2010:
            continue
        cands = [(series(out, "T20", "male", c, 15).get(y), c) for c in others]
        cands = [(r["index"], c) for r, c in cands if r]
        if not cands:
            continue
        bi, bc = max(cands)
        L.append(f"| {y} | {ipl[y]['index']:.1f} | {bi:.1f} | {ipl[y]['index'] - bi:+.1f} | {bc} |")
    L.append("")
    for a_, b_ in [("Pakistan Super League", "Big Bash League"), ("SA20", "Big Bash League"), ("The Hundred (men)", "T20 Blast")]:
        sa, sb = series(out, "T20", "male", a_), series(out, "T20", "male", b_)
        ys = sorted(set(sa) & set(sb))
        if ys:
            L.append(f"**{a_} vs {b_}** (index, gap): " + ", ".join(f"{y}: {sa[y]['index']:.1f} v {sb[y]['index']:.1f} ({sa[y]['index'] - sb[y]['index']:+.1f})" for y in ys))
            L.append("")
    wpl, wbbl, wh = (series(out, "T20", "female", c) for c in ("Women's Premier League", "Women's Big Bash League", "The Hundred (women)"))
    L.append("**Women's franchise leagues** (index by season): WBBL " + ", ".join(f"{y}: {r['index']:.1f}" for y, r in sorted(wbbl.items()) if y >= 2016) +
             "; Hundred " + ", ".join(f"{y}: {r['index']:.1f}" for y, r in sorted(wh.items())) +
             "; WPL " + ", ".join(f"{y}: {r['index']:.1f}" for y, r in sorted(wpl.items())) + ".\n")
    fm = series(out, "T20", "male", "T20I (FM v FM)")
    L.append("**Men's T20Is between full members vs the IPL** (index): " + ", ".join(f"{y}: {fm[y]['index']:.1f}" for y in sorted(fm) if y >= 2010 and y in fm) + "\n")

    L.append("## Comparison with the top-down strengths\n")
    L.append("Top-down = competition strength fitted from players who play in more than one competition (`ca_comp_strength.csv`, "
             "CricketArchive, all formats; `league_strength.csv`, Cricsheet ball-by-ball, T20), summed over the batting and bowling "
             "sides and pooled over all seasons. Bottom-up = this file's strength pooled over the competition's seasons. Each model has "
             "its own zero, so both are centred per format × gender before comparing.\n")
    L.append(compare_topdown(out))
    L.append("""**Which to trust for what.** The bottom-up index is not independent of the top-down fit: each player's rating was
league-adjusted with those strengths, so leagues full of players with no outside record inherit their league's fitted level.
What it adds is (a) time variation, since the top-down strengths are one number per competition over 25 years, and
(b) who actually took the field: a league that imports stars, or loses its internationals to a clash, moves even though its
fitted strength does not. Use bottom-up for season-to-season and team-level questions (has a league got stronger, how strong was
this XI) and for competitions with few link players; use top-down for converting a player's raw numbers between leagues, which is
what it was fitted for. Where they disagree a lot, check the coverage columns: a low `share_rated` means the bottom-up number
leans on debutant priors.
""")

    L.append("## Does it predict results?\n")
    L.append("Share of decided matches won by the side with the higher pre-match XI strength (ratings as of the previous year only), "
             "by size of the strength gap:\n")
    pred = read_csv(TMP / "predict.csv")
    buckets = ["0-3", "3-6", "6-10", "10-15", "15+", "all"]
    pd = {(r["format"], r["gender"], r["gap_bucket"]): r for r in pred}
    L.append("| format | gender | " + " | ".join(f"gap {b}" if b != "all" else "all decided" for b in buckets) + " |")
    L.append("|---|---|" + "---|" * len(buckets))
    for fmt in ("T20", "ListA", "FC"):
        for g in ("male", "female"):
            cells = []
            for b in buckets:
                r = pd.get((fmt, g, b))
                cells.append(f"{float(r['stronger_win_rate']):.0%} ({r['decided']})" if r else "–")
            L.append(f"| {fmt} | {g} | " + " | ".join(cells) + " |")
    L.append("\nA coin flip would be 50% in every column; the win rate rises steadily with the gap, so the strengths carry real "
             "information about the XIs (home advantage, toss and conditions are not modelled).\n")
    L.append("## Coverage and inputs\n")
    L.append("Share of player-appearances by source of the batting rating (same-format prior rating / cross-format mapped / debutant prior):\n")
    L.append("| format | gender | 2005 | 2010 | 2015 | 2020 | 2025 |\n|---|---|---|---|---|---|---|")
    covd = {(r["format"], r["gender"], int(r["yr"])): r for r in cov}
    for fmt in ("T20", "ListA", "FC"):
        for g in ("male", "female"):
            cells = []
            for y in (2005, 2010, 2015, 2020, 2025):
                r = covd.get((fmt, g, y))
                cells.append(f"{float(r['same']):.0%} / {float(r['cross_']):.0%} / {float(r['debut']):.0%}" if r else "–")
            L.append(f"| {fmt} | {g} | " + " | ".join(cells) + " |")
    L.append("\nCross-format maps (target rating = intercept + slope × source rating, same player-year, regular samples):\n")
    L.append("| side | gender | to | from | intercept | slope | pairs |\n|---|---|---|---|---|---|---|")
    for r in xmap:
        L.append(f"| {r['side']} | {r['gender']} | {r['tf']} | {r['sf']} | {float(r['ic']):+.2f} | {float(r['sl']):.2f} | {r['n']} |")
    L.append("""
## Caveats

- Ratings only exist from 2000 and T20 cricket starts in 2003, so early T20 seasons lean on cross-format mappings and debutant
  priors (see coverage). Treat T20 indexes before ~2008 as rough.
- A player's pre-match rating is his latest previous-year rating with no extra decay for inactivity or age, so returning veterans
  are rated at their last level.
- Mixed-strength fixtures (e.g. university sides v counties) get the average of both XIs, so a weak team's competition
  can index high when its opponents are strong; the top-down fit rates the weak team's side instead.
- Debutant priors use the mean end-of-debut-year rating for that country/tier, which includes the debut year's own matches
  (a mild circularity, averaged over many players).
- Hundred scorecards have no overs; balls bowled are recovered as runs x 100 / economy (its economy is per 100 balls).
  ca-player-seasons.sql drops bowling rows without overs, so Hundred BOWLING is missing from the player ratings
  themselves (Hundred batting is in); Hundred bowlers' pre-match ratings come from their other T20 cricket.
- Batting weights are expected usage by card position; impact-player and 12-a-side games simply include the extra player at
  his position.
- `cricket.db`'s `matches.gender` is unreliable; gender here comes from the match levels, as in ca-player-seasons.sql.
- Competition names come from CricketArchive event names; unaliased domestic events keep their lower-cased event key. The
  alias table is `src/analysis/competition_aliases.csv`.
""")
    (DATA / "league-strength-report.md").write_text("\n".join(L))


if __name__ == "__main__":
    main()
