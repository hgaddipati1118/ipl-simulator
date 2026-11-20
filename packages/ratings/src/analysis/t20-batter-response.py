"""
How the T20 ball model answers a batter's rating, refitted from Cricsheet ball by ball (docs/TACTICS.md section 5, "Tail batters").

The ball model's response to the striker's batting rating ((battingOvr + timing) / 200, the engine's `batRating`) was a straight line
through the middle of the order and too shallow at the bottom: numbers 10 and 11 scored and survived too long (men's T20I number 11,
3.9 runs against a real 2.3). This script measures the response on both sides with the same two things held fixed, who is batting
(the game's own ratings) and the phase of the innings, and fits a flexible correction to the engine's own response:

    p'(class k) = p(class k) x exp(s_k(r))          s_k piecewise linear in the batting rating r, no positional term

so a star at number 11 bats like a star and a tail-ender at number 3 like a tail-ender.

Real side (`real`): every ball of the men's T20 leagues, the women's leagues and T20Is between full members (the competitions the
engine has levels for) whose striker the game rates (Cricsheet id -> ESPN id -> data/analysis/game_players.json, the ratings the engine
plays), counted by competition x phase (overs 1-6, 7-15, 16-20; The Hundred's sets as the engine maps them) x rating bin (0.05 wide from
0.20) x outcome class, for two halves: to the end of 2023 (the fit) and 2024 on (the test).
Sim side: the same counts from packages/app/src/__tests__/tail-response.test.ts (TAIL_COLLECT=1).

Fit (`fit`): in each competition x phase the cell's class share relative to the phase's overall share, real over sim, is the
response the engine is missing at that rating; it is regressed (weights = inverse Poisson variances, a small penalty on the second
differences of the knots) on a piecewise-linear function of the rating, with the batter-independent classes (wide, no-ball, bye / leg
bye) as the reference, pooled over competitions and phases within a gender. The correction is centred on the simulated balls (each class's mean log multiplier over the balls the game's own sides play is 0, so a league's
level, its wickets and the tables fitted without it stay where they were). The out-of-sample
check scores the 2024+ counts with the correction fitted on the fit half.

Run from packages/ratings (needs the `duckdb` CLI and numpy):
    python3 -I src/analysis/t20-batter-response.py real  [out_real.json] [--odi]
    python3 -I src/analysis/t20-batter-response.py emit [--odi]   (rewrite the engine file from the json)
    python3 -I src/analysis/t20-batter-response.py fit   real.json sim.json[,sim2.json...] [--write] [--odi]
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
REPO = ROOT.parent.parent
OUT = {"t20": (REPO / "docs" / "data" / "t20_batter_response.json", ROOT.parent / "engine" / "src" / "batter-response-data.ts", "BATTER_RESPONSE"),
       "odi": (REPO / "docs" / "data" / "odi_batter_response.json", ROOT.parent / "engine" / "src" / "odi-batter-response-data.ts", "ODI_BATTER_RESPONSE")}
TMP = Path(tempfile.mkdtemp())
DB = TMP / "br.duckdb"

CLASSES = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"]
PHASES = ["powerplay", "middle", "death"]
BIN0, BINW, NBIN = 0.20, 0.05, 16
FIT_END = "2023-12-31"
# competition group -> (Cricsheet event(s), gender, The Hundred?)
LEAGUES = {
    "ipl": (["Indian Premier League"], "male", False), "bbl": (["Big Bash League"], "male", False),
    "psl": (["Pakistan Super League"], "male", False), "sa20": (["SA20"], "male", False),
    "cpl": (["Caribbean Premier League"], "male", False), "ilt20": (["International League T20"], "male", False),
    "mlc": (["Major League Cricket"], "male", False), "bpl": (["Bangladesh Premier League"], "male", False),
    "lpl": (["Lanka Premier League"], "male", False), "hundred-m": (["The Hundred Men's Competition"], "male", True),
    "wpl": (["Women's Premier League"], "female", False), "wbbl": (["Women's Big Bash League"], "female", False),
    "hundred-w": (["The Hundred Women's Competition"], "female", True),
}
FULL_MEMBERS = ["Afghanistan", "Australia", "Bangladesh", "England", "India", "Ireland", "New Zealand", "Pakistan",
                "South Africa", "Sri Lanka", "West Indies", "Zimbabwe"]
# the knots of the piecewise-linear response (batting rating), and the classes it acts on (the rest are the reference)
KNOTS = [0.25, 0.40, 0.55, 0.70, 0.85]
ACTS = ["dot", "1", "2", "3", "4", "6", "wicket"]
FITTED = ["dot", "1", "2", "4", "6", "wicket"]  # a 3 is too rare to fit alone: it takes the 2's response
EXTRAS = ["wide", "noball", "legbye"]
WICKET_POWER = {"t20": 0.0, "odi": 1.0}  # the fitted wicket row is not applied (docs/TACTICS.md section 5): it moves wickets from the top of the order into the tail and the first-innings all-out share of a men's T20I goes from 12.7% to 15-16% (real 11.5%)
WICKET_OFFSET = {"t20": 0.012, "odi": 0.0}  # added to the wicket row after it is made neutral: 32 simulated seasons of 13 leagues read 0.06 wickets an innings (1%) low with the response in
RESPONSE_POWER = {"t20": {"male": 1.25, "female": 1.5}, "odi": {"male": 1.0, "female": 1.0}}  # the run-class rows are applied to this power per gender
LAMBDA = 1.0  # penalty on the second differences of a class's knot values, relative to the mean information per knot


def run(sql: str) -> list:
    args = ["duckdb", str(DB), "-json", "-c", "SET memory_limit='3GB'; SET threads=6; " + sql]
    p = subprocess.run(args, capture_output=True, text=True, cwd=DATA)
    if p.returncode != 0:
        raise SystemExit(f"duckdb failed: {p.stderr}\n{sql[:600]}")
    rows = json.loads(p.stdout) if p.stdout.strip() else []
    num = re.compile(r"^-?\d+(\.\d+)?$")
    return [{k: (float(v) if isinstance(v, str) and num.match(v) and k not in ("grp", "cls") else v) for k, v in row.items()} for row in rows]


def rating(r: dict, adj: float = 0.0) -> float:
    """r = (battingOvr + timing) / 200, as the ball model reads the striker; `adj` the opposition adjust a national side's batters carry"""
    c = lambda x: max(1.0, min(99.0, x + adj))
    iq, ti, po = c(r["battingIQ"]), c(r["timing"]), c(r["power"])
    ovr = round(iq * 0.30 + ti * 0.30 + po * 0.35 + r["running"] * 0.05)
    return (ovr + ti) / 200


