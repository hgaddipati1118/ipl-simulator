"""
Fielding and keeping for generated players: the real distribution by gender and role class, as the generated-player
model (player-generation.py, generation-model.ts) does for the eight core ratings.

Input : data/analysis/game_players.json (the game's rated players, npx tsx src/analysis/export-game-players.ts),
        data/analysis/fielding_ratings.csv (fielding-ratings.py), keyed by the Cricinfo id inside the player id (espn_<id>).
Output: packages/engine/src/fielding-generation-model.ts  (new file; the existing generation model is not touched)
        data/analysis/fielding_generation.json

For each stratum (gender / role class: batter, keeper, allround, pace, spin) among players with a solid record (20+
fielding innings; keepers: 8+ keeper innings for keeping):
  * the marginal quantiles of the fielding rating (keepers: also of the keeping rating);
  * the fielding normal score is regressed on how good the player is as a batter and as a bowler (the rated
    batting / bowling overall, centred on the stratum mean and divided by 20): good players field better (r = 0.3);
    the slopes are pooled over strata and genders, the residual sd makes the normal score unit-variance again;
  * keeping is drawn independently of fielding for keepers (r = 0.02 in the data).
Non-keepers get no keeping rating (as in the real data); the engine treats them as 25.

Run from packages/ratings:  python3 -I src/analysis/fielding-generation.py
"""
import csv, json, math
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
OUT_TS = ROOT.parent / "engine" / "src" / "fielding-generation-model.ts"
OUT_JSON = DATA / "fielding_generation.json"
QP = [0.003, 0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.975, 0.99, 0.997]
SPIN = {"off-spin", "left-arm-orthodox", "leg-spin", "left-arm-wrist-spin"}
MIN_FIELD, MIN_KEEP = 20, 8


def role_class(p):
    if p["wk"] and p["role"] != "bowler":
        return "keeper"
    if p["role"] == "all-rounder":
        return "allround"
    if p["role"] == "bowler":
        return "spin" if p["bs"] in SPIN else "pace"
    return "batter"


def quantile(v, p):
    v = sorted(v)
    i = p * (len(v) - 1)
    lo = int(math.floor(i)); hi = min(len(v) - 1, lo + 1)
    return v[lo] + (v[hi] - v[lo]) * (i - lo)


def norm_inv(p):
    # Acklam's rational approximation
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
    pl = 0.02425
    if p < pl:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p > 1 - pl:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    q = p - 0.5; r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


def normal_scores(vals):
    """Mid-rank normal scores of a list (ties share their mean rank)"""
    n = len(vals)
    order = sorted(range(n), key=lambda i: vals[i])
    out = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and vals[order[j + 1]] == vals[order[i]]:
            j += 1
        mid = (i + j) / 2.0
        z = norm_inv((mid + 0.5) / n)
        for k in range(i, j + 1):
            out[order[k]] = z
        i = j + 1
    return out


def bat_ovr(r):
    return 0.30 * r["battingIQ"] + 0.30 * r["timing"] + 0.35 * r["power"] + 0.05 * r["running"]


def bowl_ovr(r):
    return 0.55 * r["wicketTaking"] + 0.20 * r["economy"] + 0.10 * r["accuracy"] + 0.15 * r["clutch"]


