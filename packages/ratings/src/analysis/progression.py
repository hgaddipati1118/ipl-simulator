"""
Fit how real players' ratings move from season to season, from the CricketArchive per-year ratings
(data/analysis/ca_ratings_by_year.parquet, T20 rows, men and women), and export a compact parameter set to the
engine: packages/engine/src/progression-model.ts. Also writes data/analysis/progression_params.json,
progression-report.md and the validation cohort used by the engine tests
(packages/engine/src/__tests__/fixtures/progression-cohort.json).

What is modelled (everything is on the 0-99 "ovr" scale the game shows; the game's discipline overalls are on the
same scale, slope ~1.0 for batting and ~0.9 for bowling against the CA values for current players):

  next-season change of a discipline's ovr  =  mean(age, level, last change, experience, kind)  +  sd(age, experience) * z

  * mean: age effect (10 age bins, linear between bin centres) + piecewise-linear regression to the mean on the
    level (slope below 50, between 50 and 80, above 80) + the last season's change (negative: a big jump partly
    gives back) + log experience (seasons of rating evidence) + a small offset by kind (spin / lower-order ...).
    Fitted by least squares on consecutive-season pairs of players who are regulars (120+ T20 balls in that
    discipline) in both seasons, men and women separately (women ridge-shrunk toward the men's coefficients).
  * sd: multiplicative in age and experience (new players move a lot, old hands little).
  * z: the empirical standardised residual quantiles, so the tails (breakouts and collapses) are real.
  * retirement: logistic hazard of never playing T20 again, by age, level, role class and gender.

Run from packages/ratings:  python3 -I src/analysis/progression.py
"""
import csv, json, math, subprocess, sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
PARQUET = DATA / "ca_ratings_by_year.parquet"
ENGINE = ROOT.parent / "engine"
OUT_TS = ENGINE / "src" / "progression-model.ts"
OUT_FIXTURE = ENGINE / "src" / "__tests__" / "fixtures" / "progression-cohort.json"
OUT_JSON = DATA / "progression_params.json"
OUT_REPORT = DATA / "progression-report.md"

REG = 120                      # T20 balls in a year to count as a regular in a discipline
NEXT_MIN = 0                   # balls needed next season (0 = any T20 row, so players who fall out of the side count too)
AGE_BINS = [(0, 20), (21, 22), (23, 24), (25, 26), (27, 28), (29, 30), (31, 32), (33, 34), (35, 36), (37, 99)]
EXP_BINS = [(1, 2), (3, 4), (5, 7), (8, 12), (13, 99)]
EXP_CAP = 15
Z_P = [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.975, 0.99, 0.995, 0.998]
RIDGE_WOMEN = 400.0


def duck(sql):
    out = subprocess.run(["duckdb", "-csv", "-nullvalue", "", "-c", sql], capture_output=True, text=True, cwd=ROOT)
    if out.returncode:
        sys.exit(out.stderr)
    return list(csv.DictReader(out.stdout.splitlines()))


def fnum(x):
    return float(x) if x not in ("", None) else None


# ---------------------------------------------------------------------------------------------------- small linear algebra
def solve(A, b):
    k = len(b)
    M = [A[i][:] + [b[i]] for i in range(k)]
    for i in range(k):
        p = max(range(i, k), key=lambda r: abs(M[r][i]))
        M[i], M[p] = M[p], M[i]
        piv = M[i][i] if abs(M[i][i]) > 1e-12 else 1e-12
        for r in range(k):
            if r != i:
                m = M[r][i] / piv
                if m:
                    for c in range(i, k + 1):
                        M[r][c] -= m * M[i][c]
    return [M[i][k] / (M[i][i] if abs(M[i][i]) > 1e-12 else 1e-12) for i in range(k)]


def ridge(X, y, prior=None, lam=0.0, w=None):
    """Least squares y ~ X b, with an optional ridge pull of every coefficient toward `prior`."""
    k = len(X[0])
    A = [[0.0] * k for _ in range(k)]
    b = [0.0] * k
    for n, (xi, yi) in enumerate(zip(X, y)):
        wi = 1.0 if w is None else w[n]
        for i in range(k):
            xv = xi[i] * wi
            if xv == 0:
                continue
            b[i] += xv * yi
            for j in range(i, k):
                A[i][j] += xv * xi[j]
    for i in range(k):
        for j in range(i):
            A[i][j] = A[j][i]
    for i in range(k):
        A[i][i] += 1e-6 + lam
        if prior is not None:
            b[i] += lam * prior[i]
    return solve(A, b)