def game_ratings_csv() -> Path:
    """The game's own batting ratings by ESPN id: `bat` in league play, `bat_adj` in a T20I (the opposition adjust of format-ratings.json)"""
    rows = json.loads((DATA / "game_players.json").read_text())
    adjust = json.loads((REPO / "packages" / "app" / "public" / "data" / "format-ratings.json").read_text()).get("adjust", {})
    path = TMP / "gp.csv"
    with open(path, "w") as f:
        f.write("cricinfo,g,bat,bat_adj\n")
        for p in rows:
            if not p["id"].startswith("espn_") or not p["id"][5:].isdigit():
                continue
            a = (adjust.get(p["id"]) or [0])[0]
            f.write(f"{p['id'][5:]},{p['g']},{rating(p['r'])},{rating(p['r'], a)}\n")
    return path


def odi_ratings_csv() -> Path:
    """The batting rating of a player's ODI set (format-ratings.json, `players[espn id][0]`), r = (battingOvr + timing) / 200"""
    file = json.loads((REPO / "packages" / "app" / "public" / "data" / "format-ratings.json").read_text())
    path = TMP / "odi.csv"
    with open(path, "w") as f:
        f.write("cricinfo,bat\n")
        for sid, sets in file["players"].items():
            if not sid.startswith("espn_") or not sid[5:].isdigit() or not sets[0]:
                continue
            iq, ti, po, ru = sets[0][:4]
            f.write(f"{sid[5:]},{(round(iq * 0.30 + ti * 0.30 + po * 0.35 + ru * 0.05) + ti) / 200}\n")
    return path


