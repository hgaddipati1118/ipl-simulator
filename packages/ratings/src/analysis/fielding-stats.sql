-- Fielding and wicketkeeping counts from Cricsheet ball-by-ball (T20 + IT20, men and women), with wicketkeepers
-- identified from the CricketArchive scorecards' keeper flag. Run from packages/ratings:
--     duckdb < src/analysis/fielding-stats.sql
-- Needs data/cricket.db (build-db.ts), data/analysis/{deliveries,matches,people}.parquet.
-- Outputs (data/analysis/):
--   fielding_player_innings.parquet  one row per match x fielding innings x player on the fielding side:
--       catches (non-keeper catches, excl. caught and bowled), cb (caught and bowled), ro (run-outs involved),
--       cx (catches off his own bowling, which he can't take), balls_bowled, team_nk_catches / team_ro (the innings' totals, for the leave-one-out chance baseline), is_keeper
--   keeping_innings.parquet          one row per fielding innings with a known keeper: stumpings, keeper catches,
--       bye events and runs, legal balls, and the expected counts given who bowled (bowler propensities)
--   keeper_match_map.parquet         how each match's keeper was identified (CA flag / stumping / unknown)
--   fielding_match_link.csv          Cricsheet match -> CricketArchive match link used for the keeper flag
LOAD sqlite;
ATTACH 'data/cricket.db' AS c (TYPE sqlite, READ_ONLY);
SET threads = 4;
SET memory_limit = '4GB';

CREATE TEMP TABLE cm AS
SELECT match_id, date, gender FROM 'data/analysis/matches.parquet' WHERE match_type IN ('T20', 'IT20');

CREATE TEMP TABLE ppl AS
SELECT cricsheet_id AS pid, name,
       lower(regexp_extract(trim(name), '([^ ]+)$', 1)) || '|' || lower(substr(trim(name), 1, 1)) AS key
FROM 'data/analysis/people.parquet';

-- Players on each side of each match: anyone who batted, was at the crease, bowled or took a fielding credit.
-- team = the side the player was on, from the batting / bowling team column.
CREATE TEMP TABLE d AS
SELECT d.* FROM 'data/analysis/deliveries.parquet' d JOIN cm USING (match_id) WHERE d.super_over = 0;

CREATE TEMP TABLE fl AS   -- fielding credits unnested
SELECT match_id, innings, bowling_team, legal_ball_no, wicket_kind, bowler_id, player_out_id,
       unnest(list_distinct(string_split(fielder_ids, ';'))) AS fid
FROM d WHERE is_wicket = 1 AND fielder_ids IS NOT NULL AND fielder_ids <> '';

CREATE TEMP TABLE pm AS
SELECT DISTINCT match_id, team, pid FROM (
  SELECT match_id, batting_team AS team, batter_id AS pid FROM d
  UNION ALL SELECT match_id, batting_team, non_striker_id FROM d
  UNION ALL SELECT match_id, bowling_team, bowler_id FROM d
  UNION ALL SELECT match_id, bowling_team, fid FROM fl
) WHERE pid IS NOT NULL;

-- ---- match link Cricsheet -> CricketArchive T20 (same date +-1 day, most player-name keys in common)
CREATE TEMP TABLE cam AS
SELECT id AS ca_id, date::DATE AS date, levels LIKE '%Women%' AS women
FROM c.matches WHERE levels LIKE '%Twenty20%' AND try_cast(date AS DATE) IS NOT NULL AND date::DATE >= '2005-01-01';
CREATE TEMP TABLE cap AS
SELECT b.match_id AS ca_id, b.team, b.keeper,
       lower(regexp_extract(trim(b.player_name), '([^ ]+)$', 1)) || '|' || lower(substr(trim(b.player_name), 1, 1)) AS key
FROM c.batting b JOIN cam ON cam.ca_id = b.match_id;
CREATE TEMP TABLE csp AS
SELECT pm.match_id, pm.team, pm.pid, ppl.key FROM pm JOIN ppl ON ppl.pid = pm.pid;

CREATE TEMP TABLE cand AS
SELECT cm.match_id, cam.ca_id, count(DISTINCT csp.key) AS common
FROM cm JOIN cam ON abs(date_diff('day', cm.date, cam.date)) <= 1 AND (cm.gender = 'female') = cam.women
JOIN csp ON csp.match_id = cm.match_id
JOIN cap ON cap.ca_id = cam.ca_id AND cap.key = csp.key
GROUP BY ALL;
CREATE TEMP TABLE link AS
SELECT match_id, ca_id, common FROM (
  SELECT *, row_number() OVER (PARTITION BY match_id ORDER BY common DESC, ca_id) rn,
            row_number() OVER (PARTITION BY ca_id ORDER BY common DESC, match_id) rn2 FROM cand) WHERE rn = 1 AND rn2 = 1 AND common >= 8;
COPY link TO 'data/analysis/fielding_match_link.csv' (HEADER);

