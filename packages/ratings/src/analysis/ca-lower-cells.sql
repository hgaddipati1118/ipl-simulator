-- Lower-level cricket (CricketArchive event-only scorecards: second XIs, university, club / league, youth,
-- veterans) -> per player x competition x year cells, valued like ca-player-seasons.sql so ca-lower-ratings.py can
-- put them on the senior scale. Run from packages/ratings after `npx tsx src/pipeline/build-db.ts --events-only`:
--     duckdb < src/analysis/ca-lower-cells.sql
-- Output: data/analysis/ca_lower_cells.parquet  (same columns as ca_cells.parquet plus tier / tier_name; no match-strength
--         adjustment, the bottom-up index only covers senior matches)
--         data/analysis/ca_lower_comp_seasons.parquet
-- Cards already counted as senior (their levels say Twenty20 / List A / First-Class) are skipped: they are in ca_cells.
-- Format is inferred from the card: "N-over match" (N <= 24 -> T20, 25..60 -> ListA), "N-day match" and timed one-day
-- games -> FC; cards that don't say (day/night ...) from the most overs any bowling side bowled.
-- Batting is valued only on innings with balls recorded (about a third of minor-cricket innings have them); bowling
-- uses overs, which every card has.
LOAD sqlite;
ATTACH 'data/cricket-events.db' AS e (TYPE sqlite, READ_ONLY);
SET threads = 2;
SET memory_limit = '3GB';

CREATE TEMP TABLE maxov AS
SELECT match_id, max(ov) AS max_overs FROM (
  SELECT match_id, innings, sum(try_cast(split_part(overs, '.', 1) AS INT) + coalesce(try_cast(nullif(split_part(overs, '.', 2), '') AS INT), 0) / 6.0) AS ov
  FROM e.bowling GROUP BY ALL) GROUP BY ALL;

CREATE TEMP TABLE m AS
SELECT mm.id, mm.date::DATE AS date, year(mm.date::DATE) AS year, mm.gender, mm.tier, mm.team1, mm.team2, mm.country,
       CASE WHEN regexp_extract(mm.date_text, '\((\d+)-over match\)', 1) <> ''
                 THEN CASE WHEN regexp_extract(mm.date_text, '\((\d+)-over match\)', 1)::INT <= 24 THEN 'T20'
                           WHEN regexp_extract(mm.date_text, '\((\d+)-over match\)', 1)::INT <= 60 THEN 'ListA' ELSE 'FC' END
            WHEN mm.date_text LIKE '%-day%' AND mm.date_text NOT LIKE '%1-day single%' AND mm.date_text NOT LIKE '%1-day match%' THEN 'FC'
            WHEN mm.date_text LIKE '%1-day single innings%' THEN 'FC'
            WHEN o.max_overs IS NULL THEN NULL
            WHEN o.max_overs <= 21 THEN 'T20' WHEN o.max_overs <= 61 THEN 'ListA' ELSE 'FC' END AS format,
       lower(trim(regexp_replace(regexp_replace(regexp_replace(coalesce(mm.event, 'misc ' || coalesce(mm.country, '')),
             '\s*\([^)]*\)\s*$', ''), '\b(19|20)\d{2}(/\d{2,4})?\b', '', 'g'), '\s+', ' ', 'g'))) AS event_key
FROM e.matches mm LEFT JOIN maxov o ON o.match_id = mm.id
WHERE mm.date IS NOT NULL AND try_cast(mm.date AS DATE) IS NOT NULL AND year(mm.date::DATE) >= 2000
  AND NOT (mm.levels LIKE '%Twenty20%' OR mm.levels LIKE '%List A%' OR mm.levels LIKE '%First-Class%');
DELETE FROM m WHERE format IS NULL;

CREATE TEMP TABLE bat AS
SELECT m.format, m.gender, m.tier, m.year, b.player_id, b.position, b.match_id, b.team, m.event_key AS comp,
       b.runs, b.balls,
       CASE WHEN b.dismissal IN ('not out', 'retired hurt', 'absent hurt', 'retired not out', '', '[dismissal not known]', 'did not bat')
                 OR b.dismissal IS NULL THEN 0 ELSE 1 END AS outs
FROM e.batting b JOIN m ON m.id = b.match_id
WHERE b.balls IS NOT NULL AND b.balls > 0 AND b.runs IS NOT NULL;

