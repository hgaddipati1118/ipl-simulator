"""
CricketArchive per-year player ratings, age curves and projections (all senior formats, men and women).

Input  (from src/analysis/ca-player-seasons.sql):
    data/analysis/ca_cells.parquet  one row per side x format x gender x competition x year x player, with
                                    `value` = runs above the competition-season average ball (see the SQL)
    data/cricket.db                 player names / DOB / bowling style
    data/cricsheet/people.csv       CricketArchive id -> Cricsheet / ESPNcricinfo ids
Output (data/analysis/):
    ca_ratings_by_year.parquet      one row per player x format x year played
    ca_age_curves.csv               smoothed year-over-year change by age, role, format, gender, side
    ca_validation.json              tuning + out-of-sample validation numbers
    ca_comp_strength.csv            fitted competition strength (positive = harder), weak-tier flag, pool level
    ca-ratings-report.md            method, validation tables, sanity examples, curve shape

Method, per (side, format, gender):
 1. Rate per cell = 100 * value / balls (runs per 100 balls above the competition-season average).
 2. Competition strength: rate[p,c,y] = skill[p,y] - strength[c], alternating weighted least squares over
    player-years that played in 2+ competitions in the same year (the links), strength shrunk to 0 with a prior
    worth PRIOR balls and centred on the ball-weighted mean.  Internationals are split by opponent
    ("T20I v India"), so this also learns opponent strength in international cricket.
    Adjusted rate a = rate + strength[c].
 3. Weak-tier translation: the additive fit under-corrects weak competitions, so for the bottom tier (strength
    below the 30th ball-weighted percentile) a' = alpha + rho * a, fitted on players with enough balls in both
    tiers in the same year (rho clipped to [0.3, 1]).
 4. Ratings: exponentially decayed (half-life h years) ball-weighted mean of a' up to year Y, shrunk toward a
    prior worth K balls.  Prior = the player's decayed mean competition pool level (mean a' in the competitions he
    played) + a role offset (batting-position bucket for batting; pace/spin for bowling).
    `season` = the same shrinkage on that year's balls only.  h, K (and an optional trend term) are tuned on a
    fold that ends in 2020 and predicts 2021-22; 2024-25 is held out for the final check.
 5. Age curves: delta method on unshrunk season values of the same player in consecutive years, weighted by the
    harmonic mean of the two years' balls, smoothed over +-2 years and shrunk toward the side x format x gender
    curve.  Projection for next year = rating + curve change at the player's current age.
 6. 0-99 scale: 65 + 11 z against that year's regulars (players with >= REG balls that year), clipped 25-99.
Run from packages/ratings:  python3 -I src/analysis/ca-ratings.py
"""
import csv, json, math, os, subprocess, sys, time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
WORK = Path(os.environ.get("CA_RATINGS_WORK", "/Volumes/Data/tmp/ca-ratings"))
WORK.mkdir(parents=True, exist_ok=True)

FORMATS = ("T20", "ListA", "FC")
PRIOR = {"T20": 2000, "ListA": 4000, "FC": 10000}
CLASS_PRIOR_MULT = 5          # class / super-class means are shrunk with 5x the competition prior
FULL_MEMBER_CODES = {"ENG", "IND", "RSA", "AUS", "PAK", "SL", "NZ", "WI", "BDESH", "ZIM", "IRELAND", "AFG"}


def super_class(cls):
    if cls.startswith("intl_"):
        return "full" if cls == "intl_full" else "assoc"
    return "full" if cls[4:] in FULL_MEMBER_CODES else "assoc"
MIN_LINK = {"T20": 60, "ListA": 120, "FC": 300}     # balls per tier for translation links
MIN_TARGET = {"T20": 100, "ListA": 200, "FC": 500}  # target-period balls to enter validation
MIN_AGE = {"T20": 60, "ListA": 120, "FC": 300}      # balls per season for age-curve pairs
REG = {"T20": 120, "ListA": 240, "FC": 600}         # balls in a year to count as a regular for the 0-99 scale
K_GRID = {"T20": [100, 200, 400, 800, 1600], "ListA": [200, 400, 800, 1600, 3200], "FC": [500, 1000, 2000, 4000, 8000]}
H_GRID = [1.0, 2.0, 3.0, 5.0]
BETA_GRID = [0.0, 0.25, 0.5]
AGES = range(16, 43)
LAST_YEAR = 2026


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)