-- keeper per (cricsheet match, team): CA flag -> the Cricsheet player on that team with the same name key
CREATE TEMP TABLE kca AS
SELECT l.match_id, csp.team, csp.pid, count(*) OVER (PARTITION BY l.match_id, csp.team) AS n_cand
FROM link l JOIN cap ON cap.ca_id = l.ca_id AND cap.keeper = 1
JOIN csp ON csp.match_id = l.match_id AND csp.key = cap.key;
-- keeper per (match, innings) from stumpings (a stumping is always the keeper's)
CREATE TEMP TABLE kst AS
SELECT match_id, bowling_team AS team, fid AS pid, count(*) n FROM fl WHERE wicket_kind = 'stumped' GROUP BY ALL;

CREATE TEMP TABLE km AS
SELECT s.match_id, s.team,
       coalesce(
         (SELECT pid FROM kca WHERE kca.match_id = s.match_id AND kca.team = s.team AND n_cand = 1),
         (SELECT pid FROM kst WHERE kst.match_id = s.match_id AND kst.team = s.team ORDER BY n DESC LIMIT 1)) AS keeper_id,
       CASE WHEN EXISTS (SELECT 1 FROM kca WHERE kca.match_id = s.match_id AND kca.team = s.team AND n_cand = 1) THEN 'ca'
            WHEN EXISTS (SELECT 1 FROM kst WHERE kst.match_id = s.match_id AND kst.team = s.team) THEN 'stumping'
            ELSE 'unknown' END AS source
FROM (SELECT DISTINCT match_id, team FROM pm) s;
COPY km TO 'data/analysis/keeper_match_map.parquet' (FORMAT parquet);

-- ---- fielding innings: every player on the fielding side x innings
CREATE TEMP TABLE inn AS
SELECT DISTINCT match_id, innings, bowling_team AS team FROM d;
CREATE TEMP TABLE ev AS
SELECT match_id, innings, bowling_team AS team, fid AS pid,
       sum((wicket_kind = 'caught')::INT) AS catches_all, sum((wicket_kind = 'run out')::INT) AS ro, sum((wicket_kind = 'stumped')::INT) AS st
FROM fl GROUP BY ALL;
CREATE TEMP TABLE cb AS
SELECT match_id, innings, bowling_team AS team, bowler_id AS pid, count(*) AS cb
FROM d WHERE wicket_kind = 'caught and bowled' GROUP BY ALL;
CREATE TEMP TABLE cx AS   -- non-keeper catches taken off each bowler's own bowling (he can't catch those himself)
SELECT fl.match_id, fl.innings, fl.bowling_team AS team, fl.bowler_id AS pid, count(*) AS cx
FROM fl JOIN km ON km.match_id = fl.match_id AND km.team = fl.bowling_team
WHERE fl.wicket_kind = 'caught' AND fl.fid IS DISTINCT FROM km.keeper_id GROUP BY ALL;
CREATE TEMP TABLE bl AS   -- legal balls in the innings
SELECT match_id, innings, bowling_team AS team, count(*) FILTER (WHERE wides = 0 AND noballs = 0) AS balls FROM d GROUP BY ALL;

CREATE TEMP TABLE fpi AS
SELECT i.match_id, i.innings, i.team, pm.pid, m.gender, year(m.date) AS year, bl.balls,
       km.keeper_id, km.source AS keeper_source, (pm.pid = km.keeper_id) AS is_keeper,
       coalesce(ev.catches_all, 0) AS catches_all, coalesce(ev.ro, 0) AS ro, coalesce(cb.cb, 0) AS cb, coalesce(cx.cx, 0) AS cx,
       coalesce(bw.balls_bowled, 0) AS balls_bowled
FROM inn i
JOIN pm ON pm.match_id = i.match_id AND pm.team = i.team
JOIN 'data/analysis/matches.parquet' m ON m.match_id = i.match_id
JOIN bl ON bl.match_id = i.match_id AND bl.innings = i.innings AND bl.team = i.team
JOIN km ON km.match_id = i.match_id AND km.team = i.team
LEFT JOIN ev ON ev.match_id = i.match_id AND ev.innings = i.innings AND ev.pid = pm.pid
LEFT JOIN cb ON cb.match_id = i.match_id AND cb.innings = i.innings AND cb.pid = pm.pid
LEFT JOIN cx ON cx.match_id = i.match_id AND cx.innings = i.innings AND cx.pid = pm.pid
LEFT JOIN (SELECT match_id, innings, bowler_id AS pid, count(*) FILTER (WHERE wides = 0 AND noballs = 0) AS balls_bowled FROM d GROUP BY ALL) bw
       ON bw.match_id = i.match_id AND bw.innings = i.innings AND bw.pid = pm.pid;

