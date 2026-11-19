"""
Does the age of the ball predict the next delivery beyond what the engine already has? Out-of-sample tests (docs/data/ball_age.json,
docs/FORMATS.md "Ball age"). Each experiment fits the ball model twice by iterative proportional fitting (the machinery of
odi-ball-model.py / t20-bowler-type.py: per-class Poisson rates, shrunk factors, the batter's and the bowler's own quality taken out) on
the matches to the end of 2023, once without the ball-age term under test and once with it, and scores both on the deliveries of 2024
on, for players the fit saw, as the multinomial log likelihood per ball over the ten classes. A term ships only if it wins.

  test      Test, men's, 2006+: the engine's ball-age factor (overs since the new ball, bins 0-4 ... 65+, new ball taken at 80 and 160)
            against the same plus age x bowler type (pace / spin): is a spinner better with the old ball and a seamer with the new?
  odi       ODI, men's, 2012+ (two new balls since 2011): the bowler-type factor (pace / spin, overs in 10s: the shipped model) against
            ten buckets (the first three overs, 4-10, then 10s): does the new ball of the first overs and the old one of the last
            add anything?
  odi-age   ODI: the number of overs the ball in use has bowled (over / 2 while two balls are in use, the last ten overs on the
            ball chosen at over 34: over - 17 from over 35 on) x pace / spin, by era (one ball to 2011, two since)
  t20       T20, men's: the bowler-type table's five buckets (overs 1-6, 7-10, 11-15, 16-18, 19-20: the shipped one) against eight
            (single overs 1-3 for the new ball, then as before): is the new ball's first over its own thing?

    python3 -I src/analysis/ball-age.py <test|odi|odi-age|t20> [--cut 2023]
"""
import json
import math
import re
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
REPO = ROOT.parent.parent
ESPN = ROOT / "data" / "scraped" / "espn-players.json"
TMP = Path(tempfile.mkdtemp())
DB = TMP / "age.duckdb"
CLASSES = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"]
K = 10
EXP = sys.argv[1]
CUT = int(sys.argv[sys.argv.index("--cut") + 1]) if "--cut" in sys.argv else 2023
A_CTX, A_PLAYER, A_X = 10.0, 20.0, 60.0
SWEEPS = 25
HALF_LIFE = 6.0


def run(sql, json_out=True):
    args = ["duckdb", str(DB)] + (["-json"] if json_out else [])
    # the statement goes in on stdin: a table of every player's effects does not fit on a command line
    p = subprocess.run(args, input="SET memory_limit='3GB'; SET threads=4; " + sql + "\n", capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"duckdb failed: {p.stderr}\n{sql[:600]}")
    rows = json.loads(p.stdout) if json_out and p.stdout.strip() else []
    num = re.compile(r"^-?\d+(\.\d+)?$")
    keep = lambda k: k == "lv" or k.endswith("_id")
    return [{k: (float(v) if num.match(v) and not keep(k) else v) if isinstance(v, str) else v for k, v in row.items()} for row in rows]


def style_type(s):
    s = (s or "").lower()
    if not s:
        return "unknown"
    if any(w in s for w in ("offbreak", "off-break", "legbreak", "leg-break", "orthodox", "wrist", "googly", "slow left", "chinaman")):
        return "spin"
    if any(w in s for w in ("fast", "medium")):
        return "pace"
    return "unknown"


styles_csv = TMP / "styles.csv"
with open(styles_csv, "w") as f:
    f.write("espn_id,btype\n")
    for x in json.load(open(ESPN)):
        p = x.get("profile") or {}
        bs = p.get("bowlingStyles") or []
        if p.get("espnId"):
            f.write(f"{int(p['espnId'])},{style_type(bs[0] if bs else '')}\n")

edges = lambda col, es: "(" + " + ".join(f"({col} >= {e})::INT" for e in es[1:]) + ")"
SET_EDGES = [0, 1, 5, 10, 20, 35, 60, 100]
AGE_BINS = [0, 5, 10, 20, 35, 50, 65]
RRR50 = [0, 3, 4, 5, 6, 7, 8, 9, 10, 12]
RRR20 = [0, 6, 7, 8, 9, 10, 11, 12, 14, 16]
bk = lambda col, bs: "CASE " + " ".join(f"WHEN {col} BETWEEN {a} AND {b} THEN {i}" for i, (a, b) in enumerate(bs)) + " END"

# base factors (SQL over b0) shared by both variants; `base_x` / `full_x` the factor under test (the shipped form / the candidate)
if EXP == "test":
    MATCH = "match_type='Test' AND gender='male' AND year(date) >= 2006"
    # b0 has: ov (over of the innings, 0-based), inn_no, legal_before (balls before in the innings)
    FACT = {
        "f_age": f"{edges('((ov % 80))', AGE_BINS)}",
        "f_set": edges("sb", SET_EDGES),
        "f_inn": "innings",
    }
    X_BASE = {"f_type": "bty"}
    X_FULL = {"f_type": f"bty * 10 + {edges('((ov % 80))', AGE_BINS)}"}
