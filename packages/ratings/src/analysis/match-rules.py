"""
Fit the match-rules model (extras, dismissal kinds, free hits, run-outs, strike after a wicket, retirements, super overs)
from Cricsheet T20 ball-by-ball data and write it as a generated engine table
(packages/engine/src/match-rules-data.ts) plus a report (data/analysis/match_rules.json).

Inputs (read-only): data/analysis/deliveries.parquet, matches.parquet (all formats; filtered to T20 / IT20 here),
                    data/commentary/balls.jsonl.gz (only for the wide-for-height share).
Needs the `duckdb` CLI on PATH. Run from packages/ratings:  python3 -I src/analysis/match-rules.py

Conventions: "regular" = super_over = 0. Gender keys are "male" / "female". Free hits are the ball after a no-ball (and
carry through wides / no-balls bowled on a free hit); because some competitions did not apply free hits in every season,
free-hit statistics use 2016+ and competitions that always did (see FH_EVENTS).
"""
import gzip
import json
import re
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
OUT_TS = ROOT.parent / "engine" / "src" / "match-rules-data.ts"
OUT_JSON = DATA / "match_rules.json"
COMM = ROOT / "data" / "commentary" / "balls.jsonl.gz"

FH_EVENTS = ("Indian Premier League", "Big Bash League", "Women''s Big Bash League", "Pakistan Super League",
             "Caribbean Premier League", "Bangladesh Premier League", "Women''s Premier League", "SA20",
             "International League T20", "Major League Cricket")
NON_BOWLER = ("run out", "obstructing the field", "handled the ball", "hit the ball twice", "retired out", "timed out")

DB = Path(tempfile.mkdtemp()) / "mr.duckdb"


def run(sql, json_out=True):
    args = ["duckdb", str(DB)] + (["-json"] if json_out else []) + ["-c", sql]
    p = subprocess.run(args, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"duckdb failed: {p.stderr}\n{sql[:400]}")
    rows = json.loads(p.stdout) if json_out and p.stdout.strip() else []
    # DuckDB writes HUGEINT sums as strings
    num = re.compile(r"^-?\d+(\.\d+)?$")
    return [{k: (float(v) if num.match(v) else v) if isinstance(v, str) else v for k, v in row.items()} for row in rows]


def norm(counts):
    t = sum(counts.values()) or 1
    return {k: v / t for k, v in counts.items()}


def r(x, n=5):
    return round(float(x), n)


run(f"""
CREATE TABLE d AS
WITH base AS (
 SELECT d.*, m.gender, m.event, m.date, m.match_type, year(m.date) y,
   row_number() OVER (PARTITION BY d.match_id, d.innings, d.super_over ORDER BY d.over, d.ball, d.legal_ball_no) rn
 FROM '{DATA}/deliveries.parquet' d JOIN '{DATA}/matches.parquet' m USING(match_id) WHERE m.match_type IN ('T20','IT20')
), lagged AS (
 SELECT *, lag(noballs>0) OVER w nb1, lag(wides>0) OVER w wd1, lag(noballs>0,2) OVER w nb2, lag(wides>0,2) OVER w wd2,
   lag(noballs>0,3) OVER w nb3, lag(wides>0,3) OVER w wd3,
   lead(batter_id) OVER w nxt_batter, lead(over) OVER w nxt_over
 FROM base WINDOW w AS (PARTITION BY match_id, innings, super_over ORDER BY rn)
)
SELECT *, coalesce(nb1 OR (wd1 AND (nb2 OR (wd2 AND (nb3 OR wd3)))),false) AS free_hit,
  CASE WHEN player_out_id=batter_id THEN 'striker' WHEN player_out_id=non_striker_id THEN 'nonstriker' ELSE 'other' END orole,
  CASE WHEN player_out_id=batter_id THEN non_striker_id ELSE batter_id END survivor
FROM lagged;
""", json_out=False)

GENDERS = ("male", "female")
report = {}

