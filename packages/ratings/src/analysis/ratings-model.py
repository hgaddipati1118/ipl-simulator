"""
T20 player-ratings model: opponent- and league-adjusted skills, recency-decayed season snapshots,
age curve, components, roles, and out-of-sample validation.

Run order (from packages/ratings):
    npx tsx src/analysis/cricsheet-deliveries.ts && duckdb < src/analysis/player-seasons.sql && python3 -I src/analysis/league-strength.py && python3 -I src/analysis/ratings-model.py && python3 -I src/analysis/ratings-report.py
(league-strength.py needs its CSV export step first, see its docstring.)  ratings-model.py takes ~2-3 minutes.

Method
 1. ball_values.parquet (player-seasons.sql) gives every T20 ball an expectation from its context cell
    (competition-season x phase x wickets-down x innings x venue).  Five batter-oriented residuals per faced
    ball: runs (rv), dismissal avoided (dis), six, four, non-boundary runs (rr).
 2. Opponent adjustment.  For each metric the residual is modelled as  e = beta[batter] - gamma[bowler]
    (higher = better for the batter).  beta/gamma come from alternating shrunken least squares over all balls, so
    a batter is credited against the bowlers he actually faced and a bowler against the batters he bowled to.
    Shrinkage targets are hierarchical: league pool mean (seeded from league_strength.csv, then learned from the
    data with K_POOL balls of pull) + a role offset (batting-position bucket / bowling-workload bucket).
    Everything is re-centred so the ball-weighted IPL (men) / WPL (women) average is 0.  beta and gamma share one
    scale, so league strength is carried by players who move between leagues rather than a hand-set multiplier.
 2b. League translation.  The additive model under-corrects weak leagues: players seen in both a weak tier (associates, small
    domestic) and the elite tier do far worse in the elite tier than their adjusted weak-tier numbers say (skill transfers with
    correlation ~0.6, and the average weak-tier player is far below the elite average).  translation() estimates, per tier,
    common = P' + rho * (adjusted - tier pool) from those link players and applies it to every weak/mid-tier ball.
 3b. Round 2 (current season).  On top of the long-run skill: (i) a current-form blend with a ~2-season window (weight set by a
    1%-error tolerance, since validation puts almost no weight on form); (ii) an elite-exposure gate that pulls players with few
    recent elite/mid-tier balls toward their role prior (strictest gate within a 2% error budget); (iii) an inactivity decay
    (distance to prior halves each year after a year with no elite/mid-tier ball); (iv) an age projection used by `overall`;
    (v) overall = value in a team role (primary impact + half the secondary), not a sum.
 3. Snapshots.  Adjusted ball values  e + gamma[bowler]  (batters) and  beta[batter] - e  (bowlers) are summed per
    player with exponential recency decay (half-life tuned) from balls strictly BEFORE the snapshot date, then
    shrunk toward the role/league prior with a tuned K per metric.
 4. Age curve from year-over-year changes of the same players (DOB from ESPN), applied as a forward projection.
 5. Validation: fit through 2020/2022/2024, predict the next two years.  Half-life and K are tuned on the 2021-22
    and 2023-24 folds only; 2025-26 is reported untouched.

Outputs (data/analysis/): player_ratings_by_season.parquet, ratings_validation.json, tuned_params.json,
    age_curve.csv, league_levels.csv.   Work database: $RATINGS_WORK or $TMPDIR/ratings-work (safe to delete).
Flags: --fresh (rebuild the work database from scratch)
"""

import csv
import json
import math
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
WORK = Path(os.environ.get("RATINGS_WORK", Path(os.environ.get("TMPDIR", "/tmp")) / "ratings-work"))
DB = str(WORK / "ratings.duckdb")

METRICS = ["rv", "dis", "six", "four", "rr"]
BOWL_METRICS = ["rv", "dis"]
ALS_K = {"rv": 400, "dis": 1500, "six": 500, "four": 500, "rr": 500}   # shrinkage (balls) inside the opponent fit
K_POOL = 20000                    # balls of pull toward the seeded league pool mean
ITERS = 25
LAM = {}                          # runs a dismissal costs, by phase (derived from the data, see wicket_values)
LAM_SCALE = 1.0                   # sensitivity knob for the report
ANCHOR = {"male": ["Indian Premier League"],
          "female": ["Women's Premier League", "Women's Big Bash League", "The Hundred Women's Competition", "International T20 full members (female)"]}
TRAIN_YEARS = [2020, 2022, 2024]  # validation folds; the 'all' fit is the production model
HALF_LIVES = [0.5, 1.0, 1.5, 2.0, 3.0, 5.0, 8.0, 12.0]                    # years
K_GRID = [50, 100, 200, 400, 800, 1600, 3200, 6400, 12800]
TUNE_FOLDS = [2020, 2022]         # the 2024 fold (2025-26) is never used for tuning
PHASE_K = {"rv": 400, "dis": 1600}  # shrink of a phase rating toward the player's overall (untuned)
GENDERS = ["male", "female"]
HL_SHORT = [0.5, 0.75, 1.0, 1.5, 2.0]           # current-form window half-lives (years)
KG_GRID = [0, 25, 50, 100, 150, 200, 300, 400]    # elite-exposure gate ramp: full weight at this many recent (decayed) elite balls
FORM_HALF_LIFE = 1.0                             # policy: current-form window (about the last two seasons)
FORM_TOLERANCE = 1.01                            # policy: take the most responsive form weight whose validation error is within 1% of the best
GATE_TOLERANCE = 1.02                            # policy: take the strictest exposure gate whose validation error is within 2% of no gate
MID_WEIGHT = 0.5                                 # a mid-tier ball counts half as much as an elite ball toward the gate
GRACE_YEARS = 1.0                                # no inactivity penalty until this long after the last elite/mid-tier ball
INACT_HALF_YEARS = 1.0                           # then the rating's distance from its prior halves every year
ROLE_REF = {"bat": 20.0, "bow": 18.0}            # balls per match of a full batting / bowling role
SECONDARY_BONUS = 0.5                            # overall = primary role impact + 0.5 x secondary role impact (if positive)
ESPN = ROOT / "data" / "scraped" / "espn-players.json"
RATINGS = {"male": ROOT / "data" / "scraped" / "espn-ratings-base.json", "female": ROOT / "data" / "scraped" / "espn-ratings-women-base.json"}   # the game's own stats-derived ratings, before the model re-rank


# ───────────────────────────── DuckDB plumbing ─────────────────────────────
def run(sql, fetch=False):
    cmd = ["duckdb", DB] + (["-csv", "-header"] if fetch else [])
    p = subprocess.run(cmd, input=sql, capture_output=True, text=True, cwd=ROOT)
    if p.returncode != 0:
        raise RuntimeError(f"duckdb failed:\n{p.stderr}\n--- SQL ---\n{sql[:4000]}")
    return list(csv.DictReader(p.stdout.splitlines())) if fetch else None


def q(sql):
    rows = run(sql, fetch=True)
    for r in rows:
        for k, v in r.items():
            try:
                r[k] = float(v) if v not in ("", None, "NULL") else None
            except ValueError:
                pass
    return rows


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def exists(name):
    return int(q(f"SELECT count(*) AS n FROM information_schema.tables WHERE table_name = '{name}'")[0]["n"]) > 0


WICKET_SQL = f"""
CREATE TABLE sx AS
SELECT m.gender, d.is_wicket, d."over" AS ov,
  sum(d.runs_total) OVER (PARTITION BY d.match_id ORDER BY d."over", d.ball) AS cum,
  sum(d.is_wicket) OVER (PARTITION BY d.match_id ORDER BY d."over", d.ball) AS w_after,
  sum(d.runs_total) OVER (PARTITION BY d.match_id) AS tot
FROM '{DATA}/deliveries.parquet' d JOIN '{DATA}/matches.parquet' m USING (match_id)
WHERE d.innings = 1 AND d.super_over = 0 AND m.match_type IN ('T20', 'IT20') AND m.date >= DATE '2015-01-01';
CREATE TABLE rr AS SELECT gender, ov, w_after AS w, avg(tot - cum) AS fut, count(*) AS n, sum(is_wicket) AS ev FROM sx GROUP BY ALL;
-- value of a wicket at (over, wickets down before the ball) = expected runs still to come without it minus with it
CREATE TABLE lam_raw AS
SELECT a.gender, b.ov, a.w AS wd, a.fut - b.fut AS lam, b.ev AS ev FROM rr a JOIN rr b ON a.gender = b.gender AND a.ov = b.ov AND b.w = a.w + 1
WHERE a.w <= 8 AND a.n > 100 AND b.n > 100;
CREATE TABLE lamtab AS      -- smoothed over adjacent overs, weighted by wickets that actually fell
SELECT r.gender, r.ov, r.wd, sum(n_.lam * n_.ev) / sum(n_.ev) AS lam
FROM lam_raw r JOIN lam_raw n_ ON n_.gender = r.gender AND n_.wd = r.wd AND abs(n_.ov - r.ov) <= 1 GROUP BY ALL;
CREATE TABLE lamph AS
SELECT CASE WHEN ov < 6 THEN 'powerplay' WHEN ov < 15 THEN 'middle' ELSE 'death' END AS phase, sum(lam * ev) / sum(ev) AS lam FROM lam_raw WHERE gender = 'male' GROUP BY 1;
"""


def wicket_values():
    """Runs a wicket costs by phase (men, first innings) = expected runs still to come with vs without it, averaged over the wickets that fell.
    Also available per state: table lamtab(gender, over, wickets down)."""
    global LAM
    LAM = {r["phase"]: r["lam"] * LAM_SCALE for r in q("SELECT phase, lam FROM lamph")}
    log(f"runs per wicket by phase: { {k: round(v, 1) for k, v in LAM.items()} } (pricing mode: {WICKET_PRICING})")


def lam_case(alias="d"):
    return f"CASE {alias}.phase WHEN 'powerplay' THEN {LAM['powerplay']} WHEN 'middle' THEN {LAM['middle']} ELSE {LAM['death']} END"


def lam_eff(a="a"):
    """Player-level wicket cost from the phase mix of his decayed balls."""
    return (f"((coalesce({a}.ne_pp, 0) * {LAM['powerplay']} + coalesce({a}.ne_mid, 0) * {LAM['middle']} + coalesce({a}.ne_d, 0) * {LAM['death']}) / {a}.ne)")


def anchor_sql(g):
    return ", ".join("'" + c.replace("'", "''") + "'" for c in ANCHOR[g])


def mlist(fmt, ms=None, sep=", "):
    return sep.join(fmt.format(m=m) for m in (ms or METRICS))


# ───────────────────────────── stage 0: load ─────────────────────────────
def load(fresh):
    WORK.mkdir(parents=True, exist_ok=True)
    if fresh and Path(DB).exists():
        Path(DB).unlink()
    if exists("bl"):
        return
    log("loading ball table")
    bv = f"'{DATA}/ball_values.parquet'"
    run(f"""
CREATE TABLE ls AS
  SELECT competition, gender, (batting_strength + bowling_strength) / 2 / 100 AS lvl
  FROM read_csv_auto('{DATA}/league_strength.csv');
CREATE TABLE cmap AS
  SELECT b.competition, b.gender, row_number() OVER (ORDER BY b.gender, b.competition) AS cid, coalesce(max(ls.lvl), 0) AS lvl
  FROM (SELECT DISTINCT competition, gender FROM {bv}) b LEFT JOIN ls USING (competition, gender) GROUP BY b.competition, b.gender;
CREATE TABLE pmap AS
  SELECT player_id, row_number() OVER (ORDER BY player_id) AS pid FROM (
    SELECT batter_id AS player_id FROM {bv} UNION SELECT bowler_id FROM {bv}) WHERE player_id IS NOT NULL;
{WICKET_SQL}
-- faced balls: the rows batter and bowler skills are fitted on
CREATE TABLE bl AS
  SELECT v.match_id, v.gender, v.date, c.cid, v.phase, pb.pid AS bi, pw.pid AS bj, v.bat_pos, v.legal::INT AS legal,
         v.runs_batter - v.x_runs AS e_rv,
         -(v.bowler_wicket - v.x_bw) * {"coalesce(lt.lam, lp.lam) / lp.lam" if WICKET_PRICING == "state" else "1.0"} AS e_dis,   -- dismissal avoided, in units of the phase-average wicket value
         v.ball_over AS ov, v.wkts_down AS wd,
         v.is_six - v.x_six AS e_six,
         v.is_four - v.x_four AS e_four,
         (v.runs_batter - 4 * v.is_four - 6 * v.is_six) - v.x_nb AS e_rr
  FROM {bv} v JOIN cmap c USING (competition, gender)
  JOIN pmap pb ON pb.player_id = v.batter_id JOIN pmap pw ON pw.player_id = v.bowler_id
  JOIN lamph lp ON lp.phase = v.phase
  LEFT JOIN lamtab lt ON lt.gender = v.gender AND lt.ov = v.ball_over AND lt.wd = least(v.wkts_down, 8)
  WHERE v.faced AND v.bat_pos IS NOT NULL;
-- wides and no-ball runs are charged to the bowler on every row, wides included
CREATE TABLE ex AS
  SELECT pw.pid, v.date, v.phase, count(*) AS n_all, sum(v.x_extras - v.bowler_extras) AS a_ext
  FROM {bv} v JOIN pmap pw ON pw.player_id = v.bowler_id GROUP BY ALL;
-- appearances (as batter or bowler) and matches bowled, per player-date, for workload per match
CREATE TABLE app AS
  SELECT pid, date, count(DISTINCT match_id) AS m FROM (
    SELECT pb.pid, v.date, v.match_id FROM {bv} v JOIN pmap pb ON pb.player_id = v.batter_id
    UNION ALL SELECT pw.pid, v.date, v.match_id FROM {bv} v JOIN pmap pw ON pw.player_id = v.bowler_id) GROUP BY pid, date;
CREATE TABLE wm AS SELECT bj AS pid, date, count(DISTINCT match_id) AS m FROM bl GROUP BY bj, date;
""")


def load_profiles():
    """ESPN profiles -> dob, hand, bowling style, roles (keyed by cricinfo id)."""
    if exists("prof"):
        return
    rows = []
    for p in json.load(open(ESPN)):
        pr = p["profile"]
        d = pr.get("dateOfBirth") or {}
        dob = f"{d['year']:04d}-{(d.get('month') or 7):02d}-{(d.get('date') or 1):02d}" if d.get("year") else ""
        styles = " / ".join(pr.get("bowlingStyles") or [])
        s = styles.lower()
        if "fast" in s or "medium" in s:
            ps = "pace"
        elif any(k in s for k in ("break", "spin", "orthodox", "chinaman", "googly")):
            ps = "spin"
        else:
            ps = ""
        roles = " / ".join(pr.get("playingRoles") or [])
        rows.append([pr["espnId"], dob, pr.get("gender"), " / ".join(pr.get("battingStyles") or []), styles, ps, roles,
                     int("wicketkeeper" in roles.lower()), pr.get("longName") or pr.get("name")])
    path = WORK / "profiles.csv"
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["cricinfo_id", "dob", "p_gender", "bat_style", "bowl_style", "pace_spin", "espn_roles", "keeper", "espn_name"])
        w.writerows(rows)
    run(f"CREATE TABLE prof AS SELECT * EXCLUDE (dob), TRY_CAST(nullif(dob, '') AS DATE) AS dob FROM read_csv('{path}', header=true, "
        f"types={{'cricinfo_id':'BIGINT','dob':'VARCHAR','keeper':'INT'}}, nullstr='');")


# ───────────────────────────── stage 1: opponent-adjusted skills ─────────────────────────────
def kappa(g, cutoff):
    """Seed for the non-run metrics' league pools: slope of each residual on the run residual."""
    r = q(f"""SELECT {mlist("covar_pop(e_{m}, e_rv) / var_pop(e_rv) AS k_{m}")} FROM bl
              WHERE gender = '{g}' AND date <= DATE '{cutoff}'""")[0]
    return {m: r[f"k_{m}"] for m in METRICS}


