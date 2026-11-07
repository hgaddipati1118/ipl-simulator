"""
Per-season fielding and keeping ratings for EVERY Cricsheet player (not only those with a known birth date, which is all
fielding_player_seasons.csv holds), for the app's "ratings over time" chart. Same method as fielding-progression.py
(Gamma-Poisson shrinkage with the fitted k, 14 points per SD, 0-99 with 50 = average, clamped to 15-99), which this
imports: season_fielding_z / season_keeping_z. Each season is shrunk on its own, so a thin season sits near 50
and a single season is noisy (the chart says so).

Writes data/analysis/fielding_player_seasons_all.csv (new file):
    cricsheet_id, cricinfo_id, gender, year, field_inns, fielding, keep_inns, keeping
Seasons are calendar years with at least MIN_FIELD_INNS fielding (MIN_KEEP_INNS keeper) innings, counted over all
innings used by the ratings (keeper identified, 60+ balls, 9-12 players).

Run from packages/ratings:  python3 -I src/analysis/fielding-seasons.py   (after fielding-stats.sql and fielding-ratings.py)
"""
import csv, importlib.util, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DATA = ROOT / "data" / "analysis"
OUT = DATA / "fielding_player_seasons_all.csv"
MIN_FIELD_INNS = 4          # below this a season is shrunk almost to 50 and says nothing (and the chart's file must stay small)
MIN_KEEP_INNS = 4

spec = importlib.util.spec_from_file_location("fp", HERE / "fielding-progression.py")
fp = importlib.util.module_from_spec(spec)
sys.modules["fp"] = fp
spec.loader.exec_module(fp)
# the progression script needs a birth date to age a season; here age is irrelevant, so every player gets a dummy one
fp.DOB = ("(SELECT pid, gender, '1990-06-15' AS dob FROM (SELECT pid, gender FROM 'data/analysis/fielding_player_innings.parquet' "
          "UNION SELECT keeper_id, gender FROM 'data/analysis/keeping_innings.parquet') GROUP BY ALL)")


def main():
    cinfo = {}
    for r in csv.DictReader(open(DATA / "fielding_ratings.csv")):
        if r["cricinfo_id"]:
            cinfo[r["cricsheet_id"]] = r["cricinfo_id"]
    frows, krows = fp.load_fielding(), fp.load_keeping()
    n = 0
    with open(OUT, "w", newline="") as fh:
        wr = csv.writer(fh)
        wr.writerow(["cricsheet_id", "cricinfo_id", "gender", "year", "field_inns", "fielding", "keep_inns", "keeping"])
        for key in sorted(set(frows) | set(krows), key=lambda k: (k[1], k[0], k[2])):
            pid, g, y = key
            fd, kd = frows.get(key), krows.get(key)
            if fd and fd["inns"] < MIN_FIELD_INNS:
                fd = None
            if kd and kd["inns"] < MIN_KEEP_INNS:
                kd = None
            if not (fd or kd) or pid not in cinfo:
                continue
            wr.writerow([pid, cinfo[pid], g, y, fd["inns"] if fd else 0,
                         max(15, min(99, round(50 + fp.SCALE * fp.season_fielding_z(fd, g)))) if fd else "",
                         kd["inns"] if kd else 0,
                         max(15, min(99, round(50 + fp.SCALE * fp.season_keeping_z(kd, g)))) if kd else ""])
            n += 1
    print("wrote", OUT, n, "player-seasons")


if __name__ == "__main__":
    main()