def logistic(X, y, iters=25, l2=1e-3):
    k = len(X[0])
    beta = [0.0] * k
    for _ in range(iters):
        g = [0.0] * k
        H = [[0.0] * k for _ in range(k)]
        for xi, yi in zip(X, y):
            eta = sum(a * b for a, b in zip(beta, xi))
            p = 1 / (1 + math.exp(-max(-30, min(30, eta))))
            wgt = p * (1 - p)
            for i in range(k):
                if xi[i] == 0:
                    continue
                g[i] += (yi - p) * xi[i]
                for j in range(i, k):
                    H[i][j] += wgt * xi[i] * xi[j]
        for i in range(k):
            for j in range(i):
                H[i][j] = H[j][i]
            H[i][i] += l2
            g[i] -= l2 * beta[i]
        step = solve(H, g)
        beta = [a + s for a, s in zip(beta, step)]
        if max(abs(s) for s in step) < 1e-6:
            break
    return beta


def quantile(sorted_v, p):
    if not sorted_v:
        return 0.0
    i = p * (len(sorted_v) - 1)
    lo = int(math.floor(i))
    hi = min(len(sorted_v) - 1, lo + 1)
    return sorted_v[lo] + (sorted_v[hi] - sorted_v[lo]) * (i - lo)


def bin_of(v, bins):
    for i, (lo, hi) in enumerate(bins):
        if lo <= v <= hi:
            return i
    return len(bins) - 1


# ---------------------------------------------------------------------------------------------------- data
PAIRS_SQL = f"""
WITH n AS (
  SELECT *, round(age)::int a, row_number() OVER (PARTITION BY player_id, gender ORDER BY year) nrow
  FROM '{PARQUET}' WHERE format = 'T20')
SELECT a0.player_id, a0.gender, a0.year, a0.a + 1 age_next, a0.batting_role brole, a0.bowling_type btype, a0.nrow,
  a0.bat_balls bb0, a0.bat_ovr bo0, a1.bat_balls bb1, a1.bat_ovr bo1, am.bat_ovr bom,
  a0.bowl_balls wb0, a0.bowl_ovr wo0, a1.bowl_balls wb1, a1.bowl_ovr wo1, am.bowl_ovr wom
FROM n a0 JOIN n a1 ON a1.player_id = a0.player_id AND a1.gender = a0.gender AND a1.year = a0.year + 1
LEFT JOIN n am ON am.player_id = a0.player_id AND am.gender = a0.gender AND am.year = a0.year - 1
WHERE a0.age IS NOT NULL
"""

RETIRE_SQL = f"""
WITH n AS (SELECT *, round(age)::int a FROM '{PARQUET}' WHERE format = 'T20' AND age IS NOT NULL)
SELECT a0.gender, a0.a age, a0.bat_balls bb, a0.bowl_balls wb, a0.bat_ovr bo, a0.bowl_ovr wo, a0.bowling_type btype,
  CASE WHEN EXISTS (SELECT 1 FROM '{PARQUET}' f WHERE f.format = 'T20' AND f.player_id = a0.player_id AND f.gender = a0.gender
                    AND f.year BETWEEN a0.year + 1 AND a0.year + 4) THEN 0 ELSE 1 END gone
FROM n a0 WHERE a0.year <= 2022 AND (a0.bat_balls >= 120 OR a0.bowl_balls >= 120)
"""


def features(side, r, kind_names):
    """Regressors for one pair: age dummies, level pieces, momentum, log experience, kind dummies."""
    o = r["o0"]
    age_i = bin_of(r["age_next"], AGE_BINS)
    x = [1.0 if i == age_i else 0.0 for i in range(len(AGE_BINS))]
    x += [o - 65.0, max(0.0, o - 80.0), min(0.0, o - 50.0), r["mom"], math.log(min(r["nrow"], EXP_CAP))]
    x += [1.0 if r["kind"] == k else 0.0 for k in kind_names]
    return x


KINDS = {"bat": ["top", "lower"], "bowl": ["spin"]}


