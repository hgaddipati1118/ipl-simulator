"""
Fit the "extra" match rules (gendered extras, no-ball kinds, beamers, short runs, lodged balls, rain / reduced
overs / no result, DRS reviews, fielding errors) and write them as a generated engine table
(packages/engine/src/match-rules-extra-data.ts) plus a report (docs/data/match_rules_extra.json).

Inputs (read-only):
  data/analysis/deliveries.parquet, matches.parquet   Cricsheet, all formats; filtered to T20 / IT20 here
                                                      (The Hundred is match_type T20, 5-ball overs, "overs" = 20).
  data/commentary/<id>-<slug>.jsonl.gz                ESPNcricinfo raw ball-by-ball commentary (one match per line),
                                                      deduplicated by (matchId, innings, ball id); balls.jsonl.gz is a
                                                      derived subset of the same matches and is only used for an overlap check.
  data/analysis/fielding_player_innings.parquet       keeper id per (match, innings), for the caught-behind share of reviews.
  $CRICSHEET_JSON_DIR                                 raw Cricsheet JSON (*.json, one match per file) with the DRS `review`
                                                      objects. Default: packages/ratings/data/cricsheet/json. To create it:
                                                      download ipl|wpl|bbl|wbb|psl|cpl|sat|ilt|mlc|hnd|bpl|lpl|t20s _json.zip
                                                      from https://cricsheet.org/downloads/ and unzip them into one empty
                                                      directory. The files are untrusted data and are only json.load-ed.
Needs the `duckdb` CLI on PATH. Run from packages/ratings:
  CRICSHEET_JSON_DIR=/path/to/json python3 -I src/analysis/match-rules-extra.py
(`-I` is fine: paths come from this file's location and the environment is read with os.environ.)

Conventions: "regular" = super_over = 0; gender keys "male" / "female"; rates are per delivery row (wides and no-balls count
as deliveries). Rare-event rates use the Jeffreys posterior mean (k + 0.5) / (N + 1) so zero counts stay positive.
"""
import collections
import glob
import gzip
import json
import os
import random
import re
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]            # packages/ratings
REPO = ROOT.parent.parent
DATA = ROOT / "data" / "analysis"
COMM_DIR = ROOT / "data" / "commentary"
OUT_TS = ROOT.parent / "engine" / "src" / "match-rules-extra-data.ts"
OUT_JSON = REPO / "docs" / "data" / "match_rules_extra.json"
JSON_DIR = Path(os.environ.get("CRICSHEET_JSON_DIR", str(ROOT / "data" / "cricsheet" / "json")))

DB = Path(tempfile.mkdtemp()) / "mre.duckdb"

# engine league id -> Cricsheet event name (verified against matches.parquet)
LEAGUES = {
    "ipl": "Indian Premier League", "wpl": "Women's Premier League", "bbl": "Big Bash League",
    "wbbl": "Women's Big Bash League", "psl": "Pakistan Super League", "sa20": "SA20",
    "hundred-m": "The Hundred Men's Competition", "hundred-w": "The Hundred Women's Competition",
    "cpl": "Caribbean Premier League", "ilt20": "International League T20", "mlc": "Major League Cricket",
    "bpl": "Bangladesh Premier League", "lpl": "Lanka Premier League",
}
EVENT_TO_LEAGUE = {v: k for k, v in LEAGUES.items()}
SHRINK = 20          # pseudo-matches for the rain shrink toward the pooled rate
EXTRAS_FROM_YEAR = 2019


def run(sql, json_out=True):
    args = ["duckdb", str(DB)] + (["-json"] if json_out else []) + ["-c", sql]
    p = subprocess.run(args, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"duckdb failed: {p.stderr}\n{sql[:400]}")
    rows = json.loads(p.stdout) if json_out and p.stdout.strip() else []
    num = re.compile(r"^-?\d+(\.\d+)?$")           # DuckDB writes HUGEINT as strings
    return [{k: (float(v) if num.match(v) else v) if isinstance(v, str) else v for k, v in row.items()} for row in rows]


def sq(s):
    return s.replace("'", "''")


def r(x, n=5):
    return round(float(x), n)


def jeffreys(k, n):
    return (k + 0.5) / (n + 1)


report = {"generatedBy": "packages/ratings/src/analysis/match-rules-extra.py"}
EVENTS_SQL = ", ".join(f"'{sq(e)}'" for e in LEAGUES.values())

run(f"""
CREATE TABLE d AS SELECT d.*, m.gender, m.event, m.team_type, year(m.date) y, m.match_type
FROM '{DATA}/deliveries.parquet' d JOIN '{DATA}/matches.parquet' m USING(match_id) WHERE m.match_type IN ('T20','IT20');
CREATE TABLE inn AS SELECT match_id, innings, count(*) FILTER (WHERE wides=0 AND noballs=0) legal,
  count(DISTINCT player_out_id) wk, max(inn_target_overs) t FROM d WHERE super_over=0 GROUP BY 1,2;
""", json_out=False)

