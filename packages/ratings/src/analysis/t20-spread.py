"""
The spread of real T20 innings totals and where it comes from: per league, the distribution of first-innings totals (mean,
sd, 200+, under 120; The Hundred on the same thresholds scaled to 100 balls), and a decomposition of innings scoring into
the batting side, the bowling side (each per season), the ground, the match (conditions on the day, shared by both innings)
and the rest. packages/app/src/__tests__/calibrate-spread.test.ts applies the same decomposition to simulated seasons and
fits the engine's match conditions (match-conditions.ts) to the match share.

Inputs (read-only): data/analysis/deliveries.parquet, matches.parquet. Needs the `duckdb` CLI on PATH.
Run from packages/ratings:  python3 -I src/analysis/t20-spread.py
Output: docs/data/t20_spread.json

Matches: full matches (the chase's target overs 20, 20 sets in The Hundred), no DLS or awarded result, no super overs;
leagues from 2021 (2023 where they began later), T20Is between full members from 2019. The decomposition is on the first
ten overs (ten sets in The Hundred) of each innings, which a chase almost never cuts short: runs (r10) and wickets (w10).
Matches whose chase ended inside the window are left out of it.

Model, per measure: y = league-season mean + bat(team, season) + bowl(team, season) + ground + residual, every term but the
mean random (normal), fitted by EM with each term's posterior mean and variance (backfitting; the cross-term posterior
covariances are ignored, which the simulated side shares). The match term is then the covariance of the two innings'
residuals within a match: what both innings have in common beyond the two sides and the ground, the pitch and the weather
on the day (and, in the simulated and the real game alike, a chase's response to its target). Its run / wicket correlation
is the cross-covariance over the same pairs.
"""
import json
import math
import re
import subprocess
import tempfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
REPO = ROOT.parent.parent
OUT = REPO / "docs" / "data" / "t20_spread.json"
TMP = Path(tempfile.mkdtemp())
DB = TMP / "spread.duckdb"

FULL_MEMBERS = ["Afghanistan", "Australia", "Bangladesh", "England", "India", "Ireland", "New Zealand", "Pakistan",
                "South Africa", "Sri Lanka", "West Indies", "Zimbabwe"]
# league id -> (where clause on matches m, The Hundred?, gender)
LEAGUES = {
    "ipl": ("m.event = 'Indian Premier League'", False, "men"),
    "bbl": ("m.event = 'Big Bash League'", False, "men"),
    "psl": ("m.event = 'Pakistan Super League'", False, "men"),
    "sa20": ("m.event = 'SA20'", False, "men"),
    "cpl": ("m.event = 'Caribbean Premier League'", False, "men"),
    "ilt20": ("m.event = 'International League T20'", False, "men"),
    "mlc": ("m.event = 'Major League Cricket'", False, "men"),
    "bpl": ("m.event = 'Bangladesh Premier League'", False, "men"),
    "lpl": ("m.event = 'Lanka Premier League'", False, "men"),
    "hundred-m": ("m.event = 'The Hundred Men''s Competition'", True, "men"),
    "wpl": ("m.event = 'Women''s Premier League'", False, "women"),
    "wbbl": ("m.event = 'Women''s Big Bash League'", False, "women"),
    "hundred-w": ("m.event = 'The Hundred Women''s Competition'", True, "women"),
}
FM = ", ".join(f"'{t}'" for t in FULL_MEMBERS)
T20I = f"m.match_type IN ('T20', 'IT20') AND m.team_type = 'international' AND m.date >= DATE '2019-01-01' AND m.team1 IN ({FM}) AND m.team2 IN ({FM})"
TERMS = ["bat", "bowl", "ground"]


def run(sql: str, json_out: bool = True) -> list:
    args = ["duckdb", str(DB)] + (["-json"] if json_out else []) + ["-c", "SET memory_limit='2GB'; SET threads=4; " + sql]
    p = subprocess.run(args, capture_output=True, text=True, cwd=DATA)
    if p.returncode != 0:
        raise SystemExit(f"duckdb failed: {p.stderr}\n{sql[:600]}")
    rows = json.loads(p.stdout) if json_out and p.stdout.strip() else []
    num = re.compile(r"^-?\d+(\.\d+)?$")
    keep = {"match_id", "season", "bat", "bowl", "ground", "lg", "gender"}
    return [{k: float(v) if isinstance(v, str) and num.match(v) and k not in keep else v for k, v in row.items()} for row in rows]