def fit_skills(g, cutoff, tag):
    """Alternating shrunken least squares for batter (beta) and bowler (gamma) skills for one gender."""
    log(f"ALS {tag} {g} through {cutoff}")
    kap = kappa(g, cutoff)
    ipl = ", ".join("'" + c.replace("'", "''") + "'" for c in ANCHOR[g])
    K = ALS_K
    run(f"""
CREATE OR REPLACE TABLE fb AS SELECT * FROM bl WHERE gender = '{g}' AND date <= DATE '{cutoff}';
CREATE OR REPLACE TABLE grp_bat AS
  SELECT bi AS pid, CASE WHEN avg(bat_pos) <= 2.5 THEN 'open' WHEN avg(bat_pos) <= 4.5 THEN 'top' WHEN avg(bat_pos) < 6 THEN 'mid'
                         WHEN avg(bat_pos) <= 7.5 THEN 'fin' ELSE 'tail' END AS grp FROM fb GROUP BY bi;
CREATE OR REPLACE TABLE grp_bow AS
  SELECT bj AS pid, CASE WHEN count(*) * 1.0 / count(DISTINCT match_id) < 8 THEN 'part'
                         WHEN count(*) * 1.0 / count(DISTINCT match_id) < 16 THEN 'support' ELSE 'front' END AS grp FROM fb GROUP BY bj;
CREATE OR REPLACE TABLE init_pool AS SELECT cid, {", ".join(f"lvl * {kap[m]} AS {m}" for m in METRICS)} FROM cmap WHERE gender = '{g}';
CREATE OR REPLACE TABLE pool_bat AS SELECT * FROM init_pool;
CREATE OR REPLACE TABLE pool_bow AS SELECT * FROM init_pool;
CREATE OR REPLACE TABLE sk_bat AS SELECT bi AS pid, {mlist("avg(p.{m}) AS {m}")} FROM fb JOIN init_pool p USING (cid) GROUP BY bi;
CREATE OR REPLACE TABLE sk_bow AS SELECT bj AS pid, {mlist("avg(p.{m}) AS {m}")} FROM fb JOIN init_pool p USING (cid) GROUP BY bj;
""")
    bat_expr = ", ".join(f"(sum(fb.e_{m} + w.{m}) + {K[m]} * any_value(p.{m})) / (count(*) + {K[m]}) AS {m}" for m in METRICS)
    bow_expr = ", ".join(f"(sum(b.{m} - fb.e_{m}) + {K[m]} * any_value(p.{m})) / (count(*) + {K[m]}) AS {m}" for m in METRICS)
    for it in range(ITERS):
        stmts = []
        for s, key, grp in (("bat", "bi", "grp_bat"), ("bow", "bj", "grp_bow")):
            stmts.append(f"""
CREATE OR REPLACE TABLE pool_{s} AS
  SELECT i.cid, {mlist("(sum(s.{m}) + " + str(K_POOL) + " * any_value(i.{m})) / (count(*) + " + str(K_POOL) + ") AS {m}")}
  FROM fb JOIN sk_{s} s ON s.pid = fb.{key} JOIN init_pool i ON i.cid = fb.cid GROUP BY i.cid;
CREATE OR REPLACE TABLE base_{s} AS
  SELECT fb.{key} AS pid, count(*) AS n, {mlist("avg(p.{m}) AS {m}")} FROM fb JOIN pool_{s} p ON p.cid = fb.cid GROUP BY fb.{key};
CREATE OR REPLACE TABLE omega_{s} AS
  SELECT g.grp, {mlist("sum(b.n * (s.{m} - b.{m})) / sum(b.n) AS {m}")}
  FROM base_{s} b JOIN sk_{s} s USING (pid) JOIN {grp} g USING (pid) GROUP BY g.grp;
CREATE OR REPLACE TABLE pri_{s} AS
  SELECT b.pid, {mlist("b.{m} + o.{m} AS {m}")} FROM base_{s} b JOIN {grp} g USING (pid) JOIN omega_{s} o USING (grp);""")
        stmts.append(f"""
CREATE OR REPLACE TABLE nb AS
  SELECT fb.bi AS pid, {bat_expr} FROM fb JOIN sk_bow w ON w.pid = fb.bj JOIN pri_bat p ON p.pid = fb.bi GROUP BY fb.bi;
CREATE OR REPLACE TABLE nw AS
  SELECT fb.bj AS pid, {bow_expr} FROM fb JOIN nb b ON b.pid = fb.bi JOIN pri_bow p ON p.pid = fb.bj GROUP BY fb.bj;
CREATE OR REPLACE TABLE shift AS
  SELECT {mlist("(avg(b.{m}) + avg(w.{m})) / 2 AS {m}")}
  FROM fb JOIN cmap c USING (cid) JOIN nb b ON b.pid = fb.bi JOIN nw w ON w.pid = fb.bj WHERE c.competition IN ({ipl});
CREATE OR REPLACE TABLE chg AS SELECT max(abs(a.rv - (b.rv - (SELECT rv FROM shift)))) AS d FROM sk_bat a JOIN nb b USING (pid);
""")
        run("\n".join(stmts))
        d = q("SELECT d FROM chg")[0]["d"]
        run(f"""
CREATE OR REPLACE TABLE sk_bat AS SELECT pid, {mlist("{m} - (SELECT {m} FROM shift) AS {m}")} FROM nb;
CREATE OR REPLACE TABLE sk_bow AS SELECT pid, {mlist("{m} - (SELECT {m} FROM shift) AS {m}")} FROM nw;
""")
        if it % 6 == 0 or it == ITERS - 1:
            log(f"   iter {it}: max change in beta_rv = {d:.5f} runs/ball")
    first = not exists(f"sk_bat_{tag}")
    for s in ("bat", "bow"):
        if first:
            run(f"CREATE TABLE sk_{s}_{tag} AS SELECT * FROM sk_{s}; CREATE TABLE pool_{s}_{tag} AS SELECT * FROM pool_{s}; "
                f"CREATE TABLE omega_{s}_{tag} AS SELECT '{g}' AS gender, * FROM omega_{s}; CREATE TABLE grp_{s}_{tag} AS SELECT * FROM grp_{s};")
        else:
            run(f"INSERT INTO sk_{s}_{tag} SELECT * FROM sk_{s}; INSERT INTO pool_{s}_{tag} SELECT * FROM pool_{s}; "
                f"INSERT INTO omega_{s}_{tag} SELECT '{g}', * FROM omega_{s}; INSERT INTO grp_{s}_{tag} SELECT * FROM grp_{s};")


TIER_CUTS = {"male": (-5.5, -10.5), "female": (-2.5, -12.0)}   # learned batter-pool level (runs/100) separating elite / mid / weak
MIN_LINK_BALLS = 100
RHO_RANGE = (0.25, 1.0)


def build_dp(tag, cutoff):
    """Opponent-adjusted ball values aggregated to player x date x phase (the unit snapshots decay over), then
    translated to the common scale by league tier (see translation())."""
    log(f"daily aggregates {tag}")
    run(f"""
CREATE OR REPLACE TABLE bdp_raw_{tag} AS
  SELECT bl.bi AS pid, bl.gender, bl.cid, bl.date, bl.phase, count(*) AS n, sum(bl.bat_pos) AS pos,
         {mlist("sum(bl.e_{m} + w.{m}) AS a_{m}")}, {mlist("sum(p.{m}) AS p_{m}")}
  FROM bl JOIN sk_bow_{tag} w ON w.pid = bl.bj JOIN pool_bat_{tag} p ON p.cid = bl.cid
  WHERE bl.date <= DATE '{cutoff}' GROUP BY ALL;
CREATE OR REPLACE TABLE wdp_raw_{tag} AS
  SELECT bl.bj AS pid, bl.gender, bl.cid, bl.date, bl.phase, count(*) AS n, sum(bl.legal) AS n_leg,
         {mlist("sum(b.{m} - bl.e_{m}) AS a_{m}", BOWL_METRICS)}, {mlist("sum(p.{m}) AS p_{m}", BOWL_METRICS)}
  FROM bl JOIN sk_bat_{tag} b ON b.pid = bl.bi JOIN pool_bow_{tag} p ON p.cid = bl.cid
  WHERE bl.date <= DATE '{cutoff}' GROUP BY ALL;
CREATE OR REPLACE TABLE tier_{tag} AS
  SELECT c.cid, c.gender, c.competition,
         CASE WHEN p.rv * 100 > CASE c.gender WHEN 'male' THEN {TIER_CUTS['male'][0]} ELSE {TIER_CUTS['female'][0]} END THEN 'elite'
              WHEN p.rv * 100 > CASE c.gender WHEN 'male' THEN {TIER_CUTS['male'][1]} ELSE {TIER_CUTS['female'][1]} END THEN 'mid' ELSE 'weak' END AS tier
  FROM cmap c JOIN pool_bat_{tag} p USING (cid);
""")
    translation(tag, cutoff)
    for side, key, ms, extra in (("bat", "bdp", METRICS, "sum(d.pos) AS pos"), ("bow", "wdp", BOWL_METRICS, "sum(d.n_leg) AS n_leg")):
        cols = ", ".join(f"sum(CASE WHEN t.tier = 'elite' THEN d.a_{m} ELSE r.rho_{m} * (d.a_{m} - d.p_{m}) + d.n * r.pp_{m} END) AS a_{m}" for m in ms)
        pcols = ", ".join(f"sum(CASE WHEN t.tier = 'elite' THEN d.p_{m} ELSE d.n * r.pp_{m} END) AS p_{m}" for m in ms)
        pcols += ", " + ", ".join(f"sum(d.n * r.rho_{m} * r.rho_{m}) AS ni_{m}" for m in ("rv", "dis"))   # information: a weak-tier ball counts rho^2 of an elite ball
        tiercols = "sum(CASE WHEN t.tier = 'elite' THEN d.n ELSE 0 END) AS n_el, sum(CASE WHEN t.tier = 'mid' THEN d.n ELSE 0 END) AS n_md"
        run(f"""
CREATE OR REPLACE TABLE {key}_{tag} AS
  SELECT d.pid, d.gender, d.date, d.phase, sum(d.n) AS n, {extra}, {tiercols}, {cols}, {pcols}
  FROM {key}_raw_{tag} d JOIN tier_{tag} t ON t.cid = d.cid
  LEFT JOIN tr_{side}_{tag} r ON r.gender = d.gender AND r.tier = t.tier
  GROUP BY d.pid, d.gender, d.date, d.phase;""")


def translation(tag, cutoff):
    """League-tier translation to the common scale, estimated from players who appear in a weaker tier AND in the elite tier.
    A player's adjusted value in a weaker tier overstates how he would do against elite opposition: skill transfers with a
    correlation well below 1 (about 0.6 in the data) and the average player of a weak tier is far below the elite average.
        common = P' + rho * (adjusted - tier pool)
      rho = Cov(weak, elite) / signal variance in the weak tier   (signal = observed variance minus sampling noise)
      P'  = mean elite value of the link players - rho * (their mean weak-tier value - tier pool)
    Elite tier is left unchanged.  Estimated per gender and metric (rv/dis pooled across batting and bowling, weighted by link
    counts); falls back to rho=0.6 when fewer than 15 link players."""
    allstats = {}
    for side, key, ms, pool in (("bat", "bdp_raw", METRICS, "pool_bat"), ("bow", "wdp_raw", BOWL_METRICS, "pool_bow")):
        stats = {}
        for m in ms:
            # sampling-noise variance per ball: variance of the raw residual of this metric, per gender
            for g in GENDERS:
                s2 = q(f"SELECT var_pop(e_{m}) AS v FROM bl WHERE gender = '{g}' AND date <= DATE '{cutoff}'")[0]["v"]
                r = q(f"""
WITH blk AS (SELECT d.pid, d.gender, t.tier, sum(d.n) AS n, sum(d.a_{m}) / sum(d.n) AS v
             FROM {key}_{tag} d JOIN tier_{tag} t ON t.cid = d.cid WHERE d.gender = '{g}' GROUP BY ALL),
     tp AS (SELECT t.tier, sum(d.p_{m}) / sum(d.n) AS pool FROM {key}_{tag} d JOIN tier_{tag} t ON t.cid = d.cid WHERE d.gender = '{g}' GROUP BY 1)
SELECT a.tier, count(*) AS nl, covar_samp(a.v, b.v) AS cov, var_samp(a.v) AS va, avg({s2} / a.n) AS noise, avg(a.v) AS ma, avg(b.v) AS mb,
       any_value(tp.pool) AS pool
FROM blk a JOIN blk b ON a.pid = b.pid AND b.tier = 'elite' AND a.tier <> 'elite' JOIN tp ON tp.tier = a.tier
WHERE a.n >= {MIN_LINK_BALLS} AND b.n >= {MIN_LINK_BALLS} GROUP BY a.tier""")
                pools = {x["tier"]: x["pool"] for x in q(f"""SELECT t.tier, sum(d.p_{m}) / sum(d.n) AS pool FROM {key}_{tag} d JOIN tier_{tag} t ON t.cid = d.cid
                                                              WHERE d.gender = '{g}' GROUP BY 1""")}
                for tier in ("mid", "weak"):
                    x = next((y for y in r if y["tier"] == tier), None)
                    pool_t = pools.get(tier, 0.0)
                    if x and x["nl"] >= 15 and x["va"] - x["noise"] > 0:
                        rho = max(RHO_RANGE[0], min(RHO_RANGE[1], x["cov"] / (x["va"] - x["noise"])))
                        pp = x["mb"] - rho * (x["ma"] - pool_t)
                        nl = int(x["nl"])
                    else:
                        rho, pp, nl = 0.6, pool_t - (pools.get("elite", 0.0) - pool_t) * 0.0, 0
                    stats[(g, tier, m)] = (rho, pp, nl)
        allstats[side] = (ms, stats)
    # league quality is a property of the league, not of batting vs bowling: pool the rv/dis estimates of the two sides
    # (weighted by link-player counts) so a noisy side cannot make a weak league look better than the other side says
    for g in GENDERS:
        for tier in ("mid", "weak"):
            for m in BOWL_METRICS:
                parts = [allstats[sd][1].get((g, tier, m)) for sd in ("bat", "bow")]
                parts = [x for x in parts if x and x[2] > 0]
                if parts:
                    w = sum(x[2] for x in parts)
                    pooled = (sum(x[0] * x[2] for x in parts) / w, sum(x[1] * x[2] for x in parts) / w, w)
                    for sd in ("bat", "bow"):
                        allstats[sd][1][(g, tier, m)] = pooled
    for side in ("bat", "bow"):
        ms, stats = allstats[side]
        rows = []
        for g in GENDERS:
            for tier in ("elite", "mid", "weak"):
                row = [g, tier]
                for m in ms:
                    rho, pp, nl = stats.get((g, tier, m), (1.0, 0.0, 0))
                    row += [rho, pp, nl]
                rows.append(row)
        cols = ["gender", "tier"] + [c for m in ms for c in (f"rho_{m}", f"pp_{m}", f"nl_{m}")]
        vals = ", ".join("(" + ", ".join(f"'{v}'" if isinstance(v, str) else repr(v) for v in row) + ")" for row in rows)
        run(f"CREATE OR REPLACE TABLE tr_{side}_{tag} AS SELECT * FROM (VALUES {vals}) v({', '.join(cols)});")
    log(f"translation {tag}: " + "; ".join(
        f"{r['gender']} {r['tier']} rho={r['rho_rv']:.2f} P'={r['pp_rv'] * 100:.1f}" for r in q(f"SELECT * FROM tr_bat_{tag} WHERE tier <> 'elite' ORDER BY gender, tier")))