def load_pairs():
    pairs = {("male", "bat"): [], ("male", "bowl"): [], ("female", "bat"): [], ("female", "bowl"): []}
    periph = {"bat": [], "bowl": []}
    for r in duck(PAIRS_SQL):
        g = r["gender"]
        nrow = int(r["nrow"])
        for side, p in (("bat", "b"), ("bowl", "w")):
            o0, o1, om = fnum(r[p + "o0"]), fnum(r[p + "o1"]), fnum(r[p + "om"])
            b0, b1 = int(r[p + "b0"]), int(r[p + "b1"])
            if o0 is None or o1 is None:
                continue
            if side == "bat":
                kind = "top" if r["brole"] == "top" else "lower" if r["brole"] == "lower" else "middle"
            else:
                kind = "spin" if r["btype"] == "spin" else "pace"
            row = dict(age_next=int(r["age_next"]), o0=o0, o1=o1, mom=(o0 - om) if om is not None else 0.0,
                       nrow=nrow, kind=kind, y=o1 - o0, year=int(r["year"]), has_mom=om is not None)
            if b0 >= REG and b1 >= NEXT_MIN:
                pairs[(g, side)].append(row)
            else:
                # peripheral: the other discipline is the regular one in both seasons
                o_b0, o_b1 = (int(r["wb0"]), int(r["wb1"])) if side == "bat" else (int(r["bb0"]), int(r["bb1"]))
                if o_b0 >= REG and o_b1 >= REG and b0 < REG:
                    periph[side].append(row)
    # Calendar effects: the ovr scale is re-normalised among each year's regulars, so a whole cohort drifts together
    # (mean change by year swings between about -5 and +5 points). That is an artefact of the rating system, not
    # something a player does, so the fit and the validation both work net of it.
    ym = {}
    for (g, side), rows in pairs.items():
        by = defaultdict(list)
        for r in rows:
            by[r["year"]].append(r["y"])
        for yr, v in by.items():
            ym[(g, side, yr)] = sum(v) / len(v) if len(v) >= 25 else 0.0
    for (g, side), rows in pairs.items():
        for r in rows:
            r["y"] -= ym.get((g, side, r["year"]), 0.0)
            if r["has_mom"]:
                r["mom"] -= ym.get((g, side, r["year"] - 1), 0.0)
    for side, rows in periph.items():
        for r in rows:
            r["y"] -= ym.get(("male", side, r["year"]), 0.0)
    return pairs, periph, ym


# ---------------------------------------------------------------------------------------------------- fits
def fit_mean_sd(side, rows, prior=None, lam=0.0):
    kinds = KINDS[side]
    X = [features(side, r, kinds) for r in rows]
    y = [r["y"] for r in rows]
    beta = ridge(X, y, prior, lam)
    res = [yi - sum(a * b for a, b in zip(beta, xi)) for xi, yi in zip(X, y)]
    # multiplicative sd: age x experience, two passes
    age_i = [bin_of(r["age_next"], AGE_BINS) for r in rows]
    exp_i = [bin_of(r["nrow"], EXP_BINS) for r in rows]
    fa = [1.0] * len(AGE_BINS)
    fe = [1.0] * len(EXP_BINS)
    for _ in range(6):
        for j in range(len(EXP_BINS)):
            v = [res[n] / fa[age_i[n]] for n in range(len(rows)) if exp_i[n] == j]
            if len(v) >= 20:
                fe[j] = math.sqrt(sum(a * a for a in v) / len(v))
        ref = fe[2]
        fe = [f / ref for f in fe]
        for j in range(len(AGE_BINS)):
            v = [res[n] / fe[exp_i[n]] for n in range(len(rows)) if age_i[n] == j]
            if len(v) >= 20:
                fa[j] = math.sqrt(sum(a * a for a in v) / len(v))
        ref = sum(fa) / len(fa)
        fa = [f / ref for f in fa]
    z = [res[n] / (fa[age_i[n]] * fe[exp_i[n]]) for n in range(len(rows))]
    s0 = math.sqrt(sum(a * a for a in z) / len(z))
    z = [a / s0 for a in z]
    ages = [[r["age_next"] for r, i in zip(rows, age_i) if i == j] for j in range(len(AGE_BINS))]
    exps = [[r["nrow"] for r, i in zip(rows, exp_i) if i == j] for j in range(len(EXP_BINS))]
    nodes_age = [round(sum(a) / len(a), 1) if a else float(sum(AGE_BINS[j]) / 2) for j, a in enumerate(ages)]
    nodes_exp = [round(sum(a) / len(a), 1) if a else float(EXP_BINS[j][0]) for j, a in enumerate(exps)]
    k = len(AGE_BINS)
    return dict(
        beta=beta, ageNodes=nodes_age, ageEffect=beta[:k], slope=beta[k], slopeHigh=beta[k + 1], slopeLow=beta[k + 2],
        momentum=beta[k + 3], expCoef=beta[k + 4], kind={n: beta[k + 5 + i] for i, n in enumerate(kinds)},
        sdBase=s0, sdAge=fa, expNodes=nodes_exp, sdExp=fe, z=z, n=len(rows),
        resid_sd=math.sqrt(sum(a * a for a in res) / len(res)),
    ), res


