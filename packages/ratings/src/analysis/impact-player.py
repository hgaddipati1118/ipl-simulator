"""
How IPL sides use the Impact Player (docs/TACTICS.md section 9), fitted for the CPU (packages/engine/src/impact-player.ts).

Input: IMP_OUT=<rows.json> npx vitest run packages/app/src/__tests__/impact-player.test.ts   (docs/data/impact_player.json, rated)

    python3 -I packages/ratings/src/analysis/impact-player.py <rows.json> [--write]

The engine's XI is the eleven that bats (section 7). Every real substitution is one of three:
  chase          the side batting second fields with a bowler Y who later makes way for a batter X (X bats, Y bowled)
  batfirst-break the side batting first brings a bowler Y on at the break for a batter X who batted
  batfirst-mid   the side batting first brings Y in to bat at the fall of a wicket late in its innings, for a batter X out already
So two choices are fitted as conditional logits: X, the one of the batting eleven who does not field (any player but the keeper), and
Y, the bench player who comes on (the side's season squad that day; the overseas limit holds), with a separate Y model for the mid-innings
batter; and a hazard at each wicket of the first innings (the batting side brings its sub in now). Fitted to the end of 2024, judged on 2025+.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy.optimize import minimize

REPO = Path(__file__).resolve().parents[4]
OUT_TS = REPO / "packages" / "engine" / "src" / "impact-player-data.ts"
OUT_REPORT = REPO / "docs" / "data" / "impact_player_fit.json"
SPLIT = "2024-12-31"
MAX_OS = 4


def kind_of(r):
    s = r["sub"]
    if not s or s["in"] < 0 or s["out"] < 0 or len(r["players"]) < 12:
        return "none"
    if not r["batFirst"]:
        return "chase"
    return "batfirst-mid" if s["batting"] else "batfirst-break"


def xy(r, k):
    s = r["sub"]
    return (s["in"], s["out"]) if k == "chase" else (s["out"], s["in"])


def pos_bin(p):
    return 0 if 0 <= p <= 1 else 1 if 2 <= p <= 3 else 2 if 4 <= p <= 5 else 3


# ── features (the engine builds the same: impact-player.ts) ──
X_NAMES = ["bat", "bowl", "fld", "os", "pos23", "pos45", "pos6", "chase:bat", "chase:bowl"]


def x_feat(p, pos, chase):
    b = pos_bin(pos)
    return [p["bat"] / 100, p["bowl"] / 100, p.get("fld", 50) / 100, p["os"], b == 1, b == 2, b == 3, chase * p["bat"] / 100, chase * p["bowl"] / 100]


Y_NAMES = ["gain", "bat", "os", "chase:gain", "chase:bat"]
# the bowling weights of the league XI value by rank (docs/TACTICS.md section 7, LEAGUE_XI_VALUE in xi-selection.ts)
BOWL_W = [6.39, 5.68, 4.50, 3.03, 1.74, 0.50, -0.11]


def bowl_value(ps):
    b = sorted((p["bowl"] for p in ps), reverse=True)
    return sum(w * x / 100 for w, x in zip(BOWL_W, b))


def y_feat(p, chase, rest):
    """the bowling eleven's value with him in it (relative to the rest alone), his batting, overseas"""
    g = bowl_value(rest + [p]) - bowl_value(rest)
    return [g, p["bat"] / 100, p["os"], chase * g, chase * p["bat"] / 100]


M_NAMES = ["bat", "bat2", "bowl", "os"]


def m_feat(p):
    return [p["bat"] / 100, (p["bat"] / 100) ** 2, p["bowl"] / 100, p["os"]]


H_NAMES = ["const", "w5", "w6", "w7", "o12", "o15", "o17"]


def h_feat(n, over):
    return [1, n >= 5, n >= 6, n >= 7, over >= 12, over >= 15, over >= 17]


def best_bowl(pool, rest):
    """the engine's bowling sub: the best bowler on the bench (ties: the weaker batter), as the former engine chose him"""
    return max(range(len(pool)), key=lambda i: (pool[i]["bowl"], -pool[i]["bat"]))