# ── sample sizes ───────────────────────────────────────────────────────
s = run("SELECT gender, count(*) deliveries, count(distinct match_id) matches, count(distinct match_id||innings) innings FROM d WHERE super_over=0 GROUP BY 1")
report["sample"] = {x["gender"]: x for x in s}

# ── wides ──────────────────────────────────────────────────────────────
wide, wide_rate = {}, {}
for g in GENDERS:
    rows = run(f"SELECT wides w, count(*) n FROM d WHERE gender='{g}' AND super_over=0 AND wides>0 GROUP BY 1")
    wide[g] = {str(int(x["w"])): r(v) for x, v in zip(rows, [x["n"] for x in rows])}
    t = sum(x["n"] for x in rows)
    wide[g] = {str(int(x["w"])): r(x["n"] / t) for x in rows}
    tot = run(f"SELECT count(*) n FROM d WHERE gender='{g}' AND super_over=0")[0]["n"]
    wide_rate[g] = r(t / tot)

# ── no-balls: composition of the ball (bat runs, byes, leg byes) ───────
noball = {}
for g in GENDERS:
    rows = run(f"""SELECT runs_batter b, byes y, legbyes l, count(*) n FROM d WHERE gender='{g}' AND super_over=0 AND noballs>0 GROUP BY ALL ORDER BY n DESC""")
    t = sum(x["n"] for x in rows)
    noball[g] = [[int(x["b"]), int(x["y"]), int(x["l"]), r(x["n"] / t)] for x in rows if x["n"] / t >= 0.0004]

# ── byes / leg byes on legal balls ─────────────────────────────────────
byes = {}
for g in GENDERS:
    tot = run(f"SELECT count(*) n FROM d WHERE gender='{g}' AND super_over=0")[0]["n"]
    by = run(f"SELECT byes k, count(*) n FROM d WHERE gender='{g}' AND super_over=0 AND wides=0 AND noballs=0 AND byes>0 GROUP BY 1")
    lb = run(f"SELECT legbyes k, count(*) n FROM d WHERE gender='{g}' AND super_over=0 AND wides=0 AND noballs=0 AND legbyes>0 GROUP BY 1")
    nby, nlb = sum(x["n"] for x in by), sum(x["n"] for x in lb)
    byes[g] = {
        "rate": r((nby + nlb) / tot),            # bye or leg bye, per delivery
        "byeShare": r(nby / (nby + nlb)),
        "byeRuns": {str(int(x["k"])): r(x["n"] / nby) for x in by},
        "legByeRuns": {str(int(x["k"])): r(x["n"] / nlb) for x in lb},
    }

# ── penalty runs and overthrows ────────────────────────────────────────
tot_all = run("SELECT count(*) n FROM d WHERE super_over=0")[0]["n"]
pen = run("SELECT count(*) n FROM d WHERE super_over=0 AND penalty>0")[0]["n"]
ot = run("""SELECT
  sum((runs_batter in (5,7) OR (runs_batter=6 AND non_boundary=1))::int) after_run,
  sum((runs_batter=4 AND non_boundary=1)::int) after_dot,
  sum((runs_batter in (1,3))::int)+sum((runs_batter=2)::int) ran,
  sum((runs_batter=0)::int) dots
  FROM d WHERE super_over=0 AND wides=0 AND noballs=0 AND byes=0 AND legbyes=0 AND is_wicket=0""")[0]
overthrow = {
    "boundaryAfterRun": r(ot["after_run"] / (ot["ran"] + ot["after_run"]), 6),
    "boundaryAfterDot": r(ot["after_dot"] / ot["dots"], 6),
}