def z_quantiles(z):
    v = sorted(z)
    q = [quantile(v, p) for p in Z_P]
    return [round(a, 3) for a in q]


def fit_retirement():
    rows = duck(RETIRE_SQL)
    bins = [(0, 22), (23, 25), (26, 28), (29, 31), (32, 33), (34, 35), (36, 37), (38, 39), (40, 41), (42, 99)]
    roles = ["bat", "pace", "spin", "allround"]
    X, y = [], []
    for r in rows:
        bb, wb = int(r["bb"]), int(r["wb"])
        bo, wo = fnum(r["bo"]), fnum(r["wo"])
        bat_reg, bowl_reg = bb >= REG, wb >= REG
        role = "allround" if (bat_reg and bowl_reg) else ("spin" if r["btype"] == "spin" else "pace") if bowl_reg else "bat"
        bo_v = bo if bo is not None and bb > 0 else 0.0
        wo_v = wo if wo is not None and wb > 0 else 0.0
        s, w = max(bo_v, wo_v), min(bo_v, wo_v)
        overall = s + (100 - s) * (w / 100) ** 4
        age_i = bin_of(int(r["age"]), bins)
        x = [1.0 if i == age_i else 0.0 for i in range(len(bins))]
        x += [(overall - 65) / 10, 1.0 if r["gender"] == "female" else 0.0]
        x += [1.0 if role == k else 0.0 for k in roles[1:]]
        X.append(x)
        y.append(float(r["gone"]))
    beta = logistic(X, y)
    # calibration table: observed vs fitted by age bin and role
    cal = []
    for j, (lo, hi) in enumerate(bins):
        idx = [i for i in range(len(X)) if X[i][j] == 1.0]
        obs = sum(y[i] for i in idx) / max(1, len(idx))
        fit = sum(1 / (1 + math.exp(-sum(a * b for a, b in zip(beta, X[i])))) for i in idx) / max(1, len(idx))
        cal.append(dict(ages=f"{lo}-{hi}", n=len(idx), observed=round(obs, 3), fitted=round(fit, 3)))
    k = len(bins)
    return dict(
        bins=[[lo, hi] for lo, hi in bins], ageEffect=[round(b, 3) for b in beta[:k]], level=round(beta[k], 3),
        female=round(beta[k + 1], 3), role={"bat": 0.0, **{r: round(beta[k + 2 + i], 3) for i, r in enumerate(roles[1:])}},
        n=len(X)), cal


