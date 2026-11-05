"""
Ball-handling audit tests.  Run from packages/ratings:   python3 -I src/analysis/__tests__/ball_handling.test.py

Builds small synthetic Cricsheet matches, pushes them through the REAL pipeline code
(src/analysis/cricsheet-deliveries.ts -> src/analysis/player-seasons.sql, using the env overrides RATINGS_MATCH_DIR / RATINGS_OUT_DIR /
RATINGS_PEOPLE_CSV and a scratch working directory) and asserts per-player balls, runs, conceded runs and wickets.
Part 2 spot-checks specific real Cricsheet matches in data/analysis/*.parquet (read-only).
Needs: npx tsx, duckdb.  Exit code is non-zero if any assertion fails.
"""

import csv
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FAILS, PASSES = [], 0


def check(name, got, want):
    global PASSES
    ok = (abs(got - want) < 1e-9) if isinstance(want, float) else (str(got).lower() == str(want).lower() if isinstance(want, bool) else got == want)
    if ok:
        PASSES += 1
    else:
        FAILS.append(f"{name}: got {got!r}, want {want!r}")
        print(f"  FAIL {name}: got {got!r}, want {want!r}")


# ───────────────────────── synthetic match builder ─────────────────────────
PEOPLE = {}


def pid(name):
    PEOPLE[name] = "id_" + name.replace(" ", "_")
    return PEOPLE[name]


def dl(batter, bowler, non_striker, bat=0, wides=0, noballs=0, byes=0, legbyes=0, penalty=0, wickets=None, non_boundary=False):
    ex = {k: v for k, v in (("wides", wides), ("noballs", noballs), ("byes", byes), ("legbyes", legbyes), ("penalty", penalty)) if v}
    e = sum(ex.values())
    d = {"batter": batter, "bowler": bowler, "non_striker": non_striker, "runs": {"batter": bat, "extras": e, "total": bat + e}}
    if non_boundary:
        d["runs"]["non_boundary"] = True
    if ex:
        d["extras"] = ex
    if wickets:
        d["wickets"] = wickets
    return d


def out(player, kind, fielders=None):
    w = {"player_out": player, "kind": kind}
    if fielders:
        w["fielders"] = [{"name": f} for f in fielders]
    return w


def match(mid, teams, innings, match_type="T20", event="Test League", overs=20, bpo=6, team_type="club", date="2024-04-01", stage=None):
    names = set()
    for inn in innings:
        for o in inn["overs"]:
            for d in o["deliveries"]:
                names.update([d["batter"], d["bowler"], d["non_striker"]])
                for w in d.get("wickets", []):
                    names.add(w["player_out"])
    ev = {"name": event}
    if stage:
        ev["stage"] = stage
    return mid, {"meta": {"data_version": "1.1.0"},
                 "info": {"dates": [date], "season": date[:4], "match_type": match_type, "gender": "male", "team_type": team_type, "event": ev,
                          "teams": teams, "overs": overs, "balls_per_over": bpo, "venue": "Test Ground", "city": "Testville",
                          "outcome": {"winner": teams[0], "by": {"runs": 5}}, "registry": {"people": {n: pid(n) for n in names}}},
                 "innings": innings}


def over(i, deliveries):
    return {"over": i, "deliveries": deliveries}


