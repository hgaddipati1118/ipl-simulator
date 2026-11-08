"""
How real T20 sides bat by wickets down and overs left: a table of each outcome class's rate by the over band and the
wickets down before the ball, with the batter and the bowler held fixed, from the first innings of the men's (and women's)
T20 leagues since 2021. Real sides consolidate after early wickets (fewer boundaries, fewer wickets, more singles) and
accelerate late with wickets in hand; the table is that behaviour, beyond who is at the crease. The engine applies it in
the first innings (wickets-in-hand.ts; docs/RULES-MATCH.md 12.9); packages/app/src/__tests__/calibrate-collapses.test.ts
keeps each league's phase rates where they were.

Inputs (read-only): data/analysis/deliveries.parquet, matches.parquet. Needs the `duckdb` CLI on PATH.
Run from packages/ratings:  python3 -I src/analysis/t20-wickets-in-hand.py
Output: docs/data/t20_wickets_in_hand.json and packages/engine/src/wickets-in-hand-data.ts

Model, per gender, per outcome class k (dot, 1, 2, 3, 4, 6, wicket, wide, no-ball, bye / leg bye), as independent Poisson
rates fitted by iterative proportional fitting (as odi-ball-model.py):

    rate_k = level_k(league, season, over band) x state_k(over band, wickets down) x batter_k x bowler_k

The level takes each league-season's phase rates out, the batter and bowler terms the quality of who is at the crease (a
side seven down has its tail in: that is the batters, not the situation), so the state term is the situation alone. Over
bands: 1-6, 7-11, 12-15, 16-18, 19-20; wickets down 0 to 7, 8+. Shrinkage toward 1 with 5 pseudo-events for players (light,
so a tail-ender's few balls still set his own effect rather than leaving it in the state cells: with 20, the eight-down
death cells were about 0.07 lower), 30 for the state cells (some are thin: eight down in the powerplay), 10 for the levels. The state term is normalised to a mean of 1 within each over band over the real deliveries, so it
moves rates between states and not the band's level. Matches: full matches (no overs lost, no DLS or awarded result).
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
OUT_JSON = REPO / "docs" / "data" / "t20_wickets_in_hand.json"
OUT_TS = ROOT.parent / "engine" / "src" / "wickets-in-hand-data.ts"
TMP = Path(tempfile.mkdtemp())
DB = TMP / "wih.duckdb"

CLASSES = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"]
K = len(CLASSES)
BANDS = [(0, 5), (6, 10), (11, 14), (15, 17), (18, 19)]
WK = 9  # 0..7 down, 8+
EVENTS = {
    "male": ["Indian Premier League", "Big Bash League", "Pakistan Super League", "SA20", "Caribbean Premier League",
             "International League T20", "Major League Cricket", "Bangladesh Premier League", "Lanka Premier League"],
    "female": ["Women's Premier League", "Women's Big Bash League"],
}
A_CTX, A_STATE, A_PLAYER = 10.0, 30.0, 5.0
SWEEPS = 40


def run(sql: str, json_out: bool = True) -> list:
    args = ["duckdb", str(DB)] + (["-json"] if json_out else []) + ["-c", "SET memory_limit='2GB'; SET threads=4; " + sql]
    p = subprocess.run(args, capture_output=True, text=True, cwd=DATA)
    if p.returncode != 0:
        raise SystemExit(f"duckdb failed: {p.stderr}\n{sql[:600]}")
    rows = json.loads(p.stdout) if json_out and p.stdout.strip() else []
    num = re.compile(r"^-?\d+(\.\d+)?$")
    keep = lambda k: k == "lv" or k.endswith("_id")
    return [{k: (float(v) if num.match(v) and not keep(k) else v) if isinstance(v, str) else v for k, v in row.items()} for row in rows]


def band_sql(col: str) -> str:
    return "CASE " + " ".join(f"WHEN {col} BETWEEN {a} AND {b} THEN {i}" for i, (a, b) in enumerate(BANDS)) + " END"


def build() -> None:
    ev = ", ".join("'" + e.replace("'", "''") + "'" for g in EVENTS.values() for e in g)
    run(f"""