# ───────────────────────────── stage 2: decayed snapshot sums ─────────────────────────────
def decay(tag, hl, snaps, name):
    """Per player x snapshot sums with exponential recency weights from balls strictly BEFORE the snapshot date.
    Creates {name}_bat(_ph), {name}_bow(_ph), {name}_ext(_ph) and {name}_ap (appearances, matches bowled)."""
    wt = f"power(0.5, date_diff('day', d.date, s.T) / {hl * 365.25})"
    win = lambda tbl: f"(SELECT d.*, s.snap, {wt} AS wt FROM {tbl} d JOIN {snaps} s ON d.date < s.T AND d.date >= s.T - INTERVAL 20 YEAR) x"
    ph_cols = "sum(ne) FILTER (WHERE phase = 'powerplay') AS ne_pp, sum(ne) FILTER (WHERE phase = 'middle') AS ne_mid, sum(ne) FILTER (WHERE phase = 'death') AS ne_d"
    run(f"""
CREATE OR REPLACE TABLE {name}_bat_ph AS
  SELECT pid, snap, phase, sum(wt * n) AS ne, sum(n) AS raw_n, max(date) AS last,
         sum(wt * n_el) AS nel, sum(wt * n_md) AS nmd, max(date) FILTER (WHERE n_el + n_md > 0) AS last_major,
         sum(wt * ni_rv) AS ni_rv, sum(wt * ni_dis) AS ni_dis,
         {mlist("sum(wt * a_{m}) AS a_{m}, sum(wt * p_{m}) AS p_{m}")}, sum(wt * pos) AS pos
  FROM {win("bdp_" + tag)} GROUP BY pid, snap, phase;
CREATE OR REPLACE TABLE {name}_bat AS
  SELECT pid, snap, sum(ne) AS ne, sum(raw_n) AS raw_n, max(last) AS last, sum(nel) AS nel, sum(nmd) AS nmd, max(last_major) AS last_major,
         sum(ni_rv) AS ni_rv, sum(ni_dis) AS ni_dis, {mlist("sum(a_{m}) AS a_{m}, sum(p_{m}) AS p_{m}")}, sum(pos) AS pos, {ph_cols}
  FROM {name}_bat_ph GROUP BY pid, snap;
CREATE OR REPLACE TABLE {name}_bow_ph AS
  SELECT pid, snap, phase, sum(wt * n) AS ne, sum(n) AS raw_n, sum(wt * n_leg) AS ne_leg, max(date) AS last,
         sum(wt * n_el) AS nel, sum(wt * n_md) AS nmd, max(date) FILTER (WHERE n_el + n_md > 0) AS last_major,
         sum(wt * ni_rv) AS ni_rv, sum(wt * ni_dis) AS ni_dis,
         {mlist("sum(wt * a_{m}) AS a_{m}, sum(wt * p_{m}) AS p_{m}", BOWL_METRICS)}
  FROM {win("wdp_" + tag)} GROUP BY pid, snap, phase;
CREATE OR REPLACE TABLE {name}_bow AS
  SELECT pid, snap, sum(ne) AS ne, sum(raw_n) AS raw_n, sum(ne_leg) AS ne_leg, max(last) AS last, sum(nel) AS nel, sum(nmd) AS nmd,
         max(last_major) AS last_major, sum(ni_rv) AS ni_rv, sum(ni_dis) AS ni_dis,
         {mlist("sum(a_{m}) AS a_{m}, sum(p_{m}) AS p_{m}", BOWL_METRICS)}, {ph_cols}
  FROM {name}_bow_ph GROUP BY pid, snap;
CREATE OR REPLACE TABLE {name}_ext_ph AS
  SELECT pid, snap, phase, sum(wt * n_all) AS ne_all, sum(wt * a_ext) AS a_ext FROM {win("ex")} GROUP BY pid, snap, phase;
CREATE OR REPLACE TABLE {name}_ext AS SELECT pid, snap, sum(ne_all) AS ne_all, sum(a_ext) AS a_ext FROM {name}_ext_ph GROUP BY pid, snap;
CREATE OR REPLACE TABLE {name}_ap AS
  SELECT a.pid, a.snap, a.m_app, coalesce(w.m_bowl, 0) AS m_bowl FROM
    (SELECT pid, snap, sum(wt * m) AS m_app FROM {win("app")} GROUP BY pid, snap) a
    LEFT JOIN (SELECT pid, snap, sum(wt * m) AS m_bowl FROM {win("wm")} GROUP BY pid, snap) w USING (pid, snap);
""")


BAT_GRP = "CASE WHEN a.pos / a.ne <= 2.5 THEN 'open' WHEN a.pos / a.ne <= 4.5 THEN 'top' WHEN a.pos / a.ne < 6 THEN 'mid' WHEN a.pos / a.ne <= 7.5 THEN 'fin' ELSE 'tail' END"
BOW_GRP = "CASE WHEN a.ne / nullif(ap.m_bowl, 0) < 8 THEN 'part' WHEN a.ne / nullif(ap.m_bowl, 0) < 16 THEN 'support' ELSE 'front' END"
EXT_K = 1500   # shrink of wide/no-ball extras toward 0 (untuned)


def rating_sql(m, K):
    """Shrunk rating of metric m: decayed adjusted mean pulled toward (window pool level + role offset)."""
    return f"((a.a_{m} + {K} * (a.p_{m} / a.ne + o.{m})) / (a.ne + {K}))"


def joined(name, side, tag):
    """FROM fragment: decayed sums + appearance counts + the role offsets for the player's gender."""
    grp, om = (BAT_GRP, f"omega_bat_{tag}") if side == "bat" else (BOW_GRP, f"omega_bow_{tag}")
    return (f"FROM {name}_{side} a JOIN pmap_g pg ON pg.pid = a.pid LEFT JOIN {name}_ap ap ON ap.pid = a.pid AND ap.snap = a.snap "
            f"JOIN {om} o ON o.gender = pg.gender AND o.grp = {grp}")


PHI_SQL = (f"power(0.5, greatest(0, date_diff('day', coalesce(a.last_major, DATE '1990-01-01'), sp.T) / 365.25 - {GRACE_YEARS}) / {INACT_HALF_YEARS})")


def joined2(nameL, nameS, side, tag, snaps):
    """Long-window sums (a), short-window sums (s), snapshot date (sp), role offsets (o)."""
    return (joined(nameL, side, tag) + f" LEFT JOIN {nameS}_{side} s ON s.pid = a.pid AND s.snap = a.snap JOIN {snaps} sp ON sp.snap = a.snap")


def fexpr(m, P, variant):
    """Rating of metric m.  long: decayed skill shrunk to prior.  form: short-window sample pulls the long estimate (blend by recent
    sample size).  gate: prior + g * (form - prior), g = min(1, recent elite/mid balls / Kg) (a linear ramp).  full: gate also times the
    inactivity factor phi (halves the distance to prior each year after a year with no elite/mid-tier ball)."""
    rL = rating_sql(m, P["K"][m])
    if variant == "long":
        return rL
    Kf = P["Kf"][m]
    rF = f"((coalesce(s.a_{m}, 0) + {Kf} * {rL}) / (coalesce(s.ne, 0) + {Kf}))"
    if variant == "form":
        return rF
    prior = f"(a.p_{m} / a.ne + o.{m})"
    nG = f"(coalesce(s.nel, 0) + {MID_WEIGHT} * coalesce(s.nmd, 0))"
    g = f"least(1.0, {nG} / {P['Kg']})" if P["Kg"] > 0 else "1.0"
    phi = PHI_SQL if variant == "full" else "1.0"
    return f"({prior} + {phi} * {g} * ({rF} - {prior}))"


def prep_maps():
    if not exists("pmap_g"):
        run("CREATE TABLE pmap_g AS SELECT pid, any_value(gender) AS gender FROM (SELECT bi AS pid, gender FROM bl UNION ALL SELECT bj, gender FROM bl) GROUP BY pid;")
    if not exists("people_ids"):
        run(f"CREATE TABLE people_ids AS SELECT * FROM '{DATA}/people.parquet';")
    if not exists("caps"):
        fm = ", ".join(f"'{t}'" for t in FULL_MEMBERS)
        run(f"""CREATE TABLE caps AS
SELECT pm.pid, m.date, year(m.date) AS y,
       CASE WHEN m.match_type IN ('T20', 'IT20') THEN 't20' WHEN m.match_type = 'ODI' THEN 'odi' ELSE 'test' END AS fmt,
       (m.team1 IN ({fm}) AND m.team2 IN ({fm})) AS fm
FROM (SELECT DISTINCT match_id, player_id FROM (SELECT match_id, batter_id AS player_id FROM '{DATA}/deliveries.parquet'
        UNION ALL SELECT match_id, non_striker_id FROM '{DATA}/deliveries.parquet' UNION ALL SELECT match_id, bowler_id FROM '{DATA}/deliveries.parquet')
      WHERE player_id IS NOT NULL) d
JOIN '{DATA}/matches.parquet' m USING (match_id) JOIN pmap pm USING (player_id)
WHERE m.team_type = 'international' AND m.match_type IN ('T20', 'IT20', 'ODI', 'Test');""")


# ───────────────────────────── stage 3: tuning and validation ─────────────────────────────
def target(side, t0, t1, minimum, name, elite_only=False):
    """Test-period mean adjusted metric per player: the common-scale 'truth' (opponent skills from the all-data fit).
    elite_only: only balls in elite-tier leagues (no translation involved); otherwise all balls, translated."""
    ms = METRICS if side == "bat" else BOWL_METRICS
    if elite_only:
        dp = ("bdp_raw_all d JOIN tier_all t ON t.cid = d.cid AND t.tier = 'elite'" if side == "bat" else "wdp_raw_all d JOIN tier_all t ON t.cid = d.cid AND t.tier = 'elite'")
    else:
        dp = "bdp_all d" if side == "bat" else "wdp_all d"
    run(f"""
CREATE OR REPLACE TABLE {name} AS
  SELECT d.pid, sum(d.n) AS nt, {mlist("sum(d.a_{m}) / sum(d.n) AS t_{m}", ms)}, sum(d.n * ({lam_case("d")})) / sum(d.n) AS lam_t
  FROM {dp} WHERE d.date >= DATE '{t0}' AND d.date < DATE '{t1}' GROUP BY d.pid HAVING sum(d.n) >= {minimum};""")


def one_snap(year):
    run(f"CREATE OR REPLACE TABLE sn AS SELECT 'x' AS snap, DATE '{year + 1}-01-01' AS T;")


def tune():
    """Choose half-life per (gender, side) and K per metric by out-of-sample MSE on the tuning folds only."""
    prep_maps()
    results = {}
    for side, ms in (("bat", METRICS), ("bow", BOWL_METRICS)):
        acc = {g: {hl: {m: {k: 0.0 for k in K_GRID} for m in ms} for hl in HALF_LIVES} for g in GENDERS}
        for ty in TUNE_FOLDS:
            tag = f"f{ty}"
            one_snap(ty)
            target(side, f"{ty + 1}-01-01", f"{ty + 3}-01-01", 60, "tgt", elite_only=True)
            for hl in HALF_LIVES:
                decay(tag, hl, "sn", "tn")
                for g in GENDERS:
                    cols = []
                    for m in ms:
                        for k in K_GRID:
                            cols.append(f"sum(t.nt * pow({rating_sql(m, k)} - t.t_{m}, 2)) / sum(t.nt) AS s_{m}_{k}")
                        cols.append(f"(sum(t.nt * t.t_{m} * t.t_{m}) - pow(sum(t.nt * t.t_{m}), 2) / sum(t.nt)) / sum(t.nt) AS v_{m}")
                    r = q(f"SELECT {', '.join(cols)} {joined('tn', side, tag)} JOIN tgt t ON t.pid = a.pid WHERE pg.gender = '{g}' AND a.ne > 0")[0]
                    for m in ms:
                        for k in K_GRID:
                            acc[g][hl][m][k] += r[f"s_{m}_{k}"] / r[f"v_{m}"] / len(TUNE_FOLDS)
        for g in GENDERS:
            best = None
            for hl in HALF_LIVES:
                ks = {m: min(K_GRID, key=lambda k: acc[g][hl][m][k]) for m in ms}
                score = sum(acc[g][hl][m][ks[m]] for m in ms) / len(ms)
                if best is None or score < best[0]:
                    best = (score, hl, ks)
            results[f"{g}_{side}"] = {"half_life_years": best[1], "K": best[2], "normalised_mse": best[0],
                                      "grid": {str(hl): {m: {str(k): acc[g][hl][m][k] for k in K_GRID} for m in ms} for hl in HALF_LIVES}}
            log(f"tuned {g} {side}: half-life {best[1]}y, K {best[2]}, normalised MSE {best[0]:.4f}")
    json.dump(results, open(DATA / "tuned_params.json", "w"), indent=1)
    return results


def tune_form(params):
    """Stage 2/3 of tuning (long-run params fixed from tune()): short-window current-form blend (half-life, K per metric), then the
    elite-exposure gate strength Kg.  Everything is scored on the tuning folds only, against elite-tier targets."""
    prep_maps()
    for side, ms in (("bat", METRICS), ("bow", BOWL_METRICS)):
        accF = {g: {hs: {m: {k: 0.0 for k in K_GRID} for m in ms} for hs in HL_SHORT} for g in GENDERS}
        accL = {g: {m: 0.0 for m in ms} for g in GENDERS}
        for ty in TUNE_FOLDS:
            tag = f"f{ty}"
            one_snap(ty)
            target(side, f"{ty + 1}-01-01", f"{ty + 3}-01-01", 60, "tgt", elite_only=True)
            for g in GENDERS:
                decay(tag, params[f"{g}_{side}"]["half_life_years"], "sn", f"tL_{g}")
            for hs in HL_SHORT:
                decay(tag, hs, "sn", "tS")
                for g in GENDERS:
                    P = params[f"{g}_{side}"]
                    cols = []
                    for m in ms:
                        rL = rating_sql(m, P["K"][m])
                        cols.append(f"sum(t.nt * pow({rL} - t.t_{m}, 2)) / sum(t.nt) AS l_{m}")
                        cols.append(f"(sum(t.nt * t.t_{m} * t.t_{m}) - pow(sum(t.nt * t.t_{m}), 2) / sum(t.nt)) / sum(t.nt) AS v_{m}")
                        for k in K_GRID:
                            cols.append(f"sum(t.nt * pow((coalesce(s.a_{m}, 0) + {k} * {rL}) / (coalesce(s.ne, 0) + {k}) - t.t_{m}, 2)) / sum(t.nt) AS f_{m}_{k}")
                    r = q(f"SELECT {', '.join(cols)} {joined2(f'tL_{g}', 'tS', side, tag, 'sn')} JOIN tgt t ON t.pid = a.pid WHERE pg.gender = '{g}' AND a.ne > 0")[0]
                    for m in ms:
                        if hs == HL_SHORT[0]:
                            accL[g][m] += r[f"l_{m}"] / r[f"v_{m}"] / len(TUNE_FOLDS)
                        for k in K_GRID:
                            accF[g][hs][m][k] += r[f"f_{m}_{k}"] / r[f"v_{m}"] / len(TUNE_FOLDS)
        for g in GENDERS:
            P = params[f"{g}_{side}"]
            best = None
            for hs in HL_SHORT:
                ks = {m: min(K_GRID, key=lambda k: accF[g][hs][m][k]) for m in ms}
                score = sum(accF[g][hs][m][ks[m]] for m in ms) / len(ms)
                if best is None or score < best[0]:
                    best = (score, hs, ks)
            P["form_argmin"] = {"short_half_life_years": best[1], "Kf": best[2], "normalised_mse": best[0]}
            # The data say recent form adds essentially nothing beyond long-run skill (the argmin puts almost no weight on the short
            # window), but the game needs current-season sensitivity.  Policy: fixed ~2-season window, and the smallest Kf (largest form
            # weight) whose tuning-fold error is within FORM_TOLERANCE of the best at that window.
            hs = FORM_HALF_LIFE
            ks = {}
            for m in ms:
                bestk = min(accF[g][hs][m][k] for k in K_GRID)
                ks[m] = min(k for k in K_GRID if accF[g][hs][m][k] <= bestk * FORM_TOLERANCE)
            P["short_half_life_years"], P["Kf"] = hs, ks
            P["normalised_mse_long"] = sum(accL[g].values()) / len(ms)
            P["normalised_mse_form"] = sum(accF[g][hs][m][ks[m]] for m in ms) / len(ms)
            best = (P["normalised_mse_form"], hs, ks)
            P["form_grid"] = {str(hs): {m: {str(k): accF[g][hs][m][k] for k in K_GRID} for m in ms} for hs in HL_SHORT}
            log(f"tuned form {g} {side}: short half-life {best[1]}y, Kf {best[2]}; normalised MSE long {P['normalised_mse_long']:.4f} -> form {best[0]:.4f}")
        for g in GENDERS:
            params[f"{g}_{side}"]["Kg"] = 0     # round 3: no hard exposure gate; thin elite exposure now shows up as a wide posterior SD
    json.dump(params, open(DATA / "tuned_params.json", "w"), indent=1)
    return params


