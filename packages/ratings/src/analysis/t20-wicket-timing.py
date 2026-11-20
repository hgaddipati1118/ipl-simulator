"""
When wickets fall in a men's T20 innings: the engine against Cricsheet ball by ball (docs/TACTICS.md section 6, "When wickets fall").

Real: every delivery of the men's T20 leagues since 2016 (the nine with engine levels; The Hundred left out) and of the T20Is between full members
since 2019, full matches (no overs lost, no DLS or awarded result), with the striker's and the non-striker's batting rating (the game's own ratings,
(battingOvr + timing) / 200; in a T20I with the opposition adjust), the striker's balls faced, the wickets down before the ball and the legal balls
already bowled in the over. Sim: the same rows from the engine (packages/app/src/__tests__/last-pair-collect.test.ts with LP_MIN_WK=0: the leagues'
own squads, LP_LEAGUES; the matches the real XIs played, LP_COLLECT).

Run from packages/ratings (needs the `duckdb` CLI, numpy and scipy):
    python3 -I src/analysis/t20-wicket-timing.py build  work.duckdb                (real table: slow, once)
    python3 -I src/analysis/t20-wicket-timing.py report work.duckdb simdir         (real against sim: wickets down by over, all-outs, hazards)
    python3 -I src/analysis/t20-wicket-timing.py fit    work.duckdb simdir [--write]
"""
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
REPO = ROOT.parent.parent
FIT_END = "2023-12-31"


def _load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "src" / "analysis" / file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


LP = _load("lp", "last-pair.py")


def duck(db: Path, sql: str, json_out: bool = False):
    import subprocess
    args = ["duckdb", str(db)] + (["-json"] if json_out else []) + ["-c", "SET memory_limit='2GB'; SET threads=3; " + sql]
    p = subprocess.run(args, capture_output=True, text=True, cwd=DATA)
    if p.returncode != 0:
        raise SystemExit(f"duckdb failed: {p.stderr}\n{sql[:800]}")
    return json.loads(p.stdout) if json_out and p.stdout.strip() else []

MEN_LEAGUES = ["ipl", "bbl", "psl", "sa20", "cpl", "ilt20", "mlc", "bpl", "lpl"]