def build_matches():
    X, Y = "Team X", "Team Y"
    pp = [{"from": 0.1, "to": 5.6, "type": "mandatory"}]
    # ── Match A: every extras / dismissal edge case, one innings ──
    over0 = [
        dl("A1", "B1", "A2", bat=1),                                                        # d1 normal single
        dl("A1", "B1", "A2", wides=1),                                                      # d2 wide
        dl("A1", "B1", "A2", bat=4, noballs=1),                                             # d3 no-ball, four off the bat
        dl("A1", "B1", "A2", bat=6),                                                        # d4 FREE HIT, six
        dl("A1", "B1", "A2", byes=1),                                                       # d5 bye
        dl("A1", "B1", "A2", legbyes=2),                                                    # d6 leg-bye
        dl("A1", "B1", "A2", bat=2, penalty=5),                                             # d7 two off the bat plus 5 penalty runs
        dl("A1", "B1", "A2", wides=1, wickets=[out("A1", "stumped", ["KEEPER"])]),          # d8 stumped off a wide
    ]
    over1 = [
        dl("A2", "B2", "A3", bat=2),                                                        # e0 A2 bats
        dl("A3", "B2", "A2", bat=1, wickets=[out("A2", "run out", ["F1"])]),                # e1 run out, NON-striker A2 is out
        dl("A3", "B2", "A4", wickets=[out("A3", "retired hurt")]),                          # e2 retired hurt: not a dismissal
        dl("A4", "B2", "A5", noballs=1, byes=2),                                            # e3 no-ball + byes
        dl("A4", "B2", "A5", wickets=[out("A4", "caught", ["F2"]), out("A5", "retired not out")]),   # e4 caught + retired not out on the same ball
        dl("A6", "B2", "A5", wickets=[out("A6", "handled the ball")]),                      # e5 handled the ball: not the bowler's
        dl("A7", "B2", "A5", bat=4, non_boundary=True),                                     # e6 all-run four
        dl("A8", "B2", "A5", wickets=[out("A8", "bowled")]),                                # e7 bowled
    ]
    over6 = [dl("A9", "B3", "A5", bat=1)]                                                   # middle overs
    over15 = [dl("A9", "B3", "A5", bat=1)]                                                  # death overs
    innA = {"team": X, "powerplays": pp, "overs": [over(0, over0), over(1, over1), over(6, over6), over(15, over15)]}
    matches = [match("A", [X, Y], [innA])]
    # ── Match B: a super over (must not feed player value) ──
    inn1 = {"team": X, "powerplays": pp, "overs": [over(0, [dl("SO1", "SOB", "SO2", bat=1)])]}
    so = {"team": Y, "super_over": True, "overs": [over(0, [dl("SO3", "SOB2", "SO4", bat=6)])]}
    matches.append(match("B", [X, Y], [inn1, so]))
    # ── Match C: rain-affected chase (target.overs 10) -> chase excluded; full first innings kept ──
    full1 = {"team": X, "powerplays": pp, "overs": [over(0, [dl("C1", "CB1", "C2", bat=1)]), over(19, [dl("C1", "CB1", "C2", bat=1)])]}
    short2 = {"team": Y, "powerplays": pp, "target": {"overs": 10, "runs": 90}, "overs": [over(0, [dl("C3", "CB2", "C4", bat=4)])]}
    matches.append(match("C", [X, Y], [full1, short2]))
    # ── Match D: The Hundred-style (5-ball sets, powerplay = first 5 sets) ──
    hp = [{"from": 0.1, "to": 4.5, "type": "mandatory"}]
    hund = {"team": X, "powerplays": hp, "overs": [over(4, [dl("H1", "HB1", "H2", bat=1)]), over(5, [dl("H1", "HB1", "H2", bat=1)]), over(15, [dl("H1", "HB1", "H2", bat=1)])]}
    matches.append(match("D", [X, Y], [hund], event="The Hundred Men's Competition", bpo=5, date="2024-08-01"))
    # ── Match E: an ODI (must not feed T20 player value) ──
    odi = {"team": X, "overs": [over(0, [dl("O1", "OB1", "O2", bat=1)])]}
    matches.append(match("E", [X, Y], [odi], match_type="ODI", overs=50, team_type="international", event="ODI Series", date="2024-05-01"))
    # ── Match F: ordinary balls to give every context cell some mass ──
    filler = {"team": X, "powerplays": pp, "overs": [over(i, [dl("F1", "FB1", "F2", bat=b) for b in (0, 1, 1, 4, 0, 2)]) for i in range(0, 20)]}
    matches.append(match("F", [X, Y], [filler]))
    return matches


def sh(cmd, cwd, env=None, stdin=None):
    p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, input=stdin)
    if p.returncode:
        print(p.stdout, p.stderr)
        raise SystemExit(f"command failed: {cmd}")
    return p.stdout


def q(cwd, sql):
    return json.loads(sh(["duckdb", "-json", "-c", sql], cwd) or "[]")


