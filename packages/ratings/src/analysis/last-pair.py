"""
The last wicket, measured and fitted from Cricsheet ball by ball (docs/TACTICS.md section 5, "The last pair").

With nine down a real last pair does not bat as the ball model's rating terms say a tail-ender and his partner would. The senior
partner farms the strike (he refuses singles early in the over, takes one on the last ball to keep the end, and the weaker man
refuses the single on the last ball so the over's end hands the strike to the senior one) and attacks when he has it, the junior
one blocks or slogs and falls more often. The engine's #11 faced half of the last pair's balls where the real one faces about 40%.
It is a STATE (nine wickets down), not a position: who is "the senior one" is the partner's rating against the striker's, so a star
at number 11 bats and farms as himself.

    log p'(class k) = log p(class k) + theta[role][ball of the over][k]       only with nine down, only the ODI / T20 (not The Hundred) / Test

role: how the striker's batting rating ((battingOvr + timing) / 200, the game's own ratings; in a T20I the opposition adjust) compares with
the non-striker's, a weight w = clamp(0.5 + (striker - partner) / (2 H), 0, 1) on "strong" (1 - w on "weak"); ball of the over: the
legal balls already bowled in it, 0-2 | 3-4 | 5.

Real: every delivery with nine down (wickets before the ball, wides and no-balls included) of the men's T20 leagues since 2016 and T20Is
between full members since 2019 (the competitions the engine has levels for), the women's, the ODIs and the men's Tests between full members
since 2016, counted by (competition x stratum x role weight x ball of the over x outcome class); the stratum is the striker's rating bin
and, in the limited-overs formats, the phase of the innings. Sim: the same cells from the engine (packages/app/src/__tests__/last-pair-collect.test.ts,
LP_COLLECT / LP_LEAGUES: the matches the real XIs played, real batting orders, and the leagues' own squads), competitions re-weighted to the real
balls with nine down. The fit is a multinomial regression of the real counts on the sim's shares in each cell with a log-multiplier per class
shared across the cells of a (role, ball of the over): theta = u[role][k] + v[role][bucket][k], ridge-shrunk, the extras (wide, no-ball, bye)
the reference. Fitted on balls to the end of 2023; the 2024+ balls score it.

Run from packages/ratings (needs the `duckdb` CLI, numpy and scipy):
    python3 -I src/analysis/last-pair.py build  work.duckdb           (real table: slow, once)
    python3 -I src/analysis/last-pair.py fit    work.duckdb simdir [--write] [--lam-u 3 --lam-v 30] [--iter table.json]
    python3 -I src/analysis/last-pair.py report work.duckdb simdir     (real against sim, by role and ball of the over)
"""
import json
import subprocess
import sys
import tempfile
import importlib.util
from pathlib import Path

import numpy as np
from scipy.optimize import minimize

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
REPO = ROOT.parent.parent
CLASSES = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"]
ACTS = ["dot", "1", "2", "3", "4", "6", "wicket"]
FITTED = ["dot", "1", "2", "4", "6", "wicket"]  # a 3 takes the 2's term
BIOS = 3          # ball of the over: 0-2, 3-4, 5
RBIN_EDGES = [0.30, 0.40, 0.50, 0.60]
FORMATS = ["t20", "odi", "test"]
TABLES = ["t20", "t20i", "odi", "test"]
GROUPS = [("t20", "male"), ("t20", "female"), ("odi", "male"), ("odi", "female"), ("test", "male")]
# a table is fitted per (format, gender) and, in the T20, a T20I table that is the league one plus a shrunk offset (the T20I context plays a different level at nine down)
SLOTS = [("t20", "male", "league"), ("t20", "male", "t20i"), ("t20", "female", "t20i"), ("odi", "male", "all"), ("odi", "female", "all"), ("test", "male", "all")]   # the women have the T20I table only (374 rated balls to 2023): fitted on the women's leagues too, the term moved their pair runs (WBBL, WPL) away from real
FIT_END = "2023-12-31"
OUT_JSON = REPO / "docs" / "data" / "last_pair.json"
OUT_TS = ROOT.parent / "engine" / "src" / "last-pair-data.ts"
FULL_MEMBERS = ["Afghanistan", "Australia", "Bangladesh", "England", "India", "Ireland", "New Zealand", "Pakistan",
                "South Africa", "Sri Lanka", "West Indies", "Zimbabwe"]


def _load_br():
    spec = importlib.util.spec_from_file_location("br", ROOT / "src" / "analysis" / "t20-batter-response.py")
    br = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(br)
    return br


