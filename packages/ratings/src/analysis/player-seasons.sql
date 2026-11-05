-- T20 player-season value, adjusted for context: competition-season, phase, wickets down,
-- innings, and venue ("pitch") factor; with batting position and bowling phase as roles.
--
-- Inputs:  data/analysis/{deliveries,matches,people}.parquet (cricsheet-deliveries.ts)
-- Outputs: data/analysis/venue_factors.parquet
--          data/analysis/batting_seasons.parquet
--          data/analysis/bowling_seasons.parquet
--          data/analysis/ball_values.parquet   (ball level: context expectations, for ratings-model.py)
-- Run from packages/ratings:  duckdb < src/analysis/player-seasons.sql
--
-- Method: every ball gets an expected outcome = mean runs/ball and dismissal rate for its
-- context cell (competition-season x phase x wickets-down bucket x innings), scaled by the
-- venue's run factor. Player value = actual - expected, summed. Venue factors are shrunk toward
-- 1.0 with a prior worth VENUE_PRIOR_BALLS balls, so grounds with few matches stay neutral.

SET VARIABLE venue_prior_balls = 3000;
SET VARIABLE full_members = ['Afghanistan', 'Australia', 'Bangladesh', 'England', 'India', 'Ireland',
  'New Zealand', 'Pakistan', 'South Africa', 'Sri Lanka', 'West Indies', 'Zimbabwe'];

-- Grounds whose matches sometimes omit the city: take the city most often recorded for that name
CREATE TEMP TABLE ground_city AS
SELECT lower(split_part(venue, ',', 1)) AS ground, mode(city) AS city
FROM 'data/analysis/matches.parquet' WHERE city IS NOT NULL GROUP BY 1;

CREATE TEMP TABLE m AS
SELECT mm.match_id, mm.team1, mm.team2, mm.date, mm.season, mm.gender, mm.team_type, mm.venue, mm.city,
       -- Internationals are many small "events" (tours): pool them per gender and tier, since a
       -- full-member T20I and an associate T20I (Malaysia v Thailand) are very different levels
       CASE WHEN mm.team_type = 'international' THEN
              'International T20 ' ||
              CASE WHEN mm.team1 IN (SELECT unnest(getvariable('full_members'))) AND mm.team2 IN (SELECT unnest(getvariable('full_members')))
                   THEN 'full members' ELSE 'associates' END || ' (' || mm.gender || ')'
            ELSE mm.event END AS competition,
       year(mm.date) AS year,
       -- One key per ground: Cricsheet spells grounds several ways ("M Chinnaswamy Stadium",
       -- "M.Chinnaswamy Stadium", "..., Bengaluru"); keep city so the many "County Ground"s stay apart
       trim(regexp_replace(lower(split_part(mm.venue, ',', 1)), '[^a-z0-9]+', ' ', 'g')) || ' | ' ||
         CASE lower(coalesce(mm.city, nullif(split_part(mm.venue, ', ', 2), ''), gc.city))
              WHEN 'bangalore' THEN 'bengaluru' WHEN 'bombay' THEN 'mumbai' WHEN 'calcutta' THEN 'kolkata'
              WHEN 'madras' THEN 'chennai' ELSE lower(coalesce(mm.city, nullif(split_part(mm.venue, ', ', 2), ''), gc.city)) END AS venue_key
FROM 'data/analysis/matches.parquet' mm
LEFT JOIN ground_city gc ON gc.ground = lower(split_part(mm.venue, ',', 1))
WHERE mm.match_type IN ('T20', 'IT20');

