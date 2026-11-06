"""
Venue, pitch, toss/chase and geography analysis from the CricketArchive scorecards (all senior cricket 2000+) and the
Cricsheet ball-by-ball data.  Analysis only: nothing here feeds the game's player ratings.

Inputs (packages/ratings):
    data/cricket.db                          CricketArchive matches / batting / bowling / players
    data/analysis/match_strength.parquet     pre-match batting / bowling / total strength of both XIs (league-strength-index.py)
    data/analysis/deliveries.parquet, matches.parquet  Cricsheet balls (cricsheet-deliveries.ts); data/cricsheet/people.csv register;
    data/scraped/espn-players.json (bowling / batting styles, first choice) + CricketArchive players (fallback)
    src/analysis/venue_aliases.csv           ground renames / sponsor names -> canonical ground (venue_canon.py)
Outputs (data/analysis/):
    venue_aliases.csv, venue_map.csv          the alias table used and every raw venue string -> ground id
    venue_factors.csv                         per ground x format x scope (all / T20I / ODI / Test) x gender: pitch profile
    venue_factors_by_era.csv                  same, per era (2000-07, 2008-13, 2014-19, 2020-23, 2024-26)
    venue_ball_factors.csv                    Cricsheet: phase profile, six factor, Test day profile per ground
    venue_bowler_types.csv                    bowler-type edge (runs + wickets vs expectation) per ground / country / region,
                                              by phase, and type x batter-hand matchups
    toss_chase.csv                            chase advantage, toss value, captains' choices and whether they were right
    geography_effects.csv                     home advantage, SENA / subcontinent travel, regional conditions
    player_region_splits.parquet              per player x format x region: performance vs their own baseline
    venue-conditions-report.md                method, headline tables, validation
    ../../data-export/venue-conditions.json   compact table the engine could load later (not wired in)

Method (match level, CricketArchive)
  Every senior innings since 2000 (both XIs' strengths from match_strength.parquet) is modelled as
      y = mu[competition x season x innings] + beta * (batting XI strength - bowling XI strength) + R[region] + C[country] + D[ground]
  for y = runs per 100 balls (runs charged to bowlers: bat + wides + no-balls), wickets per 100 balls, sixes per 100 balls.
  R, C, D are fitted by alternating weighted least squares with shrinkage (region -> 0, country -> region, ground -> country),
  priors in innings-equivalents so FC grounds aren't under-shrunk.  Factors are reported as 100 = an average ground.
  Era and scope (T20I / ODI / Test) versions shrink toward the ground's overall value.  Pitch profile adds: 2nd-minus-1st
  innings (and innings 1-4 in FC), variability (spread of innings residuals vs the format's), collapse rate, dismissal mix
  (bowled + lbw share, caught-behind share as a bounce/carry proxy, stumpings), and FC draw / result rates.
Method (ball level, Cricsheet)
  e = y - mean[format x gender x event-season x innings x phase], then e = B[batter] + W[bowler] + C[country] + V[ground]
  (alternating shrunken least squares, runs / bowler wickets / sixes).  Bowler-type edges are the shrunk mean of the remaining
  residual per (ground or country or region) x type, so they read "this type does X better here than these bowlers do
  elsewhere".  Value = runs saved per 100 balls + wicket value x extra wickets per 100 balls (T20 8, List A 15, FC 25 runs).
Toss / chase / home: logistic regressions on the pre-match strength gap (IRLS), groups shrunk toward their parent.

Run from packages/ratings:  python3 -I src/analysis/venue-conditions.py
"""
import csv, json, math, os, re, subprocess, sys, time
from collections import defaultdict, Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from venue_canon import VenueCanon, jaccard  # noqa: E402

ROOT = HERE.parents[1]
DATA = ROOT / "data" / "analysis"
EXPORT = ROOT / "data-export"
TMP = Path(os.environ.get("VENUE_WORK", "/Volumes/Data/tmp/venue"))
TMP.mkdir(parents=True, exist_ok=True)
(TMP / "duck").mkdir(exist_ok=True)
DUCK = f"SET memory_limit='1800MB'; SET threads=2; SET temp_directory='{TMP / 'duck'}'; SET preserve_insertion_order=false;\n"

ERAS = [(2000, 2007, "2000-07"), (2008, 2013, "2008-13"), (2014, 2019, "2014-19"), (2020, 2023, "2020-23"), (2024, 2026, "2024-26")]
FMT_INN_BALLS = {"T20": 115, "ListA": 280, "FC": 480}      # typical balls per innings (prior scaling)
WICKET_VALUE = {"T20": 8.0, "ListA": 15.0, "FC": 25.0}     # runs per extra wicket in the bowler-type value
REGION = {}
for c in ["IND", "PAK", "SL", "BDESH", "AFG", "NEP", "BHU"]: REGION[c] = "Subcontinent"
for c in ["ENG", "AUS", "RSA", "NZ"]: REGION[c] = "SENA"
REGION["WI"] = "West Indies"
for c in ["UAE", "OMAN", "QTR", "BAHRAIN", "KUWAIT", "SAUDI"]: REGION[c] = "Gulf"
for c in ["ZIM", "NAMIB", "KENYA", "UGAN", "NGA", "RWN", "BOT", "TZN", "MLW", "GHA", "SWAZ", "CAMB", "MOZ", "SLE", "LES", "CMR"]: REGION[c] = "Africa (other)"
for c in ["IRELAND", "SCOT", "NL", "FIN", "SPAIN", "MALTA", "CYP", "DNMRK", "GERMANY", "CZK", "GUERN", "JERSEY", "ITALY", "AUSTRIA",
          "BELGIUM", "BULG", "ROM", "GREECE", "FRANCE", "SWE", "PORT", "GIBR", "LUX", "HUN", "SER", "EST", "CRT", "SWITZ", "NOR", "IOM", "SLOV"]:
    REGION[c] = "Europe (other)"
for c in ["USA", "CAN", "ARG", "BMDA", "CAY", "MEXICO", "BRAZIL", "PERU", "CRICA", "COL", "PNM", "BAH", "SUR"]: REGION[c] = "Americas"
for c in ["MAL", "THAI", "INA", "SPORE", "JAPAN", "HKG", "CHI", "SKOREA", "MRC", "PHI", "MYAN"]: REGION[c] = "East Asia"
for c in ["PNG", "VTU", "FIJI", "SAM", "NCAL", "COOK"]: REGION[c] = "Pacific"
SUBCONT, SENA = {"IND", "PAK", "SL", "BDESH"}, {"ENG", "AUS", "RSA", "NZ"}

TEAM_COUNTRY = {  # international team name (men; " Women" stripped) -> CricketArchive country code
    "India": "IND", "Pakistan": "PAK", "Sri Lanka": "SL", "Bangladesh": "BDESH", "Afghanistan": "AFG", "Nepal": "NEP",
    "England": "ENG", "Australia": "AUS", "South Africa": "RSA", "New Zealand": "NZ", "West Indies": "WI", "Zimbabwe": "ZIM",
    "Ireland": "IRELAND", "Scotland": "SCOT", "Netherlands": "NL", "Holland": "NL", "United Arab Emirates": "UAE", "UAE": "UAE",
    "Oman": "OMAN", "Namibia": "NAMIB", "Kenya": "KENYA", "Uganda": "UGAN", "Canada": "CAN", "United States of America": "USA",
    "USA": "USA", "Hong Kong": "HKG", "Papua New Guinea": "PNG", "Malaysia": "MAL", "Thailand": "THAI", "Singapore": "SPORE",
    "Qatar": "QTR", "Nigeria": "NGA", "Rwanda": "RWN", "Botswana": "BOT", "Bermuda": "BMDA", "Jersey": "JERSEY", "Guernsey": "GUERN",
    "Denmark": "DNMRK", "Germany": "GERMANY", "Italy": "ITALY", "Japan": "JAPAN", "Tanzania": "TZN", "Bahrain": "BAHRAIN",
    "Kuwait": "KUWAIT", "Saudi Arabia": "SAUDI", "Vanuatu": "VTU", "Fiji": "FIJI", "Samoa": "SAM", "Cayman Islands": "CAY",
    "Argentina": "ARG", "Mexico": "MEXICO", "Brazil": "BRAZIL", "Indonesia": "INA", "China": "CHI", "Malawi": "MLW",
    "Spain": "SPAIN", "Austria": "AUSTRIA", "Romania": "ROM", "Belgium": "BELGIUM", "France": "FRANCE", "Sweden": "SWE",
    "Finland": "FIN", "Norway": "NOR", "Czech Republic": "CZK", "Portugal": "PORT", "Gibraltar": "GIBR", "Malta": "MALTA",
    "Cyprus": "CYP", "Greece": "GREECE", "Bulgaria": "BULG", "Hungary": "HUN", "Serbia": "SER", "Estonia": "EST",
    "Luxembourg": "LUX", "Switzerland": "SWITZ", "Isle of Man": "IOM", "Ghana": "GHA", "Cameroon": "CAMB", "Mozambique": "MOZ",
    "Sierra Leone": "SLE", "Bhutan": "BHU", "Myanmar": "MYAN", "Philippines": "PHI", "South Korea": "SKOREA", "Peru": "PERU",
    "Costa Rica": "CRICA", "Panama": "PNM", "Belize": "BLZ", "Bahamas": "BAH", "Suriname": "SUR", "Cook Islands": "COOK",
}


def log(*a):
    print(time.strftime("[%H:%M:%S]"), *a, flush=True)


def duck(sql):
    out = subprocess.run(["duckdb"], input=DUCK + sql, capture_output=True, text=True, cwd=ROOT)
    if out.returncode != 0 or "Error" in out.stderr:
        sys.exit(f"duckdb failed:\n{out.stderr[-3000:]}\n--- sql head ---\n{sql[:1500]}")
    return out.stdout