def duck(db: Path, sql: str, json_out: bool = False):
    args = ["duckdb", str(db)] + (["-json"] if json_out else []) + ["-c", "SET memory_limit='6GB'; SET threads=6; " + sql]
    p = subprocess.run(args, capture_output=True, text=True, cwd=DATA)
    if p.returncode != 0:
        raise SystemExit(f"duckdb failed: {p.stderr}\n{sql[:800]}")
    return json.loads(p.stdout) if json_out and p.stdout.strip() else []


def ratings_csv(tmp: Path) -> Path:
    br = _load_br()
    rows = json.loads((DATA / "game_players.json").read_text())
    file = json.loads((REPO / "packages" / "app" / "public" / "data" / "format-ratings.json").read_text())
    adj = file.get("adjust", {})
    fr = file["players"]

    def r4(s):
        iq, ti, po, ru = s[:4]
        return (round(iq * .3 + ti * .3 + po * .35 + ru * .05) + ti) / 200

    path = tmp / "gp.csv"
    with open(path, "w") as f:
        f.write("cricinfo,g,bat,bat_adj,bat_odi,bat_test\n")
        for p in rows:
            if not p["id"].startswith("espn_") or not p["id"][5:].isdigit():
                continue
            a = (adj.get(p["id"]) or [0])[0]
            sets = fr.get(p["id"]) or [None, None]
            o = r4(sets[0]) if sets and sets[0] else ""
            t = r4(sets[1]) if len(sets) > 1 and sets[1] else ""
            f.write(f"{p['id'][5:]},{p['g']},{br.rating(p['r'])},{br.rating(p['r'], a)},{o},{t}\n")
    return path


def build(db: Path):
    """The real table: every delivery with nine down (wk) of the sets above, with the striker's and the non-striker's rating"""
    br = _load_br()
    if db.exists():
        db.unlink()
    tmp = Path(tempfile.mkdtemp())
    gp = ratings_csv(tmp)
    members = ", ".join(f"'{t}'" for t in FULL_MEMBERS)
    sel = []
    for gid, (events, gender, hundred) in br.LEAGUES.items():
        if hundred:
            continue
        ev = ", ".join("'" + e.replace("'", "''") + "'" for e in events)
        sel.append(f"SELECT match_id,'t20' AS fmt,'{gid}' AS comp,'{gender}' AS gender FROM 'matches.parquet' WHERE event IN ({ev}) AND gender='{gender}' AND date>=DATE '2016-01-01'")
    for g, gender in (("t20i-men", "male"), ("t20i-women", "female")):
        sel.append(f"SELECT match_id,'t20','{g}','{gender}' FROM 'matches.parquet' WHERE gender='{gender}' AND team_type='international' AND match_type IN ('T20','IT20') AND team1 IN ({members}) AND team2 IN ({members}) AND date>=DATE '2019-01-01'")
    sel.append(f"SELECT match_id,'odi','odi',gender FROM 'matches.parquet' WHERE match_type IN ('ODI','ODM') AND team_type='international' AND team1 IN ({members}) AND team2 IN ({members}) AND date>=DATE '2016-01-01'")
    sel.append(f"SELECT match_id,'test','test',gender FROM 'matches.parquet' WHERE match_type='Test' AND team_type='international' AND gender='male' AND team1 IN ({members}) AND team2 IN ({members}) AND date>=DATE '2016-01-01'")
    cls = ("CASE WHEN d.wides>0 THEN 'wide' WHEN d.noballs>0 THEN 'noball' WHEN d.is_wicket>0 THEN 'wicket' WHEN d.byes+d.legbyes>0 AND d.runs_batter=0 THEN 'legbye' "
           "WHEN d.runs_batter>=6 THEN '6' WHEN d.runs_batter>=4 THEN '4' WHEN d.runs_batter=0 THEN 'dot' ELSE d.runs_batter::VARCHAR END")
    duck(db, f"""
CREATE TABLE sel AS {" UNION ALL ".join(sel)};
CREATE TABLE gp AS SELECT * FROM read_csv('{gp}');
CREATE TABLE pid AS SELECT DISTINCT cricsheet_id, cricinfo_id FROM 'people.parquet';
CREATE TABLE d0 AS
SELECT s.fmt,s.comp,s.gender,m.date,CASE WHEN m.date<=DATE '{FIT_END}' THEN 'fit' ELSE 'test' END AS half,
 d.match_id,d.innings,d.over,d.ball,d.batter_id,d.non_striker_id,d.runs_batter,d.wides,d.noballs,d.is_wicket,{cls} AS cls
FROM 'deliveries.parquet' d JOIN sel s USING(match_id) JOIN 'matches.parquet' m USING(match_id)
WHERE d.super_over=0 AND m.outcome_method IS NULL;
CREATE TABLE d1 AS
SELECT *,
 COALESCE(SUM(is_wicket) OVER (PARTITION BY match_id,innings ORDER BY over,ball ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS wk,
 COALESCE(SUM(CASE WHEN wides=0 AND noballs=0 THEN 1 ELSE 0 END) OVER (PARTITION BY match_id,innings,over ORDER BY ball ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS legal_before_in_over
FROM d0;
CREATE TABLE ds AS
SELECT d.*,
 CASE d.fmt WHEN 't20' THEN CASE WHEN d.comp LIKE 't20i%' THEN g1.bat_adj ELSE g1.bat END WHEN 'odi' THEN COALESCE(g1.bat_odi,g1.bat) ELSE COALESCE(g1.bat_test,g1.bat) END AS srat,
 CASE d.fmt WHEN 't20' THEN CASE WHEN d.comp LIKE 't20i%' THEN g2.bat_adj ELSE g2.bat END WHEN 'odi' THEN COALESCE(g2.bat_odi,g2.bat) ELSE COALESCE(g2.bat_test,g2.bat) END AS nrat
FROM d1 d
LEFT JOIN pid p1 ON p1.cricsheet_id=d.batter_id LEFT JOIN gp g1 ON g1.cricinfo=p1.cricinfo_id AND g1.g=d.gender
LEFT JOIN pid p2 ON p2.cricsheet_id=d.non_striker_id LEFT JOIN gp g2 ON g2.cricinfo=p2.cricinfo_id AND g2.g=d.gender
WHERE d.wk>=6;
""")
    print("built", db)