def innings_rows() -> list:
    """Every innings of the selected matches: league, gender, season, sides, ground, totals and the first-ten-overs window"""
    sel = " UNION ALL ".join(
        f"SELECT match_id, '{lid}' lg, '{g}' gender, season, venue FROM 'matches.parquet' m WHERE {w} AND m.date >= DATE '2021-01-01' AND outcome_method IS NULL"
        for lid, (w, _, g) in LEAGUES.items())
    sel += f" UNION ALL SELECT match_id, CASE WHEN gender = 'male' THEN 't20i-m' ELSE 't20i-w' END lg, CASE WHEN gender = 'male' THEN 'men' ELSE 'women' END gender, season, venue FROM 'matches.parquet' m WHERE {T20I} AND outcome_method IS NULL"
    run(f"""
CREATE OR REPLACE TABLE m AS {sel};
CREATE OR REPLACE TABLE full_m AS SELECT match_id FROM 'deliveries.parquet' WHERE innings = 2 AND super_over = 0 AND match_id IN (SELECT match_id FROM m)
  GROUP BY 1 HAVING min(inn_target_overs) = 20 AND max(inn_target_overs) = 20;
CREATE OR REPLACE TABLE inn AS SELECT d.match_id, any_value(m.lg) lg, any_value(m.gender) gender, any_value(m.season) season,
  lower(trim(split_part(any_value(m.venue), ',', 1))) ground, d.innings, any_value(d.batting_team) bat, any_value(d.bowling_team) bowl,
  sum(runs_total) runs, sum(is_wicket) + count(*) FILTER (WHERE retired_kind IS NOT NULL AND retired_kind <> 'retired hurt') wk,
  sum(runs_total) FILTER (WHERE over < 10) r10, sum(is_wicket) FILTER (WHERE over < 10) w10, max(over) last_over
  FROM 'deliveries.parquet' d JOIN m USING (match_id)
  WHERE d.super_over = 0 AND d.innings IN (1, 2) AND d.match_id IN (SELECT match_id FROM full_m) GROUP BY d.match_id, d.innings;
""", json_out=False)
    return run("SELECT * FROM inn ORDER BY match_id, innings")


def decompose(rows: list, y_key: str, sweeps: int = 200) -> dict:
    """Variance components of y over the TERMS (see the module note); rows need lg, season, bat, bowl, ground, match_id"""
    keys = {
        "bat": lambda r: f"{r['lg']}|{r['bat']}|{r['season']}",
        "bowl": lambda r: f"{r['lg']}|{r['bowl']}|{r['season']}",
        "ground": lambda r: f"{r['lg']}|{r['ground']}",
    }
    mean_key = lambda r: f"{r['lg']}|{r['season']}"
    y = [float(r[y_key]) for r in rows]
    n = len(y)
    lv = {t: [keys[t](r) for r in rows] for t in TERMS}
    mk = [mean_key(r) for r in rows]
    u = {t: {} for t in TERMS}
    tot = sum(y) / n
    var_e = sum((v - tot) ** 2 for v in y) / n
    var = {t: 0.1 * var_e for t in TERMS}
    mu = {}
    for _ in range(sweeps):
        # league-season means
        acc = {}
        for i in range(n):
            res = y[i] - sum(u[t].get(lv[t][i], 0.0) for t in TERMS)
            s = acc.setdefault(mk[i], [0.0, 0])
            s[0] += res
            s[1] += 1
        mu = {k: s / c for k, (s, c) in acc.items()}
        cond_sum = 0.0
        for t in TERMS:
            acc = {}
            for i in range(n):
                res = y[i] - mu[mk[i]] - sum(u[o].get(lv[o][i], 0.0) for o in TERMS if o != t)
                s = acc.setdefault(lv[t][i], [0.0, 0])
                s[0] += res
                s[1] += 1
            new, tot_sq = {}, 0.0
            for k, (s, c) in acc.items():
                post_var = 1.0 / (c / var_e + 1.0 / var[t])
                new[k] = post_var * s / var_e
                tot_sq += new[k] ** 2 + post_var
                cond_sum += c * post_var
            u[t] = new
            var[t] = max(tot_sq / len(acc), 1e-6)
        rss = sum((y[i] - mu[mk[i]] - sum(u[t].get(lv[t][i], 0.0) for t in TERMS)) ** 2 for i in range(n))
        var_e = (rss + cond_sum) / n
    out = {t: round(var[t], 3) for t in TERMS}
    out["residual"] = round(var_e, 3)
    out["n"] = n
    out["mean"] = round(sum(y) / n, 2)
    res = {(r["match_id"], r["innings"]): y[i] - mu[mk[i]] - sum(u[t].get(lv[t][i], 0.0) for t in TERMS) for i, r in enumerate(rows)}
    return {"var": out, "res": res}


def match_terms(dr: dict, dw: dict) -> dict:
    """The match term from the residuals' covariance between a match's two innings: runs, wickets and their correlation"""
    ids = sorted({k[0] for k in dr["res"]})
    pairs = [(dr["res"][(m, 1)], dr["res"][(m, 2)], dw["res"][(m, 1)], dw["res"][(m, 2)]) for m in ids if (m, 1) in dr["res"] and (m, 2) in dr["res"]]
    k = len(pairs)
    cr = sum(a * b for a, b, _, _ in pairs) / k
    cw = sum(c * d for _, _, c, d in pairs) / k
    x = sum((a * d + b * c) / 2 for a, b, c, d in pairs) / k
    corr = x / math.sqrt(cr * cw) if cr > 0 and cw > 0 else 0.0
    return {"run": round(cr, 2), "wicket": round(cw, 4), "corr": round(max(-1.0, min(1.0, corr)), 3), "matches": k}


QS = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]