def wstats(pred, tgt, w, frm):
    """Weighted MSE, correlation and R2 against a constant, over `frm`."""
    r = q(f"""SELECT sum({w}) AS sw, sum({w} * ({pred} - {tgt}) ^ 2) AS sse, sum({w} * {pred}) AS sp, sum({w} * {tgt}) AS st,
                     sum({w} * {pred} * {pred}) AS spp, sum({w} * {tgt} * {tgt}) AS stt, sum({w} * {pred} * {tgt}) AS spt, count(*) AS n {frm}""")[0]
    sw = r["sw"]
    mp, mt = r["sp"] / sw, r["st"] / sw
    vp, vt, cov = r["spp"] / sw - mp * mp, r["stt"] / sw - mt * mt, r["spt"] / sw - mp * mt
    return {"players": int(r["n"]), "weight_balls": sw, "mse": r["sse"] / sw, "target_var": vt,
            "corr": cov / math.sqrt(vp * vt) if vp > 0 and vt > 0 else None, "r2_vs_constant": 1 - (r["sse"] / sw) / vt}


def game_ratings_table():
    if exists("game"):
        return
    rows = []
    for g, path in RATINGS.items():
        for p in json.load(open(path)):
            r, o = p["ratings"], p["overalls"]
            rows.append([p["espnId"], g, o["battingOvr"], o["bowlingOvr"], o["overall"], r["battingIQ"], r["timing"], r["power"], r["running"],
                         r["wicketTaking"], r["economy"], r["accuracy"], r["clutch"], p["role"], int(bool(p.get("isInternational")))])
    path = WORK / "game.csv"
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["cricinfo_id", "gender", "battingOvr", "bowlingOvr", "overall", "battingIQ", "timing", "power", "running",
                    "wicketTaking", "economy", "accuracy", "clutch", "role", "intl"])
        w.writerows(rows)
    run(f"CREATE TABLE game AS SELECT * FROM read_csv('{path}', header=true);")


def ols(xs, ys, ws):
    """Weighted least squares with intercept in plain Python; returns coefficients and R2."""
    k = len(xs[0]) + 1
    A = [[0.0] * k for _ in range(k)]
    b = [0.0] * k
    for x, y, w in zip(xs, ys, ws):
        v = [1.0] + list(x)
        for i in range(k):
            b[i] += w * v[i] * y
            for j in range(k):
                A[i][j] += w * v[i] * v[j]
    M = [A[i] + [b[i]] for i in range(k)]
    for i in range(k):
        piv = max(range(i, k), key=lambda r: abs(M[r][i]))
        M[i], M[piv] = M[piv], M[i]
        for r in range(k):
            if r != i:
                f = M[r][i] / M[i][i]
                M[r] = [a - f * c for a, c in zip(M[r], M[i])]
    beta = [M[i][k] / M[i][i] for i in range(k)]
    sw = sum(ws)
    my = sum(w * y for w, y in zip(ws, ys)) / sw
    sst = sum(w * (y - my) ** 2 for w, y in zip(ws, ys))
    sse = sum(w * (y - (beta[0] + sum(c * xi for c, xi in zip(beta[1:], x)))) ** 2 for x, y, w in zip(xs, ys, ws))
    return beta, 1 - sse / sst


def corr_mse(pred, ys, ws):
    sw = sum(ws)
    mp = sum(w * p for w, p in zip(ws, pred)) / sw
    my = sum(w * y for w, y in zip(ws, ys)) / sw
    vp = sum(w * (p - mp) ** 2 for w, p in zip(ws, pred)) / sw
    vy = sum(w * (y - my) ** 2 for w, y in zip(ws, ys)) / sw
    cv = sum(w * (p - mp) * (y - my) for w, p, y in zip(ws, pred, ys)) / sw
    return {"corr": cv / math.sqrt(vp * vy), "mse": sum(w * (p - y) ** 2 for w, p, y in zip(ws, pred, ys)) / sw, "players": len(ys)}


def age_delta(C, a0, a1):
    """C(a1) - C(a0), linear interpolation of the cumulative curve, clamped to ages 18..38."""
    def at(a):
        a = max(18.0, min(37.999, a))
        lo = int(math.floor(a))
        return C[lo] + (a - lo) * (C[lo + 1] - C[lo])
    return at(a1) - at(a0)


REPO = ROOT.parent.parent
HAND_TUNED_SHA = "d41dcfe"     # initial commit: 50 hand-tuned IPL players (not stats-derived; written for the 2025 IPL)
MARCH_2026_SHA = "e714d26"     # last stats-derived game ratings before the Oct 2026 refresh (ESPN career stats to ~26 Mar 2026)
BAT_COMPS = ["battingIQ", "timing", "power", "running"]
BOWL_COMPS = ["wicketTaking", "economy", "accuracy"]
ALL_COMPS = ["battingIQ", "timing", "power", "running", "wicketTaking", "economy", "accuracy", "clutch"]


def git_show(sha, path):
    p = subprocess.run(["git", "-C", str(REPO), "show", f"{sha}:{path}"], capture_output=True, text=True)
    return p.stdout if p.returncode == 0 else ""


def historical_game_tables():
    """Read-only extraction of older game ratings from git history -> tables hand (pre-2025, hand-tuned) and game_mar (Mar 2026)."""
    if exists("hand") and exists("game_mar"):
        return
    names = {}
    for p in json.load(open(ESPN)):
        pr = p["profile"]
        if pr.get("gender") == "M":
            for n in (pr.get("longName"), pr.get("name")):
                if n:
                    names.setdefault(n.lower(), pr["espnId"])
    rows, miss = [], []
    txt = git_show(HAND_TUNED_SHA, "packages/ratings/src/real-players.ts")
    for m in re.finditer(r'\["([^"]+)",\s*(\d+),\s*"[^"]*",\s*"[^"]*",\s*((?:\d+,\s*){8})"', txt):
        nm, vals = m.group(1), [int(x) for x in re.findall(r"\d+", m.group(3))]
        cid = names.get(nm.lower())
        (rows if cid else miss).append([cid, *vals] if cid else nm)
    path = WORK / "hand.csv"
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["cricinfo_id"] + ALL_COMPS)
        w.writerows(rows)
    run(f"CREATE OR REPLACE TABLE hand AS SELECT * FROM read_csv('{path}', header=true);")
    log(f"hand-tuned pre-2025 list: {len(rows)} matched, {len(miss)} unmatched")
    txt = git_show(MARCH_2026_SHA, "packages/ratings/src/all-players.ts")
    pat = re.compile(r'id: "espn_(\d+)".*?ratings: \{ ' + ", ".join(rf"{c}: (\d+)" for c in ALL_COMPS) + r" \}", re.S)
    rows = [[m.group(1)] + [m.group(i) for i in range(2, 10)] for m in pat.finditer(txt)]
    path = WORK / "game_mar.csv"
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["cricinfo_id"] + ALL_COMPS)
        w.writerows(rows)
    run(f"CREATE OR REPLACE TABLE game_mar AS SELECT * FROM read_csv('{path}', header=true);")
    log(f"March-2026 game ratings: {len(rows)} players")


def seasons_table(tag, snaps, out):
    """Proven seasons per player x snapshot: a year earns up to 1 credit from elite/mid-tier volume (balls/120, batting or bowling, whichever is larger)
    or from international T20 caps (weighted caps/6, full-member match = 1, associate = 0.5), whichever is larger; seasons = sum of credits before the snapshot."""
    run(f"""
CREATE OR REPLACE TABLE {out} AS
WITH mb AS (SELECT pid, snap, year(date) AS y, sum(n_el + n_md) AS nb FROM bdp_{tag} d JOIN {snaps} s ON d.date < s.T GROUP BY ALL),
     mw AS (SELECT pid, snap, year(date) AS y, sum(n_el + n_md) AS nb FROM wdp_{tag} d JOIN {snaps} s ON d.date < s.T GROUP BY ALL),
     yb AS (SELECT pid, snap, y, max(nb) AS nb FROM (SELECT * FROM mb UNION ALL SELECT * FROM mw) GROUP BY ALL),
     ic AS (SELECT c.pid, s.snap, c.y, sum(CASE WHEN c.fm THEN 1.0 ELSE 0.5 END) AS wc FROM caps c JOIN {snaps} s ON c.date < s.T WHERE c.fmt = 't20' GROUP BY ALL),
     k AS (SELECT coalesce(yb.pid, ic.pid) AS pid, coalesce(yb.snap, ic.snap) AS snap, coalesce(yb.y, ic.y) AS y,
                  least(1.0, greatest(coalesce(yb.nb, 0) / {SEASON_BALLS}.0, coalesce(ic.wc, 0) / {SEASON_CAPS})) AS credit
           FROM yb FULL JOIN ic ON yb.pid = ic.pid AND yb.snap = ic.snap AND yb.y = ic.y)
SELECT pid, snap, sum(credit) AS seasons FROM k GROUP BY pid, snap;""")


def pull(x, prior, w):
    """Proven pull: a rating above its role prior may sit only w of the way above it (w = min(1, seasons / 5)); below the prior it is untouched."""
    return f"(CASE WHEN {x} > {prior} THEN {prior} + {w} * ({x} - {prior}) ELSE {x} END)"


def proven_rows(g, side, P, nameL, nameS, tag, snaps, tgt_table, ssn):
    mean = f"(({fexpr('rv', P, 'full')} + {lam_eff('a')} * {fexpr('dis', P, 'full')}) * 100)"
    prior = f"(((a.p_rv / a.ne + o.rv) + {lam_eff('a')} * (a.p_dis / a.ne + o.dis)) * 100)"
    rows = q(f"SELECT {mean} AS v, {sd_sql(P, g)} AS sd, {prior} AS pr, coalesce(z.seasons, 0) AS ss, ((t.t_rv + t.lam_t * t.t_dis) * 100) AS y, t.nt AS w "
             f"{joined2(nameL, nameS, side, tag, snaps)} LEFT JOIN {ssn} z ON z.pid = a.pid AND z.snap = a.snap JOIN {tgt_table} t ON t.pid = a.pid "
             f"WHERE pg.gender = '{g}' AND a.ne > 0")
    return [(r["v"], r["sd"], r["pr"], r["ss"], r["y"], r["w"]) for r in rows]


def eval_proven(rows, k, N):
    """Accuracy of (a) the raw mean, (b) mean - k SD, (c) conservative rating with the proven pull, against the realised target."""
    def stat(xs):
        top = sorted(xs, key=lambda t: -t[0])[:N]
        sw = sum(t[2] for t in top)
        c = corr_mse([t[0] for t in xs], [t[1] for t in xs], [t[2] for t in xs])
        return {"corr": c["corr"], "mse": c["mse"], "top_realised": sum(t[1] * t[2] for t in top) / sw, "players": len(xs)}
    mean = [(r[0], r[4], r[5]) for r in rows]
    cons = [(r[0] - k * r[1], r[4], r[5]) for r in rows]
    def pull_py(x, pr, ss):
        return pr + min(1.0, ss / PROVEN_SEASONS) * (x - pr) if x > pr else x
    prov = [(pull_py(r[0] - k * r[1], r[2], r[3]), r[4], r[5]) for r in rows]
    return {"mean": stat(mean), "conservative": stat(cons), "proven": stat(prov)}


def proven_effect_tuning(params):
    """Report-only: accuracy of the proven pull on the 2021-22 and 2023-24 tuning folds (averaged)."""
    prep_maps()
    noise_sd()
    for side in ("bat", "bow"):
        for ty in TUNE_FOLDS:
            tag = f"f{ty}"
            one_snap(ty)
            target(side, f"{ty + 1}-01-01", f"{ty + 3}-01-01", 60, f"tg_{side}", elite_only=True)
            seasons_table(tag, "sn", "ssn_t")
            for g in GENDERS:
                P = params[f"{g}_{side}"]
                decay(tag, P["half_life_years"], "sn", "pL")
                decay(tag, P["short_half_life_years"], "sn", "pS")
                ev = eval_proven(proven_rows(g, side, P, "pL", "pS", tag, "sn", f"tg_{side}", "ssn_t"), P["k"], TOP_N[g])
                P.setdefault("proven_effect_folds", {})[str(ty)] = ev
    json.dump(params, open(DATA / "tuned_params.json", "w"), indent=1)
    return params


NOISE = {}                     # per-ball SD of each residual metric, per gender (the 'sigma' of the normal likelihood)
K_CONS_GRID = [0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0]   # conservatism: rating = mean - k * SD
K_POLICY_MIN = 0.5
K_POLICY_MAX = 1.0          # cap: the tuned k is noisy (it picks a top-N), so never more than 1 SD of conservatism
WICKET_PRICING = os.environ.get("RATINGS_WICKET_PRICING", "state")   # 'state': price a dismissal by the run value of a wicket at that over and wickets-down; 'phase': one constant per phase
K_AGE = 150                 # pseudo-pairs shrinking each age's year-to-year change toward zero (thin ages, mostly 35+, get little curve)
FULL_MEMBERS = ["Afghanistan", "Australia", "Bangladesh", "England", "India", "Ireland", "New Zealand", "Pakistan", "South Africa", "Sri Lanka", "West Indies", "Zimbabwe"]
SEASON_BALLS = 120          # elite/mid-tier balls (batting or bowling) in a year that make it a full 'proven' season
SEASON_CAPS = 6.0           # weighted T20I caps in a year that make it a full proven season (full-member match = 1, associate = 0.5)
PROVEN_SEASONS = 5.0        # seasons for a fully proven rating (weight = min(1, seasons / 5))
TOP_N = {"male": 25, "female": 12}


def noise_sd():
    if not NOISE:
        for g in GENDERS:
            r = q(f"SELECT {mlist('sqrt(var_pop(e_{m})) AS s_{m}')} FROM bl WHERE gender = '{g}'")[0]
            NOISE[g] = {m: r[f"s_{m}"] for m in METRICS}
    return NOISE


def sd_sql(P, g, variant="full"):
    """Posterior SD of the composite value (runs per 100 balls), explicit normal-normal form.
    Prior: N(mu0, tau_m^2) with tau_m^2 = sigma_m^2 / K_m (so the tuned shrinkage K is a prior SD).  Likelihood: each ball is N(skill, sigma_m^2),
    weighted by recency and discounted by rho^2 when it came from a weaker league tier (info = sum w * n * rho^2).
    Posterior SD_m = sigma_m / sqrt(K_m + info_m).  The inactivity factor phi scales the deviation from the prior, so
    variance = phi^2 SD_m^2 + (1 - phi^2) tau_m^2.  Composite SD treats rv and dis as independent: sqrt(SD_rv^2 + lam^2 SD_dis^2)."""
    sig = noise_sd()[g]
    K = P["K"]
    phi = PHI_SQL if variant == "full" else "1.0"

    def var(m):
        post = f"(pow({sig[m]}, 2) / ({K[m]} + coalesce(a.ni_{m}, 0)))"
        tau2 = sig[m] ** 2 / K[m]
        return f"(pow({phi}, 2) * {post} + (1 - pow({phi}, 2)) * {tau2})"
    return f"(100 * sqrt({var('rv')} + pow({lam_eff('a')}, 2) * {var('dis')}))"


def eval_k(rows, N):
    """rows: (mean, sd, target, weight).  Returns per-k: realised target of the top-N by mean - k*sd, plus corr / MSE of the conservative rating."""
    out = {}
    for k in K_CONS_GRID:
        xs = [(r[0] - k * r[1], r[2], r[3]) for r in rows]
        top = sorted(xs, key=lambda t: -t[0])[:N]
        sw = sum(t[2] for t in top)
        res = {"top_realised": sum(t[1] * t[2] for t in top) / sw}
        c = corr_mse([t[0] for t in xs], [t[1] for t in xs], [t[2] for t in xs])
        res.update(corr=c["corr"], mse=c["mse"])
        out[k] = res
    return out