# ── 1. extras rates (per gender) ───────────────────────────────────────
EXTRAS_FILTER = f"super_over=0 AND y >= {EXTRAS_FROM_YEAR} AND event IN ({EVENTS_SQL})"
INTL_FILTER = f"super_over=0 AND y >= {EXTRAS_FROM_YEAR} AND team_type='international'"
extras = {}
for g in ("male", "female"):
    row = run(f"""SELECT count(*) n, count(DISTINCT match_id) matches, sum((wides>0)::int) wide, sum((noballs>0)::int) noball,
      sum((byes>0 OR legbyes>0)::int) byelb FROM d WHERE gender='{g}' AND {EXTRAS_FILTER}""")[0]
    extras[g] = {"wide": r(row["wide"] / row["n"]), "noBall": r(row["noball"] / row["n"]), "byeLegBye": r(row["byelb"] / row["n"]),
                 "deliveries": int(row["n"]), "matches": int(row["matches"])}
report["extrasRate"] = {"filter": f"match_type T20/IT20, super_over=0, year >= {EXTRAS_FROM_YEAR}, event in the 13 engine leagues (franchise). T20Is are reported under bySource but not used: their women's wide rate is ~2x the leagues' because of associate-nation matches",
                        "perDelivery": "wides>0 / noballs>0 / (byes>0 or legbyes>0) over all delivery rows", **extras}
by_src = run(f"""SELECT gender, CASE WHEN event IN ({EVENTS_SQL}) THEN 'franchise' ELSE 'international' END src, count(*) n,
  round(sum((wides>0)::int)::double/count(*),5) wide, round(sum((noballs>0)::int)::double/count(*),5) noball,
  round(sum((byes>0 OR legbyes>0)::int)::double/count(*),5) byelb FROM d WHERE ({EXTRAS_FILTER}) OR ({INTL_FILTER}) GROUP BY 1,2 ORDER BY 1,2""")
report["extrasRate"]["bySource"] = by_src

# ── 2. rain / reduced overs / no result ────────────────────────────────
run("""
CREATE TABLE mm AS
SELECT m.match_id, m.event, m.gender, m.result, m.outcome_method, m.overs, m.balls_per_over bpo, m.overs*m.balls_per_over full_balls,
  i1.legal l1, i1.wk w1, i2.t t2,
  CASE WHEN i2.t IS NULL THEN NULL ELSE floor(i2.t)*m.balls_per_over + round((i2.t-floor(i2.t))*10) END tb
FROM (SELECT * FROM 'DATA_matches' WHERE match_type IN ('T20','IT20')) m
LEFT JOIN inn i1 ON i1.match_id=m.match_id AND i1.innings=1 LEFT JOIN inn i2 ON i2.match_id=m.match_id AND i2.innings=2;
""".replace("DATA_matches", f"{DATA}/matches.parquet"), json_out=False)
run("""CREATE TABLE mm2 AS SELECT *, (result='no result') nr,
  (result <> 'no result' AND (outcome_method IS NOT NULL OR (tb IS NOT NULL AND tb < full_balls))) red FROM mm""", json_out=False)

lg = run(f"SELECT event, count(*) n, sum(nr::int) nr, sum(red::int) red FROM mm2 WHERE event IN ({EVENTS_SQL}) GROUP BY 1")
tot_n = sum(x["n"] for x in lg)
pool_nr = sum(x["nr"] for x in lg) / tot_n
pool_red = sum(x["red"] for x in lg) / tot_n
by_league = {}
for x in lg:
    lid = EVENT_TO_LEAGUE[x["event"]]
    by_league[lid] = {"matches": int(x["n"]), "pNoResult": r((x["nr"] + SHRINK * pool_nr) / (x["n"] + SHRINK)),
                      "pReduced": r((x["red"] + SHRINK * pool_red) / (x["n"] + SHRINK)),
                      "noResults": int(x["nr"]), "reducedWithResult": int(x["red"]),
                      "rawPNoResult": r(x["nr"] / x["n"]), "rawPReduced": r(x["red"] / x["n"])}
by_league = {k: by_league[k] for k in LEAGUES if k in by_league}
rain_default = {"matches": int(tot_n), "pNoResult": r(pool_nr), "pReduced": r(pool_red),
                "noResults": int(sum(x["nr"] for x in lg)), "reducedWithResult": int(sum(x["red"] for x in lg))}

# when / oversPerSide: all reduced T20 / IT20 matches with a result (larger sample than the 13 leagues alone)
red_rows = run("SELECT match_id, event, bpo, full_balls, l1, w1, tb FROM mm2 WHERE red AND l1 IS NOT NULL AND tb IS NOT NULL")


def classify(row):
    l1, w1, tb, full = row["l1"], row["w1"], row["tb"], row["full_balls"]
    if l1 == tb or (w1 >= 10 and l1 <= tb):
        return "preMatch"          # both innings the same reduced length (cut before / at the start of innings 1)
    if l1 >= full or w1 >= 10:
        return "secondInnings"     # innings 1 ran its full length / all out, then the chase was cut
    return "firstInnings"          # innings 1 stopped short of its length, not all out: cut during innings 1


when_ct = collections.Counter(classify(x) for x in red_rows)
when_ct_leagues = collections.Counter(classify(x) for x in red_rows if x["event"] in EVENT_TO_LEAGUE)
tw = sum(when_ct.values())
when = {k: r(when_ct[k] / tw) for k in ("preMatch", "firstInnings", "secondInnings")}
ov_ct = collections.Counter()
for x in red_rows:
    if x["bpo"] == 6:                       # T20 over counts only (The Hundred is in balls)
        ov_ct[str(min(19, max(1, int(round(x["tb"] / 6)))))] += 1
