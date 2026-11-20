"""
Fit who joins the bowling attack and who bowls each over of a men's T20 innings, over the whole eleven (docs/TACTICS.md section 8),
and write it as a generated engine table (packages/engine/src/bowling-attack-data.ts) plus a report (docs/data/bowling_attack.json).

The captain's choice model of section 1 (bowling-choice.py) was fitted over the bowlers who did bowl in the innings (the attack known in
advance), so who joins the attack and when a sixth or seventh bowler comes on was left to a hand rule (Team.autoBowlingOrder). Here
the choice set of every over is every player of the eleven who may bowl it (keepers apart, as the rank is), so the same conditional logit
also decides when a new bowler is brought on, by his rating and type and by the match state: overs and wickets of the innings, the run
rate, how many bowlers have been used, his own last over and wickets.

Input:
  league rows:  LXI_TRAIN=<file> npx vitest run packages/app/src/__tests__/league-xi.test.ts -t "training rows"
  T20I rows:    BENCH_TACTICS=1 BENCH_ONLY=t20i-men BENCH_REPLAYS=0 BENCH_EXPORT=<file> npx vitest run packages/app/src/__tests__/tactics-allocation.test.ts
  per-over runs and wickets: docs/data/bowling_overs.json (packages/ratings/src/pipeline/generate-bowling-overs.ts)

    python3 -I packages/ratings/src/analysis/bowling-attack.py <league.json> <t20i.json> [--write]

Fit on innings to the end of 2024 (ridge penalty chosen by fitting to 2023 and scoring 2024), judged on 2025+, against the section-1
model on the same full-eleven choice sets. Needs numpy and scipy.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
import scipy.sparse as sp
from scipy.optimize import minimize

REPO = Path(__file__).resolve().parents[4]
OUT_TS = REPO / "packages" / "engine" / "src" / "bowling-attack-data.ts"
OUT_REPORT = REPO / "docs" / "data" / "bowling_attack.json"
OVERS = REPO / "docs" / "data" / "bowling_overs.json"
CHOICE = REPO / "docs" / "data" / "bowling_choice.json"

FAST = {"right-arm-fast", "right-arm-fast-medium", "left-arm-fast", "left-arm-fast-medium"}
MEDIUM = {"right-arm-medium-fast", "right-arm-medium", "left-arm-medium-fast", "left-arm-medium"}
SPIN = {"off-spin", "left-arm-orthodox", "leg-spin", "left-arm-wrist-spin"}
CAP = 4
TOTAL = 20


def kind_of(style):
    if not style or style == "unknown":
        return "medium"
    if style in FAST:
        return "fast"
    if style in MEDIUM:
        return "medium"
    if style in SPIN:
        return "spin"
    return "slow"


def phase_of(o):
    return "pp" if o < 6 else ("mid" if o < 15 else "death")


def bin_(x, edges):
    """index of the first edge x is below (len(edges) if none)"""
    for k, e in enumerate(edges):
        if x < e:
            return k
    return len(edges)


def base_features(o, c):
    """The section-1 features (bowling-choice.py `features`, T20), names as the engine builds them"""
    ph = phase_of(o)
    f = ["rank%d" % min(c["rank"], 5), "%s@%s" % (c["kind"], ph), "%s@o%d" % (c["kind"], o)]
    extra = c["rank"] >= 5 or c["part"]
    if extra:
        f.append("extra@o%d" % o)
    if c["rank"] < 2:
        f.append("top2@%s" % ph)
    k2 = "spin" if c["kind"] == "spin" else ("pace" if c["kind"] in ("fast", "medium") else "slow")
    f.append("used%d:%s@%s" % (min(c["used"], 3), k2, ph))
    if extra:
        f.append("xslack%d" % c["slack"])
    if c["kind"] in ("fast", "medium") and ph != "death" and c["pace_left"] - 1 < 3:
        f.append("dshort")
    g = c["gap"]
    f.append("gap%s" % ("never" if g is None else (g if g <= 3 else ("4-5" if g <= 5 else "6+"))))
    f.append("phaseused%d@%s" % (min(c["phase_used"], 2), ph))
    if g is None:
        f.append("new@%s" % ph)
    if c["part"]:
        f.append("parttimer")
    return f


def attack_features(o, c):
    """The attack terms: the eleven's lower ranks and rating, the attack's size, the match state, the bowler's own day"""
    ph = phase_of(o)
    extra = c["rank"] >= 5 or c["part"]
    f = []
    if c["rank"] >= 6:
        f.append("rank%d" % min(c["rank"], 8))
    if extra:
        f.append("xlvl%d" % bin_(c["ovr"], [30, 40, 50, 60]))
        f.append("xwd%d" % bin_(c["wkts"], [2, 4, 6]))
        if c["inn"] == 2:
            f.append("x2nd")
        if o >= 3:
            f.append("xrr%d" % bin_(c["rr"], [7, 8.5, 10]))
    if c["gap"] is None:
        # he would be the n-th bowler of the innings
        f.append("newk%d@%s" % (min(max(c["nused"] + 1, 5), 8), ph))
    else:
        f.append("last%d" % bin_(c["last_runs"], [7, 11, 15]))
        f.append("econ%d" % bin_(c["runs"] / max(1, c["used"]), [7, 9, 11]))
        if c["wk"] > 0:
            f.append("wk%d" % min(c["wk"], 2))
    return f


