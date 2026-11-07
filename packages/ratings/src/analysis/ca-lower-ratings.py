"""
Lower-level CricketArchive ratings: second XIs, university, club / league, youth and veterans cricket
(event-only scorecards, tiered by src/pipeline/event-tiers.ts), put on the senior scale of ca-ratings.py.

Input   data/analysis/ca_cells.parquet        senior cells (ca-player-seasons.sql), fitted exactly as ca-ratings.py does
        data/analysis/ca_lower_cells.parquet  lower-level cells (ca-lower-cells.sql)
        data/analysis/ca_validation.json      tuned half-life h / shrinkage K per side x format x gender
Output  data/analysis/ca_lower_ratings.parquet  one row per player x format (latest year): same rating columns as
                                              ca_ratings_by_year.parquet, ratings on the senior (T20 / List A / FC) scale
        data/analysis/ca_lower_comp_level.csv   fitted level of every lower-level competition
        data/analysis/ca_lower_validation.json  translation fits per tier and the sanity checks
Run from packages/ratings:  python3 -I src/analysis/ca-lower-ratings.py   (needs the senior outputs first)

Method. The senior fit (strengths, weak-tier translation, competition pools, role offsets) is reused unchanged, so
senior ratings do not move. Each lower-level cell has a competition-relative rate r (runs per 100 balls above that
competition-season's average ball). Its value on the senior scale is
        a = L_c + rho_t * r
where t is the competition's tier and
  - rho_t, alpha_t: the tier's translation, fitted on cells of players who also played senior cricket in the same year
    (the links): senior skill y = alpha_t + rho_t * r, errors-in-variables corrected, rho clipped to [0.3, 1]. Players who
    appear at both levels are what ties lower-level cricket to the senior scale.
  - L_c = alpha_t + shift_c: the competition's level, alpha_t plus the shrunk mean residual of the links in that
    competition (prior worth half the competition prior). Competitions with no links sit at the tier level alpha_t.
  - A tier with fewer than MIN_PAIRS link cells has no usable fit: rho = FALLBACK_RHO and alpha = a level below the
    weakest senior competitions (5th percentile of senior competition pools, minus TIER_STEP[t] standard deviations).
  The link players are selected (good enough to also play senior cricket), so alpha_t errs high; the game applies tier
  ceilings on top (generate-ca-pool.ts) and the sanity report checks lower-level players against senior ones.
Ratings then use the same decayed, shrunk, role-offset estimator as the senior ratings, over the player's senior cells
(if any) and lower-level cells together, evaluated at his last season. sd adds the link regression's residual variance.
"""
import csv, importlib.util, json, math, os, subprocess, sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("ca_ratings", HERE / "ca-ratings.py")
cr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cr)

ROOT, DATA, LAST_YEAR = cr.ROOT, cr.DATA, cr.LAST_YEAR
MIN_PAIRS = 40
FALLBACK_RHO = 0.5
TIER_STEP = {0: 0.0, 1: 0.5, 2: 1.0, 3: 1.0, 4: 1.5}   # standard deviations below the weakest senior pools
TIER_NAMES = ["senior-event", "university", "club", "youth", "veterans"]
LOW_PCT = 0.05


def log(*a):
    cr.log(*a)


def load_lower():
    rows = cr.duck("SELECT side, format, gender, comp, tier, year, player_id, balls, value, mean_position FROM 'data/analysis/ca_lower_cells.parquet' WHERE balls > 0 AND value IS NOT NULL")
    groups = defaultdict(list)
    for r in rows:
        groups[(r["side"], r["format"], r["gender"])].append(
            (r["comp"], int(r["year"]), int(r["player_id"]), float(r["balls"]), float(r["value"]),
             float(r["mean_position"]) if r["mean_position"] else None, "tier" + r["tier"], int(r["tier"])))
    return groups


def wquantile(pairs, q):
    pairs = sorted(pairs)
    tot = sum(w for _, w in pairs)
    acc = 0.0
    for v, w in pairs:
        acc += w
        if acc >= q * tot:
            return v
    return pairs[-1][0]