# ── cells ────────────────────────────────────────────────────────────────────────────────────────────────────────────

SBIN_EDGES = [-0.30, -0.20, -0.10, -0.05, 0.0, 0.05, 0.10, 0.20, 0.30]   # striker minus partner rating, binned (cells), 10 bins
H1 = 0.30   # the rating gap over which the pair's scoring (the sixes, the boundaries) grows with how much better the striker is
H2 = 0.05   # ... and over which "the senior partner" becomes definite: the strike (a refused single, a single on the last ball) follows who is the better of the two, by a little or a lot


def phase_sql(fmt: str, over: str = "over") -> str:
    if fmt == "t20":
        return f"CASE WHEN {over} <= 14 THEN 0 WHEN {over} <= 17 THEN 1 ELSE 2 END"
    if fmt == "odi":
        return f"CASE WHEN {over} < 40 THEN 0 WHEN {over} < 45 THEN 1 ELSE 2 END"
    return "0"


def kind_sql(kind: str) -> str:
    return {"league": "AND comp NOT LIKE 't20i%'", "t20i": "AND comp LIKE 't20i%'"}.get(kind, "")


def cell_query(src: str, fmt: str, gender: str, half: str | None, extra: str = "") -> str:
    """Counts by comp x stratum (rating bin, phase) x ball of the over x rating-gap bin x class of the nine-down balls, with the sum of the gap"""
    rbin = "CASE " + " ".join(f"WHEN srat < {e} THEN {i}" for i, e in enumerate(RBIN_EDGES)) + f" ELSE {len(RBIN_EDGES)} END"
    sbin = "CASE " + " ".join(f"WHEN srat - nrat < {e} THEN {i}" for i, e in enumerate(SBIN_EDGES)) + f" ELSE {len(SBIN_EDGES)} END"
    bio = "CASE WHEN legal_before_in_over <= 2 THEN 0 WHEN legal_before_in_over <= 4 THEN 1 ELSE 2 END"
    return f"""SELECT comp, {rbin} AS rbin, {phase_sql(fmt)} AS ph, {bio} AS bio, {sbin} AS sbin, cls, count(*) AS n, sum(LEAST(1.0, GREATEST(-1.0, (srat - nrat) / {H1}))) AS s1sum, sum(tanh((srat - nrat) / {H2})) AS s2sum
FROM {src} WHERE fmt='{fmt}' AND gender='{gender}' AND wk=9 AND srat IS NOT NULL AND nrat IS NOT NULL {('AND half=' + repr(half)) if half else ''} {extra}
GROUP BY ALL""".replace("{H1}", str(H1)).replace("{H2}", str(H2))