def tune_k(params):
    """Choose conservatism k per (gender, side) on the tuning folds: the k whose top-N by (mean - k SD) realises the best elite-league
    value in the following two years (i.e. the best selection), not the k that minimises squared error (that is always k = 0)."""
    prep_maps()
    noise_sd()
    for side in ("bat", "bow"):
        acc = {g: {k: {"top_realised": 0.0, "corr": 0.0, "mse": 0.0} for k in K_CONS_GRID} for g in GENDERS}
        for ty in TUNE_FOLDS:
            tag = f"f{ty}"
            one_snap(ty)
            target(side, f"{ty + 1}-01-01", f"{ty + 3}-01-01", 60, "tgt", elite_only=True)
            for g in GENDERS:
                P = params[f"{g}_{side}"]
                decay(tag, P["half_life_years"], "sn", "kL")
                decay(tag, P["short_half_life_years"], "sn", "kS")
                mean = f"(({fexpr('rv', P, 'full')} + {lam_eff('a')} * {fexpr('dis', P, 'full')}) * 100)"
                rows = q(f"SELECT {mean} AS v, {sd_sql(P, g)} AS sd, ((t.t_rv + t.lam_t * t.t_dis) * 100) AS y, t.nt AS w "
                         f"{joined2('kL', 'kS', side, tag, 'sn')} JOIN tgt t ON t.pid = a.pid WHERE pg.gender = '{g}' AND a.ne > 0")
                ev = eval_k([(r["v"], r["sd"], r["y"], r["w"]) for r in rows], TOP_N[g])
                for k in K_CONS_GRID:
                    for key in ("top_realised", "corr", "mse"):
                        acc[g][k][key] += ev[k][key] / len(TUNE_FOLDS)
        for g in GENDERS:
            P = params[f"{g}_{side}"]
            best = max(K_CONS_GRID, key=lambda k: (round(acc[g][k]["top_realised"], 3), -k))
            P["k_validated"] = best
            P["k"] = min(max(best, K_POLICY_MIN), K_POLICY_MAX)    # policy floor: validation is indifferent to small k, but thin records should be visibly discounted
            P["k_curve"] = {str(k): acc[g][k] for k in K_CONS_GRID}
            log(f"tuned k {g} {side}: k={best} (top-{TOP_N[g]} realised value {acc[g][best]['top_realised']:.2f} vs k=0 {acc[g][0.0]['top_realised']:.2f}; corr {acc[g][best]['corr']:.3f} vs {acc[g][0.0]['corr']:.3f})")
    json.dump(params, open(DATA / "tuned_params.json", "w"), indent=1)
    return params


def fold_frames(g, side, nameL, nameS, tag, snaps, tgt_table):
    """FROM/WHERE fragment joining the snapshot sums, target, and people ids for one gender and side."""
    return (f"{joined2(nameL, nameS, side, tag, snaps)} JOIN {tgt_table} t ON t.pid = a.pid JOIN pmap pm ON pm.pid = a.pid "
            f"JOIN people_ids pi ON pi.cricsheet_id = pm.player_id WHERE pg.gender = '{g}' AND a.ne > 0")


def validate(params, curves):
    """Fit through 2024, predict 2025-26 (and, separately, fit through 26 Mar 2026 and predict the rest of 2026)."""
    prep_maps()
    game_ratings_table()
    historical_game_tables()
    tag = "f2024"
    one_snap(2024)
    seasons_table(tag, "sn", "ssn_h")
    out = {}
    dob = {int(r["cricinfo_id"]): r["dob"] for r in q("SELECT cricinfo_id, strftime(dob, '%Y-%m-%d') AS dob FROM prof WHERE dob IS NOT NULL")}
    # naive benchmark: context-adjusted career value per ball with NO opponent/league adjustment, no decay, mild shrink (K=300)
    for side, pc, sg in (("bat", "bi", 1), ("bow", "bj", -1)):
        run(f"""CREATE OR REPLACE TABLE nv_{side} AS
                SELECT {pc} AS pid, count(*) FILTER (WHERE date < DATE '2025-01-01') AS n_pre,
                       {sg} * sum(e_rv + {lam_case("bl")} * e_dis) FILTER (WHERE date < DATE '2025-01-01') AS s_pre,
                       count(*) AS n_all, {sg} * sum(e_rv + {lam_case("bl")} * e_dis) AS s_all
                FROM bl GROUP BY {pc};""")
    for g in GENDERS:
        out[g] = {}
        for side in ("bat", "bow"):
            P = params[f"{g}_{side}"]
            hl = P["half_life_years"]
            decay(tag, hl, "sn", f"vL_{g}_{side}")
            decay(tag, P["short_half_life_years"], "sn", f"vS_{g}_{side}")
            target(side, "2025-01-01", "2027-01-01", 100, "tgt", elite_only=True)
            tgt = "((t.t_rv + t.lam_t * t.t_dis) * 100)"
            pv = {v: f"(({fexpr('rv', P, v)} + {lam_eff('a')} * {fexpr('dis', P, v)}) * 100)" for v in ("long", "form", "full")}
            frm = fold_frames(g, side, f"vL_{g}_{side}", f"vS_{g}_{side}", tag, "sn", "tgt")
            gfrm = frm.replace("WHERE", "JOIN game gm ON gm.cricinfo_id = pi.cricinfo_id AND gm.gender = pg.gender WHERE")
            ovr = "gm.battingOvr" if side == "bat" else "gm.bowlingOvr"
            res = {"params": {k: P[k] for k in ("half_life_years", "short_half_life_years", "K", "Kf", "Kg")}}
            for v in pv:
                res[f"new_{v}"] = wstats(pv[v], tgt, "t.nt", frm)
            res["new_rating"] = res["new_full"]
            pred = pv["full"]
            res["prior_only_baseline"] = wstats(f"(((a.p_rv / a.ne + o.rv) + {lam_eff('a')} * (a.p_dis / a.ne + o.dis)) * 100)", tgt, "t.nt", frm)
            res["game_overall_rating"] = wstats(ovr, tgt, "t.nt", gfrm)
            res["new_rating_same_players_as_game"] = wstats(pred, tgt, "t.nt", gfrm)
            nfrm = frm.replace("WHERE", f"JOIN nv_{side} nv ON nv.pid = a.pid WHERE")
            res["naive_career_to_2024"] = wstats("(nv.s_pre / (nv.n_pre + 300.0) * 100)", tgt, "t.nt", nfrm)
            res["naive_career_incl_test_LOOKAHEAD"] = wstats("(nv.s_all / (nv.n_all + 300.0) * 100)", tgt, "t.nt", nfrm)
            comp = ["battingIQ", "timing", "power", "running", "clutch"] if side == "bat" else ["wicketTaking", "economy", "accuracy", "clutch"]
            rows = q(f"SELECT {', '.join('gm.' + c for c in comp)}, {tgt} AS y, t.nt AS w {gfrm}")
            if rows:
                beta, r2 = ols([[r[c] for c in comp] for r in rows], [r["y"] for r in rows], [r["w"] for r in rows])
                res["game_components_ols_in_sample"] = {"r2": r2, "corr": math.sqrt(max(r2, 0)), "coefficients": dict(zip(["intercept"] + comp, beta))}
            if g == "male":
                hc = BAT_COMPS if side == "bat" else BOWL_COMPS
                hfrm = frm.replace("WHERE", "JOIN hand hd ON hd.cricinfo_id = pi.cricinfo_id WHERE")
                hexpr = "(" + " + ".join(f"hd.{c}" for c in hc) + f") / {len(hc)}.0"
                res["pre2025_hand_tuned_game"] = {"hand_tuned_mean_of_components": wstats(hexpr, tgt, "t.nt", hfrm),
                                                  "new_rating_same_players": wstats(pred, tgt, "t.nt", hfrm)}
            target(side, "2025-01-01", "2027-01-01", 100, "tgt3")
            frm3, gfrm3 = frm.replace("tgt t", "tgt3 t"), gfrm.replace("tgt t", "tgt3 t")
            res["all_leagues_target"] = {"new_rating": wstats(pred, tgt, "t.nt", frm3), "game_overall_rating": wstats(ovr, tgt, "t.nt", gfrm3),
                                         "new_long": wstats(pv["long"], tgt, "t.nt", frm3),
                                         "naive_career_to_2024": wstats("(nv.s_pre / (nv.n_pre + 300.0) * 100)", tgt, "t.nt", frm3.replace("WHERE", f"JOIN nv_{side} nv ON nv.pid = a.pid WHERE"))}
            pc = "bi" if side == "bat" else "bj"
            sg = "1" if side == "bat" else "-1"
            run(f"""CREATE OR REPLACE TABLE tgt2 AS
                    SELECT {pc} AS pid, count(*) AS nt, {sg} * avg(e_rv) AS t_rv, {sg} * avg(e_dis) AS t_dis,
                           sum({lam_case("bl")}) / count(*) AS lam_t
                    FROM bl JOIN cmap c USING (cid) WHERE c.competition IN ({anchor_sql(g)}) AND date >= DATE '2025-01-01' GROUP BY {pc} HAVING count(*) >= 100;""")
            frm2, gfrm2 = frm.replace("tgt t", "tgt2 t"), gfrm.replace("tgt t", "tgt2 t")
            res["raw_ipl_target"] = {"new_rating": wstats(pred, tgt, "t.nt", frm2), "game_overall_rating": wstats(ovr, tgt, "t.nt", gfrm2),
                                     "new_rating_same_players_as_game": wstats(pred, tgt, "t.nt", gfrm2)}
            rows = q(f"SELECT {pred} AS v, {tgt} AS y, t.nt AS w, a.ne AS ne, pi.cricinfo_id AS cid {frm}")
            variants = {"none": None, "raw_curve_K0": build_curve(AGE_META[g][side], 0), f"shrunk_K{K_AGE}": curves[g][side], "heavily_shrunk_K600": build_curve(AGE_META[g][side], 600)}
            agev = {}
            for vn, cur in variants.items():
                pr_, ys, ws = [], [], []
                for r in rows:
                    d = dob.get(int(r["cid"])) if r["cid"] else None
                    if not d:
                        continue
                    age_t = 2025.0 - (int(d[:4]) + (int(d[5:7]) - 0.5) / 12)
                    delta = age_delta(cur, age_t - 1.44 * hl, age_t + 1.0) if cur else 0.0
                    pr_.append(r["v"] + r["ne"] / (r["ne"] + P["K"]["rv"]) * delta)
                    ys.append(r["y"])
                    ws.append(r["w"])
                agev[vn] = corr_mse(pr_, ys, ws)
            res["age_projection_variants"] = agev
            res["age_projection"] = {"without_age": agev["none"], "with_age": agev[f"shrunk_K{K_AGE}"]}
            rows = q(f"SELECT {pred} AS v, {sd_sql(P, g)} AS sd, {tgt} AS y, t.nt AS w {frm}")
            ev = eval_k([(r["v"], r["sd"], r["y"], r["w"]) for r in rows], TOP_N[g])
            res["k_tuned"] = P["k"]
            res["conservatism_holdout"] = {str(k): v for k, v in ev.items()}
            res["proven_effect"] = eval_proven(proven_rows(g, side, P, f"vL_{g}_{side}", f"vS_{g}_{side}", tag, "sn", "tgt", "ssn_h"), P["k"], TOP_N[g])
            out[g][side] = res
            log(f"validation {g} {side}: long {res['new_long']['corr']:.3f} form {res['new_form']['corr']:.3f} "
                f"full {res['new_full']['corr']:.3f}; game(look-ahead) {res['game_overall_rating']['corr']:.3f}")
    out["external_march_2026"] = validate_external(params)
    json.dump(out, open(DATA / "ratings_validation.json", "w"), indent=1)
    return out


def validate_external(params):
    """The game's last stats-derived ratings before the Oct-2026 refresh (committed 26 Mar 2026) vs the new model fit through
    26 Mar 2026, both predicting elite-league per-ball value from 27 Mar 2026 on.  Men only (the committed all-players file is men's)."""
    run("CREATE OR REPLACE TABLE sn2 AS SELECT 'x' AS snap, DATE '2026-03-27' AS T;")
    tag = "fm26"
    seasons_table(tag, "sn2", "ssn_x")
    out = {}
    for side in ("bat", "bow"):
        P = params[f"male_{side}"]
        decay(tag, P["half_life_years"], "sn2", f"xL_{side}")
        decay(tag, P["short_half_life_years"], "sn2", f"xS_{side}")
        target(side, "2026-03-27", "2027-01-01", 60, "tgt")
        tgt = "((t.t_rv + t.lam_t * t.t_dis) * 100)"
        frm = fold_frames("male", side, f"xL_{side}", f"xS_{side}", tag, "sn2", "tgt")
        gm = frm.replace("WHERE", "JOIN game_mar gm ON gm.cricinfo_id = pi.cricinfo_id WHERE")
        comps = BAT_COMPS if side == "bat" else BOWL_COMPS
        mean_expr = "(" + " + ".join(f"gm.{c}" for c in comps) + f") / {len(comps)}.0"
        r = {"half_life_years": P["half_life_years"]}
        for v in ("long", "form", "full"):
            pv = f"(({fexpr('rv', P, v)} + {lam_eff('a')} * {fexpr('dis', P, v)}) * 100)"
            r[f"new_{v}"] = wstats(pv, tgt, "t.nt", frm)
            if v == "full":
                r["new_full_same_players_as_game"] = wstats(pv, tgt, "t.nt", gm)
                rows = q(f"SELECT {pv} AS v, {sd_sql(P, 'male')} AS sd, {tgt} AS y, t.nt AS w {frm}")
                r["conservatism"] = {str(k): v_ for k, v_ in eval_k([(x["v"], x["sd"], x["y"], x["w"]) for x in rows], TOP_N["male"]).items()}
                r["k_tuned"] = P["k"]
                r["proven_effect"] = eval_proven(proven_rows("male", side, P, f"xL_{side}", f"xS_{side}", tag, "sn2", "tgt", "ssn_x"), P["k"], TOP_N["male"])
        r["game_mar2026_mean_of_components"] = wstats(mean_expr, tgt, "t.nt", gm)
        rows = q(f"SELECT {', '.join('gm.' + c for c in comps + ['clutch'])}, {tgt} AS y, t.nt AS w {gm}")
        if rows:
            cc = comps + ["clutch"]
            beta, r2 = ols([[x[c] for c in cc] for x in rows], [x["y"] for x in rows], [x["w"] for x in rows])
            r["game_mar2026_components_ols_in_sample"] = {"corr": math.sqrt(max(r2, 0)), "r2": r2}
        out[side] = r
        log(f"external Mar-2026 {side}: new full {r['new_full']['corr']:.3f} ({r['new_full']['players']} players); game Mar-2026 mean-of-components "
            f"{r['game_mar2026_mean_of_components']['corr']:.3f}, OLS {out[side].get('game_mar2026_components_ols_in_sample', {}).get('corr', float('nan')):.3f}")
    return out


# ───────────────────────────── stage 4: age curve ─────────────────────────────
AGE_META = {}


def build_curve(meta, K):
    """Cumulative age curve (runs/100 balls vs age 27) from per-age yearly changes, each shrunk toward zero by n / (n + K) where n = player-year pairs
    behind that age (hierarchical shrinkage: thin ages, mostly 35+, contribute little), then clamped at the plateau."""
    d = {a: meta["delta"][a] * (meta["n"][a] / (meta["n"][a] + K) if K > 0 else 1.0) for a in meta["delta"]}
    C = {27: 0.0}
    for a in range(27, 38):
        C[a + 1] = C[a] + d[a]
    for a in range(26, 17, -1):
        C[a] = C[a + 1] - d[a]
    return {a: min(v, 0.0) for a, v in C.items()}


