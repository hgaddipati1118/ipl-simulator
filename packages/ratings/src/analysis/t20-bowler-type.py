"""
Fit the T20 bowler-type x phase effects from Cricsheet ball-by-ball and write them as a generated engine table
(packages/engine/src/t20-bowler-type-data.ts) plus a report with the out-of-sample test (docs/data/t20_bowler_type.json).

What it replaces. matchups.ts `getPhaseModifier` held hand-set multipliers (a fast bowler 1.12 on wickets and 0.93 on economy in the
powerplay, a spinner 0.90 / 1.10, a part-timer 0.80 / 1.20 ...). Here every outcome class gets a fitted factor per bowler type and
phase of the innings, as the ODI model's `bowlerType` table does (odi-ball-model.py), with the batter's and the bowler's own quality,
the over, wickets down, balls the striker has faced, the chase, the era and the competition taken out:

    rate_k = base_k x over_k x wickets_k(down, phase) x set_k x chase_k x era_k x comp_k x type_k(bowler type, phase) x batter_k x bowler_k

fitted per gender as independent Poisson rates by iterative proportional fitting with Poisson-gamma shrinkage toward 1 (the
women's type factors toward the men's). Matches: T20 / IT20 of 6-ball overs, full 20-over innings; men's from 2016, women's from
2016; half-life 5 years. The type factors are normalised to mean 1 per type over the balls that type bowled, because the bowler
effect already carries a bowler's average quality: what the table says is how a type's effect moves with the phase, and a type's
level across the innings stays in the ratings (the engine's rating of a spinner already is his ability over the overs he bowls).

Out of sample (`--holdout`): the same fit on matches to the end of 2023; the factors are then scored on the balls of 2024 on, for
the players the fit had seen, as the per-ball log likelihood of the multinomial over the ten classes, against (a) no type factor and
(b) the former hand-set modifiers (wicket and dot weights). Run from packages/ratings (needs the duckdb CLI):

    python3 -I src/analysis/t20-bowler-type.py [--holdout] [--types 2|5|7] [--write]
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
OUT_TS = ROOT.parent / "engine" / "src" / "t20-bowler-type-data.ts"
OUT_REPORT = REPO / "docs" / "data" / "t20_bowler_type.json"
ESPN = ROOT / "data" / "scraped" / "espn-players.json"

TMP = Path(tempfile.mkdtemp())
DB = TMP / "t20.duckdb"

CLASSES = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"]
K = len(CLASSES)
HOLDOUT = "--holdout" in sys.argv
WRITE = "--write" in sys.argv
NTYPES = int((sys.argv[sys.argv.index("--types") + 1]) if "--types" in sys.argv else 5)
CUT = 2023  # holdout: fit to the end of this year
FIRST_YEAR = 2016
HALF_LIFE = 5.0
NOW = 2026
A_CTX, A_PLAYER, A_WOMEN, A_TYPE = 10.0, 20.0, 40.0, 60.0
SWEEPS = 30

# type sets by granularity: name list, and how a Cricinfo style string maps to one
TYPE_SETS = {
    2: ["pace", "spin"],
    5: ["fast", "medium", "offspin", "orthodox", "wrist"],
    7: ["fast", "medium", "leftpace", "offspin", "orthodox", "wrist", "leftmed"],
}
TYPES = TYPE_SETS[NTYPES]
BUCKETS = [(0, 5), (6, 9), (10, 14), (15, 17), (18, 19)]  # phase buckets of the type factor
BUCKET_NAMES = ["overs 1-6", "7-10", "11-15", "16-18", "19-20"]


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
    left = "left-arm" in s
    if any(w in s for w in ("legbreak", "leg-break", "wrist", "googly", "chinaman")):
        spin = "wrist"
    elif any(w in s for w in ("offbreak", "off-break")):
        spin = "offspin"
    elif any(w in s for w in ("orthodox", "slow left")):
        spin = "orthodox"
    else:
        spin = None
    if spin:
        return spin if NTYPES > 2 else "spin"
    if "fast-medium" in s or ("fast" in s and "medium-fast" not in s):
        kind = "fast"
    elif "medium" in s:
        kind = "medium"
    else:
        return "unknown"
    if NTYPES == 2:
        return "pace"
    if NTYPES == 7 and left:
        return "leftpace" if kind == "fast" else "leftmed"
    return kind


styles_csv = TMP / "styles.csv"
with open(styles_csv, "w") as f:
    f.write("espn_id,btype\n")
    for x in json.load(open(ESPN)):
        p = x.get("profile") or {}
        bs = p.get("bowlingStyles") or []
        if p.get("espnId"):
            f.write(f"{int(p['espnId'])},{style_type(bs[0] if bs else '')}\n")

TYPE_IDX = {t: i for i, t in enumerate(TYPES)}
NT = len(TYPES) + 1  # + unknown (part-timers and bowlers without a style: no factor, shrunk to 1 by the prior)
case_type = "CASE coalesce(pt.btype,'unknown') " + " ".join(f"WHEN '{t}' THEN {i}" for t, i in TYPE_IDX.items()) + f" ELSE {len(TYPES)} END"
bucket = "CASE " + " ".join(f"WHEN over BETWEEN {a} AND {b} THEN {i}" for i, (a, b) in enumerate(BUCKETS)) + " END"
SET_EDGES = [0, 1, 5, 10, 20, 35]
RRR_EDGES = [0, 6, 7, 8, 9, 10, 11, 12, 14, 16]
edges = lambda col, es: "(" + " + ".join(f"({col} >= {e})::INT" for e in es[1:]) + ")"

last_year = CUT if HOLDOUT else 2100
run(f"""
CREATE TABLE m AS SELECT * FROM '{DATA}/matches.parquet' WHERE match_type IN ('T20','IT20') AND balls_per_over=6 AND year(date) >= {FIRST_YEAR};
CREATE TABLE full_m AS
SELECT d.match_id FROM '{DATA}/deliveries.parquet' d JOIN m USING(match_id)
WHERE d.super_over=0 GROUP BY 1 HAVING min(d.inn_target_overs)=20 AND max(d.inn_target_overs)=20 AND max(d.over)<=19;
CREATE TABLE ptype AS
SELECT p.cricsheet_id, coalesce(s.btype, 'unknown') btype
FROM '{DATA}/people.parquet' p LEFT JOIN read_csv('{styles_csv}', header=true) s ON s.espn_id = p.cricinfo_id;
CREATE TABLE raw AS
SELECT d.*, m.gender, year(m.date) y, coalesce(m.event, 'none') comp,
  row_number() OVER (PARTITION BY d.match_id, d.innings ORDER BY d.over, d.ball, d.legal_ball_no) seq
