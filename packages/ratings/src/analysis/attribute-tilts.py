"""
Per-attribute age curves for batting and bowling: how each of the eight game attributes ages RELATIVE to its discipline.

Player.progress() draws one change per discipline (progression.py: age, level, experience, luck) and spreads it over
the discipline's four attributes with the weights below, so every attribute used to age alike. The real components
age differently (running and power fade earlier, battingIQ and accuracy hold, clutch grows with experience). This script
fits that as a TILT per attribute and age:

    attribute change = discipline change + tilt_attr(age, gender),    sum over the discipline of weight * tilt = 0

so a player's discipline overall moves exactly as the validated discipline model says and only the mix changes.

Data: data/analysis/player_ratings_by_season.parquet, the ratings model's component values per player and year-start
snapshot (the components the game attributes are ranked from, src/pipeline/model-ratings.ts):
    battingIQ = bat_dismissal + bat_runs, timing = bat_timing, power = bat_power, running = bat_running,
    wicketTaking = bowl_wickets, economy = bowl_economy, accuracy = bowl_accuracy, clutch = clutch (the 0-99 rating).
Method (the delta method on consecutive snapshots, as progression.py and fielding-progression.py):
 1. Regulars only (300+ batting balls / 240+ bowling balls on record at both snapshots, age known).  Each component is
    standardised within its snapshot and gender (z), which removes the calendar drift of the run scale, and turned into
    game attribute points with the attribute's own sd in the game's player pool (so 1 z = ~14 points for battingIQ).
 2. For every consecutive pair, change in each attribute (points) minus the weighted mean change of its discipline's
    attributes (bat .30/.30/.35/.05, bowl .55/.20/.10/.15; clutch is compared with its player's main discipline).
 3. Mean relative change by two-year age bin (age at the later snapshot = the age the game uses), standard errors from the
    pairs (players are repeated across years, so the s.e. is inflated by a design factor of 1.5).
 4. A line  tilt(a) = alpha + beta (a - 28)  fitted by precision-weighted least squares on the bins with 40+ pairs, each
    coefficient shrunk by empirical Bayes toward its prior (men: 0; women: the men's value) with prior sds ALPHA_SD / BETA_SD
    chosen small because the snapshots are cumulative and decayed estimates, which damp every real change, so a raw slope
    understates the truth and a noisy one is not to be trusted.
 5. Centred so that the weighted tilts sum to zero in each discipline at every age (the same shift for each attribute).

Writes (new files; nothing existing is touched):
    packages/engine/src/attribute-tilt-model.ts                          the parameters, generated
    packages/engine/src/__tests__/fixtures/attribute-tilt-cohort.json   real mean relative change per season by age band
    data/analysis/attribute_tilts.json, attribute-tilts-report.md

Run from packages/ratings:  python3 -I src/analysis/attribute-tilts.py
"""
import csv, json, math, statistics, subprocess, sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
ENGINE = ROOT.parent / "engine"
OUT_TS = ENGINE / "src" / "attribute-tilt-model.ts"
OUT_FIXTURE = ENGINE / "src" / "__tests__" / "fixtures" / "attribute-tilt-cohort.json"
OUT_JSON = DATA / "attribute_tilts.json"
OUT_REPORT = DATA / "attribute-tilts-report.md"

BAT = ["battingIQ", "timing", "power", "running"]
BOWL = ["wicketTaking", "economy", "accuracy", "clutch"]
W = {"battingIQ": 0.30, "timing": 0.30, "power": 0.35, "running": 0.05,
     "wicketTaking": 0.55, "economy": 0.20, "accuracy": 0.10, "clutch": 0.15}
MIN_BAT_BALLS, MIN_BOWL_BALLS = 300, 240
AGE_BINS = [(0, 22), (23, 24), (25, 26), (27, 28), (29, 30), (31, 32), (33, 34), (35, 36), (37, 99)]
MIN_PAIRS = 40
DESIGN = 1.5                 # s.e. inflation: a player appears in several overlapping pairs
ALPHA_SD, BETA_SD = 0.25, 0.04      # prior sd of the level (points a season at 28) and of the slope (points a season per year of age)
WOMEN_PRIOR_SCALE = 0.6      # women's prior sds relative to men's, around the men's posterior
CLAMP = 1.5                  # |tilt| never exceeds this many points a season
GROUPS = [("<=25", 0, 25), ("26-29", 26, 29), ("30-33", 30, 33), ("34+", 34, 99)]   # validation bands (age at the later snapshot)
ATTRS = BAT + BOWL


