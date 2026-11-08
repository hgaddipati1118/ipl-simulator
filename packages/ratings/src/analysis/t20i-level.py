"""
The scoring level of real T20Is between full members since 2019 (men and women), the targets the engine's T20I context is
fitted to (packages/app/src/__tests__/calibrate-t20i.test.ts writes packages/engine/src/t20i-context-data.ts from them),
and the same measures for the women's leagues (WPL, WBBL; 2024-26) for comparison.

Inputs (read-only): data/analysis/deliveries.parquet, matches.parquet. Needs the `duckdb` CLI on PATH.
Run from packages/ratings:  python3 -I src/analysis/t20i-level.py
Output: docs/data/t20i_validation.json

Matches: full 20-over matches (no overs lost: the chase's target overs 20), no DLS or awarded results, no super-over balls.
T20Is: Cricsheet match_type T20 / IT20, team_type international, both sides among the twelve full members, 2019 onwards.

Per gender: first-innings totals (mean, sd, 200+), wickets, all-out share, run rate by phase (overs 1-6, 7-15, 16-20), the
chase, batting-first wins, extras, fours and sixes; and each phase's share of deliveries by outcome class (dot, 1, 2, 3,
4, 6, wicket, wide, no-ball, bye / leg bye), the classes the engine's ball model draws. A delivery's class: a wide or
no-ball first, then a dismissal (run-outs included), then byes / leg byes with no runs off the bat, else the runs off the
bat (5 counts as 4, 7+ as 6).
"""
import json
import re
import subprocess
import tempfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
REPO = ROOT.parent.parent
OUT = REPO / "docs" / "data" / "t20i_validation.json"

FULL_MEMBERS = ["Afghanistan", "Australia", "Bangladesh", "England", "India", "Ireland", "New Zealand", "Pakistan",
                "South Africa", "Sri Lanka", "West Indies", "Zimbabwe"]
CLASSES = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"]
PHASES = [("powerplay", 0, 5), ("middle", 6, 14), ("death", 15, 19)]
LEAGUES = {"wpl": "Women's Premier League", "wbbl": "Women's Big Bash League"}


TMP = Path(tempfile.mkdtemp())
DB = TMP / "t20i.duckdb"


def run(sql: str, json_out: bool = True) -> list:
    """One statement batch against the scratch database (read_parquet paths are relative to data/analysis)"""
    args = ["duckdb", str(DB)] + (["-json"] if json_out else []) + ["-c", "SET memory_limit='2GB'; SET threads=4; " + sql]
    p = subprocess.run(args, capture_output=True, text=True, cwd=DATA)
    if p.returncode != 0:
        raise SystemExit(f"duckdb failed: {p.stderr}\n{sql[:600]}")
    rows = json.loads(p.stdout) if json_out and p.stdout.strip() else []
    # DuckDB writes HUGEINT sums as strings; the outcome class ("1", "4", ...) stays a string
    num = re.compile(r"^-?\d+(\.\d+)?$")
    return [{k: float(v) if isinstance(v, str) and num.match(v) and k != "cls" else v for k, v in row.items()} for row in rows]