def build(db: Path):
    br = LP._load_br()
    if db.exists():
        db.unlink()
    tmp = Path(tempfile.mkdtemp())
    gp = LP.ratings_csv(tmp)
    members = ", ".join(f"'{t}'" for t in LP.FULL_MEMBERS)
    sel = []
    for gid in MEN_LEAGUES:
        events, gender, _ = br.LEAGUES[gid]
        ev = ", ".join("'" + e.replace("'", "''") + "'" for e in events)
        sel.append(f"SELECT match_id,'{gid}' AS comp FROM 'matches.parquet' WHERE event IN ({ev}) AND gender='male' AND date>=DATE '2016-01-01'")
    sel.append(f"SELECT match_id,'t20i-men' FROM 'matches.parquet' WHERE gender='male' AND team_type='international' AND match_type IN ('T20','IT20') AND team1 IN ({members}) AND team2 IN ({members}) AND date>=DATE '2019-01-01'")
    cls = ("CASE WHEN d.wides>0 THEN 'wide' WHEN d.noballs>0 THEN 'noball' WHEN d.is_wicket>0 THEN 'wicket' WHEN d.byes+d.legbyes>0 AND d.runs_batter=0 THEN 'legbye' "
           "WHEN d.runs_batter>=6 THEN '6' WHEN d.runs_batter>=4 THEN '4' WHEN d.runs_batter=0 THEN 'dot' ELSE d.runs_batter::VARCHAR END")
    duck(db, f"""
CREATE TABLE sel AS {" UNION ALL ".join(sel)};
CREATE TABLE full_m AS SELECT match_id FROM 'deliveries.parquet' WHERE innings=2 AND super_over=0 AND match_id IN (SELECT match_id FROM sel)
  GROUP BY 1 HAVING min(inn_target_overs)=20 AND max(inn_target_overs)=20;
CREATE TABLE gp AS SELECT * FROM read_csv('{gp}');
CREATE TABLE pid AS SELECT DISTINCT cricsheet_id, cricinfo_id FROM 'people.parquet';
CREATE TABLE d0 AS
SELECT s.comp,m.date,CASE WHEN m.date<=DATE '{FIT_END}' THEN 'fit' ELSE 'test' END AS half,
 d.match_id,d.innings,d.over,d.ball,d.legal_ball_no,d.batter_id,d.non_striker_id,d.player_out_id,d.runs_batter,d.runs_total,d.wides,d.noballs,d.is_wicket,{cls} AS cls,
 row_number() OVER (PARTITION BY d.match_id,d.innings ORDER BY d.over,d.ball,d.legal_ball_no) AS seq
FROM 'deliveries.parquet' d JOIN sel s USING(match_id) JOIN 'matches.parquet' m USING(match_id)
WHERE d.super_over=0 AND d.innings IN (1,2) AND m.outcome_method IS NULL AND d.match_id IN (SELECT match_id FROM full_m);
CREATE TABLE d1 AS
SELECT *,
 COALESCE(SUM(is_wicket) OVER (PARTITION BY match_id,innings ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS wk,
 COALESCE(SUM(CASE WHEN wides=0 AND noballs=0 THEN 1 ELSE 0 END) OVER (PARTITION BY match_id,innings,over ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS legal_before_in_over,
 COALESCE(SUM((wides=0)::INT) OVER (PARTITION BY match_id,innings,batter_id ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS sballs
FROM d0;
CREATE TABLE arr AS SELECT match_id,innings,pl,row_number() OVER (PARTITION BY match_id,innings ORDER BY first,role) AS pos FROM (
 SELECT match_id,innings,pl,min(seq) AS first,min(role) AS role FROM (
  SELECT match_id,innings,batter_id AS pl,seq,0 AS role FROM d0 UNION ALL SELECT match_id,innings,non_striker_id,seq,1 FROM d0) GROUP BY ALL);
CREATE TABLE dw AS
SELECT d.*, a1.pos AS spos, a2.pos AS npos,
 CASE WHEN d.comp LIKE 't20i%' THEN g1.bat_adj ELSE g1.bat END AS srat,
 CASE WHEN d.comp LIKE 't20i%' THEN g2.bat_adj ELSE g2.bat END AS nrat
FROM d1 d
LEFT JOIN arr a1 ON a1.match_id=d.match_id AND a1.innings=d.innings AND a1.pl=d.batter_id
LEFT JOIN arr a2 ON a2.match_id=d.match_id AND a2.innings=d.innings AND a2.pl=d.non_striker_id
LEFT JOIN pid p1 ON p1.cricsheet_id=d.batter_id LEFT JOIN gp g1 ON g1.cricinfo=p1.cricinfo_id AND g1.g='male'
LEFT JOIN pid p2 ON p2.cricsheet_id=d.non_striker_id LEFT JOIN gp g2 ON g2.cricinfo=p2.cricinfo_id AND g2.g='male';
DROP TABLE d0; DROP TABLE d1;
""")
    print(duck(db, "SELECT comp, half, count(DISTINCT match_id) m, count(*) n, avg((srat IS NOT NULL)::INT) rated FROM dw GROUP BY ALL ORDER BY 1,2", True))


def sim_load(db: Path, simdir: Path):
    duck(db, "DROP TABLE IF EXISTS sims; CREATE TABLE sims AS SELECT * EXCLUDE(tag, match), tag AS comp, match AS match_id FROM read_csv('" + str(simdir / "sim-*.csv")
         + "', union_by_name=true, header=true, types={'srat':'DOUBLE','nrat':'DOUBLE','cls':'VARCHAR'})")


def realsrc(since: str, half: str | None = None) -> str:
    h = f" AND half='{half}'" if half else ""
    return f"(SELECT * FROM dw WHERE date>=DATE '{since}'{h})"