def sim_load(db: Path, simdir: Path):
    """Load the sim csvs: tag -> (fmt, gender, comp); the sim's `over` is the engine's (0-based)"""
    files = sorted(simdir.glob("sim-*.csv"))
    duck(db, "DROP TABLE IF EXISTS sim; CREATE TABLE sim AS SELECT * FROM read_csv('" + str(simdir / "sim-*.csv") + "', union_by_name=true, header=true, types={'srat':'DOUBLE','nrat':'DOUBLE'});")
    tags = duck(db, "SELECT DISTINCT tag FROM sim", True)
    print("sim", sorted(t["tag"] for t in tags), len(files), "files")
    meta = {"t20i-men": ("t20", "male"), "t20i-women": ("t20", "female"), "odi-men": ("odi", "male"), "odi-women": ("odi", "female"), "test-men": ("test", "male")}
    for t in [t["tag"] for t in tags]:
        if t not in meta:
            meta[t] = ("t20", "female" if t in ("wpl", "wbbl") else "male")
    duck(db, "DROP TABLE IF EXISTS simm; CREATE TABLE simm(tag VARCHAR, fmt VARCHAR, gender VARCHAR); INSERT INTO simm VALUES " + ",".join(f"('{k}','{v[0]}','{v[1]}')" for k, v in meta.items()) + ";")
    duck(db, "DROP TABLE IF EXISTS sims; CREATE TABLE sims AS SELECT s.*, m.fmt, m.gender, CASE WHEN s.tag LIKE 'odi-%' THEN 'odi' WHEN s.tag LIKE 'test-%' THEN 'test' ELSE s.tag END AS comp FROM sim s JOIN simm m USING(tag)")


def counts(db: Path, src: str, fmt: str, gender: str, half: str | None, extra: str = "") -> dict:  # noqa
    """(comp, rbin, ph, bio, sbin) -> (class counts, sum of the rating gap)"""
    rows = duck(db, cell_query(src, fmt, gender, half, extra), True)
    out: dict = {}
    for r in rows:
        key = (r["comp"], int(r["rbin"]), int(r["ph"]), int(r["bio"]), int(r["sbin"]))
        a = out.setdefault(key, [np.zeros(len(CLASSES)), 0.0, 0.0, 0.0])
        a[0][CLASSES.index(r["cls"])] += float(r["n"])
        a[1] += float(r["s1sum"])
        a[2] += float(r["s2sum"])
        a[3] += float(r["n"])
    return out


def build_cells(db: Path, fmt: str, gender: str, half: str | None, kind: str = "all"):
    """Real counts and the sim's re-weighted counts on the same strata"""
    real = counts(db, "ds", fmt, gender, half, kind_sql(kind))
    sim = counts(db, "sims", fmt, gender, None, kind_sql(kind))
    comps = sorted({k[0] for k in real})
    rt = {c: sum(v[0].sum() for k, v in real.items() if k[0] == c) for c in comps}
    st = {c: sum(v[0].sum() for k, v in sim.items() if k[0] == c) for c in comps}
    wt = {c: (rt[c] / st[c] if st.get(c) else 0.0) for c in comps}
    R: dict = {}
    S: dict = {}
    for k, v in real.items():
        a = R.setdefault(k[1:], [np.zeros(len(CLASSES)), 0.0, 0.0, 0.0])
        a[0] += v[0]; a[1] += v[1]; a[2] += v[2]; a[3] += v[3]
    for k, v in sim.items():
        if k[0] in wt:
            a = S.setdefault(k[1:], [np.zeros(len(CLASSES)), 0.0, 0.0, 0.0])
            a[0] += v[0] * wt[k[0]]; a[1] += v[1] * wt[k[0]]; a[2] += v[2] * wt[k[0]]; a[3] += v[3] * wt[k[0]]
    return R, S, rt


def design(R: dict, S: dict, prior: float = 2.0):
    """Arrays over the strata that have real balls: counts [cell, class], sim shares [cell, class], the cell's ball-of-the-over bucket and its gap value s = clamp(gap / h)"""
    keys = sorted(R)
    pooled: dict = {}
    for (rb, ph, bio, sb), v in S.items():
        pooled.setdefault(bio, np.zeros(len(CLASSES)))
        pooled[bio] += v[0]
    real_arr, sim_sh, bio, sv, sv2 = [], [], [], [], []
    for k in keys:
        sc = S.get(k)
        c = sc[0] if sc else np.zeros(len(CLASSES))
        base = pooled[k[2]] / max(pooled[k[2]].sum(), 1e-9)
        tot = c + prior * base
        sim_sh.append(tot / tot.sum())
        real_arr.append(R[k][0])
        bio.append(k[2])
        sv.append(R[k][1] / max(R[k][3], 1e-9))
        sv2.append(R[k][2] / max(R[k][3], 1e-9))
    return keys, np.array(real_arr), np.array(sim_sh), np.array(bio), np.array(sv), np.array(sv2)


