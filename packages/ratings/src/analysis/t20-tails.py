"""
The T20I lower order, real against sim, on the matches the real XIs played (docs/COUNTRY-VALIDATION.md, "Women's T20I tails").

Real: Cricsheet ball by ball (deliveries.parquet) of the matches in docs/data/actual_xi.json, both innings (super overs left out), and the batting
cards stored with them. Sim: the dump of the BENCH_TAILS test in packages/app/src/__tests__/benchmark-countries.test.ts (the same matches replayed
with the real XIs in the real order). Per half (fit: to 2024, holdout: 2025+), with standard errors clustered by match:
  - runs / balls by batting position 7-11 and their runs per ball, the share of innings a position bats;
  - by wickets down (0-9, the wickets before the ball): legal balls an innings, runs (with extras) and wickets per legal ball;
  - the balls numbers 8-11 face an innings, the last-wicket stand (balls, runs) when nine fall, first-innings all-out share, total and sd.

Run from packages/ratings (needs the `duckdb` CLI):
    python3 -I src/analysis/t20-tails.py sim.json [t20i-women] [--md]
"""
import json
import math
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
REPO = ROOT.parent.parent


def duck(sql: str):
    p = subprocess.run(["duckdb", "-json", "-c", "SET memory_limit='3GB'; SET threads=2; " + sql], capture_output=True, text=True, cwd=DATA)
    if p.returncode:
        raise SystemExit(p.stderr)
    return json.loads(p.stdout or "[]")


def real_matches(key: str):
    act = json.loads((REPO / "docs" / "data" / "actual_xi.json").read_text())[key]
    ids = ", ".join(f"'{m['id']}'" for m in act)
    rows = duck(f"""
WITH d AS (SELECT match_id, innings, over, ball, runs_total, is_wicket, CASE WHEN wides=0 AND noballs=0 THEN 1 ELSE 0 END AS legal,
  COALESCE(SUM(is_wicket) OVER (PARTITION BY match_id, innings ORDER BY over, ball ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS wk
  FROM 'deliveries.parquet' WHERE match_id IN ({ids}) AND super_over=0)
SELECT match_id AS id, innings::INT AS q, wk::INT AS wk, SUM(legal)::INT AS b, SUM(runs_total)::INT AS r, SUM(is_wicket)::INT AS w FROM d GROUP BY ALL""")
    # outs by batting position: the order the batters came in (first ball at either end), the wickets' player_out_id
    outs = duck(f"""
WITH a AS (SELECT match_id, innings, over, ball, batter_id AS pid FROM 'deliveries.parquet' WHERE match_id IN ({ids}) AND super_over=0
  UNION ALL SELECT match_id, innings, over, ball, non_striker_id FROM 'deliveries.parquet' WHERE match_id IN ({ids}) AND super_over=0),
f AS (SELECT match_id, innings, pid, min(over * 100 + ball) AS t FROM a GROUP BY ALL),
o AS (SELECT match_id, innings, pid, (row_number() OVER (PARTITION BY match_id, innings ORDER BY t) - 1)::INT AS pos FROM f),
w AS (SELECT DISTINCT match_id, innings, player_out_id AS pid FROM 'deliveries.parquet' WHERE match_id IN ({ids}) AND super_over=0 AND is_wicket>0 AND player_out_id IS NOT NULL)
SELECT o.match_id AS id, o.innings::INT AS q, o.pos FROM o JOIN w USING (match_id, innings, pid) WHERE o.innings <= 2""")
    ph = duck(f"""SELECT match_id AS id, innings::INT AS q, (CASE WHEN over < 6 THEN 0 WHEN over < 15 THEN 1 ELSE 2 END)::INT AS ph,
  SUM(CASE WHEN wides=0 AND noballs=0 THEN 1 ELSE 0 END)::INT AS b, SUM(runs_total)::INT AS r, SUM(is_wicket)::INT AS w
  FROM 'deliveries.parquet' WHERE match_id IN ({ids}) AND super_over=0 AND innings <= 2 GROUP BY ALL""")
    out = {}
    for m in act:
        out[m["id"]] = {"date": m["date"], "n": 1, "pos": [[0, 0, 0, 0] for _ in range(11)], "state": [[0, 0, 0] for _ in range(10)], "state2": [[0, 0, 0] for _ in range(10)], "firstW": 0, "phase": [[0, 0, 0] for _ in range(6)], "over1": [[0, 0, 0] for _ in range(20)],
                        "last": [0, 0, 0], "first": [0, 0], "allOut": 0, "standIn": [0] * 11}
        for s in "ab":
            for i, (r, b) in enumerate(m["bat"][s][:11]):
                p = out[m["id"]]["pos"][i]
                p[0] += r; p[1] += b; p[2] += 1
    for x in ph:
        if x["id"] in out:
            e = out[x["id"]]["phase"][3 * (x["q"] - 1) + x["ph"]]
            e[0] += x["b"]; e[1] += x["r"]; e[2] += x["w"]
    ov = duck(f"""SELECT match_id AS id, over::INT AS o, SUM(CASE WHEN wides=0 AND noballs=0 THEN 1 ELSE 0 END)::INT AS b, SUM(is_wicket)::INT AS w, SUM(runs_total)::INT AS r
  FROM 'deliveries.parquet' WHERE match_id IN ({ids}) AND super_over=0 AND innings = 1 AND over < 20 GROUP BY ALL""")
    for x in ov:
        if x["id"] in out:
            e = out[x["id"]]["over1"][x["o"]]
            e[0] += x["b"]; e[1] += x["w"]; e[2] += x["r"]
    for x in outs:
        if x["id"] in out and x["pos"] < 11:
            out[x["id"]]["pos"][x["pos"]][3] += 1
    inn = {}
    for x in rows:
        if x["id"] not in out or x["q"] > 2:
            continue
        inn.setdefault((x["id"], x["q"]), {})[min(9, x["wk"])] = x
    for (mid, q), st in inn.items():
        pm = out[mid]
        tot = sum(v["r"] for v in st.values())
        wk = sum(v["w"] for v in st.values())
        for k, v in st.items():
            for tab in ([pm["state"], pm["state2"]] if q == 1 else [pm["state"]]):
                tab[k][0] += v["b"]; tab[k][1] += v["r"]; tab[k][2] += v["w"]
        if 9 in st:
            pm["last"][0] += st[9]["b"]; pm["last"][1] += st[9]["r"]; pm["last"][2] += 1
        if q == 1:
            pm["first"][0] += tot; pm["first"][1] += tot * tot
            pm["allOut"] += 1 if wk >= 10 else 0
            pm["firstW"] += min(10, wk)
    # matches without ball-by-ball (none expected) leave their innings out of the state figures
    return out