tov = sum(ov_ct.values())
overs_per_side = {k: r(ov_ct[k] / tov) for k in sorted(ov_ct, key=int)}
report["rain"] = {
    "source": "Cricsheet matches/deliveries; pNoResult = result 'no result'; pReduced = reduced with a result: outcome_method set (D/L) or "
              "the chase's inn_target_overs < scheduled overs",
    "caveat": "Cricsheet omits matches abandoned without a ball, so pNoResult is a LOWER bound for 'no result once started' only in the "
              "sense of fully washed-out fixtures; matches with at least one ball are included.",
    "shrink": f"(k + {SHRINK} * pooled) / (n + {SHRINK}) toward the pooled 13-league rate",
    "byLeague": by_league, "default": rain_default,
    "whenCounts": dict(when_ct), "whenCountsEngineLeaguesOnly": dict(when_ct_leagues), "whenN": tw,
    "whenRule": "preMatch: first-innings legal balls == chase length (or all out within it); secondInnings: innings 1 ran full length or "
                "was all out, chase then cut; firstInnings: innings 1 stopped short of its length, not all out",
    "oversPerSideN": tov, "oversPerSideSource": "all T20/IT20 reduced matches with a result and 6-ball overs, chase length rounded to whole overs",
}

# ── 3. DRS from Cricsheet JSON ─────────────────────────────────────────
LBW_KINDS = {"lbw"}
CAUGHT_KINDS = {"caught", "caught and bowled"}


def kind_of(w):
    if w in LBW_KINDS:
        return "lbw"
    if w in CAUGHT_KINDS:
        return "caught"
    return "other"


def fit_drs():
    if not JSON_DIR.is_dir() or not glob.glob(str(JSON_DIR / "*.json")):
        raise SystemExit(f"CRICSHEET_JSON_DIR {JSON_DIR} has no *.json files; see the module docstring for how to download them")
    keepers = {}
    for x in run(f"SELECT 'm' || match_id mid, innings, 'k' || any_value(keeper_id) k FROM '{DATA}/fielding_player_innings.parquet' WHERE keeper_id IS NOT NULL GROUP BY 1,2"):
        keepers[(x["mid"][1:], int(x["innings"]))] = x["k"][1:]
    c = collections.Counter()
    league_m = collections.Counter()
    league_rm = collections.Counter()
    cb = collections.Counter()
    n_innings_drs = n_matches_drs = 0
    n_matches = 0
    for f in glob.glob(str(JSON_DIR / "*.json")):
        try:
            d = json.load(open(f))
        except (ValueError, OSError):
            continue
        info = d.get("info", {})
        if info.get("match_type") not in ("T20", "IT20"):
            continue
        n_matches += 1
        lid = EVENT_TO_LEAGUE.get((info.get("event") or {}).get("name"), "other")
        league_m[lid] += 1
        mid = os.path.basename(f)[:-5]
        reg = (info.get("registry") or {}).get("people") or {}
        reviews = []
        regular = [i for i in d.get("innings", []) if not i.get("super_over")]
        for idx, inn in enumerate(regular, 1):
            for o in inn.get("overs", []):
                for dl in o.get("deliveries", []):
                    rv = dl.get("review")
                    if not rv or rv.get("decision") not in ("upheld", "struck down"):
                        continue
                    wk = (dl.get("wickets") or [None])[0]
                    reviews.append((idx, inn.get("team"), rv, wk))
        if not reviews:
            continue
        n_matches_drs += 1
        league_rm[lid] += 1
        n_innings_drs += len(regular)
        for idx, bat_team, rv, wk in reviews:
            side = "bat" if rv.get("by") == bat_team else "field" if rv.get("by") else None
            if side is None:
                continue
            kd = kind_of(wk["kind"]) if wk else None
            uc = bool(rv.get("umpires_call"))
            c["total"] += 1
            if side == "bat":
                c["bat"] += 1
                if rv["decision"] == "upheld":
                    c["bat_over"] += 1                       # out decision overturned: no wicket on the ball
                elif wk:
                    c[f"bat_stood_{kd}"] += 1               # out decision stood
                    c[f"bat_stood_uc_{kd}"] += uc
            else:
                c["field"] += 1
                if rv["decision"] == "upheld" and wk:
                    c[f"field_up_{kd}"] += 1                 # not-out overturned to out
                elif rv["decision"] == "struck down" and not wk:
                    c["field_struck"] += 1
                    c["field_struck_uc"] += uc
            if kd == "caught" and wk and ((side == "bat" and rv["decision"] == "struck down") or (side == "field" and rv["decision"] == "upheld")):
                fielders = [x.get("name") for x in (wk.get("fielders") or []) if not x.get("substitute")]
                keeper = keepers.get((mid, idx))
                if keeper is None:
                    cb["unknownKeeper"] += 1
                elif wk["kind"] == "caught and bowled" or not fielders:
                    cb["notKeeper"] += 1
                else:
                    cb["keeper" if any(reg.get(nm) == keeper for nm in fielders) else "notKeeper"] += 1
    if not c["total"]:
        raise SystemExit("no DRS reviews found in CRICSHEET_JSON_DIR")
    # batting side: out decisions reviewed. Overturned reviews have no wicket, so their kind is unknown: split by the stood mix.
    s_l = c["bat_stood_lbw"] / (c["bat_stood_lbw"] + c["bat_stood_caught"])
    bo_l, bo_c = c["bat_over"] * s_l, c["bat_over"] * (1 - s_l)
    bn_l, bn_c = c["bat_stood_lbw"] + bo_l, c["bat_stood_caught"] + bo_c
    batting = {"lbw": {"overturned": r(bo_l / bn_l), "umpiresCall": r(c["bat_stood_uc_lbw"] / bn_l)},
               "caught": {"overturned": r(bo_c / bn_c), "umpiresCall": r(c["bat_stood_uc_caught"] / bn_c)}}
    # fielding side: not-out decisions reviewed. Upheld ones have a kind; struck-down ones do not, except umpire's call = lbw.
    u_l = c["field_up_lbw"] / (c["field_up_lbw"] + c["field_up_caught"])
    f_nonuc = c["field_struck"] - c["field_struck_uc"]
    fn_l = c["field_up_lbw"] + c["field_struck_uc"] + f_nonuc * u_l
    fn_c = c["field_up_caught"] + f_nonuc * (1 - u_l)
    fielding = {"lbw": {"overturned": r(c["field_up_lbw"] / fn_l), "umpiresCall": r(c["field_struck_uc"] / fn_l)},
                "caught": {"overturned": r(c["field_up_caught"] / fn_c), "umpiresCall": 0}}
    cbk = cb["keeper"] + cb["notKeeper"]
    out = {
        "reviewsPerInnings": r(c["total"] / n_innings_drs),
        "battingReviewShare": r(c["bat"] / c["total"]),
        "batting": batting, "fielding": fielding,
        "fieldingKindShare": {"lbw": r(fn_l / (fn_l + fn_c)), "caught": r(fn_c / (fn_l + fn_c))},
        "battingKindShare": {"lbw": r(bn_l / (bn_l + bn_c)), "caught": r(bn_c / (bn_l + bn_c))},
        "caughtBehindShare": r(cb["keeper"] / cbk) if cbk else 0,
        "n": int(c["total"]), "nInnings": int(n_innings_drs), "nMatchesWithReviews": int(n_matches_drs),
        "source": "Cricsheet JSON review objects (T20/IT20): decision is from the reviewer's side (batting: upheld = out overturned, "
                  "struck down = out stood; fielding: upheld = not-out overturned to out). Overturned batting reviews and struck-down "
                  "fielding reviews carry no kind, so they are split by the stood / upheld lbw:caught mix (umpire's call is lbw only).",
    }
    rep = {
        "counts": dict(c), "caughtBehind": dict(cb), "matchesScanned": n_matches, "matchesWithReviews": n_matches_drs,
        "shareOfMatchesWithReviewsByLeague": {k: {"matches": league_m[k], "withReviews": league_rm[k], "share": r(league_rm[k] / league_m[k])}
                                              for k in sorted(league_m, key=lambda k: -league_m[k])},
        "reviewsPerInningsRule": "reviews (wicket-type, upheld / struck down, both sides) / regular innings, over matches with >= 1 review recorded; "
                                 "a match where DRS was available but unused counts as a non-DRS match, so this is slightly high",
        "keeperRule": "caught review where the (non-substitute) fielder is the innings' wicketkeeper (fielding_player_innings.keeper_id); "
                      "caught-and-bowled counts as not keeper",
    }
    return out, rep


