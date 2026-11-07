"""
Export the real T20 rating history of the game's players for the app's "ratings over time" view:
packages/app/public/data/rating-history.json, fetched lazily by the app.

Format (compact, one array per player):
  { "v": 1, "ids": { "espn_625383": 1196767, ... },     game id -> CricketArchive id ("ca_1196767" ids work too)
    "f": [ids of women],                                 so the right progression curves are used in combined leagues
    "p": { "1196767": [firstYear, bat, bowl, bat, bowl, ...] } }   one (bat, bowl) pair of 0-99 ovr per year from
                                                       firstYear to the last year with T20 data, -1 = none
Version 2 adds "q": { "1196767": [firstYear, fielding, fielding, ...] } (one value per year from the first to the last year with a
fielding season, -1 = none) and "k": the same for keeping, only for players who kept wicket, each with its own first year. Built by fielding-seasons.py: each season is the 0-99 fielding /
keeping rating of that calendar year alone, with the same Gamma-Poisson shrinkage and scale as the career ratings (so a thin season sits near
50 and a single season is noisy). Version 1 files (no "q") are still read by the app.
Players are those of data/analysis/game_players.json that ca_espn_map.csv maps to a CricketArchive player with T20 rows.
Run from packages/ratings (after fielding-seasons.py):  python3 -I src/analysis/export-rating-history.py
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
    # fielding and keeping seasons (fielding-seasons.py), by Cricinfo id = the tail of the game id
    seasons = DATA / "fielding_player_seasons_all.csv"
    q, k = {}, {}
    if seasons.exists():
        by_cinfo = defaultdict(lambda: defaultdict(dict))        # cricinfo id -> cricsheet id -> year -> (f, k)
        inns = defaultdict(int)
        for r in csv.DictReader(open(seasons)):
            by_cinfo[int(r["cricinfo_id"])][r["cricsheet_id"]][int(r["year"])] = (
                int(r["fielding"]) if r["fielding"] else -1, int(r["keeping"]) if r["keeping"] else -1)
            inns[(int(r["cricinfo_id"]), r["cricsheet_id"])] += int(r["field_inns"]) + int(r["keep_inns"])
        for gid, ca in ids.items():
            tail = gid.split("_")[-1]
            if not tail.isdigit() or int(tail) not in by_cinfo or str(ca) in q:
                continue
            cands = by_cinfo[int(tail)]
            best = max(cands, key=lambda c: inns[(int(tail), c)])      # a player listed twice keeps the one with more innings
            ys = cands[best]
            for idx, store in ((0, q), (1, k)):
                have = {y: v[idx] for y, v in ys.items() if v[idx] >= 0}
                if have:
                    first, last = min(have), max(have)
                    store[str(ca)] = [first] + [have.get(y, -1) for y in range(first, last + 1)]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    women = sorted({espn_to_ca[int(p["id"].split("_")[-1])] for p in game if p["g"] == "female" and p["id"].split("_")[-1].isdigit()
                    and int(p["id"].split("_")[-1]) in espn_to_ca} & {int(k) for k in hist})
    OUT.write_text(json.dumps({"v": 2, "ids": ids, "f": women, "p": hist, "q": q, "k": k}, separators=(",", ":")))
    print("wrote", OUT, OUT.stat().st_size // 1024, "KB;", len(hist), "players,", len(ids), "game ids;", len(q), "with fielding,", len(k), "with keeping seasons")


if __name__ == "__main__":
    main()