def duck(sql):
    out = subprocess.run(["duckdb", "-csv", "-nullvalue", "", "-c", sql], capture_output=True, text=True, cwd=ROOT)
    if out.returncode:
        sys.exit(out.stderr)
    return list(csv.DictReader(out.stdout.splitlines()))


def num(x):
    return float(x) if x not in ("", None) else None


def bin_of(a):
    for i, (lo, hi) in enumerate(AGE_BINS):
        if lo <= a <= hi:
            return i
    return len(AGE_BINS) - 1


def game_sds():
    """sd of each attribute among the game's rated players of the discipline, by gender"""
    g = json.load(open(DATA / "game_players.json"))
    out = {}
    for gen in ("male", "female"):
        ps = [p for p in g if p["g"] == gen]
        out[gen] = {}
        for a in ATTRS:
            ok = (lambda p: p["role"] != "bowler") if a in BAT else (lambda p: p["role"] != "batsman")
            out[gen][a] = statistics.pstdev([p["r"][a] for p in ps if ok(p)])
    return out


def load():
    rows = duck(f"""
        SELECT gender, cricinfo_id AS pid, CAST(snapshot AS INT) AS year, age, bat_balls_career AS bb, bowl_balls_career AS wb,
               bat_dismissal + bat_runs AS battingIQ, bat_timing AS timing, bat_power AS power, bat_running AS running,
               last_played AS lp, as_of, bowl_wickets AS wicketTaking, bowl_economy AS economy, bowl_accuracy AS accuracy, clutch
        FROM 'data/analysis/player_ratings_by_season.parquet'
        WHERE regexp_matches(snapshot, '^[0-9]{{4}}$') AND age IS NOT NULL AND cricinfo_id IS NOT NULL""")
    snaps = defaultdict(dict)       # (gender, year) -> pid -> row
    for r in rows:
        d = {a: num(r[a]) for a in ATTRS}
        d.update(age=num(r["age"]), bb=num(r["bb"]) or 0, wb=num(r["wb"]) or 0, lp=r["lp"], as_of=r["as_of"])
        snaps[(r["gender"], int(r["year"]))][r["pid"]] = d
    # standardise each component within snapshot and gender, among the regulars of its discipline
    for key, S in snaps.items():
        for a in ATTRS:
            pool = [d[a] for d in S.values() if d[a] is not None and ((d["bb"] >= MIN_BAT_BALLS) if a in BAT else (d["wb"] >= MIN_BOWL_BALLS) if a != "clutch" else (d["bb"] >= MIN_BAT_BALLS or d["wb"] >= MIN_BOWL_BALLS))]
            if len(pool) < 30:
                for d in S.values():
                    d["z_" + a] = None
                continue
            m, s = statistics.mean(pool), statistics.pstdev(pool) or 1.0
            for d in S.values():
                d["z_" + a] = (d[a] - m) / s if d[a] is not None else None
    return snaps


def pairs(snaps, sds):
    """per gender: list of dicts(age, rel{attr: pts}) for consecutive-year pairs"""
    out = defaultdict(list)
    for (gen, year), S in snaps.items():
        T = snaps.get((gen, year + 1))
        if not T:
            continue
        for pid, a0 in S.items():
            a1 = T.get(pid)
            # a player who is not playing carries his old values forward: only seasons he actually played count, ages up to 45
            if a1 is None or a1["age"] > 45 or not a1["lp"] or a1["lp"] < a0["as_of"]:
                continue
            rel = {}
            bat_ok = a0["bb"] >= MIN_BAT_BALLS and a1["bb"] >= MIN_BAT_BALLS
            bowl_ok = a0["wb"] >= MIN_BOWL_BALLS and a1["wb"] >= MIN_BOWL_BALLS
            d = {}
            for a in ATTRS:
                z0, z1 = a0.get("z_" + a), a1.get("z_" + a)
                d[a] = (z1 - z0) * sds[gen][a] if z0 is not None and z1 is not None else None
            if bat_ok and all(d[a] is not None for a in BAT):
                comp = sum(W[a] * d[a] for a in BAT)
                for a in BAT:
                    rel[a] = d[a] - comp
            if bowl_ok and all(d[a] is not None for a in BOWL):
                comp = sum(W[a] * d[a] for a in BOWL)
                for a in BOWL:
                    rel[a] = d[a] - comp
            elif bat_ok and d["clutch"] is not None and "clutch" not in rel:
                rel["clutch"] = d["clutch"] - sum(W[a] * d[a] for a in BAT if d[a] is not None) if all(d[a] is not None for a in BAT) else None
                if rel["clutch"] is None:
                    del rel["clutch"]
            if rel:
                out[gen].append(dict(age=a1["age"], rel=rel))
    return out


