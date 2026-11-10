"""
Real per-country results of the national sides, the targets of the per-country benchmark
(packages/app/src/__tests__/benchmark-countries.test.ts; docs/FORMATS.md, "Per-country validation").

Inputs (read-only): data/analysis/deliveries.parquet, matches.parquet, venue_map.csv. Needs the `duckdb` CLI on PATH.
Run from packages/ratings:  python3 -I src/analysis/country-validation.py
Output: docs/data/country_validation.json

Matches: Cricsheet international matches between two of the twelve full members, with a result (no tie, no result, no DLS or
awarded outcome), in the window each engine was fitted on: men's and women's T20Is and ODIs from 2019, men's Tests from 2023.
The venue's country (data/analysis/venue_map.csv, the same table the Test fit uses) decides home / away / neutral for each side:
home = the venue is in the side's own country, away = in the opponent's, neutral = anywhere else.

Per format and gender, per country: matches, wins, home and away matches and wins, the mean first-innings total when batting
first (innings of the full scheduled length only for the limited-overs formats), runs per wicket over all of the side's
innings (runs / wickets lost), and the head-to-head records of the pairs with enough matches. The fixtures (pairing, venue
country, count) are what the benchmark replays.
"""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
OUT = ROOT.parent.parent / "docs" / "data" / "country_validation.json"

FULL = ["Afghanistan", "Australia", "Bangladesh", "England", "India", "Ireland", "New Zealand", "Pakistan",
        "South Africa", "Sri Lanka", "West Indies", "Zimbabwe"]
CODE = {"India": "IND", "England": "ENG", "Australia": "AUS", "South Africa": "RSA", "New Zealand": "NZ", "Pakistan": "PAK",
        "Sri Lanka": "SL", "West Indies": "WI", "Bangladesh": "BDESH", "Zimbabwe": "ZIM", "Ireland": "IRELAND", "Afghanistan": "AFG"}
# (format, gender) -> (Cricsheet match types, first season date)
SETS = {
    ("t20i", "men"): (("T20", "IT20"), "male", "2019-01-01"),
    ("t20i", "women"): (("T20", "IT20"), "female", "2019-01-01"),
    ("odi", "men"): (("ODI", "ODM"), "male", "2019-01-01"),
    ("odi", "women"): (("ODI", "ODM"), "female", "2019-01-01"),
    ("test", "men"): (("Test",), "male", "2023-01-01"),
}
H2H_MIN = 8


def duck(sql: str) -> list:
    p = subprocess.run(["duckdb", "-json", "-c", "SET memory_limit='2GB'; " + sql], capture_output=True, text=True, cwd=DATA)
    if p.returncode != 0:
        raise SystemExit(f"duckdb failed: {p.stderr}\n{sql[:500]}")
    return json.loads(p.stdout) if p.stdout.strip() else []