def cohort(base_year, gender, horizon, ym):
    """Players who were regulars (120+ T20 balls in a discipline) in the base year, with what happened next."""
    cols = "player_id, round(age)::int a, batting_role, bowling_type, bat_balls, bowl_balls, bat_ovr, bowl_ovr, year"
    rows = duck(f"""WITH n AS (SELECT *, row_number() OVER (PARTITION BY player_id ORDER BY year) nrow
                    FROM '{PARQUET}' WHERE format = 'T20' AND gender = '{gender}')
                    SELECT {cols}, nrow FROM n WHERE year BETWEEN {base_year - 2} AND {base_year + horizon} AND age IS NOT NULL""")
    by = defaultdict(dict)
    for r in rows:
        by[int(r["player_id"])][int(r["year"])] = r
    out = []
    for pid, ys in by.items():
        r0 = ys.get(base_year)
        if r0 is None:
            continue
        bb, wb = int(r0["bat_balls"]), int(r0["bowl_balls"])
        age = int(r0["a"])
        if not (bb >= REG or wb >= REG) or not (17 <= age <= 40):
            continue

        def val(r, k):
            v = fnum(r[k]) if r else None
            return None if v is None else int(round(v))
        def adj(side, y):
            """Shift into the base year's frame: undo the common calendar drift between year y and the base year"""
            return sum(ym.get((gender, side, yy), 0.0) for yy in range(min(y, base_year), max(y, base_year))) * (1 if y < base_year else -1)

        def pair(y):
            r = ys.get(y)
            if not r:
                return None
            b, w = val(r, "bat_ovr"), val(r, "bowl_ovr")
            return [None if b is None else int(round(b + adj("bat", y))), None if w is None else int(round(w + adj("bowl", y)))]
        outcomes = []
        for k in range(1, horizon + 1):
            r = ys.get(base_year + k)
            if r is None:
                outcomes.append(None)
                continue
            b, w = val(r, "bat_ovr"), val(r, "bowl_ovr")
            # outcomes net of the common calendar drift since the base year
            outcomes.append([None if b is None else int(round(b + adj("bat", base_year + k))),
                             None if w is None else int(round(w + adj("bowl", base_year + k))), int(r["bat_balls"]), int(r["bowl_balls"])])
        out.append(dict(g=gender[0], a=age, bo=val(r0, "bat_ovr"), wo=val(r0, "bowl_ovr"), bb=bb, wb=wb,
                        n=int(r0["nrow"]), bt=r0["bowling_type"] or "unknown", br=r0["batting_role"] or "middle",
                        p=[pair(base_year - 1), pair(base_year - 2)], o=outcomes))
    return out


# ---------------------------------------------------------------------------------------------------- export
def r3(v):
    return [round(a, 3) for a in v] if isinstance(v, list) else round(v, 3)


def discipline_ts(d):
    return {
        "ageNodes": d["ageNodes"], "ageEffect": r3(d["ageEffect"]), "slope": r3(d["slope"]), "slopeHigh": r3(d["slopeHigh"]),
        "slopeLow": r3(d["slopeLow"]), "momentum": r3(d["momentum"]), "expCoef": r3(d["expCoef"]),
        "kind": {k: r3(v) for k, v in d["kind"].items()}, "sdBase": r3(d["sdBase"]), "sdAge": r3(d["sdAge"]),
        "expNodes": d["expNodes"], "sdExp": r3(d["sdExp"]),
    }