def duck(sql):
    out = subprocess.run(["duckdb", "-csv", "-nullvalue", "", "-c", "LOAD sqlite; " + sql], capture_output=True, text=True, cwd=ROOT)
    if out.returncode:
        sys.exit(out.stderr)
    return list(csv.DictReader(out.stdout.splitlines()))


def wmean(pairs):
    sw = sum(w for _, w in pairs)
    return sum(v * w for v, w in pairs) / sw if sw else 0.0


def wcorr(xs, ys, ws):
    sw = sum(ws)
    if sw == 0 or len(xs) < 3:
        return float("nan")
    mx = sum(x * w for x, w in zip(xs, ws)) / sw
    my = sum(y * w for y, w in zip(ys, ws)) / sw
    cxy = sum(w * (x - mx) * (y - my) for x, y, w in zip(xs, ys, ws))
    cxx = sum(w * (x - mx) ** 2 for x, w in zip(xs, ws))
    cyy = sum(w * (y - my) ** 2 for y, w in zip(ys, ws))
    return cxy / math.sqrt(cxx * cyy) if cxx > 0 and cyy > 0 else float("nan")


def wmse(xs, ys, ws):
    sw = sum(ws)
    return sum(w * (x - y) ** 2 for x, y, w in zip(xs, ys, ws)) / sw if sw else float("nan")


# ── load ────────────────────────────────────────────────────────────────────────

def load():
    rows = duck("SELECT side, format, gender, comp, comp_class, year, player_id, balls, value, mean_position FROM 'data/analysis/ca_cells.parquet' WHERE balls > 0 AND value IS NOT NULL")
    groups = defaultdict(list)
    for r in rows:
        groups[(r["side"], r["format"], r["gender"])].append(
            (r["comp"], int(r["year"]), int(r["player_id"]), float(r["balls"]), float(r["value"]),
             float(r["mean_position"]) if r["mean_position"] else None, r["comp_class"]))
    pids = {c[2] for g in groups.values() for c in g}
    meta = {}
    for r in duck("ATTACH 'data/cricket.db' AS c (TYPE sqlite, READ_ONLY); SELECT id, name, full_name, dob, bowling_style FROM c.players"):
        pid = int(r["id"])
        if pid in pids:
            meta[pid] = r
    people = {}
    with open(ROOT / "data" / "cricsheet" / "people.csv", newline="") as f:
        for r in csv.DictReader(f):
            for k in ("key_cricketarchive", "key_cricketarchive_2"):
                if r.get(k):
                    people[int(r[k])] = (r["identifier"], r.get("key_cricinfo") or "")
    return groups, meta, people


def dob_year(meta, pid):
    d = (meta.get(pid) or {}).get("dob") or ""
    try:
        y, m, dd = (int(x) for x in d.split("-"))
        return y + (m - 1) / 12 + dd / 365
    except ValueError:
        return None


def bowl_type(style):
    s = (style or "").lower()
    if any(k in s for k in ("break", "orthodox", "googly", "chinaman", "spin", "wrist", "slow left")):
        return "spin"
    if any(k in s for k in ("fast", "medium", "pace", "seam")):
        return "pace"
    return "unknown"


# ── fit: strengths, translation, pools, role offsets ───────────────────────────

