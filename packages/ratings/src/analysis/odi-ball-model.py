"""
Fit the ODI (50-over) ball model from Cricsheet ODI ball-by-ball data and write it as a generated engine table
(packages/engine/src/odi-model-data.ts), plus the real-ODI validation targets and national player pools the
benchmark replays (docs/data/odi_validation.json) and a report (docs/data/odi_ball_model.json).

Inputs (read-only): data/analysis/deliveries.parquet, matches.parquet (match_type 'ODI'), people.parquet (Cricsheet id ->
                    Cricinfo id), data/scraped/espn-players.json (bowling styles).
Needs the `duckdb` CLI on PATH. Run from packages/ratings:  python3 -I src/analysis/odi-ball-model.py

Model. Each delivery's outcome class (dot, 1, 2, 3, 4, 6, wicket, wide, no-ball, bye / leg bye) has a rate

    rate_k = base_k x over_k x wickets_k(wickets down, overs bucket) x set_k(balls the striker has faced)
             x chase_k(required rate, stage | first innings) x era_k x bowlerType_k(pace / spin, overs bucket)
             x batter_k x bowler_k

fitted per gender as independent Poisson rates by iterative proportional fitting (each factor's level matched to its
observed count, Poisson-gamma shrinkage toward 1; women's context factors shrink toward the men's). The batter and bowler
effects take the players' quality out of the context effects (a side 7 down has its tail in: that is the batters, not
the situation), and are not exported: the engine gets player quality from ratings. Their spread is reported so the
engine's rating effects can be scaled to it. Matches: full 50-over matches (no rain revision), men 2012+ (a new ball
from each end since October 2011), women 2010+; recent seasons weigh more (half-life 6 years); every context factor is
normalised to mean 1 over the 2019+ deliveries, so base_k is the 2019+ average rate.
"""
import json
import math
import os
import re
import subprocess
import tempfile
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
REPO = ROOT.parent.parent
OUT_TS = ROOT.parent / "engine" / "src" / "odi-model-data.ts"
OUT_REPORT = REPO / "docs" / "data" / "odi_ball_model.json"
OUT_VALID = REPO / "docs" / "data" / "odi_validation.json"
ESPN = ROOT / "data" / "scraped" / "espn-players.json"

TMP = Path(tempfile.mkdtemp())
DB = TMP / "odi.duckdb"

CLASSES = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"]
K = len(CLASSES)
GENDERS = ("male", "female")
FIRST_YEAR = {"male": 2012, "female": 2010}
VALID_FROM = 2019
HALF_LIFE = 6.0
NOW = 2026

OVER_BUCKETS = [(0, 9), (10, 19), (20, 29), (30, 39), (40, 44), (45, 49)]
TYPE_BUCKETS = [(0, 9), (10, 19), (20, 29), (30, 39), (40, 49)]
WKT_LEVELS = 9   # 0..7 down, 8+
SET_EDGES = [0, 1, 5, 10, 20, 35, 60, 100]  # balls faced before this ball: 0, 1-4, 5-9, 10-19, 20-34, 35-59, 60-99, 100+
RRR_EDGES = [0, 3, 4, 5, 6, 7, 8, 9, 10, 12]  # required rate buckets: <3, 3-4, ..., 10-12, 12+
STAGES = [(0, 19), (20, 34), (35, 44), (45, 49)]
ERAS = [("2010-14", 2010, 2014), ("2015-18", 2015, 2018), ("2019-26", 2019, 2026)]

# Pseudo-events of shrinkage toward 1 (context, players) and, for the women's context factors, toward the men's
A_CTX, A_PLAYER, A_WOMEN = 10.0, 20.0, 40.0
SWEEPS = 40


def run(sql, json_out=True):
    args = ["duckdb", str(DB)] + (["-json"] if json_out else []) + ["-c", "SET memory_limit='2GB'; SET threads=4; " + sql]
    p = subprocess.run(args, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"duckdb failed: {p.stderr}\n{sql[:600]}")
    rows = json.loads(p.stdout) if json_out and p.stdout.strip() else []
    # DuckDB writes HUGEINT sums as strings; ids (lv, *_id) stay strings even when they look numeric
    num = re.compile(r"^-?\d+(\.\d+)?$")
    keep = lambda k: k == "lv" or k.endswith("_id")
    return [{k: (float(v) if num.match(v) and not keep(k) else v) if isinstance(v, str) else v for k, v in row.items()} for row in rows]


def r(x, n=4):
    return round(float(x), n)


def bucket_sql(col, buckets):
    return "CASE " + " ".join(f"WHEN {col} BETWEEN {a} AND {b} THEN {i}" for i, (a, b) in enumerate(buckets)) + " END"


def edges_sql(col, edges):
    # index of the last edge <= col
    return "(" + " + ".join(f"({col} >= {e})::INT" for e in edges[1:]) + ")"