-- Audit notes (see src/analysis/__tests__/ball_handling.test.py for the executable spec):
--  * wide: not a ball faced, not a legal delivery; its runs are the bowler's. A dismissal off a wide (stumped, hit wicket) still debits the striker
--    and credits the bowler, so such a row counts as faced for the dismissal accounting only.
--  * no-ball: faced by the batter (bat runs are his), conceded by the bowler (bat runs + the no-ball), not legal. The next delivery is a free hit.
--  * byes / leg-byes: faced, but neither credited to the batter nor charged to the bowler. Penalty runs: charged to nobody.
--  * bowler-credited dismissals are a whitelist (bowled, caught, caught and bowled, lbw, stumped, hit wicket); run out, obstructing, handled,
--    timed out, hit the ball twice, retired out are not. Retired hurt / retired not out are not dismissals at all (is_wicket = 0 upstream).
--  * wickets-down counts every genuine dismissal plus retired out (the team loses the wicket) but not retired hurt.
--  * free hits get their own expectation (data-derived factor on the context cell), so their inflated runs and impossible dismissals do not distort players.
--  * innings of reduced scheduled length (revised target under 20 overs) are excluded: their run rates are not comparable.
--  * phases use the innings' own powerplay (T20 overs 0-5, The Hundred sets 0-4) and the last 5 overs / sets as death.
--  * all-run fours are not boundaries (runs.non_boundary).
CREATE TEMP TABLE b AS
SELECT d.*, m.competition, m.year, m.gender, m.date AS match_date, m.venue_key AS venue, m.venue AS venue_name,
       m.competition || ' ' || m.year AS comp_season,
       CASE WHEN d."over" <= coalesce(d.inn_pp_end, 5) THEN 'powerplay' WHEN d."over" >= 15 THEN 'death' ELSE 'middle' END AS phase,
       (d.is_wicket = 1 AND d.wicket_kind IN ('bowled', 'caught', 'caught and bowled', 'lbw', 'stumped', 'hit wicket')) AS bowler_wicket,
       (d.wides = 0 OR (d.is_wicket = 1 AND d.player_out_id = d.batter_id
                        AND d.wicket_kind IN ('bowled', 'caught', 'caught and bowled', 'lbw', 'stumped', 'hit wicket'))) AS faced,   -- a ball for the batter (a dismissal off a wide still counts)
       (d.wides = 0 AND d.noballs = 0) AS legal,                 -- counts as a ball for the bowler
       d.runs_total - d.byes - d.legbyes - d.penalty AS bowler_runs,
       d.runs_extras - d.byes - d.legbyes - d.penalty AS bowler_extras,      -- wides + no-ball runs charged to the bowler
       (d.runs_batter = 4 AND d.non_boundary = 0) AS is_four,
       (d.runs_batter = 6 AND d.non_boundary = 0) AS is_six,
       -- free hit: the previous non-wide delivery was a no-ball (wides do not use up the free hit)
       coalesce(last_value(CASE WHEN d.noballs > 0 THEN 1 WHEN d.wides = 0 THEN 0 END IGNORE NULLS) OVER (
                  PARTITION BY d.match_id, d.innings ORDER BY d."over", d.ball ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) = 1 AS free_hit,
       -- revised-target innings: chase with a reduced allocation, or a first innings cut short in a match that went to a revised target
       (d.inn_target_overs < 20
        OR (d.innings = 1 AND max(d.inn_target_overs) OVER (PARTITION BY d.match_id) < 20
            AND max(d."over") OVER (PARTITION BY d.match_id, d.innings) < 19)) AS reduced,
       coalesce(sum(d.is_wicket) OVER (PARTITION BY d.match_id, d.innings ORDER BY d.over, d.ball
                                       ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS wkts_down,
       row_number() OVER (PARTITION BY d.match_id, d.innings ORDER BY d.over, d.ball) AS seq
FROM 'data/analysis/deliveries.parquet' d
JOIN m USING (match_id)
WHERE d.super_over = 0;
DELETE FROM b WHERE reduced;

-- ── Context cells ──
CREATE TEMP TABLE cell AS
SELECT comp_season, phase, least(wkts_down // 3, 2) AS wk_bucket, innings,
       avg(runs_batter) FILTER (faced) AS x_runs_per_ball,
       avg(is_wicket::DOUBLE) FILTER (faced) AS x_out_per_ball,
       -- per legal ball, but including the wides / no-ball rows' runs and wickets (they are charged to the bowler)
       sum(bowler_runs) / nullif(count(*) FILTER (legal), 0) AS x_conceded_per_ball,
       sum(bowler_wicket::INT) / nullif(count(*) FILTER (legal), 0) AS x_wkt_per_ball,
       -- ratings-model.py expectations (per faced ball unless noted)
       avg(bowler_wicket::DOUBLE) FILTER (faced) AS x_bw_per_ball,
       avg(is_six::DOUBLE) FILTER (faced) AS x_six_per_ball,
       avg(is_four::DOUBLE) FILTER (faced) AS x_four_per_ball,
       avg((runs_batter - 4 * is_four::INT - 6 * is_six::INT)::DOUBLE) FILTER (faced) AS x_nb_per_ball,
       avg(bowler_extras::DOUBLE) AS x_extras_per_row           -- every row, wides included
FROM b WHERE NOT free_hit GROUP BY ALL;      -- free hits are modelled separately (below)

-- ── Venue ("pitch") factors: venue runs/ball vs its own context expectation, shrunk to 1.0 ──
CREATE TEMP TABLE venue_raw AS
SELECT b.venue, b.gender,
       count(*) FILTER (faced) AS balls,
       sum(b.runs_batter) FILTER (faced) AS runs,
       sum(c.x_runs_per_ball) FILTER (faced) AS x_runs,
       sum(b.is_wicket) FILTER (faced) AS outs,
       sum(c.x_out_per_ball) FILTER (faced) AS x_outs,
       count(DISTINCT b.match_id) AS matches
FROM b JOIN cell c ON c.comp_season = b.comp_season AND c.phase = b.phase
                  AND c.wk_bucket = least(b.wkts_down // 3, 2) AND c.innings = b.innings
WHERE NOT b.free_hit
GROUP BY ALL;

CREATE TEMP TABLE venue AS
SELECT venue, gender, matches, balls,
       (runs + getvariable('venue_prior_balls') * x_runs / balls) / (x_runs + getvariable('venue_prior_balls') * x_runs / balls) AS run_factor,
       (outs + getvariable('venue_prior_balls') * x_outs / balls) / (x_outs + getvariable('venue_prior_balls') * x_outs / balls) AS wicket_factor
FROM venue_raw;
COPY venue TO 'data/analysis/venue_factors.parquet' (FORMAT parquet);

-- ── Free hits: pooled actual / expected ratio per gender (free hits score faster and bowler-credited dismissals are almost impossible) ──
CREATE TEMP TABLE fh AS
SELECT b.gender,
       sum(b.runs_batter) FILTER (b.faced) / sum(c.x_runs_per_ball) FILTER (b.faced) AS f_runs,
       sum(b.bowler_wicket::INT) FILTER (b.faced) / nullif(sum(c.x_bw_per_ball) FILTER (b.faced), 0) AS f_bw,
       sum(b.is_six::INT) FILTER (b.faced) / nullif(sum(c.x_six_per_ball) FILTER (b.faced), 0) AS f_six,
       sum(b.is_four::INT) FILTER (b.faced) / nullif(sum(c.x_four_per_ball) FILTER (b.faced), 0) AS f_four,
       sum((b.runs_batter - 4 * b.is_four::INT - 6 * b.is_six::INT)) FILTER (b.faced) / nullif(sum(c.x_nb_per_ball) FILTER (b.faced), 0) AS f_nb,
       sum(b.is_wicket) FILTER (b.faced) / nullif(sum(c.x_out_per_ball) FILTER (b.faced), 0) AS f_out
FROM b JOIN cell c ON c.comp_season = b.comp_season AND c.phase = b.phase AND c.wk_bucket = least(b.wkts_down // 3, 2) AND c.innings = b.innings
WHERE b.free_hit GROUP BY b.gender;

-- ── Expected outcome per ball ──
CREATE TEMP TABLE bx AS
SELECT b.*,
       c.x_runs_per_ball * coalesce(v.run_factor, 1) * CASE WHEN b.free_hit THEN coalesce(fh.f_runs, 1) ELSE 1 END AS x_runs,
       c.x_out_per_ball * coalesce(v.wicket_factor, 1) * CASE WHEN b.free_hit THEN coalesce(fh.f_out, 1) ELSE 1 END AS x_out,
       c.x_conceded_per_ball * coalesce(v.run_factor, 1) * CASE WHEN b.free_hit THEN coalesce(fh.f_runs, 1) ELSE 1 END AS x_conceded,
       c.x_wkt_per_ball * coalesce(v.wicket_factor, 1) * CASE WHEN b.free_hit THEN coalesce(fh.f_bw, 1) ELSE 1 END AS x_wkt,
       c.x_bw_per_ball * coalesce(v.wicket_factor, 1) * CASE WHEN b.free_hit THEN coalesce(fh.f_bw, 1) ELSE 1 END AS x_bw,
       c.x_six_per_ball * coalesce(v.run_factor, 1) * CASE WHEN b.free_hit THEN coalesce(fh.f_six, 1) ELSE 1 END AS x_six,
       c.x_four_per_ball * coalesce(v.run_factor, 1) * CASE WHEN b.free_hit THEN coalesce(fh.f_four, 1) ELSE 1 END AS x_four,
       c.x_nb_per_ball * coalesce(v.run_factor, 1) * CASE WHEN b.free_hit THEN coalesce(fh.f_nb, 1) ELSE 1 END AS x_nb,
       c.x_extras_per_row AS x_extras
FROM b
JOIN cell c ON c.comp_season = b.comp_season AND c.phase = b.phase
           AND c.wk_bucket = least(b.wkts_down // 3, 2) AND c.innings = b.innings
LEFT JOIN venue v ON v.venue = b.venue AND v.gender = b.gender
LEFT JOIN fh ON fh.gender = b.gender;

-- ── Batting position (role): order of first appearance at the crease ──
CREATE TEMP TABLE arrivals AS
SELECT match_id, innings, player_id, min(seq) AS first_seq, bool_or(as_striker_first) AS striker_first
FROM (
  SELECT match_id, innings, batter_id AS player_id, seq, seq = 1 AS as_striker_first FROM b
  UNION ALL
  SELECT match_id, innings, non_striker_id, seq, false FROM b
) WHERE player_id IS NOT NULL
GROUP BY ALL;

CREATE TEMP TABLE positions AS
SELECT match_id, innings, player_id,
       row_number() OVER (PARTITION BY match_id, innings ORDER BY first_seq, striker_first DESC) AS position
FROM arrivals;

-- ── Batting seasons ──
CREATE TEMP TABLE bat AS
SELECT x.batter_id AS player_id, any_value(x.batter) AS name, x.gender, x.competition, x.year,
       count(DISTINCT x.match_id) AS innings,
       count(*) FILTER (x.faced) AS balls,
       sum(x.runs_batter) AS runs,
       sum((x.is_four OR x.is_six)::INT) AS boundaries,
       sum((x.runs_batter = 0 AND x.faced)::INT) AS dots,
       sum(x.is_wicket) FILTER (x.player_out_id = x.batter_id) AS outs,
       sum(x.x_runs) FILTER (x.faced) AS x_runs,
       sum(x.x_out) FILTER (x.faced) AS x_outs,
       -- share of balls by phase: what kind of batter they are used as
       avg((x.phase = 'powerplay')::INT) AS pp_share,
       avg((x.phase = 'death')::INT) AS death_share
FROM bx x
WHERE x.batter_id IS NOT NULL
GROUP BY ALL;

-- dismissals of the non-striker (run out at either end, obstructing) belong to the player who was out, not to the batter on strike
CREATE TEMP TABLE ns_outs AS
SELECT player_out_id AS player_id, gender, competition, year, count(*) AS outs_non_striker
FROM bx WHERE is_wicket = 1 AND player_out_id IS NOT NULL AND player_out_id <> batter_id GROUP BY ALL;

COPY (
  SELECT bat.* EXCLUDE (outs), bat.outs AS outs_on_strike, coalesce(ns.outs_non_striker, 0) AS outs_non_striker,
         coalesce(bat.outs, 0) + coalesce(ns.outs_non_striker, 0) AS outs,
         100.0 * runs / nullif(balls, 0) AS strike_rate,
         100.0 * (runs - x_runs) / nullif(balls, 0) AS runs_above_avg_per_100,
         runs::DOUBLE / nullif(coalesce(bat.outs, 0) + coalesce(ns.outs_non_striker, 0), 0) AS average,
         x_outs - (coalesce(bat.outs, 0) + coalesce(ns.outs_non_striker, 0)) AS dismissals_avoided,
         p.median_position,
         -- T20 batting slots: 1-2 open, 3-4 top order, 5 middle, 6-7 finish, 8+ tail
         CASE WHEN p.median_position <= 2 THEN 'opener'
              WHEN p.median_position <= 4 THEN 'top order'
              WHEN p.median_position < 6 THEN 'middle order'
              WHEN p.median_position <= 7 THEN 'finisher'
              ELSE 'tail' END AS batting_role,
         pe.cricinfo_id, pe.cricketarchive_id
  FROM bat
  LEFT JOIN ns_outs ns USING (player_id, gender, competition, year)
  LEFT JOIN (
    SELECT x.batter_id AS player_id, x.competition, x.year, median(pos.position) AS median_position
    FROM (SELECT DISTINCT match_id, innings, batter_id, competition, year FROM bx) x
    JOIN positions pos ON pos.match_id = x.match_id AND pos.innings = x.innings AND pos.player_id = x.batter_id
    GROUP BY ALL
  ) p USING (player_id, competition, year)
  LEFT JOIN 'data/analysis/people.parquet' pe ON pe.cricsheet_id = bat.player_id
) TO 'data/analysis/batting_seasons.parquet' (FORMAT parquet);

-- ── Bowling seasons ──
COPY (
  SELECT x.bowler_id AS player_id, any_value(x.bowler) AS name, x.gender, x.competition, x.year,
         count(DISTINCT x.match_id) AS matches,
         count(*) FILTER (x.legal) AS balls,
         sum(x.bowler_runs) AS conceded,
         sum(x.bowler_wicket::INT) AS wickets,
         sum((x.runs_total = 0 AND x.legal)::INT) AS dots,
         sum(x.x_conceded) FILTER (x.legal) AS x_conceded,
         sum(x.x_wkt) FILTER (x.legal) AS x_wickets,
         6.0 * sum(x.bowler_runs) / nullif(count(*) FILTER (x.legal), 0) AS economy,
         100.0 * (sum(x.x_conceded) FILTER (x.legal) - sum(x.bowler_runs)) / nullif(count(*) FILTER (x.legal), 0) AS runs_saved_per_100,
         sum(x.bowler_wicket::INT) - sum(x.x_wkt) FILTER (x.legal) AS wickets_above_avg,
         avg((x.phase = 'powerplay')::INT) FILTER (x.legal) AS pp_share,
         avg((x.phase = 'middle')::INT) FILTER (x.legal) AS middle_share,
         avg((x.phase = 'death')::INT) FILTER (x.legal) AS death_share,
         CASE WHEN avg((x.phase = 'powerplay')::INT) FILTER (x.legal) >= 0.3
                   AND avg((x.phase = 'death')::INT) FILTER (x.legal) >= 0.3 THEN 'new ball + death'
              WHEN avg((x.phase = 'death')::INT) FILTER (x.legal) >= 0.4 THEN 'death specialist'
              WHEN avg((x.phase = 'powerplay')::INT) FILTER (x.legal) >= 0.45 THEN 'powerplay / new ball'
              WHEN avg((x.phase = 'middle')::INT) FILTER (x.legal) >= 0.6 THEN 'middle overs'
              ELSE 'all phases' END AS bowling_role,
         any_value(pe.cricinfo_id) AS cricinfo_id, any_value(pe.cricketarchive_id) AS cricketarchive_id
  FROM bx x
  LEFT JOIN 'data/analysis/people.parquet' pe ON pe.cricsheet_id = x.bowler_id
  WHERE x.bowler_id IS NOT NULL
  GROUP BY x.bowler_id, x.gender, x.competition, x.year
) TO 'data/analysis/bowling_seasons.parquet' (FORMAT parquet);

-- ── Ball level, for ratings-model.py (opponent-adjusted skills and decayed snapshots) ──
COPY (
  SELECT x.match_id, x.match_date AS date, x.gender, x.competition, x.year, x.innings, x.phase, x.over AS ball_over, x.wkts_down,
         x.batter_id, x.bowler_id, pos.position AS bat_pos, x.faced, x.legal,
         x.runs_batter, x.bowler_wicket::INT AS bowler_wicket, x.bowler_extras, x.is_four::INT AS is_four, x.is_six::INT AS is_six, x.free_hit::INT AS free_hit,
         x.x_runs, x.x_bw, x.x_six, x.x_four, x.x_nb, x.x_extras
  FROM bx x
  LEFT JOIN positions pos ON pos.match_id = x.match_id AND pos.innings = x.innings AND pos.player_id = x.batter_id
) TO 'data/analysis/ball_values.parquet' (FORMAT parquet);
