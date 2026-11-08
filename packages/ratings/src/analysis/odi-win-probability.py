"""
Fit the ODI win-probability model from Cricsheet ODIs and write it as a generated engine table
(packages/engine/src/odi-win-probability-data.ts) plus a calibration report (docs/data/odi_win_probability.json).

Inputs (read-only): data/analysis/deliveries.parquet, matches.parquet (match_type 'ODI'). Needs the `duckdb` CLI.
Run from packages/ratings:  python3 -I src/analysis/odi-win-probability.py

Model (per gender; full 50-over matches with a result, 2015+, every delivery a state):
  expected runs still to come  E = G x R(u, w) / 100   (R = the Duckworth-Lewis resources of dls.ts, u overs left, w down;
                                                       G = the average first-innings total)
  chase:        P(chaser wins)        = sigmoid(a_k + b_k (E - N) / sqrt(E + c))     N = runs still needed,
                                       k = the stage by overs left (STAGES: the end of a chase is sharper than its start)
  first innings P(batting side wins)  = sigmoid(a1 + b1 (S + E - G) / sd)        S = runs so far, sd = sd of first-innings totals
The parameters are fitted by maximum likelihood (Newton steps on the grouped states; c by a grid). Ties and no results are
left out.
"""
import json
import math
import re
import subprocess
import tempfile
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
REPO = ROOT.parent.parent
OUT_TS = ROOT.parent / "engine" / "src" / "odi-win-probability-data.ts"
OUT_REPORT = REPO / "docs" / "data" / "odi_win_probability.json"
DB = Path(tempfile.mkdtemp()) / "wp.duckdb"
FROM_YEAR = 2015
# chase stages by overs left: [lo, hi)
STAGES = [(0, 2), (2, 5), (5, 10), (10, 20), (20, 35), (35, 51)]

# dls.ts: Standard Edition resources
DLS_B = 0.0274093
DLS_F = [1.0, 0.88475, 0.7599, 0.63049, 0.50001, 0.3753, 0.26175, 0.16402, 0.08878, 0.03506]


def resources50(u, w):
    if w >= 10 or u <= 0:
        return 0.0
    u = min(50.0, u)
    f = DLS_F[w]
    return 100 * f * (1 - math.exp(-DLS_B * u / f)) / (1 - math.exp(-DLS_B * 50))


def run(sql):
    p = subprocess.run(["duckdb", str(DB), "-json", "-c", "SET memory_limit='2GB'; SET threads=4; " + sql], capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"duckdb failed: {p.stderr}\n{sql[:400]}")
    rows = json.loads(p.stdout) if p.stdout.strip() else []
    num = re.compile(r"^-?\d+(\.\d+)?$")
    return [{k: (float(v) if isinstance(v, str) and num.match(v) else v) for k, v in row.items()} for row in rows]


def sigmoid(x):
    return 1 / (1 + math.exp(-max(-30, min(30, x))))


def fit_logistic(groups, iters=50):
    """groups: [(x, n, wins)] -> (a, b) maximising the binomial likelihood of sigmoid(a + b x)"""
    a, b = 0.0, 1.0
    for _ in range(iters):
        ga = gb = haa = hab = hbb = 0.0
        for x, n, k in groups:
            p = sigmoid(a + b * x)
            r = k - n * p
            w = n * p * (1 - p)
            ga += r; gb += r * x
            haa += w; hab += w * x; hbb += w * x * x
        det = haa * hbb - hab * hab
        if det <= 0:
            break
        da = (hbb * ga - hab * gb) / det
        db = (haa * gb - hab * ga) / det
        a += da; b += db
        if abs(da) + abs(db) < 1e-9:
            break
    ll = sum(k * math.log(max(1e-12, sigmoid(a + b * x))) + (n - k) * math.log(max(1e-12, 1 - sigmoid(a + b * x))) for x, n, k in groups)
    return a, b, ll


run(f"""
CREATE TABLE s AS
WITH m AS (SELECT * FROM '{DATA}/matches.parquet' WHERE match_type='ODI' AND year(date) >= {FROM_YEAR} AND winner IS NOT NULL),
full_m AS (SELECT match_id FROM '{DATA}/deliveries.parquet' WHERE innings=2 AND super_over=0 GROUP BY 1
           HAVING min(inn_target_overs)=50 AND max(inn_target_overs)=50),
d AS (SELECT d.*, m.gender, m.winner,
        row_number() OVER (PARTITION BY d.match_id, d.innings ORDER BY d.over, d.ball, d.legal_ball_no) seq
      FROM '{DATA}/deliveries.parquet' d JOIN m USING(match_id)
      WHERE d.super_over=0 AND d.innings IN (1,2) AND d.match_id IN (SELECT match_id FROM full_m))
SELECT match_id, innings, gender, (winner = batting_team)::INT AS bat_won, inn_target_runs AS target,
  coalesce(sum(runs_total) OVER w, 0) AS score,
  coalesce(sum((wides=0 AND noballs=0)::INT) OVER w, 0) AS legal,
  coalesce(sum(is_wicket) OVER w, 0) AS wk
FROM d WINDOW w AS (PARTITION BY match_id, innings ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING);
""")