def wls_line(pts):
    """pts: (age, mean, se); fit alpha + beta (age - 28); returns (alpha, beta, var_alpha, var_beta) from the precision-weighted normal equations"""
    S = [[0.0, 0.0], [0.0, 0.0]]
    b = [0.0, 0.0]
    for a, m, se in pts:
        w = 1.0 / max(se, 0.02) ** 2
        x = [1.0, a - 28.0]
        for i in range(2):
            b[i] += w * x[i] * m
            for j in range(2):
                S[i][j] += w * x[i] * x[j]
    det = S[0][0] * S[1][1] - S[0][1] * S[1][0]
    if abs(det) < 1e-12:
        return 0.0, 0.0, 1e6, 1e6
    inv = [[S[1][1] / det, -S[0][1] / det], [-S[1][0] / det, S[0][0] / det]]
    al = inv[0][0] * b[0] + inv[0][1] * b[1]
    be = inv[1][0] * b[0] + inv[1][1] * b[1]
    return al, be, inv[0][0], inv[1][1]


def eb(est, var, prior_mean, prior_sd):
    p0, p1 = 1.0 / var, 1.0 / prior_sd ** 2
    return (est * p0 + prior_mean * p1) / (p0 + p1)


def main():
    sds = game_sds()
    snaps = load()
    P = pairs(snaps, sds)
    res, L = {}, ["# Per-attribute age tilts", "",
                  "Generated by `src/analysis/attribute-tilts.py`. Each attribute's mean change relative to its discipline's weighted change, points a season, by age reached.", ""]
    fixture = {}
    for gen in ("male", "female"):
        res[gen], fixture[gen] = {}, {}
        L += [f"## {gen}: {len(P[gen])} consecutive-snapshot pairs", ""]
        for a in ATTRS:
            by = defaultdict(list)
            for p in P[gen]:
                if a in p["rel"]:
                    by[bin_of(p["age"])].append(p["rel"][a])
            bins, pts = [], []
            for b in range(len(AGE_BINS)):
                v = by.get(b, [])
                if len(v) >= 2:
                    m = statistics.mean(v)
                    se = DESIGN * statistics.pstdev(v) / math.sqrt(len(v))
                    ages = [p["age"] for p in P[gen] if a in p["rel"] and bin_of(p["age"]) == b]
                    bins.append(dict(bin=AGE_BINS[b], n=len(v), age=statistics.mean(ages), mean=m, se=se))
                    if len(v) >= MIN_PAIRS:
                        pts.append((statistics.mean(ages), m, se))
            al, be, va, vb = wls_line(pts)
            res[gen][a] = dict(raw_alpha=al, raw_beta=be, se_alpha=math.sqrt(va), se_beta=math.sqrt(vb), bins=bins)
            fix = []
            for name, lo, hi in GROUPS:
                v = [p["rel"][a] for p in P[gen] if a in p["rel"] and lo <= p["age"] <= hi]
                if len(v) >= MIN_PAIRS:
                    fix.append(dict(group=name, lo=lo, hi=hi, n=len(v), mean=round(statistics.mean(v), 3),
                                    se=round(DESIGN * statistics.pstdev(v) / math.sqrt(len(v)), 3)))
            fixture[gen][a] = fix
    # shrinkage: men toward 0; women toward the men's posterior (then both centred)
    for gen in ("male", "female"):
        for a in ATTRS:
            r = res[gen][a]
            if gen == "male":
                mu_a, mu_b, sa, sb = 0.0, 0.0, ALPHA_SD, BETA_SD
            else:
                mu_a, mu_b = res["male"][a]["alpha"], res["male"][a]["beta"]
                sa, sb = ALPHA_SD * WOMEN_PRIOR_SCALE, BETA_SD * WOMEN_PRIOR_SCALE
            r["alpha"] = eb(r["raw_alpha"], r["se_alpha"] ** 2, mu_a, sa)
            r["beta"] = eb(r["raw_beta"], r["se_beta"] ** 2, mu_b, sb)
    # centre in each discipline (same shift for every attribute: the weights sum to 1)
    for gen in ("male", "female"):
        for group in (BAT, BOWL):
            ca = sum(W[a] * res[gen][a]["alpha"] for a in group)
            cb = sum(W[a] * res[gen][a]["beta"] for a in group)
            for a in group:
                # clutch sits in both worlds: it keeps the bowling centring (its weight in the bowling overall), batters inherit it
                if a == "clutch" or True:
                    res[gen][a]["alpha_c"] = res[gen][a]["alpha"] - ca
                    res[gen][a]["beta_c"] = res[gen][a]["beta"] - cb
    # Population centring: a tilt that is the same sign at every age (clutch about +0.8 a season, accuracy negative
    # throughout) is a level shift, not an ageing shape; applied every season it moves the league's average attribute
    # forever (20-season sims: clutch +3 to +4, women's accuracy -10). Anchor each line so it averages zero over the
    # real age mix of player-seasons and keep only its slope. The anchors weight to zero within each discipline
    # (the lines are already centred there), so discipline overalls are unchanged.
    for gen in ("male", "female"):
        mean_age = statistics.mean(p["age"] for p in P[gen])
        res[gen]["_mean_age"] = mean_age
        for a in ATTRS:
            r = res[gen][a]
            r["level_removed"] = r["alpha_c"] + r["beta_c"] * (mean_age - 28)
            r["alpha_c"] = r["beta_c"] * (28 - mean_age)
    model = {}
    for gen in ("male", "female"):
        model[gen] = {}
        for a in ATTRS:
            r = res[gen][a]
            nodes = [20, 28, 40]
            tilt = [max(-CLAMP, min(CLAMP, r["alpha_c"] + r["beta_c"] * (n - 28))) for n in nodes]
            model[gen][a] = dict(ageNodes=nodes, tilt=[round(t, 3) for t in tilt])
            r["tilt_nodes"] = tilt
        L += ["| attribute | raw level at 28 (s.e.) | raw slope per year (s.e.) | shrunk level | shrunk slope | centred tilt at 22 / 28 / 34 / 38 |", "|---|---|---|---|---|---|"]
        for a in ATTRS:
            r = res[gen][a]
            t = lambda ag: r["alpha_c"] + r["beta_c"] * (ag - 28)
            L.append(f"| {a} | {r['raw_alpha']:+.2f} ({r['se_alpha']:.2f}) | {r['raw_beta']:+.3f} ({r['se_beta']:.3f}) | {r['alpha']:+.2f} | {r['beta']:+.3f} | "
                     f"{t(22):+.2f} / {t(28):+.2f} / {t(34):+.2f} / {t(38):+.2f} |")
        L += ["", "Raw bin means (points a season relative to the discipline; n pairs):", ""]
        for a in ATTRS:
            L.append(f"- {a}: " + ", ".join(f"{b['bin'][0]}-{b['bin'][1]}: {b['mean']:+.2f} (n={b['n']}, se {b['se']:.2f})" for b in res[gen][a]["bins"]))
        L.append("")
    json.dump(dict(model=model, fit=res, sds=sds), open(OUT_JSON, "w"), indent=1, default=lambda x: None)
    OUT_REPORT.write_text("\n".join(L))
    lines = [
        "// Generated by packages/ratings/src/analysis/attribute-tilts.py from the ratings model's per-snapshot components",
        "// (data/analysis/player_ratings_by_season.parquet). Do not edit by hand; re-run the script.",
        "//",
        "// How each attribute ages relative to its discipline: rating points a season added to the discipline's change, at the age",
        "// reached (linear between the nodes). Weighted by the discipline's attribute weights the tilts sum to zero at every age, so the",
        "// discipline overall moves as the progression model says and only the mix between attributes changes.",
        "// See docs/RATINGS-PIPELINE.md, \"Per-attribute age curves\".",
        "",
        "export interface AttributeTilt {",
        "  ageNodes: number[];",
        "  /** Points a season relative to the discipline's change, at each node */",
        "  tilt: number[];",
        "}",
        "",
        "export type TiltedAttribute = \"battingIQ\" | \"timing\" | \"power\" | \"running\" | \"wicketTaking\" | \"economy\" | \"accuracy\" | \"clutch\";",
        "",
        "export const ATTRIBUTE_TILT: Record<\"male\" | \"female\", Record<TiltedAttribute, AttributeTilt>> = " + json.dumps(model, indent=2) + ";",
        "",
    ]
    OUT_TS.write_text("\n".join(lines))
    OUT_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    json.dump(fixture, open(OUT_FIXTURE, "w"), separators=(",", ":"))
    print("wrote", OUT_TS, OUT_FIXTURE, OUT_REPORT)


if __name__ == "__main__":
    main()