def innings_shape(db: Path, src: str, inn: int = 1) -> dict:
    """Per comp: share of innings reaching k down, mean over (0-based legal-ball index / 6) at which the k-th wicket fell, all out, runs"""
    q = f"""
WITH b AS (SELECT comp, match_id, innings, over, legal_before_in_over, wk, is_wicket, runs_total, wides, noballs FROM {src} WHERE innings={inn}),
w AS (SELECT comp, match_id, wk+1 AS k, min(over + legal_before_in_over/6.0) AS t_at, min(over) AS o_at FROM b WHERE is_wicket=1 GROUP BY ALL),
i AS (SELECT comp, match_id, sum(runs_total) runs, sum(is_wicket) wkts FROM b GROUP BY ALL)
SELECT i.comp, count(*) n, avg(runs) runs, avg(wkts) wkts, avg((wkts>=10)::INT) allout,
 {", ".join(f"avg((wkts>={k})::INT) r{k}" for k in range(1, 11))},
 any_value(wo.late9) late9, any_value(wo.o1) o1, {", ".join(f"any_value(wo.o{k}) o{k}" for k in range(2, 11))}
FROM i JOIN (SELECT comp, {", ".join(f"avg(CASE WHEN k={k} THEN t_at END) o{k}" for k in range(1, 11))}, avg(CASE WHEN k=9 THEN (o_at>=18)::INT END) late9 FROM w GROUP BY 1) wo USING (comp) GROUP BY 1 ORDER BY 1"""
    return {r["comp"]: r for r in duck(db, q, True)}


