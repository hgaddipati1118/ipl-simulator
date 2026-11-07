"""
Fielding and wicketkeeping ratings (0-99) from Cricsheet T20 ball-by-ball, men and women.

Input  (from src/analysis/fielding-stats.sql):
    data/analysis/fielding_player_innings.parquet   one row per fielding innings x player (catches, run-outs, the
                                                    innings' team totals) with the keeper identified
    data/analysis/keeping_innings.parquet           one row per fielding innings: keeper's stumpings, catches, byes
                                                    and what the bowlers on that day would be expected to give
    data/analysis/people.parquet                    Cricsheet register (Cricinfo + CricketArchive ids)
    data/cricket.db                                 CricketArchive scorecards (keeper flag, for players Cricsheet lacks)
Output (data/analysis/):
    fielding_ratings.csv        one row per player (Cricsheet id, Cricinfo id): fielding / keeping 0-99 and the counts
    fielding_validation.json    shrinkage, reliabilities, split-half checks
    fielding_ca_keepers.csv     CricketArchive keeper share per player (all formats), for players Cricsheet can't rate

Method (per gender; everything is a ratio of observed to expected, shrunk to the mean with a Gamma-Poisson prior):
 1. Catching.  In a fielding innings the non-keeper catches (caught and bowled excluded) are shared among the ten
    non-keeper fielders.  A fielder's expectation is the mean of his teammates' catches in that innings,
    E = (team catches - his catches) / 9.  So a team that creates many chances, a flat pitch, a format or an era with
    more catches raises everyone's E equally and drops out; only the share of the team's chances he took is
    informative.  Ratio = sum(O) / sum(E), scaled so the league mean is 1.
 2. Run-outs.  Same form, on run-outs the player was credited in (direct hit or assist), separately for keepers
    (who are involved far more) and everyone else.
 3. Keeping, on innings where the CricketArchive scorecard flags the keeper (about 87% of team-matches; stumpings
    alone identify the keeper elsewhere, but those innings are not used for the rates: they would be selected on the
    outcome).  Expected counts come from who bowled: each bowler's stumping / keeper-catch / bye-event rate per
    legal ball (his own, shrunk to the gender mean with a 1500-ball prior), so a keeper behind spinners isn't
    credited for the stumpings the bowlers create.  Three components: stumpings, catches taken by the keeper, bye
    events (fewer is better).
 4. Shrinkage.  Each ratio gets a Gamma(k, k) prior; k is fitted by maximum marginal likelihood (negative binomial)
    over all players, so thin records stay at the mean.  Posterior mean = (O + k) / (E + k).
 5. Rating = 50 + SCALE * (weighted sum of the log posterior ratios) / (prior SD of that sum).  One unit is one SD of
    true skill, so 50 is the average player, +1 SD = +SCALE.  Fielding = catching + 0.4 x run-outs; keeping =
    0.40 stumpings + 0.25 keeper catches - 0.35 bye events.  Players who never keep get no keeping rating (the game
    uses a low default for them).
Run from packages/ratings:  duckdb < src/analysis/fielding-stats.sql && python3 -I src/analysis/fielding-ratings.py
"""
import csv, json, math, random, subprocess, sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"

SCALE = 14.0                 # rating points per SD of true skill
RO_WEIGHT = 0.4              # run-out involvement relative to catching in the fielding rating
KEEP_WEIGHTS = {"st": 0.40, "kc": 0.25, "bye": -0.35}
MIN_BALLS = 60               # innings shorter than this (rain, abandoned) are skipped
MIN_PLAYERS, MAX_PLAYERS = 9, 12   # lists of players seen on the fielding side (12 = impact sub / substitute)
OTHERS = 9.0                 # non-keeper teammates sharing the catches
OTHERS_RO = 10.0
ROLE_KEEP = 0.5              # share of the bowler / part-timer / non-bowler catching gap kept in the rating
MIN_KEEPER_INNINGS_RATED = 3  # fewer keeper innings than this: no keeping rating


def duck(sql):
    out = subprocess.run(["duckdb", "-csv", "-nullvalue", "", "-c", "LOAD sqlite; " + sql], capture_output=True, text=True, cwd=ROOT)
    if out.returncode:
        sys.exit(out.stderr)
    return list(csv.DictReader(out.stdout.splitlines()))


