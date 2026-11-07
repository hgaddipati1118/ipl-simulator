"""
How fielding and keeping change with age: the age curves for Player.progress(), fitted on per-player-season values
from the Cricsheet fielding innings (data/analysis/fielding_player_innings.parquet, keeping_innings.parquet; built by
fielding-stats.sql, rated by fielding-ratings.py) and the player birth dates of ca_ratings_by_year.parquet.

Writes (new files only, nothing existing is touched):
    packages/engine/src/fielding-progression-model.ts                        the parameters, generated
    packages/engine/src/__tests__/fixtures/fielding-progression-cohort.json  real multi-season changes, for the engine validation
    data/analysis/fielding_progression.json, fielding_player_seasons.csv     fit details and the per-player-season values
    data/analysis/fielding-progression-report.md

Method (per gender; the shape of progression.py, adapted to count data):

 1. Per-player-season values.  For every player and calendar year the fielding / keeping evidence is aggregated as
    fielding-ratings.py does (catches against the teammates' catches in the same innings, run-outs, stumpings, keeper
    catches and byes against what the bowlers would give) and turned into a 0-99 rating with the same Gamma-Poisson
    shrinkage (fitted k) and scale (14 points per SD of true skill).  Written to fielding_player_seasons.csv.
 2. Delta method, consecutive seasons.  A pair is a player with 10+ fielding innings (keepers: 8+ keeper innings) in
    both year t and year t+1.  Next season's expected count given last season's observed ratio is
    E(t+1) * O(t) / E(t); the age effect of a bin is log( sum O(t+1) / sum [E(t+1) O(t) / E(t)] ) per component,
    combined with the rating's weights and converted to rating points (scale / prior SD).  Using last season's
    UNSHRUNK ratio keeps it unbiased: the shrunk season ratings are pulled toward 50 and so understate every change by
    their reliability (shown in the report as a diagnostic).  Standard errors by bootstrap over players.
 3. Smoothing and shrinkage.  Bin effects are noisy, so the curve is a two-segment line (a peak age, a slope before
    and a slope after, chosen by weighted least squares on the bins with 40+ pairs); women's curve is pulled toward
    the men's in proportion to its precision.  Exported as a handful of nodes, linear between them.
 4. Spread.  A season's persistent change has the sd of the random-walk part of the pair variances: variance of the
    t -> t+2 changes minus that of t -> t+1 changes, Poisson noise removed.  Transient luck does not accumulate; real
    change does.  It is noisy, so it is blended with an upper bound (the whole lag-1 variance, halved) and clamped.
 5. Level reversion.  Chosen from stationarity, not fitted: innovations of sd s and a true spread of V = 14^2 rating
    points are only compatible if a fraction s^2 / (2 V) of the distance to 50 is given back each season.

Run from packages/ratings:  duckdb < src/analysis/fielding-stats.sql && python3 -I src/analysis/fielding-ratings.py &&
                            python3 -I src/analysis/fielding-progression.py
"""
import csv, json, math, random, subprocess, sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
ENGINE = ROOT.parent / "engine"
OUT_TS = ENGINE / "src" / "fielding-progression-model.ts"
OUT_FIXTURE = ENGINE / "src" / "__tests__" / "fixtures" / "fielding-progression-cohort.json"
OUT_JSON = DATA / "fielding_progression.json"
OUT_CSV = DATA / "fielding_player_seasons.csv"
OUT_REPORT = DATA / "fielding-progression-report.md"

SCALE = 14.0
RO_WEIGHT = 0.4
KEEP_WEIGHTS = {"st": 0.40, "kc": 0.25, "bye": -0.35}
MIN_BALLS, MIN_PLAYERS, MAX_PLAYERS = 60, 9, 12
OTHERS, OTHERS_RO = 9.0, 10.0
ROLE_KEEP = 0.5
MIN_FIELD_INNS = 10
MIN_KEEP_INNS = 8
AGE_BINS = [(0, 22), (23, 24), (25, 26), (27, 28), (29, 30), (31, 32), (33, 34), (35, 36), (37, 38), (39, 99)]
BOOT = 80
SD_FLOOR = 1.5               # sd of a season's persistent change is floored here (see the report: the data find little beyond the age curve)
NODES = [20, 24, 28, 31, 34, 37, 40]       # nodes of the exported curves (age after the coming birthday)
SEED = 20260506
GROUPS = [("<=25", 0, 25), ("26-29", 26, 29), ("30-33", 30, 33), ("34+", 34, 99)]   # start-age groups for the validation fixture