def best_gain(pool, rest):
    """the engine's bowling sub: the bench player who adds most to the bowling eleven's value (ties: the weaker batter)"""
    g = [(round(bowl_value(rest + [p]) - bowl_value(rest), 9), -p["bat"]) for p in pool]
    return max(range(len(pool)), key=lambda i: g[i])


def legal_y(cands, eleven_minus_x):
    os_on = sum(p["os"] for p in eleven_minus_x)
    return [p for p in cands if not (p["os"] and os_on >= MAX_OS)]


def build(rows):
    X, Y, M, H = [], [], [], []
    for r in rows:
        ps = r["players"]
        if any(p is None for p in ps):
            continue
        k = kind_of(r)
        chase = 0 if r["batFirst"] else 1
        if k != "none":
            xi, yi = xy(r, k)
            # X among the batting eleven (the twelve less Y), keepers apart
            cand = [(j, p) for j, p in enumerate(ps) if j != yi and not p["wk"]]
            if any(j == xi for j, _ in cand):
                X.append(dict(f=np.array([x_feat(p, r["bat"][j], chase) for j, p in cand], float), y=[j for j, _ in cand].index(xi), kind=k, date=r["date"],
                              ps=[p for _, p in cand]))
            # Y among the bench and Y himself, legal against the eleven he joins
            rest = [p for j, p in enumerate(ps) if j not in (xi, yi)]
            pool = legal_y([ps[yi]] + r["bench"], rest)
            if pool and pool[0] is ps[yi]:
                if k == "batfirst-mid":
                    M.append(dict(f=np.array([m_feat(p) for p in pool], float), y=0, date=r["date"], ps=pool, rest=rest))
                else:
                    Y.append(dict(f=np.array([y_feat(p, chase, rest) for p in pool], float), y=0, kind=k, date=r["date"], ps=pool, rest=rest, chase=chase))
        if r["batFirst"] and k != "none":
            s = r["sub"]
            for (over, ball, n) in r["fow"]:
                # the wickets of the first innings before the sub (a sub at the break: every wicket is a 'not now')
                if k == "batfirst-mid" and (over, ball) > (s["over"], s["ball"]):
                    break
                now = k == "batfirst-mid" and s["wkts"] == n
                H.append(dict(f=np.array(h_feat(n, over), float), y=int(now), date=r["date"]))
                if now:
                    break
    return X, Y, M, H


def clogit(data, lam, d):
    def nll(w):
        tot, g = 0.0, np.zeros(d)
        for c in data:
            u = c["f"] @ w
            u = u - u.max()
            e = np.exp(u)
            pr = e / e.sum()
            tot -= math.log(pr[c["y"]])
            g -= c["f"][c["y"]] - pr @ c["f"]
        return tot + lam * w @ w, g + 2 * lam * w
    return minimize(nll, np.zeros(d), jac=True, method="L-BFGS-B").x


def cl_score(data, w):
    ll, top = 0.0, 0
    for c in data:
        u = c["f"] @ w
        pr = np.exp(u - u.max()); pr /= pr.sum()
        ll += math.log(pr[c["y"]]); top += int(np.argmax(pr) == c["y"])
    n = max(1, len(data))
    return ll / n, top / n


def uniform(data):
    return sum(-math.log(len(c["f"])) for c in data) / max(1, len(data))


def logit(data, lam, d):
    F = np.array([c["f"] for c in data]); y = np.array([c["y"] for c in data], float)
    def nll(w):
        z = F @ w
        p = 1 / (1 + np.exp(-z))
        return -(y * np.log(p + 1e-12) + (1 - y) * np.log(1 - p + 1e-12)).sum() + lam * w[1:] @ w[1:], -(F.T @ (y - p)) + 2 * lam * np.r_[0, w[1:]]
    return minimize(nll, np.zeros(d), jac=True, method="L-BFGS-B").x


def lg_score(data, w):
    ll = 0.0
    for c in data:
        p = 1 / (1 + math.exp(-(c["f"] @ w)))
        ll += math.log(p if c["y"] else 1 - p)
    return ll / max(1, len(data))