drs, drs_report = fit_drs()
report["drs"] = {**drs, **drs_report}

# ── 4. commentary ──────────────────────────────────────────────────────
def clean(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s or ""))


def items(b, k):
    return [clean(it.get("html") or it.get("text")) for it in (b.get(k) or [])]


FAN = re.compile(r"^[\w .'-]{1,40}\s?:\s*[\"“”']|^\d{1,2}[:.]\d\d ?[ap]m", re.I)   # fan comments / timestamps before the ball text


def btext(b):
    return " | ".join([x for x in items(b, "commentPreTextItems") if not FAN.search(x)] + items(b, "commentTextItems"))


raw_files = sorted(glob.glob(str(COMM_DIR / "[0-9]*.jsonl.gz")))
balls, seen, match_ids = [], set(), set()
dups = 0
for f in raw_files:
    for line in gzip.open(f, "rt"):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        match_ids.add(d["matchId"])
        for inn, bs in (d.get("commentary") or {}).items():
            for b in bs:
                key = (d["matchId"], inn, b["id"])
                if key in seen:
                    dups += 1
                    continue
                seen.add(key)
                balls.append((d["matchId"], inn, b))
bm = set()
bf = COMM_DIR / "balls.jsonl.gz"
if bf.exists():
    for line in gzip.open(bf, "rt"):
        bm.add(json.loads(line)["m"])
N = len(balls)
report["commentary"] = {"rawFiles": [os.path.basename(f) for f in raw_files], "matches": len(match_ids), "balls": N, "duplicateBallsDropped": dups,
                        "ballsJsonlMatches": len(bm), "ballsJsonlMatchesNotInRaw": len(bm - match_ids),
                        "competitions": "ESPNcricinfo commentary on disk is IPL only (2025 and 2026 seasons); all commentary rates are IPL-only"}
T = [(m, inn, b, btext(b)) for m, inn, b in balls]
rng = random.Random(7)


def sample(rows, k=40):
    rows = list(rows)
    rng.shuffle(rows)
    return [{"match": m, "over": b["oversActual"], "runs": b["totalRuns"], "text": t[:420]} for m, _, b, t in rows[:k]]


