"""
Export the real T20 rating history of the game's players for the app's "ratings over time" view:
packages/app/public/data/rating-history.json, fetched lazily by the app.

Format (compact, one array per player):
  { "v": 1, "ids": { "espn_625383": 1196767, ... },     game id -> CricketArchive id ("ca_1196767" ids work too)
    "f": [ids of women],                                 so the right progression curves are used in combined leagues
    "p": { "1196767": [firstYear, bat, bowl, bat, bowl, ...] } }   one (bat, bowl) pair of 0-99 ovr per year from
                                                       firstYear to the last year with T20 data, -1 = none
Players are those of data/analysis/game_players.json that ca_espn_map.csv maps to a CricketArchive player with T20 rows.
Run from packages/ratings:  python3 -I src/analysis/export-rating-history.py
"""
import csv, json, subprocess, sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
OUT = ROOT.parent / "app" / "public" / "data" / "rating-history.json"


def main():
    game = json.load(open(DATA / "game_players.json"))
    espn_to_ca = {int(r["espn_id"]): int(r["ca_id"]) for r in csv.DictReader(open(DATA / "ca_espn_map.csv"))}
    ids = {}
    for p in game:
        tail = p["id"].split("_")[-1]
        if tail.isdigit() and int(tail) in espn_to_ca:
            ids[p["id"]] = espn_to_ca[int(tail)]
    wanted = sorted(set(ids.values()))
    q = (f"SELECT player_id, year, coalesce(bat_ovr, -1) b, coalesce(bowl_ovr, -1) w FROM '{DATA}/ca_ratings_by_year.parquet' "
         f"WHERE format = 'T20' AND player_id IN ({','.join(map(str, wanted))}) ORDER BY player_id, year")
    out = subprocess.run(["duckdb", "-csv", "-noheader", "-c", q], capture_output=True, text=True, cwd=ROOT)
    if out.returncode:
        sys.exit(out.stderr)
    rows = defaultdict(dict)
    for pid, year, b, w in csv.reader(out.stdout.splitlines()):
        rows[int(pid)][int(year)] = (int(float(b)), int(float(w)))
    hist = {}
    for pid, ys in rows.items():
        first, last = min(ys), max(ys)
        arr = [first]
        for y in range(first, last + 1):
            b, w = ys.get(y, (-1, -1))
            arr += [b, w]
        hist[str(pid)] = arr
    ids = {k: v for k, v in ids.items() if str(v) in hist}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    women = sorted({espn_to_ca[int(p["id"].split("_")[-1])] for p in game if p["g"] == "female" and p["id"].split("_")[-1].isdigit()
                    and int(p["id"].split("_")[-1]) in espn_to_ca} & {int(k) for k in hist})
    OUT.write_text(json.dumps({"v": 1, "ids": ids, "f": women, "p": hist}, separators=(",", ":")))
    print("wrote", OUT, OUT.stat().st_size // 1024, "KB;", len(hist), "players,", len(ids), "game ids")


if __name__ == "__main__":
    main()
