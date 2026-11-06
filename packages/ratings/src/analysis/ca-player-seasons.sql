-- CricketArchive scorecards -> per player x competition x year cells, valued against the competition-season average.
-- Run from packages/ratings:  duckdb < src/analysis/ca-player-seasons.sql
-- Full-member country codes for comp_super: ('ENG','IND','RSA','AUS','PAK','SL','NZ','WI','BDESH','ZIM','IRELAND','AFG')
-- Output: data/analysis/ca_cells.parquet   (one row per format x gender x side x competition x year x player)
--         data/analysis/ca_comp_seasons.parquet (competition-season averages used as the baseline)
--
-- Value per ball, "runs above the average ball in that competition-season":
--   batting  v = runs - balls*rpb - (outs - balls*opb) * W
--   bowling  v = balls*rpb - runs + (wkts - balls*wpb) * W
-- where rpb/opb/wpb are the competition-season runs/outs/wickets per ball and W is the run value of a wicket:
--   W = k * (competition-season runs per wicket), k = 0.3 (T20), 0.5 (List A), 1.0 (first-class).
-- Small competition-seasons are blended toward the format x gender x year average (prior worth 3000 balls).
-- Competition: internationals = "<format>I v <opponent>" (so international opponent strength is learned per
-- opposing team); domestic = event name with season tokens and "(Group X)" stripped.
-- comp_class (prior for competition strength): internationals by opponent = intl_full / intl_assoc;
-- domestic = dom_<country>. comp_super = full / assoc (ICC full members).
-- Match-level opponent adjustment (data/analysis/match_strength.parquet, the bottom-up index built from every
-- player's pre-match rating): a raw value is relative to the competition-season average ball, so
--   batting skill = raw + (comp-season mean batting level) + (this opponent's bowling - comp-season mean bowling)
--   bowling skill = raw + (comp-season mean bowling level) + (this opponent's batting - comp-season mean batting)
-- added per ball as value_ms = value + balls * adj / 100 (`value` stays the raw competition-season-relative value;
-- ca-ratings.py picks one with CA_VALUE=raw|ms). This pins the absolute level of competitions that are linked to the
-- elite game only by a few players (associate T20Is), which the competition-strength fit alone could not.
-- Matches missing from the index get no adjustment. The ALS strength fit and weak-tier translation in
-- ca-ratings.py then work on what is left.
-- Only matches from 2000 on, and only innings with balls recorded (scorecards before ~2000 rarely have them).
LOAD sqlite;
ATTACH 'data/cricket.db' AS c (TYPE sqlite, READ_ONLY);
SET threads = 2;
SET memory_limit = '2GB';
SET temp_directory = '/Volumes/Data/tmp/duckdb';

CREATE TEMP TABLE m AS
SELECT id, date::DATE AS date, year(date::DATE) AS year,
       -- cricket.db's matches.gender is wrong for ~2,300 men's matches (e.g. the 2015 World Cup); levels are reliable
       CASE WHEN levels LIKE '%Women%' THEN 'female' ELSE 'male' END AS gender, team1, team2, country,
       CASE WHEN levels LIKE '%Twenty20%' THEN 'T20'
            WHEN levels LIKE '%List A%' THEN 'ListA'
            WHEN levels LIKE '%First-Class%' THEN 'FC' END AS format,
       (levels LIKE '%International%' OR levels LIKE '%"Test"%' OR levels LIKE '%ODI%') AS intl,
       lower(trim(regexp_replace(regexp_replace(regexp_replace(coalesce(event, 'misc ' || coalesce(country, '')),
             '\s*\([^)]*\)\s*$', ''), '\b(19|20)\d{2}(/\d{2,4})?\b', '', 'g'), '\s+', ' ', 'g'))) AS event_key
FROM c.matches
WHERE date IS NOT NULL AND try_cast(date AS DATE) IS NOT NULL AND year(date::DATE) >= 2000
  AND (levels LIKE '%Twenty20%' OR levels LIKE '%List A%' OR levels LIKE '%First-Class%');

CREATE TEMP TABLE bat AS
SELECT m.format, m.gender, m.year, b.player_id, b.position, b.match_id, b.team,
       CASE WHEN m.intl THEN m.format || 'I v ' || regexp_replace(CASE WHEN b.team = m.team1 THEN m.team2 ELSE m.team1 END, ' Women$', '')
            ELSE m.event_key END AS comp,
       CASE WHEN m.intl THEN CASE WHEN regexp_replace(CASE WHEN b.team = m.team1 THEN m.team2 ELSE m.team1 END, ' Women$', '') IN ('Afghanistan','Australia','Bangladesh','England','India','Ireland','New Zealand','Pakistan','South Africa','Sri Lanka','West Indies','Zimbabwe')
                                  THEN 'intl_full' ELSE 'intl_assoc' END
            ELSE 'dom_' || coalesce(m.country, '?') END AS comp_class,
       b.runs, b.balls,
       CASE WHEN b.dismissal IN ('not out', 'retired hurt', 'absent hurt', 'retired not out', '', '[dismissal not known]', 'did not bat')
                 OR b.dismissal IS NULL THEN 0 ELSE 1 END AS outs
FROM c.batting b JOIN m ON m.id = b.match_id
WHERE m.format IS NOT NULL AND b.balls IS NOT NULL AND b.balls > 0 AND b.runs IS NOT NULL;

CREATE TEMP TABLE bowl AS
SELECT m.format, m.gender, m.year, w.player_id, w.match_id, w.team,
       CASE WHEN m.intl THEN m.format || 'I v ' || regexp_replace(CASE WHEN w.team = m.team1 THEN m.team2 ELSE m.team1 END, ' Women$', '')
            ELSE m.event_key END AS comp,
       CASE WHEN m.intl THEN CASE WHEN regexp_replace(CASE WHEN w.team = m.team1 THEN m.team2 ELSE m.team1 END, ' Women$', '') IN ('Afghanistan','Australia','Bangladesh','England','India','Ireland','New Zealand','Pakistan','South Africa','Sri Lanka','West Indies','Zimbabwe')
                                  THEN 'intl_full' ELSE 'intl_assoc' END
            ELSE 'dom_' || coalesce(m.country, '?') END AS comp_class,
       w.runs, coalesce(w.wickets, 0) AS wickets,
       -- Overs where given; else the card's own balls (The Hundred has no overs), else runs * 100 / Econ (Hundred Econ
       -- is runs per 100 balls)
       coalesce(try_cast(split_part(w.overs, '.', 1) AS INT) * 6 + coalesce(try_cast(nullif(split_part(w.overs, '.', 2), '') AS INT), 0),
                w.balls,
                CASE WHEN m.event_key LIKE '%hundred%' AND w.economy > 0 THEN round(w.runs * 100.0 / w.economy)::INT END) AS balls
FROM c.bowling w JOIN m ON m.id = w.match_id
WHERE m.format IS NOT NULL AND w.runs IS NOT NULL;
DELETE FROM bowl WHERE balls IS NULL OR balls <= 0;

-- Bottom-up match strength: per match the two XIs' batting / bowling strength, plus comp-season means
CREATE TEMP TABLE ms AS
SELECT match_id, competition, season_year, team1, team2, bat1, bowl1, bat2, bowl2
FROM 'data/analysis/match_strength.parquet' WHERE bat1 IS NOT NULL AND bat2 IS NOT NULL AND bowl1 IS NOT NULL AND bowl2 IS NOT NULL;
CREATE TEMP TABLE ms_comp AS
SELECT competition, season_year, avg((bat1 + bat2) / 2) AS cbat, avg((bowl1 + bowl2) / 2) AS cbowl FROM ms GROUP BY ALL;
CREATE TEMP TABLE ms_adj AS
SELECT ms.match_id, ms.team1, ms.team2, ms.bat1, ms.bowl1, ms.bat2, ms.bowl2, c.cbat, c.cbowl
FROM ms JOIN ms_comp c USING (competition, season_year);

-- Competition-season baselines, blended toward format x gender x year with a 3000-ball prior
CREATE TEMP TABLE base AS
WITH bs AS (SELECT format, gender, year, comp, sum(balls) balls, sum(runs) runs, sum(outs) outs FROM bat GROUP BY ALL),
     ws AS (SELECT format, gender, year, comp, sum(balls) balls, sum(runs) runs, sum(wickets) wkts FROM bowl GROUP BY ALL),
     bg AS (SELECT format, gender, year, sum(runs)/sum(balls) rpb, sum(outs)/sum(balls) opb FROM bat GROUP BY ALL),
     wg AS (SELECT format, gender, year, sum(runs)/sum(balls) rpb, sum(wickets)/sum(balls) wpb FROM bowl GROUP BY ALL)
SELECT 'bat' AS side, bs.format, bs.gender, bs.year, bs.comp, bs.balls,
       (bs.runs + 3000*bg.rpb)/(bs.balls + 3000) AS rpb, (bs.outs + 3000*bg.opb)/(bs.balls + 3000) AS opb
FROM bs JOIN bg USING (format, gender, year)
UNION ALL
SELECT 'bowl', ws.format, ws.gender, ws.year, ws.comp, ws.balls,
       (ws.runs + 3000*wg.rpb)/(ws.balls + 3000), (ws.wkts + 3000*wg.wpb)/(ws.balls + 3000)
FROM ws JOIN wg USING (format, gender, year);
ALTER TABLE base ADD COLUMN w DOUBLE;
UPDATE base SET w = (CASE format WHEN 'T20' THEN 0.3 WHEN 'ListA' THEN 0.5 ELSE 1.0 END) * rpb / greatest(opb, 1e-4);

COPY base TO 'data/analysis/ca_comp_seasons.parquet' (FORMAT parquet);

COPY (
  SELECT 'bat' AS side, b.format, b.gender, b.comp, b.comp_class, b.year, b.player_id,
         count(*) AS inns, sum(b.balls) AS balls, sum(b.runs) AS runs, sum(b.outs) AS outs,
         sum(b.runs - b.balls*x.rpb - (b.outs - b.balls*x.opb)*x.w
             + b.balls * coalesce(a.cbat + CASE WHEN b.team = a.team1 THEN a.bowl2 WHEN b.team = a.team2 THEN a.bowl1 END - a.cbowl, 0) / 100) AS value_ms,
         sum(b.runs - b.balls*x.rpb - (b.outs - b.balls*x.opb)*x.w) AS value,
         sum(b.balls * CASE WHEN b.position <= 3 THEN 1 ELSE 0 END) AS balls_top,
         sum(b.balls * CASE WHEN b.position BETWEEN 4 AND 7 THEN 1 ELSE 0 END) AS balls_mid,
         sum(b.balls * CASE WHEN b.position >= 8 THEN 1 ELSE 0 END) AS balls_low,
         sum(b.position * b.balls) / sum(b.balls) AS mean_position
  FROM bat b JOIN base x ON x.side = 'bat' AND x.format = b.format AND x.gender = b.gender AND x.year = b.year AND x.comp = b.comp
  LEFT JOIN ms_adj a ON a.match_id = b.match_id
  GROUP BY ALL
  UNION ALL
  SELECT 'bowl', w.format, w.gender, w.comp, w.comp_class, w.year, w.player_id,
         count(*), sum(w.balls), sum(w.runs), sum(w.wickets),
         sum(w.balls*x.rpb - w.runs + (w.wickets - w.balls*x.opb)*x.w
             + w.balls * coalesce(a.cbowl + CASE WHEN w.team = a.team1 THEN a.bat2 WHEN w.team = a.team2 THEN a.bat1 END - a.cbat, 0) / 100),
         sum(w.balls*x.rpb - w.runs + (w.wickets - w.balls*x.opb)*x.w),
         NULL, NULL, NULL, NULL
  FROM bowl w JOIN base x ON x.side = 'bowl' AND x.format = w.format AND x.gender = w.gender AND x.year = w.year AND x.comp = w.comp
  LEFT JOIN ms_adj a ON a.match_id = w.match_id
  GROUP BY ALL
) TO 'data/analysis/ca_cells.parquet' (FORMAT parquet);

SELECT 'index coverage (bat innings with a match-strength row)' AS what,
       round(avg((a.match_id IS NOT NULL AND (b.team = a.team1 OR b.team = a.team2))::INT), 3) AS share
FROM bat b LEFT JOIN ms_adj a ON a.match_id = b.match_id;
SELECT side, format, gender, count(*) cells, count(DISTINCT player_id) players, count(DISTINCT comp) comps,
       sum(balls) balls, round(sum(value)/sum(balls)*100, 3) mean_val_per100
FROM 'data/analysis/ca_cells.parquet' GROUP BY ALL ORDER BY ALL;