def real_odi() -> dict:
    """The ODI's cells: international ODIs since 2019, both genders, phases overs 1-10 / 11-40 / 41-50"""
    gp = odi_ratings_csv()
    cls = ("CASE WHEN d.wides > 0 THEN 'wide' WHEN d.noballs > 0 THEN 'noball' WHEN d.is_wicket > 0 THEN 'wicket' "
           "WHEN d.byes + d.legbyes > 0 AND d.runs_batter = 0 THEN 'legbye' WHEN d.runs_batter >= 6 THEN '6' WHEN d.runs_batter >= 4 THEN '4' "
           "WHEN d.runs_batter = 0 THEN 'dot' ELSE d.runs_batter::VARCHAR END")
    run(f"""
CREATE TABLE gp AS SELECT * FROM read_csv('{gp}');
CREATE TABLE b AS
SELECT CASE WHEN m.gender = 'male' THEN 'odi-men' ELSE 'odi-women' END AS grp, CASE WHEN m.date <= DATE '{FIT_END}' THEN 'fit' ELSE 'test' END AS half,
  CASE WHEN d.over < 10 THEN 0 WHEN d.over < 40 THEN 1 ELSE 2 END AS ph,
  LEAST({NBIN - 1}, GREATEST(0, CAST(FLOOR((g.bat - {BIN0}) / {BINW} + 1e-9) AS INTEGER))) AS bin, {cls} AS cls
FROM 'deliveries.parquet' d JOIN 'matches.parquet' m USING (match_id)
JOIN 'people.parquet' p ON p.cricsheet_id = d.batter_id JOIN gp g ON g.cricinfo = p.cricinfo_id
WHERE m.match_type IN ('ODI', 'ODM') AND m.team_type = 'international' AND m.date >= DATE '2019-01-01'
  AND d.super_over = 0 AND m.outcome_method IS NULL AND d.innings <= 2;
""")
    rows = run("SELECT grp, half, ph, bin, cls, count(*) AS n FROM b GROUP BY ALL")
    out: dict = {"bin0": BIN0, "binw": BINW, "nbin": NBIN, "classes": CLASSES, "phases": PHASES, "halves": {}}
    for r in rows:
        cells = out["halves"].setdefault(r["half"], {}).setdefault(r["grp"], [[[0] * len(CLASSES) for _ in range(NBIN)] for _ in PHASES])
        cells[int(r["ph"])][int(r["bin"])][CLASSES.index(r["cls"])] += int(r["n"])
    return out


def real() -> dict:
    gp = game_ratings_csv()
    cls = ("CASE WHEN d.wides > 0 THEN 'wide' WHEN d.noballs > 0 THEN 'noball' WHEN d.is_wicket > 0 THEN 'wicket' "
           "WHEN d.byes + d.legbyes > 0 AND d.runs_batter = 0 THEN 'legbye' WHEN d.runs_batter >= 6 THEN '6' WHEN d.runs_batter >= 4 THEN '4' "
           "WHEN d.runs_batter = 0 THEN 'dot' ELSE d.runs_batter::VARCHAR END")
    members = ", ".join(f"'{t}'" for t in FULL_MEMBERS)
    sel = []
    for gid, (events, gender, hundred) in LEAGUES.items():
        ev = ", ".join("'" + e.replace("'", "''") + "'" for e in events)
        sel.append(f"SELECT match_id, '{gid}' AS grp, {'TRUE' if hundred else 'FALSE'} AS hundred FROM 'matches.parquet' WHERE event IN ({ev}) AND gender = '{gender}' AND date >= DATE '2016-01-01'")
    for g, gender in (("t20i-men", "male"), ("t20i-women", "female")):
        sel.append(f"SELECT match_id, '{g}' AS grp, FALSE AS hundred FROM 'matches.parquet' WHERE gender = '{gender}' AND team_type = 'international' "
                   f"AND match_type IN ('T20', 'IT20') AND team1 IN ({members}) AND team2 IN ({members}) AND date >= DATE '2019-01-01'")
    run(f"""
CREATE TABLE sel AS {" UNION ALL ".join(sel)};
CREATE TABLE gp AS SELECT * FROM read_csv('{gp}');
CREATE TABLE b AS
SELECT s.grp, CASE WHEN m.date <= DATE '{FIT_END}' THEN 'fit' ELSE 'test' END AS half,
  CASE WHEN d.over <= (CASE WHEN s.hundred THEN 4 ELSE 5 END) THEN 0 WHEN d.over <= 14 THEN 1 ELSE 2 END AS ph,
  LEAST({NBIN - 1}, GREATEST(0, CAST(FLOOR((CASE WHEN s.grp LIKE 't20i-%' THEN g.bat_adj ELSE g.bat END - {BIN0}) / {BINW} + 1e-9) AS INTEGER))) AS bin,
  {cls} AS cls
FROM 'deliveries.parquet' d JOIN sel s USING (match_id) JOIN 'matches.parquet' m USING (match_id)
JOIN 'people.parquet' p ON p.cricsheet_id = d.batter_id
JOIN gp g ON g.cricinfo = p.cricinfo_id AND g.g = m.gender
WHERE d.super_over = 0 AND m.outcome_method IS NULL;
""")
    rows = run("SELECT grp, half, ph, bin, cls, count(*) AS n FROM b GROUP BY ALL")
    out: dict = {"bin0": BIN0, "binw": BINW, "nbin": NBIN, "classes": CLASSES, "phases": PHASES, "halves": {}}
    for r in rows:
        cells = out["halves"].setdefault(r["half"], {}).setdefault(r["grp"], [[[0] * len(CLASSES) for _ in range(NBIN)] for _ in PHASES])
        cells[int(r["ph"])][int(r["bin"])][CLASSES.index(r["cls"])] += int(r["n"])
    return out