NP = len(FITTED)
VCLASSES = ["dot", "1"]   # the ball of the over moves only the strike classes (a refused or an extra single); the rest is the pair's
NV = len(VCLASSES)


def unpack(x: np.ndarray, ng: int):
    n1 = ng * NP
    a = x[:n1].reshape(ng, NP)
    b = x[n1:2 * n1].reshape(ng, NP)
    av = x[2 * n1:2 * n1 + BIOS * NV].reshape(BIOS, NV)
    bv = x[2 * n1 + BIOS * NV:].reshape(BIOS, NV)
    return a, b, av, bv


def theta(a, b, av, bv, gi: int, bio: np.ndarray, s: np.ndarray, s2: np.ndarray):
    """Log multipliers [cell, 10 classes] for cells with ball-of-the-over bucket `bio` and gap value `s` (gender gi): a + s b, plus the strike classes' ball-of-the-over term"""
    n = len(bio)
    th = np.zeros((n, len(CLASSES)))
    for i, c in enumerate(FITTED):
        th[:, CLASSES.index(c)] = a[gi, i] + s * b[gi, i]
    for i, c in enumerate(VCLASSES):
        th[:, CLASSES.index(c)] += av[bio, i] + s2 * bv[bio, i]
    th[:, CLASSES.index("3")] = th[:, CLASSES.index("2")]
    return th


LAM_DELTA = 3.0


def nll(x, cells, ng, lam_u, lam_v, pairs=()):
    a, b, av, bv = unpack(x, ng)
    ll = 0.0
    ga, gb = np.zeros_like(a), np.zeros_like(b)
    gav, gbv = np.zeros_like(av), np.zeros_like(bv)
    for gi, real, simsh, bio, sv, sv2 in cells:
        th = theta(a, b, av, bv, gi, bio, sv, sv2)
        logit = np.log(simsh) + th
        lse = np.log(np.exp(logit).sum(1, keepdims=True))
        ll += (real * (logit - lse)).sum()
        p = np.exp(logit - lse)
        gc = real - real.sum(1, keepdims=True) * p          # d ll / d theta [cell, class]
        gc2 = gc.copy()
        gc2[:, CLASSES.index("2")] += gc[:, CLASSES.index("3")]
        for i, c in enumerate(FITTED):
            col = gc2[:, CLASSES.index(c)]
            ga[gi, i] += col.sum()
            gb[gi, i] += (col * sv).sum()
        for i, c in enumerate(VCLASSES):
            col = gc[:, CLASSES.index(c)]
            for bi in range(BIOS):
                m = bio == bi
                gav[bi, i] += col[m].sum()
                gbv[bi, i] += (col[m] * sv2[m]).sum()
    pen = lam_u * ((a ** 2).sum() + (b ** 2).sum()) + lam_v * ((av ** 2).sum() + (bv ** 2).sum())
    pa, pb = np.zeros_like(a), np.zeros_like(b)
    for child, parent in pairs:
        # the child (T20I) is the parent (league) plus a shrunk offset: the ridge acts on the offset, not on the child's own level
        pen += LAM_DELTA * (((a[child] - a[parent]) ** 2).sum() + ((b[child] - b[parent]) ** 2).sum()) - lam_u * (((a[child]) ** 2).sum() + ((b[child]) ** 2).sum())
        pa[child] += 2 * LAM_DELTA * (a[child] - a[parent]) - 2 * lam_u * a[child]
        pa[parent] -= 2 * LAM_DELTA * (a[child] - a[parent])
        pb[child] += 2 * LAM_DELTA * (b[child] - b[parent]) - 2 * lam_u * b[child]
        pb[parent] -= 2 * LAM_DELTA * (b[child] - b[parent])
    g = np.concatenate([(-ga + 2 * lam_u * a + pa).ravel(), (-gb + 2 * lam_u * b + pb).ravel(), (-gav + 2 * lam_v * av).ravel(), (-gbv + 2 * lam_v * bv).ravel()])
    return -ll + pen, g


def fit_cells(cells, ng, lam_u, lam_v, pairs=()):
    x0 = np.zeros(2 * ng * NP + 2 * BIOS * NV)
    res = minimize(nll, x0, args=(cells, ng, lam_u, lam_v, pairs), jac=True, method="L-BFGS-B")
    return unpack(res.x, ng)


