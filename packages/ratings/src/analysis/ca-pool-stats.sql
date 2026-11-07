-- Career stats and profile facts for every rated CricketArchive player (senior cricket.db + lower-level cricket-events.db),
-- for generate-ca-pool.ts: attribute mix, role, keeper flag, batting position, country, age.
-- Run from packages/ratings:  duckdb < src/analysis/ca-pool-stats.sql
-- Output: data/analysis/ca_pool_stats.parquet    one row per player x gender x format x level
--                (level = 'senior' for Twenty20 / List A / First-Class cards, else 'tier0'..'tier4' from the event name)
--         data/analysis/ca_pool_players.parquet  one row per player: names, DOB, hand, bowling style, nationality evidence
-- Matches from 2000 on, as the ratings.
LOAD sqlite;
ATTACH 'data/cricket.db' AS c (TYPE sqlite, READ_ONLY);
ATTACH 'data/cricket-events.db' AS e (TYPE sqlite, READ_ONLY);
SET threads = 2;
SET memory_limit = '4GB';

-- every match we use, with format / level / gender (senior db first; the events db only adds cards senior does not have)
CREATE TEMP TABLE m AS
SELECT id, date::DATE AS date, year(date::DATE) AS year, country, 'senior' AS level,
       CASE WHEN levels LIKE '%Women%' THEN 'female' ELSE 'male' END AS gender,
       CASE WHEN levels LIKE '%Twenty20%' THEN 'T20' WHEN levels LIKE '%List A%' THEN 'ListA' WHEN levels LIKE '%First-Class%' THEN 'FC' END AS format
FROM c.matches
WHERE date IS NOT NULL AND try_cast(date AS DATE) IS NOT NULL AND year(date::DATE) >= 2000
  AND (levels LIKE '%Twenty20%' OR levels LIKE '%List A%' OR levels LIKE '%First-Class%');

CREATE TEMP TABLE maxov AS
SELECT match_id, max(ov) AS max_overs FROM (
  SELECT match_id, innings, sum(try_cast(split_part(overs, '.', 1) AS INT) + coalesce(try_cast(nullif(split_part(overs, '.', 2), '') AS INT), 0) / 6.0) AS ov
  FROM e.bowling GROUP BY ALL) GROUP BY ALL;

INSERT INTO m
SELECT mm.id, mm.date::DATE, year(mm.date::DATE), mm.country, 'tier' || mm.tier, mm.gender,
       CASE WHEN regexp_extract(mm.date_text, '\((\d+)-over match\)', 1) <> ''
                 THEN CASE WHEN regexp_extract(mm.date_text, '\((\d+)-over match\)', 1)::INT <= 24 THEN 'T20'
                           WHEN regexp_extract(mm.date_text, '\((\d+)-over match\)', 1)::INT <= 60 THEN 'ListA' ELSE 'FC' END
            WHEN mm.date_text LIKE '%-day%' AND mm.date_text NOT LIKE '%1-day single%' AND mm.date_text NOT LIKE '%1-day match%' THEN 'FC'
            WHEN mm.date_text LIKE '%1-day single innings%' THEN 'FC'
            WHEN o.max_overs IS NULL THEN NULL
            WHEN o.max_overs <= 21 THEN 'T20' WHEN o.max_overs <= 61 THEN 'ListA' ELSE 'FC' END
FROM e.matches mm LEFT JOIN maxov o ON o.match_id = mm.id
WHERE mm.date IS NOT NULL AND try_cast(mm.date AS DATE) IS NOT NULL AND year(mm.date::DATE) >= 2000
  AND NOT (mm.levels LIKE '%Twenty20%' OR mm.levels LIKE '%List A%' OR mm.levels LIKE '%First-Class%');
DELETE FROM m WHERE format IS NULL;

CREATE TEMP TABLE bat AS
SELECT m.id AS match_id, m.level, m.gender, m.format, m.year, b.player_id, b.position, b.keeper, b.runs, b.balls, b.fours, b.sixes,
       CASE WHEN b.dismissal IN ('not out', 'retired hurt', 'absent hurt', 'retired not out', '', '[dismissal not known]', 'did not bat')
                 OR b.dismissal IS NULL THEN 0 ELSE 1 END AS outs
FROM c.batting b JOIN m ON m.id = b.match_id AND m.level = 'senior'
UNION ALL
SELECT m.id, m.level, m.gender, m.format, m.year, b.player_id, b.position, b.keeper, b.runs, b.balls, b.fours, b.sixes,
       CASE WHEN b.dismissal IN ('not out', 'retired hurt', 'absent hurt', 'retired not out', '', '[dismissal not known]', 'did not bat')
                 OR b.dismissal IS NULL THEN 0 ELSE 1 END
FROM e.batting b JOIN m ON m.id = b.match_id AND m.level <> 'senior';

CREATE TEMP TABLE bowl AS
SELECT m.id AS match_id, m.level, m.gender, m.format, m.year, w.player_id, w.runs, coalesce(w.wickets, 0) AS wickets,
       coalesce(try_cast(split_part(w.overs, '.', 1) AS INT) * 6 + coalesce(try_cast(nullif(split_part(w.overs, '.', 2), '') AS INT), 0), w.balls) AS balls
FROM c.bowling w JOIN m ON m.id = w.match_id AND m.level = 'senior'
UNION ALL
SELECT m.id, m.level, m.gender, m.format, m.year, w.player_id, w.runs, coalesce(w.wickets, 0),
       coalesce(try_cast(split_part(w.overs, '.', 1) AS INT) * 6 + coalesce(try_cast(nullif(split_part(w.overs, '.', 2), '') AS INT), 0), w.balls)