def age_curve():
    """Year-over-year change in opponent-adjusted value for the same player, by age, centred on the 26-29 plateau.
    Returns {gender: {side: {age: cumulative level in runs/100 balls, C(27) = 0}}}; writes age_curve.csv."""
    prep_maps()
    curves, rows_out = {}, []
    for g in GENDERS:
        curves[g] = {}
        for side, dp in (("bat", "bdp_all"), ("bow", "wdp_all")):
            rows = q(f"""
WITH py AS (
  SELECT d.pid, year(d.date) AS y, sum(d.n) AS n, (sum(d.a_rv) + sum(d.a_dis * ({lam_case("d")}))) / sum(d.n) * 100 AS v
  FROM {dp} d WHERE d.gender = '{g}' AND d.date < DATE '2026-01-01' GROUP BY d.pid, year(d.date) HAVING sum(d.n) >= 150)
SELECT floor(a.y + 0.5 - (year(p.dob) + (month(p.dob) - 0.5) / 12)) AS age, b.v - a.v AS dv, 2.0 / (1.0 / a.n + 1.0 / b.n) AS w
FROM py a JOIN py b ON a.pid = b.pid AND b.y = a.y + 1
JOIN pmap pm ON pm.pid = a.pid JOIN people_ids pe ON pe.cricsheet_id = pm.player_id
JOIN prof p ON p.cricinfo_id = pe.cricinfo_id WHERE p.dob IS NOT NULL""")
            bins = {}
            for r in rows:
                a = int(max(18, min(37, r["age"])))
                s = bins.setdefault(a, [0.0, 0.0, 0])
                s[0] += r["w"] * r["dv"]
                s[1] += r["w"]
                s[2] += 1
            ages = sorted(bins)
            raw = {a: bins[a][0] / bins[a][1] for a in ages}
            cnt = {a: bins[a][2] for a in ages}
            sm = {}
            for a in ages:                      # [1,2,1] smoothing weighted by pair counts
                num = den = 0.0
                for da, k in ((-1, 1), (0, 2), (1, 1)):
                    if a + da in raw:
                        num += k * cnt[a + da] * raw[a + da]
                        den += k * cnt[a + da]
                sm[a] = num / den
            plateau = [sm[a] for a in (26, 27, 28, 29) if a in sm]
            centre = sum(plateau) / len(plateau)
            delta = {a: sm.get(a, centre) - centre for a in range(18, 38)}   # expected change from age a to a+1
            nloc = {a: sum(cnt.get(a + da, 0) for da in (-1, 0, 1)) for a in range(18, 38)}   # pairs behind each age's estimate (itself and neighbours)
            AGE_META.setdefault(g, {})[side] = {"delta": delta, "n": nloc}
            C = build_curve(AGE_META[g][side], K_AGE)
            curves[g][side] = C
            C0 = build_curve(AGE_META[g][side], 0)
            for a in ages:
                rows_out.append([g, side, a, cnt[a], round(raw[a], 3), round(sm[a], 3), round(delta[a], 3), round(C0.get(a, 0), 2), round(C[a], 2)])
            log(f"age curve {g} {side}: {sum(cnt.values())} player-year pairs, centre drift {centre:+.2f}/yr")
    with open(DATA / "age_curve.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["gender", "side", "age", "player_year_pairs", "raw_mean_change", "smoothed_change", "centred_change", "cumulative_level_unshrunk", f"cumulative_level_shrunk_K{K_AGE}"])
        w.writerows(rows_out)
    return curves


# ───────────────────────────── stage 5: production snapshots ─────────────────────────────
def snapshots(params, curves):
    prep_maps()
    asof = q("SELECT strftime(max(date) + 1, '%Y-%m-%d') AS d FROM bl")[0]["d"]
    snaps = [(str(y), f"{y}-01-01") for y in range(2012, 2027)] + [(f"{y}-end", f"{y + 1}-01-01") for y in range(2011, 2026)] + [("latest", asof)]
    run("CREATE OR REPLACE TABLE sns AS SELECT * FROM (VALUES " + ", ".join(f"('{s}', DATE '{t}')" for s, t in snaps) + ") v(snap, T);")
    log("production snapshots")
    noise_sd()
    for g in GENDERS:
        for side in ("bat", "bow"):
            P = params[f"{g}_{side}"]
            hl, K = P["half_life_years"], P["K"]
            name = f"p_{g}_{side}"
            decay("all", hl, "sns", name)
            decay("all", P["short_half_life_years"], "sns", f"ps_{g}_{side}")
            ms = METRICS if side == "bat" else BOWL_METRICS
            sel = ", ".join(f"{fexpr(m, P, 'full')} AS r_{m}" for m in ms)
            sel += ", " + ", ".join(f"{fexpr(m, P, 'long')} AS rl_{m}, {fexpr(m, P, 'form')} AS rf_{m}" for m in ("rv", "dis"))
            nG = f"(coalesce(s.nel, 0) + {MID_WEIGHT} * coalesce(s.nmd, 0))"
            gate = f"least(1.0, {nG} / {P['Kg']})" if P["Kg"] > 0 else "1.0"
            extra = "a.pos / a.ne AS mean_pos" if side == "bat" else "a.ne_leg AS ne_leg, ap.m_bowl AS m_bowl"
            run(f"""
CREATE OR REPLACE TABLE {name}_r AS
  SELECT a.pid, a.snap, a.ne, a.raw_n, a.last, a.last_major, {sel}, {sd_sql(P, g)} AS sd, (((a.p_rv / a.ne + o.rv) + {lam_eff('a')} * (a.p_dis / a.ne + o.dis)) * 100) AS prior_v, {gate} AS gate, {PHI_SQL} AS phi, {nG} AS recent_major_balls,
         {lam_eff('a')} AS lam, {extra}, ap.m_app, a.ne / (a.ne + {K['rv']}) AS conf, a.ne_pp, a.ne_mid, a.ne_d
  {joined2(name, f"ps_{g}_{side}", side, 'all', 'sns')} WHERE a.ne > 0 AND pg.gender = '{g}';
""")
            # phase ratings: phase mean pulled toward the player's overall rating (shrink untuned)
            for phase, short in (("powerplay", "pp"), ("middle", "mid"), ("death", "death")):
                kr, kd = PHASE_K["rv"], PHASE_K["dis"]
                lam_ph = LAM[phase]
                run(f"""
CREATE OR REPLACE TABLE {name}_{short} AS
  SELECT r.pid, r.snap,
    ((coalesce(x.a_rv, 0) + {kr} * r.r_rv) / (coalesce(x.ne, 0) + {kr}) + {lam_ph} * (coalesce(x.a_dis, 0) + {kd} * r.r_dis) / (coalesce(x.ne, 0) + {kd})) * 100 AS v
  FROM {name}_r r LEFT JOIN {name}_{side}_ph x ON x.pid = r.pid AND x.snap = r.snap AND x.phase = '{phase}';""")
    for side in ("bat", "bow"):
        run(f"CREATE OR REPLACE TABLE all_{side}_r AS " + " UNION ALL ".join(f"SELECT '{g}' AS gender, * FROM p_{g}_{side}_r" for g in GENDERS) + ";")
        for short in ("pp", "mid", "death"):
            run(f"CREATE OR REPLACE TABLE all_{side}_{short} AS " + " UNION ALL ".join(f"SELECT * FROM p_{g}_{side}_{short}" for g in GENDERS) + ";")
    # curves -> SQL arrays (ages 18..38)
    cur_rows = ", ".join(f"('{g}', '{s}', [{', '.join(str(round(curves[g][s][a], 4)) for a in range(18, 39))}])" for g in GENDERS for s in ("bat", "bow"))
    run(f"CREATE OR REPLACE TABLE agecurve AS SELECT * FROM (VALUES {cur_rows}) v(gender, side, c);")
    seasons_table("all", "sns", "ssn_all")
    run("""CREATE OR REPLACE TABLE caps_r AS
SELECT c.pid, s.snap, count(*) FILTER (WHERE fmt = 't20') AS t20i, count(*) FILTER (WHERE fmt = 't20' AND fm) AS t20i_fm,
       count(*) FILTER (WHERE fmt = 'odi') AS odi, count(*) FILTER (WHERE fmt = 'odi' AND fm) AS odi_fm, count(*) FILTER (WHERE fmt = 'test') AS test
FROM caps c JOIN sns s ON c.date < s.T GROUP BY c.pid, s.snap;""")
    return params


HL_CONS = 5.0       # consistency uses a 5-year half-life window
K_CONS = 800        # pseudo-balls pulling a player's dispersion index toward the population value
CLUTCH_BASE, CLUTCH_PERF_SCALE, CLUTCH_PERF_CAP, CLUTCH_EXP_MAX, CLUTCH_EXP_MATCHES = 50.0, 0.5, 15.0, 10.0, 20
BIG_STAGE = r"(final|semi|quarter|qualifier|eliminator|knockout|challenger|play-?off)"
NOT_BIG_STAGE = r"(place|group|super|first round|qualifying group)"


def phi_cdf_macro():
    return """
CREATE OR REPLACE MACRO ncdf_t(z) AS 1.0 / (1.0 + 0.3275911 * abs(z) / sqrt(2.0));
CREATE OR REPLACE MACRO ncdf(z) AS 0.5 * (1.0 + sign(z) * (1.0 - ((((1.061405429 * ncdf_t(z) - 1.453152027) * ncdf_t(z) + 1.421413741) * ncdf_t(z) - 0.284496736) * ncdf_t(z) + 0.254829592) * ncdf_t(z) * exp(-z * z / 2.0)));
"""


def behaviour_attributes():
    """Consistency (per-match SD of impact) and big-match clutch, with year-to-year / split-half stability checks.
    Writes tables cons_bat_r, cons_bow_r, clutch_r (pid, snap, ...) and returns the stability results."""
    prep_maps()
    out = {}
    lamc = lam_case("bl")
    run(f"""
CREATE OR REPLACE TABLE inn_bat AS SELECT bi AS pid, any_value(gender) AS gender, any_value(date) AS date, count(*) AS n, sum(e_rv + {lamc} * e_dis) AS v, avg(bat_pos) AS pos FROM bl GROUP BY match_id, bi;
CREATE OR REPLACE TABLE inn_bow AS SELECT bj AS pid, any_value(gender) AS gender, any_value(date) AS date, count(*) AS n, -sum(e_rv + {lamc} * e_dis) AS v, 0.0 AS pos FROM bl GROUP BY match_id, bj;
CREATE OR REPLACE TABLE sig2 AS SELECT gender, var_pop(e_rv + {lamc} * e_dis) AS s2 FROM bl GROUP BY gender;
""")
    # ── consistency: dispersion of per-match value around n * (player's per-ball mean), in units of the per-ball variance ──
    for side in ("bat", "bow"):
        run(f"""
CREATE OR REPLACE TABLE cons_{side}_sums AS
SELECT pid, snap, sum(w) AS m, sum(w * n) AS nn, sum(w * v) AS sv, sum(w * v * v) AS sv2, sum(w * v * n) AS svn, sum(w * n * n) AS sn2
FROM (SELECT i.*, s.snap, power(0.5, date_diff('day', i.date, s.T) / {HL_CONS * 365.25}) AS w
      FROM inn_{side} i JOIN sns s ON i.date < s.T AND i.date >= s.T - INTERVAL 20 YEAR) GROUP BY pid, snap;
CREATE OR REPLACE TABLE cons_{side}_raw AS
SELECT x.pid, x.snap, pg.gender, x.m, x.nn, g.s2,
       (x.sv2 - 2 * (x.sv / x.nn) * x.svn + pow(x.sv / x.nn, 2) * x.sn2) / g.s2 AS ss        -- sum of squared deviations in per-ball-variance units
FROM cons_{side}_sums x JOIN pmap_g pg ON pg.pid = x.pid JOIN sig2 g ON g.gender = pg.gender WHERE x.nn > 0;
""")
        pop = {r["gender"]: r["d"] for r in q(f"SELECT gender, sum(ss) / sum(nn) AS d FROM cons_{side}_raw WHERE snap = 'latest' AND nn >= 300 GROUP BY gender")}
        out[f"population_dispersion_{side}"] = pop
        cases = " ".join(f"WHEN '{g}' THEN {pop[g]:.10e}" for g in pop)
        run(f"""
CREATE OR REPLACE TABLE cons_{side}_r AS
SELECT pid, snap, nn AS cons_balls, (ss + {K_CONS} * (CASE gender {cases} END)) / (nn + {K_CONS}) AS d_s,
       sqrt(((ss + {K_CONS} * (CASE gender {cases} END)) / (nn + {K_CONS})) * s2 * nn / m) AS match_sd          -- SD of per-match impact (runs) for his typical innings/spell length
FROM cons_{side}_raw;""")
        # year-to-year stability of the shrunk index (calendar years, no decay)
        rows = q(f"""
WITH y AS (SELECT pid, any_value(gender) AS gender, year(date) AS yr, sum(n) AS nn, sum(v) AS sv, sum(v * v) AS sv2, sum(v * n) AS svn, sum(n * n) AS sn2, avg(pos) AS pos
           FROM inn_{side} GROUP BY pid, year(date) HAVING sum(n) >= {150 if side == 'bat' else 120}),
     d AS (SELECT y.pid, y.gender, y.yr, y.nn, y.pos,
                  ((y.sv2 - 2 * (y.sv / y.nn) * y.svn + pow(y.sv / y.nn, 2) * y.sn2) / g.s2 + {K_CONS} * 1.0) / (y.nn + {K_CONS}) AS d
           FROM y JOIN sig2 g USING (gender))
SELECT a.gender, a.pos AS pos_a, a.d AS d0, b.d AS d1, least(a.nn, b.nn) AS w
FROM d a JOIN d b ON a.pid = b.pid AND b.yr = a.yr + 1 WHERE a.yr >= 2012""")
        res = {}
        for g in GENDERS:
            rr = [r for r in rows if r["gender"] == g]
            if len(rr) > 30:
                c = corr_mse([r["d0"] for r in rr], [r["d1"] for r in rr], [r["w"] for r in rr])
                res[g] = {"pairs": len(rr), "corr": c["corr"]}
                if side == "bat":    # remove the batting-position effect (openers vs finishers have different dispersion)
                    def bucket(p):
                        return 0 if p <= 2.5 else 1 if p <= 4.5 else 2 if p < 6 else 3 if p <= 7.5 else 4
                    mean_d = {}
                    for b_ in range(5):
                        v_ = [(r["d0"] + r["d1"]) / 2 for r in rr if bucket(r["pos_a"]) == b_]
                        mean_d[b_] = sum(v_) / len(v_) if v_ else 0.0
                    c2 = corr_mse([r["d0"] - mean_d[bucket(r["pos_a"])] for r in rr], [r["d1"] - mean_d[bucket(r["pos_a"])] for r in rr], [r["w"] for r in rr])
                    res[g]["corr_within_batting_position"] = c2["corr"]
        out[f"consistency_stability_{side}"] = res
        log(f"consistency stability {side}: " + ", ".join(f"{g} r={v['corr']:.2f} (n={v['pairs']})" for g, v in res.items()))
    # ── clutch: big-match performance relative to the player's own non-big-match performance ──
    run(f"""
CREATE OR REPLACE TABLE bigm AS
SELECT match_id, (stage IS NOT NULL AND regexp_matches(lower(stage), '{BIG_STAGE}') AND NOT regexp_matches(lower(stage), '{NOT_BIG_STAGE}')) AS big
FROM '{DATA}/matches.parquet';
CREATE OR REPLACE TABLE ev AS
SELECT bl.bi AS pid, bl.match_id, any_value(bl.date) AS date, any_value(b.big) AS big, count(*) AS n,
       sum(bl.e_rv + w.rv + {lamc} * (bl.e_dis + w.dis)) AS v
FROM bl JOIN sk_bow_all w ON w.pid = bl.bj JOIN bigm b USING (match_id) GROUP BY bl.bi, bl.match_id
UNION ALL
SELECT bl.bj, bl.match_id, any_value(bl.date), any_value(b.big), count(*),
       sum((bt.rv - bl.e_rv) + {lamc} * (bt.dis - bl.e_dis))
FROM bl JOIN sk_bat_all bt ON bt.pid = bl.bi JOIN bigm b USING (match_id) GROUP BY bl.bj, bl.match_id;
""")
    nbig = q("SELECT count(DISTINCT match_id) AS m, sum(n) AS balls FROM ev WHERE big")[0]
    out["big_matches_in_data"] = int(nbig["m"])
    out["big_match_balls"] = int(nbig["balls"])
    rows = q("""
WITH p AS (SELECT pid, sum(n) FILTER (NOT big) AS nn, sum(v) FILTER (NOT big) AS vn, count(DISTINCT match_id) FILTER (big) AS bm, sum(n) FILTER (big) AS nb FROM ev GROUP BY pid
           HAVING count(DISTINCT match_id) FILTER (big) >= 6 AND sum(n) FILTER (big) >= 120 AND sum(n) FILTER (NOT big) >= 300)
SELECT e.pid, e.match_id, e.date, e.n, e.v, p.vn / p.nn AS base FROM ev e JOIN p USING (pid) WHERE e.big ORDER BY e.pid, e.date, e.match_id""")
    by = {}
    for r in rows:
        by.setdefault(int(r["pid"]), []).append(r)
    splits = {"chronological": ([], [], []), "odd_even": ([], [], [])}
    for pid, rs in by.items():
        # group rows into matches in date order
        matches = {}
        for r in rs:
            matches.setdefault(r["match_id"], []).append(r)
        order = sorted(matches, key=lambda m: (matches[m][0]["date"], m))
        base = rs[0]["base"]
        for name, (ia, ib) in (("chronological", (order[: len(order) // 2], order[len(order) // 2:])), ("odd_even", (order[0::2], order[1::2]))):
            def delta(ids):
                n = sum(r["n"] for m in ids for r in matches[m])
                v = sum(r["v"] for m in ids for r in matches[m])
                return (v / n - base) * 100, n
            (d1, n1), (d2, n2) = delta(ia), delta(ib)
            splits[name][0].append(d1)
            splits[name][1].append(d2)
            splits[name][2].append(2 * n1 * n2 / (n1 + n2))
    stab = {}
    for name, (a_, b_, w_) in splits.items():
        c = corr_mse(a_, b_, w_)["corr"]
        stab[name] = {"players": len(a_), "split_half_corr": c, "spearman_brown_reliability": (2 * c / (1 + c)) if c > 0 else 0.0}
    out["clutch_stability"] = stab
    # reliability of the big-match delta at the median player's volume -> shrinkage K (balls) of the normal-normal update
    rel = max(stab["chronological"]["spearman_brown_reliability"], 0.0)
    nb_med = sorted(sum(r["n"] for r in rs) for rs in by.values())[len(by) // 2]
    kb = nb_med * (1 - rel) / rel if rel > 0.05 else 1e9
    out["clutch_shrinkage_K_balls"] = kb
    out["clutch_reliability_used"] = rel
    log(f"clutch stability: chronological split-half r={stab['chronological']['split_half_corr']:.2f}, odd/even r={stab['odd_even']['split_half_corr']:.2f}; K_b={kb:.0f} balls")
    run(f"""
CREATE OR REPLACE TABLE clutch_r AS
SELECT pid, snap, bm AS big_matches, nb AS big_balls,
       CASE WHEN nb > 0 AND nn > 0 THEN (vb / nb - vn / nn) * 100 * nb / (nb + {kb}) ELSE 0 END AS big_delta,
       {CLUTCH_BASE} + least({CLUTCH_PERF_CAP}, greatest(-{CLUTCH_PERF_CAP}, {CLUTCH_PERF_SCALE} * CASE WHEN nb > 0 AND nn > 0 THEN (vb / nb - vn / nn) * 100 * nb / (nb + {kb}) ELSE 0 END))
         + {CLUTCH_EXP_MAX} * least(1.0, bm / {CLUTCH_EXP_MATCHES}.0) AS clutch_raw
FROM (SELECT e.pid, s.snap, count(DISTINCT e.match_id) FILTER (WHERE e.big) AS bm, coalesce(sum(e.n) FILTER (WHERE e.big), 0) AS nb, coalesce(sum(e.v) FILTER (WHERE e.big), 0) AS vb,
             coalesce(sum(e.n) FILTER (WHERE NOT e.big), 0) AS nn, coalesce(sum(e.v) FILTER (WHERE NOT e.big), 0) AS vn
      FROM ev e JOIN sns s ON e.date < s.T GROUP BY e.pid, s.snap);
""")
    json.dump(out, open(DATA / "behaviour_stability.json", "w"), indent=1, default=float)
    return out


def assemble(params):
    """Join batting + bowling halves, profile info, age and impact into the output parquet."""
    log("assembling output")
    hl_b = {g: params[f"{g}_bat"]["half_life_years"] for g in GENDERS}
    hl_w = {g: params[f"{g}_bow"]["half_life_years"] for g in GENDERS}
    Kb = {g: params[f"{g}_bat"]["K"] for g in GENDERS}
    Kw = {g: params[f"{g}_bow"]["K"] for g in GENDERS}
    # bowler extras (wides/no-balls) at the bowling half-life, one table per gender
    parts = []
    for g in GENDERS:
        decay("all", hl_w[g], "sns", f"x_{g}")
        parts.append(f"SELECT '{g}' AS gender, e.pid, e.snap, e.ne_all, e.a_ext FROM x_{g}_ext e JOIN pmap_g pg ON pg.pid = e.pid WHERE pg.gender = '{g}'")
    run("CREATE OR REPLACE TABLE all_ext AS " + " UNION ALL ".join(parts) + ";")
    macro = """
CREATE OR REPLACE MACRO agec(arr, a) AS (
  list_extract(arr, CAST(floor(least(greatest(a, 18.0), 37.999)) AS INT) - 17) * (1 - (least(greatest(a, 18.0), 37.999) - floor(least(greatest(a, 18.0), 37.999))))
  + list_extract(arr, CAST(floor(least(greatest(a, 18.0), 37.999)) AS INT) - 16) * (least(greatest(a, 18.0), 37.999) - floor(least(greatest(a, 18.0), 37.999))));
"""
    kb_rv = " ".join(f"WHEN '{g}' THEN {Kb[g]['rv']}" for g in GENDERS)
    kw_rv = " ".join(f"WHEN '{g}' THEN {Kw[g]['rv']}" for g in GENDERS)
    kbat = " ".join(f"WHEN '{g}' THEN {params[f'{g}_bat']['k']}" for g in GENDERS)
    kbow = " ".join(f"WHEN '{g}' THEN {params[f'{g}_bow']['k']}" for g in GENDERS)
    hlb = " ".join(f"WHEN '{g}' THEN {hl_b[g]}" for g in GENDERS)
    hlw = " ".join(f"WHEN '{g}' THEN {hl_w[g]}" for g in GENDERS)
    sql = macro + f"""
CREATE OR REPLACE TABLE fin0 AS
WITH keys AS (SELECT gender, pid, snap FROM all_bat_r UNION SELECT gender, pid, snap FROM all_bow_r)
SELECT k.gender, k.pid, k.snap, s.T AS as_of, pm.player_id, pe.cricinfo_id, pe.cricketarchive_id,
       coalesce(pe.name, pr.espn_name) AS name,
       -- batting
       b.ne AS bat_balls_eff, b.raw_n AS bat_balls_career, b.ne / (b.ne + (CASE k.gender {kb_rv} END)) AS bat_confidence,
       (b.r_rv + b.lam * b.r_dis) * 100 AS bat_value, b.sd AS bat_sd, b.prior_v AS bat_prior, (b.rl_rv + b.lam * b.rl_dis) * 100 AS bat_value_long, (b.rf_rv + b.lam * b.rf_dis) * 100 AS bat_form,
       b.gate AS bat_gate, b.phi AS bat_inactivity, b.recent_major_balls AS bat_recent_major_balls, b.last_major AS bat_lm,
       b.r_rv * 100 AS bat_runs, b.r_dis * 100 AS bat_dismissal, b.r_six * 100 AS bat_power, b.r_four * 100 AS bat_timing, b.r_rr * 100 AS bat_running,
       bpp.v AS bat_pp, bmid.v AS bat_mid, bdeath.v AS bat_death, b.mean_pos AS bat_position, b.ne_d / b.ne AS bat_death_share, b.ne_pp / b.ne AS bat_pp_share, b.m_app AS m_app_bat, b.last AS bat_last,
       -- bowling
       w.ne AS bowl_balls_eff, w.raw_n AS bowl_balls_career, w.ne / (w.ne + (CASE k.gender {kw_rv} END)) AS bowl_confidence,
       (w.r_rv + w.lam * w.r_dis) * 100 + x.xr AS bowl_value, w.sd AS bowl_sd, w.prior_v AS bowl_prior, (w.rl_rv + w.lam * w.rl_dis) * 100 + x.xr AS bowl_value_long,
       (w.rf_rv + w.lam * w.rf_dis) * 100 + x.xr AS bowl_form, w.gate AS bowl_gate, w.phi AS bowl_inactivity,
       w.recent_major_balls AS bowl_recent_major_balls, w.last_major AS bowl_lm,
       w.r_rv * 100 AS bowl_economy, w.r_dis * 100 AS bowl_wickets, x.xr AS bowl_accuracy,
       wpp.v + x.xr AS bowl_pp, wmid.v + x.xr AS bowl_mid, wdeath.v + x.xr AS bowl_death,
       w.ne_pp / w.ne AS bowl_pp_share, w.ne_mid / w.ne AS bowl_mid_share, w.ne_d / w.ne AS bowl_death_share, w.last AS bowl_last,
       w.ne_leg AS bowl_legal_eff, w.m_app AS m_app_bow,
       pr.pace_spin, pr.bowl_style AS bowling_style, pr.bat_style AS batting_style, pr.keeper, pr.espn_roles, pr.dob,
       (s.T - pr.dob) / 365.25 AS age,
       cb.d_s AS bat_dispersion, cb.match_sd AS bat_match_sd, cb.cons_balls AS bat_cons_balls, cw.d_s AS bowl_dispersion, cw.match_sd AS bowl_match_sd, cw.cons_balls AS bowl_cons_balls,
       cl.big_matches, cl.big_balls, cl.big_delta, cl.clutch_raw,
       coalesce(z.seasons, 0) AS elite_seasons, least(1.0, coalesce(z.seasons, 0) / {PROVEN_SEASONS}) AS proven_weight,
       coalesce(cp.t20i, 0) AS intl_matches, coalesce(cp.t20i_fm, 0) AS intl_full_member_matches, coalesce(cp.odi, 0) AS intl_odi_matches, coalesce(cp.test, 0) AS intl_test_matches,
       coalesce(cp.t20i_fm, 0) + 0.4 * (coalesce(cp.t20i, 0) - coalesce(cp.t20i_fm, 0)) + 0.35 * coalesce(cp.odi_fm, 0) + 0.15 * (coalesce(cp.odi, 0) - coalesce(cp.odi_fm, 0)) + 0.5 * coalesce(cp.test, 0) AS weighted_caps
FROM keys k
JOIN sns s ON s.snap = k.snap
JOIN pmap pm ON pm.pid = k.pid
LEFT JOIN people_ids pe ON pe.cricsheet_id = pm.player_id
LEFT JOIN prof pr ON pr.cricinfo_id = pe.cricinfo_id
LEFT JOIN all_bat_r b ON b.pid = k.pid AND b.snap = k.snap
LEFT JOIN all_bat_pp bpp ON bpp.pid = k.pid AND bpp.snap = k.snap
LEFT JOIN all_bat_mid bmid ON bmid.pid = k.pid AND bmid.snap = k.snap
LEFT JOIN all_bat_death bdeath ON bdeath.pid = k.pid AND bdeath.snap = k.snap
LEFT JOIN all_bow_r w ON w.pid = k.pid AND w.snap = k.snap
LEFT JOIN all_bow_pp wpp ON wpp.pid = k.pid AND wpp.snap = k.snap
LEFT JOIN all_bow_mid wmid ON wmid.pid = k.pid AND wmid.snap = k.snap
LEFT JOIN all_bow_death wdeath ON wdeath.pid = k.pid AND wdeath.snap = k.snap
LEFT JOIN (SELECT pid, snap, a_ext / (ne_all + {EXT_K}) * 100 AS xr FROM all_ext) x ON x.pid = k.pid AND x.snap = k.snap
LEFT JOIN cons_bat_r cb ON cb.pid = k.pid AND cb.snap = k.snap
LEFT JOIN cons_bow_r cw ON cw.pid = k.pid AND cw.snap = k.snap
LEFT JOIN clutch_r cl ON cl.pid = k.pid AND cl.snap = k.snap
LEFT JOIN ssn_all z ON z.pid = k.pid AND z.snap = k.snap
LEFT JOIN caps_r cp ON cp.pid = k.pid AND cp.snap = k.snap;
"""
    run(sql)
    # workload, impact, roles, age projection
    run(f"""
CREATE OR REPLACE TABLE fin1 AS
SELECT f.* REPLACE (CASE WHEN f.bat_balls_eff < 30 THEN NULL ELSE f.bat_value END AS bat_value, CASE WHEN f.bat_balls_eff < 30 THEN NULL ELSE f.bat_runs END AS bat_runs, CASE WHEN f.bat_balls_eff < 30 THEN NULL ELSE f.bat_dismissal END AS bat_dismissal, CASE WHEN f.bat_balls_eff < 30 THEN NULL ELSE f.bat_power END AS bat_power, CASE WHEN f.bat_balls_eff < 30 THEN NULL ELSE f.bat_timing END AS bat_timing, CASE WHEN f.bat_balls_eff < 30 THEN NULL ELSE f.bat_running END AS bat_running, CASE WHEN f.bat_balls_eff < 30 THEN NULL ELSE f.bat_pp END AS bat_pp, CASE WHEN f.bat_balls_eff < 30 THEN NULL ELSE f.bat_mid END AS bat_mid, CASE WHEN f.bat_balls_eff < 30 THEN NULL ELSE f.bat_death END AS bat_death, CASE WHEN f.bat_balls_eff < 30 THEN NULL ELSE f.bat_confidence END AS bat_confidence, CASE WHEN f.bat_balls_eff < 30 THEN NULL ELSE f.bat_sd END AS bat_sd, CASE WHEN f.bowl_balls_eff < 30 THEN NULL ELSE f.bowl_sd END AS bowl_sd, CASE WHEN f.bowl_balls_eff < 30 THEN NULL ELSE f.bowl_value END AS bowl_value, CASE WHEN f.bowl_balls_eff < 30 THEN NULL ELSE f.bowl_economy END AS bowl_economy, CASE WHEN f.bowl_balls_eff < 30 THEN NULL ELSE f.bowl_wickets END AS bowl_wickets, CASE WHEN f.bowl_balls_eff < 30 THEN NULL ELSE f.bowl_accuracy END AS bowl_accuracy, CASE WHEN f.bowl_balls_eff < 30 THEN NULL ELSE f.bowl_pp END AS bowl_pp, CASE WHEN f.bowl_balls_eff < 30 THEN NULL ELSE f.bowl_mid END AS bowl_mid, CASE WHEN f.bowl_balls_eff < 30 THEN NULL ELSE f.bowl_death END AS bowl_death, CASE WHEN f.bowl_balls_eff < 30 THEN NULL ELSE f.bowl_confidence END AS bowl_confidence),
       CASE WHEN f.bat_balls_eff IS NULL THEN NULL ELSE least(30.0, f.bat_balls_eff / nullif(f.m_app_bat, 0)) END AS bat_balls_per_match,
       CASE WHEN f.bowl_legal_eff IS NULL THEN NULL ELSE least(24.0, f.bowl_legal_eff / nullif(f.m_app_bow, 0)) END AS bowl_balls_per_match,
       greatest(f.bat_last, f.bowl_last) AS last_played, greatest(f.bat_lm, f.bowl_lm) AS last_major,
       CASE WHEN f.bat_position IS NULL THEN NULL WHEN f.bat_position <= 2.5 THEN 'opener' WHEN f.bat_position <= 4.5 THEN 'top order'
            WHEN f.bat_position > 7.5 THEN 'lower order' WHEN f.bat_death_share >= 0.30 THEN 'finisher' ELSE 'middle order' END AS batting_role,
       CASE WHEN f.bowl_balls_eff IS NULL THEN NULL
            WHEN f.bowl_pp_share >= 0.3 AND f.bowl_death_share >= 0.3 THEN 'new ball + death'
            WHEN f.bowl_death_share >= 0.4 THEN 'death specialist' WHEN f.bowl_pp_share >= 0.45 THEN 'powerplay'
            WHEN f.bowl_mid_share >= 0.6 THEN 'middle overs' ELSE 'all phases' END AS bowling_role
FROM fin0 f;
CREATE OR REPLACE TABLE fin1b AS
SELECT f.*,
       f.bat_value + f.bat_confidence * (agec((SELECT c FROM agecurve a WHERE a.gender = f.gender AND a.side = 'bat'), f.age + 1.0)
         - agec((SELECT c FROM agecurve a WHERE a.gender = f.gender AND a.side = 'bat'), f.age - 1.44 * (CASE f.gender {hlb} END))) AS bat_value_proj,
       f.bowl_value + f.bowl_confidence * (agec((SELECT c FROM agecurve a WHERE a.gender = f.gender AND a.side = 'bow'), f.age + 1.0)
         - agec((SELECT c FROM agecurve a WHERE a.gender = f.gender AND a.side = 'bow'), f.age - 1.44 * (CASE f.gender {hlw} END))) AS bowl_value_proj
FROM fin1 f;
CREATE OR REPLACE TABLE fin2 AS
SELECT f.*,
       -- the game-facing overall uses the age-projected value (one year ahead), falling back to the plain value when DOB is unknown
       -- conservative: value minus k posterior SDs (k tuned per gender and side), then the proven pull toward the role prior: a rating above its prior may
       -- sit only proven_weight (= min(1, elite seasons / 5)) of the way above it.  *_u columns are the same without the pull.
       CASE WHEN f.bat_value IS NULL THEN 0 ELSE {pull("(coalesce(f.bat_value_proj, f.bat_value) - (CASE f.gender " + kbat + " END) * coalesce(f.bat_sd, 0))", "f.bat_prior", "f.proven_weight")} * coalesce(f.bat_balls_per_match, 0) / 100 END AS impact_bat,
       CASE WHEN f.bowl_value IS NULL THEN 0 ELSE {pull("(coalesce(f.bowl_value_proj, f.bowl_value) - (CASE f.gender " + kbow + " END) * coalesce(f.bowl_sd, 0))", "f.bowl_prior", "f.proven_weight")} * coalesce(f.bowl_balls_per_match, 0) / 100 END AS impact_bowl,
       CASE WHEN f.bat_value IS NULL THEN 0 ELSE (coalesce(f.bat_value_proj, f.bat_value) - (CASE f.gender {kbat} END) * coalesce(f.bat_sd, 0)) * coalesce(f.bat_balls_per_match, 0) / 100 END AS impact_bat_u,
       CASE WHEN f.bowl_value IS NULL THEN 0 ELSE (coalesce(f.bowl_value_proj, f.bowl_value) - (CASE f.gender {kbow} END) * coalesce(f.bowl_sd, 0)) * coalesce(f.bowl_balls_per_match, 0) / 100 END AS impact_bowl_u,
       f.bat_value - (CASE f.gender {kbat} END) * f.bat_sd AS bat_cons, f.bowl_value - (CASE f.gender {kbow} END) * f.bowl_sd AS bowl_cons,
       {pull("(f.bat_value - (CASE f.gender " + kbat + " END) * f.bat_sd)", "f.bat_prior", "f.proven_weight")} AS bat_rank_value,
       {pull("(f.bowl_value - (CASE f.gender " + kbow + " END) * f.bowl_sd)", "f.bowl_prior", "f.proven_weight")} AS bowl_rank_value,
       {pull("(coalesce(f.bat_value_proj, f.bat_value) - (CASE f.gender " + kbat + " END) * f.bat_sd)", "f.bat_prior", "f.proven_weight")} AS bat_rank_value_proj,
       {pull("(coalesce(f.bowl_value_proj, f.bowl_value) - (CASE f.gender " + kbow + " END) * f.bowl_sd)", "f.bowl_prior", "f.proven_weight")} AS bowl_rank_value_proj,
       -- all-rounder = real workload on both sides and neither side a liability (secondary role costs no more than 0.25 runs per match);
       -- anyone else is classed by the side that adds more
       CASE WHEN coalesce(f.bowl_balls_per_match, 0) >= 8 AND coalesce(f.bat_balls_per_match, 0) >= 8 AND coalesce(f.bat_position, 9) <= 7.5
                 AND least(coalesce(f.bat_value, 0) * f.bat_balls_per_match, coalesce(f.bowl_value, 0) * f.bowl_balls_per_match) / 100 >= -0.25 THEN 'all-rounder'
            WHEN coalesce(f.bowl_balls_per_match, 0) >= 8 AND (coalesce(f.bat_balls_per_match, 0) < 8
                 OR coalesce(f.bowl_value_proj, f.bowl_value, 0) * f.bowl_balls_per_match >= coalesce(f.bat_value_proj, f.bat_value, 0) * f.bat_balls_per_match) THEN 'bowler'
            ELSE 'batter' END AS player_role,
       coalesce(f.last_major >= f.as_of - INTERVAL 1 YEAR, false) AS active
FROM fin1b f;
CREATE OR REPLACE TABLE fin3 AS
SELECT f.*, f.impact_bat + f.impact_bowl AS impact_additive,
       -- value in a team role: the bigger of batting and bowling impact, plus half of the smaller one if positive. Impacts are already
       -- value x balls per match, so a side that is barely used contributes almost nothing and bits-and-pieces players cannot add up to a star.
       greatest(f.impact_bat, f.impact_bowl) + {SECONDARY_BONUS} * greatest(least(f.impact_bat, f.impact_bowl), 0) AS impact,
       greatest(f.impact_bat_u, f.impact_bowl_u) + {SECONDARY_BONUS} * greatest(least(f.impact_bat_u, f.impact_bowl_u), 0) AS impact_u,
       greatest(coalesce(f.bat_gate, 0), coalesce(f.bowl_gate, 0)) AS gate,
       greatest(coalesce(f.bat_inactivity, 0), coalesce(f.bowl_inactivity, 0)) AS inactivity,
       (f.as_of - f.last_major) / 30.4 AS months_since_major,
       (coalesce(f.bat_confidence, 0) * coalesce(f.bat_balls_per_match, 0) + coalesce(f.bowl_confidence, 0) * coalesce(f.bowl_balls_per_match, 0))
         / nullif(coalesce(f.bat_balls_per_match, 0) + coalesce(f.bowl_balls_per_match, 0), 0) AS confidence
FROM fin2 f
WHERE (coalesce(f.bat_balls_eff, 0) >= 15 OR coalesce(f.bowl_balls_eff, 0) >= 15) AND f.last_played >= f.as_of - INTERVAL 2 YEAR;
""")
    # 0-99 scale: position of the conservative rating (mean - k SD) on the population of active regulars, through a normal CDF.
    # Calibration per gender and snapshot: the regulars' median maps to 70 and the best regular to 98.5 (so only a genuine #1 is near 99),
    # i.e. u = 0.5434 + 2.0326 * (x - median) / (max - median) and score = 99 * Phi(u).
    run(phi_cdf_macro() + f"""
CREATE OR REPLACE TABLE fin4 AS
WITH reg_b AS (SELECT gender, snap, median(bat_rank_value_proj) AS m, max(bat_rank_value_proj) AS mx FROM fin3 WHERE active AND bat_balls_per_match >= 8 AND bat_confidence >= 0.5 GROUP BY ALL),
     reg_w AS (SELECT gender, snap, median(bowl_rank_value_proj) AS m, max(bowl_rank_value_proj) AS mx FROM fin3 WHERE active AND bowl_balls_per_match >= 8 AND bowl_confidence >= 0.5 GROUP BY ALL),
     reg_i AS (SELECT gender, snap, median(impact) AS m, max(impact) AS mx FROM fin3 WHERE active AND confidence >= 0.4 AND (bat_balls_per_match >= 8 OR bowl_balls_per_match >= 8) GROUP BY ALL),
     reg_iu AS (SELECT gender, snap, median(impact_u) AS m, max(impact_u) AS mx FROM fin3 WHERE active AND confidence >= 0.4 AND (bat_balls_per_match >= 8 OR bowl_balls_per_match >= 8) GROUP BY ALL),
     reg_cb AS (SELECT gender, snap, avg(bat_dispersion) AS m, stddev_pop(bat_dispersion) AS s FROM fin3 WHERE active AND bat_cons_balls >= 400 GROUP BY ALL),
     reg_cw AS (SELECT gender, snap, avg(bowl_dispersion) AS m, stddev_pop(bowl_dispersion) AS s FROM fin3 WHERE active AND bowl_cons_balls >= 400 GROUP BY ALL)
SELECT f.*,
       CAST(least(99, greatest(1, round(99 * ncdf(0.5434 + 2.0326 * (f.bat_rank_value_proj - rb.m) / (rb.mx - rb.m))))) AS INT) AS bat_ovr,
       CAST(least(99, greatest(1, round(99 * ncdf(0.5434 + 2.0326 * (f.bowl_rank_value_proj - rw.m) / (rw.mx - rw.m))))) AS INT) AS bowl_ovr,
       CAST(least(99, greatest(1, round(99 * ncdf(0.5434 + 2.0326 * (f.impact - ri.m) / (ri.mx - ri.m))))) AS INT) AS overall,
       CAST(least(99, greatest(1, round(99 * ncdf(0.5434 + 2.0326 * (f.impact_u - riu.m) / (riu.mx - riu.m))))) AS INT) AS overall_unproven,
       CAST(least(99, greatest(1, round(99 * ncdf((cb.m - f.bat_dispersion) / cb.s)))) AS INT) AS bat_consistency,
       CAST(least(99, greatest(1, round(99 * ncdf((cw.m - f.bowl_dispersion) / cw.s)))) AS INT) AS bowl_consistency,
       CAST(least(99, greatest(1, round(coalesce(f.clutch_raw, {CLUTCH_BASE})))) AS INT) AS clutch,
       CAST(round(99 * (0.45 * least(1.0, ln(1 + f.elite_seasons) / ln(16.0)) + 0.35 * least(1.0, ln(1 + f.weighted_caps) / ln(151.0)) + 0.20 * least(1.0, ln(1 + coalesce(f.big_matches, 0)) / ln(41.0)))) AS INT) AS experience
FROM fin3 f LEFT JOIN reg_b rb USING (gender, snap) LEFT JOIN reg_w rw USING (gender, snap) LEFT JOIN reg_i ri USING (gender, snap) LEFT JOIN reg_iu riu USING (gender, snap)
     LEFT JOIN reg_cb cb USING (gender, snap) LEFT JOIN reg_cw cw USING (gender, snap);
COPY (
  SELECT player_id, cricinfo_id, cricketarchive_id, name, gender, snap AS snapshot, as_of, round(age, 1) AS age,
         player_role, batting_role, bowling_role, pace_spin, bowling_style, batting_style, keeper::BOOLEAN AS keeper, active, last_played,
         last_major AS last_major_ball, round(months_since_major, 1) AS months_since_major, round(inactivity, 3) AS inactivity_factor,
         round(confidence, 3) AS confidence,
         CAST(round(bat_balls_career) AS INT) AS bat_balls_career, round(bat_balls_eff, 1) AS bat_balls_eff, round(bat_confidence, 3) AS bat_confidence,
         round(bat_value, 2) AS bat_value, round(bat_value, 2) AS bat_mean, round(bat_sd, 2) AS bat_sd, round(bat_cons, 2) AS bat_cons,
         round(bat_value_long, 2) AS bat_value_long, round(bat_form, 2) AS bat_form,
         round(bat_recent_major_balls, 1) AS bat_recent_major_balls, round(bat_value_proj, 2) AS bat_value_proj, round(bat_runs, 2) AS bat_runs,
         round(bat_dismissal, 3) AS bat_dismissal, round(bat_power, 3) AS bat_power, round(bat_timing, 3) AS bat_timing, round(bat_running, 3) AS bat_running,
         round(bat_pp, 2) AS bat_pp, round(bat_mid, 2) AS bat_mid, round(bat_death, 2) AS bat_death,
         round(bat_position, 2) AS bat_position, round(bat_death_share, 3) AS bat_death_share, round(bat_pp_share, 3) AS bat_pp_share, round(bat_balls_per_match, 2) AS bat_balls_per_match,
         CAST(round(bowl_balls_career) AS INT) AS bowl_balls_career, round(bowl_balls_eff, 1) AS bowl_balls_eff, round(bowl_confidence, 3) AS bowl_confidence,
         round(bowl_value, 2) AS bowl_value, round(bowl_value, 2) AS bowl_mean, round(bowl_sd, 2) AS bowl_sd, round(bowl_cons, 2) AS bowl_cons,
         round(bowl_value_long, 2) AS bowl_value_long, round(bowl_form, 2) AS bowl_form,
         round(bowl_recent_major_balls, 1) AS bowl_recent_major_balls, round(bowl_value_proj, 2) AS bowl_value_proj, round(bowl_economy, 2) AS bowl_economy,
         round(bowl_wickets, 3) AS bowl_wickets, round(bowl_accuracy, 2) AS bowl_accuracy,
         round(bowl_pp, 2) AS bowl_pp, round(bowl_mid, 2) AS bowl_mid, round(bowl_death, 2) AS bowl_death,
         round(bowl_pp_share, 3) AS bowl_pp_share, round(bowl_mid_share, 3) AS bowl_mid_share, round(bowl_death_share, 3) AS bowl_death_share,
         round(bowl_balls_per_match, 2) AS bowl_balls_per_match,
         round(impact_bat, 3) AS impact_bat, round(impact_bowl, 3) AS impact_bowl, round(impact, 3) AS impact, round(impact_additive, 3) AS impact_additive,
         bat_ovr, bowl_ovr, overall,
         bat_consistency, round(bat_match_sd, 2) AS bat_match_sd, bowl_consistency, round(bowl_match_sd, 2) AS bowl_match_sd,
         clutch, big_matches, big_balls, round(big_delta, 2) AS big_match_delta,
         experience, round(elite_seasons, 2) AS elite_seasons, round(proven_weight, 3) AS proven_weight, intl_matches, intl_full_member_matches, intl_odi_matches, intl_test_matches,
         round(bat_rank_value, 2) AS bat_rank_value, round(bowl_rank_value, 2) AS bowl_rank_value, round(bat_rank_value_proj, 2) AS bat_rank_value_proj, round(bowl_rank_value_proj, 2) AS bowl_rank_value_proj, round(bat_prior, 2) AS bat_prior, round(bowl_prior, 2) AS bowl_prior,
         round(impact_u, 3) AS impact_unproven, overall_unproven
  FROM fin4 ORDER BY gender, as_of, name
) TO '{DATA}/player_ratings_by_season.parquet' (FORMAT parquet);
""")
    n = q(f"SELECT count(*) AS n, count(DISTINCT player_id) AS p FROM '{DATA}/player_ratings_by_season.parquet'")[0]
    log(f"wrote player_ratings_by_season.parquet: {int(n['n'])} rows, {int(n['p'])} players")


def league_levels():
    """League pool levels learned by the model (runs/100 balls, vs seed from league_strength.csv)."""
    rows = q("""SELECT c.gender, c.competition, round(p.rv * 100, 2) AS batter_pool, round(w.rv * 100, 2) AS bowler_pool, round(c.lvl * 100, 2) AS seed_from_league_strength
                FROM pool_bat_all p JOIN pool_bow_all w USING (cid) JOIN cmap c USING (cid) ORDER BY c.gender, p.rv DESC""")
    with open(DATA / "league_levels.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["gender", "competition", "batter_pool", "bowler_pool", "seed_from_league_strength"])
        for r in rows:
            w.writerow([r["gender"], r["competition"], r["batter_pool"], r["bowler_pool"], r["seed_from_league_strength"]])


def main():
    fresh = "--fresh" in sys.argv
    load(fresh)
    load_profiles()
    wicket_values()
    for ty in TRAIN_YEARS + [9999, 2026]:
        tag = "all" if ty == 9999 else "fm26" if ty == 2026 else f"f{ty}"
        if exists(f"bdp_{tag}") and not fresh and "--refit" not in sys.argv:
            continue
        for tbl in ("sk_bat", "sk_bow", "pool_bat", "pool_bow", "omega_bat", "omega_bow", "grp_bat", "grp_bow"):
            run(f"DROP TABLE IF EXISTS {tbl}_{tag};")
        cutoff = "2026-12-31" if ty == 9999 else "2026-03-26" if ty == 2026 else f"{ty}-12-31"
        for g in GENDERS:
            fit_skills(g, cutoff, tag)
        build_dp(tag, cutoff)
    prep_maps()
    league_levels()
    params = tune()
    params = tune_form(params)
    params = tune_k(params)
    params = proven_effect_tuning(params)
    curves = age_curve()
    validate(params, curves)
    snapshots(params, curves)
    behaviour_attributes()
    assemble(params)
    json.dump({"lambda_runs_per_wicket": LAM, "als_K": ALS_K, "k_pool": K_POOL, "phase_K": PHASE_K, "extras_K": EXT_K,
               "half_lives": HALF_LIVES, "k_grid": K_GRID, "tune_folds": TUNE_FOLDS}, open(DATA / "model_config.json", "w"), indent=1)


if __name__ == "__main__":
    main()