def quantile(xs: list, q: float) -> float:
    """Linear-interpolation quantile (DuckDB's quantile_cont)"""
    v = sorted(xs)
    h = (len(v) - 1) * q
    lo = math.floor(h)
    return v[lo] + (v[min(lo + 1, len(v) - 1)] - v[lo]) * (h - lo)


def distribution(rows: list, hundred: bool) -> dict:
    """First-innings totals: as played, and centred on their season's mean (the shape the engine is fitted to: the engine
    plays one era, the real seasons since 2021 drift by up to 30 runs)"""
    first = [r for r in rows if r["innings"] == 1]
    runs = [r["runs"] for r in first]
    hi, lo = (200 * 100 / 120, 120 * 100 / 120) if hundred else (200, 120)
    m = sum(runs) / len(runs)
    sd = math.sqrt(sum((x - m) ** 2 for x in runs) / (len(runs) - 1))
    by = {}
    for r in first:
        by.setdefault(r["season"], []).append(r["runs"])
    means = {k: sum(v) / len(v) for k, v in by.items()}
    dev = [r["runs"] - means[r["season"]] for r in first]
    sdc = math.sqrt(sum(d * d for d in dev) / (len(dev) - len(by)))
    skew = sum(d ** 3 for d in dev) / len(dev) / (sum(d * d for d in dev) / len(dev)) ** 1.5
    allout = 100 * sum(r["wk"] >= 10 for r in first) / len(first)
    lo_allout = 100 * sum(r["wk"] >= 10 and r["runs"] < lo for r in first) / len(first)
    return {"matches": len(runs), "mean": round(m, 1), "sd": round(sd, 1), "allOut": round(allout, 1), "under120AllOut": round(lo_allout, 1),
            "p200": round(100 * sum(x >= hi for x in runs) / len(runs), 1), "under120": round(100 * sum(x < lo for x in runs) / len(runs), 1),
            "centred": {"sd": round(sdc, 1), "skew": round(skew, 3), "quantiles": [round(quantile(dev, q), 1) for q in QS],
                        "deviations": sorted(round(d, 1) for d in dev)}}


def window_rows(rows: list) -> list:
    """Both innings of the matches whose chase lasted the ten-over window (or was bowled out in it)"""
    by = {}
    for r in rows:
        by.setdefault(r["match_id"], []).append(r)
    out = []
    for inns in by.values():
        if len(inns) != 2:
            continue
        second = next(r for r in inns if r["innings"] == 2)
        if second["last_over"] < 9 and second["wk"] < 10:
            continue  # the chase ended inside the window
        out.extend(inns)
    return out


def main() -> None:
    rows = innings_rows()
    for r in rows:
        r["w10"] = r["w10"] or 0
        r["r10"] = r["r10"] or 0
    leagues = {}
    for lid in list(LEAGUES) + ["t20i-m", "t20i-w"]:
        rs = [r for r in rows if r["lg"] == lid]
        hundred = LEAGUES.get(lid, ("", False, ""))[1]
        win = window_rows(rs)
        dr, dw = decompose(win, "r10"), decompose(win, "w10")
        mt = match_terms(dr, dw)
        leagues[lid] = {"gender": rs[0]["gender"], "hundred": hundred, "firstInnings": distribution(rs, hundred),
                        "r10": dr["var"], "w10": dw["var"], "match": mt}
        f, v = leagues[lid]["firstInnings"], dr["var"]
        print(f"{lid:10} {f['matches']:4} 1st {f['mean']:6.1f} sd {f['sd']:5.1f} 200+ {f['p200']:5.1f}% <120 {f['under120']:5.1f}% | r10 var "
              + " ".join(f"{t} {v[t]:6.1f}" for t in TERMS + ["residual"]) + f" | match r10 {mt['run']:6.1f} w10 {mt['wicket']:.3f} corr {mt['corr']}")
    pooled = {}
    for g in ("men", "women"):
        rs = window_rows([r for r in rows if r["gender"] == g and not LEAGUES.get(r["lg"], ("", False, ""))[1]])
        dr, dw = decompose(rs, "r10"), decompose(rs, "w10")
        mt = match_terms(dr, dw)
        pooled[g] = {"r10": dr["var"], "w10": dw["var"], "match": mt}
        v = dr["var"]
        print(f"pooled {g} T20 (no Hundred): r10 var " + " ".join(f"{t} {v[t]:6.1f}" for t in TERMS + ["residual"]) +
              f" | match r10 {mt['run']:.1f} w10 {mt['wicket']:.3f} corr {mt['corr']}")
    doc = {
        "source": "Cricsheet ball-by-ball (data/analysis/deliveries.parquet, matches.parquet); packages/ratings/src/analysis/t20-spread.py",
        "generated": date.today().isoformat(),
        "terms": TERMS + ["residual"],
        "quantiles": QS,
        "note": "r10 / w10: runs / wickets in each innings' first ten overs (sets); var: variance components; match: within-match covariance of the residuals (run, wicket) and their correlation",
        "leagues": leagues,
        "pooled": pooled,
    }
    OUT.write_text(json.dumps(doc, indent=1) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