def main():
    game = json.load(open(DATA / "game_players.json"))
    fr = {}
    for r in csv.DictReader(open(DATA / "fielding_ratings.csv")):
        if r["cricinfo_id"]:
            fr[(r["cricinfo_id"], r["gender"])] = r
    strata = defaultdict(list)
    for p in game:
        if not p["id"].startswith("espn_"):
            continue
        r = fr.get((p["id"][5:], p["g"]))
        if not r or not r["fielding"] or int(r["field_inns"]) < MIN_FIELD:
            continue
        keeping = int(r["keeping"]) if r["keeping"] and int(r["keep_inns"] or 0) >= MIN_KEEP else None
        strata[f"{p['g']}/{role_class(p)}"].append(dict(f=int(r["fielding"]), k=keeping, bat=bat_ovr(p["r"]), bowl=bowl_ovr(p["r"])))

    # stratum summaries and the pooled regression of the fielding normal score on batting / bowling quality
    X, Y = [], []
    summary = {}
    for key, rows in strata.items():
        if len(rows) < 25:
            continue
        zs = normal_scores([r["f"] for r in rows])
        mb = sum(r["bat"] for r in rows) / len(rows); mw = sum(r["bowl"] for r in rows) / len(rows)
        summary[key] = dict(n=len(rows), mb=mb, mw=mw, zs=zs)
        for r, z in zip(rows, zs):
            X.append([(r["bat"] - mb) / 20.0, (r["bowl"] - mw) / 20.0]); Y.append(z)
    # least squares, 2 regressors, no intercept (centred)
    a11 = sum(x[0] * x[0] for x in X); a12 = sum(x[0] * x[1] for x in X); a22 = sum(x[1] * x[1] for x in X)
    b1 = sum(x[0] * y for x, y in zip(X, Y)); b2 = sum(x[1] * y for x, y in zip(X, Y))
    det = a11 * a22 - a12 * a12
    c_bat = (b1 * a22 - b2 * a12) / det; c_bowl = (a11 * b2 - a12 * b1) / det
    res = [y - c_bat * x[0] - c_bowl * x[1] for x, y in zip(X, Y)]
    resid_sd = math.sqrt(sum(r * r for r in res) / len(res))
    # unit-variance normal score z = (c_bat xb + c_bowl xw + resid * e) / sd_total
    var_x = (c_bat ** 2) * (sum(x[0] ** 2 for x in X) / len(X)) + (c_bowl ** 2) * (sum(x[1] ** 2 for x in X) / len(X)) \
        + 2 * c_bat * c_bowl * (sum(x[0] * x[1] for x in X) / len(X))
    sd_total = math.sqrt(var_x + resid_sd ** 2)

    model = {"quantileProbs": QP, "coefBat": round(c_bat, 4), "coefBowl": round(c_bowl, 4), "residSd": round(resid_sd, 4),
             "totalSd": round(sd_total, 4), "strata": {}}
    for key, rows in strata.items():
        if len(rows) < 25:
            continue
        s = summary[key]
        entry = dict(n=len(rows), meanBat=round(s["mb"], 2), meanBowl=round(s["mw"], 2),
                     fielding=[round(quantile([r["f"] for r in rows], p), 2) for p in QP])
        kv = [r["k"] for r in rows if r["k"] is not None]
        if key.endswith("/keeper") and len(kv) >= 20:
            entry["keeping"] = [round(quantile(kv, p), 2) for p in QP]
            entry["nKeeping"] = len(kv)
            entry["keepingMean"] = round(sum(kv) / len(kv), 2)
        model["strata"][key] = entry
    # keeper strata thin for women: fall back on the men's keeping quantiles (the engine does this when absent)
    json.dump(model, open(OUT_JSON, "w"), indent=1)
    lines = [
        "// Generated by packages/ratings/src/analysis/fielding-generation.py from the game's rated players",
        "// (data/analysis/game_players.json) and the fielding ratings (data/analysis/fielding_ratings.csv).",
        "// Do not edit by hand; re-run the script.",
        "//",
        "// Per stratum (gender / role class): marginal quantiles of the fielding rating (keepers: also keeping), and the",
        "// regression of the fielding normal score on batting / bowling quality. See docs/RATINGS-PIPELINE.md, \"Generated players\".",
        "",
        "export interface FieldingStratum {",
        "  n: number;",
        "  /** Mean batting / bowling overall of the stratum's players (the regression is centred on these) */",
        "  meanBat: number;",
        "  meanBowl: number;",
        "  /** Fielding rating at each of quantileProbs */",
        "  fielding: number[];",
        "  /** Keeping rating at each of quantileProbs (keeper strata only) */",
        "  keeping?: number[];",
        "  nKeeping?: number;",
        "  keepingMean?: number;",
        "}",
        "",
        "export const FIELDING_GENERATION: {",
        "  quantileProbs: number[];",
        "  /** Fielding normal score = (coefBat * (batOvr - meanBat) / 20 + coefBowl * (bowlOvr - meanBowl) / 20 + residSd * e) / totalSd */",
        "  coefBat: number;",
        "  coefBowl: number;",
        "  residSd: number;",
        "  totalSd: number;",
        "  strata: Record<string, FieldingStratum>;",
        "} = " + json.dumps(model, indent=2) + ";",
        "",
    ]
    OUT_TS.write_text("\n".join(lines))
    print("wrote", OUT_TS)
    print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk in ("n", "keepingMean", "nKeeping")} | {"fielding_median": v["fielding"][10]} for k, v in model["strata"].items()}, indent=1))
    print("coef", c_bat, c_bowl, "resid", resid_sd, "total", sd_total)


if __name__ == "__main__":
    main()