def split(data, lo, hi):
    return [c for c in data if lo < c["date"] <= hi]


def pick_lam(data, fit, score, d):
    """ridge strength: fit to 2023, scored on 2024"""
    tr, va = split(data, "", "2023-12-31"), split(data, "2023-12-31", SPLIT)
    best = None
    for lam in [0.001, 0.01, 0.1, 0.3, 1, 3, 10]:
        s = score(va, fit(tr, lam, d))
        s = s[0] if isinstance(s, tuple) else s
        if best is None or s > best[1]:
            best = (lam, s)
    return best[0]


def sixth(field):
    b = sorted((p["bowl"] for p in field), reverse=True)
    return b[5], b[6]


def shape(rows, wX, wY, wM, rng):
    """the bowling eleven's sixth and seventh bowlers: real, and with X and Y drawn from the fitted models (the real kind and bench)"""
    real6, real7, sim6, sim7 = [], [], [], []
    for r in rows:
        ps = r["players"]
        k = kind_of(r)
        if k == "none" or any(p is None for p in ps):
            continue
        xi, yi = xy(r, k)
        field = [p for j, p in enumerate(ps) if j != xi]
        a, b = sixth(field); real6.append(a); real7.append(b)
        bat11 = [p for j, p in enumerate(ps) if j != yi]
        chase = 0 if r["batFirst"] else 1
        for _ in range(20):
            cand = [(j, p) for j, p in enumerate(bat11) if not p["wk"]]
            f = np.array([x_feat(p, r["bat"][ps.index(p)], chase) for _, p in cand]); u = f @ wX; pr = np.exp(u - u.max()); pr /= pr.sum()
            x = cand[rng.choice(len(cand), p=pr)][1]
            rest = [p for p in bat11 if p is not x]
            pool = legal_y([ps[yi]] + r["bench"], rest)
            if not pool:
                continue
            if k == "batfirst-mid":
                u = np.array([m_feat(p) for p in pool]) @ wM; pr = np.exp(u - u.max()); pr /= pr.sum()
                y = pool[rng.choice(len(pool), p=pr)]
            else:
                y = pool[best_bowl(pool, rest)]
            a, b = sixth(rest + [y]); sim6.append(a); sim7.append(b)
    m = lambda v: round(float(np.mean(v)), 2)
    return dict(real=[m(real6), m(real7)], model=[m(sim6), m(sim7)], n=len(real6))