def evs(b, typ):
    return [e for e in (b.get("events") or []) if e.get("type") == typ]


# no-ball kinds
FIELDING = re.compile(r"(?:only|just) (?:three|3|two|2) fielders|too many fielders|fielding restriction|not enough fielders|"
                      r"(?:keeper|wicketkeeper) (?:standing|creeping|moved|was) (?:up |in front|ahead)|fielders? (?:was|were|is|are) (?:outside|out of) the (?:circle|ring)", re.I)
HEIGHT = re.compile(r"\bheight\b|\bwaist\b|above the shoulder|shoulder[- ]?height|head[- ]?height|over (?:the |his |her )?(?:batter's |batsman's )?head|"
                    r"\bbeamer\b|high full[- ]?toss|\bbouncers?\b|chest[- ]high|full[- ]?toss[^|]{0,60}(?:above|over)|"
                    r"third bouncer|second bouncer|short ball[^.|]{0,25}(?:over|above)", re.I)
FRONT = re.compile(r"overstep|front[- ]?foot|cut the return crease|return crease|foot (?:on|over|outside|just)|outside the (?:crease|wide line)", re.I)
nb = [(m, inn, b, t) for m, inn, b, t in T if b["noballs"] > 0]
nb_kind = collections.Counter()
nb_cls = []
for m, inn, b, t in nb:
    k = "fielding" if FIELDING.search(t) else "height" if HEIGHT.search(t) else "frontFoot" if FRONT.search(t) else "unclassified"
    nb_kind[k] += 1
    nb_cls.append((m, inn, b, t, k))
n_nb = len(nb)
nbk = {k: nb_kind[k] + (nb_kind["unclassified"] if k == "frontFoot" else 0) for k in ("frontFoot", "height", "fielding")}   # unclassified -> overstep
no_ball_kind = {"frontFoot": r((nbk["frontFoot"] + 0.5) / (n_nb + 1.5), 4), "height": r((nbk["height"] + 0.5) / (n_nb + 1.5), 4),
                "fielding": r((nbk["fielding"] + 0.5) / (n_nb + 1.5), 4), "n": n_nb}
report["noBallKind"] = {"counts": dict(nb_kind), "unclassifiedAssignedTo": "frontFoot", "smoothing": "Jeffreys (k + 0.5) / (n + 1.5)",
                        "regex": {"fielding": FIELDING.pattern, "height": HEIGHT.pattern, "frontFoot": FRONT.pattern},
                        "samples": {k: sample([x[:4] for x in nb_cls if x[4] == k], 20) for k in ("frontFoot", "height", "fielding", "unclassified")}}

# beamers: height no-balls that were full tosses (above-waist) as opposed to bouncers over the head
BEAMER = re.compile(r"\bbeamer\b|full[- ]?toss|waist", re.I)
beamers = [(m, inn, b, t) for m, inn, b, t, k in nb_cls if k == "height" and (b.get("pitchLength") == "FULL_TOSS" or BEAMER.search(t))
           and not re.search(r"\bbouncer\b", t, re.I)]
beamer_rate = jeffreys(len(beamers), N)
report["beamer"] = {"count": len(beamers), "deliveries": N, "rate": r(beamer_rate, 6), "rule": "no-ball with height keywords AND (pitchLength FULL_TOSS or "
                    "'beamer|full toss|waist' in text) AND no 'bouncer'; Jeffreys mean", "samples": sample(beamers, 40)}

# short runs signalled by the umpire
SHORT_SIG = re.compile(r"\b(?:one short|short[- ]run)\b[^.|]{0,25}\b(?:signalled|signaled|called|given|signals?)\b|"
                       r"\b(?:signals?|signalled|signaled|calls?|called|gives?|given)\b[^.|]{0,25}\b(?:one short|short[- ]run)\b|"
                       r"\bonly (?:one|\d) run (?:will )?(?:count|counts)\b|\b(?:run|runs) (?:is|are|has been|have been) (?:cut|taken off|deducted)\b", re.I)
SHORT_CHECK = re.compile(r"\bone short\b|short[- ]?run|check for (?:a )?short|checking for (?:a )?short", re.I)
sr_sig = [x for x in T if SHORT_SIG.search(x[3]) and not re.search(r"check", SHORT_SIG.search(x[3]).group(0), re.I)]
sr_chk = [x for x in T if SHORT_CHECK.search(x[3])]
short_rate = jeffreys(len(sr_sig), N)
report["shortRun"] = {"signalled": len(sr_sig), "checkedNotGiven": len(sr_chk), "deliveries": N, "rate": r(short_rate, 6),
                      "note": "rate is the Jeffreys mean 0.5/(N+1) when none are signalled; Cricsheet does not record short runs",
                      "regexSignalled": SHORT_SIG.pattern, "regexChecked": SHORT_CHECK.pattern,
                      "signalledSamples": sample(sr_sig, 40), "checkedSamples": sample(sr_chk, 40)}