def translate(model, senior_py, ll_cells, fmt):
    """Per tier alpha/rho and per competition level. Returns (tier_fit, comp_level, comp_tier)."""
    sk = {}
    for pid, years in senior_py.items():
        for y, (b, a, _) in years.items():
            if b > 0:
                sk[(pid, y)] = (b, a / b)
    pool = model["pool"]
    pool_pairs = [(v, 1.0) for v in pool.values()]
    l_low = wquantile(pool_pairs, LOW_PCT)
    m = sum(v for v, _ in pool_pairs) / len(pool_pairs)
    sd_pool = math.sqrt(sum((v - m) ** 2 for v, _ in pool_pairs) / len(pool_pairs))
    sigma2 = model.get("sigma2_within") or model["sigma"] ** 2
    comp_tier = {}
    votes = defaultdict(lambda: defaultdict(float))
    for c in ll_cells:
        votes[c[0]][c[7]] += c[3]
    for comp, v in votes.items():
        comp_tier[comp] = max(v, key=v.get)
    pairs = defaultdict(list)  # tier -> (x, y, w, comp, nx)
    for c in ll_cells:
        comp, y, pid, b, val = c[0], c[1], c[2], c[3], c[4]
        s = sk.get((pid, y))
        if not s or b < cr.MIN_LINK[fmt] or s[0] < cr.MIN_LINK[fmt]:
            continue
        pairs[comp_tier[comp]].append((100 * val / b, s[1], 2 * b * s[0] / (b + s[0]), comp, sigma2 / b))
    fit = {}
    for t in range(5):
        p = pairs.get(t, [])
        floor = l_low - TIER_STEP[t] * sd_pool
        if len(p) < MIN_PAIRS:
            fit[t] = {"alpha": floor, "rho": FALLBACK_RHO, "links": len(p), "resid_var": 300.0, "fallback": True, "floor": floor}
            continue
        sw = sum(w for _, _, w, _, _ in p)
        mx = sum(x * w for x, _, w, _, _ in p) / sw
        my = sum(y * w for _, y, w, _, _ in p) / sw
        sxx = sum(w * (x - mx) ** 2 for x, _, w, _, _ in p) - sum(w * n for _, _, w, _, n in p)
        sxy = sum(w * (x - mx) * (y - my) for x, y, w, _, _ in p)
        rho = min(1.0, max(0.3, sxy / sxx)) if sxx > 0 else 1.0
        alpha = my - rho * mx
        resid = sum(w * (y - alpha - rho * x) ** 2 for x, y, w, _, _ in p) / sw
        # the regression residual includes the sampling noise of the lower-level value; keep only the rest
        noise = sum(w * rho ** 2 * n for _, _, w, _, n in p) / sw
        fit[t] = {"alpha": alpha, "rho": rho, "links": len(p), "resid_var": max(0.0, resid - noise), "fallback": False, "floor": floor}
    # competition levels: alpha + shrunk mean residual over its links
    num, den = defaultdict(float), defaultdict(float)
    for t, p in pairs.items():
        for x, y, w, comp, _ in p:
            num[comp] += w * (y - fit[t]["alpha"] - fit[t]["rho"] * x)
            den[comp] += w
    comp_level, comp_links = {}, {}
    for comp, t in comp_tier.items():
        shift = num[comp] / (den[comp] + cr.PRIOR[fmt] / 2) if den[comp] else 0.0
        comp_level[comp] = fit[t]["alpha"] + shift
        comp_links[comp] = den[comp]
    return fit, comp_level, comp_tier, comp_links