def build(rows, overs_of, with_attack=True):
    """Choice sets over the eleven: (feature lists per candidate, chosen index, date, key)"""
    sets = []
    for r in rows:
        ov = overs_of(r)
        if ov is None or len(ov) < 15:
            continue
        xi = r["xi"]
        byid = {p["id"]: p for p in xi}
        ranked = sorted([p for p in xi if (not p["kp"]) or p["role"] == "all-rounder"], key=lambda p: (-p["ovr"], p["id"]))
        rank = {p["id"]: i for i, p in enumerate(ranked)}
        pool = [p["id"] for p in ranked]
        if any(o[0] is None or o[0] not in byid for o in ov):
            continue
        if any(o[0] not in rank for o in ov):
            continue  # a keeper bowled (rare): out of the choice sets, as the engine's rank leaves keepers out
        front = [i for i in pool if rank[i] < 5 and byid[i]["role"] != "batsman"]
        used = {i: 0 for i in pool}
        runs = {i: 0 for i in pool}
        wk = {i: 0 for i in pool}
        last = {i: None for i in pool}
        lastr = {i: 0 for i in pool}
        pused = {i: {} for i in pool}
        prev = None
        tot_r = 0
        tot_w = 0
        nused = 0
        for o, (ch, r_, w_) in enumerate(ov):
            ph = phase_of(o)
            elig = [i for i in pool if used[i] < CAP and i != prev]
            if ch in elig and len(elig) > 1:
                S = sum(CAP - used[j] for j in front) - (TOTAL - o)
                pace_left = sum(CAP - used[j] for j in front if kind_of(byid[j]["style"]) in ("fast", "medium"))
                slack = 0 if S <= 0 else (1 if S <= 2 else (2 if S <= 5 else 3))
                fs = []
                for i in elig:
                    p = byid[i]
                    c = dict(rank=rank[i], kind=kind_of(p["style"]), used=used[i], gap=None if last[i] is None else o - last[i],
                             phase_used=pused[i].get(ph, 0), part=p["role"] == "batsman", slack=slack, pace_left=pace_left,
                             ovr=p["ovr"], wkts=tot_w, inn=r["inn"], rr=tot_r / max(1, o), nused=nused, last_runs=lastr[i], runs=runs[i], wk=wk[i])
                    f = base_features(o, c) + (attack_features(o, c) if with_attack else [])
                    fs.append(f + [("left", (CAP - used[i]) / CAP)])
                sets.append((fs, elig.index(ch), r["date"], r["key"]))
            if used[ch] == 0:
                nused += 1
            used[ch] += 1
            runs[ch] += r_
            wk[ch] += w_
            lastr[ch] = r_
            last[ch] = o
            pused[ch][ph] = pused[ch].get(ph, 0) + 1
            prev = ch
            tot_r += r_
            tot_w += w_
    return sets