def score(params, gi, cell) -> float:
    """Mean log loss per ball of a set of cells under sim shares x exp(theta)"""
    a, b, av, bv = params
    _, real, simsh, bio, sv, sv2 = cell
    th = theta(a, b, av, bv, gi, bio, sv, sv2)
    logit = np.log(simsh) + th
    lse = np.log(np.exp(logit).sum(1, keepdims=True))
    return float(-(real * (logit - lse)).sum() / max(real.sum(), 1))


GENDERS = ["male", "female"]


def diff_se(params, gi, cell) -> tuple:
    """Mean per-ball log-loss difference (fitted - engine) over a set of cells and its standard error over the balls (a ball's difference is its class's)"""
    a, b, av, bv = params
    _, real, simsh, bio, sv, sv2 = cell
    z = (np.zeros_like(a), np.zeros_like(b), np.zeros_like(av), np.zeros_like(bv))

    def ll(par):
        th = theta(*par, gi, bio, sv, sv2)
        logit = np.log(simsh) + th
        return logit - np.log(np.exp(logit).sum(1, keepdims=True))

    d = ll(params) - ll(z)                       # [cell, class]: the log-likelihood gain of a ball of that class
    n = real.sum()
    mean = float((real * d).sum() / n)
    var = float((real * d ** 2).sum() / n - mean ** 2)
    return -mean, float(np.sqrt(max(var, 0) / n))


# the strength each table is applied at, per format and gender (the fitted term x this): chosen on the position table of the matches to 2023 and read on 2024+ (docs/TACTICS.md section 5)
POWER = {}   # every table is played as fitted (1.0): the position tables of both halves saturate at the fitted strength (docs/TACTICS.md section 5)
NEUTRAL_WICKET = {"t20"}   # formats whose wicket term is made neutral: the pair's total hazard stays where the engine had it (docs/TACTICS.md section 5: a wicket row moves the all-outs)


# a calibrated offset to a slot's wicket level, from the league sims (LP_WICKET in last-pair-collect.test.ts: first-innings all-out shares of the nine men's leagues at 0 / -0.10 /
# -0.20 against the engine without the term: +0.4 points a league at 0, back to the former level at -0.10; the T20I's are already below the real share and keep 0)
WICKET_CAL = {("t20", "male", "league"): -0.10}


def neutralise_wicket(a, b, av, bv, cells):
    """Shift each slot's wicket level (a) so that, over the real nine-down cells, the sim's wicket share under the term is its share without it: the term moves
    the wickets between the two batters (b) and the ball of the over, not the pair's total"""
    a = a.copy()
    iw = FITTED.index("wicket")
    for gi, real, simsh, bio, sv, sv2 in cells:
        w = real.sum(1)
        base = float((w * simsh[:, CLASSES.index("wicket")]).sum() / w.sum())

        def share(x):
            a2 = a.copy()
            a2[gi, iw] = x
            th = theta(a2, b, av, bv, gi, bio, sv, sv2)
            logit = np.log(simsh) + th
            pr = np.exp(logit - np.log(np.exp(logit).sum(1, keepdims=True)))
            return float((w * pr[:, CLASSES.index("wicket")]).sum() / w.sum())

        lo, hi = -2.0, 2.0
        for _ in range(60):
            mid = (lo + hi) / 2
            if share(mid) > base:
                hi = mid
            else:
                lo = mid
        a[gi, iw] = (lo + hi) / 2
    return a


NEUTRAL_ALL = {"odi"}   # formats whose whole level is made neutral: every outcome class keeps its share of the nine-down balls (only the redistribution between the batters and the balls of the over remains)


def neutralise_all(a, b, av, bv, cells):
    """Shift each slot's class levels (a) so that, over the real nine-down cells, every class's share under the term is its share without it (iterative proportional fitting on the shares)"""
    a = a.copy()
    for gi, real, simsh, bio, sv, sv2 in cells:
        w = real.sum(1)
        base = (w[:, None] * simsh).sum(0) / w.sum()
        for _ in range(200):
            th = theta(a, b, av, bv, gi, bio, sv, sv2)
            logit = np.log(simsh) + th
            pr = np.exp(logit - np.log(np.exp(logit).sum(1, keepdims=True)))
            cur = (w[:, None] * pr).sum(0) / w.sum()
            step = np.log(base / cur)
            for i, c in enumerate(FITTED):
                a[gi, i] += 0.7 * step[CLASSES.index(c)]
            if np.abs(step).max() < 1e-6:
                break
    return a