FROM '{DATA}/deliveries.parquet' d JOIN m USING(match_id)
WHERE d.super_over=0 AND d.innings IN (1,2) AND d.match_id IN (SELECT match_id FROM full_m);
CREATE TABLE b0 AS
SELECT match_id, innings, gender, y, comp, over, batter_id, bowler_id,
  CASE WHEN wides>0 THEN 7 WHEN noballs>0 THEN 8 WHEN is_wicket=1 THEN 6 WHEN byes>0 OR legbyes>0 THEN 9
       WHEN runs_batter=0 THEN 0 WHEN runs_batter=1 THEN 1 WHEN runs_batter=2 THEN 2 WHEN runs_batter=3 THEN 3
       WHEN runs_batter IN (4,5) THEN 4 ELSE 5 END cls,
  coalesce(sum(is_wicket + (coalesce(retired_kind,'') NOT IN ('','retired hurt','retired not out'))::INT) OVER w, 0) wk_before,
  coalesce(sum(runs_total) OVER w, 0) score_before,
  coalesce(sum((wides=0 AND noballs=0)::INT) OVER w, 0) legal_before,
  coalesce(sum((wides=0)::INT) OVER (PARTITION BY match_id, innings, batter_id ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) sb,
  inn_target_runs
FROM raw WINDOW w AS (PARTITION BY match_id, innings ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING);
CREATE TABLE b AS
SELECT b0.*,
  over AS f_over,
  (least(wk_before, 8) * 10 + CASE WHEN over < 6 THEN 0 WHEN over < 15 THEN 1 ELSE 2 END)::INT AS f_wk,
  {edges('sb', SET_EDGES)} AS f_set,
  CASE WHEN innings=1 THEN -1 ELSE
    (CASE WHEN over < 6 THEN 0 WHEN over < 15 THEN 1 ELSE 2 END) * 100 + {edges('6.0*(inn_target_runs-score_before)/greatest(120-legal_before,1)', RRR_EDGES)} END AS f_chase,
  CASE WHEN y <= 2018 THEN 0 WHEN y <= 2022 THEN 1 ELSE 2 END AS f_era,
  comp AS f_comp,
  ({case_type}) * 10 + {bucket} AS f_bt,
  pow(0.5, ({NOW} - y) / {HALF_LIFE}) AS w
FROM b0 LEFT JOIN ptype pt ON pt.cricsheet_id = b0.bowler_id;
""", json_out=False)

sample = run("SELECT gender, count(*) deliveries, count(DISTINCT match_id) matches, sum((y>2023)::INT) after_2023 FROM b GROUP BY 1")
print("sample:", sample, flush=True)

FACTORS = ["f_over", "f_wk", "f_set", "f_chase", "f_era", "f_comp", "f_bt", "batter_id", "bowler_id"]
CTX = FACTORS[:7]


def fit(gender, prior=None):
    tr = f"y <= {last_year}"
    rates = run(f"SELECT {', '.join(f'sum(w*(cls={k})::INT)/sum(w) r{k}' for k in range(K))} FROM b WHERE gender='{gender}' AND {tr}")[0]
    base = [rates[f"r{k}"] for k in range(K)]
    run(f"""CREATE OR REPLACE TABLE g AS SELECT match_id, innings, y, cls, w, {', '.join(FACTORS)},
      {', '.join(f'{base[k]}::DOUBLE AS lam{k}' for k in range(K))} FROM b WHERE gender='{gender}' AND {tr};""", json_out=False)
    eff = {f: defaultdict(lambda: [1.0] * K) for f in FACTORS}
    for sweep in range(SWEEPS):
        worst, worst_f = 0.0, ""
        for f in FACTORS:
            rows = run(f"SELECT {f} lv, count(*) n, {', '.join(f'sum(w*(cls={k})::INT) o{k}, sum(w*lam{k}) e{k}' for k in range(K))} FROM g GROUP BY 1")
            a = A_PLAYER if f in ("batter_id", "bowler_id") else (A_TYPE if f == "f_bt" else A_CTX)
            if prior and f == "f_bt":
                a = A_WOMEN
            ratio = []
            for row in rows:
                lv = row["lv"]
                old = eff[f][lv]
                new = []
                for k in range(K):
                    o = row[f"o{k}"] or 0.0
                    e_ex = (row[f"e{k}"] or 0.0) / old[k]
                    target = prior[f].get(str(lv), [1.0] * K)[k] if prior and f == "f_bt" else 1.0
                    new.append((o + a * target) / (e_ex + a) if e_ex + a > 0 else 1.0)
                ch = max(abs(math.log(new[k] / old[k])) for k in range(K))
                if ch > worst:
                    worst, worst_f = ch, f
                eff[f][lv] = new
                ratio.append([lv] + [new[k] / old[k] for k in range(K)])
            vals = ",".join("(" + ("'" + x[0].replace("'", "''") + "'" if isinstance(x[0], str) else str(int(x[0]))) + "," + ",".join(f"{v:.10e}" for v in x[1:]) + ")" for x in ratio)
            cols = ", ".join(f"q{k}" for k in range(K))
            run(f"""CREATE OR REPLACE TABLE rq AS SELECT * FROM (VALUES {vals}) t(lv, {cols});
              CREATE OR REPLACE TABLE g AS SELECT g.* REPLACE ({', '.join(f'lam{k} * rq.q{k} AS lam{k}' for k in range(K))})
              FROM g JOIN rq ON rq.lv = g.{f};""", json_out=False)
        print(f"  {gender} sweep {sweep + 1}: max log change {worst:.5f} ({worst_f})", flush=True)
        if worst < 1e-3:
            break
    return base, eff


def type_table(gender, eff):
    """Type factors normalised to mean 1 per type over the balls it bowled -> [type][bucket][class]"""
    rows = run(f"SELECT f_bt lv, count(*) n FROM g GROUP BY 1")
    n = {int(row["lv"]): row["n"] for row in rows}
    out = []
    for t in range(NT):
        lvs = [t * 10 + b for b in range(len(BUCKETS)) if (t * 10 + b) in n]
        tot = sum(n[lv] for lv in lvs) or 1
        mean = [math.exp(sum(n[lv] * math.log(eff["f_bt"][str(lv) if str(lv) in eff["f_bt"] else lv][k]) for lv in lvs) / tot) if lvs else 1.0 for k in range(K)]
        row = []
        for b in range(len(BUCKETS)):
            lv = t * 10 + b
            e = eff["f_bt"].get(lv) if lv in eff["f_bt"] else None
            row.append([round((e[k] / mean[k]) if e else 1.0, 4) for k in range(K)])
        out.append(row)
    return out


def score_holdout(gender, eff, table):
    """Per-ball log likelihood on balls after CUT for players the fit saw: (a) no type factor, (b) the fitted table, (c) the former hand-set modifiers"""
    # context + player factors from the fit (without the type factor); type factor applied from `table` / the old rule
    ctx = {}
    for f in CTX:
        if f == "f_bt":
            continue
        for lv, v in eff[f].items():
            ctx[(f, str(lv))] = v
    pl = {}
    for f in ("batter_id", "bowler_id"):
        for lv, v in eff[f].items():
            pl[(f, str(lv))] = v
    base = run(f"SELECT {', '.join(f'sum(w*(cls={k})::INT)/sum(w) r{k}' for k in range(K))} FROM b WHERE gender='{gender}' AND y <= {CUT}")[0]
    base = [base[f"r{k}"] for k in range(K)]
    rows = run(f"""SELECT cls, f_over, f_wk, f_set, f_chase, f_era, f_comp, f_bt, batter_id, bowler_id, over, coalesce(pt.btype,'unknown') bty
      FROM b JOIN ptype pt ON pt.cricsheet_id = b.bowler_id WHERE gender='{gender}' AND y > {CUT}""")
    ll = {"none": 0.0, "fitted": 0.0, "old": 0.0}
    n = 0
    old_mod = old_modifiers()
    for row in rows:
        keys = [("f_over", row["f_over"]), ("f_wk", row["f_wk"]), ("f_set", row["f_set"]), ("f_chase", row["f_chase"]), ("f_era", row["f_era"]), ("f_comp", row["f_comp"])]
        try:
            fs = [ctx[(f, str(int(v)) if isinstance(v, (int, float)) else v)] for f, v in keys]
            fb = pl[("batter_id", row["batter_id"])]
            fw = pl[("bowler_id", row["bowler_id"])]
        except KeyError:
            continue
        lam = [base[k] for k in range(K)]
        for v in fs + [fb, fw]:
            lam = [lam[k] * v[k] for k in range(K)]
        t, bk = int(row["f_bt"]) // 10, int(row["f_bt"]) % 10
        fit_m = table[t][bk] if t < len(table) else [1.0] * K
        old_m = old_mod(row["bty"], row["over"])
        def lp(m):
            x = [lam[k] * m[k] for k in range(K)]
            return math.log(x[row["cls"]] / sum(x))
        ll["none"] += lp([1.0] * K)
        ll["fitted"] += lp(fit_m)
        ll["old"] += lp(old_m)
        n += 1
    return {k: round(v / n, 5) for k, v in ll.items()}, n


def old_modifiers():
    """matchups.ts getPhaseModifier as outcome-class multipliers (wicket x wicketMod, dot / economyMod), by Cricinfo type and over"""
    table = {
        "pp": {"fast": (1.12, 0.93), "medium": (1.05, 0.97), "spin": (0.90, 1.10)},
        "mid": {"fast": (0.95, 1.05), "medium": (0.93, 1.03), "spin": (1.12, 0.90)},
        "death": {"fast": (1.08, 0.90), "medium": (1.00, 0.97), "spin": (0.85, 1.15)},
    }
    def mod(bty, over):
        ph = "pp" if over < 6 else "mid" if over < 15 else "death"
        kind = "spin" if bty in ("spin", "offspin", "orthodox", "wrist") else "fast" if bty in ("fast",) else "medium" if bty in ("medium", "pace", "leftpace", "leftmed") else None
        if bty == "pace":
            kind = "medium"
        m = [1.0] * K
        if kind:
            wk, eco = table[ph][kind]
            m[6] = wk
            m[0] = 1 / eco
        return m
    return mod


report = {"types": TYPES, "buckets": BUCKET_NAMES, "classes": CLASSES, "sample": sample, "holdout": HOLDOUT, "cut": CUT}
model = {}
prior = None
for gender in ("male", "female"):
    print("fitting", gender, flush=True)
    base, eff = fit(gender, prior)
    table = type_table(gender, eff)
    if gender == "male":
        prior = {"f_bt": {str(lv): v for lv, v in eff["f_bt"].items()}}
    model[gender] = table
    report[gender] = {"table": table}
    if HOLDOUT:
        res, nb = score_holdout(gender, eff, table)
        report[gender]["holdout_ll_per_ball"] = res
        report[gender]["holdout_balls"] = nb
        print(gender, "holdout log lik per ball", res, "on", nb, "balls", flush=True)

tag = f"_{NTYPES}types" + ("_holdout" if HOLDOUT else "")
path = REPO / "docs" / "data" / f"t20_bowler_type{tag}.json"
path.write_text(json.dumps(report, indent=1))
print("wrote", path)
if WRITE and not HOLDOUT:
    ts = ["/** Generated by packages/ratings/src/analysis/t20-bowler-type.py (docs/data/t20_bowler_type_*.json). Do not edit. */",
          f"export const T20_TYPES = {json.dumps(TYPES + ['unknown'])} as const;",
          f"export const T20_TYPE_BUCKETS = {json.dumps(BUCKETS)} as const;",
          "/** [type][phase bucket][ball class: dot, 1, 2, 3, 4, 6, wicket, wide, noball, legbye] */",
          "export const T20_BOWLER_TYPE: Record<\"male\" | \"female\", number[][][]> = " + json.dumps(model) + ";", ""]
    OUT_TS.write_text("\n".join(ts))
    print("wrote", OUT_TS)