CREATE TEMP TABLE bowl AS
SELECT m.format, m.gender, m.tier, m.year, w.player_id, w.match_id, w.team, m.event_key AS comp, w.runs, coalesce(w.wickets, 0) AS wickets,
       coalesce(try_cast(split_part(w.overs, '.', 1) AS INT) * 6 + coalesce(try_cast(nullif(split_part(w.overs, '.', 2), '') AS INT), 0), w.balls) AS balls
FROM e.bowling w JOIN m ON m.id = w.match_id
WHERE w.runs IS NOT NULL;
DELETE FROM bowl WHERE balls IS NULL OR balls <= 0;

-- Competition-season baselines, blended toward format x gender x tier x year with a 3000-ball prior
CREATE TEMP TABLE base AS
WITH bs AS (SELECT format, gender, tier, year, comp, sum(balls) balls, sum(runs) runs, sum(outs) outs FROM bat GROUP BY ALL),
     ws AS (SELECT format, gender, tier, year, comp, sum(balls) balls, sum(runs) runs, sum(wickets) wkts FROM bowl GROUP BY ALL),
     bg AS (SELECT format, gender, tier, year, sum(runs)/sum(balls) rpb, sum(outs)/sum(balls) opb FROM bat GROUP BY ALL),
     wg AS (SELECT format, gender, tier, year, sum(runs)/sum(balls) rpb, sum(wickets)/sum(balls) wpb FROM bowl GROUP BY ALL)
SELECT 'bat' AS side, bs.format, bs.gender, bs.tier, bs.year, bs.comp, bs.balls,
       (bs.runs + 3000*bg.rpb)/(bs.balls + 3000) AS rpb, (bs.outs + 3000*bg.opb)/(bs.balls + 3000) AS opb
FROM bs JOIN bg USING (format, gender, tier, year)
UNION ALL
SELECT 'bowl', ws.format, ws.gender, ws.tier, ws.year, ws.comp, ws.balls,
       (ws.runs + 3000*wg.rpb)/(ws.balls + 3000), (ws.wkts + 3000*wg.wpb)/(ws.balls + 3000)
FROM ws JOIN wg USING (format, gender, tier, year);
ALTER TABLE base ADD COLUMN w DOUBLE;
UPDATE base SET w = (CASE format WHEN 'T20' THEN 0.3 WHEN 'ListA' THEN 0.5 ELSE 1.0 END) * rpb / greatest(opb, 1e-4);

COPY base TO 'data/analysis/ca_lower_comp_seasons.parquet' (FORMAT parquet);

COPY (
  SELECT 'bat' AS side, b.format, b.gender, b.comp, 'tier' || b.tier AS comp_class, b.tier, b.year, b.player_id,
         count(*) AS inns, sum(b.balls) AS balls, sum(b.runs) AS runs, sum(b.outs) AS outs,
         sum(b.runs - b.balls*x.rpb - (b.outs - b.balls*x.opb)*x.w) AS value,
         sum(b.balls * CASE WHEN b.position <= 3 THEN 1 ELSE 0 END) AS balls_top,
         sum(b.balls * CASE WHEN b.position BETWEEN 4 AND 7 THEN 1 ELSE 0 END) AS balls_mid,
         sum(b.balls * CASE WHEN b.position >= 8 THEN 1 ELSE 0 END) AS balls_low,
         sum(b.position * b.balls) / sum(b.balls) AS mean_position
  FROM bat b JOIN base x ON x.side = 'bat' AND x.format = b.format AND x.gender = b.gender AND x.tier = b.tier AND x.year = b.year AND x.comp = b.comp
  GROUP BY ALL
  UNION ALL
  SELECT 'bowl', w.format, w.gender, w.comp, 'tier' || w.tier, w.tier, w.year, w.player_id,
         count(*), sum(w.balls), sum(w.runs), sum(w.wickets),
         sum(w.balls*x.rpb - w.runs + (w.wickets - w.balls*x.opb)*x.w),
         NULL, NULL, NULL, NULL
  FROM bowl w JOIN base x ON x.side = 'bowl' AND x.format = w.format AND x.gender = w.gender AND x.tier = w.tier AND x.year = w.year AND x.comp = w.comp
  GROUP BY ALL
) TO 'data/analysis/ca_lower_cells.parquet' (FORMAT parquet);

SELECT side, format, gender, tier, count(*) cells, count(DISTINCT player_id) players, count(DISTINCT comp) comps, sum(balls) balls,
       round(sum(value)/sum(balls)*100, 3) mean_val_per100
FROM 'data/analysis/ca_lower_cells.parquet' GROUP BY ALL ORDER BY ALL;