# ── the fit ──────────────────────────────────────────────────────────────────────────────────────────────────────────

def hat(r: float) -> np.ndarray:
    """Linear interpolation weights of a rating on the knots (constant beyond the ends)"""
    w = np.zeros(len(KNOTS))
    if r <= KNOTS[0]:
        w[0] = 1
    elif r >= KNOTS[-1]:
        w[-1] = 1
    else:
        j = int(np.searchsorted(KNOTS, r) - 1)
        t = (r - KNOTS[j]) / (KNOTS[j + 1] - KNOTS[j])
        w[j], w[j + 1] = 1 - t, t
    return w


def table_at(values: dict, r: float) -> dict:
    h = hat(r)
    return {k: float(h @ np.array(values[k])) for k in ACTS}


def cell_rows(real_cells, sim_cells, groups):
    """(rating, class index, y, weight, group) rows: log of the real over the sim class share, relative to the phase's, minus the extras' reference"""
    rows = []
    for gid in groups:
        R, S = np.array(real_cells[gid], float), np.array(sim_cells[gid], float)  # phase x bin x class
        for ph in range(len(PHASES)):
            Rk, Sk = R[ph].sum(0), S[ph].sum(0)
            Rt, St = Rk.sum(), Sk.sum()
            for b in range(NBIN):
                rt, st = R[ph, b].sum(), S[ph, b].sum()
                if rt < 200 or st < 200:
                    continue
                rx, sx = sum(R[ph, b, CLASSES.index(c)] for c in EXTRAS), sum(S[ph, b, CLASSES.index(c)] for c in EXTRAS)
                xr, xs = sum(Rk[CLASSES.index(c)] for c in EXTRAS), sum(Sk[CLASSES.index(c)] for c in EXTRAS)
                if min(rx, sx) < 5:
                    continue
                lx = np.log((rx / rt) / (xr / Rt)) - np.log((sx / st) / (xs / St))
                for c in FITTED:
                    i = CLASSES.index(c)
                    if min(R[ph, b, i], S[ph, b, i]) < 3:
                        continue
                    ly = np.log((R[ph, b, i] / rt) / (Rk[i] / Rt)) - np.log((S[ph, b, i] / st) / (Sk[i] / St))
                    var = 1 / R[ph, b, i] + 1 / S[ph, b, i] + 1 / rx + 1 / sx
                    rows.append((BIN0 + BINW * (b + 0.5), c, float(ly - lx), 1 / var, gid))
    return rows