def duck(sql):
    out = subprocess.run(["duckdb", "-csv", "-nullvalue", "", "-c", sql], capture_output=True, text=True, cwd=ROOT)
    if out.returncode:
        sys.exit(out.stderr)
    return list(csv.DictReader(out.stdout.splitlines()))


def num(x):
    return float(x) if x not in ("", None) else 0.0


def bin_of(a):
    for i, (lo, hi) in enumerate(AGE_BINS):
        if lo <= a <= hi:
            return i
    return len(AGE_BINS) - 1


# ------------------------------------------------------------------------------------------------ data
VAL = json.load(open(DATA / "fielding_validation.json"))
COND = f"keeper_source = 'ca' AND balls >= {MIN_BALLS} AND team_players BETWEEN {MIN_PLAYERS} AND {MAX_PLAYERS}"
DOB = """(SELECT cricsheet_id AS pid, gender, min(dob) AS dob FROM 'data/analysis/ca_ratings_by_year.parquet'
          WHERE dob IS NOT NULL AND cricsheet_id IS NOT NULL GROUP BY ALL)"""


def age_in_season(dob, year):
    """Age during the calendar year's season (mid-year)."""
    parts = dob.split("-")
    y = int(parts[0])
    m = int(parts[1]) if len(parts) > 1 else 6
    d = int(parts[2]) if len(parts) > 2 else 15
    return round((year + 0.5) - (y + (m - 1) / 12.0 + d / 365.0))


def load_fielding():
    catch = duck(f"""
        SELECT f.pid, f.gender, f.year, d.dob, count(*) AS inns, sum(catches_all) AS o,
               sum((team_nk_catches - cx - catches_all) / {OTHERS}) AS e, sum(balls_bowled) * 1.0 / count(*) AS bpi
        FROM 'data/analysis/fielding_player_innings.parquet' f JOIN {DOB} d ON d.pid = f.pid AND d.gender = f.gender
        WHERE {COND} AND NOT is_keeper GROUP BY ALL""")
    ro = duck(f"""
        SELECT f.pid, f.gender, f.year, is_keeper, count(*) AS inns, sum(ro) AS o, sum((team_ro - ro) / {OTHERS_RO}) AS e
        FROM 'data/analysis/fielding_player_innings.parquet' f
        WHERE {COND} GROUP BY ALL""")
    rows = {}
    for r in catch:
        key = (r["pid"], r["gender"], int(r["year"]))
        bpi = num(r["bpi"])
        cls = "bowler" if bpi >= 15 else ("part" if bpi >= 3 else "non")
        R = VAL[r["gender"]]["catching"]["class_ratio"][cls]
        rows[key] = dict(inns=int(r["inns"]), c_o=num(r["o"]), c_e=num(r["e"]) * R, cls=cls, r_o=0.0, r_e=0.0,
                         age=age_in_season(r["dob"], int(r["year"])))
    for r in ro:
        key = (r["pid"], r["gender"], int(r["year"]))
        if key not in rows:
            continue
        R = VAL[r["gender"]]["runouts"][r["is_keeper"]]["R"]
        rows[key]["r_o"] += num(r["o"])
        rows[key]["r_e"] += num(r["e"]) * R
    return rows


def load_keeping():
    krows = duck(f"""
        SELECT k.keeper_id AS pid, k.gender, k.year, d.dob, count(*) AS inns, sum(st) AS st, sum(exp_st_ev) AS est, sum(kc) AS kc,
               sum(exp_kc_ev) AS ekc, sum(bye_ev) AS b, sum(exp_bye_ev) AS eb
        FROM 'data/analysis/keeping_innings.parquet' k JOIN {DOB} d ON d.pid = k.keeper_id AND d.gender = k.gender
        WHERE source = 'ca' AND balls >= {MIN_BALLS} GROUP BY ALL""")
    rows = {}
    for r in krows:
        g = r["gender"]
        K = VAL[g]["keeping"]
        rows[(r["pid"], g, int(r["year"]))] = dict(
            inns=int(r["inns"]), age=age_in_season(r["dob"], int(r["year"])),
            st_o=num(r["st"]), st_e=num(r["est"]) * K["st"]["R"], kc_o=num(r["kc"]), kc_e=num(r["ekc"]) * K["kc"]["R"],
            b_o=num(r["b"]), b_e=num(r["eb"]) * K["bye"]["R"])
    return rows