def cmd_report(db: Path, simdir: Path, since: str = "2021-01-01"):
    sim_load(db, simdir)
    real = innings_shape(db, realsrc(since))
    sim = innings_shape(db, "sims")
    print(f"First innings, real since {since} | sim: all out; runs; wickets; the ninth wicket's over (mean, 0-based, with the ball: 18.5 = halfway through the 19th); ninth wicket in the last two overs")
    mae, n_ = 0.0, 0
    for c in MEN_LEAGUES + ["t20i-men"]:
        if c in real and c in sim:
            r, s_ = real[c], sim[c]
            print(f"  {c:9s} all out {100*r['allout']:5.1f} / {100*s_['allout']:5.1f} | runs {r['runs']:6.1f} / {s_['runs']:6.1f} | wkts {r['wkts']:.2f} / {s_['wkts']:.2f} | 9th wkt over {r['o9']:.2f} / {s_['o9']:.2f} | 9th in overs 19-20 {100*r['late9']:4.1f} / {100*s_['late9']:4.1f}")
            if c != "t20i-men":
                mae += abs(r["allout"] - s_["allout"]); n_ += 1
    print(f"  all-out mean absolute error over the leagues: {100*mae/max(n_,1):.2f} points")
    if "--full" not in sys.argv:
        return
    for c in MEN_LEAGUES + ["t20i-men"]:
        if c not in real or c not in sim:
            continue
        r, s = real[c], sim[c]
        print(f"\n{c}: real {int(r['n'])} innings, runs {r['runs']:.1f} wkts {r['wkts']:.2f} all out {100*r['allout']:.1f}% | sim {int(s['n'])}: runs {s['runs']:.1f} wkts {s['wkts']:.2f} all out {100*s['allout']:.1f}%")
        print("   k:      " + " ".join(f"{k:>11d}" for k in range(1, 11)))
        print("   reach:  " + " ".join(f"{100*r[f'r{k}']:5.1f}/{100*s[f'r{k}']:5.1f}" for k in range(1, 11)))
        print("   over:   " + " ".join(f"{(r[f'o{k}'] or 0):5.2f}/{(s[f'o{k}'] or 0):5.2f}" for k in range(1, 11)))
    # hazard per legal-or-not ball (wides out) by over band x wickets down, pooled (comps re-weighted to the real innings counts)
    bands = "CASE WHEN over<=5 THEN 0 WHEN over<=10 THEN 1 WHEN over<=14 THEN 2 WHEN over<=17 THEN 3 ELSE 4 END"
    wkb = "CASE WHEN wk<=1 THEN '0-1' WHEN wk<=3 THEN '2-3' WHEN wk<=5 THEN '4-5' WHEN wk<=7 THEN '6-7' ELSE '8-9' END"

    def haz(src, extra=""):
        q = f"""SELECT comp, {bands} band, {wkb} wkb, count(*)::DOUBLE n, sum(is_wicket)::DOUBLE w, sum(runs_batter)::DOUBLE rb FROM {src} WHERE innings=1 AND wides=0 {extra} GROUP BY ALL"""
        return duck(db, q, True)

    for label, extra in (("all strikers", ""),):
        R = haz(realsrc(since), extra)
        S = haz("sims", extra)
        ninn_r = {c: real[c]["n"] for c in real}
        ninn_s = {c: sim[c]["n"] for c in sim}
        agg = {}
        for src, rows, nn in (("r", R, ninn_r), ("s", S, ninn_s)):
            for x in rows:
                if x["comp"] == "t20i-men" or x["comp"] not in ninn_r:
                    continue
                wt = 1.0 / float(nn[x["comp"]])
                a = agg.setdefault((src, int(x["band"]), x["wkb"]), [0.0, 0.0, 0.0])
                a[0] += x["n"] * wt; a[1] += x["w"] * wt; a[2] += x["rb"] * wt
        print(f"\nMen's leagues pooled ({label}), first innings, per ball (wides out): wicket rate real/sim  [balls per innings real/sim]")
        for b in range(5):
            row = []
            for wkk in ["0-1", "2-3", "4-5", "6-7", "8-9"]:
                r = agg.get(("r", b, wkk)); s = agg.get(("s", b, wkk))
                if not r or not s:
                    row.append(" " * 26); continue
                row.append(f"{100*r[1]/r[0]:4.1f}/{100*s[1]/s[0]:4.1f} [{r[0]:5.1f}/{s[0]:5.1f}]")
            print(f"  band {b}: " + " | ".join(row))
    # by striker rating bin
    rb = "CASE WHEN srat<0.35 THEN 0 WHEN srat<0.45 THEN 1 WHEN srat<0.55 THEN 2 WHEN srat<0.65 THEN 3 WHEN srat<0.75 THEN 4 ELSE 5 END"
    for src, lab in ((realsrc(since), "real"), ("sims", "sim")):
        rows = duck(db, f"""SELECT {rb} rb, {bands} band, count(*)::DOUBLE n, avg(is_wicket) h, avg(runs_batter) r FROM {src} WHERE innings=1 AND wides=0 AND srat IS NOT NULL AND comp<>'t20i-men' GROUP BY ALL ORDER BY 1,2""", True)
        print(f"\n{lab}: wicket rate by striker rating bin (<.35,.45,.55,.65,.75,+) x band; (n)")
        cur = {}
        for x in rows:
            cur[(int(x["rb"]), int(x["band"]))] = x
        for r_ in range(6):
            print(f"  rb{r_}: " + " ".join(f"{100*cur[(r_,b)]['h']:4.1f}({int(cur[(r_,b)]['n']):6d})" if (r_, b) in cur else " " * 12 for b in range(5)))
    # striker rating by arrival position
    for src, lab in ((realsrc(since), "real"), ("sims", "sim")):
        rows = duck(db, f"""SELECT spos, avg(srat) r, count(*)::DOUBLE n, avg(is_wicket) h FROM {src} WHERE innings=1 AND wides=0 AND srat IS NOT NULL AND comp<>'t20i-men' AND spos<=11 GROUP BY 1 ORDER BY 1""", True)
        print(f"\n{lab}: mean striker rating / wicket rate by arrival position: " + " ".join(f"{int(x['spos'])}:{x['r']:.2f}/{100*x['h']:.1f}" for x in rows))



# ── the innings clock: a log multiplier per over of a first innings and outcome class, fitted against the engine ─────────

CLASSES = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"]
FITTED = ["dot", "1", "2", "4", "6", "wicket"]   # a 3 takes the 2's term; the extras (the bowler's) are the reference
NF = len(FITTED)
OVERS = 20
PHASE_OF = [0] * 6 + [1] * 9 + [2] * 5            # the engine's phases (powerplay 0-5, middle 6-14, death 15-19): its multipliers step there
SLOTS = MEN_LEAGUES + ["t20i-men"]
WKB = "CASE WHEN wk<=1 THEN 0 WHEN wk<=3 THEN 1 WHEN wk<=5 THEN 2 WHEN wk<=7 THEN 3 ELSE 4 END"
RBIN = "CASE WHEN srat<0.35 THEN 0 WHEN srat<0.45 THEN 1 WHEN srat<0.55 THEN 2 WHEN srat<0.65 THEN 3 WHEN srat<0.75 THEN 4 ELSE 5 END"
SETB = "CASE WHEN sballs<=2 THEN 0 WHEN sballs<=9 THEN 1 WHEN sballs<=19 THEN 2 ELSE 3 END"