def fit_gender(rows, ridge_to: dict | None = None) -> dict:
    """Weighted least squares of y on the hat basis, per class, with a second-difference penalty on the knots"""
    out = {}
    nk = len(KNOTS)
    D = np.zeros((nk - 2, nk))
    for i in range(nk - 2):
        D[i, i:i + 3] = [1, -2, 1]
    for c in FITTED:
        sel = [x for x in rows if x[1] == c]
        if not sel:
            out[c] = [0.0] * nk
            continue
        X = np.array([hat(x[0]) for x in sel])
        y = np.array([x[2] for x in sel])
        w = np.array([x[3] for x in sel])
        info = X.T @ (X * w[:, None])
        A = info + LAMBDA * np.trace(info) / nk * (D.T @ D) + 1e-6 * np.eye(nk)
        out[c] = np.linalg.solve(A, X.T @ (w * y)).tolist()
    out["3"] = list(out["2"])
    return out


def centre(values: dict, counts: np.ndarray) -> dict:
    """Make the correction neutral over the balls the game's own sides play, in shares: a constant per class is added to each
    class's log multiplier so that, over the simulated balls (`counts`: class x rating bin, the engine before the correction), each class's
    share of all deliveries is what it was (the correction moves runs and wickets between batters, not the competitions' levels or wicket
    counts; the sampler normalises the weights, so a class's share is its weight over the sum). The wide, no-ball and bye weights are left alone."""
    rs = BIN0 + BINW * (np.arange(NBIN) + 0.5)
    n_b = counts.sum(axis=0)
    q = counts / np.maximum(n_b, 1)                      # class x bin: the share of the bin's balls
    base = {k: np.array([hat(r) @ np.array(values[k]) for r in rs]) for k in ACTS}
    idx = [CLASSES.index(k) for k in ACTS]
    others = [i for i in range(len(CLASSES)) if i not in idx]
    c = {k: 0.0 for k in ACTS}
    target = (counts.sum(axis=1)) / counts.sum()
    for _ in range(500):
        w = np.array(q)
        for k, i in zip(ACTS, idx):
            w[i] = q[i] * np.exp(base[k] + c[k])
        w = w / w.sum(axis=0, keepdims=True)
        tot = (w * n_b).sum(axis=1) / n_b.sum()
        err = max(abs(np.log(tot[i] / target[i])) for i in idx)
        if err < 1e-7:
            break
        for k, i in zip(ACTS, idx):
            c[k] += np.log(target[i] / tot[i])
    return {k: [v + c[k] for v in values[k]] for k in ACTS}


def score(rows, values) -> tuple[float, float]:
    """Weighted squared error of the response left in the cells: with no correction, with `values`"""
    e0 = e1 = 0.0
    for r, c, y, w, _ in rows:
        e0 += w * y * y
        e1 += w * (y - float(hat(r) @ np.array(values[c]))) ** 2
    return e0, e1


def fit(real_file: str, sim_file: str, write: bool, prior_file: str | None, fmt: str = "t20") -> None:
    R = json.loads(Path(real_file).read_text())
    S = {"groups": {}}
    for f in sim_file.split(","):  # several collector runs (one per set of competitions) merge
        S["groups"].update(json.loads(Path(f).read_text())["groups"])
    OUT_JSON, OUT_TS, CONST = OUT[fmt]
    prior = json.loads(OUT_JSON.read_text()) if OUT_JSON.exists() and not os.environ.get("BR_NO_PRIOR") else {}
    result = {"knots": KNOTS, "classes": ACTS, "male": {}, "female": {}, "fit": {}}
    sets = (("male", ("odi-men",)), ("female", ("odi-women",))) if fmt == "odi" else (
        ("male", ("ipl", "bbl", "psl", "sa20", "cpl", "ilt20", "mlc", "bpl", "lpl", "hundred-m", "t20i-men")), ("female", ("wpl", "wbbl", "hundred-w", "t20i-women")))
    for gender, suffix in sets:
        groups = [g for g in suffix if g in S["groups"] and g in R["halves"]["fit"]]
        sim = {g: S["groups"][g]["cells"] for g in groups}
        rows_fit = cell_rows(R["halves"]["fit"], sim, groups)
        rows_test = cell_rows({g: R["halves"]["test"][g] for g in groups if g in R["halves"]["test"]}, sim,
                              [g for g in groups if g in R["halves"]["test"]])
        step = fit_gender(rows_fit)
        # the powers (the wicket row and each gender's run rows) go on before the correction is made neutral
        wp = float(os.environ.get("BR_WICKET_POWER", WICKET_POWER[fmt]))
        rp = float(os.environ.get("BR_RUN_POWER", RESPONSE_POWER[fmt][gender]))
        step = {c: [v * (wp if c == "wicket" else rp) for v in step[c]] for c in ACTS}
        # the simulated balls' rating distribution, per class (summed over phases and competitions)
        counts = np.zeros((len(CLASSES), NBIN))
        for g in groups:
            counts += np.array(sim[g]).sum(axis=0).T
        step = centre(step, counts)
        step["wicket"] = [v + WICKET_OFFSET[fmt] for v in step["wicket"]]
        e0, e1 = score(rows_fit, step)
        t0, t1 = score(rows_test, step)
        print(f"{gender}: groups {groups}")
        print(f"  residual response (weighted squared error)  fit half: {e0:.1f} -> {e1:.1f}   test half (2024+): {t0:.1f} -> {t1:.1f}")
        for c in ACTS:
            print(f"  {c:>6}: " + " ".join(f"{v:+.3f}" for v in step[c]))
        # this round's correction is added to the one the engine already carries (the sim was collected with it)
        cur = prior.get(gender, {c: [0.0] * len(KNOTS) for c in ACTS})
        total = {c: [a + b for a, b in zip(cur[c], step[c])] for c in ACTS}
        result[gender] = total
        result["fit"][gender] = {"fitHalfError": [e0, e1], "testHalfError": [t0, t1], "groups": groups}
    if os.environ.get("BR_DUMP"):
        Path(os.environ["BR_DUMP"]).write_text(json.dumps({g: result[g] for g in ("male", "female")}))
    if write:
        result["wicketPower"] = WICKET_POWER[fmt]
        result["responsePower"] = RESPONSE_POWER[fmt]
        result["wicketOffset"] = WICKET_OFFSET[fmt]
        OUT_JSON.write_text(json.dumps(result, indent=1))
        emit(fmt)