def main():
    rows = json.load(open(sys.argv[1]))
    X, Y, M, H = build(rows)
    rep = {}
    out = {}
    for name, data, d, fit, score, names in [
        ("x", X, len(X_NAMES), clogit, cl_score, X_NAMES), ("y", Y, len(Y_NAMES), clogit, cl_score, Y_NAMES),
        ("mid", M, len(M_NAMES), clogit, cl_score, M_NAMES), ("hazard", H, len(H_NAMES), logit, lg_score, H_NAMES),
    ]:
        lam = pick_lam(data, fit, score, d)
        tr, ho = split(data, "", SPLIT), split(data, SPLIT, "9999")
        w = fit(tr, lam, d)
        s_fit, s_ho = score(tr, w), score(ho, w)
        r = dict(lam=lam, n_fit=len(tr), n_holdout=len(ho), weights={k: round(float(v), 4) for k, v in zip(names, w)})
        if fit is clogit:
            r.update(fit_ll=round(s_fit[0], 4), holdout_ll=round(s_ho[0], 4), holdout_top1=round(s_ho[1], 3), uniform_holdout_ll=round(uniform(ho), 4))
            if name == "y":
                # the former engine's choice: the best bowler on the bench; the engine's now: the most bowling value (best_gain)
                r["former_top1_holdout"] = round(sum(int(np.argmax([p["bowl"] for p in c["ps"]]) == 0) for c in ho) / max(1, len(ho)), 3)
                r["gain_top1_holdout"] = round(sum(int(best_gain(c["ps"], c["rest"]) == 0) for c in ho) / max(1, len(ho)), 3)
                r["gain_top1_fit"] = round(sum(int(best_gain(c["ps"], c["rest"]) == 0) for c in tr) / max(1, len(tr)), 3)
            if name == "x":
                r["former_top1_holdout"] = round(sum(int(np.argmin([p["bowl"] for p in c["ps"]]) == c["y"]) for c in ho) / max(1, len(ho)), 3)
        else:
            base = np.mean([c["y"] for c in tr]); bl = sum(math.log(base if c["y"] else 1 - base) for c in ho) / max(1, len(ho))
            r.update(fit_ll=round(s_fit, 4), holdout_ll=round(s_ho, 4), const_holdout_ll=round(bl, 4), events_fit=int(sum(c["y"] for c in tr)), events_holdout=int(sum(c["y"] for c in ho)))
        rep[name] = r
        out[name] = [float(v) for v in w]
        if fit is clogit:
            r["mean_choices_holdout"] = round(float(np.mean([len(c["f"]) for c in ho])), 2)
        print(name, json.dumps(r))
    # kinds and the no-sub shares
    kinds = {}
    for half, lo, hi in [("fit", "", SPLIT), ("holdout", SPLIT, "9999")]:
        c = {}
        for r in rows:
            if lo < r["date"] <= hi:
                key = ("bf:" if r["batFirst"] else "ch:") + kind_of(r)
                c[key] = c.get(key, 0) + 1
        kinds[half] = c
    rep["kinds"] = kinds
    fitk = kinds["fit"]
    bf = sum(v for k, v in fitk.items() if k.startswith("bf:")); ch = sum(v for k, v in fitk.items() if k.startswith("ch:"))
    out["noSub"] = {"batFirst": fitk.get("bf:none", 0) / bf, "chase": fitk.get("ch:none", 0) / ch}
    # after no mid-innings sub, the share of first-innings sides that bring one on at the break
    out["breakShare"] = fitk.get("bf:batfirst-break", 0) / max(1, fitk.get("bf:batfirst-break", 0) + fitk.get("bf:none", 0))
    rng = np.random.default_rng(7)
    rep["shape_holdout"] = shape([r for r in rows if r["date"] > SPLIT], np.array(out["x"]), np.array(out["y"]), np.array(out["mid"]), rng)
    rep["shape_fit"] = shape([r for r in rows if r["date"] <= SPLIT], np.array(out["x"]), np.array(out["y"]), np.array(out["mid"]), rng)
    print("kinds", json.dumps(kinds))
    print("noSub", out["noSub"], "breakShare", out["breakShare"])
    print("shape holdout", rep["shape_holdout"], "fit", rep["shape_fit"])
    if "--write" in sys.argv:
        OUT_REPORT.write_text(json.dumps(rep, indent=1) + "\n")
        fmt = lambda names, w: "{ " + ", ".join(f"{n.replace(':', '_')}: {v:.4f}" for n, v in zip(names, w)) + " }"
        OUT_TS.write_text(
            "// Generated by packages/ratings/src/analysis/impact-player.py (docs/TACTICS.md section 9). Do not edit by hand.\n"
            "/** How IPL sides use the Impact Player: fitted on Cricsheet IPL 2023-24, judged on 2025+ */\n"
            "export const IMPACT_FIT = {\n"
            f"  /** who of the batting eleven does not field (conditional logit, keepers apart; pos = place in the batting order, 0-based) */\n  x: {fmt(X_NAMES, out['x'])},\n"
            f"  /** the bench player a first-innings side brings in to bat at the fall of a wicket */\n  mid: {fmt(M_NAMES, out['mid'])},\n"
            f"  /** the hazard of that mid-innings sub at each first-innings wicket (logistic; n = wickets down, over 0-based) */\n  hazard: {fmt(H_NAMES, out['hazard'])},\n"
            f"  /** shares of sides that use no sub */\n  noSub: {{ batFirst: {out['noSub']['batFirst']:.4f}, chase: {out['noSub']['chase']:.4f} }},\n"

            "} as const;\n")
        print("wrote", OUT_TS, OUT_REPORT)


if __name__ == "__main__":
    main()