report = {"generated": date.today().isoformat(), "from": FROM_YEAR, "source": "Cricsheet ODIs, full 50-over matches with a result, every delivery a state"}
model = {}
for gender in ("male", "female"):
    # the first innings' final total is the chase target - 1
    fin = run(f"""SELECT avg(target - 1) g, stddev(target - 1) sd, count(DISTINCT match_id) n FROM s WHERE gender='{gender}' AND innings=2""")[0]
    G, SD = fin["g"], fin["sd"]
    states = run(f"""SELECT innings, score, legal, wk, target, bat_won, count(*) n FROM s WHERE gender='{gender}' AND wk < 10 AND legal < 300 GROUP BY ALL""")
    chase = [(r["score"], r["legal"], int(r["wk"]), r["target"], r["bat_won"], r["n"]) for r in states if r["innings"] == 2 and r["target"]]
    first = [(r["score"], r["legal"], int(r["wk"]), r["bat_won"], r["n"]) for r in states if r["innings"] == 1]

    # chase: grid over c, Newton for (a_k, b_k) per stage on states grouped by rounded x
    def stage_of(overs_left):
        return next(i for i, (lo, hi) in enumerate(STAGES) if lo <= overs_left < hi)
    best = None
    for c in (0, 2, 5, 10, 25, 50, 100):
        g = [defaultdict(lambda: [0, 0]) for _ in STAGES]
        for score, legal, wk, target, won, n in chase:
            need = target - score
            if need <= 0:
                continue
            u = (300 - legal) / 6
            E = G * resources50(u, wk) / 100
            x = round((E - need) / math.sqrt(E + c + 1e-9), 2)
            cell = g[stage_of(u)][x]
            cell[0] += n; cell[1] += won * n
        fits = []
        for gk in g:
            groups_k = [(x, v[0], v[1]) for x, v in gk.items()]
            fits.append((*fit_logistic(groups_k), groups_k))
        ll = sum(f[2] for f in fits)
        if best is None or ll > best[1]:
            best = (c, ll, fits)
    c, ll, fits = best
    a = [f[0] for f in fits]
    b = [f[1] for f in fits]
    # first innings: projected total against G
    g1 = defaultdict(lambda: [0, 0])
    for score, legal, wk, won, n in first:
        E = G * resources50((300 - legal) / 6, wk) / 100
        x = round((score + E - G) / SD, 2)
        g1[x][0] += n; g1[x][1] += won * n
    groups1 = [(x, v[0], v[1]) for x, v in g1.items()]
    a1, b1, ll1 = fit_logistic(groups1)

    # calibration: predicted against actual by tenths of predicted probability
    def calib(groupsx, f):
        bins = defaultdict(lambda: [0.0, 0, 0])
        for x, n, k in groupsx:
            p = f(x)
            i = min(9, int(p * 10))
            bins[i][0] += p * n; bins[i][1] += n; bins[i][2] += k
        return [{"bin": f"{i * 10}-{i * 10 + 10}%", "predicted": round(v[0] / v[1], 3), "actual": round(v[2] / v[1], 3), "states": v[1]} for i, v in sorted(bins.items())]

    key = "men" if gender == "male" else "women"
    model[key] = {"g": round(G, 1), "sd": round(SD, 1),
                  "chase": {"stages": [lo for lo, _ in STAGES], "a": [round(x, 4) for x in a], "b": [round(x, 4) for x in b], "c": c},
                  "first": {"a": round(a1, 4), "b": round(b1, 4)}}
    report[key] = {**model[key], "matches": int(fin["n"]),
                   "calibrationChaseByStage": {f"{lo}-{hi} overs left": calib(f[3], lambda x, f=f: sigmoid(f[0] + f[1] * x)) for (lo, hi), f in zip(STAGES, fits)},
                   "calibrationFirst": calib(groups1, lambda x: sigmoid(a1 + b1 * x))}
    print(key, json.dumps(model[key]))

OUT_TS.write_text(f'''/**
 * GENERATED by packages/ratings/src/analysis/odi-win-probability.py from Cricsheet ODIs ({FROM_YEAR}+, full matches with a
 * result; every delivery a state). Do not edit by hand. Generated {date.today().isoformat()}.
 *
 * E = g x R(u, w) / 100, the runs still to come at the average scoring level (R = dls.ts resources50, u overs left, w down).
 *   chase:          P(chaser wins)       = sigmoid(chase.a[k] + chase.b[k] (E - runs needed) / sqrt(E + chase.c)),
 *                   k = the stage: the last of chase.stages (overs left, ascending) not above the overs left
 *   first innings:  P(batting side wins) = sigmoid(first.a + first.b (runs + E - g) / sd)
 * Calibration tables: docs/data/odi_win_probability.json.
 */
export interface OdiWinProbabilityModel {{
  /** Average first-innings total and its sd */
  g: number;
  sd: number;
  chase: {{ stages: number[]; a: number[]; b: number[]; c: number }};
  first: {{ a: number; b: number }};
}}

export const ODI_WIN_PROBABILITY: Record<"men" | "women", OdiWinProbabilityModel> = {json.dumps(model, indent=2)};
''')
OUT_REPORT.write_text(json.dumps(report, indent=1))
print("wrote", OUT_TS, OUT_REPORT)