elif EXP == "odi":
    MATCH = "match_type='ODI' AND gender='male' AND year(date) >= 2012"
    FACT = {
        "f_over": "ov",
        "f_wk": "least(wk_before, 8)",
        "f_set": edges("sb", SET_EDGES),
        "f_chase": f"CASE WHEN innings=1 THEN -1 ELSE {edges('6.0*(inn_target_runs-score_before)/greatest(300-legal_before,1)', RRR50)} END",
    }
    X_BASE = {"f_type": f"bty * 10 + {bk('ov', [(0, 9), (10, 19), (20, 29), (30, 39), (40, 49)])}"}
    X_FULL = {"f_type": f"bty * 20 + {bk('ov', [(0, 2), (3, 9), (10, 14), (15, 19), (20, 24), (25, 29), (30, 34), (35, 39), (40, 44), (45, 49)])}"}
elif EXP == "odi-age":
    MATCH = "match_type='ODI' AND gender='male' AND year(date) >= 2005"
    FACT = {
        "f_over": "ov",
        "f_wk": "least(wk_before, 8)",
        "f_set": edges("sb", SET_EDGES),
        "f_chase": f"CASE WHEN innings=1 THEN -1 ELSE {edges('6.0*(inn_target_runs-score_before)/greatest(300-legal_before,1)', RRR50)} END",
    }
    X_BASE = {"f_type": f"bty * 10 + {bk('ov', [(0, 9), (10, 19), (20, 29), (30, 39), (40, 49)])}"}
    # ball age in overs: one ball to 2011 (age = over), two balls since (over/2 until 34, then the one ball chosen: over - 17), era-specific
    age = "CASE WHEN y < 2012 THEN ov WHEN ov < 34 THEN ov / 2 ELSE ov - 17 END"
    X_FULL = {"f_type": f"bty * 100 + (y >= 2012)::INT * 50 + ({age})"}
elif EXP == "t20":
    MATCH = "match_type IN ('T20','IT20') AND gender='male' AND balls_per_over=6 AND year(date) >= 2016"
    FACT = {
        "f_over": "ov",
        "f_wk": "least(wk_before, 8) * 10 + CASE WHEN ov < 6 THEN 0 WHEN ov < 15 THEN 1 ELSE 2 END",
        "f_set": edges("sb", [0, 1, 5, 10, 20, 35]),
        "f_chase": f"CASE WHEN innings=1 THEN -1 ELSE {edges('6.0*(inn_target_runs-score_before)/greatest(120-legal_before,1)', RRR20)} END",
        "f_era": "CASE WHEN y <= 2018 THEN 0 WHEN y <= 2022 THEN 1 ELSE 2 END",
        "f_comp": "comp",
    }
    X_BASE = {"f_type": f"bty * 10 + {bk('ov', [(0, 5), (6, 9), (10, 14), (15, 17), (18, 19)])}"}
    X_FULL = {"f_type": f"bty * 10 + {bk('ov', [(0, 0), (1, 1), (2, 5), (6, 9), (10, 14), (15, 17), (18, 19)])}"}
else:
    raise SystemExit("experiment: test | odi | odi-age | t20")

run(f"""
CREATE TABLE m AS SELECT * FROM '{DATA}/matches.parquet' WHERE {MATCH};
CREATE TABLE ptype AS SELECT p.cricsheet_id, coalesce(s.btype,'unknown') btype FROM '{DATA}/people.parquet' p
  LEFT JOIN read_csv('{styles_csv}', header=true) s ON s.espn_id = p.cricinfo_id;
CREATE TABLE raw AS
SELECT d.*, year(m.date) y, coalesce(m.event,'none') comp,   row_number() OVER (PARTITION BY d.match_id, d.innings ORDER BY d.over, d.ball, d.legal_ball_no) seq
FROM '{DATA}/deliveries.parquet' d JOIN m USING(match_id) WHERE d.super_over=0 AND d.innings IN (1,2,3,4);
CREATE TABLE b0 AS
SELECT match_id, innings, y, comp, "over" ov, batter_id, bowler_id,
  CASE WHEN wides>0 THEN 7 WHEN noballs>0 THEN 8 WHEN is_wicket=1 THEN 6 WHEN byes>0 OR legbyes>0 THEN 9
       WHEN runs_batter=0 THEN 0 WHEN runs_batter=1 THEN 1 WHEN runs_batter=2 THEN 2 WHEN runs_batter=3 THEN 3
       WHEN runs_batter IN (4,5) THEN 4 ELSE 5 END cls,
  coalesce(sum(is_wicket) OVER w, 0) wk_before, coalesce(sum(runs_total) OVER w, 0) score_before,
  coalesce(sum((wides=0 AND noballs=0)::INT) OVER w, 0) legal_before,
  coalesce(sum((wides=0)::INT) OVER (PARTITION BY match_id, innings, batter_id ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) sb,
  inn_target_runs,
  CASE (SELECT btype FROM ptype WHERE cricsheet_id = raw.bowler_id) WHEN 'pace' THEN 0 WHEN 'spin' THEN 1 ELSE 2 END AS bty
FROM raw WINDOW w AS (PARTITION BY match_id, innings ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING);
""", json_out=False)