# ball lodged in the batter's helmet / pads / clothing
LODGED = re.compile(r"(?:lodged|stuck|trapped|wedged|nestl\w+|tangled|caught up)[^.|]{0,40}\b(?:helmet|pads?|clothing|shirt|trousers?|jersey|pocket|gear|thigh|between (?:his|the|her) legs)\b", re.I)
lodged = [x for x in T if LODGED.search(x[3]) and not x[2]["isWicket"]]
lodged_rate = jeffreys(len(lodged), N)
report["lodgedDeadBall"] = {"count": len(lodged), "deliveries": N, "rate": r(lodged_rate, 6), "regex": LODGED.pattern, "samples": sample(lodged, 40),
                            "deadBallMentions": len([x for x in T if re.search(r"dead[- ]ball", x[3], re.I)])}

# fielding
caught = [x for x in T if x[2]["isWicket"] and x[2]["dismissalType"] == 1]
runouts = [x for x in T if x[2]["isWicket"] and x[2]["dismissalType"] == 4]
stumpings = [x for x in T if x[2]["isWicket"] and x[2]["dismissalType"] == 5]
drops = [x for x in T if evs(x[2], "DROPPED_CATCH")]
ro_miss = [x for x in T if evs(x[2], "RUN_OUT_CHANCE")]
st_miss = [x for x in T if evs(x[2], "STUMPING_CHANCE")]
n_drop = len(drops) + len(caught)
n_ro = len(ro_miss) + len(runouts)
n_st = len(st_miss) + len(stumpings)

# text cross-check of the structured DROPPED_CATCH events (regex finds drops independently)
DROP_TXT = re.compile(r"\b(?:dropped|drops|spilled|spills|shelled|shells|grassed|grasses|put down|puts down|muffs?|fluffs?|spurned)\b"
                      r"(?! (?:short|into|towards|down|the pace|it (?:short|into|towards|down)|his wrists|a hand))|"
                      r"\bdropped (?:by|a|an|the|another|that|this)\b|\bdropped[,!]?$|can't (?:hold|cling) on|cannot (?:hold|make it stick)|fails? to hold", re.I)
txt_drops = [x for x in T if DROP_TXT.search(x[3]) and not re.search(r"drop(?:s|ped)? (?:short|it short|into|it into|down|the pace|his wrists|a hand)|drop shot|drop and run|drop kick|drop-kick", x[3], re.I)]
both = len([x for x in txt_drops if evs(x[2], "DROPPED_CATCH")])

# misfields that give away runs
MIS = re.compile(r"\b(?:mis-?fields?|mis-?fielded|mis-?fielding|fumbles?|fumbled|fumbling|bobbles?|bobbled|(?:lets?|let) (?:it|the ball) (?:go )?(?:through|slip|past)|"
                 r"through (?:his|the|her) (?:legs|hands|fingers|gloves|feet)|between (?:his|the) (?:legs|feet)|makes? a mess|"
                 r"slips? (?:through|past|under) (?:his|the|her)|sloppy)\b", re.I)
mis = [x for x in T if MIS.search(x[3]) and not x[2]["isWicket"] and x[2]["batsmanRuns"] > 0 and not evs(x[2], "DROPPED_CATCH")
       and not evs(x[2], "RUN_OUT_CHANCE") and not re.search(r"catch|dropped|run[- ]?out|stump|bail", x[3], re.I)]
mis_bd = [x for x in mis if x[2]["isFour"] or x[2]["isSix"]]

# catches taken in the deep / on the rope
POS = re.compile(r"\b(?:deep[- ](?:mid[- ]?wicket|square(?: leg)?|cover(?: point)?|point|backward(?: square| point)?|extra(?: cover)?|fine(?: leg)?|third|mid[- ]?on|mid[- ]?off|midwicket)|"
                 r"long[- ]?on|long[- ]?off|long[- ]?leg|cow corner|third[- ]?man|sweeper|(?:on|at|near|inside|along|towards) the (?:rope|ropes|boundary|fence|cushion|line)|"
                 r"boundary rider|boundary (?:rope|fielder|line)|ropes?|fence|in the deep|of the (?:boundary|rope|ropes|fence))\b", re.I)
ROPE_ONLY = re.compile(r"\b(?:ropes?|fence|cushion|boundary (?:rope|fielder|line)|boundary rider|(?:on|at|near|inside|along) the boundary)\b", re.I)
bcatch = [x for x in caught if POS.search(x[3])]
rope_catch = [x for x in caught if ROPE_ONLY.search(x[3])]
RELAY = re.compile(r"\brelay\b|(?:throws?|tosses|tossed|lobs?|lobbed|flicks?|flicked|passes|passed|palms?|palmed|pats?|patted|chucks?)\s+(?:it|the ball)\s+(?:up\s+|back\s+|in\s+)*to\s+[A-Z]\w+", 0)
RELAY_SELF = re.compile(r"by himself|all by himself|himself|on his own|all by (?:him|her)self", re.I)
relay = [x for x in bcatch if RELAY.search(x[3]) and not RELAY_SELF.search(x[3])]
# saved sixes: a fielder at the rope keeps a six-bound ball in play
SAVED6 = re.compile(r"\b(?:sav(?:es|ed|ing)|stop(?:s|ped)|prevent(?:s|ed)?|deni(?:es|ed)|rescu(?:es|ed))\s+(?:a\s+|the\s+|at least\s+)?(?:certain\s+|sure\s+)?six(?:es)?\b|"
                    r"\b(?:pats?|patted|palms?|palmed|flicks?|flicked|parries|parried|tips?|tipped|pushe?s?|pushed)\s+(?:the ball\s+|it\s+)(?:back\s+)?(?:in|into play)\b", re.I)