def main():
    pairs, periph, ym = load_pairs()
    fits, resid = {}, {}
    for side in ("bat", "bowl"):
        m, res_m = fit_mean_sd(side, pairs[("male", side)])
        w, res_w = fit_mean_sd(side, pairs[("female", side)], prior=m["beta"], lam=RIDGE_WOMEN)
        fits[("male", side)], fits[("female", side)] = m, w
        resid[("male", side)], resid[("female", side)] = res_m, res_w
    zq = {side: z_quantiles(fits[("male", side)]["z"] + fits[("female", side)]["z"]) for side in ("bat", "bowl")}
    retire, retire_cal = fit_retirement()

    # peripheral discipline: sd relative to the regulars' sd (reported; the engine uses PERIPHERAL_SD_SCALE below)
    periph_sd = {s: math.sqrt(sum(r["y"] ** 2 for r in periph[s]) / max(1, len(periph[s]))) for s in periph}

    model = {
        "bat": {g: discipline_ts(fits[(g, "bat")]) for g in ("male", "female")},
        "bowl": {g: discipline_ts(fits[(g, "bowl")]) for g in ("male", "female")},
        "zProbs": Z_P, "zQuantiles": zq, "retirement": retire,
    }
    json.dump({**model, "fitInfo": {f"{g}/{s}": {"n": fits[(g, s)]["n"], "resid_sd": round(fits[(g, s)]["resid_sd"], 3)} for g, s in fits},
               "peripheralRms": periph_sd, "retirementCalibration": retire_cal,
               "yearEffects": {f"{g}/{s}/{y}": round(v, 2) for (g, s, y), v in sorted(ym.items())}}, open(OUT_JSON, "w"), indent=1)

    def ts(v, ind=0):
        return json.dumps(v)
    lines = [
        "// Generated by packages/ratings/src/analysis/progression.py from the CricketArchive per-year T20 ratings",
        "// (data/analysis/ca_ratings_by_year.parquet). Do not edit by hand; re-run the script.",
        "//",
        "// Season-to-season rating movement fitted on real careers: mean change by age, level (regression to the mean),",
        "// last season's change (give-back after a jump) and experience; spread by age and experience; the empirical",
        "// standardised residual quantiles (fat tails: breakouts and collapses); and the retirement hazard.",
        "// See docs/RATINGS-PIPELINE.md, \"Progression model\".",
        "",
        "export interface DisciplineFit {",
        "  /** Mean age (after the birthday) of the players in each age bin */",
        "  ageNodes: number[];",
        "  /** Expected change at 65 ovr, no recent change, for each bin; linear between nodes */",
        "  ageEffect: number[];",
        "  /** Regression to the mean, per ovr point above 65 (up to 80) */",
        "  slope: number;",
        "  /** Extra slope per ovr point above 80 */",
        "  slopeHigh: number;",
        "  /** Extra slope per ovr point below 50 (negative ovr-50 side) */",
        "  slopeLow: number;",
        "  /** Per point of last season's change */",
        "  momentum: number;",
        "  /** Per log(min(seasons of rating evidence, 15)) */",
        "  expCoef: number;",
        "  kind: Record<string, number>;",
        "  sdBase: number;",
        "  sdAge: number[];",
        "  expNodes: number[];",
        "  sdExp: number[];",
        "}",
        "",
        "export interface RetirementFit {",
        "  bins: number[][];",
        "  ageEffect: number[];",
        "  level: number;",
        "  female: number;",
        "  role: Record<string, number>;",
        "  n: number;",
        "}",
        "",
        "export const PROGRESSION_MODEL: {",
        "  bat: Record<\"male\" | \"female\", DisciplineFit>;",
        "  bowl: Record<\"male\" | \"female\", DisciplineFit>;",
        "  zProbs: number[];",
        "  zQuantiles: Record<\"bat\" | \"bowl\", number[]>;",
        "  retirement: RetirementFit;",
        "} = " + json.dumps(model, indent=2) + ";",
        "",
    ]
    OUT_TS.write_text("\n".join(lines))
    print("wrote", OUT_TS)

    # validation cohorts: men from 2015 (10 seasons forward), women from 2018 (8)
    cohorts = {"male": {"baseYear": 2015, "players": cohort(2015, "male", 10, ym)},
               "female": {"baseYear": 2018, "players": cohort(2018, "female", 8, ym)}}
    OUT_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    json.dump(cohorts, open(OUT_FIXTURE, "w"), separators=(",", ":"))
    print("wrote", OUT_FIXTURE, {g: len(c["players"]) for g, c in cohorts.items()})

    # report
    L = ["# Progression model fit", "", "Pairs of consecutive T20 seasons of regulars (120+ balls in the discipline both years).", ""]
    for (g, s), f in fits.items():
        L += [f"## {g} {s}: n={f['n']} pairs, residual sd {f['resid_sd']:.2f}", "",
              "age bin means / age effect / sd multiplier:", "",
              "| age node | effect | sd x |", "|---|---|---|"]
        for a, e, sd in zip(f["ageNodes"], f["ageEffect"], f["sdAge"]):
            L.append(f"| {a} | {e:+.2f} | {sd:.2f} |")
        L += ["", f"level slope {f['slope']:.3f}/pt (above 80: {f['slopeHigh']:+.3f}, below 50: {f['slopeLow']:+.3f}), momentum {f['momentum']:+.3f}, "
              f"log-experience {f['expCoef']:+.3f}, kind {({k: round(v, 2) for k, v in f['kind'].items()})}", "",
              "experience (seasons) vs sd x: " + ", ".join(f"{e}:{x:.2f}" for e, x in zip(f["expNodes"], f["sdExp"])), ""]
    L += ["## Retirement (never plays T20 again within 4 seasons)", "", "| age | n | observed | fitted |", "|---|---|---|---|"]
    for c in retire_cal:
        L.append(f"| {c['ages']} | {c['n']} | {c['observed']} | {c['fitted']} |")
    L += ["", f"level coefficient {retire['level']} per 10 ovr, women {retire['female']}, role {retire['role']}", ""]
    OUT_REPORT.write_text("\n".join(L))
    print("wrote", OUT_REPORT)
    for (g, s), f in fits.items():
        print(g, s, f["n"], "resid sd %.2f" % f["resid_sd"], "slope %.3f mom %.3f exp %.3f" % (f["slope"], f["momentum"], f["expCoef"]))
    print("retire", retire)


if __name__ == "__main__":
    main()