def fit(cells, fmt, cutoff, roles):
    """cells: (comp, year, pid, balls, value, pos). Uses years <= cutoff. Returns a model dict."""
    use = [c for c in cells if c[1] <= cutoff and c[3] >= 6]
    by_py = defaultdict(list)
    for i, c in enumerate(use):
        by_py[(c[2], c[1])].append(i)
    links = {k: v for k, v in by_py.items() if len({use[i][0] for i in v}) >= 2}
    strength = defaultdict(float)
    comp_balls = defaultdict(float)
    cls_votes = defaultdict(lambda: defaultdict(float))
    for c in use:
        comp_balls[c[0]] += c[3]
        cls_votes[c[0]][c[6]] += c[3]
    comp_cls = {comp: max(v, key=v.get) for comp, v in cls_votes.items()}
    tot = sum(comp_balls.values())
    cp = CLASS_PRIOR_MULT * PRIOR[fmt]
    for _ in range(40):
        skill = {}
        for k, idx in links.items():
            skill[k] = sum(use[i][3] * (100 * use[i][4] / use[i][3] + strength[use[i][0]]) for i in idx) / sum(use[i][3] for i in idx)
        num, den = defaultdict(float), defaultdict(float)
        for k, idx in links.items():
            for i in idx:
                c = use[i]
                num[c[0]] += c[3] * (skill[k] - 100 * c[4] / c[3])
                den[c[0]] += c[3]
        # hierarchical prior: competition -> class (country / intl opponent tier) -> full vs associate -> 0
        sup_n, sup_d, cls_n, cls_d = defaultdict(float), defaultdict(float), defaultdict(float), defaultdict(float)
        for comp in comp_balls:
            if den[comp]:
                k = comp_cls[comp]
                cls_n[k] += num[comp]; cls_d[k] += den[comp]
                sup_n[super_class(k)] += num[comp]; sup_d[super_class(k)] += den[comp]
        sup_mean = {k: sup_n[k] / (sup_d[k] + cp) for k in sup_d}
        cls_mean = {k: (cls_n[k] + cp * sup_mean.get(super_class(k), 0.0)) / (cls_d[k] + cp) for k in cls_d}
        new = {}
        for comp in comp_balls:
            k = comp_cls[comp]
            prior = cls_mean.get(k, sup_mean.get(super_class(k), 0.0))
            new[comp] = (num[comp] + PRIOR[fmt] * prior) / (den[comp] + PRIOR[fmt])
        centre = sum(new[comp] * b for comp, b in comp_balls.items()) / tot
        delta = max(abs(new[comp] - centre - strength[comp]) for comp in comp_balls)
        strength = defaultdict(float, {comp: v - centre for comp, v in new.items()})
        if delta < 1e-3:
            break
    # weak-tier translation
    ranked = sorted(comp_balls, key=lambda comp: strength[comp])
    acc, cut = 0.0, None
    for comp in ranked:
        acc += comp_balls[comp]
        if acc >= 0.3 * tot:
            cut = strength[comp]
            break
    weak = {comp for comp in comp_balls if strength[comp] < cut}
    # within player-year noise per ball (per-100 units): pooled variance of cell rates around the player-year mean
    sn = sd_ = 0.0
    for k, idx in by_py.items():
        if len(idx) < 2:
            continue
        vals = [(100 * use[i][4] / use[i][3] + strength[use[i][0]], use[i][3]) for i in idx]
        bsum = sum(b for _, b in vals)
        m = sum(v * b for v, b in vals) / bsum
        sn += sum(b * (v - m) ** 2 for v, b in vals); sd_ += len(vals) - 1
    sigma2 = sn / sd_ if sd_ else 0.0
    xs, ys, ws, nx = [], [], [], []
    for k, idx in by_py.items():
        wb = sum(use[i][3] for i in idx if use[i][0] in weak)
        ob = sum(use[i][3] for i in idx if use[i][0] not in weak)
        if wb >= MIN_LINK[fmt] and ob >= MIN_LINK[fmt]:
            xs.append(sum(100 * use[i][4] + use[i][3] * strength[use[i][0]] for i in idx if use[i][0] in weak) / wb)
            ys.append(sum(100 * use[i][4] + use[i][3] * strength[use[i][0]] for i in idx if use[i][0] not in weak) / ob)
            ws.append(2 * wb * ob / (wb + ob))
            nx.append(sigma2 / wb)
    if len(xs) >= 20:
        sw = sum(ws)
        mx = sum(x * w for x, w in zip(xs, ws)) / sw
        my = sum(y * w for y, w in zip(ys, ws)) / sw
        # errors-in-variables: remove the sampling noise of the weak-tier value from its variance
        sxx = sum(w * (x - mx) ** 2 for x, w in zip(xs, ws)) - sum(w * n for w, n in zip(ws, nx))
        rho = sum(w * (x - mx) * (y - my) for x, y, w in zip(xs, ys, ws)) / sxx if sxx > 0 else 1.0
        rho = min(1.0, max(0.3, rho))
        alpha = my - rho * mx
    else:
        rho, alpha = 1.0, 0.0
    model = {"strength": strength, "weak": weak, "rho": rho, "alpha": alpha, "links": len(xs), "fmt": fmt, "sigma2_within": sigma2,
             "class_mean": cls_mean, "super_mean": sup_mean, "comp_class": comp_cls}
    # pools and role offsets on translated values
    pool_n, pool_d = defaultdict(float), defaultdict(float)
    for c in use:
        a = adjusted(model, c)
        pool_n[c[0]] += c[3] * a
        pool_d[c[0]] += c[3]
    model["pool"] = {comp: pool_n[comp] / pool_d[comp] for comp in pool_d}
    off_n, off_d = defaultdict(float), defaultdict(float)
    for c in use:
        r = roles.get(c[2], "unknown")
        off_n[r] += c[3] * (adjusted(model, c) - model["pool"][c[0]])
        off_d[r] += c[3]
    model["offset"] = {r: off_n[r] / off_d[r] for r in off_d}
    # per-ball noise (per-100 units) for the uncertainty column
    model["sigma"] = math.sqrt(sum(c[3] * (adjusted(model, c) - model["pool"][c[0]]) ** 2 for c in use) / max(1, len(use)))
    return model