def duck_csv(sql, path):
    duck(f"COPY ({sql}) TO '{path}' (HEADER, DELIMITER ',');")
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def fnum(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def era_of(y):
    for a, b, lab in ERAS:
        if a <= y <= b:
            return lab
    return None


def region_of(c):
    return REGION.get(c, "Other")


def logistic(z):
    if z > 30: return 1.0
    if z < -30: return 0.0
    return 1 / (1 + math.exp(-z))


def irls(X, y, w=None, iters=25, ridge=1e-6):
    """Weighted logistic regression; returns (coef, se)."""
    k = len(X[0]); b = [0.0] * k
    w = w or [1.0] * len(y)
    for _ in range(iters):
        H = [[ridge if i == j else 0.0 for j in range(k)] for i in range(k)]; g = [0.0] * k
        for xi, yi, wi in zip(X, y, w):
            p = logistic(sum(bj * xj for bj, xj in zip(b, xi)))
            v = wi * p * (1 - p)
            for i in range(k):
                g[i] += wi * (yi - p) * xi[i]
                for j in range(k):
                    H[i][j] += v * xi[i] * xi[j]
        Hinv = invert(H)
        step = [sum(Hinv[i][j] * g[j] for j in range(k)) for i in range(k)]
        b = [bi + si for bi, si in zip(b, step)]
        if max(abs(s) for s in step) < 1e-7:
            break
    se = [math.sqrt(max(Hinv[i][i], 0)) for i in range(k)]
    return b, se


def invert(M):
    n = len(M); A = [row[:] + [1.0 if i == j else 0.0 for j in range(n)] for i, row in enumerate(M)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(A[r][c]))
        A[c], A[p] = A[p], A[c]
        pv = A[c][c] or 1e-12
        A[c] = [v / pv for v in A[c]]
        for r in range(n):
            if r != c and A[r][c]:
                f = A[r][c]; A[r] = [a - f * b for a, b in zip(A[r], A[c])]
    return [row[n:] for row in A]


def wmean(vals):
    sw = sum(w for _, w in vals)
    return sum(v * w for v, w in vals) / sw if sw else 0.0


# ─────────────────────────────────────────────────────────────── venues
def build_venue_map(vc):
    log("venue map")
    duck("""LOAD sqlite; ATTACH 'data/cricket.db' AS c (TYPE sqlite, READ_ONLY);
        COPY (SELECT m.venue, m.country, count(*) n FROM c.matches m WHERE m.id IN (SELECT match_id FROM 'data/analysis/match_strength.parquet')
              GROUP BY 1,2) TO '%s' (HEADER);
        COPY (SELECT venue, city, count(*) n FROM 'data/analysis/matches.parquet' GROUP BY 1,2) TO '%s' (HEADER);"""
         % (TMP / "ca_venues_raw.csv", TMP / "cs_venues_raw.csv"))
    ca = list(csv.DictReader(open(TMP / "ca_venues_raw.csv")))
    cs = list(csv.DictReader(open(TMP / "cs_venues_raw.csv")))
    info = {}  # vid -> dict(name, city, countries Counter, alias_country)
    rows = []
    for r in ca:
        vid, disp, city, ac = vc.key(r["venue"])
        d = info.setdefault(vid, {"name": disp, "city": city, "cc": Counter(), "alias_country": ac, "n": 0})
        d["cc"][r["country"]] += int(r["n"]); d["n"] += int(r["n"])
        rows.append(("ca", r["venue"], "", vid))
    bycity = defaultdict(list)
    for vid in info:
        bycity[vid.split("|")[1]].append(vid)
    city_country = defaultdict(Counter)
    for vid, d in info.items():
        city_country[vid.split("|")[1]].update(d["cc"])
    for r in cs:
        vid, disp, city, ac = vc.key(r["venue"], r["city"] or None)
        if vid not in info and vid.startswith("K:"):
            ck = vid.split("|")[1]; toks = vid.split("|")[0][2:].split()
            best = max(((jaccard(toks, k.split("|")[0][2:].split()), k) for k in bycity.get(ck, [])), default=(0, None))
            if best[0] >= 0.6:
                vid = best[1]
        if vid not in info:
            ck = vid.split("|")[1]
            cc = Counter(city_country.get(ck, Counter()))
            info[vid] = {"name": disp, "city": city, "cc": cc, "alias_country": ac, "n": 0}
        rows.append(("cs", r["venue"], r["city"], vid))
    out = {}
    for vid, d in info.items():
        country = d["alias_country"] or (d["cc"].most_common(1)[0][0] if d["cc"] else "UNK")
        out[vid] = {"vid": vid, "venue": d["name"], "city": d["city"], "country": country, "region": region_of(country)}
    names = Counter(o["venue"] for o in out.values())
    for o in out.values():
        if names[o["venue"]] > 1 and o["city"]:
            o["venue"] = f'{o["venue"]}, {o["city"]}'
    with open(DATA / "venue_map.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["source", "raw_venue", "raw_city", "vid", "venue", "city", "country", "region"])
        for src, raw, city, vid in rows:
            o = out[vid]; w.writerow([src, raw, city, vid, o["venue"], o["city"], o["country"], o["region"]])
    unk = sum(1 for o in out.values() if o["country"] == "UNK")
    log(f"  {len(out)} grounds ({unk} with unknown country)")
    return out


# ─────────────────────────────────────────────────────────────── match-level data (CricketArchive)
def load_innings():
    log("innings table (CricketArchive)")
    path = TMP / "innings.csv"
    duck(f"""LOAD sqlite; ATTACH 'data/cricket.db' AS c (TYPE sqlite, READ_ONLY);
CREATE TEMP TABLE ms AS SELECT * FROM 'data/analysis/match_strength.parquet' WHERE NOT in_progress;
CREATE TEMP TABLE m AS SELECT id, venue, date_text, toss, result FROM c.matches WHERE id IN (SELECT match_id FROM ms);
CREATE TEMP TABLE keep AS SELECT match_id, team, any_value(player_name) kname FROM c.batting
    WHERE keeper=1 AND match_id IN (SELECT id FROM m) GROUP BY 1,2;
CREATE TEMP TABLE bat AS
SELECT b.match_id, b.innings, any_value(b.team) team,
    sum(coalesce(b.sixes,0)) sixes, count(b.sixes) FILTER (WHERE b.dismissal IS DISTINCT FROM 'did not bat') n_six_known,
    count(*) FILTER (WHERE b.dismissal IS DISTINCT FROM 'did not bat') n_bat,
    sum(CASE WHEN b.dismissal LIKE 'b %' THEN 1 ELSE 0 END) d_bowled,
    sum(CASE WHEN b.dismissal LIKE 'lbw %' THEN 1 ELSE 0 END) d_lbw,
    sum(CASE WHEN b.dismissal LIKE 'st %' THEN 1 ELSE 0 END) d_stumped,
    sum(CASE WHEN b.dismissal LIKE 'run out%' THEN 1 ELSE 0 END) d_runout,
    sum(CASE WHEN b.dismissal LIKE 'c %' OR b.dismissal LIKE 'c&b%' OR b.dismissal LIKE 'c & b%' THEN 1 ELSE 0 END) d_caught,
    sum(CASE WHEN regexp_matches(b.dismissal, '^c .+ b .+') AND k.kname IS NOT NULL AND
             (k.kname = regexp_extract(b.dismissal, '^c (.+) b .+$', 1) OR k.kname LIKE '% ' || regexp_extract(b.dismissal, '^c (.+) b .+$', 1))
        THEN 1 ELSE 0 END) d_keeper,
    sum(CASE WHEN b.dismissal IS NOT NULL AND b.dismissal NOT IN ('not out','did not bat','absent hurt','retired hurt','absent',
        'retired not out','') THEN 1 ELSE 0 END) wkts_bat
FROM c.batting b LEFT JOIN keep k ON k.match_id=b.match_id AND k.team<>b.team
WHERE b.match_id IN (SELECT id FROM m) GROUP BY 1,2;
CREATE TEMP TABLE bowl AS
SELECT match_id, innings, any_value(team) bowl_team, sum(coalesce(runs,0)) runs, sum(coalesce(wickets,0)) bwk,
    sum(coalesce(balls, CAST(floor(TRY_CAST(overs AS DOUBLE)) AS INT)*6 +
        CAST(round((TRY_CAST(overs AS DOUBLE) - floor(TRY_CAST(overs AS DOUBLE)))*10) AS INT))) balls
FROM c.bowling WHERE match_id IN (SELECT id FROM m) GROUP BY 1,2;
COPY (
SELECT ms.match_id, ms.date, ms.season_year yr, ms.format fmt, ms.gender, ms.competition comp, ms.intl, ms.country ms_country,
    CASE WHEN ms.competition LIKE 'Test (%' THEN 'Test' WHEN ms.competition LIKE 'ODI (%' THEN 'ODI'
         WHEN ms.competition LIKE 'T20I (%' THEN 'T20I' ELSE 'domestic' END scope,
    ms.team1, ms.team2, ms.bat1, ms.bowl1, ms.str1, ms.bat2, ms.bowl2, ms.str2, ms.cls1, ms.cls2,
    m.venue, m.date_text, m.toss, m.result,
    (m.date_text ILIKE '%day/night%' OR m.date_text ILIKE '%floodlit%') dn,
    bo.innings, bt.team bat_team, bo.bowl_team, bo.runs, bo.balls, bo.bwk, bt.wkts_bat, bt.sixes, bt.n_six_known, bt.n_bat,
    bt.d_bowled, bt.d_lbw, bt.d_stumped, bt.d_runout, bt.d_caught, bt.d_keeper
FROM ms JOIN m ON m.id=ms.match_id JOIN bowl bo ON bo.match_id=ms.match_id
     JOIN bat bt ON bt.match_id=bo.match_id AND bt.innings=bo.innings
WHERE bo.balls > 0
) TO '{path}' (HEADER);""")
    rows = list(csv.DictReader(open(path)))
    log(f"  {len(rows)} innings rows")
    return rows


def prep_innings(rows, vmap_ca):
    inns = []
    for r in rows:
        fmt = r["fmt"]; inn = int(r["innings"])
        if fmt in ("T20", "ListA") and inn > 2: continue
        if fmt == "FC" and inn > 4: continue
        balls = int(r["balls"]); runs = int(r["runs"])
        if fmt == "T20" and balls < 30: continue
        if fmt == "ListA" and balls < 60: continue
        if fmt == "FC" and balls < 30: continue
        v = vmap_ca.get(r["venue"])
        if not v: continue
        bat_is_1 = r["bat_team"] == r["team1"]
        bat = fnum(r["bat1"] if bat_is_1 else r["bat2"]); obowl = fnum(r["bowl2"] if bat_is_1 else r["bowl1"])
        if bat is None or obowl is None: continue
        wk = max(int(r["wkts_bat"] or 0), int(r["bwk"] or 0))
        sixk = int(r["n_six_known"] or 0) >= max(1, int(r["n_bat"] or 0) - 1)
        yr = int(r["yr"])
        inns.append({
            "match_id": r["match_id"], "yr": yr, "era": era_of(yr), "fmt": fmt, "gender": r["gender"], "comp": r["comp"],
            "scope": r["scope"], "intl": r["intl"] == "true", "inn": inn, "bat_team": r["bat_team"], "bowl_team": r["bowl_team"],
            "vid": v["vid"], "country": v["country"], "region": v["region"], "balls": balls, "runs": runs, "wk": wk,
            "six": int(r["sixes"] or 0) if sixk else None, "gap": bat - obowl,
            "rp100": 100.0 * runs / balls, "wp100": 100.0 * wk / balls, "s100": (100.0 * int(r["sixes"] or 0) / balls) if sixk else None,
            "d_bowled": int(r["d_bowled"]), "d_lbw": int(r["d_lbw"]), "d_st": int(r["d_stumped"]), "d_ro": int(r["d_runout"]),
            "d_caught": int(r["d_caught"]), "d_keeper": int(r["d_keeper"]), "allout": wk >= 10,
        })
    return inns


# ─────────────────────────────────────────────────────────────── hierarchical venue model
def fit_venue_model(rows, ycol, fmt, iters=8):
    """y = mu[cell] + beta*gap + R[region] + C[country] + D[ground]; weights = balls.  Returns dict with effects."""
    rows = [r for r in rows if r[ycol] is not None]
    if len(rows) < 200:
        return None
    unit = FMT_INN_BALLS[fmt]
    K_cell, K_reg, K_c, K_v = 4 * unit, 150 * unit, 40 * unit, 12 * unit
    cellk = lambda r: (r["comp"], r["yr"], r["inn"] if fmt == "FC" else min(r["inn"], 2))
    inn_mean = defaultdict(lambda: [0.0, 0.0])
    for r in rows:
        a = inn_mean[r["inn"]]; a[0] += r[ycol] * r["balls"]; a[1] += r["balls"]
    inn_mean = {k: v[0] / v[1] for k, v in inn_mean.items()}
    beta = 0.0; mu = {}; R = defaultdict(float); C = defaultdict(float); D = defaultdict(float)
    for _ in range(iters):
        acc = defaultdict(lambda: [0.0, 0.0])
        for r in rows:
            a = acc[cellk(r)]; a[0] += (r[ycol] - beta * r["gap"] - R[r["region"]] - C[r["country"]] - D[r["vid"]]) * r["balls"]; a[1] += r["balls"]
        mu = {k: (v[0] + K_cell * inn_mean[k[2]]) / (v[1] + K_cell) for k, v in acc.items()}
        num = den = 0.0
        for r in rows:
            res = r[ycol] - mu[cellk(r)] - R[r["region"]] - C[r["country"]] - D[r["vid"]]
            num += r["balls"] * r["gap"] * res; den += r["balls"] * r["gap"] ** 2
        beta = num / den if den else 0.0
        for level, store, parent, K in (("region", R, None, K_reg), ("country", C, "region", K_c), ("vid", D, "country", K_v)):
            acc = defaultdict(lambda: [0.0, 0.0])
            for r in rows:
                res = r[ycol] - mu[cellk(r)] - beta * r["gap"]
                if level == "region": res -= C[r["country"]] + D[r["vid"]]
                elif level == "country": res -= R[r["region"]] + D[r["vid"]]
                else: res -= R[r["region"]] + C[r["country"]]
                a = acc[r[level]]; a[0] += res * r["balls"]; a[1] += r["balls"]
            store.clear()
            for k, (s, wsum) in acc.items():
                store[k] = s / (wsum + K)
    for r in rows:
        r["_exp_" + ycol] = mu[cellk(r)] + beta * r["gap"]
        r["_res_" + ycol] = r[ycol] - r["_exp_" + ycol] - R[r["region"]] - C[r["country"]] - D[r["vid"]]
    base = sum(r[ycol] * r["balls"] for r in rows) / sum(r["balls"] for r in rows)
    return {"beta": beta, "mu": mu, "R": dict(R), "C": dict(C), "D": dict(D), "base": base, "K_v": K_v, "cellk": cellk}


# ─────────────────────────────────────────────────────────────── match-level venue factors
def venue_factors(inns, vinfo):
    log("venue factors (match level)")
    out_rows, era_rows, models = [], [], {}
    keyfg = sorted({(r["fmt"], r["gender"]) for r in inns})
    for fmt, g in keyfg:
        rows = [r for r in inns if r["fmt"] == fmt and r["gender"] == g]
        if len(rows) < 500: continue
        M = {y: fit_venue_model(rows, y, fmt) for y in ("rp100", "wp100", "s100")}
        M = {y: m for y, m in M.items() if m is not None}
        models[(fmt, g)] = M
        unit = FMT_INN_BALLS[fmt]
        total = lambda y, r: M[y]["R"].get(r["region"], 0) + M[y]["C"].get(r["country"], 0) + M[y]["D"].get(r["vid"], 0)
        # residual sd per innings for variability (balls-normalised)
        fmt_var = wmean([((r["_res_rp100"]) ** 2, 1) for r in rows])
        fmt_low = sorted(r["_res_rp100"] + total("rp100", r) for r in rows)
        q15 = fmt_low[int(0.15 * len(fmt_low))]
        sd = math.sqrt(fmt_var)
        # dismissal-mix baselines
        tot_w = sum(r["wk"] for r in rows) or 1
        base_share = {k: sum(r[k] for r in rows) / tot_w for k in ("d_bowled", "d_lbw", "d_keeper", "d_st", "d_caught", "d_ro")}
        # FC results per match
        matches = {}
        for r in rows:
            matches.setdefault(r["match_id"], r)
        for scope_name, scope_filter in (("all", lambda r: True),
                                         ("T20I", lambda r: r["scope"] == "T20I"), ("ODI", lambda r: r["scope"] == "ODI"),
                                         ("Test", lambda r: r["scope"] == "Test")):
            if scope_name == "T20I" and fmt != "T20": continue
            if scope_name == "ODI" and fmt != "ListA": continue
            if scope_name == "Test" and fmt != "FC": continue
            srows = [r for r in rows if scope_filter(r)]
            if len(srows) < 200: continue
            for era_name, era_f in [("all", lambda r: True)] + [(e[2], (lambda e: lambda r: r["era"] == e[2])(e)) for e in ERAS]:
                erows = [r for r in srows if era_f(r)]
                if not erows: continue
                pv = defaultdict(list)
                for r in erows:
                    pv[r["vid"]].append(r)
                for vid, vr in pv.items():
                    n_inn = len(vr); balls = sum(r["balls"] for r in vr)
                    if n_inn < 4: continue
                    rec = {"vid": vid, **{k: vinfo[vid][k] for k in ("venue", "city", "country", "region")},
                           "format": fmt, "scope": scope_name, "gender": g, "era": era_name,
                           "matches": len({r["match_id"] for r in vr}), "innings": n_inn, "balls": balls}
                    K = M["rp100"]["K_v"]
                    for y, lab in (("rp100", "run"), ("wp100", "wkt"), ("s100", "six")):
                        yr = [r for r in vr if r.get("_res_" + y) is not None] if y in M else []
                        if not yr: rec[lab + "_eff"] = rec[lab + "_factor"] = rec[lab + "_se"] = None; continue
                        prior = total(y, yr[0])  # overall ground effect (R + C + D)
                        wsum = sum(r["balls"] for r in yr)
                        extra = sum(r["_res_" + y] * r["balls"] for r in yr) / (wsum + K) if (scope_name != "all" or era_name != "all") else 0.0
                        eff = prior + extra
                        var = wmean([(r["_res_" + y] ** 2, r["balls"]) for r in yr])
                        se = math.sqrt(var * unit / (wsum + K))
                        rec[lab + "_eff"] = round(eff, 3); rec[lab + "_se"] = round(se, 3)
                        rec[lab + "_factor"] = round(100 * (M[y]["base"] + eff) / M[y]["base"], 1) if M[y]["base"] else None
                    if rec.get("run_factor") and rec.get("wkt_factor"):
                        rec["runs_per_wkt_factor"] = round(100 * rec["run_factor"] / rec["wkt_factor"], 1)
                    # innings profile
                    if fmt == "FC":
                        for k in (1, 2, 3, 4):
                            ir = [r for r in vr if r["inn"] == k]
                            w_ = sum(r["balls"] for r in ir)
                            rec[f"inn{k}_run_eff"] = round(rec["run_eff"] + sum(r["_res_rp100"] * r["balls"] for r in ir) / (w_ + K), 2) if ir else None
                            rpw = sum(r["runs"] for r in ir) / max(1, sum(r["wk"] for r in ir)) if ir else None
                            rec[f"inn{k}_rpw"] = round(rpw, 1) if rpw else None
                        i12 = [r for r in vr if r["inn"] in (1, 2)]; i34 = [r for r in vr if r["inn"] in (3, 4)]
                        a = sum(r["_res_rp100"] * r["balls"] for r in i12) / (sum(r["balls"] for r in i12) + K)
                        b = sum(r["_res_rp100"] * r["balls"] for r in i34) / (sum(r["balls"] for r in i34) + K)
                        rec["late_minus_early_run"] = round(b - a, 2)
                        aw = sum(r["_res_wp100"] * r["balls"] for r in i12) / (sum(r["balls"] for r in i12) + K)
                        bw = sum(r["_res_wp100"] * r["balls"] for r in i34) / (sum(r["balls"] for r in i34) + K)
                        rec["late_minus_early_wkt"] = round(bw - aw, 3)
                    else:
                        i1 = [r for r in vr if r["inn"] == 1]; i2 = [r for r in vr if r["inn"] == 2]
                        a = sum(r["_res_rp100"] * r["balls"] for r in i1) / (sum(r["balls"] for r in i1) + K)
                        b = sum(r["_res_rp100"] * r["balls"] for r in i2) / (sum(r["balls"] for r in i2) + K)
                        rec["inn2_minus_inn1_run"] = round(b - a, 2)
                    # variability, collapse
                    vv = [r["_res_rp100"] for r in vr]
                    ratio = (sum(x * x for x in vv) / len(vv)) / fmt_var if fmt_var else 1
                    k_var = 15
                    rec["variability"] = round((len(vv) * ratio + k_var) / (len(vv) + k_var), 2)
                    full = [r["_res_rp100"] + total("rp100", r) for r in vr]
                    low = sum(1 for x in full if x <= q15)
                    rec["low_score_rate"] = round((low + 20 * 0.15) / (len(full) + 20), 3)
                    coll = sum(1 for x in vv if x <= -1.5 * sd)
                    base_coll = 0.067
                    rec["collapse_rate"] = round((coll + 20 * base_coll) / (len(vv) + 20), 3)
                    # dismissal mix
                    wk = sum(r["wk"] for r in vr)
                    for k, lab in (("d_bowled", "bowled"), ("d_lbw", "lbw"), ("d_keeper", "caught_behind"), ("d_st", "stumped"),
                                   ("d_caught", "caught")):
                        sh = (sum(r[k] for r in vr) + 60 * base_share[k]) / (wk + 60)
                        rec[f"{lab}_share_pp"] = round(100 * (sh - base_share[k]), 2)
                    rec["bowled_lbw_share_pp"] = round(rec["bowled_share_pp"] + rec["lbw_share_pp"], 2)
                    # FC results
                    if fmt == "FC":
                        ms_ = {r["match_id"]: r for r in vr}
                        res = [results.get(mid) for mid in ms_]
                        res = [x for x in res if x]
                        if res:
                            dr = sum(1 for x in res if x == "draw")
                            base_dr = FC_DRAW_BASE.get((g, scope_name, era_name), 0.35)
                            rec["draw_rate"] = round((dr + 15 * base_dr) / (len(res) + 15), 3)
                            rec["result_rate"] = round(1 - rec["draw_rate"], 3)
                            rec["draw_rate_raw"] = round(dr / len(res), 3)
                    (out_rows if era_name == "all" else era_rows).append(rec)
    return out_rows, era_rows, models


results = {}
FC_DRAW_BASE = {}
VNAME = {}


def parse_results(inns, rows_raw):
    """match_id -> 'draw' | 'tie' | 'nr' | winner team name."""
    for r in rows_raw:
        mid = r["match_id"]
        if mid in results: continue
        t = (r["result"] or "").strip()
        tl = t.lower()
        if "drawn" in tl: results[mid] = "draw"
        elif "tied" in tl and "won" not in tl: results[mid] = "tie"
        elif "no result" in tl or "abandon" in tl or "cancelled" in tl or not t: results[mid] = "nr"
        else:
            m = re.match(r"^(.*?) won\b", t)
            results[mid] = m.group(1).strip() if m else "nr"
    by = defaultdict(lambda: [0, 0])
    seen = set()
    for r in inns:
        if r["fmt"] != "FC" or r["match_id"] in seen: continue
        seen.add(r["match_id"]); x = results.get(r["match_id"])
        if not x or x in ("nr", "tie"): continue
        for scope in ("all", r["scope"]):
            for era in ("all", r["era"]):
                a = by[(r["gender"], scope, era)]; a[0] += x == "draw"; a[1] += 1
    for k, (d, n) in by.items():
        FC_DRAW_BASE[k] = d / n if n else 0.35


# ─────────────────────────────────────────────────────────────── match records: toss / chase / home
def match_records(rows_raw, inns, vinfo_ca):
    log("match records (toss / chase / home)")
    first = {}
    for r in rows_raw:
        if r["innings"] == "1":
            first[r["match_id"]] = r["bat_team"]
    recs = {}
    for r in rows_raw:
        mid = r["match_id"]
        if mid in recs: continue
        v = vinfo_ca.get(r["venue"])
        if not v or mid not in first: continue
        s1, s2 = fnum(r["str1"]), fnum(r["str2"])
        if s1 is None or s2 is None: continue
        toss = r["toss"] or ""
        m = re.match(r"^(.*?) won the toss and (?:decided|elected|chose) to (bat|field|bowl)", toss)
        tw, td = (m.group(1).strip(), "bat" if m.group(2) == "bat" else "field") if m else (None, None)
        yr = int(r["yr"])
        recs[mid] = {"match_id": mid, "fmt": r["fmt"], "gender": r["gender"], "comp": r["comp"], "scope": r["scope"],
                     "yr": yr, "era": era_of(yr), "intl": r["intl"] == "true", "team1": r["team1"], "team2": r["team2"],
                     "s1": s1, "s2": s2, "bat_first": first[mid], "toss_winner": tw, "toss_dec": td,
                     "dn": r["dn"] == "true", "vid": v["vid"], "country": v["country"], "region": v["region"],
                     "result": results.get(mid), "cls1": r["cls1"], "cls2": r["cls2"]}
    # home teams: internationals = team's country; others = team's home grounds in that competition-season
    venue_counts = defaultdict(Counter)
    for x in recs.values():
        if not x["intl"]:
            for t in (x["team1"], x["team2"]):
                venue_counts[(x["comp"], x["yr"], t)][x["vid"]] += 1
    for x in recs.values():
        for side, t in (("h1", x["team1"]), ("h2", x["team2"])):
            if x["intl"]:
                code = TEAM_COUNTRY.get(re.sub(r" Women$", "", t).strip())
                x[side] = 1 if code and code == x["country"] else 0
            else:
                vc = venue_counts[(x["comp"], x["yr"], t)]; tot = sum(vc.values())
                homes = {v for v, n in vc.items() if n >= 2 and n / tot >= 0.3}
                x[side] = 1 if x["vid"] in homes else 0
        if x["h1"] and x["h2"]:
            x["h1"] = x["h2"] = 0
    log(f"  {len(recs)} matches")
    return list(recs.values())


def group_logit(recs, yfun, xfun, groupf, min_n=40, label=""):
    """Fit logit y ~ xfun per group; returns rows."""
    groups = defaultdict(list)
    for x in recs:
        y = yfun(x)
        if y is None: continue
        for gk in groupf(x):
            groups[gk].append((xfun(x), y))
    out = []
    for gk, data in groups.items():
        if len(data) < min_n: continue
        X = [d[0] for d in data]; y = [d[1] for d in data]
        try:
            b, se = irls(X, y)
        except Exception:
            continue
        out.append((gk, b, se, len(data), sum(y) / len(y)))
    return out


def toss_chase(recs):
    log("toss / chase")
    rows = []
    def add(analysis, gk, est, se, n, extra=None):
        fmt, scope, g, group_type, group = gk
        rows.append({"analysis": analysis, "format": fmt, "scope": scope, "gender": g, "group_type": group_type, "group": group,
                     "estimate": round(est, 4), "se": round(se, 4) if se is not None else None, "n": n, **(extra or {})})
    lo = [x for x in recs if x["fmt"] in ("T20", "ListA") and x["result"] not in (None, "nr", "tie", "draw")]
    def bf_won(x):
        return 1 if x["result"] == x["bat_first"] else (0 if x["result"] in (x["team1"], x["team2"]) else None)
    def chase_x(x):
        bf1 = x["bat_first"] == x["team1"]
        gap = (x["s1"] - x["s2"]) if bf1 else (x["s2"] - x["s1"])
        hd = (x["h1"] - x["h2"]) if bf1 else (x["h2"] - x["h1"])
        return [1.0, gap / 10.0, hd]
    def scopes(x):
        return ["all"] + ([x["scope"]] if x["scope"] != "domestic" else ["domestic"])
    groupers = {
        "overall": lambda x: [(x["fmt"], s, x["gender"], "overall", "all") for s in scopes(x)],
        "era": lambda x: [(x["fmt"], s, x["gender"], "era", x["era"]) for s in scopes(x)],
        "year": lambda x: [(x["fmt"], "all", x["gender"], "year", str(x["yr"]))],
        "competition": lambda x: [(x["fmt"], "all", x["gender"], "competition", x["comp"])],
        "comp_era": lambda x: [(x["fmt"], "all", x["gender"], "competition_era", f"{x['comp']} | {x['era']}")],
        "day_night": lambda x: [(x["fmt"], s, x["gender"], "day_night", "day/night" if x["dn"] else "day") for s in scopes(x)],
    }
    chase_by = {}
    for name, gf in groupers.items():
        for gk, b, se, n, mean in group_logit(lo, bf_won, chase_x, gf, min_n=60 if name != "overall" else 40):
            adv = 0.5 - logistic(b[0])   # P(chaser wins | equal, neutral) - 0.5
            add("chase_advantage", gk, adv, se[0] * 0.25, n, {"bat_first_win_raw": round(mean, 3), "home_logit": round(b[2], 3)})
            chase_by[gk] = b
    # venue chase advantage, shrunk toward the format/gender overall
    vgroups = defaultdict(list)
    for x in lo:
        y = bf_won(x)
        if y is None: continue
        vgroups[(x["fmt"], x["gender"], x["vid"])].append(x)
    for (fmt, g, vid), xs in vgroups.items():
        if len(xs) < 20: continue
        bo = chase_by.get((fmt, "all", g, "overall", "all"), [0.0, 0.0, 0.0])
        # one-step random-intercept estimate on the logit scale: sum(y - p) / (sum p(1-p) + k), p from the overall fit
        num = den = 0.0
        for x in xs:
            p = logistic(sum(bi * xi for bi, xi in zip(bo, chase_x(x))))
            num += bf_won(x) - p; den += p * (1 - p)
        shift = num / (den + 10)
        add("chase_advantage", (fmt, "all", g, "venue", vid), 0.5 - logistic(bo[0] + shift), 0.25 / math.sqrt(den + 10), len(xs),
            {"venue": VNAME.get(vid, vid)})
    # toss value
    def tw_won(x):
        if not x["toss_winner"] or x["result"] in (None, "nr", "tie", "draw"): return None
        return 1 if x["result"] == x["toss_winner"] else (0 if x["result"] in (x["team1"], x["team2"]) else None)
    def toss_x(x):
        t1 = x["toss_winner"] == x["team1"]
        gap = (x["s1"] - x["s2"]) if t1 else (x["s2"] - x["s1"])
        hd = (x["h1"] - x["h2"]) if t1 else (x["h2"] - x["h1"])
        return [1.0, gap / 10.0, hd]
    allm = [x for x in recs if x["toss_winner"]]
    for name in ("overall", "era", "competition", "day_night"):
        for gk, b, se, n, mean in group_logit([x for x in allm if x["fmt"] in ("T20", "ListA")], tw_won, toss_x, groupers[name]):
            add("toss_value_win", gk, logistic(b[0]) - 0.5, se[0] * 0.25, n)
    # choice shares
    cs = defaultdict(lambda: [0, 0])
    for x in allm:
        if x["fmt"] == "FC": continue   # first-class choices are reported below
        for gk in groupers["year"](x) + groupers["overall"](x) + groupers["era"](x):
            a = cs[gk]; a[0] += x["toss_dec"] == "field"; a[1] += 1
    for gk, (f, n) in cs.items():
        if n >= 30: add("toss_choice_field_share", gk, f / n, math.sqrt(f / n * (1 - f / n) / n), n)
    # were choices right?  venue/competition chase effect from PRIOR seasons only
    lo_sorted = sorted(lo, key=lambda x: x["yr"])
    prior = defaultdict(lambda: [0.0, 0.0])
    aligned_rows = []
    by_year = defaultdict(list)
    for x in lo_sorted: by_year[x["yr"]].append(x)
    for yr in sorted(by_year):
        for x in by_year[yr]:
            if not x["toss_dec"]: continue
            a0 = chase_by.get((x["fmt"], "all", x["gender"], "overall", "all"), [0.0])[0]
            pv = prior[(x["fmt"], x["gender"], x["vid"])]; pc = prior[(x["fmt"], x["gender"], x["comp"])]
            shift = (pv[0] + 0.5 * pc[0]) / (pv[1] + 0.5 * pc[1] + 10)
            chase_better = (0.5 - logistic(a0 + shift)) > 0
            x["_aligned"] = (x["toss_dec"] == "field") == chase_better
            aligned_rows.append(x)
        for x in by_year[yr]:
            y = bf_won(x)
            if y is None: continue
            bo = chase_by.get((x["fmt"], "all", x["gender"], "overall", "all"), [0.0, 0.0, 0.0])
            p = logistic(sum(bi * xi for bi, xi in zip(bo, chase_x(x))))
            for k in ((x["fmt"], x["gender"], x["vid"]), (x["fmt"], x["gender"], x["comp"])):
                a = prior[k]; a[0] += y - p; a[1] += p * (1 - p)
    for gk, b, se, n, mean in group_logit(aligned_rows, tw_won, lambda x: toss_x(x) + [1.0 if x["_aligned"] else 0.0],
                                          lambda x: [(x["fmt"], "all", x["gender"], "overall", "all"), (x["fmt"], "all", x["gender"], "era", x["era"])]):
        add("toss_choice_aligned_effect", gk, logistic(b[0] + b[3]) - logistic(b[0]), se[3] * 0.25, n,
            {"aligned_share": round(sum(1 for x in aligned_rows if x["fmt"] == gk[0] and x["gender"] == gk[2] and
                                        (gk[3] == "overall" or x["era"] == gk[4]) and x["_aligned"]) /
                                    max(1, sum(1 for x in aligned_rows if x["fmt"] == gk[0] and x["gender"] == gk[2] and
                                               (gk[3] == "overall" or x["era"] == gk[4]))), 3)})
    # first-class / Tests: bat first vs bowl first after the toss, draws
    fc = [x for x in recs if x["fmt"] == "FC" and x["result"] not in (None, "nr", "tie") and x["toss_winner"]]
    for scope in ("all", "Test"):
        for g in ("male", "female"):
            for era in ["all"] + [e[2] for e in ERAS]:
                xs = [x for x in fc if x["gender"] == g and (scope == "all" or x["scope"] == scope) and (era == "all" or x["era"] == era)]
                if len(xs) < 40: continue
                d = sum(1 for x in xs if x["result"] == "draw")
                add("fc_draw_rate", ("FC", scope, g, "era", era), d / len(xs), math.sqrt(d / len(xs) * (1 - d / len(xs)) / len(xs)), len(xs))
                f = sum(1 for x in xs if x["toss_dec"] == "field")
                add("toss_choice_field_share", ("FC", scope, g, "era", era), f / len(xs), None, len(xs))
                for dec in ("bat", "field"):
                    ys = [x for x in xs if x["toss_dec"] == dec]
                    if len(ys) < 25: continue
                    X = [toss_x(x)[:2] for x in ys]
                    yw = [1 if x["result"] == x["toss_winner"] else 0 for x in ys]
                    yd = [1 if x["result"] == "draw" else 0 for x in ys]
                    bw, sw = irls(X, yw); bd, sd_ = irls(X, yd)
                    add(f"fc_toss_{dec}_first", ("FC", scope, g, "era", era), logistic(bw[0]), sw[0] * 0.25, len(ys),
                        {"draw_prob": round(logistic(bd[0]), 3),
                         "loss_prob": round(1 - logistic(bw[0]) - logistic(bd[0]), 3)})
                # bat first (not toss) win prob among decided
                dec_ = [x for x in xs if x["result"] != "draw"]
                if len(dec_) >= 40:
                    yb = [1 if x["result"] == x["bat_first"] else 0 for x in dec_]
                    Xb = [[1.0, ((x["s1"] - x["s2"]) if x["bat_first"] == x["team1"] else (x["s2"] - x["s1"])) / 10,
                           (x["h1"] - x["h2"]) if x["bat_first"] == x["team1"] else (x["h2"] - x["h1"])] for x in dec_]
                    b, se = irls(Xb, yb)
                    add("fc_bat_first_win_given_result", ("FC", scope, g, "era", era), logistic(b[0]), se[0] * 0.25, len(dec_))
    return rows


def geography(recs, inns, models, vinfo):
    log("geography")
    rows = []
    def add(analysis, fmt, scope, g, gt, grp, est, se, n, extra=None):
        rows.append({"analysis": analysis, "format": fmt, "scope": scope, "gender": g, "group_type": gt, "group": grp,
                     "estimate": round(est, 4), "se": round(se, 4) if se is not None else None, "n": n, **(extra or {})})
    def won1(x):
        if x["result"] in (None, "nr", "tie", "draw"): return None
        return 1 if x["result"] == x["team1"] else (0 if x["result"] == x["team2"] else None)
    for fmt in ("T20", "ListA", "FC"):
        for g in ("male", "female"):
            base = [x for x in recs if x["fmt"] == fmt and x["gender"] == g and won1(x) is not None and (x["h1"] or x["h2"])]
            for scope_name, sf in (("all", lambda x: True), ("international", lambda x: x["intl"]), ("domestic", lambda x: not x["intl"]),
                                   ("T20I" if fmt == "T20" else "ODI" if fmt == "ListA" else "Test", lambda x: x["scope"] in ("T20I", "ODI", "Test"))):
                for era in ["all"] + [e[2] for e in ERAS]:
                    xs = [x for x in base if sf(x) and (era == "all" or x["era"] == era)]
                    if len(xs) < 60: continue
                    # team order is arbitrary (hosts are usually listed first), so no intercept
                    X = [[(x["s1"] - x["s2"]) / 10, x["h1"] - x["h2"]] for x in xs]; y = [won1(x) for x in xs]
                    b, se = irls(X, y)
                    add("home_advantage", fmt, scope_name, g, "era", era, logistic(b[1]) - 0.5, se[1] * 0.25, len(xs),
                        {"home_logit": round(b[1], 3)})
            # by host country (internationals)
            intl = [x for x in base if x["intl"]]
            for c in sorted({x["country"] for x in intl}):
                xs = [x for x in intl if x["country"] == c]
                if len(xs) < 40: continue
                X = [[(x["s1"] - x["s2"]) / 10, x["h1"] - x["h2"]] for x in xs]; y = [won1(x) for x in xs]
                b, se = irls(X, y)
                add("home_advantage", fmt, "international", g, "host_country", c, logistic(b[1]) - 0.5, se[1] * 0.25, len(xs))
            # SENA vs subcontinent (full-member internationals)
            fm = [x for x in recs if x["fmt"] == fmt and x["gender"] == g and x["intl"] and x["cls1"] == "FM" and x["cls2"] == "FM"
                  and won1(x) is not None]
            def team_reg(t):
                code = TEAM_COUNTRY.get(re.sub(r" Women$", "", t).strip())
                return "SUB" if code in SUBCONT else "SENA" if code in SENA else "OTHER"
            for era in ["all", "2000-13", "2014-26"]:
                xs = [x for x in fm if era == "all" or (era == "2000-13" and x["yr"] <= 2013) or (era == "2014-26" and x["yr"] >= 2014)]
                X, y = [], []
                for x in xs:
                    vr = "SUB" if x["country"] in SUBCONT else "SENA" if x["country"] in SENA else "OTHER"
                    r1, r2 = team_reg(x["team1"]), team_reg(x["team2"])
                    sub_in_sena = (1 if (r1 == "SUB" and vr == "SENA") else 0) - (1 if (r2 == "SUB" and vr == "SENA") else 0)
                    sena_in_sub = (1 if (r1 == "SENA" and vr == "SUB") else 0) - (1 if (r2 == "SENA" and vr == "SUB") else 0)
                    X.append([(x["s1"] - x["s2"]) / 10, x["h1"] - x["h2"], sub_in_sena, sena_in_sub]); y.append(won1(x))
                if len(y) < 80: continue
                b, se = irls(X, y)
                add("travel_sub_team_in_SENA", fmt, "FM internationals", g, "era", era, logistic(b[2]) - 0.5, se[2] * 0.25, len(y),
                    {"logit": round(b[2], 3), "note": "win prob shift vs equal-strength, after home advantage"})
                add("travel_SENA_team_in_sub", fmt, "FM internationals", g, "era", era, logistic(b[3]) - 0.5, se[3] * 0.25, len(y),
                    {"logit": round(b[3], 3)})
                add("home_advantage_FM", fmt, "FM internationals", g, "era", era, logistic(b[1]) - 0.5, se[1] * 0.25, len(y))
            # regional conditions from the match-level model
            M = models.get((fmt, g))
            if M:
                for y, lab in (("rp100", "run_rate_eff_per100"), ("wp100", "wkt_rate_eff_per100"), ("s100", "six_rate_eff_per100")):
                    if y not in M: continue
                    for reg, v in M[y]["R"].items():
                        add("region_conditions_" + lab, fmt, "all", g, "region", reg, v, None, None)
                    for c, v in M[y]["C"].items():
                        add("country_conditions_" + lab, fmt, "all", g, "country", c,
                            v + M[y]["R"].get(region_of(c), 0), None, None)
    return rows


# ─────────────────────────────────────────────────────────────── player region splits
def player_splits(models, vinfo_ca):
    log("player region splits")
    path = TMP / "player_inns.csv"
    duck(f"""LOAD sqlite; ATTACH 'data/cricket.db' AS c (TYPE sqlite, READ_ONLY);
CREATE TEMP TABLE ms AS SELECT match_id FROM 'data/analysis/match_strength.parquet' WHERE NOT in_progress;
COPY (
  SELECT 'bat' side, b.match_id, b.innings, b.player_id, coalesce(p.name, b.player_name) player_name, b.runs, b.balls, NULL wk
  FROM c.batting b LEFT JOIN c.players p ON p.id = b.player_id
  WHERE b.match_id IN (SELECT match_id FROM ms) AND b.balls > 0
  UNION ALL
  SELECT 'bowl', w.match_id, w.innings, w.player_id, coalesce(p.name, w.player_name), w.runs,
     coalesce(w.balls, CAST(floor(TRY_CAST(w.overs AS DOUBLE)) AS INT)*6 + CAST(round((TRY_CAST(w.overs AS DOUBLE)-floor(TRY_CAST(w.overs AS DOUBLE)))*10) AS INT)),
     w.wickets FROM c.bowling w LEFT JOIN c.players p ON p.id = w.player_id WHERE w.match_id IN (SELECT match_id FROM ms)
) TO '{path}' (HEADER);""")
    return path


def player_region_table(path, inns, models, vinfo):
    exp = {}
    for r in inns:
        M = models.get((r["fmt"], r["gender"]))
        if not M: continue
        tot_r = M["rp100"]["R"].get(r["region"], 0) + M["rp100"]["C"].get(r["country"], 0) + M["rp100"]["D"].get(r["vid"], 0)
        tot_w = M["wp100"]["R"].get(r["region"], 0) + M["wp100"]["C"].get(r["country"], 0) + M["wp100"]["D"].get(r["vid"], 0)
        exp[(r["match_id"], str(r["inn"]))] = (r["fmt"], r["gender"], r["region"], r["intl"],
                                               r.get("_exp_rp100", 0) + tot_r, r.get("_exp_wp100", 0) + tot_w)
    acc = defaultdict(lambda: [0.0, 0.0, 0.0, 0])     # (pid, fmt, g, side, region) -> res_runs, balls, res_w, inns
    dom = defaultdict(Counter); names = {}
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            e = exp.get((r["match_id"], r["innings"]))
            if not e: continue
            fmt, g, reg, intl, er, ew = e
            balls = fnum(r["balls"]) or 0
            if balls <= 0: continue
            runs = fnum(r["runs"]) or 0
            res = runs - balls * er / 100.0
            resw = ((fnum(r["wk"]) or 0) - balls * ew / 100.0) if r["side"] == "bowl" else 0.0
            k = (r["player_id"], fmt, g, r["side"], reg)
            a = acc[k]; a[0] += res; a[1] += balls; a[2] += resw; a[3] += 1
            if not intl: dom[(r["player_id"], fmt, g)][reg] += balls
            names[r["player_id"]] = r["player_name"]
    out = []
    by_player = defaultdict(dict)
    for (pid, fmt, g, side, reg), v in acc.items():
        by_player[(pid, fmt, g, side)][reg] = v
    K = {"T20": 800, "ListA": 1500, "FC": 3000}   # balls of shrinkage: region splits are noisy
    for (pid, fmt, g, side), regs in by_player.items():
        home = dom[(pid, fmt, g)].most_common(1)[0][0] if dom[(pid, fmt, g)] else max(regs, key=lambda k: regs[k][1])
        if home not in regs: continue
        h = regs[home]; kk = K[fmt]
        h_eff = 100 * h[0] / (h[1] + kk); h_w = 100 * h[2] / (h[1] + kk)
        for reg, v in regs.items():
            eff = 100 * v[0] / (v[1] + kk); wf = 100 * v[2] / (v[1] + kk)
            out.append({"player_id": int(pid), "name": names.get(pid), "format": fmt, "gender": g, "side": side, "home_region": home,
                        "region": reg, "balls": int(v[1]), "innings": v[3], "runs_res_per100": round(eff, 2),
                        "wkts_res_per100": round(wf, 3) if side == "bowl" else None,
                        "diff_vs_home_runs_per100": round(eff - h_eff, 2) if reg != home else 0.0,
                        "diff_vs_home_wkts_per100": round(wf - h_w, 3) if (side == "bowl" and reg != home) else None,
                        "home_balls": int(h[1])})
    return out


# ─────────────────────────────────────────────────────────────── ball level (Cricsheet)
BL_NAMES = ["venue_main", "ev", "venue_phase", "country_phase", "venue_type", "venue_type_scope", "country_type", "region_type",
            "venue_type_phase", "country_type_phase", "venue_type_hand", "country_type_hand", "type_hand", "fc_day", "venue_day", "venue_era"]


def write_espn_styles():
    src = ROOT / "data" / "scraped" / "espn-players.json"
    with open(TMP / "espn_styles.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["espn_id", "bowl", "bat"])
        if src.exists():
            for x in json.load(open(src)):
                p = x.get("profile") or {}
                bs = p.get("bowlingStyles") or []; bt = p.get("battingStyles") or []
                w.writerow([p.get("espnId"), bs[0] if bs else "", bt[0] if bt else ""])


def ball_level(vinfo_cs_map):
    if os.environ.get("REUSE_BALL") and all((TMP / f"bl_{n}.csv").exists() for n in BL_NAMES):
        log("ball level: reusing previous outputs (REUSE_BALL)")
        return {n: list(csv.DictReader(open(TMP / f"bl_{n}.csv"))) for n in BL_NAMES}
    log("ball level (Cricsheet): building table")
    write_espn_styles()
    mp = TMP / "cs_venue_map.csv"
    with open(mp, "w", newline="") as f:
        w = csv.writer(f); w.writerow(["venue", "city", "vid", "country", "region"])
        for (v, c), o in vinfo_cs_map.items():
            w.writerow([v, c, o["vid"], o["country"], o["region"]])
    db = TMP / "balls.duckdb"
    if db.exists(): db.unlink()
    K_SQL = """CREATE TABLE kp AS SELECT * FROM (VALUES ('T20',1.0),('ListA',2.0),('FC',4.0)) t(fmt, mult);"""
    duck(f"""ATTACH '{db}' AS w; USE w;
LOAD sqlite; ATTACH '{ROOT / 'data/cricket.db'}' AS c (TYPE sqlite, READ_ONLY);
{K_SQL}
CREATE TABLE vmap AS SELECT * FROM read_csv('{mp}', header=true, all_varchar=true);
CREATE MACRO btype_of(st) AS (
  CASE
    WHEN st IS NULL OR st = '' THEN NULL
    WHEN st LIKE 'right-arm fast-medium%' OR st LIKE 'right-arm medium-fast%' THEN 'RA fast-medium'
    WHEN st LIKE 'right-arm fast%' THEN 'RA fast'
    WHEN st LIKE 'right-arm medium%' OR st LIKE 'right-arm slow-medium%' THEN 'RA medium'
    WHEN st LIKE 'left-arm fast%' OR st LIKE 'left-arm medium%' THEN 'LA pace'
    WHEN st LIKE 'slow left-arm orthodox%' OR st LIKE 'left-arm orthodox%' THEN 'LA orthodox'
    WHEN st LIKE 'legbreak%' OR st LIKE 'slow left-arm wrist%' OR st LIKE 'left-arm wrist%' OR st LIKE '%googly%' THEN 'wrist-spin'
    WHEN st LIKE 'right-arm offbreak%' OR st LIKE 'offbreak%' OR st LIKE 'right-arm slow%' THEN 'off-spin'
    ELSE NULL END);
CREATE MACRO norm_style(x) AS replace(replace(lower(split_part(coalesce(x,''), ',', 1)), 'off-break', 'offbreak'), 'leg-break', 'legbreak');
CREATE TABLE espn AS SELECT * FROM read_csv('{TMP / 'espn_styles.csv'}', header=true, all_varchar=true);
CREATE TABLE pc AS SELECT identifier cricsheet_id, TRY_CAST(key_cricinfo AS BIGINT) ci, TRY_CAST(key_cricketarchive AS BIGINT) ca
  FROM read_csv('{ROOT / 'data/cricsheet/people.csv'}', header=true, all_varchar=true);
CREATE TABLE cem AS SELECT TRY_CAST(espn_id AS BIGINT) espn_id, any_value(TRY_CAST(ca_id AS BIGINT)) ca_id
  FROM read_csv('{DATA / 'ca_espn_map.csv'}', header=true, all_varchar=true) GROUP BY 1;
CREATE TABLE ptype AS
SELECT pc.cricsheet_id,
  coalesce(btype_of(norm_style(e.bowl)), btype_of(norm_style(pl.bowling_style)), 'unknown') btype,
  coalesce(CASE WHEN e.bat ILIKE 'left%' THEN 'Left' WHEN e.bat ILIKE 'right%' THEN 'Right' END, pl.batting_hand) batting_hand
FROM pc
LEFT JOIN espn e ON TRY_CAST(e.espn_id AS BIGINT) = pc.ci
LEFT JOIN cem ON cem.espn_id = pc.ci
LEFT JOIN c.players pl ON pl.id = coalesce(pc.ca, cem.ca_id);
CREATE TABLE m AS
SELECT mm.match_id, mm.date, year(mm.date) yr, mm.gender, coalesce(mm.event, mm.team1||' v '||mm.team2) || ' ' || mm.season cell_es,
  CASE WHEN mm.match_type IN ('T20','IT20') THEN 'T20' WHEN mm.match_type IN ('ODI','ODM') THEN 'ListA' ELSE 'FC' END fmt,
  CASE WHEN mm.match_type='Test' THEN 'Test' WHEN mm.match_type='ODI' THEN 'ODI' WHEN mm.match_type='T20' AND mm.team_type='international' THEN 'T20I'
       ELSE 'domestic' END scope,
  v.vid, v.country, v.region
FROM '{DATA / 'matches.parquet'}' mm JOIN vmap v ON v.venue = mm.venue AND coalesce(v.city,'') = coalesce(mm.city,'');
CREATE TABLE b0 AS
SELECT d.match_id, m.fmt, m.scope, m.gender, m.yr, m.cell_es, m.vid, m.country, m.region, d.innings inn, d.over ov,
  d.batter_id, d.bowler_id,
  (d.runs_batter + d.wides + d.noballs)::DOUBLE r,
  CASE WHEN d.is_wicket=1 AND d.wicket_kind IN ('bowled','caught','lbw','stumped','caught and bowled','hit wicket') THEN 1.0 ELSE 0.0 END w,
  CASE WHEN d.runs_batter=6 AND coalesce(d.non_boundary,0)=0 THEN 1.0 ELSE 0.0 END s,
  CASE WHEN d.wides=0 AND d.noballs=0 THEN 1 ELSE 0 END legal,
  row_number() OVER (PARTITION BY d.match_id ORDER BY d.innings, d.over, d.ball) seq
FROM '{DATA / 'deliveries.parquet'}' d JOIN m ON m.match_id = d.match_id
WHERE coalesce(d.super_over,0)=0 AND m.yr >= 2005;
CREATE TABLE b AS
SELECT b0.*, coalesce(pt.btype,'unknown') btype,
  CASE WHEN ph.batting_hand ILIKE 'left%' THEN 'LHB' WHEN ph.batting_hand ILIKE 'right%' THEN 'RHB' ELSE 'unk' END hand,
  CASE WHEN fmt='T20' THEN CASE WHEN ov<6 THEN 'powerplay (1-6)' WHEN ov<15 THEN 'middle (7-15)' ELSE 'death (16-20)' END
       WHEN fmt='ListA' THEN CASE WHEN ov<10 THEN 'overs 1-10' WHEN ov<40 THEN 'overs 11-40' ELSE 'overs 41-50' END
       ELSE CASE WHEN ov<20 THEN 'new ball (1-20)' WHEN ov<80 THEN 'middle (21-80)' ELSE 'old/2nd new ball (81+)' END END phase,
  CASE WHEN fmt='FC' THEN least(5, 1 + CAST(floor((sum(legal) OVER (PARTITION BY match_id ORDER BY seq) - 1) / 540.0) AS INT)) END test_day,
  CASE WHEN fmt='FC' THEN inn ELSE least(inn, 2) END innb
FROM b0 LEFT JOIN ptype pt ON pt.cricsheet_id = b0.bowler_id LEFT JOIN ptype ph ON ph.cricsheet_id = b0.batter_id;
DROP TABLE b0;
SELECT fmt, gender, count(*) FROM b GROUP BY ALL;""")
    log("ball level: expectation + ALS")
    iters = 6
    sql = [f"ATTACH '{db}' AS w; USE w;",
           """CREATE OR REPLACE TABLE cm AS SELECT fmt, gender, cell_es, innb, phase, avg(r) mr, avg(w) mw, avg(s) ms FROM b GROUP BY ALL;
CREATE OR REPLACE TABLE e AS SELECT b.*, b.r - cm.mr er, b.w - cm.mw ew, b.s - cm.ms es, cm.mr, cm.mw, cm.ms
  FROM b JOIN cm USING (fmt, gender, cell_es, innb, phase);
CREATE OR REPLACE TABLE eb AS SELECT fmt, gender, batter_id, 0.0 br, 0.0 bw, 0.0 bs FROM e GROUP BY ALL;
CREATE OR REPLACE TABLE ew AS SELECT fmt, gender, bowler_id, 0.0 wr, 0.0 ww, 0.0 ws FROM e GROUP BY ALL;
CREATE OR REPLACE TABLE ec AS SELECT fmt, gender, country, 0.0 cr, 0.0 cw, 0.0 cs FROM e GROUP BY ALL;
CREATE OR REPLACE TABLE ev AS SELECT fmt, gender, vid, 0.0 vr, 0.0 vw, 0.0 vs FROM e GROUP BY ALL;"""]
    J = """FROM e JOIN eb USING (fmt, gender, batter_id) JOIN ew USING (fmt, gender, bowler_id) JOIN ec USING (fmt, gender, country)
           JOIN ev USING (fmt, gender, vid) JOIN kp USING (fmt)"""
    for _ in range(iters):
        sql.append(f"""
CREATE OR REPLACE TABLE eb2 AS SELECT fmt, gender, batter_id,
  sum(er - wr - cr - vr)/(count(*) + 250*any_value(mult)) br, sum(ew - ww - cw - vw)/(count(*) + 800*any_value(mult)) bw,
  sum(es - ws - cs - vs)/(count(*) + 400*any_value(mult)) bs {J} GROUP BY ALL;
CREATE OR REPLACE TABLE eb AS SELECT * FROM eb2;
CREATE OR REPLACE TABLE ew2 AS SELECT fmt, gender, bowler_id,
  sum(er - br - cr - vr)/(count(*) + 250*any_value(mult)) wr, sum(ew - bw - cw - vw)/(count(*) + 800*any_value(mult)) ww,
  sum(es - bs - cs - vs)/(count(*) + 400*any_value(mult)) ws {J} GROUP BY ALL;
CREATE OR REPLACE TABLE ew AS SELECT * FROM ew2;
CREATE OR REPLACE TABLE ec2 AS SELECT fmt, gender, country,
  sum(er - br - wr - vr)/(count(*) + 6000*any_value(mult)) cr, sum(ew - bw - ww - vw)/(count(*) + 12000*any_value(mult)) cw,
  sum(es - bs - ws - vs)/(count(*) + 8000*any_value(mult)) cs {J} GROUP BY ALL;
CREATE OR REPLACE TABLE ec AS SELECT * FROM ec2;
CREATE OR REPLACE TABLE ev2 AS SELECT fmt, gender, vid,
  sum(er - br - wr - cr)/(count(*) + 1500*any_value(mult)) vr, sum(ew - bw - ww - cw)/(count(*) + 4000*any_value(mult)) vw,
  sum(es - bs - ws - cs)/(count(*) + 2500*any_value(mult)) vs {J} GROUP BY ALL;
CREATE OR REPLACE TABLE ev AS SELECT * FROM ev2;""")
    sql.append(f"""
CREATE OR REPLACE TABLE u AS SELECT e.fmt, e.gender, e.scope, e.yr, e.vid, e.country, e.region, e.btype, e.hand, e.phase, e.test_day, e.innb,
  e.er - br - wr - cr - vr ur, e.ew - bw - ww - cw - vw uw, e.es - bs - ws - cs - vs us, mult, mr, mw, ms {J};
DROP TABLE e;""")
    duck("\n".join(sql))
    log("ball level: interactions")
    outp = {}
    def q(name, keys, kr, kw, ks=None, where="TRUE"):
        p = TMP / f"bl_{name}.csv"
        ks_ = ks or kr
        duck(f"""ATTACH '{db}' AS w; USE w;
COPY (SELECT {keys}, count(*) n, avg(mr) base_r, avg(mw) base_w, avg(ms) base_s,
   sum(ur)/(count(*) + {kr}*any_value(mult)) eff_r, sum(uw)/(count(*) + {kw}*any_value(mult)) eff_w,
   sum(us)/(count(*) + {ks_}*any_value(mult)) eff_s,
   sqrt(avg(ur*ur))/sqrt(count(*) + {kr}*any_value(mult)) se_r, sqrt(avg(uw*uw))/sqrt(count(*) + {kw}*any_value(mult)) se_w
 FROM u WHERE {where} GROUP BY ALL) TO '{p}' (HEADER);""")
        outp[name] = list(csv.DictReader(open(p)))
    q("venue_main", "fmt, gender, vid", 0, 0)   # main effects are in ev; this gives n / base
    duck(f"ATTACH '{db}' AS w; USE w; COPY (SELECT ev.*, ec.cr, ec.cw, ec.cs FROM ev LEFT JOIN (SELECT DISTINCT fmt, gender, vid, country FROM u) x USING (fmt, gender, vid) LEFT JOIN ec USING (fmt, gender, country)) TO '{TMP / 'bl_ev.csv'}' (HEADER);")
    outp["ev"] = list(csv.DictReader(open(TMP / "bl_ev.csv")))
    q("venue_phase", "fmt, gender, vid, phase", 1500, 4000)
    q("country_phase", "fmt, gender, country, phase", 4000, 10000)
    q("venue_type", "fmt, gender, vid, btype", 1500, 4000, where="btype<>'unknown'")
    q("venue_type_scope", "fmt, gender, scope, vid, btype", 2500, 6000, where="btype<>'unknown' AND scope IN ('Test','ODI','T20I')")
    q("country_type", "fmt, gender, country, btype", 4000, 10000, where="btype<>'unknown'")
    q("region_type", "fmt, gender, region, btype", 8000, 20000, where="btype<>'unknown'")
    q("venue_type_phase", "fmt, gender, vid, btype, phase", 3000, 8000, where="btype<>'unknown'")
    q("country_type_phase", "fmt, gender, country, btype, phase", 6000, 15000, where="btype<>'unknown'")
    q("venue_type_hand", "fmt, gender, vid, btype, hand", 4000, 10000, where="btype<>'unknown' AND hand<>'unk'")
    q("country_type_hand", "fmt, gender, country, btype, hand", 8000, 20000, where="btype<>'unknown' AND hand<>'unk'")
    q("type_hand", "fmt, gender, btype, hand", 8000, 20000, where="btype<>'unknown' AND hand<>'unk'")
    q("fc_day", "fmt, gender, scope, test_day", 4000, 10000, where="fmt='FC'")
    q("venue_day", "fmt, gender, vid, test_day", 3000, 8000, where="fmt='FC'")
    q("venue_era", "fmt, gender, vid, CASE WHEN yr<=2013 THEN '2005-13' WHEN yr<=2019 THEN '2014-19' WHEN yr<=2023 THEN '2020-23' ELSE '2024-26' END era",
      2500, 6000)
    return outp


def bowler_type_rows(bl, vinfo, vid_name):
    rows = []
    def emit(level, recs, keyname):
        for r in recs:
            fmt = r["fmt"]; wv = WICKET_VALUE[fmt]
            er, ew = float(r["eff_r"]), float(r["eff_w"])
            row = {"level": level, "format": fmt, "gender": r["gender"], "scope": r.get("scope", "all"),
                   "key": r[keyname], "name": vid_name.get(r[keyname], r[keyname]) if keyname == "vid" else r[keyname],
                   "country": vinfo.get(r[keyname], {}).get("country") if keyname == "vid" else None,
                   "bowler_type": r["btype"], "phase": r.get("phase", "all"), "batter_hand": r.get("hand", "all"),
                   "balls": int(r["n"]), "econ_eff_per_over": round(6 * er, 3), "runs_eff_per100": round(100 * er, 2),
                   "wkts_eff_per100": round(100 * ew, 3), "runs_se_per100": round(100 * float(r["se_r"]), 2),
                   "wkts_se_per100": round(100 * float(r["se_w"]), 3),
                   "value_per100": round(-100 * er + wv * 100 * ew, 2),
                   "value_se": round(math.sqrt((100 * float(r["se_r"])) ** 2 + (wv * 100 * float(r["se_w"])) ** 2), 2)}
            rows.append(row)
    emit("venue", bl["venue_type"], "vid")
    emit("venue_scope", bl["venue_type_scope"], "vid")
    emit("country", bl["country_type"], "country")
    emit("region", bl["region_type"], "region")
    emit("venue_phase", bl["venue_type_phase"], "vid")
    emit("country_phase", bl["country_type_phase"], "country")
    emit("venue_hand", bl["venue_type_hand"], "vid")
    emit("country_hand", bl["country_type_hand"], "country")
    for r in bl["type_hand"]:
        r["key"] = "all"
    emit("overall_hand", bl["type_hand"], "key")
    return rows


def venue_ball_rows(bl, vinfo):
    out = []
    idx = {}
    for name in ("venue_phase", "venue_day", "venue_era"):
        d = defaultdict(list)
        for p in bl[name]: d[(p["fmt"], p["gender"], p["vid"])].append(p)
        idx[name] = d
    ev = {(r["fmt"], r["gender"], r["vid"]): r for r in bl["ev"]}
    nmain = {(r["fmt"], r["gender"], r["vid"]): r for r in bl["venue_main"]}
    for k, r in nmain.items():
        e = ev.get(k)
        if not e: continue
        fmt, g, vid = k
        base_r, base_w, base_s = float(r["base_r"]), float(r["base_w"]), float(r["base_s"])
        vr = float(e["vr"]) + float(e["cr"] or 0); vw = float(e["vw"]) + float(e["cw"] or 0); vs = float(e["vs"]) + float(e["cs"] or 0)
        rec = {"vid": vid, **{x: vinfo.get(vid, {}).get(x) for x in ("venue", "city", "country", "region")}, "format": fmt, "gender": g,
               "balls": int(r["n"]), "run_factor": round(100 * (base_r + vr) / base_r, 1) if base_r else None,
               "wkt_factor": round(100 * (base_w + vw) / base_w, 1) if base_w else None,
               "six_factor": round(100 * (base_s + vs) / base_s, 1) if base_s else None,
               "runs_eff_per100": round(100 * vr, 2), "wkts_eff_per100": round(100 * vw, 3), "sixes_eff_per100": round(100 * vs, 3)}
        for p in idx["venue_phase"][k]:
            if True:
                rec[f"phase {p['phase']} runs_eff_per100"] = round(100 * (vr + float(p["eff_r"])), 2)
                rec[f"phase {p['phase']} wkts_eff_per100"] = round(100 * (vw + float(p["eff_w"])), 3)
        if fmt == "FC":
            for d in idx["venue_day"][k]:
                if d["test_day"]:
                    rec[f"day {d['test_day']} runs_eff_per100"] = round(100 * (vr + float(d["eff_r"])), 2)
                    rec[f"day {d['test_day']} wkts_eff_per100"] = round(100 * (vw + float(d["eff_w"])), 3)
        for d in idx["venue_era"][k]:
            if True:
                rec[f"era {d['era']} run_factor"] = round(100 * (base_r + vr + float(d["eff_r"])) / base_r, 1)
        out.append(rec)
    return out


# ─────────────────────────────────────────────────────────────── validation
def validate(inns, vinfo):
    log("validation: holdout 2025-26")
    rows = []
    for fmt in ("T20", "ListA", "FC"):
        for g in ("male", "female"):
            allr = [r for r in inns if r["fmt"] == fmt and r["gender"] == g]
            train = [dict(r) for r in allr if r["yr"] <= 2024]
            test = [r for r in allr if r["yr"] >= 2025]
            if len(train) < 1000 or len(test) < 200: continue
            for y in ("rp100", "wp100"):
                M = fit_venue_model(train, y, fmt)
                # competition level for 2025+: mean of that competition's 2023-24 cells (fallback: innings mean)
                cm = defaultdict(lambda: [0.0, 0.0]); im = defaultdict(lambda: [0.0, 0.0])
                for r in train:
                    if r["yr"] >= 2023:
                        k = (r["comp"], r["inn"] if fmt == "FC" else min(r["inn"], 2))
                        a = cm[k]; a[0] += r[y] * r["balls"]; a[1] += r["balls"]
                    a = im[r["inn"] if fmt == "FC" else min(r["inn"], 2)]; a[0] += r[y] * r["balls"]; a[1] += r["balls"]
                def base(r):
                    k = (r["comp"], r["inn"] if fmt == "FC" else min(r["inn"], 2))
                    ib = im[k[1]][0] / im[k[1]][1]
                    if k in cm: s, w_ = cm[k]; return (s + 4 * FMT_INN_BALLS[fmt] * ib) / (w_ + 4 * FMT_INN_BALLS[fmt])
                    return ib
                se0 = se1 = sw = 0.0; covered = 0
                for r in test:
                    p0 = base(r) + M["beta"] * r["gap"]
                    v = M["R"].get(r["region"], 0) + M["C"].get(r["country"], 0) + M["D"].get(r["vid"], 0)
                    covered += r["vid"] in M["D"]
                    p1 = p0 + v
                    se0 += r["balls"] * (r[y] - p0) ** 2; se1 += r["balls"] * (r[y] - p1) ** 2; sw += r["balls"]
                rows.append({"format": fmt, "gender": g, "metric": y, "test_innings": len(test),
                             "rmse_no_venue": round(math.sqrt(se0 / sw), 3), "rmse_with_venue": round(math.sqrt(se1 / sw), 3),
                             "mse_reduction_pct": round(100 * (1 - se1 / se0), 2), "grounds_seen_in_training_pct": round(100 * covered / len(test), 1)})
    return rows


# ─────────────────────────────────────────────────────────────── output helpers
def write_csv(path, rows):
    keys = []
    for r in rows:
        for k in r:
            if k not in keys: keys.append(k)
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); w.writerows(rows)


def write_parquet(rows, path):
    tmp = TMP / (Path(path).stem + ".csv")
    write_csv(tmp, rows)
    duck(f"COPY (SELECT * FROM read_csv('{tmp}', header=true, auto_detect=true)) TO '{path}' (FORMAT parquet);")


def main():
    t0 = time.time()
    alias_src = HERE / "venue_aliases.csv"
    vc = VenueCanon(alias_src)
    (DATA / "venue_aliases.csv").write_text(alias_src.read_text())
    vinfo = build_venue_map(vc)
    VNAME.update({v: o["venue"] for v, o in vinfo.items()})
    vm_rows = list(csv.DictReader(open(DATA / "venue_map.csv")))
    vinfo_ca = {r["raw_venue"]: vinfo[r["vid"]] for r in vm_rows if r["source"] == "ca"}
    vinfo_cs = {(r["raw_venue"], r["raw_city"]): vinfo[r["vid"]] for r in vm_rows if r["source"] == "cs"}
    raw = load_innings()
    inns = prep_innings(raw, vinfo_ca)
    parse_results(inns, raw)
    vf, vfe, models = venue_factors(inns, vinfo)
    write_csv(DATA / "venue_factors.csv", vf); write_csv(DATA / "venue_factors_by_era.csv", vfe)
    log(f"  venue_factors: {len(vf)} rows, by era: {len(vfe)}")
    recs = match_records(raw, inns, vinfo_ca)
    tc = toss_chase(recs)
    write_csv(DATA / "toss_chase.csv", tc)
    geo = geography(recs, inns, models, vinfo)
    write_csv(DATA / "geography_effects.csv", geo)
    pth = player_splits(models, vinfo_ca)
    ps = player_region_table(pth, inns, models, vinfo)
    write_parquet(ps, DATA / "player_region_splits.parquet")   # also leaves TMP/player_region_splits.csv for the report
    log(f"  player splits: {len(ps)} rows")
    val = validate(inns, vinfo)
    write_csv(DATA / "venue_validation.csv", val)
    if os.environ.get("SKIP_BALL"):
        log("SKIP_BALL set: stopping before the ball-level stage"); return
    bl = ball_level(vinfo_cs)
    vid_name = {v: o["venue"] for v, o in vinfo.items()}
    bt = bowler_type_rows(bl, vinfo, vid_name)
    write_csv(DATA / "venue_bowler_types.csv", bt)
    vb = venue_ball_rows(bl, vinfo)
    write_csv(DATA / "venue_ball_factors.csv", vb)
    fcday = bl["fc_day"]
    json.dump({"fc_day": fcday, "type_hand": bl["type_hand"]}, open(TMP / "misc.json", "w"))
    log(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
