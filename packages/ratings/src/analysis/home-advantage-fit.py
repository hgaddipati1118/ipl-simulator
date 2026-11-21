"""
Fit the leagues' home edge (packages/engine/src/home-advantage.ts; docs/LEAGUES.md, "Home advantage") on the league actual-XI
benchmark's per-match dumps, fit half (2021-24) only, and score it on the 2025+ holdout.

  LEAGUE_BENCH=1 LB_LEAGUES=... LB_REPLAYS=128 LB_HOME='{"<league>":H,...}' LB_DUMP=<dir>/h<H>-r128 npx vitest run packages/app/src/__tests__/league-bench.test.ts
  python3 -I src/analysis/home-advantage-fit.py <dir> r128 0 4 8      (the arms: the home edge every league played at)

Each match with a home side has the engine's P(home side wins) at edge 0 (wins + 1) / (replays + 2). The edge moves the logit by
`beta` per balance point, estimated from the arms (the pooled change of the mean logit per point). Per league: the edge that minimises
the fit half's log loss (Newton on the smooth model) and its standard error (the curvature); then a pooled edge (precision-weighted)
and each league shrunk toward it by the spread the leagues' own estimates show beyond their errors (an empirical-Bayes prior),
floored at 0 (no ground makes its own side worse). Prints the fit-half and holdout loss of the coin-free model at each candidate,
paired per match against edge 0 with standard errors, and the arms' own log loss per league as a check.
"""
import json
import math
import sys
from pathlib import Path

D = Path(sys.argv[1])
TAG = sys.argv[2]
ARMS = [float(a) for a in sys.argv[3:]]
LEAGUES = ["ipl", "psl", "bbl", "sa20", "cpl", "ilt20", "mlc", "hundred-m"]
CLAMP = (0.03, 0.97)
# seasons played in a bubble or hub (home-advantage.py BUBBLE): no side was at home, whatever ground it played at
BUBBLE = {"ipl": ("2021", "2022"), "psl": ("2021",), "cpl": ("2020", "2021")}


def logit(p):
    return math.log(p / (1 - p))


def sig(x):
    return 1 / (1 + math.exp(-x))


def load(h, lg, half):
    f = D / f"h{h:g}-{TAG}-{lg}-{half}.json"
    return json.loads(f.read_text()) if f.exists() else None


def home_rows(rows, lg):
    """per match: (id, real home won 0/1 or None at a neutral ground, sim home-side wins, decided replays, real-winner wins)"""
    out = []
    for m in rows:
        if m["home"] < 0 or m["date"][:4] in BUBBLE.get(lg, ()):
            out.append((m["id"], None, None, m["n"], m["w"]))
            continue
        hw = 1 if m["winner"] == m["sides"][0]["name"] else 0
        sim_home = m["w"] if hw else m["n"] - m["w"]
        out.append((m["id"], hw, sim_home, m["n"], m["w"]))
    return out


def loss_of(p):
    return -math.log(min(CLAMP[1], max(CLAMP[0], p)))


def mean_se(v):
    n = len(v)
    m = sum(v) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in v) / max(1, n - 1))
    return m, sd / math.sqrt(n)