class Design:
    def __init__(self, sets, names):
        idx = {n: k for k, n in enumerate(names)}
        rows, cols, vals = [], [], []
        starts = []
        chosen = []
        n = 0
        for fs, ch, _, _ in sets:
            starts.append(n)
            chosen.append(n + ch)
            for f in fs:
                for x in f:
                    nm, v = (x if isinstance(x, tuple) else (x, 1.0))
                    if nm in idx:
                        rows.append(n)
                        cols.append(idx[nm])
                        vals.append(v)
                n += 1
        self.X = sp.csr_matrix((np.array(vals), (np.array(rows), np.array(cols))), shape=(n, len(names)))
        self.starts = np.array(starts)
        self.chosen = np.array(chosen)
        self.group = np.repeat(np.arange(len(starts)), np.diff(np.append(self.starts, n)))
        self.n = len(starts)

    def ll(self, w):
        u = self.X @ w
        mx = np.maximum.reduceat(u, self.starts)
        e = np.exp(u - mx[self.group])
        s = np.add.reduceat(e, self.starts)
        lse = mx + np.log(s)
        p = e / s[self.group]
        return float(u[self.chosen].sum() - lse.sum()), p

    def obj(self, w, lam):
        ll, p = self.ll(w)
        g = np.asarray(self.X[self.chosen].sum(axis=0)).ravel() - self.X.T @ p
        return -ll + lam * (w @ w), -g + 2 * lam * w


def fit(sets, names, lam):
    d = Design(sets, names)
    res = minimize(d.obj, np.zeros(len(names)), args=(lam,), jac=True, method="L-BFGS-B", options={"maxiter": 2000})
    return res.x


def score(sets, names, w):
    d = Design(sets, names)
    return d.ll(w)[0] / d.n


def eligible_rows(rows, start, end):
    """Full innings (19+ overs) in [start, end] whose every over is in the choice sets (the allocation table's innings)"""
    out = []
    for r in rows:
        ov = r["_ov"]
        if not ov or len(ov) < 19 or not (start <= r["date"] <= end) or any(o[0] is None for o in ov):
            continue
        ok = {p["id"] for p in r["xi"] if (not p["kp"]) or p["role"] == "all-rounder"}
        if all(o[0] in ok for o in ov):
            out.append(r)
    return out


def allocation(seqs, rows):
    """bowlers used, share using 6+ and 7+, overs by bowlers rated under 50 (section 7's table)"""
    n = len(seqs)
    u = [len(set(s)) for s in seqs]
    pt = sum(sum(1 for i in s if {p["id"]: p for p in r["xi"]}[i]["ovr"] < 50) for s, r in zip(seqs, rows))
    return dict(used=round(sum(u) / n, 3), six=round(sum(x >= 6 for x in u) / n, 3), seven=round(sum(x >= 7 for x in u) / n, 3), pt=round(pt / n, 3))


def forward(rows, W, seed, overs_pool):
    """Play each innings' eleven forward with the model (over runs and wickets drawn from the real overs of that index)"""
    import random
    rng = random.Random(seed)
    seqs = []
    for r in rows:
        xi = r["xi"]
        byid = {p["id"]: p for p in xi}
        ranked = sorted([p for p in xi if (not p["kp"]) or p["role"] == "all-rounder"], key=lambda p: (-p["ovr"], p["id"]))
        rank = {p["id"]: i for i, p in enumerate(ranked)}
        pool = [p["id"] for p in ranked]
        front = [i for i in pool if rank[i] < 5 and byid[i]["role"] != "batsman"]
        used = {i: 0 for i in pool}
        runs = dict(used)
        wk = dict(used)
        lastr = dict(used)
        last = {i: None for i in pool}
        pused = {i: {} for i in pool}
        prev = None
        tr = tw = nu = 0
        seq = []
        for o in range(TOTAL):
            ph = phase_of(o)
            elig = [i for i in pool if used[i] < CAP and i != prev]
            S = sum(CAP - used[j] for j in front) - (TOTAL - o)
            pl = sum(CAP - used[j] for j in front if kind_of(byid[j]["style"]) in ("fast", "medium"))
            sl = 0 if S <= 0 else (1 if S <= 2 else (2 if S <= 5 else 3))
            us = []
            for i in elig:
                p = byid[i]
                c = dict(rank=rank[i], kind=kind_of(p["style"]), used=used[i], gap=None if last[i] is None else o - last[i], phase_used=pused[i].get(ph, 0),
                         part=p["role"] == "batsman", slack=sl, pace_left=pl, ovr=p["ovr"], wkts=tw, inn=r["inn"], rr=tr / max(1, o), nused=nu,
                         last_runs=lastr[i], runs=runs[i], wk=wk[i])
                us.append(sum(W.get(x, 0.0) for x in base_features(o, c) + attack_features(o, c)) + W.get("left", 0.0) * (CAP - used[i]) / CAP)
            m = max(us)
            e = [math.exp(u - m) for u in us]
            x = rng.random() * sum(e)
            k = 0
            while k < len(e) - 1 and x > e[k]:
                x -= e[k]
                k += 1
            ch = elig[k]
            r_, w_ = overs_pool[o][rng.randrange(len(overs_pool[o]))]
            if used[ch] == 0:
                nu += 1
            used[ch] += 1
            runs[ch] += r_
            wk[ch] += w_
            lastr[ch] = r_
            last[ch] = o
            pused[ch][ph] = pused[ch].get(ph, 0) + 1
            prev = ch
            tr += r_
            tw += w_
            seq.append(ch)
        seqs.append(seq)
    return seqs