def run_synthetic():
    tmp = Path(tempfile.mkdtemp(prefix="ball-audit-"))
    try:
        mdir, out_dir = tmp / "json", tmp / "data" / "analysis"
        mdir.mkdir()
        out_dir.mkdir(parents=True)
        for mid, js in build_matches():
            (mdir / f"{mid}.json").write_text(json.dumps(js))
        with open(tmp / "people.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["identifier", "name", "unique_name", "key_cricinfo", "key_cricketarchive"])
            for n, i in PEOPLE.items():
                w.writerow([i, n, n, "", ""])
        env = dict(os.environ, RATINGS_MATCH_DIR=str(mdir), RATINGS_OUT_DIR=str(out_dir), RATINGS_PEOPLE_CSV=str(tmp / "people.csv"))
        sh(["npx", "tsx", str(ROOT / "src/analysis/cricsheet-deliveries.ts")], ROOT, env)
        sql = (ROOT / "src/analysis/player-seasons.sql").read_text()
        sh(["duckdb"], tmp, stdin=sql)
        bv = f"'{out_dir}/ball_values.parquet'"
        dv = f"'{out_dir}/deliveries.parquet'"

        # ── deliveries.parquet (flattening) ──
        r = q(tmp, f"SELECT legal_ball_no FROM {dv} WHERE match_id = 'A' AND innings = 1 AND \"over\" = 0 ORDER BY ball")
        check("legal ball numbering with a wide, a no-ball and a wide-stumping in the over", [x["legal_ball_no"] for x in r], [1, 1, 1, 2, 3, 4, 5, 5])
        r = q(tmp, f"SELECT is_wicket, wicket_kind, retired_kind FROM {dv} WHERE match_id = 'A' AND batter = 'A3' AND wickets_on_ball = 0 AND retired_kind IS NOT NULL")
        check("retired hurt: is_wicket = 0, retirement recorded separately", (r[0]["is_wicket"], r[0]["retired_kind"]), (0, "retired hurt"))
        r = q(tmp, f"SELECT is_wicket, wicket_kind, wickets_on_ball, retired_kind FROM {dv} WHERE match_id = 'A' AND batter = 'A4' AND wicket_kind = 'caught'")
        check("caught + retired not out on one ball: one dismissal, primary kind caught", (r[0]["is_wicket"], r[0]["wicket_kind"], r[0]["wickets_on_ball"], r[0]["retired_kind"]), (1, "caught", 1, "retired not out"))
        r = q(tmp, f"SELECT penalty, runs_total, runs_batter, runs_extras FROM {dv} WHERE match_id = 'A' AND penalty > 0")
        check("penalty column and totals", (r[0]["penalty"], r[0]["runs_total"], r[0]["runs_batter"], r[0]["runs_extras"]), (5, 7, 2, 5))

        # ── ball_values (ball level) ──
        def bv1(batter, extra=""):
            return q(tmp, f"SELECT * FROM {bv} WHERE match_id = 'A' AND batter_id = 'id_{batter}' {extra}")
        wide = bv1("A1", "AND NOT legal AND runs_batter = 0 AND bowler_extras = 1 AND NOT faced")
        check("plain wide: not faced, not legal, 1 extra charged to the bowler", len(wide), 1)
        nb = bv1("A1", "AND runs_batter = 4")[0]
        check("no-ball four: faced by batter", nb["faced"], True)
        check("no-ball four: not a legal delivery", nb["legal"], False)
        check("no-ball four: counts as a four", nb["is_four"], 1)
        check("no-ball extra charged to the bowler as an extra", nb["bowler_extras"], 1)
        fh = bv1("A1", "AND runs_batter = 6")[0]
        check("ball after a no-ball is a free hit", fh["free_hit"], 1)
        check("the no-ball itself is not a free hit", nb["free_hit"], 0)
        check("six counted", fh["is_six"], 1)
        st = bv1("A1", "AND bowler_wicket = 1")[0]
        check("stumped off a wide: bowler wicket", st["bowler_wicket"], 1)
        check("stumped off a wide: counted as a ball for the dismissal accounting", st["faced"], True)
        check("stumped off a wide: not a legal delivery", st["legal"], False)
        ro = q(tmp, f"SELECT bowler_wicket FROM {bv} WHERE match_id = 'A' AND batter_id = 'id_A3' AND runs_batter = 1")[0]
        check("run out is not a bowler wicket", ro["bowler_wicket"], 0)
        e7 = bv1("A8")[0]
        check("wickets down before the 8th ball of over 1 (retired hurt / retired not out do not count)", e7["wkts_down"], 4)
        check("bowled is a bowler wicket", e7["bowler_wicket"], 1)
        hb = bv1("A6")[0]
        check("handled the ball is not a bowler wicket", hb["bowler_wicket"], 0)
        ar = bv1("A7")[0]
        check("all-run four is not a four (non_boundary)", ar["is_four"], 0)
        check("phase: over 0 is powerplay", bv1("A1")[0]["phase"], "powerplay")
        check("phase: over 6 is middle", q(tmp, f"SELECT phase FROM {bv} WHERE match_id='A' AND \"ball_over\" = 6")[0]["phase"], "middle")
        check("phase: over 15 is death", q(tmp, f"SELECT phase FROM {bv} WHERE match_id='A' AND \"ball_over\" = 15")[0]["phase"], "death")
        check("super over excluded from player value", q(tmp, f"SELECT count(*) AS n FROM {bv} WHERE match_id = 'B'")[0]["n"], 1)
        check("super-over batter absent", q(tmp, f"SELECT count(*) AS n FROM {bv} WHERE batter_id IN ('id_SO3')")[0]["n"], 0)
        check("rain-reduced chase (target.overs 10) excluded", q(tmp, f"SELECT count(*) AS n FROM {bv} WHERE match_id = 'C' AND innings = 2")[0]["n"], 0)
        check("full first innings of the rain-affected match kept", q(tmp, f"SELECT count(*) AS n FROM {bv} WHERE match_id = 'C' AND innings = 1")[0]["n"], 2)
        check("ODI excluded from T20 value", q(tmp, f"SELECT count(*) AS n FROM {bv} WHERE match_id = 'E'")[0]["n"], 0)
        h = {r["ball_over"]: r["phase"] for r in q(tmp, f"SELECT ball_over, phase FROM {bv} WHERE match_id = 'D'")}
        check("Hundred: set 4 is still powerplay (5 sets)", h[4], "powerplay")
        check("Hundred: set 5 is middle", h[5], "middle")
        check("Hundred: set 15 is death", h[15], "death")

        # ── season tables: balls, runs, outs, conceded, wickets ──
        def bat(n):
            return q(tmp, f"SELECT * FROM '{out_dir}/batting_seasons.parquet' WHERE player_id = 'id_{n}' AND balls > 0")
        def bowl(n):
            return q(tmp, f"SELECT * FROM '{out_dir}/bowling_seasons.parquet' WHERE player_id = 'id_{n}'")
        a1 = [r for r in bat("A1")][0]
        check("A1 balls faced (wide not faced; no-ball, free hit, byes, penalty ball, stumped-off-wide dismissal count)", a1["balls"], 7)
        check("A1 runs: 1 + 4 + 6 + 2 (byes, leg-byes and penalty excluded)", a1["runs"], 13)
        check("A1 outs: stumped off the wide", a1["outs"], 1)
        check("A1 boundaries (four off a no-ball and the six)", a1["boundaries"], 2)
        a2 = [r for r in bat("A2")][0]
        check("A2 balls faced", a2["balls"], 1)
        check("A2 dismissed as the NON-striker: debited to A2", a2["outs_non_striker"], 1)
        check("A2 total outs", a2["outs"], 1)
        a3 = [r for r in bat("A3")][0]
        check("A3: retired hurt is not an out", a3["outs"], 0)
        a4 = [r for r in bat("A4")][0]
        check("A4 balls (no-ball with byes + the caught ball)", a4["balls"], 2)
        check("A4 runs (byes not credited)", a4["runs"], 0)
        check("A4 outs", a4["outs"], 1)
        check("A6 handled the ball counts as an out", [r for r in bat("A6")][0]["outs"], 1)
        check("A7 all-run four: 4 runs, 0 boundaries", ([r for r in bat("A7")][0]["runs"], [r for r in bat("A7")][0]["boundaries"]), (4, 0))
        b1 = bowl("B1")[0]
        check("B1 legal balls", b1["balls"], 5)
        check("B1 conceded: 1 + wide 1 + (4+1) + 6 + 0 + 0 + 2 (no penalty) + wide 1", b1["conceded"], 16)
        check("B1 wickets (stumped off a wide)", b1["wickets"], 1)
        b2 = bowl("B2")[0]
        check("B2 legal balls (the no-ball is not legal)", b2["balls"], 7)
        check("B2 conceded: 2 + 1 + 0 + (no-ball 1, byes not charged) + 0 + 0 + 4 + 0", b2["conceded"], 8)
        check("B2 wickets: caught + bowled only (run out, retired hurt, handled excluded)", b2["wickets"], 2)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ───────────────────────── real Cricsheet matches ─────────────────────────
def run_real():
    d = ROOT / "data" / "analysis"
    if not (d / "ball_values.parquet").exists():
        print("  (skipping real-match checks: data/analysis/ball_values.parquet missing)")
        return
    dv, bv, mv = f"'{d}/deliveries.parquet'", f"'{d}/ball_values.parquet'", f"'{d}/matches.parquet'"
    r = q(ROOT, f"SELECT is_wicket, wicket_kind, wickets_on_ball, retired_kind FROM {dv} WHERE match_id = '1512938' AND batter = 'DL Collins' AND wicket_kind = 'caught'")
    check("real 1512938: caught + retired not out on one ball = one dismissal", (r[0]["is_wicket"], r[0]["wickets_on_ball"], r[0]["retired_kind"]), (1, 1, "retired not out"))
    r = q(ROOT, f"SELECT penalty, runs_total, runs_batter FROM {dv} WHERE match_id = '1207751' AND penalty > 0")
    check("real 1207751: penalty delivery (2 off the bat + 5 penalty)", (r[0]["penalty"], r[0]["runs_batter"], r[0]["runs_total"]), (5, 2, 7))
    check("real: retired hurt never flagged as a wicket", q(ROOT, f"SELECT count(*) AS n FROM {dv} WHERE is_wicket = 1 AND wicket_kind IN ('retired hurt', 'retired not out')")[0]["n"], 0)
    check("real 1155306 (D/L, Denmark chase of 18 in 5.1 overs): chase excluded, Germany's innings kept",
          (q(ROOT, f"SELECT count(*) AS n FROM {bv} WHERE match_id = '1155306' AND innings = 2")[0]["n"] == 0, q(ROOT, f"SELECT count(*) AS n FROM {bv} WHERE match_id = '1155306' AND innings = 1")[0]["n"] > 100), (True, True))
    ph = {r["ball_over"]: r["phase"] for r in q(ROOT, f"SELECT ball_over, any_value(phase) AS phase FROM {bv} WHERE match_id = '1299204' GROUP BY 1")}
    check("real Hundred 1299204: sets 0-4 powerplay, set 5 middle, set 15 death", (ph[4], ph[5], ph[15]), ("powerplay", "middle", "death"))
    r = q(ROOT, f"SELECT (SELECT sum(bowler_wicket) FROM {bv}) AS got, "
                f"(SELECT count(*) FROM {dv} d JOIN {mv} m USING (match_id) WHERE m.match_type IN ('T20', 'IT20') AND d.super_over = 0 "
                f"AND d.wicket_kind IN ('bowled', 'caught', 'caught and bowled', 'lbw', 'stumped', 'hit wicket')) AS all_credited, "
                f"(SELECT count(*) FROM {dv} d JOIN {mv} m USING (match_id) WHERE m.match_type IN ('T20', 'IT20') AND d.super_over = 0 "
                f"AND d.wicket_kind IN ('run out', 'obstructing the field', 'handled the ball', 'timed out', 'hit the ball twice', 'retired out')) AS not_credited")[0]
    check("real: bowler wickets in ball_values = whitelisted dismissals (less rain-reduced innings, about 3%)", 0.95 <= float(r["got"]) / float(r["all_credited"]) <= 1.0, True)
    check("real: run outs etc. exist in the data but are not bowler wickets (>16k)", r["not_credited"] > 16000 and float(r["got"]) <= float(r["all_credited"]), True)
    check("real: super-over balls absent from ball_values",
          q(ROOT, f"SELECT count(*) AS n FROM {bv} b JOIN {dv} d ON d.match_id = b.match_id AND d.innings = b.innings AND d.\"over\" = b.ball_over AND d.batter_id = b.batter_id WHERE d.super_over = 1")[0]["n"], 0)
    check("real: ball_values holds only T20 / IT20 matches",
          q(ROOT, f"SELECT count(*) AS n FROM {bv} b JOIN {mv} m USING (match_id) WHERE m.match_type NOT IN ('T20', 'IT20')")[0]["n"], 0)
    check("real: free-hit balls exist and follow no-balls (>5000 flagged)", q(ROOT, f"SELECT count(*) > 5000 AS ok FROM {bv} WHERE free_hit = 1")[0]["ok"], True)
    check("real: from 2019 bowler-credited dismissals on free-hit balls are essentially absent (< 0.5%; the rule bars them)",
          q(ROOT, f"SELECT avg(bowler_wicket) < 0.005 AS ok FROM {bv} WHERE free_hit = 1 AND faced AND year(date) >= 2019")[0]["ok"], True)


if __name__ == "__main__":
    print("synthetic matches through the real pipeline...")
    run_synthetic()
    print("real Cricsheet matches...")
    run_real()
    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    for f in FAILS:
        print("  -", f)
    sys.exit(1 if FAILS else 0)