# ── fit and score ───────────────────────────────────────────────────────
run(f"""CREATE TABLE b AS SELECT b0.*, {', '.join(f'({e}) AS {n}' for n, e in {**FACT, **X_BASE}.items())},
  {', '.join(f'({e}) AS {n}_x' for n, e in X_FULL.items())},
  pow(0.5, (2026 - y) / {HALF_LIFE}) AS w FROM b0;""", json_out=False)
print("balls:", run(f"SELECT count(*) n, sum((y > {CUT})::INT) AS n_after FROM b")[0], flush=True)


def fit(factors):
    rates = run(f"SELECT {', '.join(f'sum(w*(cls={k})::INT)/sum(w) r{k}' for k in range(K))} FROM b WHERE y <= {CUT}")[0]
    base = [rates[f"r{k}"] for k in range(K)]
    cols = ", ".join(sorted({f for f in factors} ))
    run(f"""CREATE OR REPLACE TABLE g AS SELECT cls, w, {', '.join(factors)}, {', '.join(f'{base[k]}::DOUBLE AS lam{k}' for k in range(K))}
      FROM b WHERE y <= {CUT} AND {' AND '.join(f'{f} IS NOT NULL' for f in factors)};""", json_out=False)
    eff = {f: defaultdict(lambda: [1.0] * K) for f in factors}
    for sweep in range(SWEEPS):
        worst = 0.0
        for f in factors:
            rows = run(f"SELECT {f} lv, {', '.join(f'sum(w*(cls={k})::INT) o{k}, sum(w*lam{k}) e{k}' for k in range(K))} FROM g GROUP BY 1")
            a = A_PLAYER if f.endswith("_id") else (A_X if f == "f_type" else A_CTX)
            ratio = []
            for row in rows:
                lv = row["lv"]
                old = eff[f][lv]
                new = []
                for k in range(K):
                    o = row[f"o{k}"] or 0.0
                    e_ex = (row[f"e{k}"] or 0.0) / old[k]
                    new.append((o + a) / (e_ex + a) if e_ex + a > 0 else 1.0)
                worst = max(worst, max(abs(math.log(new[k] / old[k])) for k in range(K)))
                eff[f][lv] = new
                ratio.append([lv] + [new[k] / old[k] for k in range(K)])
            vals = ",".join("(" + ("'" + x[0].replace("'", "''") + "'" if isinstance(x[0], str) else str(int(x[0]))) + "," + ",".join(f"{v:.10e}" for v in x[1:]) + ")" for x in ratio)
            run(f"""CREATE OR REPLACE TABLE rq AS SELECT * FROM (VALUES {vals}) t(lv, {', '.join(f'q{k}' for k in range(K))});
              CREATE OR REPLACE TABLE g AS SELECT g.* REPLACE ({', '.join(f'lam{k} * rq.q{k} AS lam{k}' for k in range(K))})
              FROM g JOIN rq ON rq.lv = g.{f};""", json_out=False)
        print(f"  sweep {sweep + 1}: {worst:.5f}", flush=True)
        if worst < 2e-3:
            break
    return base, eff


def score(base, eff, factors, xcol):
    """Per-ball multinomial log likelihood on the balls after CUT (a third of them) for batters and bowlers the fit saw"""
    names = [f if f != "f_type" else xcol for f in factors]
    rows = run(f"SELECT cls, {', '.join(names)} FROM b WHERE y > {CUT} AND (hash(match_id) % 3) = 0")
    ll = 0.0
    n = 0
    for row in rows:
        lam = list(base)
        ok = True
        for f, nm in zip(factors, names):
            lv = row[nm]
            lv = int(lv) if isinstance(lv, (int, float)) else lv
            if f.endswith("_id") and lv not in eff[f]:
                ok = False
                break
            v = eff[f].get(lv)
            if v is None:
                continue
            lam = [lam[k] * v[k] for k in range(K)]
        if not ok:
            continue
        ll += math.log(lam[row["cls"]] / sum(lam))
        n += 1
    return ll / n, n


results = {}
for label, xcol in (("base", "f_type"), ("full", "f_type_x")):
    factors = list(FACT) + ["f_type", "batter_id", "bowler_id"]
    if label == "full":
        run("ALTER TABLE b RENAME COLUMN f_type TO f_type_base; ALTER TABLE b RENAME COLUMN f_type_x TO f_type;", json_out=False)
    base, eff = fit(factors)
    ll, n = score(base, eff, factors, "f_type")
    results[label] = {"ll_per_ball": round(ll, 5), "balls": n}
    print(label, results[label], flush=True)
results["gain_per_1000_balls"] = round(1000 * (results["full"]["ll_per_ball"] - results["base"]["ll_per_ball"]), 3)
print(EXP, results, flush=True)
out = REPO / "docs" / "data" / "ball_age.json"
cur = json.load(open(out)) if out.exists() else {}
cur[EXP] = {"cut": CUT, **results}
json.dump(cur, open(out, "w"), indent=1)