SIXCTX = re.compile(r"\b(?:six|rope|ropes|boundary|fence|cushion|beyond|over the (?:rope|boundary|fence))\b", re.I)
saved6 = [x for x in T if SAVED6.search(x[3]) and SIXCTX.search(x[3]) and not x[2]["isWicket"] and x[2]["totalRuns"] < 4 and not x[2]["isSix"]]
sixes = [x for x in T if x[2]["isSix"]]

fld = {
    "catchDropShare": r(len(drops) / n_drop, 4),
    "stumpingMissShare": r(jeffreys(len(st_miss), n_st), 4),
    "runOutMissShare": r(len(ro_miss) / n_ro, 4),
    "misfieldPerDelivery": r(len(mis) / N, 5),
    "misfieldBoundaryShare": r(len(mis_bd) / len(mis), 4),
    "boundaryCatchShare": r(len(bcatch) / len(caught), 4),
    "relayCatchShare": r(jeffreys(len(relay), len(bcatch)), 4),
    "sixSavedShare": r(len(saved6) / (len(saved6) + len(sixes)), 4),
    "n": N,
    "source": f"ESPNcricinfo commentary, IPL 2025-26, {len(match_ids)} matches / {N} balls. Drops, run-out chances and stumping chances use the "
              f"feed's structured events (DROPPED_CATCH, RUN_OUT_CHANCE, STUMPING_CHANCE) against taken catches / run outs / stumpings "
              f"(dismissalType 1 / 4 / 5); the rest are text regexes. Stumping and relay shares are thin (Jeffreys). "
              f"Cross-check: CricViz T20 catch efficiency ~75-80% (drop share 0.20-0.25).",
}
report["fielding"] = {
    **fld,
    "counts": {"droppedCatchEvents": len(drops), "caughtDismissals": len(caught), "runOutChanceEvents": len(ro_miss), "runOutDismissals": len(runouts),
               "stumpingChanceEvents": len(st_miss), "stumpingDismissals": len(stumpings), "misfieldsGivingRuns": len(mis), "misfieldBoundaries": len(mis_bd),
               "boundaryCatches": len(bcatch), "ropeMentionCatches": len(rope_catch), "relayCatches": len(relay), "savedSixes": len(saved6), "sixes": len(sixes)},
    "denominators": {"catchDropShare": n_drop, "stumpingMissShare": n_st, "runOutMissShare": n_ro, "boundaryCatchShare": len(caught), "relayCatchShare": len(bcatch),
                     "sixSavedShare": len(saved6) + len(sixes), "misfieldPerDelivery": N},
    "dropTextCrossCheck": {"textHits": len(txt_drops), "textHitsAlsoEvents": both, "events": len(drops), "regex": DROP_TXT.pattern},
    "regexes": {"misfield": MIS.pattern, "bcatch": POS.pattern, "ropeOnly": ROPE_ONLY.pattern, "relay": RELAY.pattern, "relaySelfExclusion": RELAY_SELF.pattern, "savedSix": SAVED6.pattern,
                "savedSixContext": SIXCTX.pattern},
    "samples": {"droppedCatchEvents": sample(drops, 40), "runOutChanceEvents": sample(ro_miss, 40), "stumpingChanceEvents": sample(st_miss, 40),
                "misfield": sample(mis, 40), "boundaryCatch": sample(bcatch, 40), "notBoundaryCatch": sample([x for x in caught if not POS.search(x[3])], 40),
                "relay": sample(relay, 40), "savedSix": sample(saved6, 60)},
}
report["noBallKindN"] = n_nb
# Manual review of the seeded samples dumped above (reading 40 hits per item, 2026-11-06). Judgements, not computed values.
report["handCheck"] = {
    "note": "precision judged by reading the seeded 'samples' of each item; re-judge if the regexes or the commentary corpus change",
    "droppedCatchEvents": {"n": 40, "clearDrops": 29, "plausibleIncludingDivingMisses": 33, "precisionStrict": 0.725, "precisionLoose": 0.82},
    "misfield": {"n": 40, "correct": 36, "precision": 0.90},
    "boundaryCatch": {"n": 40, "correctOfJudgeable": "31/34", "precision": 0.91, "recallInSampleOfNonHits": "3 of 40 non-hits were deep catches", "recall": 0.9},
    "runOutChanceEvents": {"n": 40, "realMissedChances": 34, "precision": 0.85},
    "beamers": {"n": 17, "correct": 15, "precision": 0.88},
    "savedSix": {"n": 6, "correct": 3, "precision": 0.5, "note": "low recall and mixed precision; treat as an order-of-magnitude figure"},
    "lodgedDeadBall": {"n": 1, "note": "ball lodged between the batter's legs; the text does not say dead ball was called"},
    "shortRun": {"signalled": 0, "note": "four 'check for a short run' mentions, none signalled"},
    "noBallKind": {"unclassifiedOf68": 10, "note": "unclassified assigned to front-foot (the default reason); the 1 fielding hit is a genuine only-three-fielders call",},
}

# ── write TS ───────────────────────────────────────────────────────────
def num(x):
    if isinstance(x, int):
        return str(x)
    s = f"{x:.6f}".rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def obj(d):
    return "{ " + ", ".join(f"{k}: {num(v) if not isinstance(v, str) else json.dumps(v)}" for k, v in d.items()) + " }"