# ── wides for height (corpus text; indicative) ─────────────────────────
height = {"off": 0.5, "leg": 0.38, "height": 0.12, "n": 0}
if COMM.exists():
    c = {"height": 0, "leg": 0, "off": 0}
    with gzip.open(COMM, "rt") as f:
        for line in f:
            b = json.loads(line)
            if b.get("oc") != "wide":
                continue
            t = b.get("text") or ""
            if re.search(r"over (his|the) head|head high|above (his )?head|height|bouncer|beamer|too high", t, re.I):
                c["height"] += 1
            elif re.search(r"\bleg\b|down the leg|leg ?side", t, re.I):
                c["leg"] += 1
            else:
                c["off"] += 1
    n = sum(c.values())
    if n >= 100:
        height = {k: r(v / n, 3) for k, v in c.items()}
        height["n"] = n

# ── dismissal mix on normal legal balls (2019+, per gender) ────────────
mix = {}
for g in GENDERS:
    rows = run(f"""SELECT wicket_kind k, count(*) n FROM d WHERE gender='{g}' AND super_over=0 AND y>=2019 AND is_wicket=1
      AND wides=0 AND noballs=0 AND NOT free_hit AND wicket_kind IS NOT NULL AND wicket_kind NOT IN ('retired out') GROUP BY 1""")
    cnt = {x["k"]: x["n"] for x in rows}
    # rare kinds pooled over both genders and all years for stability (counts are tiny)
    mix[g] = cnt
rare = run("""SELECT wicket_kind k, count(*) n FROM d WHERE super_over=0 AND is_wicket=1 AND wicket_kind IN
  ('hit wicket','obstructing the field','handled the ball','hit the ball twice') GROUP BY 1""")
rare_n = {x["k"]: x["n"] for x in rare}
all_w = run("SELECT count(*) n FROM d WHERE super_over=0 AND is_wicket=1 AND wicket_kind IS NOT NULL AND wicket_kind<>'retired out'")[0]["n"]
KEYMAP = {"caught": "caught", "caught and bowled": "caught_and_bowled", "bowled": "bowled", "lbw": "lbw", "run out": "run_out",
          "stumped": "stumped", "hit wicket": "hit_wicket", "obstructing the field": "obstructing_the_field",
          "handled the ball": "handled_the_ball", "hit the ball twice": "hit_the_ball_twice"}
rare_rate = {KEYMAP[k]: v / all_w for k, v in rare_n.items()}   # share of all dismissals, both genders pooled
dismissal_mix = {}
for g in GENDERS:
    cnt = mix[g]
    main = {KEYMAP[k]: v for k, v in cnt.items() if k in ("caught", "caught and bowled", "bowled", "lbw", "run out", "stumped")}
    t = sum(main.values())
    m = {k: v / t for k, v in main.items()}
    scale = 1 - sum(rare_rate.values())
    m = {k: v * scale for k, v in m.items()}
    m.update(rare_rate)
    dismissal_mix[g] = {k: r(v, 6) for k, v in m.items()}

# ── share of wickets on normal legal balls, and wickets on wides / no-balls / free hits ──
legal_share, wide_wk, nb_wk = {}, {}, {}
for g in GENDERS:
    tot = run(f"""SELECT
      sum((wides=0 AND noballs=0 AND NOT free_hit)::int) legal, sum((wides=0 AND noballs=0 AND NOT free_hit AND is_wicket=1 AND wicket_kind<>'retired out')::int) legal_w,
      sum((wides>0)::int) wd, sum((wides>0 AND is_wicket=1 AND wicket_kind<>'retired out')::int) wd_w,
      sum((noballs>0)::int) nb, sum((noballs>0 AND is_wicket=1 AND wicket_kind<>'retired out')::int) nb_w,
      sum((is_wicket=1 AND wicket_kind<>'retired out')::int) all_w
      FROM d WHERE gender='{g}' AND super_over=0 AND y>=2016""")[0]
    legal_share[g] = r(tot["legal_w"] / tot["all_w"], 5)
    wide_wk[g] = r(tot["wd_w"] / tot["wd"], 5)
    nb_wk[g] = r(tot["nb_w"] / tot["nb"], 5)