def adjusted(model, c):
    a = 100 * c[4] / c[3] + model["strength"].get(c[0], 0.0)
    if c[0] in model["weak"]:
        a = model["alpha"] + model["rho"] * a
    return a


def player_years(model, cells, last_year):
    """pid -> {year: [balls, balls*a, balls*pool]} for years <= last_year."""
    out = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0, 0.0]))
    gpool = 0.0
    for c in cells:
        if c[1] > last_year:
            continue
        a = adjusted(model, c)
        p = model["pool"].get(c[0], gpool)
        t = out[c[2]][c[1]]
        t[0] += c[3]
        t[1] += c[3] * a
        t[2] += c[3] * p
    return out


def rating_at(years, Y, h, K, offset):
    d = 0.5 ** (1 / h)
    B = A = P = 0.0
    for y, (b, a, p) in years.items():
        if y <= Y:
            w = d ** (Y - y)
            B += w * b; A += w * a; P += w * p
    if B == 0:
        return None, 0.0
    prior = P / B + offset
    return (A + K * prior) / (B + K), B


def season_at(years, Y, K, offset):
    if Y not in years:
        return None
    b, a, p = years[Y]
    prior = p / b + offset
    return (a + K * prior) / (b + K)


# ── age curves ──────────────────────────────────────────────────────────────────

def age_curve(pyears, fmt, meta, roles, K, offsets):
    """Delta method on shrunk season values (shrinkage removes most of the regression to the mean that raw
    season deltas carry). Centred so the ball-weighted mean change over all pairs is zero: values are relative
    to the competition-season average, so ageing is zero-sum against the league and the raw mean change is
    survivor/selection bias. Returns {role: {age: (smoothed delta, weight, pairs)}} incl. role 'all',
    plus '_centre' = the raw mean change that was removed."""
    raw = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0, 0]))
    pairs = []
    for pid, years in pyears.items():
        by = dob_year(meta, pid)
        if by is None:
            continue
        off = offsets.get(roles.get(pid, "unknown"), 0.0)
        for y, (b, a, _) in years.items():
            n = years.get(y + 1)
            if not n or b < MIN_AGE[fmt] or n[0] < MIN_AGE[fmt]:
                continue
            age = int(y + 0.5 - by)
            if age not in AGES:
                continue
            w = 2 * b * n[0] / (b + n[0])
            pairs.append((pid, age, w, season_at(years, y + 1, K, off) - season_at(years, y, K, off)))
    centre = sum(w * d for _, _, w, d in pairs) / max(1e-9, sum(w for _, _, w, _ in pairs))
    for pid, age, w, d in pairs:
        for role in ("all", roles.get(pid, "unknown")):
            t = raw[role][age]
            t[0] += w * (d - centre); t[1] += w; t[2] += 1
    kern = {-2: 1, -1: 2, 0: 3, 1: 2, 2: 1}
    out = {}
    for role in ["all"] + [r for r in raw if r != "all"]:
        sm = {}
        for age in AGES:
            num = den = 0.0
            for j, k in kern.items():
                t = raw[role].get(age + j)
                if t:
                    num += k * t[0]; den += k * t[1]
            if role != "all" and "all" in out:
                # shrink a role curve toward the all-player curve with a prior worth 4000 harmonic balls
                base = out["all"].get(age, (0.0, 0.0, 0))[0]
                num += 4000 * base; den += 4000
            sm[age] = (num / den if den else 0.0, den, raw[role].get(age, [0, 0, 0])[2])
        out[role] = sm
    out["_centre"] = centre
    return out