# ------------------------------------------------------------------------------------------------ season values
def post(o, e, k):
    return (o + k) / (e + k)


def season_fielding_z(d, g):
    V = VAL[g]
    cr = V["catching"]["class_ratio"]
    lc = math.log(post(d["c_o"], d["c_e"], V["catching"]["k"]))
    off = ROLE_KEEP * math.log(cr[d["cls"]] / (sum(cr.values()) / 3.0))
    lr = math.log(post(d["r_o"], d["r_e"], V["runouts"]["false"]["k"])) if d["r_e"] > 0 else 0.0
    return (lc + off + RO_WEIGHT * lr) / V["fielding_prior_sd"]


def season_keeping_z(d, g):
    K = VAL[g]["keeping"]
    s = 0.0
    for comp, w in KEEP_WEIGHTS.items():
        key = "b" if comp == "bye" else comp
        s += w * math.log(post(d[key + "_o"], d[key + "_e"], K[comp]["k"]))
    return s / K["prior_sd"]
# ------------------------------------------------------------------------------------------------ fixed-effects Poisson
# Why not simply compare each player's season with the next?  Last season's ratio O/E is noisy and, because E is built
# from the teammates' catches in the same innings (so it falls when he takes more), its mean is biased upward; a naive
# "next season over this season" ratio then shows a decline at every age.  The player fixed-effects Poisson model avoids
# it: O(i,t) ~ Poisson(E(i,t) * exp(alpha_i + g(age))), alpha_i the player's own level (its sufficient statistic is his
# total, so thin and lucky seasons do no harm), g the age profile.  g(a) - g(a-1) is the expected change into age a.
def fe_poisson(obs, n_iter=40):
    """obs: list of (player index, bin, O, E) for one component. Returns g per bin (log-ratio, reference = bin 3)."""
    nb = len(AGE_BINS)
    tot_o = defaultdict(float)
    for i, b, o, e in obs:
        tot_o[i] += o
    obs = [x for x in obs if tot_o[x[0]] > 0 and x[3] > 0]
    g = [0.0] * nb
    by_b_o = [0.0] * nb
    for i, b, o, e in obs:
        by_b_o[b] += o
    alpha = {}
    for _ in range(n_iter):
        den = defaultdict(float)
        for i, b, o, e in obs:
            den[i] += e * math.exp(g[b])
        alpha = {i: math.log(tot_o[i] / den[i]) for i in den}
        for b in range(nb):
            d = sum(e * math.exp(alpha[i]) for i, bb, o, e in obs if bb == b)
            g[b] = math.log(by_b_o[b] / d) if d > 0 and by_b_o[b] > 0 else g[b]
    ref = g[3]
    return [x - ref for x in g], alpha, obs


def component_obs(rows, g, o_key, e_key, min_inns):
    sub = [(k, d) for k, d in rows.items() if k[1] == g and d["inns"] >= min_inns and d[e_key] > 0]
    n_seasons = defaultdict(int)
    for k, d in sub:
        n_seasons[k[0]] += 1
    idx = {}
    obs = []
    for k, d in sub:
        if n_seasons[k[0]] < 2:
            continue
        i = idx.setdefault(k[0], len(idx))
        obs.append((i, bin_of(d["age"]), d[o_key], d[e_key], k))
    return obs