# The offsets the forward calibration moves: the sixth bowler's entry, the seventh's and later, and extras rated under 50
CALIB = {"a6": lambda n: n.startswith("newk6@"), "a7": lambda n: n.startswith("newk7@") or n.startswith("newk8@"), "apt": lambda n: n in ("xlvl0", "xlvl1", "xlvl2")}


def with_offsets(W, names, a):
    W2 = dict(W)
    for key, sel in CALIB.items():
        for n in names:
            if sel(n):
                W2[n] = W2.get(n, 0.0) + a[key]
    return W2


def calibrate(W, names, rows, overs_pool, replays=2):
    """Moment matching on the fit half: the offsets that make the forward-played elevens use a sixth and a seventh bowler and bowl
    part-timers' overs as often as the real ones did (the per-over fit is calibrated on the real histories, but played forward its
    choices compound: it brings on a sixth and seventh bowler more often than real captains, who plan the twenty overs)"""
    real = allocation([[o[0] for o in r["_ov"]] for r in rows], rows)
    target = np.array([real["six"], real["seven"], real["pt"] / 4])
    keys = list(CALIB)
    a = {k: 0.0 for k in keys}

    def moments(a):
        sims = []
        for k in range(replays):
            sims.append(allocation(forward(rows, with_offsets(W, names, a), 1000 + k, overs_pool), rows))
        return np.array([np.mean([s["six"] for s in sims]), np.mean([s["seven"] for s in sims]), np.mean([s["pt"] for s in sims]) / 4])

    for it in range(8):
        m = moments(a)
        print("  calibrate", it, {k: round(v, 3) for k, v in a.items()}, "moments", np.round(m, 3), "target", np.round(target, 3))
        if np.max(np.abs(m - target)) < 0.005:
            break
        J = np.zeros((3, 3))
        for j, k in enumerate(keys):
            b = dict(a)
            b[k] += 0.15
            J[:, j] = (moments(b) - m) / 0.15
        step = np.linalg.lstsq(J, target - m, rcond=None)[0]
        for j, k in enumerate(keys):
            a[k] += float(np.clip(step[j], -1.0, 1.0))
    return a, real