def curve_delta(curves, role, age):
    c = curves.get(role) if role != "_centre" else None
    c = c or curves.get("all") or {}
    if age is None:
        return 0.0
    age = min(max(int(age), AGES.start), AGES.stop - 1)
    return c.get(age, (0.0, 0.0, 0))[0]


# ── validation fold ─────────────────────────────────────────────────────────────

def fold(cells, fmt, cutoff, roles, meta, grid=True, params=None, curves=None):
    """Fit through `cutoff`, predict the mean adjusted value over cutoff+1..cutoff+2."""
    model = fit(cells, fmt, cutoff, roles)
    py = player_years(model, cells, cutoff + 2)
    targets = {}
    for pid, years in py.items():
        b = sum(years[y][0] for y in (cutoff + 1, cutoff + 2) if y in years)
        if b >= MIN_TARGET[fmt] and any(y <= cutoff for y in years):
            targets[pid] = (sum(years[y][1] for y in (cutoff + 1, cutoff + 2) if y in years) / b, b)
    hist = {pid: {y: v for y, v in years.items() if y <= cutoff} for pid, years in py.items() if pid in targets}
    res = {}
    combos = [(h, K, beta) for h in H_GRID for K in K_GRID[fmt] for beta in BETA_GRID] if grid else [params]
    curve_by_k = {}
    for h, K, beta in combos:
        if K not in curve_by_k:
            curve_by_k[K] = age_curve(hist, fmt, meta, roles, K, model["offset"])
        curves = curve_by_k[K]
        xs, ys, ws = [], [], []
        for pid, (t, b) in targets.items():
            off = model["offset"].get(roles.get(pid, "unknown"), 0.0)
            r, _ = rating_at(hist[pid], cutoff, h, K, off)
            if r is None:
                continue
            r0, _ = rating_at(hist[pid], cutoff - 1, h, K, off)
            trend = (r - r0) if r0 is not None else 0.0
            by = dob_year(meta, pid)
            age = (cutoff + 0.5 - by) if by else None
            dage = curve_delta(curves, roles.get(pid, "unknown"), age) + 0.5 * curve_delta(curves, roles.get(pid, "unknown"), age + 1 if age else None)
            xs.append(r + beta * trend + dage); ys.append(t); ws.append(b)
        res[(h, K, beta)] = (wmse(xs, ys, ws), wcorr(xs, ys, ws), len(xs))
    return model, py, targets, hist, curves, res


def evaluate(cells, fmt, cutoff, roles, meta, params, current=None):
    """Held-out comparison table at `cutoff` with tuned params."""
    h, K, beta = params
    model, py, targets, hist, curves, _ = fold(cells, fmt, cutoff, roles, meta, grid=False, params=params)
    # raw (unadjusted) values for naive baselines
    raw = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))
    for c in cells:
        if c[1] <= cutoff:
            raw[c[2]][c[1]][0] += c[3]; raw[c[2]][c[1]][1] += 100 * c[4]
    preds = defaultdict(dict)
    for pid, (t, b) in targets.items():
        off = model["offset"].get(roles.get(pid, "unknown"), 0.0)
        r, _ = rating_at(hist[pid], cutoff, h, K, off)
        if r is None:
            continue
        r0, _ = rating_at(hist[pid], cutoff - 1, h, K, off)
        by = dob_year(meta, pid)
        age = (cutoff + 0.5 - by) if by else None
        role = roles.get(pid, "unknown")
        dage = curve_delta(curves, role, age) + 0.5 * curve_delta(curves, role, age + 1 if age else None)
        preds["new: rating only"][pid] = r
        preds["new: + age curve"][pid] = r + dage
        preds["new: + age curve + trend (final)"][pid] = r + dage + beta * ((r - r0) if r0 is not None else 0.0)
        cb = sum(v[0] for v in raw[pid].values())
        if cb:
            preds["naive: career raw value to cutoff"][pid] = sum(v[1] for v in raw[pid].values()) / cb
        if raw[pid].get(cutoff, [0, 0])[0] >= MIN_AGE[fmt]:
            preds["naive: last season raw value"][pid] = raw[pid][cutoff][1] / raw[pid][cutoff][0]
            preds["new (final), same players as last-season baseline"][pid] = preds["new: + age curve + trend (final)"][pid]
        if current and pid in current:
            preds["current Cricsheet model (T20 only)"][pid] = current[pid]
            preds["new (final), same players as current model"][pid] = preds["new: + age curve + trend (final)"][pid]
    table = []
    for name, p in preds.items():
        ids = [pid for pid in p if pid in targets]
        xs = [p[i] for i in ids]; ys = [targets[i][0] for i in ids]; ws = [targets[i][1] for i in ids]
        cur = name.startswith("current")
        table.append({"predictor": name, "players": len(ids), "corr": round(wcorr(xs, ys, ws), 3),
                      "mse": None if cur else round(wmse(xs, ys, ws), 1)})
    return table, model, curves