COPY (
  SELECT f.*,
         sum(CASE WHEN NOT coalesce(is_keeper, false) THEN catches_all ELSE 0 END) OVER w AS team_nk_catches,
         sum(ro) OVER w AS team_ro,
         count(*) OVER w AS team_players
  FROM fpi f WINDOW w AS (PARTITION BY match_id, innings, team)
) TO 'data/analysis/fielding_player_innings.parquet' (FORMAT parquet);

-- ---- keeping innings with bowler-based expectations
CREATE TEMP TABLE bb AS   -- per innings x bowler: legal balls, stumpings, keeper catches, bye events/runs
SELECT d.match_id, d.innings, d.bowling_team AS team, d.bowler_id,
       count(*) FILTER (WHERE d.wides = 0 AND d.noballs = 0) AS balls,
       sum(coalesce(d.wicket_kind = 'stumped', false)::INT) AS st,
       sum(coalesce(d.wicket_kind = 'caught' AND d.fielder_ids = km.keeper_id, false)::INT) AS kc,
       sum(coalesce(d.byes > 0, false)::INT) AS bye_ev, sum(coalesce(d.byes, 0)) AS bye_runs
FROM d JOIN km ON km.match_id = d.match_id AND km.team = d.bowling_team AND km.keeper_id IS NOT NULL
GROUP BY ALL;
CREATE TEMP TABLE g AS SELECT m.gender, sum(st)/sum(balls) AS p_st, sum(kc)/sum(balls) AS p_kc, sum(bye_ev)/sum(balls) AS p_bye
FROM bb JOIN 'data/analysis/matches.parquet' m USING (match_id) GROUP BY ALL;
CREATE TEMP TABLE bp AS   -- bowler propensities, shrunk to the gender mean with a prior of 1500 balls
SELECT m.gender, bb.bowler_id, sum(balls) AS n, g.p_st, g.p_kc, g.p_bye,
       (sum(st) + 1500*g.p_st)/(sum(balls) + 1500) AS q_st,
       (sum(kc) + 1500*g.p_kc)/(sum(balls) + 1500) AS q_kc,
       (sum(bye_ev) + 1500*g.p_bye)/(sum(balls) + 1500) AS q_bye
FROM bb JOIN 'data/analysis/matches.parquet' m USING (match_id) JOIN g ON g.gender = m.gender
GROUP BY m.gender, bb.bowler_id, g.p_st, g.p_kc, g.p_bye;

CREATE TEMP TABLE ki AS
SELECT bb.match_id, bb.innings, bb.team, km.keeper_id, km.source, m.gender, year(m.date) AS year,
       coalesce(m.event, 'none') || ' ' || coalesce(m.season, '') AS ev,
       sum(bb.balls) AS balls, sum(bb.st) AS st, sum(bb.kc) AS kc, sum(bb.bye_ev) AS bye_ev, sum(bb.bye_runs) AS bye_runs,
       sum(bb.balls * coalesce(bp.q_st, g.p_st)) AS exp_st,
       sum(bb.balls * coalesce(bp.q_kc, g.p_kc)) AS exp_kc,
       sum(bb.balls * coalesce(bp.q_bye, g.p_bye)) AS exp_bye
FROM bb JOIN km ON km.match_id = bb.match_id AND km.team = bb.team
JOIN 'data/analysis/matches.parquet' m ON m.match_id = bb.match_id
JOIN g ON g.gender = m.gender
LEFT JOIN bp ON bp.bowler_id = bb.bowler_id AND bp.gender = m.gender
GROUP BY ALL;
-- Event-season factor: scorers, pitches and conditions differ by tournament-season (byes are recorded very
-- differently across leagues).  Observed / expected over the event, shrunk with a prior worth a fixed expected count.
CREATE TEMP TABLE evf AS
SELECT ev, (sum(st) + 12) / (sum(exp_st) + 12) AS f_st, (sum(kc) + 40) / (sum(exp_kc) + 40) AS f_kc, (sum(bye_ev) + 40) / (sum(exp_bye) + 40) AS f_bye
FROM ki WHERE source = 'ca' GROUP BY ev;
COPY (
  SELECT ki.* EXCLUDE (ev), ki.exp_st * f_st AS exp_st_ev, ki.exp_kc * f_kc AS exp_kc_ev, ki.exp_bye * f_bye AS exp_bye_ev
  FROM ki JOIN evf USING (ev)
) TO 'data/analysis/keeping_innings.parquet' (FORMAT parquet);

SELECT 'matches' AS what, count(*) AS n FROM cm
UNION ALL SELECT 'linked to CA', count(*) FROM link
UNION ALL SELECT 'team-matches', count(*) FROM km
UNION ALL SELECT 'keeper via CA', count(*) FROM km WHERE source = 'ca'
UNION ALL SELECT 'keeper via stumping', count(*) FROM km WHERE source = 'stumping'
UNION ALL SELECT 'keeper unknown', count(*) FROM km WHERE source = 'unknown'
UNION ALL SELECT 'keeper_id null', count(*) FROM km WHERE keeper_id IS NULL;
