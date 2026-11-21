"""
The wicket hazard by the state of the innings, the engine against Cricsheet ball by ball (docs/TACTICS.md section 11, "The innings shape").

The engine's chance of a wicket depends on the state of a T20 innings through hand-set and fitted terms that act together (the chase
adjustment's pressure and wickets-down terms in match.ts, the wickets-in-hand table and the innings clock in a first innings, the league
levels). Held to the same striker (his rating bin and balls faced) and the same competition, a real wicket comes as often as the engine's in
some states and less often in others: in a first innings the engine loses too many wickets with three to six down in the middle overs, and in
a chase it loses too many under a high required rate and too few when the chase is comfortable. Wickets per innings stay where the league
levels put them; how they are spread across innings moves, and with it the share of innings that end all out.

A log multiplier on the wicket class per state cell, pooled over the nine men's leagues: a first innings by over band (1-6, 7-11, 12-15,
16-18, 19-20) x wickets down (0-2, 3-4, 5-6, 7-8, 9), a chase by required-rate pressure ((required rate - current rate) / 8, the chase
adjustment's own measure: <= -0.25, -0.25-0, 0-0.25, 0.25-0.5, 0.5-1, 1+) x wickets down. Fitted by maximum likelihood (Bernoulli, a ball's
wicket against the engine's own rate in the same cell, competition, striker rating bin and balls-faced bin), a wickets-down main effect plus
a ridge-shrunk cell effect, then made neutral per competition and innings over the engine's own balls (each league's wickets per innings
stay where they were). Fit to the end of 2024 (from 2021), judged on 2025+; the ridge chosen by fitting to 2023 and scoring 2024.

Real: the work.duckdb `dw` table of t20-wicket-timing.py build (full matches). Sim: last-pair-collect.test.ts LP_LEAGUES=1 LP_MIN_WK=0 csvs.
Run from packages/ratings (needs the `duckdb` CLI, numpy and scipy):
    python3 -I src/analysis/state-wickets.py fit work.duckdb simdir [--prev docs/data/state_wickets.json] [--write]
With --prev (the sim collected with that table in play) the fit is a multiplicative update of it (one more step of the same fit).
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.optimize import minimize

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
REPO = ROOT.parent.parent
OUT_JSON = REPO / "docs" / "data" / "state_wickets.json"
OUT_TS = REPO / "packages" / "engine" / "src" / "state-wickets-data.ts"
LEAGUES = ["ipl", "bbl", "psl", "sa20", "cpl", "ilt20", "mlc", "bpl", "lpl"]
WG = ["0-2", "3-4", "5-6", "7-8", "9"]
OB = ["1-6", "7-11", "12-15", "16-18", "19-20"]
PB = ["<=-0.25", "-0.25-0", "0-0.25", "0.25-0.5", "0.5-1", "1+"]
PB_EDGES = [-0.25, 0.0, 0.25, 0.5, 1.0]
# the chase's state: required-rate pressure x the over band (shipped), or either alone (candidates: --chase pressure|over)
CHASE_STATE = sys.argv[sys.argv.index("--chase") + 1] if "--chase" in sys.argv else "both"


def duck(db: Path, sql: str, json_out: bool = False):
    args = ["duckdb", str(db)] + (["-json"] if json_out else []) + ["-c", "SET memory_limit='2GB'; SET threads=3; " + sql]
    p = subprocess.run(args, capture_output=True, text=True, cwd=DATA)
    if p.returncode != 0:
        raise SystemExit(f"duckdb failed: {p.stderr}\n{sql[:800]}")
    return json.loads(p.stdout) if json_out and p.stdout.strip() else []


WGQ = "CASE WHEN wk<=2 THEN 0 WHEN wk<=4 THEN 1 WHEN wk<=6 THEN 2 WHEN wk<=8 THEN 3 ELSE 4 END"
OBQ = "CASE WHEN over<=5 THEN 0 WHEN over<=10 THEN 1 WHEN over<=14 THEN 2 WHEN over<=17 THEN 3 ELSE 4 END"
PBQ = "CASE WHEN p<=-0.25 THEN 0 WHEN p<=0 THEN 1 WHEN p<=0.25 THEN 2 WHEN p<=0.5 THEN 3 WHEN p<=1 THEN 4 ELSE 5 END"
RBQ = "CASE WHEN srat<0.35 THEN 0 WHEN srat<0.45 THEN 1 WHEN srat<0.55 THEN 2 WHEN srat<0.65 THEN 3 WHEN srat<0.75 THEN 4 ELSE 5 END"
SBQ = "CASE WHEN sballs<=2 THEN 0 WHEN sballs<=9 THEN 1 WHEN sballs<=19 THEN 2 ELSE 3 END"


def load(db: Path, simdir: Path):
    CHQ = {"pressure": PBQ, "over": OBQ, "both": f"(({PBQ})*5 + ({OBQ}))"}[CHASE_STATE]
    comps = ", ".join(f"'{c}'" for c in LEAGUES)
    duck(db, f"""