def age_profile(rows, g, comps, sd, min_inns, rng=None, boot=False):
    """Combined rating-point age profile (level by bin) of a weighted sum of components; optional player bootstrap."""
    cobs = {(o_key, e_key): component_obs(rows, g, o_key, e_key, min_inns) for (o_key, e_key, _w) in comps}

    def run(player_weights=None):
        prof = [0.0] * len(AGE_BINS)
        for (o_key, e_key, w) in comps:
            ob = cobs[(o_key, e_key)]
            if player_weights is None:
                ob_ = [(i, b, o, e) for i, b, o, e, k in ob]
            else:
                # a drawn copy of a player is a new player (the bootstrap resamples whole careers)
                per = defaultdict(list)
                for i, b, o, e, k in ob:
                    per[k[0]].append((b, o, e))
                ob_ = []
                nxt = 0
                for pid, lst in per.items():
                    for _c in range(player_weights.get(pid, 0)):
                        ob_ += [(nxt, b, o, e) for b, o, e in lst]
                        nxt += 1
            gg, _, _ = fe_poisson(ob_, n_iter=60 if player_weights is None else 25)
            for b in range(len(AGE_BINS)):
                prof[b] += w * gg[b]
        return [SCALE * v / sd for v in prof]

    base = run()
    if not boot:
        return base, None
    pids = sorted({k[0] for ob in cobs.values() for (_, _, _, _, k) in ob})
    sims = []
    for _ in range(BOOT):
        wts = defaultdict(int)
        for _i in range(len(pids)):
            wts[pids[rng.randrange(len(pids))]] += 1
        sims.append(run(wts))
    return base, sims


def level_hinge(ages, y, w):
    """g(a) = level + pre * min(0, a - P) + post * max(0, a - P); grid over the peak age P; weighted least squares"""
    best = None
    for P in [x / 2.0 for x in range(44, 70)]:
        X = [[1.0, min(0.0, a - P), max(0.0, a - P)] for a in ages]
        A = [[sum(w[n] * X[n][i] * X[n][j] for n in range(len(y))) + (1e-9 if i == j else 0) for j in range(3)] for i in range(3)]
        bb = [sum(w[n] * X[n][i] * y[n] for n in range(len(y))) for i in range(3)]
        beta = solve(A, bb)
        sse = sum(w[n] * (y[n] - sum(beta[i] * X[n][i] for i in range(3))) ** 2 for n in range(len(y)))
        if best is None or sse < best[0]:
            best = (sse, P, beta)
    return best


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
                for c in range(i, k + 1):
                    M[r][c] -= m * M[i][c]
    return [M[i][k] / (M[i][i] if abs(M[i][i]) > 1e-12 else 1e-12) for i in range(k)]


def bin_ages(rows, g, comps, min_inns):
    out = []
    ages = defaultdict(list)
    for (pid, gg, y), d in rows.items():
        if gg == g and d["inns"] >= min_inns:
            ages[bin_of(d["age"])].append(d["age"])
    return [sum(ages[b]) / len(ages[b]) if ages[b] else None for b in range(len(AGE_BINS))], [len(ages[b]) for b in range(len(AGE_BINS))]


def fit_hinge_profile(ages, prof, se, counts, min_count=40):
    pts = [(ages[b], prof[b], max(se[b], 0.5)) for b in range(len(AGE_BINS)) if ages[b] is not None and counts[b] >= min_count and se[b] is not None]
    sse, P, beta = level_hinge([p[0] for p in pts], [p[1] for p in pts], [1.0 / p[2] ** 2 for p in pts])
    return dict(P=P, level=beta[0], pre=beta[1], post=beta[2])


def curve_effect(c, age_next):
    """Expected change into age `age_next`: the slope of the level curve over the year before it"""
    a_lo, a_hi = age_next - 1, age_next
    lv = lambda a: c["level"] + c["pre"] * min(0.0, a - c["P"]) + c["post"] * max(0.0, a - c["P"])
    return lv(a_hi) - lv(a_lo)