def emit(fmt: str) -> None:
    """Write the engine's data file from the fitted json: the wicket row scaled by the power chosen on the real all-out rates (docs/TACTICS.md section 5)"""
    OUT_JSON, OUT_TS, CONST = OUT[fmt]
    result = json.loads(OUT_JSON.read_text())
    wp = result.get("wicketPower", WICKET_POWER[fmt])
    pw = result.get("responsePower", RESPONSE_POWER[fmt])
    lines = ["/**", " * GENERATED by packages/ratings/src/analysis/t20-batter-response.py. Do not edit by hand.", " *",
             f" * The {'ODI' if fmt == 'odi' else 'T20'} ball model's correction to its response to the striker's batting rating ((battingOvr + timing) / 200): per gender and",
             " * outcome class, a log multiplier at each knot, linear between them (batter-response.ts; docs/TACTICS.md section 5).",
             f" * Fitted rows x a power (wicket x {wp}, the others x {pw['male']} men / x {pw['female']} women), then made neutral in shares over the simulated balls, the wicket row {result.get('wicketOffset', 0.0):+.3f} on top (docs/TACTICS.md section 5).", " */",
             f"export const {CONST}_KNOTS: readonly number[] = {json.dumps(KNOTS)};",
             f"export const {CONST}: Record<\"male\" | \"female\", Record<string, readonly number[]>> = {{"]
    for g in ("male", "female"):
        lines.append(f"  {g}: {{")
        for c in ACTS:
            key = f'"{c}"' if c[0].isdigit() else c
            lines.append(f"    {key}: [{', '.join(f'{v + 0.0:.4f}' for v in result[g][c])}],")
        lines.append("  },")
    lines.append("};")
    OUT_TS.write_text("\n".join(lines) + "\n")
    print("wrote", OUT_JSON, OUT_TS)


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "real":
        path = sys.argv[2] if len(sys.argv) > 2 else str(REPO / "docs" / "data" / "t20_batter_response_real.json")
        Path(path).write_text(json.dumps(real_odi() if "--odi" in sys.argv else real()))
        print("wrote", path)
    elif len(sys.argv) >= 2 and sys.argv[1] == "emit":
        emit("odi" if "--odi" in sys.argv else "t20")
    elif len(sys.argv) >= 4 and sys.argv[1] == "fit":
        fit(sys.argv[2], sys.argv[3], "--write" in sys.argv, None, "odi" if "--odi" in sys.argv else "t20")
    else:
        raise SystemExit(__doc__)