def cmd_fit(db: Path, simdir: Path, write: bool, lam_u: float, lam_v: float, power: float):
    sim_load(db, simdir)
    out: dict = {}
    for fmt in FORMATS:
        slots = [(g, k) for f, g, k in SLOTS if f == fmt]
        pairs = tuple((i, j) for i, (g, k) in enumerate(slots) if k == "t20i" for j, (g2, k2) in enumerate(slots) if g2 == g and k2 == "league")
        cf, ct = [], []
        for gi, (gender, kind) in enumerate(slots):
            Rf, Sf, rtf = build_cells(db, fmt, gender, "fit", kind)
            Rt, St, _ = build_cells(db, fmt, gender, "test", kind)
            _, real, simsh, bio, sv, sv2 = design(Rf, Sf)
            _, realt, simsht, biot, svt, svt2 = design(Rt, Sf)
            cf.append((gi, real, simsh, bio, sv, sv2))
            ct.append((gi, realt, simsht, biot, svt, svt2))
        a, b, av, bv = fit_cells(cf, len(slots), lam_u, lam_v, pairs)
        if fmt in NEUTRAL_ALL:
            a = neutralise_all(a, b, av, bv, cf)
        elif fmt in NEUTRAL_WICKET:
            a = neutralise_wicket(a, b, av, bv, cf)
            for gi, (gender, kind) in enumerate(slots):
                a[gi, FITTED.index("wicket")] += WICKET_CAL.get((fmt, gender, kind), 0.0)
        zero = (np.zeros_like(a), np.zeros_like(b), np.zeros_like(av), np.zeros_like(bv))
        for gi, (gender, kind) in enumerate(slots):
            print(f"\n{fmt} {gender} {kind}: nine-down balls fit {cf[gi][1].sum():.0f}, test {ct[gi][1].sum():.0f}  (H1 {H1}, H2 {H2})")
            for name, c in (("fit", cf[gi]), ("test", ct[gi])):
                d, se = diff_se((a * power, b * power, av * power, bv * power), gi, c)
                print(f"  {name}: log loss / ball: engine {score(zero, gi, c):.4f}  fitted {score((a * power, b * power, av * power, bv * power), gi, c):.4f}  difference {d:+.4f} +- {se:.4f}  (balls {c[1].sum():.0f})")
            print("  a (the pair): " + " ".join(f"{c}={a[gi, i]:+.2f}" for i, c in enumerate(FITTED)))
            print("  b (per unit gap): " + " ".join(f"{c}={b[gi, i]:+.2f}" for i, c in enumerate(FITTED)))
            if gi == 0:
                for bi in range(BIOS):
                    print(f"  ball bucket {bi}: dot {av[bi, 0]:+.2f} + s2 {bv[bi, 0]:+.2f};  single {av[bi, 1]:+.2f} + s2 {bv[bi, 1]:+.2f}")
            pw = power
            ta = [[0.0] * len(ACTS) for _ in range(BIOS)]
            tc = [[0.0] * len(ACTS) for _ in range(BIOS)]
            tb = [0.0] * len(ACTS)
            for i, c in enumerate(FITTED):
                tb[ACTS.index(c)] = round(float(b[gi, i] * pw), 4)
            tb[ACTS.index("3")] = tb[ACTS.index("2")]
            for bi in range(BIOS):
                for i, c in enumerate(FITTED):
                    v = a[gi, i] + (av[bi, VCLASSES.index(c)] if c in VCLASSES else 0.0)
                    ta[bi][ACTS.index(c)] = round(float(v * pw), 4)
                    if c in VCLASSES:
                        tc[bi][ACTS.index(c)] = round(float(bv[bi, VCLASSES.index(c)] * pw), 4)
                ta[bi][ACTS.index("3")] = ta[bi][ACTS.index("2")]
            key = "t20i" if kind == "t20i" else fmt
            out.setdefault(key, {})[gender] = {"a": ta, "b": tb, "c": tc, "balls_fit": float(cf[gi][1].sum()), "shipped": (key, gender) in SHIPPED}
    if write:
        OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
        OUT_JSON.write_text(json.dumps({"H1": H1, "H2": H2, "bios": BIOS, "classes": ACTS, "tables": out}, indent=1))
        emit(out)
        print("wrote", OUT_JSON, OUT_TS)


# what ships: the ODI's and the women's T20I terms were fitted and scored (docs/TACTICS.md section 5) and do not improve the actual-XI holdout (the women's is 2 standard errors worse); the women's leagues have none
SHIPPED = {("t20", "male"), ("t20i", "male"), ("test", "male")}