def lgamma(x):
    return math.lgamma(x)


def nb_loglik(k, pairs):
    """Marginal log-likelihood of counts O ~ Poisson(lambda E), lambda ~ Gamma(k, k)."""
    t = 0.0
    for o, e in pairs:
        t += lgamma(o + k) - lgamma(k) - lgamma(o + 1) + k * math.log(k / (k + e)) + o * math.log(e / (k + e))
    return t


def fit_k(pairs):
    pairs = [(o, e) for o, e in pairs if e > 0]
    best, best_ll = None, -1e300
    for i in range(0, 61):
        k = math.exp(math.log(1.0) + i * (math.log(3000.0) / 60))
        ll = nb_loglik(k, pairs)
        if ll > best_ll:
            best, best_ll = k, ll
    return best


def trigamma(x):
    # recurrence + asymptotic series
    s = 0.0
    while x < 6:
        s += 1 / (x * x)
        x += 1
    return s + 1 / x + 1 / (2 * x * x) + 1 / (6 * x ** 3) - 1 / (30 * x ** 5) + 1 / (42 * x ** 7)


def post(o, e, k):
    return (o + k) / (e + k)


def main():
    people = {r["cricsheet_id"]: r for r in duck("SELECT cricsheet_id, name, cricinfo_id, cricketarchive_id FROM 'data/analysis/people.parquet'")}

    # ---------- catching and run-outs
    cond = f"keeper_source = 'ca' AND balls >= {MIN_BALLS} AND team_players BETWEEN {MIN_PLAYERS} AND {MAX_PLAYERS}"
    catch_rows = duck(f"""
        SELECT pid, gender, count(*) AS inns, sum(catches_all) AS o, sum((team_nk_catches - cx - catches_all) / {OTHERS}) AS e,
               sum(cb) AS cb, min(year) AS y0, max(year) AS y1, sum(balls_bowled) * 1.0 / count(*) AS bpi
        FROM 'data/analysis/fielding_player_innings.parquet'
        WHERE {cond} AND NOT is_keeper GROUP BY ALL""")
    ro_rows = duck(f"""
        SELECT pid, gender, is_keeper, count(*) AS inns, sum(ro) AS o, sum((team_ro - ro) / {OTHERS_RO}) AS e
        FROM 'data/analysis/fielding_player_innings.parquet'
        WHERE {cond} GROUP BY ALL""")
    all_inns = {(r["pid"], r["gender"]): r for r in duck(f"""
        SELECT pid, gender, count(*) AS inns, sum(is_keeper::INT) AS keeper_inns, min(year) AS y0, max(year) AS y1
        FROM 'data/analysis/fielding_player_innings.parquet' WHERE {cond} GROUP BY ALL""")}

    out = {}      # (pid, gender) -> dict
    report = {"scale": SCALE, "ro_weight": RO_WEIGHT, "keep_weights": KEEP_WEIGHTS}
    for gender in ("male", "female"):
        rep = report[gender] = {}
        # --- catching
        crows = [r for r in catch_rows if r["gender"] == gender]
        so = sum(float(r["o"]) for r in crows); se = sum(float(r["e"]) for r in crows)
        R_all = so / se
        # Role: bowlers are posted at fine leg / third man and bowl a third of the catches themselves; batters take
        # most.  Each bowling-load class is compared with its own mean, and half of the class gap is kept in the rating.
        cls = lambda r: "bowler" if float(r["bpi"]) >= 15 else ("part" if float(r["bpi"]) >= 3 else "non")
        R_cls = {}
        for c_ in ("bowler", "part", "non"):
            rr_ = [r for r in crows if cls(r) == c_]
            R_cls[c_] = sum(float(r["o"]) for r in rr_) / sum(float(r["e"]) for r in rr_)
        off = {c_: ROLE_KEEP * math.log(R_cls[c_] / R_all) for c_ in R_cls}
        kc_ = fit_k([(float(r["o"]), float(r["e"]) * R_cls[cls(r)]) for r in crows])
        rep["catching"] = {"players": len(crows), "innings": sum(int(r["inns"]) for r in crows), "catches": so,
                           "catches_per_innings_per_fielder": so / sum(int(r["inns"]) for r in crows), "k": kc_,
                           "class_ratio": R_cls, "class_offset_kept": off,
                           "true_sd_log": 1 / math.sqrt(kc_) if kc_ else None}
        # --- run-outs, by role
        ro = {}
        rep["runouts"] = {}
        for role in ("true", "false"):
            rr = [r for r in ro_rows if r["gender"] == gender and r["is_keeper"] == role]
            o_ = sum(float(r["o"]) for r in rr); e_ = sum(float(r["e"]) for r in rr)
            R = o_ / e_ if e_ else 1.0
            k = fit_k([(float(r["o"]), float(r["e"]) * R) for r in rr if float(r["e"]) > 0])
            rep["runouts"][role] = {"players": len(rr), "involvements": o_, "R": R, "k": k}
            for r in rr:
                d = ro.setdefault(r["pid"], {"o": 0.0, "eR": 0.0, "k": {}})
                d["o"] += float(r["o"]); d["eR"] += float(r["e"]) * R
                d["k"][role] = k
        # use one k for run-outs per gender (non-keeper fit; keepers are few)
        k_ro = rep["runouts"]["false"]["k"]
        sd_c = 1 / math.sqrt(kc_); sd_ro = 1 / math.sqrt(k_ro)
        sd_f = math.sqrt(sd_c ** 2 + (RO_WEIGHT * sd_ro) ** 2)
        rep["fielding_prior_sd"] = sd_f

        for r in crows:
            pid = r["pid"]
            c_ = cls(r)
            o, e = float(r["o"]), float(r["e"]) * R_cls[c_]
            m_c = post(o, e, kc_)
            d = out.setdefault((pid, gender), {"pid": pid, "gender": gender})
            d.update(catch_inns=int(r["inns"]), catches=o, exp_catches=round(e, 3), cb=int(r["cb"]), catch_ratio=round(m_c, 4),
                     role=c_, role_offset=off[c_], bowl_balls_per_inns=round(float(r["bpi"]), 2))
        # players with run-out data (incl. keepers with no non-keeper innings)
        ro_gender = {r["pid"] for r in ro_rows if r["gender"] == gender}
        for pid in ro_gender:
            d = out.setdefault((pid, gender), {"pid": pid, "gender": gender})
            rd = ro[pid]
            m_ro = post(rd["o"], rd["eR"], k_ro)
            d.update(ro_involved=rd["o"], ro_ratio=round(m_ro, 4))
        for (pid, g), d in out.items():
            if g != gender:
                continue
            lc = math.log(d.get("catch_ratio", 1.0)) + d.get("role_offset", 0.0)
            lr = math.log(d.get("ro_ratio", 1.0))
            # keepers with no non-keeper innings get catching ratio 1 (the keeper's catching is rated under keeping)
            f = lc + RO_WEIGHT * lr
            d["fielding_z"] = f / sd_f
            ai = all_inns.get((pid, gender), {})
            d["field_inns"] = int(ai.get("inns", 0) or 0)
            d["keeper_inns"] = int(ai.get("keeper_inns", 0) or 0)
            d["year_first"] = ai.get("y0"); d["year_last"] = ai.get("y1")

        # ---------- keeping
        krows = duck(f"""
            SELECT keeper_id AS pid, count(*) AS inns, sum(balls) AS balls, sum(st) AS st, sum(exp_st_ev) AS exp_st, sum(kc) AS kc, sum(exp_kc_ev) AS exp_kc,
                   sum(bye_ev) AS bye, sum(exp_bye_ev) AS exp_bye, sum(bye_runs) AS bye_runs
            FROM 'data/analysis/keeping_innings.parquet'
            WHERE source = 'ca' AND gender = '{gender}' AND balls >= {MIN_BALLS} GROUP BY ALL""")
        rep["keeping"] = {"keepers": len(krows), "innings": sum(int(r["inns"]) for r in krows)}
        ks, sds = {}, {}
        for comp, (oc, ec) in {"st": ("st", "exp_st"), "kc": ("kc", "exp_kc"), "bye": ("bye", "exp_bye")}.items():
            so = sum(float(r[oc]) for r in krows); se = sum(float(r[ec]) for r in krows)
            R = so / se
            k = fit_k([(float(r[oc]), float(r[ec]) * R) for r in krows])
            ks[comp] = (k, R)
            sds[comp] = 1 / math.sqrt(k)
            rep["keeping"][comp] = {"observed": so, "expected": se, "R": R, "k": k, "true_sd_log": sds[comp]}
        sd_k = math.sqrt(sum((KEEP_WEIGHTS[c] * sds[c]) ** 2 for c in KEEP_WEIGHTS))
        rep["keeping"]["prior_sd"] = sd_k
        for r in krows:
            d = out.setdefault((r["pid"], gender), {"pid": r["pid"], "gender": gender})
            n = int(r["inns"])
            d["keep_inns"] = n
            ks_sum = 0.0
            for comp, (oc, ec) in {"st": ("st", "exp_st"), "kc": ("kc", "exp_kc"), "bye": ("bye", "exp_bye")}.items():
                k, R = ks[comp]
                o, e = float(r[oc]), float(r[ec]) * R
                m = post(o, e, k)
                d[f"{comp}_o"] = o; d[f"{comp}_e"] = round(e, 3); d[f"{comp}_ratio"] = round(m, 4)
                ks_sum += KEEP_WEIGHTS[comp] * math.log(m)
            d["keeping_z"] = ks_sum / sd_k
            d["bye_runs"] = float(r["bye_runs"])
            d["keep_balls"] = int(float(r["balls"]))

    # ---------- split-half check: odd / even matches for catching and keeping stability
    rep_all = report
    rng = random.Random(7)
    for gender in ("male", "female"):
        halves = duck(f"""
            SELECT pid, (hash(match_id) % 2)::INT AS h, sum(catches_all) AS o, sum((team_nk_catches - cx - catches_all) / {OTHERS}) AS e, count(*) AS inns
            FROM 'data/analysis/fielding_player_innings.parquet'
            WHERE {cond} AND NOT is_keeper AND gender = '{gender}' GROUP BY ALL""")
        by = defaultdict(dict)
        for r in halves:
            by[r["pid"]][int(r["h"])] = (float(r["o"]), float(r["e"]), int(r["inns"]))
        R = sum(v[h][0] for v in by.values() for h in v) / sum(v[h][1] for v in by.values() for h in v)
        k = rep_all[gender]["catching"]["k"]
        xs, ys = [], []
        for pid, v in by.items():
            if 0 in v and 1 in v and v[0][2] >= 40 and v[1][2] >= 40:
                xs.append(math.log(post(v[0][0], v[0][1] * R, k))); ys.append(math.log(post(v[1][0], v[1][1] * R, k)))
        rep_all[gender]["catching"]["split_half"] = {"players": len(xs), "corr_shrunk": corr(xs, ys),
                                                       "corr_raw": corr_raw(by, R, 40)}
        halves = duck(f"""
            SELECT keeper_id AS pid, (hash(match_id) % 2)::INT AS h, sum(st) st, sum(exp_st_ev) est, sum(kc) kc, sum(exp_kc_ev) ekc, sum(bye_ev) b, sum(exp_bye_ev) eb, count(*) inns
            FROM 'data/analysis/keeping_innings.parquet' WHERE source = 'ca' AND gender = '{gender}' AND balls >= {MIN_BALLS} GROUP BY ALL""")
        by = defaultdict(dict)
        for r in halves:
            by[r["pid"]][int(r["h"])] = {k_: float(r[k_]) for k_ in ("st", "est", "kc", "ekc", "b", "eb")} | {"inns": int(r["inns"])}
        res = {}
        for name, (o, e) in {"stumpings": ("st", "est"), "keeper_catches": ("kc", "ekc"), "byes": ("b", "eb")}.items():
            tot_o = sum(h[o] for v in by.values() for h in v.values()); tot_e = sum(h[e] for v in by.values() for h in v.values())
            R = tot_o / tot_e
            xs, ys = [], []
            for v in by.values():
                if 0 in v and 1 in v and v[0]["inns"] >= 25 and v[1]["inns"] >= 25:
                    xs.append(v[0][o] / max(v[0][e] * R, 1e-9)); ys.append(v[1][o] / max(v[1][e] * R, 1e-9))
            res[name] = {"players": len(xs), "corr_raw": corr(xs, ys)}
        rep_all[gender]["keeping"]["split_half"] = res

    # ---------- map to ratings
    rows = []
    for (pid, gender), d in out.items():
        p = people.get(pid, {})
        f = 50 + SCALE * d.get("fielding_z", 0.0)
        row = {
            "cricsheet_id": pid, "name": p.get("name", ""), "cricinfo_id": p.get("cricinfo_id", ""),
            "ca_id": p.get("cricketarchive_id", ""), "gender": gender,
            "field_inns": d.get("field_inns", 0), "catch_inns": d.get("catch_inns", 0),
            "catches": d.get("catches", ""), "exp_catches": d.get("exp_catches", ""), "catch_ratio": d.get("catch_ratio", ""),
            "ro_involved": d.get("ro_involved", ""), "ro_ratio": d.get("ro_ratio", ""),
            "fielding": max(15, min(99, round(f))) if d.get("field_inns", 0) > 0 else "",
            "role": d.get("role", ""), "bowl_balls_per_inns": d.get("bowl_balls_per_inns", ""), "keeper_inns_cs": d.get("keeper_inns", 0), "keep_inns": d.get("keep_inns", 0),
            "st": d.get("st_o", ""), "exp_st": d.get("st_e", ""), "kc": d.get("kc_o", ""), "exp_kc": d.get("kc_e", ""),
            "bye_ev": d.get("bye_o", ""), "exp_bye": d.get("bye_e", ""), "bye_runs": d.get("bye_runs", ""),
            "keeping": "", "year_first": d.get("year_first", ""), "year_last": d.get("year_last", ""),
        }
        if d.get("keep_inns", 0) >= MIN_KEEPER_INNINGS_RATED:
            row["keeping"] = max(15, min(99, round(50 + SCALE * d["keeping_z"])))
        rows.append(row)
    rows.sort(key=lambda r: (r["gender"], -(r["fielding"] if r["fielding"] != "" else 0)))

    with open(DATA / "fielding_ratings.csv", "w", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=list(rows[0]))
        wr.writeheader(); wr.writerows(rows)

    # ---------- CricketArchive keeper share (all formats), for players Cricsheet can't rate
    ca = duck("""ATTACH 'data/cricket.db' AS c (TYPE sqlite, READ_ONLY);
        WITH m AS (SELECT id, CASE WHEN levels LIKE '%Twenty20%' THEN 'T20' WHEN levels LIKE '%List A%' THEN 'ListA' WHEN levels LIKE '%First-Class%' THEN 'FC' END AS fmt
                   FROM c.matches WHERE try_cast(date AS DATE) >= '2000-01-01')
        SELECT b.player_id AS ca_id, m.fmt, count(*) AS matches, sum(b.keeper) AS keeper_matches
        FROM c.batting b JOIN m ON m.id = b.match_id WHERE m.fmt IS NOT NULL GROUP BY ALL HAVING sum(b.keeper) > 0""")
    with open(DATA / "fielding_ca_keepers.csv", "w", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=["ca_id", "fmt", "matches", "keeper_matches"])
        wr.writeheader(); wr.writerows(ca)

    def clean(x):
        if isinstance(x, float) and (x != x or x in (float("inf"), float("-inf"))):
            return None
        if isinstance(x, dict):
            return {k: clean(v) for k, v in x.items()}
        return x
    with open(DATA / "fielding_validation.json", "w") as fh:
        json.dump(clean(report), fh, indent=1)
    print(f"{len(rows)} players rated -> data/analysis/fielding_ratings.csv")
    print(json.dumps(clean({g: {k: v for k, v in report[g].items() if k in ('catching', 'keeping')} for g in ('male', 'female')}), indent=1)[:3000])


def corr(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs); syy = sum((y - my) ** 2 for y in ys)
    return sxy / math.sqrt(sxx * syy) if sxx > 0 and syy > 0 else None


def corr_raw(by, R, minn):
    xs, ys = [], []
    for v in by.values():
        if 0 in v and 1 in v and v[0][2] >= minn and v[1][2] >= minn and v[0][1] > 0 and v[1][1] > 0:
            xs.append(v[0][0] / (v[0][1] * R)); ys.append(v[1][0] / (v[1][1] * R))
    return corr(xs, ys)


if __name__ == "__main__":
    main()