# ------------------------------------------------------------------------------------------------ spread
def deviations(rows, g, comps, sd, min_inns, profile_by_bin):
    """Per player-season deviation (rating points) from the player's own level and the age profile, and its Poisson variance"""
    # components' fitted alpha need the FE solution: refit once per component to get alpha and use g from profile
    out = defaultdict(dict)       # player -> year -> [dev, noise var]
    for (o_key, e_key, w) in comps:
        ob = component_obs(rows, g, o_key, e_key, min_inns)
        gg, alpha, obs_ = fe_poisson([(i, b, o, e) for i, b, o, e, k in ob])
        keep = {(i, b, o, e): k for i, b, o, e, k in ob}
        for i, b, o, e in obs_:
            k = keep[(i, b, o, e)]
            mu = e * math.exp(alpha[i] + gg[b])
            if mu < 3.0:
                continue
            c = SCALE * w / sd
            dev = c * (o - mu) / mu
            nv = c * c / mu
            cur = out[k[0]].setdefault(k[2], [0.0, 0.0])
            cur[0] += dev
            cur[1] += nv
    return out


def innovation_sd(dev):
    """
    Persistent change from the autocovariance of the deviations.  Removing a player's own mean makes deviations from
    pure luck negatively correlated (cov = -s2 / T for T seasons), so that is subtracted; what is left over, if
    positive, is skill that moves from one season to the next (noise cancels across seasons).
    Returns (variance of a deviation, excess cov at lag 1, excess cov at lag 2, pair counts)
    """
    v_sum = v_n = 0.0
    c = {1: [0.0, 0.0], 2: [0.0, 0.0]}
    for pid, ys in dev.items():
        T = len(ys)
        if T < 3:
            continue
        # luck variance of this player's seasons, from the variance of his deviations net of Poisson noise
        var_i = sum(d * d - nv for d, nv in ys.values()) / T
        s2 = max(var_i, 0.0) / (1 - 1.0 / T)
        v_sum += s2; v_n += 1
        for y, (d0, _) in ys.items():
            for lag in (1, 2):
                if y + lag in ys:
                    c[lag][0] += d0 * ys[y + lag][0] + s2 / T      # observed minus the -s2/T that luck alone gives
                    c[lag][1] += 1
    v0 = v_sum / v_n if v_n else 0.0
    return v0, (c[1][0] / c[1][1] if c[1][1] else 0.0), (c[2][0] / c[2][1] if c[2][1] else 0.0), c[1][1], c[2][1]


# ------------------------------------------------------------------------------------------------ fit one quantity
def fit_quantity(name, rows, comps, sd_for, min_inns, rng, tau, prior=None):
    res = {}
    for g in ("male", "female"):
        sd = sd_for(g)
        base, sims = age_profile(rows, g, comps, sd, min_inns, rng=rng, boot=True)
        ages, counts = bin_ages(rows, g, comps, min_inns)
        se = []
        for b in range(len(AGE_BINS)):
            v = [s[b] for s in sims]
            m = sum(v) / len(v)
            se.append(math.sqrt(sum((a - m) ** 2 for a in v) / (len(v) - 1)))
        c = fit_hinge_profile(ages, base, se, counts)
        # bootstrap the slopes of the hinge fit for their standard errors (the peak age is refitted each time)
        cs = []
        for s in sims[:80]:
            try:
                cs.append(fit_hinge_profile(ages, s, se, counts))
            except Exception:
                pass
        sd_pre = math.sqrt(sum((x["pre"] - sum(y["pre"] for y in cs) / len(cs)) ** 2 for x in cs) / (len(cs) - 1))
        sd_post = math.sqrt(sum((x["post"] - sum(y["post"] for y in cs) / len(cs)) ** 2 for x in cs) / (len(cs) - 1))
        res[g] = dict(base=base, se=se, ages=ages, counts=counts, curve=c, se_pre=max(sd_pre, 0.15 if name == "fielding" else 1.5), se_post=max(sd_post, 0.15 if name == "fielding" else 1.5), sims=sims)
    # empirical-Bayes shrinkage of the slopes toward 0 (prior sd tau points per year), women toward the men's
    for g in ("male", "female"):
        r = res[g]
        c = dict(r["curve"])
        for key, se_key in (("pre", "se_pre"), ("post", "se_post")):
            r[key + "_raw"] = c[key]
            p0 = prior[g][key] if prior else 0.0
            c[key] = p0 + (c[key] - p0) * tau ** 2 / (tau ** 2 + r[se_key] ** 2)
        r["shrunk"] = c
    m, w = res["male"]["shrunk"], res["female"]["shrunk"]
    for key, se_key in (("pre", "se_pre"), ("post", "se_post")):
        # women: precision-weighted between their own slope and the men's (whose slope has se of its own)
        pw = 1.0 / res["female"][se_key] ** 2
        pm = 1.0 / (res["male"][se_key] ** 2 + 0.5)       # the men's value as a prior: its own error plus an allowance for real differences
        w[key] = (pw * w[key] + pm * m[key]) / (pw + pm)
    w["P"] = 0.5 * (w["P"] + m["P"])
    # spread
    for g in ("male", "female"):
        sd = sd_for(g)
        dev = deviations(rows, g, comps, sd, min_inns, None)
        v0, c1, c2, n1, n2 = innovation_sd(dev)
        res[g].update(v0=v0, c1=c1, c2=c2, n1=n1, n2=n2)
    return res