def main():
    league = json.load(open(sys.argv[1]))
    t20i = json.load(open(sys.argv[2]))
    write = "--write" in sys.argv
    OV = json.load(open(OVERS))
    for r in t20i:
        r["key"] = "t20i"
        o = (OV["t20i"].get(r["id"]) or {}).get("ab"[r["side"]])
        r["inn"] = o["inn"] if o else 1
        # ids from actual_xi's bowl list, runs and wickets from bowling_overs (the same overs: generate-bowling-overs.ts)
        r["_ov"] = [[i, x[1], x[2]] for i, x in zip(r["overs"], o["overs"])] if o and len(o["overs"]) == len(r["overs"]) else None
    for r in league:
        r["_ov"] = r["overs"]
    old = json.load(open(CHOICE))["weights"]["t20-male"]
    report = {}
    tables = {}
    for name, rows in (("league", league), ("t20i", t20i)):
        sets = build(rows, lambda r: r["_ov"])
        base_sets = build(rows, lambda r: r["_ov"], with_attack=False)
        fit_i = [k for k, s in enumerate(sets) if s[2] <= "2024-12-31"]
        hold_i = [k for k, s in enumerate(sets) if s[2] >= "2025-01-01"]
        names = sorted({(x[0] if isinstance(x, tuple) else x) for k in fit_i for f in sets[k][0] for x in f})
        # ridge strength: fit to 2023, score 2024
        tr = [sets[k] for k in fit_i if sets[k][2] <= "2023-12-31"]
        va = [sets[k] for k in fit_i if sets[k][2] >= "2024-01-01"]
        best = None
        for lam in (0.3, 1, 3, 10, 30):
            w = fit(tr, names, lam)
            s = score(va, names, w)
            print(name, "lambda", lam, "2024 ll/choice %.4f" % s)
            if best is None or s > best[1]:
                best = (lam, s)
        lam = best[0]
        F = [sets[k] for k in fit_i]
        H = [sets[k] for k in hold_i]
        w = fit(F, names, lam)
        # the section-1 model (fitted on T20Is over the known attack) on the same full-eleven choice sets, and its own refit on these data
        bnames = sorted({(x[0] if isinstance(x, tuple) else x) for k in fit_i for f in base_sets[k][0] for x in f})
        BH = [base_sets[k] for k in hold_i]
        w_old = np.array([old.get(n, 0.0) for n in bnames])
        wb = fit([base_sets[k] for k in fit_i], bnames, lam)
        uni = float(np.mean([-math.log(len(s[0])) for s in H]))
        overs_pool = {}
        for r in rows:
            for o, x in enumerate(r["_ov"] or []):
                overs_pool.setdefault(o, []).append((x[1], x[2]))
        Wd = {n: float(v) for n, v in zip(names, w)}
        Rf = eligible_rows(rows, "2000", "2024-12-31")
        Rh = eligible_rows(rows, "2025-01-01", "2099")
        a, real_fit = calibrate(Wd, names, Rf, overs_pool)
        Wc = with_offsets(Wd, names, a)
        alloc = dict(fit_real=real_fit, fit_uncalibrated=allocation(forward(Rf, Wd, 7, overs_pool), Rf), fit_calibrated=allocation(forward(Rf, Wc, 7, overs_pool), Rf),
                     holdout_real=allocation([[o[0] for o in r["_ov"]] for r in Rh], Rh), holdout_uncalibrated=allocation(forward(Rh, Wd, 7, overs_pool), Rh),
                     holdout_calibrated=allocation(forward(Rh, Wc, 7, overs_pool), Rh), offsets={k: round(v, 3) for k, v in a.items()})
        print(name, alloc)
        wc = np.array([Wc[n] for n in names])
        rep = dict(lam=lam, choices_fit=len(F), choices_holdout=len(H), ll_holdout=round(score(H, names, w), 4), ll_fit=round(score(F, names, w), 4),
                   ll_holdout_calibrated=round(score(H, names, wc), 4), ll_fit_calibrated=round(score(F, names, wc), 4), allocation=alloc,
                   ll_holdout_section1_weights=round(score(BH, bnames, w_old), 4), ll_holdout_section1_features_refit=round(score(BH, bnames, wb), 4),
                   ll_holdout_uniform=round(uni, 4))
        print(name, rep)
        report[name] = rep
        # the shipped table is the fit half's, calibrated (fitted to the end of 2024: the 2025+ benchmarks stay out of sample)
        tables[name] = {n: round(float(Wc[n]), 3) for n in names if abs(Wc[n]) > 0.005}
    if write:
        OUT_REPORT.write_text(json.dumps({"report": report, "weights": tables}, indent=1))
        ts = ["/** Generated by packages/ratings/src/analysis/bowling-attack.py (docs/data/bowling_attack.json). Do not edit. */",
              "export const BOWLING_ATTACK: Record<string, Record<string, number>> = " + json.dumps({"t20-male-league": tables["league"], "t20-male-t20i": tables["t20i"]}, indent=2) + ";", ""]
        OUT_TS.write_text("\n".join(ts))
    else:
        json.dump({"report": report, "weights": tables}, open("/tmp/attack/fit.json", "w"), indent=1)


if __name__ == "__main__":
    main()