def clock_counts(db: Path, src: str, where: str = "") -> dict:
    """(comp, over, wkb, rbin, setb) -> class counts, first innings, rated strikers"""
    rows = duck(db, f"""SELECT comp, over, {WKB} wkb, {RBIN} rb, {SETB} sb, cls, count(*)::DOUBLE n FROM {src}
WHERE innings=1 AND srat IS NOT NULL AND over<{OVERS} {where} GROUP BY ALL""", True)
    out: dict = {}
    for r in rows:
        k = (r["comp"], int(r["over"]), int(r["wkb"]), int(r["rb"]), int(r["sb"]))
        a = out.setdefault(k, np.zeros(len(CLASSES)))
        a[CLASSES.index(r["cls"])] += r["n"]
    return out


def clock_design(R: dict, S: dict, prior: float = 2.0):
    """Per slot: real counts [cell, class], the sim's shares [cell, class] (smoothed toward the slot's over), the cell's over"""
    pooled: dict = {}
    for (c, o, *_), v in S.items():
        pooled.setdefault((c, o), np.zeros(len(CLASSES)))
        pooled[(c, o)] += v
    out = {}
    for c in SLOTS:
        keys = sorted(k for k in R if k[0] == c and (c, k[1]) in pooled)
        if not keys:
            continue
        real, sh, ov = [], [], []
        for k in keys:
            base = pooled[(c, k[1])] / pooled[(c, k[1])].sum()
            v = S.get(k, np.zeros(len(CLASSES))) + prior * base
            real.append(R[k]); sh.append(np.maximum(v / v.sum(), 1e-7)); ov.append(k[1])
        out[c] = (np.array(real), np.array(sh), np.array(ov))
    return out


def clock_theta(x: np.ndarray, si: int):
    """[over, fitted class] of slot si: the pooled league term + the slot's offset (the T20I's offset is from the pooled league term too)"""
    t = x.reshape(len(SLOTS) + 1, OVERS, NF)
    return t[0] + t[si + 1]


def second_diff_pen(t: np.ndarray):
    """sum of squared second differences across overs within an engine phase (the engine steps between phases: no penalty across them)"""
    pen, g = 0.0, np.zeros_like(t)
    for o in range(1, OVERS - 1):
        if PHASE_OF[o - 1] == PHASE_OF[o] == PHASE_OF[o + 1]:
            d = t[o - 1] - 2 * t[o] + t[o + 1]
            pen += (d ** 2).sum()
            g[o - 1] += 2 * d; g[o] -= 4 * d; g[o + 1] += 2 * d
    return pen, g


def full_theta(tf: np.ndarray, n: int):
    """[n cells via over, 10 classes] from the fitted classes"""
    th = np.zeros((OVERS, len(CLASSES)))
    for i, c in enumerate(FITTED):
        th[:, CLASSES.index(c)] = tf[:, i]
    th[:, CLASSES.index("3")] = th[:, CLASSES.index("2")]
    return th


def clock_nll(x, design, lam_u, lam_d, lam_s):
    t = x.reshape(len(SLOTS) + 1, OVERS, NF)
    ll = 0.0
    g = np.zeros_like(t)
    for si, c in enumerate(SLOTS):
        if c not in design:
            continue
        real, sh, ov = design[c]
        th = full_theta(t[0] + t[si + 1], OVERS)[ov]
        logit = np.log(sh) + th
        lse = np.log(np.exp(logit).sum(1, keepdims=True))
        ll += (real * (logit - lse)).sum()
        p = np.exp(logit - lse)
        gc = real - real.sum(1, keepdims=True) * p
        gc[:, CLASSES.index("2")] += gc[:, CLASSES.index("3")]
        gs = np.zeros((OVERS, NF))
        for i, cl in enumerate(FITTED):
            np.add.at(gs[:, i], ov, gc[:, CLASSES.index(cl)])
        g[0] -= gs; g[si + 1] -= gs
    pen = lam_u * (t[0] ** 2).sum() + lam_d * (t[1:] ** 2).sum()
    g[0] += 2 * lam_u * t[0]; g[1:] += 2 * lam_d * t[1:]
    for j in range(len(SLOTS) + 1):
        p2, g2 = second_diff_pen(t[j])
        pen += lam_s * p2; g[j] += lam_s * g2
    return -ll + pen, g.ravel()