def sim_changes(curve, sd, phi, start, k, n=4000, seed=1):
    """Mean k-season change of the model from `start` age (no level effect), for the validation notes"""
    return sum(curve_effect(curve, start + j + 1) for j in range(k))


def real_changes(res, k_list=(1, 3, 5)):
    """Real change in the age profile between start-age groups, from the bin profile: g(start + k) - g(start)"""
    ages, base = res["ages"], res["base"]
    pts = [(a, v) for a, v in zip(ages, base) if a is not None]
    def at(a):
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        if a <= xs[0]:
            return ys[0]
        if a >= xs[-1]:
            return ys[-1]
        for i in range(1, len(xs)):
            if a <= xs[i]:
                t = (a - xs[i - 1]) / (xs[i] - xs[i - 1])
                return ys[i - 1] + (ys[i] - ys[i - 1]) * t
    return {str(k): [dict(group=label, start=(lo + min(hi, 40)) / 2.0 if lo > 0 else 23.0) for label, lo, hi in GROUPS] for k in k_list}, at


def holdout(name, rows, comps, sd_for, min_inns):
    """Fit the curve on half of the players (by id hash), compare with the age profile of the other half"""
    out = {}
    for g in ("male", "female"):
        sd = sd_for(g)
        half = lambda keep: {k: d for k, d in rows.items() if (sum(map(ord, k[0])) % 2 == keep)}
        pa, _ = age_profile(half(0), g, comps, sd, min_inns)
        pb, _ = age_profile(half(1), g, comps, sd, min_inns)
        ages_a, cnt_a = bin_ages(half(0), g, comps, min_inns)
        ages_b, cnt_b = bin_ages(half(1), g, comps, min_inns)
        se = [3.0] * len(AGE_BINS)
        c = fit_hinge_profile(ages_a, pa, se, cnt_a, min_count=20)
        lv = lambda a: c["level"] + c["pre"] * min(0.0, a - c["P"]) + c["post"] * max(0.0, a - c["P"])
        ref = lv(ages_a[3])
        num_m = num_f = den = 0.0
        for b in range(len(AGE_BINS)):
            if ages_b[b] is None or cnt_b[b] < 20:
                continue
            pred = lv(ages_b[b]) - ref
            num_m += cnt_b[b] * (pb[b] - pred) ** 2
            num_f += cnt_b[b] * pb[b] ** 2
            den += cnt_b[b]
        if den == 0:
            continue
        out[g] = dict(rms_model=math.sqrt(num_m / den), rms_flat=math.sqrt(num_f / den), slope_post_a=c["post"], P=c["P"])
    return out