def build(fmt: str, gender: str) -> dict:
    types, g, since = SETS[(fmt, gender)]
    members = ", ".join(f"'{t}'" for t in FULL)
    mt = ", ".join(f"'{t}'" for t in types)
    full_len = {"t20i": 114, "odi": 270, "test": 0}[fmt]  # legal balls of a full limited-overs innings (an innings shortened by rain is left out)
    rows = duck(f"""
WITH vm AS (SELECT raw_venue, coalesce(raw_city, '') raw_city, any_value(country) country FROM read_csv('venue_map.csv', header=true, all_varchar=true) WHERE source = 'cs' GROUP BY 1, 2),
m AS (SELECT m.match_id, m.team1, m.team2, m.winner, m.result, m.outcome_method, coalesce(vm.country, 'UNK') vc FROM 'matches.parquet' m
  LEFT JOIN vm ON vm.raw_venue = m.venue AND vm.raw_city = coalesce(m.city, '')
  WHERE m.match_type IN ({mt}) AND m.gender = '{g}' AND m.team_type = 'international' AND m.date >= DATE '{since}'
    AND m.team1 IN ({members}) AND m.team2 IN ({members})),
inn AS (SELECT match_id, innings, batting_team bt, sum(runs_total) runs, sum(CASE WHEN is_wicket = 1 AND wicket_kind NOT IN ('retired hurt', 'retired not out') THEN 1 ELSE 0 END) w,
  sum(CASE WHEN wides = 0 AND noballs = 0 THEN 1 ELSE 0 END) legal FROM 'deliveries.parquet' WHERE super_over = 0 GROUP BY 1, 2, 3)
SELECT m.*, (SELECT list(struct_pack(i := inn.innings, t := inn.bt, r := inn.runs, w := inn.w, b := inn.legal)) FROM inn WHERE inn.match_id = m.match_id) innings FROM m
""")
    code = CODE
    matches = []
    for r in rows:
        if r["winner"] is None or r["winner"] not in (r["team1"], r["team2"]) or r["outcome_method"] not in (None, ""):
            continue
        if r["result"] in ("tie", "no result"):
            continue
        matches.append(r)
    teams = {t: {"n": 0, "wins": 0, "homeN": 0, "homeWins": 0, "awayN": 0, "awayWins": 0, "neutralN": 0, "neutralWins": 0,
                 "first": [], "runs": 0, "wkts": 0} for t in FULL}
    h2h, fixtures = {}, {}
    for r in matches:
        a, b, vc = r["team1"], r["team2"], r["vc"]
        for t, o in ((a, b), (b, a)):
            s = teams[t]
            s["n"] += 1
            win = r["winner"] == t
            s["wins"] += win
            kind = "home" if vc == code[t] else "away" if vc == code[o] else "neutral"
            s[kind + "N"] += 1
            s[kind + "Wins"] += win
        key = " v ".join(sorted((a, b)))
        h = h2h.setdefault(key, {"n": 0, "wins": {a: 0, b: 0}})
        h["n"] += 1
        h["wins"][r["winner"]] += 1
        host = a if vc == code[a] else b if vc == code[b] else None
        fkey = (key, host)
        fixtures[fkey] = fixtures.get(fkey, 0) + 1
        for inn in r["innings"] or []:
            s = teams[inn["t"]]
            if inn["i"] == 1 and (fmt == "test" or inn["b"] >= full_len):
                s["first"].append(inn["r"])
            s["runs"] += inn["r"]
            s["wkts"] += inn["w"]
    out = {"window": since[:4] + "+", "matches": len(matches), "teams": {}, "h2h": {}, "fixtures": []}
    for t, s in teams.items():
        if s["n"] < 5:
            continue
        out["teams"][t] = {
            "n": s["n"], "winRate": round(s["wins"] / s["n"], 3),
            "homeN": s["homeN"], "homeWinRate": round(s["homeWins"] / s["homeN"], 3) if s["homeN"] else None,
            "awayN": s["awayN"], "awayWinRate": round(s["awayWins"] / s["awayN"], 3) if s["awayN"] else None,
            "neutralN": s["neutralN"], "neutralWinRate": round(s["neutralWins"] / s["neutralN"], 3) if s["neutralN"] else None,
            "firstN": len(s["first"]), "firstInnings": round(sum(s["first"]) / len(s["first"]), 1) if s["first"] else None,
            "runsPerWicket": round(s["runs"] / s["wkts"], 2) if s["wkts"] else None,
        }
    for k, h in h2h.items():
        if h["n"] >= H2H_MIN:
            a, b = k.split(" v ")
            out["h2h"][k] = {"n": h["n"], "winRate": {a: round(h["wins"][a] / h["n"], 3), b: round(h["wins"][b] / h["n"], 3)}}
    out["fixtures"] = [[k.split(" v ")[0], k.split(" v ")[1], host, n] for (k, host), n in sorted(fixtures.items(), key=lambda x: (x[0][0], str(x[0][1])))]
    return out


def main():
    res = {f"{fmt}-{gender}": build(fmt, gender) for fmt, gender in SETS}
    OUT.write_text(json.dumps(res, indent=1))
    for k, v in res.items():
        print(k, v["matches"], "matches,", len(v["teams"]), "teams,", len(v["h2h"]), "pairs,", len(v["fixtures"]), "fixtures")


if __name__ == "__main__":
    main()
