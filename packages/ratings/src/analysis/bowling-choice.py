"""
Fit the captain's bowling choice (who bowls the next over) on the real over-by-over record of the benchmark matches and write it as a generated
engine table (packages/engine/src/bowling-choice-data.ts) plus a report (docs/data/bowling_choice.json).

Input: the training rows written by `BENCH_TACTICS=1 BENCH_EXPORT=<file> npx vitest run packages/app/src/__tests__/tactics-allocation.test.ts`: for every
match of docs/data/actual_xi.json (full members' T20Is and ODIs since 2019, both genders), each bowling side's eleven with the ratings the engine plays
them on (bowling overall, wicket-taking, accuracy, style, keeper, role) and the bowler of every over (`overs`, ids). Needs numpy and scipy (fitting only;
the engine reads the generated table).

Model. At each over, a conditional logit over the bowlers who may bowl it (those of the innings' attack who have overs left and did not bowl the
previous over). The utility of a bowler is a sum of coefficients of the named features in `features()`: his rating rank in the eleven, his type
(fast / medium pace / spin / slow part-timer) by phase, whether he is one of the two best at the start and the death, overs used and left, the gap since his
last over, overs he has bowled in this phase, whether he is new to the attack. The names are the ones the engine builds (bowling-choice.ts `choiceFeatures`).
Fit on matches to 2024 with a ridge penalty, judged on 2025+ matches against the engine's former rule (one of the top three on rating, uniformly).

    python3 packages/ratings/src/analysis/bowling-choice.py <train.json>
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy.optimize import minimize

REPO = Path(__file__).resolve().parents[4]
OUT_TS = REPO / "packages" / "engine" / "src" / "bowling-choice-data.ts"
OUT_REPORT = REPO / "docs" / "data" / "bowling_choice.json"

FAST = {"right-arm-fast", "right-arm-fast-medium", "left-arm-fast", "left-arm-fast-medium"}
MEDIUM = {"right-arm-medium-fast", "right-arm-medium", "left-arm-medium-fast", "left-arm-medium"}
SPIN = {"off-spin", "left-arm-orthodox", "leg-spin", "left-arm-wrist-spin"}
LAMBDA = {"t20-male": 2.0, "t20-female": 2.0, "odi-male": 2.0, "odi-female": 2.0}
CAPS = {"t20": 4, "odi": 10}


def kind_of(style):
    if style in FAST:
        return "fast"
    if style in MEDIUM:
        return "medium"
    if style in SPIN:
        return "spin"
    return "slow"


def phase_of(fmt, o):
    if fmt == "t20":
        return "pp" if o < 6 else ("mid" if o < 15 else "death")
    return "pp" if o < 10 else ("mid" if o < 30 else ("late" if o < 40 else "death"))


PHASES = {"t20": ["pp", "mid", "death"], "odi": ["pp", "mid", "late", "death"]}


def features(fmt, o, c):
    """Named features of candidate c at over o. c: dict(rank, kind, used, left, gap, phase_used, role_part)"""
    ph = phase_of(fmt, o)
    f = []
    f.append("rank%d" % min(c["rank"], 5))
    ob = o if fmt == "t20" else o // 2
    f.append("%s@%s" % (c["kind"], ph))
    f.append("%s@o%d" % (c["kind"], ob))
    if c["rank"] >= 5 or c["part"]:
        f.append("extra@o%d" % ob)
    if c["rank"] < 2:
        f.append("top2@%s" % ph)
    k2 = "spin" if c["kind"] == "spin" else ("pace" if c["kind"] in ("fast", "medium") else "slow")
    f.append("used%d:%s@%s" % (min(c["used"], 3) if fmt == "t20" else min(c["used"] // 2, 4), k2, ph))
    if c["rank"] >= 5 or c["part"]:
        f.append("xslack%d" % c["slack"])
    # saving pace for the death: choosing this pace bowler now would leave the attack's pace overs short of the death's need
    if c["kind"] in ("fast", "medium") and ph != "death" and c["pace_left"] - 1 < (3 if fmt == "t20" else 6):
        f.append("dshort")
    f.append("gap%s" % ("never" if c["gap"] is None else (c["gap"] if c["gap"] <= 3 else ("4-5" if c["gap"] <= 5 else "6+"))))
    f.append("phaseused%d@%s" % (min(c["phase_used"], 2), ph))
    if c["gap"] is None:
        f.append("new@%s" % ph)
    if c["part"]:
        f.append("parttimer")
    return f


def build(rows, fmt):
    """Choice sets: list of (list of feature-name lists per candidate, chosen index, date)"""
    sets = []
    cap = CAPS[fmt]
    total = 20 if fmt == "t20" else 50
    for r in rows:
        xi = r["xi"]
        overs = r["overs"]
        bowled = [i for i in overs]
        if len(overs) < (15 if fmt == "t20" else 40):
            continue
        ranked = sorted([p for p in xi if (not p["kp"]) or p["role"] == "all-rounder"], key=lambda p: -p["ovr"])
        rank = {p["id"]: i for i, p in enumerate(ranked)}
        byid = {p["id"]: p for p in xi}
        cand_ids = sorted(set(bowled), key=lambda i: rank.get(i, 99))
        if any(i not in byid for i in cand_ids):
            continue
        used = {i: 0 for i in cand_ids}
        last = {i: None for i in cand_ids}
        pused = {i: {} for i in cand_ids}
        prev = None
        for o, ch in enumerate(overs):
            ph = phase_of(fmt, o)
            elig = [i for i in cand_ids if used[i] < cap and i != prev]
            if ch in elig and len(elig) > 1:
                fs = []
                oversleft = total - o
                S = sum(cap - used[j] for j in cand_ids if rank.get(j, 9) < 5 and byid[j]["role"] != "batsman") - oversleft
                pace_left = sum(cap - used[j] for j in cand_ids if rank.get(j, 9) < 5 and byid[j]["role"] != "batsman" and kind_of(byid[j]["style"]) in ("fast", "medium"))
                slack = 0 if S <= 0 else (1 if S <= 2 else (2 if S <= 5 else 3))
                for i in elig:
                    p = byid[i]
                    fs.append(features(fmt, o, dict(
                        rank=rank.get(i, 9), kind=kind_of(p["style"]), used=used[i], left=cap - used[i],
                        gap=None if last[i] is None else o - last[i], phase_used=pused[i].get(ph, 0),
                        part=p["role"] == "batsman", slack=slack, pace_left=pace_left)) + [("left", (cap - used[i]) / cap)])
                sets.append((fs, elig.index(ch), r["date"], [rank.get(i, 9) for i in elig]))
            used[ch] = used.get(ch, 0) + 1
            last[ch] = o
            pused.setdefault(ch, {})[ph] = pused.setdefault(ch, {}).get(ph, 0) + 1
            prev = ch
    return sets


def fit(sets, names):
    idx = {n: k for k, n in enumerate(names)}
    K = len(names)
    # dense per set: matrix (cands x K)
    mats = []
    for fs, ch, d, rk in sets:
        m = np.zeros((len(fs), K))
        for ci, f in enumerate(fs):
            for x in f:
                if isinstance(x, tuple):
                    m[ci, idx[x[0]]] += x[1]
                else:
                    m[ci, idx[x]] += 1
        mats.append(m)
    return mats


def objective(w, mats, chosen, lam, weights=None):
    ll = 0.0
    g = np.zeros_like(w)
    for m, c in zip(mats, chosen):
        u = m @ w
        u -= u.max()
        e = np.exp(u)
        p = e / e.sum()
        ll += u[c] - math.log(e.sum())
        g += m[c] - p @ m
    return -(ll) + lam * (w @ w), -(g) + 2 * lam * w


def loglik(w, mats, chosen):
    ll = 0.0
    for m, c in zip(mats, chosen):
        u = m @ w
        mx = u.max()
        ll += u[c] - mx - math.log(np.exp(u - mx).sum())
    return ll / len(mats)


def old_rule_ll(sets):
    # one of the top three on rating among the eligible, uniformly; others a floor of 0.01
    ll = 0.0
    hit = 0
    for fs, ch, d, rk in sets:
        order = sorted(range(len(rk)), key=lambda i: rk[i])[:3]
        p = (1 - 0.01 * (len(rk) - len(order))) / len(order) if ch in order else 0.01
        ll += math.log(p)
        hit += ch in order
    return ll / len(sets), hit / len(sets)


def main():
    rows_all = json.load(open(sys.argv[1]))
    report = {}
    out = {}
    for fmt, gen in (("t20", "male"), ("t20", "female"), ("odi", "male"), ("odi", "female")):
        rows = [r for r in rows_all if r["key"] == ("t20i" if fmt == "t20" else "odi") + ("-men" if gen == "male" else "-women")]
        name_ = fmt + "-" + gen
        sets = build(rows, fmt)
        names = sorted({(x[0] if isinstance(x, tuple) else x) for s in sets for f in s[0] for x in f})
        mats = fit(sets, names)
        chosen = [s[1] for s in sets]
        fit_i = [i for i, s in enumerate(sets) if s[2] <= "2024-12-31"]
        hold_i = [i for i, s in enumerate(sets) if s[2] >= "2025-01-01"]
        lam = LAMBDA[name_]
        K = len(names)
        mf = [mats[i] for i in fit_i]
        cf = [chosen[i] for i in fit_i]
        res = minimize(objective, np.zeros(K), args=(mf, cf, lam), jac=True, method="L-BFGS-B", options={"maxiter": 300})
        w = res.x
        mh = [mats[i] for i in hold_i]
        ch_ = [chosen[i] for i in hold_i]
        old_fit = old_rule_ll([sets[i] for i in fit_i])
        old_hold = old_rule_ll([sets[i] for i in hold_i])
        uni = float(np.mean([-math.log(len(m)) for m in mh]))
        rep = {
            "choices_fit": len(fit_i), "choices_holdout": len(hold_i),
            "ll_fit_new": round(loglik(w, mf, cf), 4), "ll_holdout_new": round(loglik(w, mh, ch_), 4),
            "ll_fit_old_rule": round(old_fit[0], 4), "ll_holdout_old_rule": round(old_hold[0], 4),
            "top3_hit_holdout": round(old_hold[1], 3), "ll_holdout_uniform": round(uni, 4),
        }
        # refit on everything for the shipped table (fit-half choice of lambda is kept)
        res2 = minimize(objective, w, args=(mats, chosen, lam), jac=True, method="L-BFGS-B", options={"maxiter": 300})
        report[name_] = rep
        out[name_] = {n: round(float(v), 3) for n, v in zip(names, res2.x) if abs(v) > 0.005}
        print(name_, rep)
    OUT_REPORT.write_text(json.dumps({"report": report, "weights": out}, indent=1))
    ts = ["/** Generated by packages/ratings/src/analysis/bowling-choice.py (docs/data/bowling_choice.json). Do not edit. */",
          "export const BOWLING_CHOICE: Record<string, Record<string, number>> = " + json.dumps(out, indent=2) + ";", ""]
    OUT_TS.write_text("\n".join(ts))


if __name__ == "__main__":
    main()