def emit(tables: dict):
    lines = [
        "/**",
        " * GENERATED by packages/ratings/src/analysis/last-pair.py. Do not edit by hand.",
        " *",
        " * The last pair (nine down): per format and gender, the log multiplier of each outcome class (dot, 1, 2, 3, 4, 6, wicket) by the ball",
        " * of the over (0-2, 3-4, 5 legal balls already bowled) as a[bucket] + s1 b + s2 c[bucket], where g = the striker's batting rating - the partner's,",
        " * s1 = clamp(g / LAST_PAIR_H1, -1, 1) (the scoring: how much better) and s2 = tanh(g / LAST_PAIR_H2) (the strike: who is the senior one, by a little or a lot).",
        " * docs/TACTICS.md section 5, last-pair.ts.",
        " */",
        f"export const LAST_PAIR_H1 = {H1};",
        f"export const LAST_PAIR_H2 = {H2};",
        f"export const LAST_PAIR_CLASSES = {json.dumps(ACTS)} as const;",
        "/** [ball-of-the-over bucket][class] */",
        "export interface LastPairTable { a: number[][]; b: number[]; c: number[][] }",
        "export const LAST_PAIR: Record<\"t20\" | \"t20i\" | \"odi\" | \"test\", Partial<Record<\"male\" | \"female\", LastPairTable>>> = {",
    ]
    for fmt in TABLES:
        lines.append(f"  {fmt}: {{")
        for g in ("male", "female"):
            if fmt in tables and g in tables[fmt] and (fmt, g) in SHIPPED:
                t = tables[fmt][g]
                lines.append(f"    {g}: {{ a: {json.dumps(t['a'])}, b: {json.dumps(t['b'])}, c: {json.dumps(t['c'])} }},")
        lines.append("  },")
    lines.append("};")
    lines.append("/** How strongly each format and gender plays the fitted term (1 = as fitted; applied to what separates the two batters and the balls of the over, not to the pair's level): docs/TACTICS.md section 5 */")
    lines.append("export const LAST_PAIR_STRENGTH: Record<\"t20\" | \"odi\" | \"test\", Record<\"male\" | \"female\", number>> = {")
    for fmt in FORMATS:
        lines.append(f"  {fmt}: {{ male: {POWER.get((fmt, 'male'), 1.0)}, female: {POWER.get((fmt, 'female'), 1.0)} }},")
    lines.append("};")
    OUT_TS.write_text("\n".join(lines) + "\n")


def cmd_report(db: Path, simdir: Path):
    sim_load(db, simdir)
    for fmt, gender in GROUPS:
        print(f"\n{fmt} {gender} (nine down, rated pairs): real | sim, by role and ball of the over")
        for src, label in (("ds", "real"), ("sims", "sim")):
            rows = duck(db, f"""SELECT CASE WHEN srat < nrat THEN 'weak' WHEN srat > nrat THEN 'strong' ELSE 'tie' END AS role,
 CASE WHEN legal_before_in_over <= 2 THEN 'b1-3' WHEN legal_before_in_over <= 4 THEN 'b4-5' ELSE 'b6' END AS bio, count(*) n,
 avg((cls='dot')::int) dot, avg((cls='1')::int) one, avg((cls IN ('4','6'))::int) bnd, avg(is_wicket) wk
 FROM {src} WHERE fmt='{fmt}' AND gender='{gender}' AND wk=9 AND wides=0 AND srat IS NOT NULL AND nrat IS NOT NULL GROUP BY ALL ORDER BY 1,2""", True)
            for r in rows:
                if r["role"] == "tie":
                    continue
                print(f"  {label:4s} {r['role']:6s} {r['bio']:5s} n={int(r['n']):6d} dot {r['dot']:.3f} one {r['one']:.3f} bnd {r['bnd']:.3f} wkt {r['wk']:.3f}")


if __name__ == "__main__":
    cmd = sys.argv[1]
    arg = lambda n, d: float(sys.argv[sys.argv.index(n) + 1]) if n in sys.argv else d
    if cmd == "build":
        build(Path(sys.argv[2]))
    elif cmd == "fit":
        cmd_fit(Path(sys.argv[2]), Path(sys.argv[3]), "--write" in sys.argv, arg("--lam-u", 1.0), arg("--lam-v", 1.0), arg("--power", 1.0))
    elif cmd == "report":
        cmd_report(Path(sys.argv[2]), Path(sys.argv[3]))