wmix = run("""SELECT wicket_kind k, count(*) n FROM d WHERE super_over=0 AND wides>0 AND is_wicket=1 AND wicket_kind IN ('stumped','run out','hit wicket') GROUP BY 1""")
wide_kinds = {KEYMAP[x["k"]]: r(x["n"] / sum(y["n"] for y in wmix)) for x in wmix}
nmix = run("""SELECT wicket_kind k, count(*) n FROM d WHERE super_over=0 AND noballs>0 AND is_wicket=1 AND wicket_kind IN ('run out','obstructing the field','handled the ball','hit the ball twice') GROUP BY 1""")
noball_kinds = {KEYMAP[x["k"]]: r(x["n"] / sum(y["n"] for y in nmix)) for x in nmix}

# ── free hits ─────────────────────────────────────────────────────────
ev = ",".join(f"'{e}'" for e in FH_EVENTS)
fhset = f"y>=2016 AND super_over=0 AND (match_type='IT20' OR event IN ({ev}))"
fh = run(f"""SELECT free_hit fh, count(*) n,
  sum((is_wicket=1 AND wicket_kind IN ('run out','obstructing the field','handled the ball','hit the ball twice'))::int) legal_wk,
  avg((runs_batter=0)::int) dot, avg((runs_batter=1)::int) one, avg((runs_batter=2)::int) two, avg((runs_batter=3)::int) three,
  avg((runs_batter=4)::int) four, avg((runs_batter=6)::int) six
  FROM d WHERE {fhset} AND wides=0 AND noballs=0 AND byes=0 AND legbyes=0 GROUP BY 1""")
f1 = next(x for x in fh if x["fh"] == "true"); f0 = next(x for x in fh if x["fh"] == "false")
base_wk = run(f"SELECT avg((is_wicket=1 AND wicket_kind<>'retired out')::int) w FROM d WHERE {fhset} AND wides=0 AND noballs=0 AND NOT free_hit")[0]["w"]
fh_kinds = run(f"""SELECT wicket_kind k, count(*) n FROM d WHERE {fhset} AND free_hit AND is_wicket=1 AND wicket_kind IN ('run out','obstructing the field','handled the ball','hit the ball twice') GROUP BY 1""")
fh_k = {KEYMAP[x["k"]]: x["n"] for x in fh_kinds}
# add the Laws-permitted rare kinds with their pooled rare share so they are not zero
for k in ("obstructing_the_field", "handled_the_ball", "hit_the_ball_twice"):
    fh_k.setdefault(k, 0)
    fh_k[k] += 0.1
free_hit = {
    "n": f1["n"],
    "wicketRatio": r((f1["legal_wk"] / f1["n"]) / base_wk, 4),     # run-out-type dismissals per free hit / dismissals per normal ball
    "kinds": {k: r(v, 4) for k, v in norm(fh_k).items()},
    "scoring": {k: r(f1[k] / f0[k], 3) for k in ("dot", "one", "two", "three", "four", "six")},
}
# the no-ball itself and the pre-fit extras
nb_ball = run(f"""SELECT avg(runs_batter) m, avg((runs_batter=6)::int) six, avg((runs_batter=4)::int) four FROM d WHERE {fhset} AND noballs>0""")[0]

# ── run-outs ──────────────────────────────────────────────────────────
ro_rows = run("""SELECT CASE WHEN wides>0 THEN 'wide' WHEN noballs>0 THEN 'noball' ELSE 'legal' END cls,
   least(runs_batter+byes+legbyes,3) rc, orole, count(*) n FROM d WHERE super_over=0 AND wicket_kind='run out' AND orole<>'other' GROUP BY ALL""")
ns_share = {}
for rc in range(4):
    a = sum(x["n"] for x in ro_rows if x["cls"] == "legal" and x["rc"] == rc and x["orole"] == "nonstriker")
    b = sum(x["n"] for x in ro_rows if x["cls"] == "legal" and x["rc"] == rc and x["orole"] == "striker")
    ns_share[str(rc)] = r(a / (a + b), 4) if a + b else 0.5