SET threads=1;
CREATE OR REPLACE TABLE sw_sim AS SELECT row_number() OVER () AS seq, * EXCLUDE(tag, match), tag AS comp, match AS match_id
 FROM read_csv('{simdir}/sim-*.csv', union_by_name=true, header=true, types={{'srat':'DOUBLE','nrat':'DOUBLE','cls':'VARCHAR'}}) WHERE tag IN ({comps});
SET threads=3;
CREATE OR REPLACE TABLE sw_src AS
WITH src AS (
  SELECT 'real' AS who, comp, match_id, innings, seq, over, legal_before_in_over, sballs, wides, runs_total, is_wicket, wk, srat,
    CASE WHEN date<=DATE '2023-12-31' THEN 'a' WHEN date<=DATE '2024-12-31' THEN 'b' ELSE 'h' END AS half
  FROM dw WHERE comp IN ({comps}) AND date>=DATE '2021-01-01'
  UNION ALL SELECT 'sim', comp, match_id, innings, seq, over, legal_before_in_over, sballs, wides, runs_total, is_wicket, wk, srat, 's' FROM sw_sim),
tgt AS (SELECT who, comp, match_id, sum(runs_total)+1 AS target FROM src WHERE innings=1 GROUP BY ALL),
c AS (SELECT s.*, t.target,
  coalesce(sum(runs_total) OVER (PARTITION BY s.who, s.comp, s.match_id, s.innings ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS score,
  over*6+legal_before_in_over AS bb FROM src s LEFT JOIN tgt t USING (who, comp, match_id)),
d AS (SELECT *, CASE WHEN innings<>2 OR bb>=120 OR target-score<=0 THEN NULL
  ELSE ((target-score)*6.0/(120-bb) - CASE WHEN bb>0 THEN score*6.0/bb ELSE 0 END)/8 END AS p FROM c WHERE wides=0 AND srat IS NOT NULL AND over<20)
SELECT who, half, comp, innings, CASE WHEN innings=1 THEN {OBQ} ELSE {CHQ} END AS st, {WGQ} AS wg, {RBQ} AS rb, {SBQ} AS sb,
  count(*)::DOUBLE n, sum(is_wicket)::DOUBLE w
FROM d WHERE innings=1 OR p IS NOT NULL GROUP BY ALL;
""")
    rows = duck(db, "SELECT * FROM sw_src", True)
    return rows


def cells(rows, inn):
    """real groups per half and the sim's rate in the same (comp, state, wg, rb, sb), smoothed toward its (comp, state, wg) rate"""
    sim = {}
    par = {}
    for r in rows:
        if r["who"] != "sim" or r["innings"] != inn:
            continue
        k = (r["comp"], r["st"], r["wg"], r["rb"], r["sb"])
        a = sim.setdefault(k, [0.0, 0.0]); a[0] += r["n"]; a[1] += r["w"]
        b = par.setdefault(k[:3], [0.0, 0.0]); b[0] += r["n"]; b[1] += r["w"]
    real = {}
    for r in rows:
        if r["who"] != "real" or r["innings"] != inn:
            continue
        k = (r["comp"], r["st"], r["wg"], r["rb"], r["sb"])
        if k[:3] not in par:
            continue
        a = real.setdefault((r["half"],) + k, [0.0, 0.0]); a[0] += r["n"]; a[1] += r["w"]

    def q(k):
        pn, pw = par[k[:3]]
        sn, sw = sim.get(k, [0.0, 0.0])
        prior = 20.0
        return max((sw + prior * max(pw, 0.5) / pn) / (sn + prior), 1e-4)

    out = {}
    for (h, *k), (n, w) in real.items():
        k = tuple(k)
        out.setdefault(h, []).append((k, n, w, q(k)))
    simg = [(k, n, q(k)) for k, (n, _w) in sim.items()]
    return out, simg


def unpack(x, nst):
    u = x[:len(WG)]
    v = x[len(WG):].reshape(nst, len(WG))
    return u[None, :] + v


def fit(groups, nst, lam, lam_u=1.0):
    st = np.array([g[0][1] for g in groups]); wg = np.array([g[0][2] for g in groups])
    n = np.array([g[1] for g in groups]); w = np.array([g[2] for g in groups]); q = np.array([g[3] for g in groups])

    def f(x):
        L = unpack(x, nst)[st, wg]
        m = np.exp(L)
        qm = np.clip(q * m, 1e-9, 0.95)
        ll = w * np.log(qm) + (n - w) * np.log1p(-qm)
        # d/dL: w - (n-w) * qm / (1-qm)
        gL = w - (n - w) * qm / (1 - qm)
        g = np.zeros_like(x)
        np.add.at(g[:len(WG)], wg, gL)
        gv = np.zeros((nst, len(WG)))
        np.add.at(gv, (st, wg), gL)
        g[len(WG):] = gv.ravel()
        pen = 0.5 * lam_u * (x[:len(WG)] ** 2).sum() + 0.5 * lam * (x[len(WG):] ** 2).sum()
        gp = np.concatenate([lam_u * x[:len(WG)], lam * x[len(WG):]])
        return -(ll.sum()) + pen, -g + gp

    x0 = np.zeros(len(WG) + nst * len(WG))
    r = minimize(f, x0, jac=True, method="L-BFGS-B")
    return unpack(r.x, nst)


def scales(L, simg):
    """per competition: the factor that keeps the engine's own wickets in these balls where they were"""
    out = {}
    for c in LEAGUES:
        num = den = 0.0
        for k, n, q in simg:
            if k[0] != c:
                continue
            num += n * q
            den += n * q * np.exp(L[k[1], k[2]])
        if den > 0:
            out[c] = num / den
    return out


def loglik(groups, L, sc):
    """per-ball log likelihood difference (table minus none), its standard error over the balls, the balls"""
    tot = tot2 = N = 0.0
    for k, n, w, q in groups:
        m = np.exp(L[k[1], k[2]]) * sc.get(k[0], 1.0) if L is not None else 1.0
        qm = min(q * m, 0.95)
        d1 = np.log(qm) - np.log(q)
        d0 = np.log1p(-qm) - np.log1p(-q)
        tot += w * d1 + (n - w) * d0
        tot2 += w * d1 ** 2 + (n - w) * d0 ** 2
        N += n
    mu = tot / N
    var = tot2 / N - mu ** 2
    return mu, np.sqrt(var / N), N


def ratio_table(groups, nst, labels):
    """real wickets over the engine's expected, by state x wickets down"""
    R = np.zeros((nst, len(WG))); E = np.zeros((nst, len(WG)))
    for k, n, w, q in groups:
        R[k[1], k[2]] += w; E[k[1], k[2]] += n * q
    for s in range(nst):
        print(f"    {labels[s]:>10s}: " + " ".join(f"{R[s, j] / E[s, j]:5.2f}({int(R[s, j]):4d})" if E[s, j] > 30 else "    -      " for j in range(len(WG))))


def main():
    cmd, db, simdir = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    assert cmd == "fit"
    prev = None
    if "--prev" in sys.argv:
        prev = json.load(open(sys.argv[sys.argv.index("--prev") + 1]))
    rows = load(db, simdir)
    report = {}
    tables = {}
    chase_labels = {"pressure": PB, "over": OB, "both": [f"{p}|{o}" for p in PB for o in OB]}[CHASE_STATE]
    for inn, name, labels in ((1, "first", OB), (2, "chase", chase_labels)):
        nst = len(labels)
        H, simg = cells(rows, inn)
        print(f"\n{name}: real wickets / the engine's expected (wickets), by {'over band' if inn == 1 else 'pressure'} x wickets down {WG}")
        for h, lab in (("a", "2021-23"), ("b", "2024"), ("h", "2025+")):
            print(f"  {lab}:")
            ratio_table(H[h], nst, labels)
        best = None
        for lam in (3, 10, 30, 100, 300, 1000):
            L = fit(H["a"], nst, lam)
            sc = scales(L, simg)
            mu, se, _ = loglik(H["b"], L, sc)
            mh, sh, _ = loglik(H["h"], fit(H["a"] + H["b"], nst, lam), scales(fit(H["a"] + H["b"], nst, lam), simg))
            print(f"  lambda {lam:5d}: 2024 per ball {mu * 1e4:+.3f}e-4 +- {se * 1e4:.3f}e-4  (for reference, fit to 2024 -> 2025+: {mh * 1e4:+.3f}e-4 +- {sh * 1e4:.3f}e-4)")
            if best is None or mu > best[1]:
                best = (lam, mu)
        lam = best[0]
        fitg = H["a"] + H["b"]
        L = fit(fitg, nst, lam)
        sc = scales(L, simg)
        mu_h, se_h, n_h = loglik(H["h"], L, sc)
        mu_f, se_f, n_f = loglik(fitg, L, sc)
        print(f"  chosen lambda {lam}; fit half per ball {mu_f * 1e4:+.3f}e-4 +- {se_f * 1e4:.3f}e-4 ({int(n_f)} balls); "
              f"holdout 2025+ {mu_h * 1e4:+.3f}e-4 +- {se_h * 1e4:.3f}e-4 ({int(n_h)} balls)")
        mult = np.exp(L)
        print("  multipliers (before the per-league factor):")
        for s in range(nst):
            print(f"    {labels[s]:>10s}: " + " ".join(f"{mult[s, j]:.3f}" for j in range(len(WG))))
        print("  per-league factors:", {c: round(v, 3) for c, v in sc.items()})
        # per league holdout
        per = {}
        for c in LEAGUES:
            g = [x for x in H["h"] if x[0][0] == c]
            if g:
                m_, s_, n_ = loglik(g, L, sc)
                per[c] = [round(m_ * 1e4, 3), round(s_ * 1e4, 3), int(n_)]
        print("  holdout per league (1e-4 per ball, se, balls):", per)
        # taken only where it predicted 2024 better at the chosen ridge (fit to 2023): otherwise the table is zero (the engine as it was)
        taken = best[1] > 0
        if not taken:
            print(f"  NOT TAKEN: fitted to 2023 it did not predict 2024 better ({best[1] * 1e4:+.3f}e-4 at its best ridge)")
            L = np.zeros_like(L)
            sc = {c: 1.0 for c in LEAGUES}
        logt = L.copy()
        if prev:
            logt = np.array(prev["log"][name]) + L
            sc = {c: prev["scale"][name].get(c, 1.0) * sc.get(c, 1.0) for c in LEAGUES}
        tables[name] = {"log": np.round(logt, 4).tolist(), "scale": {c: round(v, 4) for c, v in sc.items()}}
        report[name] = dict(taken=bool(taken), lam=lam, score_2024=round(best[1] * 1e4, 3), fit=[round(mu_f * 1e4, 3), round(se_f * 1e4, 3), int(n_f)], holdout=[round(mu_h * 1e4, 3), round(se_h * 1e4, 3), int(n_h)],
                            holdout_per_league=per, step_multipliers=np.round(mult, 3).tolist())
    out = {"bands": {"wickets_down": WG, "first_over": OB, "chase_pressure": PB}, "log": {k: v["log"] for k, v in tables.items()},
           "scale": {k: v["scale"] for k, v in tables.items()}, "report": report, "steps": (prev.get("steps", 1) + 1) if prev else 1}
    if "--write" in sys.argv:
        OUT_JSON.write_text(json.dumps(out, indent=1))
        ts = ["/**",
              " * GENERATED by packages/ratings/src/analysis/state-wickets.py (docs/data/state_wickets.json). Do not edit by hand.",
              " * The wicket hazard by the state of a men's T20 league innings, against the engine: log multipliers [state][wickets down 0-2, 3-4, 5-6, 7-8, 9];",
              " * first innings by over band (1-6, 7-11, 12-15, 16-18, 19-20); a chase by pressure ((required - current rate) / 8: <= -0.25, -0.25-0,",
              " * 0-0.25, 0.25-0.5, 0.5-1, 1+) x the same over bands, row = pressure bin * 5 + over band; and per league the factor that keeps its",
              " * wickets per innings (docs/TACTICS.md section 11).",
              " */",
              "export const STATE_WICKETS_PRESSURE_EDGES: readonly number[] = " + json.dumps(PB_EDGES) + ";",
              "export const STATE_WICKETS: { first: number[][]; chase: number[][]; scale: Record<string, [number, number]> } = {",
              "  first: [" + ", ".join(json.dumps(r) for r in tables["first"]["log"]) + "],",
              "  chase: [" + ", ".join(json.dumps(r) for r in tables["chase"]["log"]) + "],",
              "  scale: { " + ", ".join(f'"{c}": [{tables["first"]["scale"].get(c, 1.0)}, {tables["chase"]["scale"].get(c, 1.0)}]' for c in LEAGUES) + " },",
              "};", ""]
        OUT_TS.write_text("\n".join(ts))
        print("wrote", OUT_JSON, OUT_TS)


if __name__ == "__main__":
    main()