# ── bowling styles: Cricinfo profile -> pace / spin ─────────────────────
def style_type(s):
    s = (s or "").lower()
    if not s:
        return "unknown"
    if any(w in s for w in ("offbreak", "off-break", "legbreak", "leg-break", "orthodox", "wrist", "googly", "slow left")):
        return "spin"
    if any(w in s for w in ("fast", "medium")):
        return "pace"
    return "unknown"


styles_csv = TMP / "styles.csv"
with open(styles_csv, "w") as f:
    f.write("espn_id,btype\n")
    if ESPN.exists():
        for x in json.load(open(ESPN)):
            p = x.get("profile") or {}
            bs = p.get("bowlingStyles") or []
            if p.get("espnId"):
                f.write(f"{int(p['espnId'])},{style_type(bs[0] if bs else '')}\n")

# ── delivery table ─────────────────────────────────────────────────────
run(f"""
CREATE TABLE m AS SELECT * FROM '{DATA}/matches.parquet' WHERE match_type='ODI';
CREATE TABLE full_m AS
SELECT d.match_id FROM '{DATA}/deliveries.parquet' d JOIN m USING(match_id)
WHERE d.innings=2 AND d.super_over=0 GROUP BY 1 HAVING min(d.inn_target_overs)=50 AND max(d.inn_target_overs)=50;
CREATE TABLE ptype AS
SELECT p.cricsheet_id, coalesce(s.btype, 'unknown') btype, p.cricinfo_id
FROM '{DATA}/people.parquet' p LEFT JOIN read_csv('{styles_csv}', header=true) s ON s.espn_id = p.cricinfo_id;
CREATE TABLE raw AS
SELECT d.*, m.gender, year(m.date) y, m.date, m.team1, m.team2, m.winner, m.result, m.outcome_method, m.stage, m.event,
  d.match_id IN (SELECT match_id FROM full_m) AS full_match,
  row_number() OVER (PARTITION BY d.match_id, d.innings ORDER BY d.over, d.ball, d.legal_ball_no) seq
FROM '{DATA}/deliveries.parquet' d JOIN m USING(match_id)
WHERE d.super_over=0 AND d.innings IN (1,2);
CREATE TABLE b0 AS
SELECT match_id, innings, gender, y, over, batter_id, bowler_id, full_match,
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
  (least(wk_before, 8) * 10 + {bucket_sql('over', OVER_BUCKETS)})::INT AS f_wk,
  {edges_sql('sb', SET_EDGES)} AS f_set,
  CASE WHEN innings=1 THEN -1 ELSE
    {bucket_sql('over', STAGES)} * 100 + {edges_sql('6.0*(inn_target_runs-score_before)/greatest(300-legal_before,1)', RRR_EDGES)} END AS f_chase,
  CASE {" ".join(f"WHEN y BETWEEN {a} AND {b_} THEN {i}" for i, (_, a, b_) in enumerate(ERAS))} END AS f_era,
  (CASE coalesce(pt.btype,'unknown') WHEN 'pace' THEN 0 WHEN 'spin' THEN 1 ELSE 2 END) * 10 + {bucket_sql('over', TYPE_BUCKETS)} AS f_bt,
  pow(0.5, ({NOW} - y) / {HALF_LIFE}) AS w
FROM b0 LEFT JOIN ptype pt ON pt.cricsheet_id = b0.bowler_id
WHERE full_match AND ((gender='male' AND y >= {FIRST_YEAR['male']}) OR (gender='female' AND y >= {FIRST_YEAR['female']}));
""", json_out=False)

sample = run("SELECT gender, count(*) deliveries, count(DISTINCT match_id) matches, sum((y>=2019)::INT) deliveries_2019 FROM b GROUP BY 1")
print("sample:", sample)

FACTORS = ["f_over", "f_wk", "f_set", "f_chase", "f_era", "f_bt", "batter_id", "bowler_id"]
CTX = FACTORS[:6]
LAM = [f"lam{k}" for k in range(K)]