CREATE TABLE m AS SELECT * FROM 'matches.parquet' WHERE event IN ({ev}) AND date >= DATE '2021-01-01' AND outcome_method IS NULL;
CREATE TABLE full_m AS SELECT match_id FROM 'deliveries.parquet' WHERE innings = 2 AND super_over = 0 AND match_id IN (SELECT match_id FROM m)
  GROUP BY 1 HAVING min(inn_target_overs) = 20 AND max(inn_target_overs) = 20;
CREATE TABLE raw AS SELECT d.*, m.gender, m.event, m.season,
  row_number() OVER (PARTITION BY d.match_id, d.innings ORDER BY d.over, d.ball, d.legal_ball_no) seq
  FROM 'deliveries.parquet' d JOIN m USING (match_id) WHERE d.super_over = 0 AND d.innings = 1 AND d.match_id IN (SELECT match_id FROM full_m);
CREATE TABLE b AS SELECT match_id, gender, batter_id, bowler_id, over,
  CASE WHEN wides > 0 THEN 7 WHEN noballs > 0 THEN 8 WHEN is_wicket = 1 THEN 6 WHEN byes > 0 OR legbyes > 0 THEN 9
       WHEN runs_batter = 0 THEN 0 WHEN runs_batter = 1 THEN 1 WHEN runs_batter = 2 THEN 2 WHEN runs_batter = 3 THEN 3
       WHEN runs_batter IN (4, 5) THEN 4 ELSE 5 END cls,
  regexp_replace(event, '[^A-Za-z0-9]', '', 'g') || '|' || season || '|' || ({band_sql('over')})::VARCHAR AS f_level,
  (({band_sql('over')}) * 10 + least(coalesce(sum(is_wicket + (coalesce(retired_kind, '') NOT IN ('', 'retired hurt', 'retired not out'))::INT)
     OVER (PARTITION BY match_id, innings ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0), 8))::INT AS f_state
  FROM raw;
""", json_out=False)


FACTORS = ["f_level", "f_state", "batter_id", "bowler_id"]


def fit(gender: str) -> dict:
    rates = run(f"SELECT {', '.join(f'avg((cls={k})::INT) r{k}' for k in range(K))} FROM b WHERE gender = '{gender}'")[0]
    base = [rates[f"r{k}"] for k in range(K)]
    run(f"""CREATE OR REPLACE TABLE g AS SELECT cls, {', '.join(FACTORS)}, {', '.join(f'{base[k]}::DOUBLE AS lam{k}' for k in range(K))}
      FROM b WHERE gender = '{gender}';""", json_out=False)
    eff = {f: defaultdict(lambda: [1.0] * K) for f in FACTORS}
    for sweep in range(SWEEPS):
        worst = 0.0
        for f in FACTORS:
            rows = run(f"SELECT {f} lv, {', '.join(f'sum((cls={k})::INT) o{k}, sum(lam{k}) e{k}' for k in range(K))} FROM g GROUP BY 1")
            a = A_PLAYER if f in ("batter_id", "bowler_id") else A_STATE if f == "f_state" else A_CTX
            ratio = []
            for row in rows:
                lv, old = row["lv"], eff[f][row["lv"]]
                new = []
                for k in range(K):
                    o = row[f"o{k}"] or 0.0
                    e_ex = (row[f"e{k}"] or 0.0) / old[k]
                    new.append((o + a) / (e_ex + a) if e_ex + a > 0 else 1.0)
                worst = max(worst, max(abs(math.log(new[k] / old[k])) for k in range(K)))
                eff[f][lv] = new
                ratio.append([lv] + [new[k] / old[k] for k in range(K)])
            vals = ",".join("(" + (f"'{x[0]}'" if isinstance(x[0], str) else str(int(x[0]))) + "," + ",".join(f"{v:.10e}" for v in x[1:]) + ")" for x in ratio)
            run(f"""CREATE OR REPLACE TABLE rq AS SELECT * FROM (VALUES {vals}) t(lv, {', '.join(f'q{k}' for k in range(K))});
              CREATE OR REPLACE TABLE g AS SELECT g.* REPLACE ({', '.join(f'lam{k} * rq.q{k} AS lam{k}' for k in range(K))})
              FROM g JOIN rq ON rq.lv = g.{f};""", json_out=False)
        print(f"  {gender} sweep {sweep + 1}: max log change {worst:.5f}", flush=True)
        if worst < 1e-3:
            break
    # the state term to mean 1 within each over band over the real deliveries
    n = {int(r["lv"]): r["n"] for r in run("SELECT f_state lv, count(*) n FROM g GROUP BY 1")}
    table = []
    for band in range(len(BANDS)):
        lvs = [band * 10 + w for w in range(WK)]
        tot = sum(n.get(lv, 0) for lv in lvs)
        mean = [sum(n.get(lv, 0) * eff["f_state"][lv][k] for lv in lvs) / tot for k in range(K)]
        table.append([[round(eff["f_state"][band * 10 + w][k] / mean[k], 4) for k in range(K)] for w in range(WK)])
    counts = [[int(n.get(band * 10 + w, 0)) for w in range(WK)] for band in range(len(BANDS))]
    return {"table": table, "deliveries": counts}


def main() -> None:
    build()
    out = {}
    for gender in ("male", "female"):
        print(f"fitting {gender}")
        out[gender] = fit(gender)
        t = out[gender]["table"]
        for band, (a, b) in enumerate(BANDS):
            row = " | ".join(f"{w}: 4 {t[band][w][4]:.2f} 6 {t[band][w][5]:.2f} wk {t[band][w][6]:.2f} 1 {t[band][w][1]:.2f}" for w in range(0, WK, 2))
            print(f"  overs {a + 1}-{b + 1}: {row}")
    OUT_JSON.write_text(json.dumps({
        "source": "Cricsheet ball-by-ball (data/analysis/deliveries.parquet, matches.parquet); packages/ratings/src/analysis/t20-wickets-in-hand.py",
        "generated": date.today().isoformat(), "classes": CLASSES, "overBands": [[a, b] for a, b in BANDS], "events": EVENTS, **out,
    }, indent=1) + "\n")
    fmt = lambda t: "[\n" + ",\n".join("    [" + ", ".join("[" + ", ".join(f"{x:.4f}" for x in cell) + "]" for cell in band) + "]" for band in t) + ",\n  ]"
    OUT_TS.write_text(f"""/**
 * GENERATED by packages/ratings/src/analysis/t20-wickets-in-hand.py from Cricsheet (men's and women's T20 leagues since
 * 2021, first innings). Do not edit by hand.
 *
 * Each outcome class's rate by over band and wickets down, with the batter and bowler held fixed, mean 1 within each band
 * over the real deliveries: [band][wickets down 0..7, 8+][class]. Bands: overs 1-6, 7-11, 12-15, 16-18, 19-20. Classes:
 * {", ".join(CLASSES)}. Applied by wickets-in-hand.ts (docs/RULES-MATCH.md 12.9).
 */
export const WICKETS_IN_HAND_BANDS: readonly (readonly [number, number])[] = {json.dumps([[a, b] for a, b in BANDS])};

export const WICKETS_IN_HAND: Record<"male" | "female", number[][][]> = {{
  male: {fmt(out["male"]["table"])},
  female: {fmt(out["female"]["table"])},
}};
""")
    print(f"wrote {OUT_JSON} and {OUT_TS}")


if __name__ == "__main__":
    main()