def clock_fit(design, lam_u, lam_d, lam_s):
    from scipy.optimize import minimize
    x0 = np.zeros((len(SLOTS) + 1) * OVERS * NF)
    res = minimize(clock_nll, x0, args=(design, lam_u, lam_d, lam_s), jac=True, method="L-BFGS-B", options={"maxiter": 3000})
    return res.x


def neutralise(th: np.ndarray, sim_cells) -> np.ndarray:
    """Shift a slot's [over, class] term per class so that over the engine's own first-innings balls each class keeps its share"""
    real_w, sh, ov = sim_cells   # here real_w = the sim's own ball counts per cell
    w = real_w.sum(1)
    base = (w[:, None] * sh).sum(0) / w.sum()
    th = th.copy()
    for _ in range(300):
        logit = np.log(sh) + th[ov]
        pr = np.exp(logit - np.log(np.exp(logit).sum(1, keepdims=True)))
        cur = (w[:, None] * pr).sum(0) / w.sum()
        step = np.log(base / cur)
        for cl in FITTED + ["3"]:
            th[:, CLASSES.index(cl)] += 0.7 * step[CLASSES.index(cl)]
        if np.abs(step).max() < 1e-7:
            break
    return th


def ll_diff(th, cells):
    """Per-ball log-loss difference (term - engine) and its standard error over the balls"""
    real, sh, ov = cells
    logit0 = np.log(sh)
    l0 = logit0 - np.log(np.exp(logit0).sum(1, keepdims=True))
    logit1 = logit0 + th[ov]
    l1 = logit1 - np.log(np.exp(logit1).sum(1, keepdims=True))
    d = l1 - l0
    n = real.sum()
    m = float((real * d).sum() / n)
    var = float((real * d ** 2).sum() / n - m ** 2)
    return float(-(real * l0).sum() / n), -m, float(np.sqrt(max(var, 0) / n))


TEST_TO = "2099-12-31"