def dr(d):
    return "{ " + ", ".join(f"{k}: {num(v)}" for k, v in d.items()) + " }"


bl_lines = "\n".join(f"      {json.dumps(k) if '-' in k else k}: {obj({kk: vv for kk, vv in v.items()})}," for k, v in by_league.items())
ov_line = "{ " + ", ".join(f'"{k}": {num(v)}' for k, v in overs_per_side.items()) + " }"
ts = f"""/**
 * GENERATED by packages/ratings/src/analysis/match-rules-extra.py. Do not edit.
 * Rates for rain / DLS / no result, DRS, gendered extras, fielding errors and other rare plays.
 * See docs/RULES-MATCH.md section 13. Full report: docs/data/match_rules_extra.json.
 */
export const MATCH_RULES_EXTRA = {{
  /** per-delivery base rates of extras, regular innings (T20 franchise leagues, {EXTRAS_FROM_YEAR}+; T20Is excluded: associate-nation matches double the women's wide rate) */
  extrasRate: {{
    male: {obj(extras['male'])},
    female: {obj(extras['female'])},
  }},
  /** share of no-balls by reason (commentary, IPL 2025-26; Jeffreys-smoothed) */
  noBallKind: {obj(no_ball_kind)},
  /** beamers (above-waist full tosses called no-ball) per delivery */
  beamerPerDelivery: {num(r(beamer_rate, 6))},
  /** short runs: deliveries on which a run is signalled one short, per delivery (Jeffreys; none signalled in the commentary) */
  shortRunPerDelivery: {num(r(short_rate, 6))},
  /** dead ball, ball lodged in the batter's helmet / pads / clothing, per delivery (Jeffreys) */
  lodgedDeadBallPerDelivery: {num(r(lodged_rate, 6))},
  rain: {{
    /** per engine league id: p(no result once started), p(overs reduced, a result); shrunk toward the pooled rate with {SHRINK} pseudo-matches */
    byLeague: {{
{bl_lines}
    }} as Record<string, {{ matches: number; pNoResult: number; pReduced: number }}>,
    default: {obj(rain_default)},
    /** in reduced matches: when the interruption happened (n = {tw} reduced matches with a result) */
    when: {obj({**when, 'n': tw})},
    /** in reduced matches: overs per side after the cut (share by overs) */
    oversPerSide: {ov_line} as Record<string, number>,
  }},
  drs: {{
    /** reviews taken per innings (both sides' reviews during that innings), in matches with reviews recorded */
    reviewsPerInnings: {num(drs['reviewsPerInnings'])},
    /** share of all reviews taken by the batting side (vs the fielding side) */
    battingReviewShare: {num(drs['battingReviewShare'])},
    /** batting side reviews of an out decision */
    batting: {{ lbw: {dr(drs['batting']['lbw'])}, caught: {dr(drs['batting']['caught'])} }},
    /** fielding side reviews of a not-out decision */
    fielding: {{ lbw: {dr(drs['fielding']['lbw'])}, caught: {dr(drs['fielding']['caught'])} }},
    /** share of fielding-side reviews by appeal type */
    fieldingKindShare: {dr(drs['fieldingKindShare'])},
    /** share of batting reviews by dismissal kind */
    battingKindShare: {dr(drs['battingKindShare'])},
    /** share of reviewed catches taken by the wicketkeeper (caught behind) */
    caughtBehindShare: {num(drs['caughtBehindShare'])},
    n: {drs['n']},
  }},
  fielding: {{
    /** share of catching chances put down (all fielders) */
    catchDropShare: {num(fld['catchDropShare'])},
    /** share of stumping chances missed */
    stumpingMissShare: {num(fld['stumpingMissShare'])},
    /** share of run-out chances missed */
    runOutMissShare: {num(fld['runOutMissShare'])},
    /** misfields per delivery that give away a run or more */
    misfieldPerDelivery: {num(fld['misfieldPerDelivery'])},
    /** share of those misfields that go to the boundary */
    misfieldBoundaryShare: {num(fld['misfieldBoundaryShare'])},
    /** share of caught dismissals taken in the deep / on the boundary rope */
    boundaryCatchShare: {num(fld['boundaryCatchShare'])},
    /** share of boundary catches completed as a relay (two fielders) */
    relayCatchShare: {num(fld['relayCatchShare'])},
    /** sixes saved by a fielder on the rope (ball palmed back) per six-bound hit */
    sixSavedShare: {num(fld['sixSavedShare'])},
    n: {fld['n']},
    source: {json.dumps(fld['source'])},
  }},
}} as const;
"""
OUT_TS.write_text(ts)
OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
report["tsFile"] = str(OUT_TS.relative_to(REPO))


def strip_samples(o):
    """The committed report keeps counts and rates only; commentary excerpts (hand-check samples) stay local
    unless REPORT_SAMPLES=1 (the commentary corpus itself is not redistributed)."""
    if isinstance(o, dict):
        return {k: strip_samples(v) for k, v in o.items() if k != "samples"}
    if isinstance(o, list):
        return [strip_samples(v) for v in o]
    return o


OUT_JSON.write_text(json.dumps(report if os.environ.get("REPORT_SAMPLES") == "1" else strip_samples(report), indent=1, ensure_ascii=False))
print(f"wrote {OUT_TS} and {OUT_JSON}")
print(json.dumps({k: report[k] for k in ("extrasRate",)}, indent=1)[:900])
print(ts)