FROM e.bowling w JOIN m ON m.id = w.match_id AND m.level <> 'senior';
DELETE FROM bowl WHERE balls IS NULL OR balls <= 0 OR runs IS NULL;

COPY (
  WITH bs AS (
    SELECT player_id, gender, format, level,
           count(*) AS bat_inns, sum(outs) AS bat_outs, sum(runs) AS bat_runs_all,
           count(*) FILTER (WHERE balls > 0) AS bat_inns_b, sum(runs) FILTER (WHERE balls > 0) AS bat_runs, sum(balls) FILTER (WHERE balls > 0) AS bat_balls,
           sum(outs) FILTER (WHERE balls > 0) AS bat_outs_b,
           sum(balls) FILTER (WHERE balls > 0 AND fours IS NOT NULL) AS bnd_balls, sum(fours) FILTER (WHERE balls > 0) AS fours, sum(sixes) FILTER (WHERE balls > 0) AS sixes,
           sum(CASE WHEN keeper THEN 1 ELSE 0 END) AS keeper_inns, avg(position) AS mean_position,
           min(year) AS first_year, max(year) AS last_year, count(DISTINCT match_id) AS bat_matches
    FROM bat GROUP BY ALL),
  ws AS (
    SELECT player_id, gender, format, level, count(*) AS bowl_inns, sum(balls) AS bowl_balls, sum(runs) AS bowl_runs, sum(wickets) AS bowl_wkts,
           min(year) AS first_year_w, max(year) AS last_year_w, count(DISTINCT match_id) AS bowl_matches
    FROM bowl GROUP BY ALL)
  SELECT coalesce(bs.player_id, ws.player_id) AS player_id, coalesce(bs.gender, ws.gender) AS gender, coalesce(bs.format, ws.format) AS format,
         coalesce(bs.level, ws.level) AS level,
         coalesce(bat_inns, 0) AS bat_inns, coalesce(bat_outs, 0) AS bat_outs, coalesce(bat_runs_all, 0) AS bat_runs_all,
         coalesce(bat_inns_b, 0) AS bat_inns_b, coalesce(bat_runs, 0) AS bat_runs, coalesce(bat_balls, 0) AS bat_balls, coalesce(bat_outs_b, 0) AS bat_outs_b,
         coalesce(bnd_balls, 0) AS bnd_balls, coalesce(fours, 0) AS fours, coalesce(sixes, 0) AS sixes,
         coalesce(keeper_inns, 0) AS keeper_inns, mean_position,
         coalesce(bowl_inns, 0) AS bowl_inns, coalesce(bowl_balls, 0) AS bowl_balls, coalesce(bowl_runs, 0) AS bowl_runs, coalesce(bowl_wkts, 0) AS bowl_wkts,
         least(coalesce(bs.first_year, 9999), coalesce(ws.first_year_w, 9999)) AS first_year,
         greatest(coalesce(bs.last_year, 0), coalesce(ws.last_year_w, 0)) AS last_year,
         greatest(coalesce(bat_matches, 0), coalesce(bowl_matches, 0)) AS matches
  FROM bs FULL OUTER JOIN ws USING (player_id, gender, format, level)
) TO 'data/analysis/ca_pool_stats.parquet' (FORMAT parquet);

-- Players: profile (senior db) when there is one, else the card's name / DOB; nationality evidence
CREATE TEMP TABLE used AS SELECT DISTINCT player_id FROM 'data/analysis/ca_pool_stats.parquet';
CREATE TEMP TABLE modal AS
SELECT player_id, arg_max(country, n) AS modal_country FROM (
  SELECT x.player_id, mm.country, count(*) AS n FROM (SELECT player_id, match_id FROM bat UNION ALL SELECT player_id, match_id FROM bowl) x
  JOIN m mm ON mm.id = x.match_id GROUP BY ALL) GROUP BY ALL;
CREATE TEMP TABLE nat AS
SELECT player_id, arg_max(team, n) AS nat_team FROM (
  SELECT player_id, team, count(*) AS n FROM c.player_teams
  WHERE level IN ('Test', 'ODI', 'International Twenty20', 'Women''s Test', 'Women''s ODI', 'Women''s International Twenty20')
  GROUP BY ALL) GROUP BY ALL;
COPY (
  SELECT u.player_id,
         coalesce(cp.name, ep.name) AS name, coalesce(cp.full_name, ep.full_name) AS full_name,
         coalesce(cp.dob, ep.dob) AS dob, cp.born, cp.batting_hand, cp.bowling_style, cp.gender AS profile_gender,
         n.nat_team, mo.modal_country
  FROM used u
  LEFT JOIN c.players cp ON cp.id = u.player_id
  LEFT JOIN e.players ep ON ep.id = u.player_id
  LEFT JOIN nat n ON n.player_id = u.player_id
  LEFT JOIN modal mo ON mo.player_id = u.player_id
) TO 'data/analysis/ca_pool_players.parquet' (FORMAT parquet);

SELECT level, gender, format, count(DISTINCT player_id) players FROM 'data/analysis/ca_pool_stats.parquet' GROUP BY ALL ORDER BY ALL;
SELECT count(*) players, count(name) named, count(dob) with_dob, count(nat_team) with_nat, count(born) with_born, count(batting_hand) with_hand, count(bowling_style) with_bowl FROM 'data/analysis/ca_pool_players.parquet';