def measures(where_matches: str) -> dict:
    """Every measure for the matches selected by `where_matches` (a WHERE clause on matches m), per gender"""
    cls = ("CASE WHEN wides > 0 THEN 'wide' WHEN noballs > 0 THEN 'noball' WHEN is_wicket > 0 THEN 'wicket' "
           "WHEN byes + legbyes > 0 AND runs_batter = 0 THEN 'legbye' WHEN runs_batter >= 6 THEN '6' WHEN runs_batter >= 4 THEN '4' "
           "WHEN runs_batter = 0 THEN 'dot' ELSE runs_batter::VARCHAR END")
    phase = "CASE WHEN over <= 5 THEN 'powerplay' WHEN over <= 14 THEN 'middle' ELSE 'death' END"
    legal = "(wides = 0 AND noballs = 0)::INT"
    run(f"""
CREATE OR REPLACE TABLE m AS SELECT * FROM 'matches.parquet' m WHERE {where_matches} AND outcome_method IS NULL;
CREATE OR REPLACE TABLE full_m AS SELECT match_id FROM 'deliveries.parquet' WHERE innings = 2 AND super_over = 0 AND match_id IN (SELECT match_id FROM m)
  GROUP BY 1 HAVING min(inn_target_overs) = 20 AND max(inn_target_overs) = 20;
CREATE OR REPLACE TABLE d AS SELECT d.*, m.gender, m.winner, m.team1, m.team2, {cls} cls, {phase} phase, {legal} legal
  FROM 'deliveries.parquet' d JOIN m USING (match_id) WHERE d.super_over = 0 AND d.innings IN (1, 2) AND d.match_id IN (SELECT match_id FROM full_m);
CREATE OR REPLACE TABLE inn AS SELECT match_id, innings, gender, any_value(batting_team) bat, any_value(winner) winner,
  sum(runs_total) runs, sum(is_wicket) + count(*) FILTER (WHERE retired_kind IS NOT NULL AND retired_kind <> 'retired hurt') wk,
  sum(runs_extras) extras, sum(wides) wides, sum(noballs) noballs, sum(byes + legbyes) byes,
  sum((runs_batter = 4 AND non_boundary = 0)::INT) fours, sum((runs_batter = 6 AND non_boundary = 0)::INT) sixes, sum(legal) legal
  FROM d GROUP BY ALL;
""", json_out=False)
    first = run("""SELECT gender, count(*) n, avg(runs) runs, stddev(runs) sd, avg((runs >= 200)::INT) p200, avg(wk) wk, avg((wk >= 10)::INT) allout,
  avg(extras) extras, avg(wides) wides, avg(noballs) noballs, avg(byes) byes, avg(fours) fours, avg(sixes) sixes,
  avg((winner = bat)::INT) FILTER (WHERE winner IS NOT NULL) batfirst
  FROM inn WHERE innings = 1 GROUP BY 1 ORDER BY 1""")
    second = run("SELECT gender, avg(runs) runs, avg(wk) wk, avg((wk >= 10)::INT) allout FROM inn WHERE innings = 2 GROUP BY 1 ORDER BY 1")
    every = run("""SELECT gender, avg(runs) runs, avg(wk) wk, avg((wk >= 10)::INT) allout, avg(extras) extras, avg(fours) fours, avg(sixes) sixes,
  avg(legal) legal FROM inn GROUP BY 1 ORDER BY 1""")
    rates = run("SELECT gender, innings, phase, 6.0 * sum(runs_total) / sum(legal) rr, 120.0 * sum(is_wicket) / sum(legal) wk20 FROM d GROUP BY ALL ORDER BY ALL")
    shares = run("SELECT gender, phase, cls, count(*) n FROM d GROUP BY ALL ORDER BY ALL")
    fixtures = run("SELECT gender, team1, team2, count(*) n FROM m WHERE match_id IN (SELECT match_id FROM full_m) GROUP BY ALL ORDER BY ALL")
    out = {}
    for r in first:
        g = "men" if r["gender"] == "male" else "women"
        s = next(x for x in second if x["gender"] == r["gender"])
        a = next(x for x in every if x["gender"] == r["gender"])
        rr = {f"{x['phase']}{x['innings']}": x for x in rates if x["gender"] == r["gender"]}
        tot = {p: sum(x["n"] for x in shares if x["gender"] == r["gender"] and x["phase"] == p) for p, _, _ in PHASES}
        out[g] = {
            "matches": r["n"],
            "firstInnings": {
                "runs": round(r["runs"], 1), "sd": round(r["sd"], 1), "p200": round(100 * r["p200"], 1), "wickets": round(r["wk"], 2),
                "allOut": round(100 * r["allout"], 1), "extras": round(r["extras"], 1), "wides": round(r["wides"], 2),
                "noballs": round(r["noballs"], 2), "byes": round(r["byes"], 2), "fours": round(r["fours"], 1), "sixes": round(r["sixes"], 1),
                "runRate": [round(rr[f"{p}1"]["rr"], 2) for p, _, _ in PHASES],
                "wicketsPer20": [round(rr[f"{p}1"]["wk20"], 2) for p, _, _ in PHASES],
            },
            "secondInnings": {"runs": round(s["runs"], 1), "wickets": round(s["wk"], 2), "allOut": round(100 * s["allout"], 1),
                              "runRate": [round(rr[f"{p}2"]["rr"], 2) for p, _, _ in PHASES]},
            "allInnings": {"runs": round(a["runs"], 1), "wickets": round(a["wk"], 2), "allOut": round(100 * a["allout"], 1),
                           "extras": round(a["extras"], 1), "fours": round(a["fours"], 1), "sixes": round(a["sixes"], 1),
                           "legalBalls": round(a["legal"], 1)},
            "battingFirstWins": round(100 * r["batfirst"], 1),
            "phaseShares": {p: {c: round(next((x["n"] for x in shares if x["gender"] == r["gender"] and x["phase"] == p and x["cls"] == c), 0) / tot[p], 5)
                                for c in CLASSES} for p, _, _ in PHASES},
            "fixtures": [[x["team1"], x["team2"], x["n"]] for x in fixtures if x["gender"] == r["gender"]],
        }
    return out


def main() -> None:
    fm = ", ".join(f"'{t}'" for t in FULL_MEMBERS)
    t20i = measures(f"m.match_type IN ('T20', 'IT20') AND m.team_type = 'international' AND m.date >= DATE '2019-01-01' "
                    f"AND m.team1 IN ({fm}) AND m.team2 IN ({fm})")
    leagues = {}
    for lid, event in LEAGUES.items():
        quoted = event.replace("'", "''")
        res = measures(f"m.match_type = 'T20' AND m.event = '{quoted}' AND m.date >= DATE '2024-01-01'")
        lg = res["women"]
        lg.pop("fixtures", None)
        leagues[lid] = lg
    doc = {
        "source": "Cricsheet ball-by-ball (data/analysis/deliveries.parquet, matches.parquet); packages/ratings/src/analysis/t20i-level.py",
        "generated": date.today().isoformat(),
        "phases": [[p, a, b] for p, a, b in PHASES],
        "classes": CLASSES,
        "t20i": t20i,
        "womensLeagues2024": leagues,
    }
    OUT.write_text(json.dumps(doc, indent=1) + "\n")
    for g, v in t20i.items():
        f = v["firstInnings"]
        print(f"T20I {g}: {v['matches']} matches; 1st inns {f['runs']} (sd {f['sd']}), {f['wickets']} wkts, all out {f['allOut']}%, RR {f['runRate']}, extras {f['extras']}")
    for lid, v in leagues.items():
        f = v["firstInnings"]
        print(f"{lid}: {v['matches']} matches; 1st inns {f['runs']}, {f['wickets']} wkts, all out {f['allOut']}%, RR {f['runRate']}, all-innings {v['allInnings']['runs']}")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