def fit(gender, prior=None):
    """IPF for one gender. prior: the men's context effects (women shrink toward them)."""
    rates = run(f"SELECT {', '.join(f'sum(w*(cls={k})::INT)/sum(w) r{k}' for k in range(K))} FROM b WHERE gender='{gender}'")[0]
    base = [rates[f"r{k}"] for k in range(K)]
    run(f"""CREATE OR REPLACE TABLE g AS SELECT match_id, innings, y, cls, w, {', '.join(FACTORS)},
      {', '.join(f'{base[k]}::DOUBLE AS lam{k}' for k in range(K))} FROM b WHERE gender='{gender}';""", json_out=False)
    eff = {f: defaultdict(lambda: [1.0] * K) for f in FACTORS}
    for sweep in range(SWEEPS):
        worst, worst_f = 0.0, ""
        for f in FACTORS:
            rows = run(f"SELECT {f} lv, count(*) n, {', '.join(f'sum(w*(cls={k})::INT) o{k}, sum(w*lam{k}) e{k}' for k in range(K))} FROM g GROUP BY 1")
            a = A_PLAYER if f in ("batter_id", "bowler_id") else (A_WOMEN if prior else A_CTX)
            ratio = []
            for row in rows:
                lv = row["lv"]
                old = eff[f][lv]
                new = []
                for k in range(K):
                    o = row[f"o{k}"] or 0.0
                    e_ex = (row[f"e{k}"] or 0.0) / old[k]  # expected without this factor's effect
                    target = prior[f].get(str(lv), [1.0] * K)[k] if prior and f in CTX else 1.0
                    new.append((o + a * target) / (e_ex + a) if e_ex + a > 0 else 1.0)
                ch = max(abs(math.log(new[k] / old[k])) for k in range(K))
                if ch > worst:
                    worst, worst_f = ch, f
                eff[f][lv] = new
                ratio.append([lv] + [new[k] / old[k] for k in range(K)])
            vals = ",".join("(" + (f"'{x[0]}'" if isinstance(x[0], str) else str(int(x[0]))) + "," + ",".join(f"{v:.10e}" for v in x[1:]) + ")" for x in ratio)
            cols = ", ".join(f"q{k}" for k in range(K))
            run(f"""CREATE OR REPLACE TABLE rq AS SELECT * FROM (VALUES {vals}) t(lv, {cols});
              CREATE OR REPLACE TABLE g AS SELECT g.* REPLACE ({', '.join(f'lam{k} * rq.q{k} AS lam{k}' for k in range(K))})
              FROM g JOIN rq ON rq.lv = g.{f};""", json_out=False)
        print(f"  {gender} sweep {sweep + 1}: max log change {worst:.5f} ({worst_f})", flush=True)
        if worst < 1e-3:
            break
    return base, eff