# ── main ────────────────────────────────────────────────────────────────────────

def main():
    log("loading")
    groups, meta, people = load()
    log(f"{sum(map(len, groups.values()))} cells, {len(meta)} players with profiles")
    # roles: batting = position bucket (career, all formats), bowling = pace/spin from profile style
    pos = defaultdict(lambda: [0.0, 0.0])
    for (side, fmt, g), cells in groups.items():
        if side == "bat":
            for c in cells:
                if c[5] is not None:
                    pos[c[2]][0] += c[3] * c[5]; pos[c[2]][1] += c[3]
    bat_role = {pid: ("top" if v[0] / v[1] <= 3.5 else "middle" if v[0] / v[1] <= 7.0 else "lower") for pid, v in pos.items() if v[1]}
    bowl_role = {pid: bowl_type((m or {}).get("bowling_style")) for pid, m in meta.items()}
    # current Cricsheet model at 2024-01-01 for the T20 baseline
    current = {}
    cur_path = DATA / "player_ratings_by_season.parquet"
    if cur_path.exists():
        for r in duck(f"SELECT cricketarchive_id, gender, bat_value_proj, bowl_value_proj FROM '{cur_path}' WHERE snapshot = '2024' AND cricketarchive_id IS NOT NULL"):
            for side, col in (("bat", "bat_value_proj"), ("bowl", "bowl_value_proj")):
                if r[col]:
                    current[(side, r["gender"], int(r["cricketarchive_id"]))] = float(r[col])

    validation, tuned, all_curves, rows, strengths = {}, {}, [], {}, []
    for key in sorted(groups):
        side, fmt, gender = key
        cells = groups[key]
        roles = bat_role if side == "bat" else bowl_role
        log(f"{key}: tuning on fold 2020 -> 2021-22 ({len(cells)} cells)")
        _, _, _, _, _, res = fold(cells, fmt, 2020, roles, meta)
        best = min(res, key=lambda k: res[k][0])
        tuned[key] = best
        cur = {pid: v for (s, g, pid), v in current.items() if s == side and g == gender} if fmt == "T20" else None
        log(f"{key}: best h={best[0]} K={best[1]} beta={best[2]}; held-out 2023 -> 2024-25")
        table, vmodel, _ = evaluate(cells, fmt, 2023, roles, meta, best, cur)
        validation["/".join(key)] = {"params": {"half_life": best[0], "K": best[1], "trend_beta": best[2]},
                                     "tuning_fold_mse_corr_n": res[best], "held_out": table,
                                     "translation": {"rho": round(vmodel["rho"], 3), "alpha": round(vmodel["alpha"], 2), "links": vmodel["links"]}}
        # final fit on everything for the output table
        model = fit(cells, fmt, LAST_YEAR, roles)
        py = player_years(model, cells, LAST_YEAR)
        cb = defaultdict(float)
        for c in cells:
            cb[c[0]] += c[3]
        for comp, b in cb.items():
            strengths.append({"side": side, "format": fmt, "gender": gender, "comp": comp,
                              "comp_class": model["comp_class"].get(comp, ""), "balls": round(b),
                              "strength": round(model["strength"].get(comp, 0.0), 2),
                              "weak_tier": comp in model["weak"], "pool": round(model["pool"].get(comp, 0.0), 2)})
        curves = age_curve(py, fmt, meta, roles, best[1], model["offset"])
        validation["/".join(key)]["raw_mean_change_removed"] = round(curves["_centre"], 3)
        for role, sm in curves.items():
            if role == "_centre":
                continue
            cum, peak, best_c = 0.0, None, -1e9
            for age in AGES:
                d, w, n = sm[age]
                all_curves.append({"gender": gender, "format": fmt, "side": side, "role": role, "age": age,
                                   "delta": round(d, 3), "cumulative": round(cum, 3), "weight": round(w), "pairs": n})
                if w > 20000 and cum > best_c:
                    best_c, peak = cum, age
                cum += d
            validation["/".join(key)].setdefault("peak_age", {})[role] = peak
        h, K, beta = best
        for pid, years in py.items():
            off = model["offset"].get(roles.get(pid, "unknown"), 0.0)
            by = dob_year(meta, pid)
            prev = None
            for Y in sorted(years):
                r, B = rating_at(years, Y, h, K, off)
                s = season_at(years, Y, K, off)
                age = (Y + 0.5 - by) if by else None
                proj = r + curve_delta(curves, roles.get(pid, "unknown"), age) + beta * ((r - prev) if prev is not None else 0.0)
                prev = r
                row = rows.setdefault((pid, fmt, gender, Y), {})
                row[side] = (years[Y][0], s, r, model["sigma"] / math.sqrt(B + K), proj)
        log(f"{key}: done")

    # 0-99 scale vs regulars, per side x format x gender x year
    scale = defaultdict(list)
    for (pid, fmt, gender, Y), sides in rows.items():
        for side, (b, s, r, sd, proj) in sides.items():
            if b >= REG[fmt]:
                scale[(side, fmt, gender, Y)].append(r)
    stats = {}
    for k, v in scale.items():
        if len(v) >= 10:
            m = sum(v) / len(v)
            stats[k] = (m, math.sqrt(sum((x - m) ** 2 for x in v) / (len(v) - 1)) or 1.0)

    def ovr(side, fmt, gender, Y, x):
        st = stats.get((side, fmt, gender, Y))
        if not st:
            # fall back to the nearest year with a scale
            for dy in range(1, 6):
                st = stats.get((side, fmt, gender, Y - dy)) or stats.get((side, fmt, gender, Y + dy))
                if st:
                    break
        if not st or x is None:
            return None
        return int(round(min(99, max(25, 65 + 11 * (x - st[0]) / st[1]))))

    out_csv = WORK / "ca_ratings_by_year.csv"
    cols = ["player_id", "cricsheet_id", "cricinfo_id", "name", "full_name", "gender", "dob", "age", "year", "format",
            "batting_role", "bowling_type", "bowling_style",
            "bat_balls", "bat_season", "bat_rating", "bat_sd", "bat_proj_next", "bat_ovr", "bat_ovr_proj_next",
            "bowl_balls", "bowl_season", "bowl_rating", "bowl_sd", "bowl_proj_next", "bowl_ovr", "bowl_ovr_proj_next"]
    with open(out_csv, "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(cols)
        for (pid, fmt, gender, Y), sides in sorted(rows.items()):
            m = meta.get(pid) or {}
            by = dob_year(meta, pid)
            cs = people.get(pid, ("", ""))
            line = [pid, cs[0], cs[1], m.get("name", ""), m.get("full_name", ""), gender, m.get("dob", ""),
                    round(Y + 0.5 - by, 1) if by else "", Y, fmt, bat_role.get(pid, ""), bowl_role.get(pid, ""), m.get("bowling_style", "")]
            for side in ("bat", "bowl"):
                if side in sides:
                    b, s, r, sd, proj = sides[side]
                    line += [round(b), round(s, 2) if s is not None else "", round(r, 2), round(sd, 2), round(proj, 2),
                             ovr(side, fmt, gender, Y, r), ovr(side, fmt, gender, Y, proj)]
                else:
                    line += [0, "", "", "", "", "", ""]
            wr.writerow(line)
    subprocess.run(["duckdb", "-c", f"COPY (SELECT * FROM read_csv('{out_csv}', header=true, auto_detect=true, sample_size=-1, types={{'dob': 'VARCHAR', 'cricsheet_id': 'VARCHAR', 'full_name': 'VARCHAR', 'bowling_style': 'VARCHAR'}})) TO 'data/analysis/ca_ratings_by_year.parquet' (FORMAT parquet)"], check=True, cwd=ROOT)
    with open(DATA / "ca_age_curves.csv", "w", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=list(all_curves[0]))
        wr.writeheader(); wr.writerows(all_curves)
    with open(DATA / "ca_comp_strength.csv", "w", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=list(strengths[0]))
        wr.writeheader(); wr.writerows(sorted(strengths, key=lambda r: (r["side"], r["format"], r["gender"], -r["strength"])))
    with open(DATA / "ca_validation.json", "w") as f:
        json.dump(validation, f, indent=1, default=str)
    log(f"wrote {len(rows)} player-format-years")


if __name__ == "__main__":
    main()