ext_ns = sum(x["n"] for x in ro_rows if x["cls"] != "legal" and x["orole"] == "nonstriker")
ext_all = sum(x["n"] for x in ro_rows if x["cls"] != "legal")
ns_share["extra"] = r(ext_ns / ext_all, 4)
rc_rows = run("""SELECT least(runs_batter,4) rc, count(*) n FROM d WHERE super_over=0 AND wicket_kind='run out' AND wides=0 AND noballs=0 GROUP BY 1""")
rc_dist = {str(int(x["rc"])): r(x["n"] / sum(y["n"] for y in rc_rows), 5) for x in rc_rows}
# fielders: share involving the bowler, the keeper (players with >= 3 stumpings), and two-fielder relays
run("""CREATE TABLE keepers AS SELECT fielder_ids k FROM d WHERE wicket_kind='stumped' AND fielder_ids IS NOT NULL GROUP BY 1 HAVING count(*)>=3""")
fi = run("""SELECT count(*) n, sum((fielder_ids LIKE '%;%')::int) two,
  sum((fielder_ids = bowler_id OR fielder_ids LIKE bowler_id||';%' OR fielder_ids LIKE '%;'||bowler_id)::int) bowler,
  sum((split_part(fielder_ids,';',1) IN (SELECT k FROM keepers) OR split_part(fielder_ids,';',2) IN (SELECT k FROM keepers))::int) keeper
  FROM d WHERE super_over=0 AND y>=2019 AND wicket_kind='run out' AND fielder_ids IS NOT NULL""")[0]
run_out_fielders = {"bowlerInvolved": r(fi["bowler"] / fi["n"], 4), "keeperInvolved": r(fi["keeper"] / fi["n"], 4), "twoFielders": r(fi["two"] / fi["n"], 4)}
ck = run("""SELECT count(*) n, sum((fielder_ids IN (SELECT k FROM keepers))::int) k, sum((fielder_ids IS NULL)::int) nul FROM d WHERE super_over=0 AND y>=2019 AND wicket_kind='caught'""")[0]
catch_fielders = {"keeperShare": r(ck["k"] / ck["n"], 4), "substituteShare": r(ck["nul"] / ck["n"], 5)}

# ── who faces after a wicket (Cricsheet, matches from Oct 2022: the 2022 Laws) ──
st = run("""SELECT wicket_kind k, orole, (runs_batter+byes+legbyes)%2 par, count(*) n, avg((nxt_batter<>survivor)::int) p
  FROM d WHERE is_wicket=1 AND super_over=0 AND nxt_over=over AND nxt_batter IS NOT NULL AND wides=0 AND date>='2022-10-01'
  AND wicket_kind IN ('caught','caught and bowled','bowled','lbw','stumped','hit wicket','run out') GROUP BY ALL""")
strike = {}
for x in st:
    if x["k"] == "run out":
        strike[f"run_out_{'ns' if x['orole']=='nonstriker' else 's'}_{int(x['par'])}"] = r(x["p"], 4)
other = [x for x in st if x["k"] != "run out"]
strike["otherKinds"] = r(sum(x["p"] * x["n"] for x in other) / sum(x["n"] for x in other), 4)

# ── retirements, incomplete overs, Mankad, timed out ─────────────────
leg = run("SELECT count(*) n FROM d WHERE super_over=0 AND wides=0 AND noballs=0")[0]["n"]
hurt = run("SELECT count(*) n FROM d WHERE super_over=0 AND retired_kind IN ('retired hurt','retired not out')")[0]["n"]
innings_n = run("SELECT count(distinct match_id||innings) n FROM d WHERE super_over=0")[0]["n"]
ro_inn = run("SELECT count(*) n FROM d WHERE super_over=0 AND wicket_kind='retired out' AND y>=2022")[0]["n"]
ro_innings = run("SELECT count(distinct match_id||innings) n FROM d WHERE super_over=0 AND y>=2022")[0]["n"]
ro_prev = run("SELECT avg(over) o FROM d WHERE super_over=0 AND wicket_kind='retired out'")[0]["o"]
return_n = run("""SELECT count(*) n, sum((EXISTS (SELECT 1 FROM d d2 WHERE d2.match_id=d.match_id AND d2.innings=d.innings AND d2.super_over=0
   AND d2.rn>d.rn AND d2.batter_id=d.retired_player_id))::int) back FROM d WHERE super_over=0 AND retired_kind IN ('retired hurt','retired not out')""")[0]