def normalise(gender, base, eff):
    """Context factors to mean 1 over the 2019+ deliveries (bowler type: per type), base = 2019+ rate."""
    out = {}
    for f in CTX:
        e = eff[f]
        rows = run(f"SELECT {f} lv, count(*) n FROM g WHERE y >= {VALID_FROM} GROUP BY 1")
        n = {row["lv"]: row["n"] for row in rows}
        if f == "f_era":
            ref = e[ERAS.index(next(x for x in ERAS if x[1] == VALID_FROM))]
            out[f] = {lv: [v[k] / ref[k] for k in range(K)] for lv, v in e.items()}
            continue
        if f == "f_bt":
            norm = {}
            for t in range(3):
                lvs = [lv for lv in n if lv // 10 == t]
                tot = sum(n[lv] for lv in lvs) or 1
                norm[t] = [sum(n[lv] * e[lv][k] for lv in lvs) / tot if lvs else 1.0 for k in range(K)]
            out[f] = {lv: [v[k] / norm[lv // 10][k] for k in range(K)] for lv, v in e.items()}
            continue
        tot = sum(n.values())
        mean = [sum(n[lv] * e[lv][k] for lv in n) / tot for k in range(K)]
        out[f] = {lv: [v[k] / mean[k] for k in range(K)] for lv, v in e.items()}
    # base: the 2019+ observed rate over the model's normalised prediction without the base, with players as fitted
    pred = {}
    vals = []
    for f in CTX:
        for lv, v in out[f].items():
            vals.append(f"('{f}',{int(lv)},{','.join(f'{x:.10e}' for x in v)})")
    run(f"CREATE OR REPLACE TABLE ce AS SELECT * FROM (VALUES {','.join(vals)}) t(f, lv, {', '.join(f'c{k}' for k in range(K))});", json_out=False)
    pe = []
    for f in ("batter_id", "bowler_id"):
        for lv, v in eff[f].items():
            pe.append(f"('{f}','{lv}',{','.join(f'{x:.10e}' for x in v)})")
    run(f"CREATE OR REPLACE TABLE pe AS SELECT * FROM (VALUES {','.join(pe)}) t(f, lv, {', '.join(f'p{k}' for k in range(K))});", json_out=False)
    joins = " ".join(f"JOIN ce c_{f[2:]} ON c_{f[2:]}.f='{f}' AND c_{f[2:]}.lv=g.{f}" for f in CTX)
    prod = lambda k: "*".join(f"c_{f[2:]}.c{k}" for f in CTX)
    rows = run(f"""SELECT {', '.join(f'sum((g.cls={k})::INT) o{k}, sum({prod(k)} * bt_.p{k} * bw_.p{k}) e{k}' for k in range(K))}
      FROM g {joins} JOIN pe bt_ ON bt_.f='batter_id' AND bt_.lv=g.batter_id JOIN pe bw_ ON bw_.f='bowler_id' AND bw_.lv=g.bowler_id
      WHERE g.y >= {VALID_FROM}""")[0]
    pred["base"] = [rows[f"o{k}"] / rows[f"e{k}"] for k in range(K)]
    obs = run(f"SELECT {', '.join(f'avg((cls={k})::INT) r{k}' for k in range(K))} FROM g WHERE y >= {VALID_FROM}")[0]
    pred["observed"] = [obs[f"r{k}"] for k in range(K)]
    return pred, out


def player_spread(gender, eff):
    """Ball-weighted SD of log batter / bowler effects (2019+ regulars), net of Poisson noise: the real spread of player quality."""
    out = {}
    for f, col in (("batter_id", "batter_id"), ("bowler_id", "bowler_id")):
        rows = run(f"SELECT {col} lv, count(*) n, {', '.join(f'sum((cls={k})::INT) o{k}' for k in range(K))} FROM g WHERE y >= {VALID_FROM} GROUP BY 1 HAVING count(*) >= 600")
        res = {}
        for k, c in enumerate(CLASSES):
            xs, ws, noise = [], [], []
            for row in rows:
                o = row[f"o{k}"]
                if o < 3:
                    continue
                xs.append(math.log(eff[f][row["lv"]][k])); ws.append(row["n"]); noise.append(1.0 / o)
            if len(xs) < 10:
                continue
            tw = sum(ws)
            mu = sum(w * x for w, x in zip(ws, xs)) / tw
            var = sum(w * (x - mu) ** 2 for w, x in zip(ws, xs)) / tw
            # shrunk estimates understate the spread, raw ones overstate it; the shrunk SD is the conservative number
            res[c] = {"sd": r(math.sqrt(var), 3), "players": len(xs)}
        out["batter" if f == "batter_id" else "bowler"] = res
    return out


report = {"generated": date.today().isoformat(), "sample": sample, "classes": CLASSES}
model = {}
prior = None
# REUSE_FIT=1 skips the (several-minute) fit and reuses the last one, to rerun only the exports and validation targets
CACHE = DATA / "odi_fit_cache.json"
if os.environ.get("REUSE_FIT") and CACHE.exists():
    cached = json.load(open(CACHE))
    report.update(cached["report"])
    model = {g: {"base": m["base"], "ctx": {f: {int(lv): v for lv, v in e.items()} for f, e in m["ctx"].items()}} for g, m in cached["model"].items()}
    print("reusing", CACHE)
else:
    for gender in GENDERS:
        print(f"fitting {gender}")
        base, eff = fit(gender, prior)
        pred, ctx = normalise(gender, base, eff)
        spread = player_spread(gender, eff)
        if gender == "male":
            prior = {f: {str(lv): v for lv, v in eff[f].items()} for f in CTX}
        model[gender] = {"base": pred["base"], "ctx": ctx}
        report[gender] = {"observed2019": [r(x, 5) for x in pred["observed"]], "base": [r(x, 5) for x in pred["base"]], "playerSpread": spread}
    json.dump({"model": model, "report": {g: report[g] for g in GENDERS}}, open(CACHE, "w"))


# ── rain: no results, reduced matches, when the overs were lost, overs per side (ODIs 2012+) ─
run(f"""
CREATE OR REPLACE TABLE rinn AS SELECT match_id, innings, sum((wides=0 AND noballs=0)::INT) legal, sum(is_wicket) wk, max(inn_target_overs) t
  FROM raw WHERE y >= {FIRST_YEAR['male']} GROUP BY ALL;
CREATE OR REPLACE TABLE rm AS
SELECT m.match_id, m.gender, m.result, m.outcome_method, i1.legal l1, i1.wk w1, i2.t t2, (m.result='no result') nr,
  (coalesce(m.result,'') <> 'no result' AND (m.outcome_method IS NOT NULL OR (i2.t IS NOT NULL AND i2.t < 50))) red
FROM m LEFT JOIN rinn i1 ON i1.match_id=m.match_id AND i1.innings=1 LEFT JOIN rinn i2 ON i2.match_id=m.match_id AND i2.innings=2
WHERE year(m.date) >= {FIRST_YEAR['male']};
""", json_out=False)
rain = {}
for gender in GENDERS:
    x = run(f"SELECT count(*) n, sum(nr::INT) nr, sum(red::INT) red FROM rm WHERE gender='{gender}'")[0]
    rows = run(f"SELECT l1, w1, t2 FROM rm WHERE gender='{gender}' AND red AND l1 IS NOT NULL AND t2 IS NOT NULL")
    when = defaultdict(int)
    overs = defaultdict(int)
    for row in rows:
        tb = round(row["t2"] * 6)
        if row["l1"] == tb or (row["w1"] >= 10 and row["l1"] <= tb):
            when["preMatch"] += 1
        elif row["l1"] >= 300 or row["w1"] >= 10:
            when["secondInnings"] += 1
        else:
            when["firstInnings"] += 1
        overs[str(min(45, max(20, int(row["t2"]) // 5 * 5)))] += 1
    tw, to = sum(when.values()) or 1, sum(overs.values()) or 1
    rain[gender] = {"matches": int(x["n"]), "pNoResult": r(x["nr"] / x["n"]), "pReduced": r(x["red"] / x["n"]),
                    "when": {k: r(when[k] / tw) for k in ("preMatch", "firstInnings", "secondInnings")},
                    "oversPerSide": {k: r(overs[k] / to) for k in sorted(overs, key=int)}, "reducedN": len(rows)}
report["rain"] = {"source": "Cricsheet ODIs 2012+: no result = result 'no result'; reduced = a result with D/L or a chase of under 50 overs; "
                  "when as in match-rules-extra.py; oversPerSide = the chase's overs in 5-over bands (20 = 20-24 ...)", **rain}
print("rain:", json.dumps(rain))

# ── dismissal mix on legal balls (2019+; as match-rules.py does for T20: free hits are not an ODI issue at this level) ─
KIND_KEY = {"caught": "caught", "bowled": "bowled", "lbw": "lbw", "run out": "run_out", "caught and bowled": "caught_and_bowled",
            "stumped": "stumped", "hit wicket": "hit_wicket", "obstructing the field": "obstructing_the_field",
            "handled the ball": "handled_the_ball", "hit the ball twice": "hit_the_ball_twice"}
mix = {}
for gender in GENDERS:
    rows = run(f"""SELECT wicket_kind k, count(*) n FROM raw WHERE gender='{gender}' AND y >= {VALID_FROM} AND is_wicket=1
      AND wides=0 AND noballs=0 AND wicket_kind IN ({", ".join("'" + k + "'" for k in KIND_KEY)}) GROUP BY 1""")
    tot = sum(x["n"] for x in rows)
    mix[gender] = {KIND_KEY[x["k"]]: r(x["n"] / tot, 6) for x in sorted(rows, key=lambda x: -x["n"])}
    for k in KIND_KEY.values():
        mix[gender].setdefault(k, 5e-06)
report["dismissalMix"] = mix

# ── toss: how often the winner fields first (2019+), chase advantage (venue analysis) ─
toss = {}
for gender in GENDERS:
    t = run(f"SELECT avg((toss_decision='field')::INT) f, count(*) n FROM m WHERE gender='{gender}' AND year(date) >= {VALID_FROM} AND toss_decision IS NOT NULL")[0]
    toss[gender] = {"fieldShare": r(t["f"], 3), "n": int(t["n"])}
chase_adv = {}
TOSS_CSV = DATA / "toss_chase.csv"
if TOSS_CSV.exists():
    for line in open(TOSS_CSV):
        c = line.strip().split(",")
        if c[:3] == ["chase_advantage", "ListA", "ODI"] and c[4:6] == ["overall", "all"]:
            chase_adv[c[3]] = float(c[6])
report["toss"] = {"fieldShare2019": toss, "chaseAdvantage": chase_adv}

# ── ODI grounds (venue analysis: data/analysis/venue_factors.csv, ListA x ODI, all eras, 10+ matches) ─
VF = DATA / "venue_factors.csv"
grounds = []
if VF.exists():
    rows = run(f"""SELECT venue, city, country, gender, matches, run_factor, wkt_factor, six_factor FROM read_csv('{VF}', header=true)
      WHERE format='ListA' AND scope='ODI' AND era='all' AND matches >= 10 ORDER BY gender DESC, matches DESC""")
    for x in rows:
        grounds.append({"name": x["venue"], "city": x["city"], "country": x["country"], "gender": x["gender"], "matches": int(x["matches"]),
                        "runFactor": x["run_factor"], "wicketFactor": x["wkt_factor"], "sixFactor": x["six_factor"]})

# ── engine table ───────────────────────────────────────────────────────
def vec(v):
    return "[" + ", ".join(f"{x:.4f}" for x in v) + "]"


def table(ctx, f, levels):
    # levels are ints; a fit whose level column came back as text (HUGEINT) has string keys
    return [ctx[f].get(lv, ctx[f].get(str(lv), [1.0] * K)) for lv in levels]


lines = []
for gender in GENDERS:
    c = model[gender]["ctx"]
    over = table(c, "f_over", list(range(50)))
    wk = [table(c, "f_wk", [w * 10 + o for o in range(len(OVER_BUCKETS))]) for w in range(WKT_LEVELS)]
    st = table(c, "f_set", list(range(len(SET_EDGES))))
    chase = [table(c, "f_chase", [s * 100 + q for q in range(len(RRR_EDGES))]) for s in range(len(STAGES))]
    era = table(c, "f_era", list(range(len(ERAS))))
    bt = [table(c, "f_bt", [t * 10 + o for o in range(len(TYPE_BUCKETS))]) for t in range(2)]
    g = "men" if gender == "male" else "women"
    lines.append(f"  {g}: {{")
    lines.append(f"    base: {vec(model[gender]['base'])},")
    lines.append("    over: [\n" + ",\n".join(f"      {vec(v)}" for v in over) + ",\n    ],")
    lines.append("    wickets: [\n" + ",\n".join("      [" + ", ".join(vec(v) for v in row) + "]" for row in wk) + ",\n    ],")
    lines.append("    set: [\n" + ",\n".join(f"      {vec(v)}" for v in st) + ",\n    ],")
    lines.append("    chase: [\n" + ",\n".join("      [" + ", ".join(vec(v) for v in row) + "]" for row in chase) + ",\n    ],")
    lines.append("    era: [\n" + ",\n".join(f"      {vec(v)}" for v in era) + ",\n    ],")
    lines.append("    bowlerType: [\n" + ",\n".join("      [" + ", ".join(vec(v) for v in row) + "]" for row in bt) + ",\n    ],")
    lines.append("  },")

ts = f'''/**
 * GENERATED by packages/ratings/src/analysis/odi-ball-model.py from Cricsheet ODI ball-by-ball data
 * ({", ".join(f"{s['gender']}: {int(s['matches'])} matches, {int(s['deliveries'])} deliveries" for s in sample)}). Do not edit by hand.
 *
 * Per-delivery outcome rates of a 50-over innings, multiplicative factors, every vector in OdiOutcome order
 * (dot, 1, 2, 3, 4, 6, wicket, wide, noball, legbye). `base` is the average 2019+ ODI delivery; each factor has mean 1
 * over the 2019+ deliveries (the bowler-type profile: per type), fitted with the batter's and bowler's own quality
 * taken out. Generated {date.today().isoformat()}.
 *
 *   over        [over 0-49]
 *   wickets     [wickets down 0..7, 8+][overs 1-10, 11-20, 21-30, 31-40, 41-45, 46-50]
 *   set         [striker's balls faced before the ball: 0, 1-4, 5-9, 10-19, 20-34, 35-59, 60-99, 100+]
 *   chase       [stage: overs 1-20, 21-35, 36-45, 46-50][required rate: <3, 3-4, 4-5, 5-6, 6-7, 7-8, 8-9, 9-10, 10-12, 12+] (second innings only)
 *   era         [2010-14, 2015-18, 2019-26] (relative to 2019-26)
 *   bowlerType  [pace, spin][overs 1-10, 11-20, 21-30, 31-40, 41-50] (each type's profile over the innings, mean 1 per type)
 */
import type {{ OdiModelTables, OdiRainRates }} from "./odi-model.js";

export const ODI_MODEL_DATA: Record<"men" | "women", OdiModelTables> = {{
{chr(10).join(lines)}
}};

/** Dismissal kinds on legal balls in 2019+ ODIs (shares; the T20 mix is match-rules-data.ts dismissalMix) */
export const ODI_DISMISSAL_MIX: Record<"male" | "female", Record<string, number>> = {{
  male: {json.dumps(mix["male"])},
  female: {json.dumps(mix["female"])},
}};

/**
 * Rain in ODIs (2012+): p(no result once started), p(overs reduced, a result), when the overs were lost, and the overs a
 * side had after the cut (5-over bands: "20" = 20-24 overs). Cricsheet leaves out matches abandoned without a ball.
 */
export const ODI_RAIN: Record<"men" | "women", OdiRainRates> = {{
  men: {json.dumps({k: v for k, v in rain["male"].items() if k != "reducedN"})},
  women: {json.dumps({k: v for k, v in rain["female"].items() if k != "reducedN"})},
}};
'''
OUT_TS.write_text(ts)
print("wrote", OUT_TS)

OUT_VENUES = ROOT.parent / "engine" / "src" / "odi-venue-data.ts"
OUT_VENUES.write_text(f'''/**
 * GENERATED by packages/ratings/src/analysis/odi-ball-model.py from the venue analysis (data/analysis/venue_factors.csv:
 * List A x ODI, all eras, grounds with 10+ ODIs; docs/VENUE-CONDITIONS-REPORT.md) and toss_chase.csv. Do not edit by hand.
 *
 * runFactor / wicketFactor / sixFactor: 100 = the average ODI ground for that gender, after adjusting for the two XIs'
 * strength and shrunk by sample size (sixFactor null = too few sixes to measure). Generated {date.today().isoformat()}.
 */
export interface OdiGroundRecord {{
  name: string;
  city: string | null;
  country: string | null;
  gender: "male" | "female";
  matches: number;
  runFactor: number;
  wicketFactor: number;
  sixFactor: number | null;
}}

/** P(chasing side wins) - 0.5 for equal sides in ODIs; share of toss winners who field first (2019+) */
export const ODI_CONDITIONS = {json.dumps({"chaseAdvantage": {"male": chase_adv.get("male", 0), "female": chase_adv.get("female", 0)}, "tossFieldShare": {g: toss[g]["fieldShare"] for g in GENDERS}})};

export const ODI_GROUNDS: OdiGroundRecord[] = [
{("," + chr(10)).join("  " + json.dumps(g) for g in grounds)}
];
''')
print("wrote", OUT_VENUES, len(grounds), "grounds")

# ── real ODIs for validation (2019+, full 50-over matches unless said) ─
run(f"""
CREATE OR REPLACE TABLE inn AS
SELECT match_id, innings, gender, y, any_value(batting_team) bat, any_value(bowling_team) bowl, sum(runs_total) runs,
  sum(is_wicket + (coalesce(retired_kind,'') NOT IN ('','retired hurt','retired not out'))::INT) wk,
  sum((wides=0 AND noballs=0)::INT) legal, sum(runs_extras) extras,
  sum(runs_total) FILTER (WHERE over<10) r1, sum(runs_total) FILTER (WHERE over BETWEEN 10 AND 39) r2, sum(runs_total) FILTER (WHERE over>=40) r3,
  sum((wides=0 AND noballs=0)::INT) FILTER (WHERE over<10) b1, sum((wides=0 AND noballs=0)::INT) FILTER (WHERE over BETWEEN 10 AND 39) b2,
  sum((wides=0 AND noballs=0)::INT) FILTER (WHERE over>=40) b3,
  sum((runs_batter=4 AND non_boundary=0)::INT) fours, sum((runs_batter=6 AND non_boundary=0)::INT) sixes,
  sum(wides) wides, sum(noballs) noballs, sum(byes+legbyes) byes
FROM raw WHERE full_match AND y >= {VALID_FROM} GROUP BY ALL;
CREATE OR REPLACE TABLE bat AS
SELECT match_id, innings, gender, batter_id, sum(runs_batter) runs FROM raw WHERE full_match AND y >= {VALID_FROM} GROUP BY ALL;
""", json_out=False)

valid = {"generated": date.today().isoformat(), "from": VALID_FROM, "note": "Real ODIs (Cricsheet), full 50-over matches with no rain revision unless said"}
for gender in GENDERS:
    G = f"gender='{gender}'"
    v = {}
    i1 = run(f"""SELECT count(*) n, avg(runs) avg, stddev(runs) sd, quantile_cont(runs, [0.1,0.25,0.5,0.75,0.9]) q,
        avg((runs>=300)::INT) p300, avg((runs>=350)::INT) p350, avg((runs<200)::INT) pUnder200, avg(wk) wk, avg((wk>=10)::INT) allOut, avg(extras) extras,
        avg(fours) fours, avg(sixes) sixes, avg(wides) wides, avg(noballs) noballs, avg(byes) byes, avg(legal) legal,
        6*sum(r1)/sum(b1) rr1, 6*sum(r2)/sum(b2) rr2, 6*sum(r3)/sum(b3) rr3
        FROM inn WHERE {G} AND innings=1""")[0]
    i1["q"] = [r(x, 1) for x in json.loads(i1["q"])] if isinstance(i1["q"], str) else [r(x, 1) for x in i1["q"]]
    hist = run(f"""SELECT least(floor(runs/50)::INT, 7) bin, count(*) n FROM inn WHERE {G} AND innings=1 GROUP BY 1 ORDER BY 1""")
    tot = sum(h["n"] for h in hist)
    i1["hist50"] = {f"{int(h['bin']) * 50}+": r(h["n"] / tot, 4) for h in hist}
    v["firstInnings"] = {k: (r(x, 4) if isinstance(x, float) else x) for k, x in i1.items()}
    i2 = run(f"SELECT avg(runs) avg, avg(wk) wk, avg((wk>=10)::INT) allOut, avg(extras) extras FROM inn WHERE {G} AND innings=2")[0]
    v["secondInnings"] = {k: r(x, 4) for k, x in i2.items()}
    res = run(f"""SELECT count(*) n,
        avg((winner = i1.bat)::INT) FILTER (WHERE winner IS NOT NULL) batFirstWin,
        avg((result='tie')::INT) tieShare
        FROM (SELECT DISTINCT match_id, winner, result FROM raw WHERE {G} AND full_match AND y >= {VALID_FROM}) x
        JOIN inn i1 ON i1.match_id = x.match_id AND i1.innings = 1""")[0]
    v["results"] = {k: r(x, 4) for k, x in res.items()}
    tons = run(f"""SELECT count(DISTINCT match_id) m, sum((runs>=100)::INT) h, sum((runs BETWEEN 50 AND 99)::INT) f FROM bat WHERE {G}""")[0]
    v["perMatch"] = {"hundreds": r(tons["h"] / tons["m"]), "fifties": r(tons["f"] / tons["m"])}
    # per-delivery class rates by phase (overs 1-10, 11-40, 41-50), both innings, in the model's classes
    ph = run(f"""SELECT CASE WHEN over < 10 THEN 0 WHEN over < 40 THEN 1 ELSE 2 END p, count(*) n,
        {', '.join(f'avg((cls={k})::INT) c{k}' for k in range(K))} FROM b0 WHERE {G} AND full_match AND y >= {VALID_FROM} GROUP BY 1 ORDER BY 1""")
    v["phaseRates"] = [[r(x[f"c{k}"], 5) for k in range(K)] for x in ph]
    dm = run(f"""SELECT wicket_kind k, count(*) n FROM raw WHERE {G} AND y >= {VALID_FROM} AND is_wicket=1 GROUP BY 1""")
    t = sum(x["n"] for x in dm)
    v["dismissals"] = {x["k"]: r(x["n"] / t, 4) for x in sorted(dm, key=lambda x: -x["n"])}
    # batting position (order of arrival) averages and strike rates, both innings
    pos = run(f"""WITH arr AS (
          SELECT match_id, innings, batter_id p, min(seq) s FROM raw WHERE {G} AND full_match AND y >= {VALID_FROM} GROUP BY ALL
          UNION ALL SELECT match_id, innings, non_striker_id, min(seq) FROM raw WHERE {G} AND full_match AND y >= {VALID_FROM} GROUP BY ALL),
        firsts AS (SELECT match_id, innings, p, min(s) s FROM arr GROUP BY ALL),
        ord AS (SELECT *, row_number() OVER (PARTITION BY match_id, innings ORDER BY s, p) pos FROM firsts),
        runs AS (SELECT match_id, innings, batter_id p, sum(runs_batter) rn, sum((wides=0)::INT) bf FROM raw WHERE {G} AND full_match AND y >= {VALID_FROM} GROUP BY ALL),
        outs AS (SELECT match_id, innings, player_out_id p, count(*) o FROM raw WHERE {G} AND full_match AND y >= {VALID_FROM} AND is_wicket=1 GROUP BY ALL)
        SELECT least(ord.pos, 11) pos, sum(coalesce(rn,0)) runs, sum(coalesce(bf,0)) balls, sum(coalesce(o,0)) outs
        FROM ord LEFT JOIN runs USING(match_id, innings, p) LEFT JOIN outs USING(match_id, innings, p) GROUP BY 1 ORDER BY 1""")
    v["byPosition"] = [{"pos": int(x["pos"]), "avg": r(x["runs"] / max(x["outs"], 1), 1), "sr": r(100 * x["runs"] / max(x["balls"], 1), 1)} for x in pos]
    # team results (all ODIs with a result, rain or not) for the spread check, and the fixture list the benchmark replays
    fx = run(f"""SELECT match_id, team1, team2, winner, result FROM m WHERE {G} AND year(date) >= {VALID_FROM} ORDER BY date, match_id""")
    v["fixtures"] = [[x["team1"], x["team2"], x["winner"] or ("tie" if x["result"] == "tie" else None)] for x in fx]
    # national pools: Cricinfo ids of everyone who batted or bowled for the side, with deliveries involved and last season
    pools = run(f"""WITH inv AS (
          SELECT batting_team team, batter_id p, count(*) n, max(y) lastyr FROM raw WHERE {G} AND y >= {VALID_FROM} GROUP BY ALL
          UNION ALL SELECT bowling_team, bowler_id, count(*), max(y) FROM raw WHERE {G} AND y >= {VALID_FROM} GROUP BY ALL)
        SELECT team, cricinfo_id espn, sum(n) n, max(lastyr) lastyr FROM inv JOIN ptype ON ptype.cricsheet_id = inv.p
        WHERE cricinfo_id IS NOT NULL GROUP BY ALL ORDER BY team, n DESC""")
    pl = defaultdict(list)
    for x in pools:
        pl[x["team"]].append([int(x["espn"]), int(x["n"]), int(x["lastyr"])])
    v["pools"] = dict(pl)
    valid[gender] = v

OUT_VALID.write_text(json.dumps(valid, separators=(",", ":")))
OUT_REPORT.write_text(json.dumps(report, indent=1))
print("wrote", OUT_VALID, OUT_REPORT)
for gender in GENDERS:
    print(gender, json.dumps(valid[gender]["firstInnings"]))
