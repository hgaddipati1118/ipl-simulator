"""
Fit T20 competition strength from players who appear in more than one competition.

Model (batting; bowling is the same with runs_saved_per_100):
    runs_above_avg_per_100[player, competition, year]
        = skill[player, year] - strength[competition] + noise,   weighted by balls
A positive strength means the competition is hard: the same player does worse there.
Solved by alternating weighted least squares; strengths are centred on the Indian Premier
League (= 0) and shrunk toward 0 with a prior worth PRIOR_BALLS balls, so thinly linked
competitions stay neutral instead of swinging wildly.

Input:  data/analysis/{batting,bowling}_seasons.csv  (exported by the duckdb step below)
Output: data/analysis/league_strength.csv  competition, gender, batting/bowling strength, link balls

Run from packages/ratings:
    duckdb -c "COPY (SELECT player_id, gender, competition, year, balls, runs_above_avg_per_100 AS v FROM 'data/analysis/batting_seasons.parquet' WHERE balls >= 30) TO 'data/analysis/batting_seasons.csv'; COPY (SELECT player_id, gender, competition, year, balls, runs_saved_per_100 AS v FROM 'data/analysis/bowling_seasons.parquet' WHERE balls >= 30) TO 'data/analysis/bowling_seasons.csv'"
    python3 -I src/analysis/league-strength.py
"""

import csv
import sys
from collections import defaultdict
from pathlib import Path

DATA = Path(__file__).resolve().parents[2] / "data" / "analysis"
PRIOR_BALLS = 2000
ANCHOR = "Indian Premier League"
ITERATIONS = 50


def fit(path: Path):
    rows = []
    with path.open() as f:
        for r in csv.DictReader(f):
            if r["v"] in ("", "NULL"):
                continue
            rows.append((r["gender"], f'{r["player_id"]}:{r["year"]}', r["competition"], float(r["balls"]), float(r["v"])))

    results = {}
    for gender in ("male", "female"):
        g = [r for r in rows if r[0] == gender]
        # Only player-years seen in 2+ competitions inform strength
        comps_per_py = defaultdict(set)
        for _, py, c, _, _ in g:
            comps_per_py[py].add(c)
        linked = [r for r in g if len(comps_per_py[r[1]]) > 1]

        strength = defaultdict(float)
        skill = defaultdict(float)
        link_balls = defaultdict(float)
        for _, _, c, w, _ in linked:
            link_balls[c] += w

        for _ in range(ITERATIONS):
            num, den = defaultdict(float), defaultdict(float)
            for _, py, c, w, v in linked:
                num[py] += w * (v + strength[c])
                den[py] += w
            skill = {py: num[py] / den[py] for py in num}

            num, den = defaultdict(float), defaultdict(float)
            for _, py, c, w, v in linked:
                num[c] += w * (skill[py] - v)
                den[c] += w
            strength = defaultdict(float, {c: num[c] / (den[c] + PRIOR_BALLS) for c in num})

            anchor = strength.get(ANCHOR, 0.0) if gender == "male" else 0.0
            for c in strength:
                strength[c] -= anchor
        results[gender] = (strength, link_balls)
    return results


def main():
    bat = fit(DATA / "batting_seasons.csv")
    bowl = fit(DATA / "bowling_seasons.csv")
    out = DATA / "league_strength.csv"
    with out.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["competition", "gender", "batting_strength", "bowling_strength", "batting_link_balls", "bowling_link_balls"])
        for gender in ("male", "female"):
            comps = set(bat[gender][0]) | set(bowl[gender][0])
            for c in sorted(comps):
                w.writerow([c, gender, round(bat[gender][0].get(c, 0.0), 2), round(bowl[gender][0].get(c, 0.0), 2),
                            round(bat[gender][1].get(c, 0.0)), round(bowl[gender][1].get(c, 0.0))])
    print(f"wrote {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