def main():
    data = {}
    for lg in LEAGUES:
        for half in ("fit", "hold"):
            arms = {h: load(h, lg, half) for h in ARMS}
            if any(a is None for a in arms.values()):
                continue
            data[(lg, half)] = {h: home_rows(a, lg) for h, a in arms.items()}
    # beta: logit change per balance point, pooled over every league and both halves (it is an engine property, no real result in it)
    num = den = 0.0
    print("arm logit shift of the mean P(home wins) per point, by league:")
    for lg in LEAGUES:
        rows0 = [r for half in ("fit", "hold") if (lg, half) in data for r in data[(lg, half)][0.0] if r[1] is not None]
        if not rows0:
            continue
        q0 = sum(r[2] for r in rows0) / sum(r[3] for r in rows0)
        parts = []
        for h in ARMS:
            if h == 0:
                continue
            rows = [r for half in ("fit", "hold") if (lg, half) in data for r in data[(lg, half)][h] if r[1] is not None]
            q = sum(r[2] for r in rows) / sum(r[3] for r in rows)
            b = (logit(q) - logit(q0)) / h
            parts.append(f"h {h:g}: P(home) {q0:.3f} -> {q:.3f}, {b:.4f}/pt")
            num += (logit(q) - logit(q0)) * h * len(rows)
            den += h * h * len(rows)
        print(f"  {lg} ({len(rows0)} home matches): " + "; ".join(parts))
    beta = num / den
    print(f"beta (pooled) = {beta:.4f} logit per balance point\n")

    def model_loss(rows, h):
        """per-match loss of the real winner under edge h (neutral matches: the arm-0 estimate)"""
        out = []
        for _, hw, sh, n, w in rows:
            if hw is None:
                out.append(loss_of((w + 1) / (n + 2)))
                continue
            q = sig(logit((sh + 1) / (n + 2)) + beta * h)
            out.append(loss_of(q if hw else 1 - q))
        return out

    # per league MLE on the fit half
    est = {}
    print("league | fit home matches | real home share fit | edge MLE +- se (balance points)")
    for lg in LEAGUES:
        if (lg, "fit") not in data:
            continue
        rows = [r for r in data[(lg, "fit")][0.0] if r[1] is not None]
        if not rows:
            continue
        h = 0.0
        for _ in range(30):
            g = H = 0.0
            for _, hw, sh, n, w in rows:
                q = sig(logit((sh + 1) / (n + 2)) + beta * h)
                g += beta * (hw - q)           # d loglik / dh
                H += beta * beta * q * (1 - q)  # -d2 loglik / dh2
            h += g / H
        est[lg] = (h, 1 / math.sqrt(H), len(rows), sum(r[1] for r in rows) / len(rows))
        print(f"{lg} | {len(rows)} | {est[lg][3]:.3f} | {h:+.2f} +- {est[lg][1]:.2f}")
    # pooled and shrunk (empirical Bayes)
    w = {lg: 1 / s ** 2 for lg, (h, s, _, _) in est.items()}
    h0 = sum(w[lg] * est[lg][0] for lg in est) / sum(w.values())
    se0 = 1 / math.sqrt(sum(w.values()))
    var_b = sum((est[lg][0] - h0) ** 2 for lg in est) / (len(est) - 1)
    tau2 = max(0.0, var_b - sum(s ** 2 for _, s, _, _ in est.values()) / len(est))
    print(f"\npooled edge {h0:+.2f} +- {se0:.2f}; between-league sd beyond noise: {math.sqrt(tau2):.2f}")
    shrunk = {lg: max(0.0, h0 + (est[lg][0] - h0) * tau2 / (tau2 + est[lg][1] ** 2)) for lg in est}
    print("shrunk per league (floored at 0): " + ", ".join(f"{lg} {v:.2f}" for lg, v in shrunk.items()))
    pooled_pos = {lg: max(0.0, h0) for lg in est}

    # candidates on both halves, paired per match against edge 0
    own = {lg: max(0.0, est[lg][0]) for lg in est}
    cands = {"pooled": pooled_pos, "shrunk": shrunk, "own (each league's fit-half estimate, floored at 0; exploratory)": own}
    for name, hs in cands.items():
        print(f"\n{name}: " + ", ".join(f"{lg} {v:.2f}" for lg, v in hs.items()))
        for half in ("fit", "hold"):
            allb, alla = [], []
            for lg in LEAGUES:
                if (lg, half) not in data:
                    continue
                rows = data[(lg, half)][0.0]
                b = model_loss(rows, 0.0)
                a = model_loss(rows, hs.get(lg, 0.0))
                allb += b
                alla += a
                d = [x - y for x, y in zip(a, b)]
                m, se = mean_se(d)
                print(f"  {half} {lg}: {len(rows)} matches, {mean_se(b)[0]:.4f} -> {mean_se(a)[0]:.4f}, paired {m:+.4f} +- {se:.4f}")
            d = [x - y for x, y in zip(alla, allb)]
            m, se = mean_se(d)
            print(f"  {half} ALL: {len(allb)} matches, {mean_se(allb)[0]:.4f} -> {mean_se(alla)[0]:.4f}, paired {m:+.4f} +- {se:.4f}")

    # the arms themselves (the engine played at each edge in every league), paired against arm 0
    print("\narms as played (log loss per match, paired against edge 0):")
    for half in ("fit", "hold"):
        for h in ARMS:
            if h == 0:
                continue
            allb, alla = [], []
            line = []
            for lg in LEAGUES:
                if (lg, half) not in data:
                    continue
                b = [loss_of((r[4] + 1) / (r[3] + 2)) for r in data[(lg, half)][0.0]]
                a = [loss_of((r[4] + 1) / (r[3] + 2)) for r in data[(lg, half)][h]]
                allb += b
                alla += a
                m, se = mean_se([x - y for x, y in zip(a, b)])
                line.append(f"{lg} {m:+.4f}")
            m, se = mean_se([x - y for x, y in zip(alla, allb)])
            print(f"  {half} h {h:g}: ALL {m:+.4f} +- {se:.4f} | " + ", ".join(line))


main()