def ratio(ms, num, den):
    """sum num / sum den over matches, SE clustered by match (each match's sim replays averaged first)"""
    xs = [(num(m) / m["n"], den(m) / m["n"]) for m in ms]
    xs = [(a, b) for a, b in xs if b > 0 or a > 0]
    n = len(xs)
    sy, sx = sum(a for a, _ in xs), sum(b for _, b in xs)
    if sx == 0 or n < 2:
        return float("nan"), float("nan")
    R = sy / sx
    v = sum((a - R * b) ** 2 for a, b in xs) * n / (n - 1)
    return R, math.sqrt(v) / sx


def mean(ms, f, g=lambda m: 1):
    return ratio(ms, f, g)


def report(real, sim, md):
    halves = [("fit (to 2024)", lambda d: d <= "2024-12-31"), ("holdout (2025+)", lambda d: d >= "2025-01-01"), ("all", lambda d: True)]
    for label, inh in halves:
        ids = [i for i in sim if inh(sim[i]["date"]) and i in real]
        R = [real[i] for i in ids]; S = [sim[i] for i in ids]
        print(f"\n## {label}: {len(ids)} matches (sim {S[0]['n'] if S else 0} replays each)")
        def row(name, f, d=2):
            (a, ea), (b, eb) = f(R), f(S)
            print(f"| {name} | {a:.{d}f} +- {ea:.{d}f} | {b:.{d}f} +- {eb:.{d}f} | {b - a:+.{d}f} +- {math.hypot(ea, eb):.{d}f} |")
        print("| figure | real | sim | sim - real |\n|---|---|---|---|")
        for p in range(int(os.environ.get('TAILS_FROM', '6')), 11):
            row(f"#{p + 1} runs / innings batted", lambda ms: ratio(ms, lambda m: m["pos"][p][0], lambda m: m["pos"][p][2]))
            row(f"#{p + 1} balls / innings batted", lambda ms: ratio(ms, lambda m: m["pos"][p][1], lambda m: m["pos"][p][2]))
            row(f"#{p + 1} runs per ball", lambda ms: ratio(ms, lambda m: m["pos"][p][0], lambda m: m["pos"][p][1]), 3)
            row(f"#{p + 1} outs per ball", lambda ms: ratio(ms, lambda m: m["pos"][p][3], lambda m: m["pos"][p][1]), 3)
            row(f"#{p + 1} out (share of innings batted)", lambda ms: ratio(ms, lambda m: m["pos"][p][3], lambda m: m["pos"][p][2]), 3)
            row(f"#{p + 1} bats (share of innings)", lambda ms: ratio(ms, lambda m: m["pos"][p][2], lambda m: 2 * m["n"]), 3)
        row("balls faced by 8-11 / innings", lambda ms: ratio(ms, lambda m: sum(m["pos"][p][1] for p in range(7, 11)), lambda m: 2 * m["n"]))
        row("runs by 8-11 / innings", lambda ms: ratio(ms, lambda m: sum(m["pos"][p][0] for p in range(7, 11)), lambda m: 2 * m["n"]))
        for k in range(10):
            row(f"{k} down: legal balls / innings", lambda ms: ratio(ms, lambda m: m["state"][k][0], lambda m: 2 * m["n"]))
            row(f"{k} down: runs per ball", lambda ms: ratio(ms, lambda m: m["state"][k][1], lambda m: m["state"][k][0]), 3)
            row(f"{k} down: wickets per ball", lambda ms: ratio(ms, lambda m: m["state"][k][2], lambda m: m["state"][k][0]), 4)
        for k in range(10):
            row(f"1st inns {k} down: legal balls / innings", lambda ms: ratio(ms, lambda m: m["state2"][k][0], lambda m: m["n"]))
            row(f"1st inns {k} down: wickets per ball", lambda ms: ratio(ms, lambda m: m["state2"][k][2], lambda m: m["state2"][k][0]), 4)
        for q in range(2):
            for k, nm in enumerate(["overs 1-6", "overs 7-15", "overs 16-20"]):
                row(f"inns {q + 1} {nm}: runs per ball", lambda ms: ratio(ms, lambda m: m["phase"][3 * q + k][1], lambda m: m["phase"][3 * q + k][0]), 3)
                row(f"inns {q + 1} {nm}: wickets per ball", lambda ms: ratio(ms, lambda m: m["phase"][3 * q + k][2], lambda m: m["phase"][3 * q + k][0]), 4)
                row(f"inns {q + 1} {nm}: legal balls", lambda ms: ratio(ms, lambda m: m["phase"][3 * q + k][0], lambda m: m["n"]), 1)
        if os.environ.get("TAILS_OVERS"):
            for o in range(20):
                row(f"1st inns over {o + 1}: wickets per ball", lambda ms: ratio(ms, lambda m: m["over1"][o][1], lambda m: m["over1"][o][0]), 4)
                row(f"1st inns over {o + 1}: runs per ball", lambda ms: ratio(ms, lambda m: m["over1"][o][2], lambda m: m["over1"][o][0]), 3)
        row("1st inns wickets", lambda ms: ratio(ms, lambda m: m["firstW"], lambda m: m["n"]))
        row("all inns wickets", lambda ms: ratio(ms, lambda m: sum(m["state"][k][2] for k in range(10)), lambda m: 2 * m["n"]))
        row("last stand: share of innings", lambda ms: ratio(ms, lambda m: m["last"][2], lambda m: 2 * m["n"]), 3)
        row("last stand: balls", lambda ms: ratio(ms, lambda m: m["last"][0], lambda m: m["last"][2]))
        row("last stand: runs", lambda ms: ratio(ms, lambda m: m["last"][1], lambda m: m["last"][2]))
        row("1st inns all out", lambda ms: ratio(ms, lambda m: m["allOut"], lambda m: m["n"]), 3)
        row("1st inns total", lambda ms: ratio(ms, lambda m: m["first"][0], lambda m: m["n"]), 1)
        for name, ms in (("real", R), ("sim", S)):
            t = sum(m["first"][0] for m in ms); t2 = sum(m["first"][1] for m in ms); n = sum(m["n"] for m in ms)
            print(f"  {name} 1st inns sd {math.sqrt(max(0, t2 / n - (t / n) ** 2)):.1f}", end="")
        print()
        si = [sum(m["standIn"][p] for m in S) for p in range(11)]
        print("  stand-ins (places of the real XIs not in the pool) by position: " + " ".join(map(str, si)))
        if S and "rat" in S[0]:
            rr = [sum(m["rat"][p][0] for m in S) / max(1, sum(m["rat"][p][1] for m in S)) for p in range(11)]
            print("  sim mean batting rating by position: " + " ".join(f"{x:.2f}" for x in rr))


def main():
    simf = sys.argv[1]
    key = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else "t20i-women"
    sim = json.loads(Path(simf).read_text())[key]
    real = real_matches(key)
    report(real, sim, "--md" in sys.argv)


if __name__ == "__main__":
    main()