def cmd_fit(db: Path, simdir: Path, write: bool, lam_u: float, lam_d: float, lam_s: float, since: str, fit_end: str, test_from: str, only_wicket: bool):
    sim_load(db, simdir)
    S = clock_counts(db, "sims")
    Rf = clock_counts(db, "dw", f"AND date>=DATE '{since}' AND date<=DATE '{fit_end}'")
    Rt = clock_counts(db, "dw", f"AND date>=DATE '{test_from}' AND date<=DATE '{TEST_TO}'")
    df, dt = clock_design(Rf, S), clock_design(Rt, S)
    dsim = clock_design(S, S, prior=0.0)
    global FITTED, NF
    if only_wicket:
        FITTED, NF = ["wicket"], 1
    x = clock_fit(df, lam_u, lam_d, lam_s)
    tables = {}
    tot = {"fit": [0, 0, 0.0], "test": [0, 0, 0.0]}
    print(f"lam_u {lam_u} lam_d {lam_d} lam_s {lam_s}; fit {since}..{fit_end}, test {test_from}+; classes {FITTED}")
    for si, c in enumerate(SLOTS):
        if c not in df:
            continue
        th = neutralise(full_theta(clock_theta(x, si), OVERS), dsim[c])
        tables[c] = th
        line = f"  {c:9s}"
        for name, d in (("fit", df), ("test", dt)):
            if c in d:
                l0, dd, se = ll_diff(th, d[c])
                n = d[c][0].sum()
                line += f" | {name} {int(n):7d} balls: engine {l0:.4f} diff {dd:+.4f} +- {se:.4f}"
                if c != "t20i-men":
                    t = tot[name]; t[0] += dd * n; t[1] += n; t[2] += (se * n) ** 2
        print(line)
        iw = CLASSES.index("wicket")
        print("      wicket x by over: " + " ".join(f"{np.exp(th[o, iw]):.2f}" for o in range(OVERS)))
        if not only_wicket:
            print("      4 x by over:      " + " ".join(f"{np.exp(th[o, CLASSES.index('4')]):.2f}" for o in range(OVERS)))
            print("      6 x by over:      " + " ".join(f"{np.exp(th[o, CLASSES.index('6')]):.2f}" for o in range(OVERS)))
            print("      dot x by over:    " + " ".join(f"{np.exp(th[o, CLASSES.index('dot')]):.2f}" for o in range(OVERS)))
    # any other men's T20: the pooled league term, neutral over the nine leagues' simulated innings together
    allsim = [dsim[c] for c in MEN_LEAGUES if c in dsim]
    pooled_cells = (np.concatenate([a[0] for a in allsim]), np.concatenate([a[1] for a in allsim]), np.concatenate([a[2] for a in allsim]))
    tables["default"] = neutralise(full_theta(x.reshape(len(SLOTS) + 1, OVERS, NF)[0], OVERS), pooled_cells)
    for name, t in tot.items():
        if t[1]:
            print(f"  leagues pooled {name}: diff {t[0] / t[1]:+.4f} +- {np.sqrt(t[2]) / t[1]:.4f} per ball ({int(t[1])} balls)")
    if write:
        ekey = lambda c: "t20i-male" if c == "t20i-men" else "default-male" if c == "default" else c
        out = {ekey(c): [[round(float(v), 4) for v in row] for row in th] for c, th in tables.items()}
        Path(write).write_text(json.dumps({"classes": CLASSES, "lam": [lam_u, lam_d, lam_s], "since": since, "fit_end": fit_end, "tables": out}, indent=1))
        print("wrote", write)
        if "--emit" in sys.argv:
            emit(out, lam_u, lam_d, lam_s, since, fit_end)


OUT_TS = ROOT.parent / "engine" / "src" / "innings-clock-data.ts"
OUT_JSON = REPO / "docs" / "data" / "t20_innings_clock.json"


def emit(out: dict, lam_u, lam_d, lam_s, since, fit_end):
    OUT_JSON.write_text(json.dumps({"classes": CLASSES, "lam": [lam_u, lam_d, lam_s], "since": since, "fit_end": fit_end, "tables": out}, indent=1) + "\n")
    lines = ["/**", " * GENERATED by packages/ratings/src/analysis/t20-wicket-timing.py. Do not edit by hand.", " *",
             " * The innings clock (innings-clock.ts; docs/TACTICS.md section 6): per competition, the log multiplier of each outcome class by the over of a",
             f" * men's T20 first innings, [over 0..19][class: {', '.join(CLASSES)}], fitted on Cricsheet ball by ball {since} to {fit_end} against the engine,",
             " * made neutral in shares over the engine's own innings. Keys: a league id, \"t20i-male\", \"default-male\" (any other men's T20).", " */",
             "export const INNINGS_CLOCK: Record<string, number[][]> = {"]
    for k in sorted(out):
        lines.append(f"  {json.dumps(k)}: [")
        for row in out[k]:
            lines.append("    [" + ", ".join(f"{v:.4f}" for v in row) + "],")
        lines.append("  ],")
    lines.append("};")
    OUT_TS.write_text("\n".join(lines) + "\n")
    print("wrote", OUT_JSON, OUT_TS)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "build":
        build(Path(sys.argv[2]))
    elif cmd == "report":
        cmd_report(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4] if len(sys.argv) > 4 else "2021-01-01")
    elif cmd == "fit":
        arg = lambda n, d: type(d)(sys.argv[sys.argv.index(n) + 1]) if n in sys.argv else d
        TEST_TO = arg("--test-to", TEST_TO)
        cmd_fit(Path(sys.argv[2]), Path(sys.argv[3]), arg("--write", ""), arg("--lam-u", 1.0), arg("--lam-d", 10.0), arg("--lam-s", 30.0),
                arg("--since", "2019-01-01"), arg("--fit-end", FIT_END), arg("--test-from", "2024-01-01"), "--wicket-only" in sys.argv)