def main():
    log("loading senior cells")
    groups, meta, _people = cr.load()
    ll_groups = load_lower()
    log(f"{sum(map(len, ll_groups.values()))} lower-level cells")
    validation = json.load(open(DATA / "ca_validation.json"))
    pos = defaultdict(lambda: [0.0, 0.0])
    for cells in list(groups.values()) + list(ll_groups.values()):
        for c in cells:
            if c[5] is not None:
                pos[c[2]][0] += c[3] * c[5]; pos[c[2]][1] += c[3]
    bat_role = {pid: ("top" if v[0] / v[1] <= 3.5 else "middle" if v[0] / v[1] <= 7.0 else "lower") for pid, v in pos.items() if v[1]}
    bowl_role = {pid: cr.bowl_type((m or {}).get("bowling_style")) for pid, m in meta.items()}

    out_rows, comp_rows, tier_report = [], [], {}
    for key in sorted(ll_groups):
        side, fmt, gender = key
        ll = ll_groups[key]
        cells = groups.get(key, [])
        if not cells:
            continue
        roles = bat_role if side == "bat" else bowl_role
        p = validation["/".join(key)]["params"]
        h, K = p["half_life"], p["K"]
        log(f"{key}: senior fit ({len(cells)} cells), {len(ll)} lower-level cells")
        model = cr.fit(cells, fmt, LAST_YEAR, roles)
        spy = cr.player_years(model, cells, LAST_YEAR)
        fit, level, comp_tier, links = translate(model, spy, ll, fmt)
        tier_report["/".join(key)] = {TIER_NAMES[t]: {k: (round(v, 3) if isinstance(v, float) else v) for k, v in f.items()} for t, f in fit.items()}
        for comp, lv in level.items():
            t = comp_tier[comp]
            comp_rows.append({"side": side, "format": fmt, "gender": gender, "tier": TIER_NAMES[t], "comp": comp,
                              "level": round(lv, 2), "link_weight": round(links[comp]), "tier_rho": round(fit[t]["rho"], 3)})
        # combined player-years: senior cells (already adjusted) + translated lower-level cells
        ll_pids = {c[2] for c in ll}
        comb = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0, 0.0]))
        ll_balls = defaultdict(float)
        tier_of = defaultdict(lambda: defaultdict(float))
        for pid in ll_pids:
            for y, v in spy.get(pid, {}).items():
                comb[pid][y] = list(v)
        for comp, y, pid, b, val, _pos, _cls, t in ll:
            if b < 6:
                continue
            tf = fit[comp_tier[comp]]
            a = level[comp] + tf["rho"] * 100 * val / b
            tot = comb[pid][y]
            tot[0] += b; tot[1] += b * a; tot[2] += b * level[comp]
            ll_balls[pid] += b
            tier_of[pid][t] += b
        for pid, years in comb.items():
            if not tier_of[pid]:
                continue
            Y = max(years)
            off = model["offset"].get(roles.get(pid, "unknown"), 0.0)
            r, B = cr.rating_at(years, Y, h, K, off)
            s = cr.season_at(years, Y, K, off)
            if r is None:
                continue
            t = max(tier_of[pid], key=tier_of[pid].get)
            share = ll_balls[pid] / max(1.0, sum(v[0] for v in years.values()))
            # translated evidence adds the link regression's residual to the uncertainty, in proportion to its share
            sd = math.sqrt(model["sigma"] ** 2 / (B + K) + share * fit[t]["resid_var"])
            out_rows.append({"player_id": pid, "gender": gender, "format": fmt, "side": side, "year": Y, "balls": round(B),
                             "ll_balls": round(ll_balls[pid]), "rating": round(r, 3), "season": round(s, 3) if s is not None else "",
                             "sd": round(sd, 3), "tier": t, "has_senior": int(pid in spy)})
    # wide table: one row per player x format x gender
    wide = defaultdict(dict)
    for r in out_rows:
        row = wide[(r["player_id"], r["format"], r["gender"])]
        row["year"] = max(row.get("year", 0), r["year"])
        row["tier"] = r["tier"]
        row["has_senior"] = max(row.get("has_senior", 0), r["has_senior"])
        for k in ("balls", "ll_balls", "rating", "season", "sd"):
            row[f"{r['side']}_{k}"] = r[k]
    cols = ["player_id", "gender", "format", "year", "tier", "has_senior",
            "bat_balls", "bat_ll_balls", "bat_rating", "bat_season", "bat_sd", "bowl_balls", "bowl_ll_balls", "bowl_rating", "bowl_season", "bowl_sd"]
    work = cr.WORK
    csv_path = work / "ca_lower_ratings.csv"
    with open(csv_path, "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(cols)
        for (pid, fmt, gender), row in sorted(wide.items()):
            wr.writerow([pid, gender, fmt, row["year"], row["tier"], row["has_senior"]] +
                        [row.get(c, 0 if c.endswith("balls") else "") for c in cols[6:]])
    types = "{'bat_season': 'DOUBLE', 'bowl_season': 'DOUBLE', 'bat_rating': 'DOUBLE', 'bowl_rating': 'DOUBLE', 'bat_sd': 'DOUBLE', 'bowl_sd': 'DOUBLE'}"
    subprocess.run(["duckdb", "-c", f"COPY (SELECT * FROM read_csv('{csv_path}', header=true, sample_size=-1, types={types})) TO 'data/analysis/ca_lower_ratings.parquet' (FORMAT parquet)"], check=True, cwd=ROOT)
    with open(DATA / "ca_lower_comp_level.csv", "w", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=list(comp_rows[0]))
        wr.writeheader(); wr.writerows(sorted(comp_rows, key=lambda r: (r["side"], r["format"], r["gender"], -r["level"])))
    with open(DATA / "ca_lower_validation.json", "w") as f:
        json.dump(tier_report, f, indent=1)
    log(f"wrote {len(wide)} player-format rows")


if __name__ == "__main__":
    main()