def main():
    rng = random.Random(SEED)
    frows = load_fielding()
    krows = load_keeping()
    print("player-seasons: fielding", len(frows), "keeping", len(krows))

    with open(OUT_CSV, "w", newline="") as fh:
        wr = csv.writer(fh)
        wr.writerow(["cricsheet_id", "gender", "year", "age", "field_inns", "fielding", "keep_inns", "keeping"])
        for key in sorted(set(frows) | set(krows), key=lambda k: (k[1], k[0], k[2])):
            pid, g, y = key
            fd, kd = frows.get(key), krows.get(key)
            wr.writerow([pid, g, y, (fd or kd)["age"], fd["inns"] if fd else 0,
                         max(15, min(99, round(50 + SCALE * season_fielding_z(fd, g)))) if fd else "",
                         kd["inns"] if kd else 0, max(15, min(99, round(50 + SCALE * season_keeping_z(kd, g)))) if kd else ""])

    fld_comps = [("c_o", "c_e", 1.0), ("r_o", "r_e", RO_WEIGHT)]
    kp_comps = [("st_o", "st_e", KEEP_WEIGHTS["st"]), ("kc_o", "kc_e", KEEP_WEIGHTS["kc"]), ("b_o", "b_e", KEEP_WEIGHTS["bye"])]
    quantities = {
        "fielding": (frows, fld_comps, lambda g: VAL[g]["fielding_prior_sd"], MIN_FIELD_INNS, 1.0),
        "keeping": (krows, kp_comps, lambda g: VAL[g]["keeping"]["prior_sd"], MIN_KEEP_INNS, 0.8),
    }
    L = ["# Fielding and keeping: age curves", "",
         "Generated by `src/analysis/fielding-progression.py`. Method: the script header and `docs/RATINGS-PIPELINE.md` (Fielding and keeping progression). "
         "`level` is the age profile in rating points relative to age 27-28 (player fixed-effects Poisson); the expected change into an age is its slope.", ""]
    model, report, fixture = {}, {}, {}
    for name, (rows, comps, sd_for, min_inns, tau) in quantities.items():
        prior = None
        if name == "keeping":      # the data cannot see keeping age at all (s.e. 4+ points a year): lean on the fielding decline, halved
            prior = {g: {"pre": 0.5 * model_f[g]["pre"], "post": 0.5 * model_f[g]["post"]} for g in ("male", "female")}
        res = fit_quantity(name, rows, comps, sd_for, min_inns, rng, tau, prior)
        if name == "fielding":
            model_f = {g: res[g]["shrunk"] for g in ("male", "female")}
        model[name], report[name], fixture[name] = {}, {}, {}
        for g in ("male", "female"):
            r = res[g]
            c = r["shrunk"]
            L += [f"## {name}, {g}", "",
                  "| age bin (mean age) | player-seasons | level (pts vs 27-28) | s.e. | hinge curve |", "|---|---|---|---|---|"]
            lv = lambda a, c=c: c["level"] + c["pre"] * min(0.0, a - c["P"]) + c["post"] * max(0.0, a - c["P"])
            ref = lv(r["ages"][3])
            for b in range(len(AGE_BINS)):
                if r["ages"][b] is None:
                    continue
                L.append(f"| {AGE_BINS[b][0]}-{AGE_BINS[b][1]} ({r['ages'][b]:.1f}) | {r['counts'][b]} | {r['base'][b]:+.2f} | {r['se'][b]:.2f} | {lv(r['ages'][b]) - ref:+.2f} |")
            # spread
            tot = r["v0"]
            persist = max(r["c1"], 0.0)
            # a persistent component with variance Vp and autocorrelation a gives cov1 = Vp a and cov2 = Vp a^2
            ratio = (r["c2"] / r["c1"]) if r["c1"] > 0 and r["c2"] > 0 else 0.0
            a = min(max(ratio, 0.5), 0.98)
            Vp = persist / a if persist > 0 else 0.0
            innov = math.sqrt(Vp * (1 - a * a))
            sd_use = max(SD_FLOOR, min(innov, 3.5))
            phi = sd_use ** 2 / (2 * SCALE ** 2)
            L += ["", f"Slopes (points per year of age): {c['pre']:+.2f} before the peak age {c['P']:.1f} (raw {r['pre_raw']:+.2f}, s.e. {r['se_pre']:.2f}), "
                  f"{c['post']:+.2f} after it (raw {r['post_raw']:+.2f}, s.e. {r['se_post']:.2f}); shrunk toward "
                  + ("0" if name == "fielding" else "half the fielding slope") + f" with a prior sd of {quantities[name][4]:.1f}"
                  + (", women toward the men's curve" if g == "female" else "") + ".", "",
                  f"Season-to-season deviations from a player's own level: luck variance {tot:.1f} pts^2 (sd {math.sqrt(max(tot, 0)):.1f}) per season, Poisson noise removed; "
                  f"covariance beyond what luck alone gives: one season apart {r['c1']:+.2f} (n={int(r['n1'])}), two apart {r['c2']:+.2f} (n={int(r['n2'])}) -> "
                  f"persistent innovation sd {innov:.2f}; used {sd_use:.2f} points per season (floor {SD_FLOOR}); reversion {phi:.3f} per season.", ""]
            Pn = int(round(c["P"]))
            node_ages = [20, Pn, Pn + 1, 45]     # the curve is flat on each side of the peak age, so these four nodes carry it
            nodes = [round(curve_effect(c, a_), 3) for a_ in node_ages]
            report[name][g] = dict(curve=c, raw=r["curve"], se_pre=r["se_pre"], se_post=r["se_post"], v0=tot, c1=r["c1"], c2=r["c2"],
                                   innovation_sd=innov, sd=sd_use, phi=phi,
                                   bins=[dict(age=r["ages"][b], n=r["counts"][b], level=r["base"][b], se=r["se"][b]) for b in range(len(AGE_BINS))])
            model[name][g] = dict(ageNodes=node_ages, ageEffect=nodes, sd=round(sd_use, 2), reversion=round(phi, 4))
            # validation targets: the raw bin profile (no curve), expected change from start-age groups over 1, 3, 5 seasons
            pts = [(a_, v_) for a_, v_ in zip(r["ages"], r["base"]) if a_ is not None]
            def at(a_, pts=pts):
                for i in range(1, len(pts)):
                    if a_ <= pts[i][0]:
                        t = (a_ - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0])
                        return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t
                return pts[-1][1]
            def at_se(a_, r=r):
                ps = [(x, s) for x, s in zip(r["ages"], r["se"]) if x is not None]
                return min(ps, key=lambda p: abs(p[0] - a_))[1]
            tg = []
            for start in (22, 25, 28, 31, 34):
                for k in (1, 3, 5):
                    if start + k > 40:
                        continue
                    tg.append(dict(start=start, seasons=k, change=round(at(start + k) - at(start), 3),
                                   se=round(math.hypot(at_se(start), at_se(start + k)), 3)))
            fixture[name][g] = tg
        ho = holdout(name, rows, comps, sd_for, min_inns)
        L += [f"Held-out check ({name}): curve fitted on half of the players (by id), judged against the age profile of the other half; "
              + "; ".join(f"{g}: RMS error {v['rms_model']:.2f} points with the fitted curve vs {v['rms_flat']:.2f} for no ageing at all (post-peak slope {v['slope_post_a']:+.2f})" for g, v in ho.items()), ""]
        report[name]["holdout"] = ho
        L.append("")

    json.dump(report, open(OUT_JSON, "w"), indent=1, default=lambda x: None)
    lines = [
        "// Generated by packages/ratings/src/analysis/fielding-progression.py from the Cricsheet fielding innings",
        "// (data/analysis/fielding_player_innings.parquet, keeping_innings.parquet). Do not edit by hand; re-run the script.",
        "//",
        "// How fielding and keeping change with age: rating points per season at the age reached (the age after the coming",
        "// birthday), linear between the nodes; the sd of a season's persistent change; and the fraction of the distance to",
        "// 50 given back each season. See docs/RATINGS-PIPELINE.md, \"Fielding and keeping progression\".",
        "",
        "export interface FieldingProgressionFit {",
        "  ageNodes: number[];",
        "  /** Expected change over a season (rating points) at each node */",
        "  ageEffect: number[];",
        "  /** Spread (sd) of a season's change, rating points */",
        "  sd: number;",
        "  /** Fraction of the distance to 50 given back each season */",
        "  reversion: number;",
        "}",
        "",
        "export const FIELDING_PROGRESSION: Record<\"fielding\" | \"keeping\", Record<\"male\" | \"female\", FieldingProgressionFit>> = "
        + json.dumps(model, indent=2) + ";",
        "",
    ]
    OUT_TS.write_text("\n".join(lines))
    print("wrote", OUT_TS)
    OUT_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    json.dump(fixture, open(OUT_FIXTURE, "w"), separators=(",", ":"))
    print("wrote", OUT_FIXTURE)
    OUT_REPORT.write_text("\n".join(L))
    print("wrote", OUT_REPORT)


if __name__ == "__main__":
    main()
