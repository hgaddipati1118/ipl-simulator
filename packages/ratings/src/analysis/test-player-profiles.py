"""
Each player's Test profile for the Test engine (docs/FORMATS.md, Test section 3.2): where he usually bats and how much he
bowls in first-class cricket, Tests first. Written as a generated engine table, packages/engine/src/test-profile-data.ts.
The engine orders a Test XI by the usual position and takes a player into the attack on his bowling workload, rather than
on his T20 role (a T20 "batsman" can be a Test spinner).

Inputs (CricketArchive, already in data/analysis):
  ca_cells.parquet     per player, competition and season: batting innings with the mean batting position, balls bowled
  ca_espn_map.csv      CricketArchive id -> ESPN id
  game_players.json    the game's players (ESPN ids); only they get a profile

Per player, from first-class cells (Tests are the class "intl_full"), the first window with enough innings:
  Tests in the last six seasons, all first-class cricket in the last six, Tests ever, first-class cricket ever.
  position = the innings-weighted mean batting position (6 innings at least; 4 for the last window)
  workload = balls bowled per innings in the field (innings batted or bowled in, whichever is more):
             2 = front-line (36+ balls, six overs), 1 = part-time (6+), 0 = does not bowl

Needs the `duckdb` CLI on PATH. Run from packages/ratings:
  python3 -I src/analysis/test-player-profiles.py            (SHOW="Name,Name" prints those players' evidence)
"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
OUT_TS = ROOT.parent / "engine" / "src" / "test-profile-data.ts"

RECENT = 6           # seasons counted as recent (up to the latest season in the data)
MIN_INNS = 6         # innings a window needs (MIN_LAST for the last one)
MIN_LAST = 4
FRONT_LINE = 36      # balls per innings in the field (six overs)
PART_TIME = 6


def duck(sql):
    p = subprocess.run(["duckdb", "-json", "-c", sql], capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"duckdb failed: {p.stderr}\n{sql[:600]}")
    return json.loads(p.stdout) if p.stdout.strip() else []


def main():
    players = json.load(open(DATA / "game_players.json"))
    names = {int(p["id"][5:]): p["name"] for p in players if p["id"].startswith("espn_") and p["id"][5:].isdigit()}
    rows = duck(f"""
WITH m AS (SELECT DISTINCT CAST(espn_id AS BIGINT) espn_id, CAST(ca_id AS BIGINT) ca_id FROM read_csv_auto('{DATA / "ca_espn_map.csv"}')),
fc AS (SELECT m.espn_id, c.side, c.comp_class = 'intl_full' AS test, c.year, c.inns, c.balls, c.mean_position
       FROM '{DATA / "ca_cells.parquet"}' c JOIN m ON m.ca_id = c.player_id WHERE c.format = 'FC'),
lim AS (SELECT max(year) - {RECENT - 1} y FROM fc)
SELECT espn_id, CAST(test AS INT) test, CAST(year >= (SELECT y FROM lim) AS INT) recent,
  sum(CASE WHEN side = 'bat' THEN inns ELSE 0 END) bat_inns,
  sum(CASE WHEN side = 'bat' THEN mean_position * inns ELSE 0 END) pos_sum,
  sum(CASE WHEN side = 'bowl' THEN inns ELSE 0 END) bowl_inns,
  sum(CASE WHEN side = 'bowl' THEN balls ELSE 0 END) balls_bowled
FROM fc GROUP BY ALL""")
    cells = {}
    for x in rows:
        e = int(x["espn_id"])
        if e in names:
            cells.setdefault(e, []).append(x)

    def window(xs, test, recent):
        sel = [x for x in xs if (not test or int(x["test"]) == 1) and (not recent or int(x["recent"]) == 1)]
        bat = sum(int(x["bat_inns"]) for x in sel)
        bowl = sum(int(x["bowl_inns"]) for x in sel)
        return {"bat": bat, "pos": sum(float(x["pos_sum"] or 0) for x in sel) / bat if bat else None,
                "field": max(bat, bowl), "balls": sum(float(x["balls_bowled"] or 0) for x in sel)}

    out = {}
    show = {s.strip() for s in os.environ.get("SHOW", "").split(",") if s.strip()}
    for e, xs in cells.items():
        wins = [window(xs, True, True), window(xs, False, True), window(xs, True, False), window(xs, False, False)]
        pos = next((w["pos"] for i, w in enumerate(wins) if w["pos"] is not None and w["bat"] >= (MIN_LAST if i == 3 else MIN_INNS)), None)
        load = next((w["balls"] / w["field"] for i, w in enumerate(wins) if w["field"] >= (MIN_LAST if i == 3 else MIN_INNS)), None)
        if pos is None and load is None:
            continue
        bowl = None if load is None else 2 if load >= FRONT_LINE else 1 if load >= PART_TIME else 0
        out[e] = (round(pos * 10) if pos is not None else 0, bowl)
        if names[e] in show:
            print(names[e], e, [(w["bat"], None if w["pos"] is None else round(w["pos"], 1), w["field"], round(w["balls"] / w["field"], 1) if w["field"] else None) for w in wins], "->", out[e], file=sys.stderr)

    # "espn id, position x 10 (0 = unknown), workload (2 front-line, 1 part-time, 0 none, - unknown)" joined by ";"
    body = ";".join(f"{e},{p},{'-' if b is None else b}" for e, (p, b) in sorted(out.items()))
    front = sum(1 for p, b in out.values() if b == 2)
    OUT_TS.write_text(f"""// GENERATED by packages/ratings/src/analysis/test-player-profiles.py from CricketArchive first-class cells. Do not edit.
/**
 * Test profiles (docs/FORMATS.md, Test section 3.2): per ESPN id, the usual first-class batting position (x 10, Tests first,
 * the last {RECENT} seasons first; 0 = unknown) and the bowling workload (2 = front-line, {FRONT_LINE}+ balls an innings in the field;
 * 1 = part-time; 0 = does not bowl; "-" = unknown). {len(out)} players, {front} front-line bowlers.
 */
export const TEST_PROFILE_DATA = "{body}";
""")
    print(f"wrote {OUT_TS}: {len(out)} profiles ({front} front-line bowlers), {len(body) // 1024} KB", file=sys.stderr)


if __name__ == "__main__":
    main()