ovs = run("""SELECT sum((nb>1)::int) split, count(*) n FROM (SELECT count(distinct bowler_id) nb FROM d WHERE super_over=0 GROUP BY match_id, innings, over)""")[0]
all_formats = run(f"SELECT count(*) n FROM '{DATA}/deliveries.parquet' WHERE wicket_kind='timed out'")[0]["n"]
w_all = run(f"SELECT count(*) n FROM '{DATA}/deliveries.parquet' WHERE is_wicket=1")[0]["n"]
retire = {
    "hurtPerBatterBall": r(hurt / (2 * leg), 8),
    "returnProb": r((return_n["back"] + 0.5) / (return_n["n"] + 1), 5),  # 0 of 247 resumed in the data: Jeffreys estimate
    "retiredOutPerInning": r(ro_inn / ro_innings, 5),
    "retiredOutAvgOver": r(ro_prev, 1),
    "bowlerLeavesPerOver": r(ovs["split"] / ovs["n"], 6),
    "timedOutPerWicket": r((all_formats + 0.5) / w_all, 8),   # no timed-out in any T20; Jeffreys over every format's wickets
    # a genuine Mankad is recorded as an ordinary run out in Cricsheet and cannot be isolated; ~20 known T20 cases over this many deliveries
    "mankadPerDelivery": r(20 / tot_all, 8),
}

# ── super overs ───────────────────────────────────────────────────────
so = run("""SELECT match_id, innings, sum(runs_total) runs, sum(is_wicket) w FROM d WHERE super_over=1 GROUP BY 1,2""")
so_stats = {
    "innings": len(so),
    "meanRuns": r(sum(x["runs"] for x in so) / len(so), 3),
    "meanWickets": r(sum(x["w"] for x in so) / len(so), 3),
    "twoWicketShare": r(sum(1 for x in so if x["w"] >= 2) / len(so), 3),
}

params = {
    "wide": {"rate": wide_rate, "runs": wide, "kind": height, "wicketRate": wide_wk, "wicketKinds": wide_kinds},
    "noBall": {"bat": noball, "wicketRate": nb_wk, "wicketKinds": noball_kinds, "batRunsMean": r(nb_ball["m"], 3)},
    "byes": byes,
    "penaltyPerDelivery": r(pen / tot_all, 8),
    "overthrow": overthrow,
    "legalWicketShare": legal_share,
    "dismissalMix": dismissal_mix,
    "freeHit": free_hit,
    "runOut": {"nonStrikerShare": ns_share, "runsCompleted": rc_dist, "fielders": run_out_fielders},
    "catchFielders": catch_fielders,
    "strike": strike,
    "retire": retire,
    "superOver": so_stats,
}
report["params"] = params
report["sources"] = {"deliveries": tot_all, "freeHitBallsFit": f1["n"], "dismissals": all_w, "retiredHurt": hurt}
OUT_JSON.write_text(json.dumps(report, indent=1))

header = """/**
 * GENERATED by packages/ratings/src/analysis/match-rules.py from Cricsheet T20 / IT20 ball-by-ball data. Do not edit.
 * Rates for the situations the engines model beyond a plain run or wicket: extras, dismissal kinds, free hits,
 * run-outs, strike after a wicket, retirements, super overs. See docs/RULES-MATCH.md section 12.
 */
"""
OUT_TS.write_text(header + "export const MATCH_RULES_DATA = " + json.dumps(params, indent=2) + " as const;\n")
print("wrote", OUT_TS, "and", OUT_JSON)
print(json.dumps(params, indent=1)[:6000])
