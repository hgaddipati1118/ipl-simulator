"""
Sense-check report for the T20 ratings model -> data/analysis/ratings-report.md

Run order: ... && python3 -I src/analysis/ratings-model.py && python3 -I src/analysis/ratings-report.py
Reads player_ratings_by_season.parquet, ratings_validation.json, tuned_params.json, model_config.json,
league_levels.csv, age_curve.csv and the game's current ratings (read-only).  Writes only the report.
"""

import csv
import json
import math
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
R = f"'{DATA}/player_ratings_by_season.parquet'"
FRANCHISE = ["Indian Premier League", "The Hundred Men's Competition", "Big Bash League", "SA20", "International League T20",
             "Caribbean Premier League", "Pakistan Super League", "Major League Cricket"]
FULL_MEMBERS = {"Afghanistan", "Australia", "Bangladesh", "England", "India", "Ireland", "New Zealand", "Pakistan", "South Africa", "Sri Lanka",
                "West Indies", "Zimbabwe"}
IPL_TEAMS = {"csk": "Chennai Super Kings", "mi": "Mumbai Indians", "rcb": "Royal Challengers", "kkr": "Kolkata Knight Riders",
             "srh": "Sunrisers Hyderabad", "dc": "Delhi Capitals", "pbks": "Punjab Kings", "rr": "Rajasthan Royals",
             "lsg": "Lucknow Super Giants", "gt": "Gujarat Titans"}


def q(sql):
    p = subprocess.run(["duckdb", "-csv", "-header"], input=sql, capture_output=True, text=True, cwd=ROOT)
    if p.returncode:
        raise RuntimeError(p.stderr + "\n" + sql[:2000])
    rows = list(csv.DictReader(p.stdout.splitlines()))
    for r in rows:
        for k, v in r.items():
            try:
                r[k] = float(v) if v not in ("", None, "NULL") else None
            except ValueError:
                pass
    return rows


def f(v, d=1):
    return "–" if v is None else f"{v:.{d}f}"


def table(headers, rows):
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out) + "\n"


# game ratings and country by cricinfo id
game = {}
for g, fn in (("male", "espn-ratings-base.json"), ("female", "espn-ratings-women-base.json")):
    for p in json.load(open(ROOT / "data" / "scraped" / fn)):
        game[(g, p["espnId"])] = p
country = {k: v.get("country") for k, v in game.items()}


def gname(g, cid):
    p = game.get((g, int(cid))) if cid else None
    return p


def is_assoc(g, cid):
    c = country.get((g, int(cid))) if cid else None
    return c is not None and c not in FULL_MEMBERS


ELIG_BAT = "active AND bat_confidence >= 0.5 AND bat_balls_per_match >= 8"
ELIG_BOWL = "active AND bowl_confidence >= 0.5 AND bowl_balls_per_match >= 8"


def top(g, snap, kind, n, extra="", order=None):
    where = {"bat": ELIG_BAT, "bowl": ELIG_BOWL, "ar": "active AND player_role = 'all-rounder' AND bat_confidence >= 0.4 AND bowl_confidence >= 0.4",
             "all": "active AND confidence >= 0.4 AND (bat_balls_per_match >= 8 OR bowl_balls_per_match >= 8)"}[kind]
    order = order or {"bat": "impact_bat", "bowl": "impact_bowl", "ar": "impact", "all": "impact"}[kind]
    return q(f"SELECT * FROM {R} WHERE gender = '{g}' AND snapshot = '{snap}' AND {where} {extra} ORDER BY {order} DESC LIMIT {n}")


def fmt_list(g, rows, cols):
    out = []
    for i, r in enumerate(rows, 1):
        gm = gname(g, r["cricinfo_id"])
        cells = [i, r["name"], f(r["age"], 0), (country.get((g, int(r["cricinfo_id"]))) if r["cricinfo_id"] else None) or "–"]
        for c, d in cols:
            cells.append(f(r.get(c), d))
        cells.append(f(r["confidence"], 2))
        cells.append(gm["overalls"]["overall"] if gm else "–")
        out.append(cells)
    return out


def hdr(cols):
    return ["#", "Player", "Age", "Country"] + [c for c, _ in cols] + ["Conf", "Game ovr"]


import datetime as _dt
GAME_CIRCULAR = False   # comparisons now use espn-ratings*-base.json (pre-model ratings), so they are independent again
GAME_TAG = " [CIRCULAR: this file was regenerated from the model's own output at 20:05 on 31 Oct]" if GAME_CIRCULAR else ""


def main():
    cfg = json.load(open(DATA / "model_config.json"))
    tuned = json.load(open(DATA / "tuned_params.json"))
    val = json.load(open(DATA / "ratings_validation.json"))
    md = []
    add = md.append
    latest = q(f"SELECT strftime(max(as_of), '%Y-%m-%d') AS d FROM {R} WHERE snapshot = 'latest'")[0]["d"]
    n = q(f"SELECT count(*) AS n, count(DISTINCT player_id) AS p FROM {R}")[0]
    add("# T20 ratings model: sense-check report\n")
    add(f"Snapshot `latest` is built from balls before {latest} (Cricsheet data ends 2026-10-25). Values are runs per 100 balls "
        "above the average ball faced/bowled in the IPL (men) or top women's leagues, after adjusting for the opponents faced "
        "and the league level; `overall`/`bat_ovr`/`bowl_ovr` are an indicative 0-99 scale (z-score vs active regulars: 65 + 11 z, "
        "clipped 25-99) and `impact` is runs per match (value x balls faced/bowled per match). "
        f"Output table: {int(n['n'])} player-snapshots, {int(n['p'])} players.\n")
    add("Everything below is generated by `ratings-report.py` from the model outputs. Where a check fails, it says so.\n")

    # ───── 1. how it works ─────
    add("## 1. Model in one screen\n")
    lam = cfg["lambda_runs_per_wicket"]
    add(f"- Ball-level residuals vs context expectation (competition-season x phase x wickets x innings x venue), five metrics: runs, "
        f"dismissal avoided, sixes, fours, non-boundary runs. A dismissal is worth **{lam['powerplay']:.1f} / {lam['middle']:.1f} / {lam['death']:.1f} runs** "
        "in powerplay / middle / death (expected runs still to come with vs without that wicket, from 1st-innings states), applied by each player's own phase mix.")
    add("- Opponent + league adjustment: `residual = beta[batter] - gamma[bowler]` fitted by alternating shrunken least squares on every ball "
        "(25 sweeps, converged to <0.0005 runs/ball). Shrinkage target = learned league pool level + role offset. League strength is "
        "learned from players who move between leagues; `league_strength.csv` is only the seed (see section 8).")
    add("- Snapshots: exponentially decayed sums of adjusted ball values from balls strictly before the snapshot date, shrunk to the prior with "
        "a K tuned out-of-sample. Half-lives and K (tuned on 2021-22 and 2023-24 folds only):\n")
    rows = []
    for key, p in tuned.items():
        rows.append([key.replace("_", " "), f"{p['half_life_years']} y", ", ".join(f"{m}={k}" for m, k in p["K"].items())])
    add(table(["model", "half-life", "shrinkage K (balls) per metric"], rows))

    # ───── 2. validation ─────
    add("## 2. Validation\n")
    if GAME_CIRCULAR:
        add("> **Warning.** `data/scraped/espn-ratings*.json` was regenerated at 20:05 on 31 Oct by `compare-model-ratings.ts` from this model's own output (see `game-ratings-comparison.md`), and the pre-regeneration file was not kept. "
            "Every row below labelled *Game Oct-2026* therefore compares the model with a re-ranking of itself and is **not an independent benchmark** (its correlations jumped from 0.60 to 0.78 for men's batting). "
            "The independent game benchmarks are the git-history ones (hand-tuned list; 26-Mar-2026 stats file, section 2b). The earlier, independent Oct-2026 numbers are preserved in `ratings_validation_preaudit.json`.\n")
    add("**2a. Fit through 2024, predict 2025-26** (the 2025-26 fold was never used for tuning). Target = each player's 2025-26 mean opponent-adjusted per-ball value in "
        "elite-tier leagues (IPL, BBL, Hundred, SA20, ILT20, CPL, PSL, MLC, full-member T20Is; runs/100 balls, >= 100 such balls, weighted by balls). "
        "`corr` = weighted correlation, `MSE` in (runs/100)^2, `R2` vs predicting the mean. The Oct-2026 game ratings include 2025-26 (look-ahead).\n")
    for g in ("male", "female"):
        for side, label in (("bat", "batting"), ("bow", "bowling")):
            v = val[g][side]
            rows = []
            for key, name in (("new_long", "New: long-run skill only (round 1)"), ("new_form", "New: + current-form blend"), 
                              ("new_full", "**New: + inactivity decay (final)**"),
                              ("naive_career_to_2024", "Baseline: naive career value to 2024 (no adjustments)"),
                              ("naive_career_incl_test_LOOKAHEAD", "Reference: same naive value INCLUDING 2025-26 (look-ahead)"),
                              ("game_overall_rating", "Game Oct-2026 overall (look-ahead)" + GAME_TAG),
                              ("new_rating_same_players_as_game", "New (final), only players the game rates"),
                              ("prior_only_baseline", "Baseline: league/role prior only")):
                s_ = v[key]
                rows.append([name, s_["players"], f(s_["corr"], 3), f(s_["mse"], 0) if "game" not in key else "n/a", f(s_["r2_vs_constant"], 3) if "game" not in key else "n/a"])
            if "pre2025_hand_tuned_game" in v:
                h = v["pre2025_hand_tuned_game"]
                rows.append(["Game pre-2025 (initial commit, hand-tuned, 49 IPL players): mean of component ratings", h["hand_tuned_mean_of_components"]["players"], f(h["hand_tuned_mean_of_components"]["corr"], 3), "n/a", "n/a"])
                rows.append(["New (final), same players as the hand-tuned list", h["new_rating_same_players"]["players"], f(h["new_rating_same_players"]["corr"], 3), f(h["new_rating_same_players"]["mse"], 0), f(h["new_rating_same_players"]["r2_vs_constant"], 3)])
            if "game_components_ols_in_sample" in v:
                c = v["game_components_ols_in_sample"]
                rows.append(["Game Oct-2026 component ratings, best linear blend (in-sample, generous, look-ahead)" + GAME_TAG, v["game_overall_rating"]["players"], f(c["corr"], 3), "n/a", f(c["r2"], 3)])
            P = v["params"]
            add(f"**{g.capitalize()} {label}** (long half-life {P['half_life_years']} y, form window {P['short_half_life_years']} y)\n")
            add(table(["predictor", "players", "corr", "MSE", "R2"], rows))
            al = v["all_leagues_target"]
            add(f"All-leagues target (weaker-league balls translated): final {f(al['new_rating']['corr'], 3)} ({al['new_rating']['players']} players), long-run only {f(al['new_long']['corr'], 3)}, "
                f"naive {f(al['naive_career_to_2024']['corr'], 3)}, game (look-ahead) {f(al['game_overall_rating']['corr'], 3)}. "
                f"Raw IPL/WPL value without opponent adjustment: final {f(v['raw_ipl_target']['new_rating']['corr'], 3)}, game {f(v['raw_ipl_target']['game_overall_rating']['corr'], 3)} (look-ahead).\n")
            if "age_projection" in v:
                a_ = v["age_projection"]
                add(f"Age projection on top of the final rating (used in `overall`): corr {f(a_['without_age']['corr'], 4)} -> {f(a_['with_age']['corr'], 4)}, MSE {f(a_['without_age']['mse'], 1)} -> {f(a_['with_age']['mse'], 1)}.\n")
    ext = val["external_march_2026"]
    add("**2b. Cleaner comparison with the game: its last stats-derived ratings before the Oct-2026 refresh.** Git history has no game ratings from before 2025 that were derived "
        "from statistics: the earliest (initial commit d41dcfe, 19 Mar 2026) is a 50-player hand-tuned list written for the 2025 IPL (used as a row in 2a), and every "
        "stats-derived version (7552105 onward, 22-26 Mar 2026) was generated from ESPN career stats up to about 26 March 2026. The latest of those (e714d26, 26 Mar 2026, 3,407 men) "
        "is therefore free of look-ahead for anything after 26 March 2026. Test: new model refit through 26 Mar 2026 vs that file, both predicting elite-league value from "
        "27 Mar 2026 to the end of the data (IPL 2026, CPL, MLC, Hundred, Blast etc.). Men only.\n")
    rows = []
    for side, label in (("bat", "batting"), ("bow", "bowling")):
        e = ext[side]
        rows.append([f"{label}: New (final)", e["new_full"]["players"], f(e["new_full"]["corr"], 3)])
        rows.append([f"{label}: New (long-run only)", e["new_long"]["players"], f(e["new_long"]["corr"], 3)])
        rows.append([f"{label}: New (final), only players the game rates", e["new_full_same_players_as_game"]["players"], f(e["new_full_same_players_as_game"]["corr"], 3)])
        rows.append([f"{label}: Game Mar-2026, mean of its component ratings", e["game_mar2026_mean_of_components"]["players"], f(e["game_mar2026_mean_of_components"]["corr"], 3)])
        if "game_mar2026_components_ols_in_sample" in e:
            rows.append([f"{label}: Game Mar-2026, best linear blend of components (in-sample, generous)", e["game_mar2026_mean_of_components"]["players"], f(e["game_mar2026_components_ols_in_sample"]["corr"], 3)])
    add(table(["predictor", "players", "corr"], rows))

    # ───── 3. top lists ─────
    add("## 3. Top lists (latest snapshot)\n")
    add("Eligibility: active in the last 12 months, confidence >= 0.5 (>= 0.4 for all-rounders), >= 8 balls faced (batters) or bowled (bowlers) per match. "
        "Value = runs per 100 balls vs average; Impact = runs per match.\n")
    bcols = [("bat_value", 1), ("bat_value_proj", 1), ("bat_runs", 1), ("bat_dismissal", 2), ("bat_power", 1), ("bat_balls_per_match", 1), ("impact_bat", 2)]
    for title, kind, cols in (("Top 25 men's batters (ranked by batting impact = value x balls faced per match)", "bat", bcols),
                              ("Top 25 men's bowlers (ranked by bowling impact)", "bowl", [("bowl_value", 1), ("bowl_value_proj", 1), ("bowl_economy", 1), ("bowl_wickets", 2), ("bowl_balls_per_match", 1), ("impact_bowl", 2)]),
                              ("Top 25 men's all-rounders (ranked by team-role impact: primary role + half the secondary)", "ar", [("impact", 2), ("bat_value", 1), ("bowl_value", 1), ("bat_ovr", 0), ("bowl_ovr", 0)]),
                              ("Top 25 men's overall (impact)", "all", [("impact", 2), ("bat_value", 1), ("bowl_value", 1), ("overall", 0)])):
        rows = top("male", "latest", kind, 25)
        add(f"**{title}**\n")
        add(table(hdr(cols), fmt_list("male", rows, cols)))
    for title, kind, cols in (("Top 15 women overall (impact)", "all", [("impact", 2), ("bat_value", 1), ("bowl_value", 1), ("overall", 0)]),
                              ("Top 15 women's batters", "bat", bcols),
                              ("Top 15 women's bowlers", "bowl", [("bowl_value", 1), ("bowl_economy", 1), ("bowl_wickets", 2), ("bowl_balls_per_match", 1), ("impact_bowl", 2)])):
        rows = top("female", "latest", kind, 15)
        add(f"**{title}**\n")
        add(table(hdr(cols), fmt_list("female", rows, cols)))

    add("### By role (men, latest)\n")
    role_defs = [
        ("Openers (batting position <= 2.5), by batting value", "bat", f"AND batting_role = 'opener'", "bat_value", [("bat_value", 1), ("bat_pp", 1), ("bat_power", 1), ("bat_dismissal", 2)]),
        ("Finishers (batting position 3+ and >= 30% of balls faced in overs 16-20), by death-overs batting value", "bat", "AND batting_role = 'finisher'", "bat_death", [("bat_death", 1), ("bat_value", 1), ("bat_power", 1), ("bat_balls_per_match", 1)]),
        ("Death bowlers (>= 25% of balls in overs 16-20), by death-overs value", "bowl", "AND bowl_death_share >= 0.25", "bowl_death", [("bowl_death", 1), ("bowl_value", 1), ("bowl_death_share", 2), ("bowl_economy", 1)]),
        ("Powerplay bowlers (>= 35% of balls in overs 1-6), by powerplay value", "bowl", "AND bowl_pp_share >= 0.35", "bowl_pp", [("bowl_pp", 1), ("bowl_value", 1), ("bowl_pp_share", 2), ("bowl_wickets", 2)]),
        ("Spinners (ESPN bowling style), by bowling value", "bowl", "AND pace_spin = 'spin'", "bowl_value", [("bowl_value", 1), ("bowl_mid", 1), ("bowl_economy", 1), ("bowl_wickets", 2)]),
    ]
    for title, kind, extra, order, cols in role_defs:
        rows = top("male", "latest", kind, 10, extra, order)
        add(f"**{title}**\n")
        add(table(hdr(cols), fmt_list("male", rows, cols)))

    # ───── 4. associates ─────
    add("## 4. Associate-nation check (men)\n")
    for kind, nm in (("bat", "batters"), ("bowl", "bowlers")):
        rows = top("male", "latest", kind, 50)
        bad = [(i, r) for i, r in enumerate(rows, 1) if is_assoc("male", r["cricinfo_id"])]
        if not bad:
            add(f"- Top 50 {nm}: **no** associate-nation player (country from ESPN profile; full members = the 12 Test nations).")
        else:
            for i, r in bad:
                add(f"- Top 50 {nm}: #{i} {r['name']} ({country.get(('male', int(r['cricinfo_id'])))}), value {f(r['bat_value' if kind == 'bat' else 'bowl_value'])}, conf {f(r['confidence'], 2)}")
    best = q(f"SELECT name, cricinfo_id, bat_value, bat_confidence FROM {R} WHERE gender='male' AND snapshot='latest' AND {ELIG_BAT} ORDER BY bat_value DESC")
    ranks = [(i, r) for i, r in enumerate(best, 1) if is_assoc("male", r["cricinfo_id"])][:5]
    bestb = q(f"SELECT name, cricinfo_id, bowl_value FROM {R} WHERE gender='male' AND snapshot='latest' AND {ELIG_BOWL} ORDER BY bowl_value DESC")
    ranksb = [(i, r) for i, r in enumerate(bestb, 1) if is_assoc("male", r["cricinfo_id"])][:5]
    flagged = []
    for kind, nm in (("bat", "batters"), ("bowl", "bowlers")):
        for i, r in enumerate(top("male", "latest", kind, 50), 1):
            if is_assoc("male", r["cricinfo_id"]):
                flagged.append((nm, i, r))
    if flagged:
        fr = ", ".join("'" + c.replace("'", "''") + "'" for c in FRANCHISE)
        rows = []
        for nm, i, r in flagged:
            x = q(f"""SELECT count(*) AS n, count(*) FILTER (competition IN ({fr})) AS fr, count(*) FILTER (competition IN ({fr}) OR competition = 'International T20 full members (male)') AS elite
                      FROM (SELECT competition FROM '{DATA}/ball_values.parquet' WHERE batter_id = '{r['player_id']}' AND date >= DATE '2022-10-01'
                            UNION ALL SELECT competition FROM '{DATA}/ball_values.parquet' WHERE bowler_id = '{r['player_id']}' AND date >= DATE '2022-10-01')""")[0]
            rows.append([f"#{i} {nm}", r["name"], country.get(("male", int(r["cricinfo_id"]))), f(r["bat_value" if nm == "batters" else "bowl_value"]), f(r["confidence"], 2),
                         int(x["n"]), int(x["fr"]), int(x["elite"])])
        add("\nAssociate-nation players inside the top 50, with their exposure to top-franchise and full-member cricket over the last four years "
            "(balls faced + bowled). Franchise leagues = IPL, Hundred, BBL, SA20, ILT20, CPL, PSL, MLC. A player with little franchise exposure here is **not** "
            "'genuinely franchise-elite'; those rows are the model still over-crediting associate cricket (open problem, see section 9).\n")
        add(table(["Rank", "Player", "Country", "Value", "Conf", "Balls (4y)", "Franchise balls", "Franchise + full-member balls"], rows))
    add("- Highest-ranked associate-nation eligible batters: " + (", ".join(f"#{i} {r['name']} ({f(r['bat_value'])})" for i, r in ranks) or "none") + f" (of {len(best)} eligible).")
    add("- Highest-ranked associate-nation eligible bowlers: " + (", ".join(f"#{i} {r['name']} ({f(r['bowl_value'])})" for i, r in ranksb) or "none") + f" (of {len(bestb)} eligible).\n")

    # ───── 5. spot checks ─────
    add("## 5. Spot checks\n")
    men_names = ["Andre Russell", "Imran Tahir", "Imad Wasim", "Karanbir", "Jasprit Bumrah", "Rashid Khan", "Virat Kohli", "Jos Buttler", "Suryakumar Yadav", "Travis Head", "Abhishek Sharma", "Heinrich Klaasen",
                 "Sunil Narine", "Kieron Pollard", "Vaibhav", "Virandeep Singh", "Rajat Patidar", "Tilak Varma"]
    women_names = ["Barnett", "Smriti Mandhana", "Beth Mooney", "Sciver", "Sophie Ecclestone"]

    def find(g, pat):
        c = [p for (gg, _), p in game.items() if gg == g and re.search(pat, p["fullName"], re.I)]
        c.sort(key=lambda p: -p["overalls"]["overall"])
        return c[0] if c else None

    def spot(g, names):
        # ranks among eligible regulars of the same gender; game rank among all players the game rates
        grank = {}
        pool = sorted([p for (gg, _), p in game.items() if gg == g], key=lambda p: -p["overalls"]["overall"])
        for i, p in enumerate(pool, 1):
            grank[p["espnId"]] = i
        out = []
        for nm in names:
            p = find(g, nm)
            if not p:
                row = q(f"SELECT * FROM {R} WHERE gender='{g}' AND snapshot='latest' AND name ILIKE '%{nm}%' ORDER BY impact DESC NULLS LAST LIMIT 1")
                if not row:
                    out.append([nm, "not found", "", "", "", "", "", "", "", ""])
                    continue
                p = {"fullName": row[0]["name"], "espnId": -1, "overalls": {"overall": "–"}}
                grank[-1] = "–"
            else:
                row = q(f"SELECT * FROM {R} WHERE gender='{g}' AND snapshot='latest' AND cricinfo_id = {p['espnId']}")
            if not row:
                out.append([p["fullName"], "no snapshot row (not active / no data)", "", "", "", "", "", "", p["overalls"]["overall"], grank[p["espnId"]]])
                continue
            r = row[0]

            def rk(col, where):
                return q(f"SELECT count(*) + 1 AS r FROM {R} WHERE gender='{g}' AND snapshot='latest' AND {where} AND {col} > {r[col]}")[0]["r"] if r[col] is not None else None
            rb = rk("impact_bat", ELIG_BAT) if (r["active"] and r["bat_confidence"] and r["bat_confidence"] >= 0.5 and (r["bat_balls_per_match"] or 0) >= 8) else None
            rw = rk("impact_bowl", ELIG_BOWL) if (r["active"] and r["bowl_confidence"] and r["bowl_confidence"] >= 0.5 and (r["bowl_balls_per_match"] or 0) >= 8) else None
            ro = rk("impact", "active AND confidence >= 0.4 AND (bat_balls_per_match >= 8 OR bowl_balls_per_match >= 8)") if r["active"] else None
            tot_b = q(f"SELECT count(*) AS n FROM {R} WHERE gender='{g}' AND snapshot='latest' AND {ELIG_BAT}")[0]["n"]
            tot_w = q(f"SELECT count(*) AS n FROM {R} WHERE gender='{g}' AND snapshot='latest' AND {ELIG_BOWL}")[0]["n"]
            tot_o = q(f"SELECT count(*) AS n FROM {R} WHERE gender='{g}' AND snapshot='latest' AND active AND confidence >= 0.4 AND (bat_balls_per_match >= 8 OR bowl_balls_per_match >= 8)")[0]["n"]
            out.append([r["name"], f"{f(r['bat_value'])} (#{int(rb)}/{int(tot_b)})" if rb else f"{f(r['bat_value'])} (n/e)",
                        f"{f(r['bowl_value'])} (#{int(rw)}/{int(tot_w)})" if rw else (f"{f(r['bowl_value'])} (n/e)" if r["bowl_value"] is not None else "–"),
                        f"{f(r['impact'], 2)} (#{int(ro)}/{int(tot_o)})" if ro else f"{f(r['impact'], 2)} (n/e)",
                        r["overall"], f(r["age"], 0), f(r["confidence"], 2), f"{r['player_role']}, {r['batting_role'] or '–'}", f"{p['overalls']['overall']} (#{grank[p['espnId']]}/{len(pool)})",
                        "yes" if r["active"] else "no"])
        return out
    heads = ["Player", "Bat value (rank)", "Bowl value (rank)", "Impact (rank)", "New ovr", "Age", "Conf", "Role", "Game ovr (rank)", "Active"]
    add("Rank is among eligible regulars (see section 3); `n/e` = not eligible, usually confidence < 0.5 or low workload. Game rank is among every player the game rates.\n")
    add("**Men**\n")
    add(table(heads, spot("male", men_names)))
    add("**Women**\n")
    add(table(heads, spot("female", women_names)))

    add("**Rating trajectories (start-of-year snapshots, `overall` / batting value / bowling value)**: recency check for ageing players.\n")
    traj = []
    for nm in ("KA Pollard", "V Kohli", "AD Russell", "SP Narine", "JJ Bumrah", "F du Plessis"):
        cells = [nm]
        for sn in ("2018", "2020", "2022", "2024", "2026", "latest"):
            r = q(f"SELECT overall, bat_value, bowl_value, active FROM {R} WHERE gender='male' AND snapshot='{sn}' AND name = '{nm}'")
            cells.append(f"{int(r[0]['overall'])} / {f(r[0]['bat_value'], 0)} / {f(r[0]['bowl_value'], 0)}" if r and r[0]["overall"] is not None else "–")
        traj.append(cells)
    add(table(["Player", "2018", "2020", "2022", "2024", "2026", "latest"], traj))

    add("**Players named in the earlier reviews (latest snapshot).** `value` is the final posterior mean, `long` the long-run skill, `form` the blend with the last ~2 seasons, `proj` the age-projected value used for `overall`, `SD` the posterior SD of the batting value, `months` since the last elite or mid-tier ball.\n")
    rr = []
    for nm, g in (("AD Russell", "male"), ("KA Pollard", "male"), ("Imran Tahir", "male"), ("TM Head", "male"), ("V Suryavanshi", "male"), ("Karanbir Singh", "male"),
                  ("Imad Wasim", "male"), ("V Kohli", "male"), ("SA Yadav", "male"), ("L Barnett", "female")):
        x = q(f"SELECT * FROM {R} WHERE gender='{g}' AND snapshot='latest' AND name = '{nm}' ORDER BY impact DESC NULLS LAST LIMIT 1")
        if not x:
            rr.append([nm, "not found"] + [""] * 9)
            continue
        x = x[0]
        rb = q(f"SELECT count(*) + 1 AS r FROM {R} WHERE gender='{g}' AND snapshot='latest' AND {ELIG_BAT} AND impact_bat > {x['impact_bat']}")[0]["r"] if x["impact_bat"] is not None else None
        rw = q(f"SELECT count(*) + 1 AS r FROM {R} WHERE gender='{g}' AND snapshot='latest' AND {ELIG_BOWL} AND impact_bowl > {x['impact_bowl']}")[0]["r"] if x["impact_bowl"] is not None else None
        rr.append([nm, f(x["age"], 0), f"{f(x['bat_value'])} / {f(x['bat_value_long'])} / {f(x['bat_form'])} / {f(x['bat_value_proj'])}",
                   f(x["bat_sd"], 1), f(x["months_since_major"], 0), f(x["bat_recent_major_balls"], 0), f"#{int(rb)}" if rb else "–",
                   f"{f(x['bowl_value'])} / {f(x['bowl_value_long'])}", f"#{int(rw)}" if rw else "–", x["player_role"], x["overall"]])
    add(table(["Player", "Age", "Bat value / long / form / proj", "Bat SD", "Months since major", "Recent major balls (bat)", "Bat rank (impact)", "Bowl value / long", "Bowl rank", "Role", "Overall"], rr))
    ina = q(f"SELECT name, age, months_since_major, inactivity_factor, bat_value_long, bat_value, bowl_value_long, bowl_value, overall FROM {R} WHERE gender='male' AND snapshot='latest' "
            f"AND inactivity_factor < 0.95 AND (bat_confidence >= 0.5 OR bowl_confidence >= 0.5) ORDER BY greatest(coalesce(bat_value_long, -99), coalesce(bowl_value_long, -99)) DESC LIMIT 12")
    add("**Inactivity decay at work: the best-rated long-run players who have gone more than ~13 months without an elite/mid-tier ball** (rating pulled toward prior; they are also `active = false`, so excluded from the lists above):\n")
    add(table(["Player", "Age", "Months since major ball", "Inactivity factor", "Bat long -> final", "Bowl long -> final", "Overall"],
              [[r["name"], f(r["age"], 0), f(r["months_since_major"], 0), f(r["inactivity_factor"], 2), f"{f(r['bat_value_long'])} -> {f(r['bat_value'])}",
                f"{f(r['bowl_value_long'])} -> {f(r['bowl_value'])}", r["overall"]] for r in ina]))

    # ───── 6. movers ─────
    add("## 6. Biggest movers vs the game's current overall rating (men)\n")
    if GAME_CIRCULAR:
        add("> This section compares with the game file as it is now, which was re-ranked from this model at 20:05 on 31 Oct; the movers below are therefore small by construction and were more meaningful in the earlier runs.\n")
    add("Both sides are converted to a percentile among the same set of players (active in the last 12 months, confidence >= 0.5), so the different scales "
        "do not matter. `Share assoc` = share of the player's T20 balls in the last 4 years that were associate-tier internationals. Reasons are rule-based "
        "from the model's own diagnostics and should be read as hints, not proof.\n")
    rows = q(f"""
WITH g AS (SELECT * FROM {R} WHERE gender='male' AND snapshot='latest' AND active AND confidence >= 0.5 AND cricinfo_id IS NOT NULL),
a AS (SELECT pb.player_id, sum((c.competition LIKE 'International T20 associates%')::INT)::DOUBLE / count(*) AS share_assoc
      FROM (SELECT batter_id AS player_id, competition FROM '{DATA}/ball_values.parquet' WHERE date >= DATE '2022-10-01'
            UNION ALL SELECT bowler_id, competition FROM '{DATA}/ball_values.parquet' WHERE date >= DATE '2022-10-01') c
      JOIN (SELECT DISTINCT player_id FROM g) pb USING (player_id) GROUP BY 1)
SELECT g.*, a.share_assoc FROM g LEFT JOIN a USING (player_id)""")
    gm_rows = []
    for r in rows:
        gm = gname("male", r["cricinfo_id"])
        if gm:
            gm_rows.append((r, gm))
    gs = sorted(x[1]["overalls"]["overall"] for x in gm_rows)
    ns = sorted(x[0]["impact"] for x in gm_rows)

    def pct(arr, v):
        lo = sum(1 for a in arr if a < v)
        eq = sum(1 for a in arr if a == v)
        return (lo + 0.5 * eq) / len(arr)
    movers = []
    for r, gm in gm_rows:
        gp, np_ = pct(gs, gm["overalls"]["overall"]), pct(ns, r["impact"])
        movers.append((np_ - gp, gp, np_, r, gm))
    movers.sort(key=lambda x: x[0])

    def reason(d, r, gm):
        sa = r.get("share_assoc") or 0
        bits = []
        if sa >= 0.4:
            bits.append(f"mostly associate-tier cricket ({sa:.0%} of recent balls): opponent/league adjustment")
        if r["confidence"] < 0.5:
            bits.append(f"thin sample (confidence {r['confidence']:.2f}), shrunk to prior")
        if (r["age"] or 0) >= 36 and d < 0:
            bits.append(f"age {r['age']:.0f}, recency-weighted")
        if d < 0 and gm["role"] == "all-rounder":
            bits.append("game overall formula favours all-rounders; here impact = value x workload")
        if d < 0 and not bits:
            bits.append(f"per-ball value only {f(r['bat_value']) if (r['bat_balls_per_match'] or 0) >= (r['bowl_balls_per_match'] or 0) else f(r['bowl_value'])} runs/100 vs average after opponent adjustment")
        if d > 0 and not bits:
            bits.append(f"steady regular in a full role (bat {f(r['bat_balls_per_match'])}/bowl {f(r['bowl_balls_per_match'])} balls per match) with adjusted value bat {f(r['bat_value'])}, bowl {f(r['bowl_value'])} runs/100; "
                        "the game's career-stat formula rates him low")
        return "; ".join(bits)
    for title, sel in (("Biggest risers (new rates higher than game)", list(reversed(movers[-15:]))), ("Biggest fallers (new rates lower than game)", movers[:15])):
        add(f"**{title}**\n")
        out = []
        for d, gp, np_, r, gm in sel:
            out.append([r["name"], gm["country"], f(r["age"], 0), f"{gm['overalls']['overall']} ({gp:.0%})", f"{r['overall']} ({np_:.0%})", f"{d * 100:+.0f}",
                        f(r["share_assoc"], 2) if r["share_assoc"] is not None else "–", reason(d, r, gm)])
        add(table(["Player", "Country", "Age", "Game ovr (pctile)", "New ovr (pctile)", "Pctile move", "Share assoc", "Likely reason"], out))
    # correlation of new vs game
    cb = [(r["bat_value"], gm["overalls"]["battingOvr"]) for r, gm in gm_rows if r["bat_confidence"] and r["bat_confidence"] >= 0.5 and (r["bat_balls_per_match"] or 0) >= 8]
    cw = [(r["bowl_value"], gm["overalls"]["bowlingOvr"]) for r, gm in gm_rows if r["bowl_confidence"] and r["bowl_confidence"] >= 0.5 and (r["bowl_balls_per_match"] or 0) >= 8]

    def pear(xs):
        n = len(xs)
        mx, my = sum(a for a, _ in xs) / n, sum(b for _, b in xs) / n
        return sum((a - mx) * (b - my) for a, b in xs) / math.sqrt(sum((a - mx) ** 2 for a, _ in xs) * sum((b - my) ** 2 for _, b in xs))
    add(f"Agreement with the game today (active regulars): batting value vs game battingOvr r = {pear(cb):.2f} (n={len(cb)}; the earlier league-adjusted calibration was 0.60), "
        f"bowling value vs bowlingOvr r = {pear(cw):.2f} (n={len(cw)}; earlier 0.32).\n")

    # ───── 7. IPL 2026 squads ─────
    add("## 7. IPL 2026 squads\n")
    cur = json.load(open(DATA / "current_ratings.json"))
    squads = {}
    for p in cur:
        if p.get("team"):
            squads.setdefault(p["team"], []).append(p["cricinfo_id"])
    # actual 2026 table
    res = q(f"""SELECT team, sum(w) AS wins, count(*) AS played FROM (
        SELECT team1 AS team, (winner = team1)::INT AS w FROM '{DATA}/matches.parquet' WHERE event = 'Indian Premier League' AND date >= DATE '2026-01-01' AND stage IS NULL
        UNION ALL SELECT team2, (winner = team2)::INT FROM '{DATA}/matches.parquet' WHERE event = 'Indian Premier League' AND date >= DATE '2026-01-01' AND stage IS NULL)
        GROUP BY 1""")
    if not res:
        res = q(f"""SELECT team, sum(w) AS wins, count(*) AS played FROM (
            SELECT team1 AS team, (winner = team1)::INT AS w FROM '{DATA}/matches.parquet' WHERE event = 'Indian Premier League' AND date >= DATE '2026-01-01'
            UNION ALL SELECT team2, (winner = team2)::INT FROM '{DATA}/matches.parquet' WHERE event = 'Indian Premier League' AND date >= DATE '2026-01-01') GROUP BY 1""")

    def win_pct(tid):
        key = IPL_TEAMS[tid].split()[0]
        m = [r for r in res if r["team"].startswith(key) or (key == "Royal" and r["team"].startswith("Royal Challengers"))]
        return (m[0]["wins"] / m[0]["played"], int(m[0]["played"])) if m else (None, 0)

    def squad_stats(snap):
        out = {}
        for tid, ids in squads.items():
            ids = [int(i) for i in ids if i]
            rows = q(f"SELECT cricinfo_id, overall, impact, name FROM {R} WHERE gender='male' AND snapshot='{snap}' AND cricinfo_id IN ({','.join(map(str, ids))}) AND overall IS NOT NULL")
            rows = [r for r in rows if r["impact"] is not None]
            rows.sort(key=lambda r: -r["impact"])
            top14 = rows[:14]
            top11 = rows[:11]
            gms = sorted([game[("male", i)]["overalls"]["overall"] for i in ids if ("male", i) in game], reverse=True)[:14]
            out[tid] = {"n": len(ids), "rated": len(rows), "mean_ovr": sum(r["overall"] for r in top14) / max(len(top14), 1),
                        "xi_impact": sum(r["impact"] for r in top11), "game_mean": sum(gms) / max(len(gms), 1)}
        return out

    def spearman(a, b):
        def rank(x):
            order = sorted(range(len(x)), key=lambda i: x[i])
            r = [0.0] * len(x)
            i = 0
            while i < len(order):
                j = i
                while j + 1 < len(order) and x[order[j + 1]] == x[order[i]]:
                    j += 1
                for k in range(i, j + 1):
                    r[order[k]] = (i + j) / 2
                i = j + 1
            return r
        ra, rb = rank(a), rank(b)
        n = len(a)
        ma, mb = sum(ra) / n, sum(rb) / n
        return sum((x - ma) * (y - mb) for x, y in zip(ra, rb)) / math.sqrt(sum((x - ma) ** 2 for x in ra) * sum((y - mb) ** 2 for y in rb))
    for snap, label in (("2026", "start of 2026 (balls before 2026-01-01: a genuine pre-season view)"), ("latest", "latest (includes the 2026 season)")):
        st = squad_stats(snap)
        order = sorted(st, key=lambda t: -st[t]["xi_impact"])
        rows = []
        for t in order:
            wp, pl = win_pct(t)
            rows.append([t.upper(), st[t]["n"], st[t]["rated"], f(st[t]["mean_ovr"]), f(st[t]["xi_impact"], 1), f(st[t]["game_mean"]),
                         f"{wp:.0%}" if wp is not None else "–"])
        add(f"**Snapshot: {label}.** Mean = mean `overall` of the squad's 14 highest-impact rated players; XI impact = summed runs/match of the best 11 "
            "(a proxy for expected margin vs an average XI); Game mean = same 14-player mean using the game's overall. Win% = actual 2026 IPL league-stage win rate.\n")
        add(table(["Team", "Squad", "Rated", "Mean ovr (top 14)", "XI impact (runs/match)", "Game mean (top 14)", "2026 win%"], rows))
        pairs = [(st[t]["xi_impact"], win_pct(t)[0], st[t]["mean_ovr"], st[t]["game_mean"]) for t in st if win_pct(t)[0] is not None]
        if len(pairs) >= 6:
            add(f"Spearman vs 2026 win%: XI impact {spearman([p[0] for p in pairs], [p[1] for p in pairs]):+.2f}, mean ovr {spearman([p[2] for p in pairs], [p[1] for p in pairs]):+.2f}, "
                f"game mean {spearman([p[3] for p in pairs], [p[1] for p in pairs]):+.2f} (n={len(pairs)} teams; one season of 14 games is mostly noise, and rosters here are auction-time, not match-day XIs).\n")

    # ───── 8. diagnostics ─────
    add("## 8. Diagnostics\n")
    ll = list(csv.DictReader(open(DATA / "league_levels.csv")))
    men = [r for r in ll if r["gender"] == "male"]
    add("**League levels learned by the model, men** (average adjusted skill of players in that league, runs/100 balls vs IPL = 0; seed = mean of batting/bowling strength in `league_strength.csv`):\n")
    add(table(["competition", "batter pool", "bowler pool", "seed"], [[r["competition"], r["batter_pool"], r["bowler_pool"], r["seed_from_league_strength"]] for r in men]))
    wom = [r for r in ll if r["gender"] == "female"]
    add("**Women:**\n")
    add(table(["competition", "batter pool", "bowler pool", "seed"], [[r["competition"], r["batter_pool"], r["bowler_pool"], r["seed_from_league_strength"]] for r in wom]))
    ac = list(csv.DictReader(open(DATA / "age_curve.csv")))
    add("**Age curve** (cumulative level in runs/100 balls relative to age 27, estimated from year-over-year changes of the same players; selection and regression to the mean are only partly controlled, see caveats):\n")
    rows = []
    for g in ("male", "female"):
        for side in ("bat", "bow"):
            d = {int(r["age"]): r for r in ac if r["gender"] == g and r["side"] == side}
            rows.append([f"{g} {side}"] + [(d[a]["cumulative_level_unshrunk"] + " -> " + [v for k_, v in d[a].items() if k_.startswith("cumulative_level_shrunk")][0] + f" (n={d[a]['player_year_pairs']})") if a in d else "–" for a in (20, 23, 27, 31, 34, 37)])
    add(table(["curve", "age 20", "23", "27", "31", "34", "37"], rows))
    # lambda sensitivity
    sens = q(f"""WITH e AS (SELECT name, bat_runs AS a, bat_value AS b, bat_runs + 0.5 * (bat_value - bat_runs) AS lo, bat_runs + 1.5 * (bat_value - bat_runs) AS hi
                 FROM {R} WHERE gender='male' AND snapshot='latest' AND {ELIG_BAT})
              SELECT corr(rank_a, rank_b) AS c_runs_only, corr(rank_lo, rank_b) AS c_half, corr(rank_hi, rank_b) AS c_150 FROM (
                SELECT rank() OVER (ORDER BY a) AS rank_a, rank() OVER (ORDER BY b) AS rank_b, rank() OVER (ORDER BY lo) AS rank_lo, rank() OVER (ORDER BY hi) AS rank_hi FROM e)""")[0]
    add(f"**Wicket-value sensitivity (men's batters, rank correlation with the headline value):** runs only (no dismissal term) {sens['c_runs_only']:.2f}, "
        f"wicket value x0.5 {sens['c_half']:.2f}, x1.5 {sens['c_150']:.2f}. Pricing dismissals at half or 1.5x the derived value barely moves the ranking; dropping them entirely does (a run-only ranking rewards low-average sloggers and penalises anchors such as Kohli).\n")
    add("## 9. How the components map onto the game's attributes\n")
    add(table(["Game attribute", "Model column (per 100 balls vs average, common scale)", "Notes"], [
        ["battingIQ", "`bat_dismissal` (outs avoided) + `bat_runs`", "dismissal avoidance is the 'IQ' part; tempo is `bat_runs`"],
        ["timing", "`bat_timing` (fours above expectation)", "boundary-hitting without the six-hitting component"],
        ["power", "`bat_power` (sixes above expectation)", ""],
        ["running", "`bat_running` (non-boundary runs above expectation)", "singles/twos/threes"],
        ["clutch", "none directly", "not modelled: no pressure-state metric; `bat_death`/`bowl_death` are the nearest proxies"],
        ["wicketTaking", "`bowl_wickets` (wickets above average)", ""],
        ["economy", "`bowl_economy` (runs saved)", ""],
        ["accuracy", "`bowl_accuracy` (wide/no-ball runs saved)", "small signal, untuned shrink"],
        ["role / phases", "`batting_role`, `bowling_role`, `bat_pp/mid/death`, `bowl_pp/mid/death`", "from batting position, share of balls per phase"],
        ["pace / spin", "`pace_spin`, `bowling_style`, `batting_style`", "ESPN profile text"],
        ["overall", "`impact` (runs per match) -> `overall`, `bat_ovr`, `bowl_ovr`", "value x workload, so an all-rounder is not favoured by construction"],
    ]))
    # ───── 10. round 3 ─────
    tp = json.load(open(DATA / "tuned_params.json"))
    stab = json.load(open(DATA / "behaviour_stability.json"))
    add("## 10. Round 3: one Bayesian frame, conservative rating, rescaled overall, consistency, clutch\n")
    add("""**Frame.** Every player's batting and bowling skill is a normal posterior. Prior N(mu0, tau^2): mu0 = league pool + role offset, tau^2 = sigma^2 / K (so the tuned shrinkage K *is* the prior SD). Each ball is N(skill, sigma^2), weighted by recency (decay) and, for weaker league tiers, discounted to rho^2 of an elite ball of information (rho = the league-translation transfer correlation, about 0.6). Posterior mean = the shrinkage estimate already used; posterior SD = sigma / sqrt(K + information). Columns: `bat_mean`/`bat_sd`, `bowl_mean`/`bowl_sd`. The inactivity factor scales the deviation from the prior, so the SD widens toward tau as phi falls. The hard exposure gate from round 2 is gone: thin elite exposure now shows up as a wide SD. Conservative rating = mean - k SD (`bat_cons`, `bowl_cons`); `overall` is computed from the conservative, age-projected impact. Composite SD treats the runs and dismissal parts as independent.\n""")
    rows = []
    for g in ("male", "female"):
        for side, label in (("bat", "batting"), ("bow", "bowling")):
            P = tp[f"{g}_{side}"]
            curve = P["k_curve"]
            v = val[g][side]
            hold = v["conservatism_holdout"]
            rows.append([f"{g} {label}", P["k_validated"], P["k"],
                         " / ".join(f"{k}: {f(curve[k]['top_realised'], 1)}" for k in ("0.0", "0.5", "1.0", "2.0")),
                         f"{f(hold['0.0']['corr'], 3)} / {f(hold['0.0']['mse'], 0)} / {f(hold['0.0']['top_realised'], 1)}",
                         f"{f(hold[str(float(P['k']))]['corr'], 3)} / {f(hold[str(float(P['k']))]['mse'], 0)} / {f(hold[str(float(P['k']))]['top_realised'], 1)}"])
    add("**Conservatism k.** Tuned on the 2021-22 and 2023-24 folds as the k whose top-N by (mean - k SD) realises the best elite-league value in the next two years (N = 25 men, 12 women). "
        "Squared error is minimised at k = 0 by construction (the posterior mean is the best point prediction), so k > 0 is a selection choice, not an accuracy gain. Validation is nearly indifferent: "
        "validation picks small k (column 'k validated'). I floor k at 0.5 and cap it at 1.0 for the published ratings so thin records are visibly discounted without letting a noisy top-N criterion dominate; the table shows what that costs on the untouched 2025-26 holdout.\n")
    add(table(["model", "k validated", "k used", "tuning folds: top-N realised value at k = 0 / 0.5 / 1 / 2", "holdout k=0: corr / MSE / top-N realised", "holdout k used: corr / MSE / top-N realised"], rows))
    ext = val["external_march_2026"]
    add("26-Mar-2026 test (men): realised value of the top 25 by mean - k SD, k = 0 / 0.5 / 1 / 2: batting " +
        " / ".join(f(ext["bat"]["conservatism"][k]["top_realised"], 1) for k in ("0.0", "0.5", "1.0", "2.0")) + "; bowling " +
        " / ".join(f(ext["bow"]["conservatism"][k]["top_realised"], 1) for k in ("0.0", "0.5", "1.0", "2.0")) + ".\n")

    add("**Rescaled 0-99.** Each of `overall`, `bat_ovr`, `bowl_ovr` is the conservative rating's position among active regulars of that gender and snapshot, through a normal CDF calibrated so the median regular is 70 and the best regular 98.5; everyone else falls in between by their distance, so ties at the top disappear and only a genuine #1 sits near 99.\n")
    for g, n in (("male", 10), ("female", 10)):
        rows = q(f"SELECT name, age, overall, round(impact, 2) AS impact, round(bat_cons, 1) AS bc, round(bowl_cons, 1) AS wc FROM {R} WHERE gender = '{g}' AND snapshot = 'latest' AND active AND confidence >= 0.4 AND (bat_balls_per_match >= 8 OR bowl_balls_per_match >= 8) ORDER BY impact DESC LIMIT {n}")
        add(f"Top {n} {g} by `overall`: " + "; ".join(f"{r['name']} {int(r['overall'])} ({f(r['impact'], 2)})" for r in rows) + "\n")
    dist = q(f"SELECT count(*) FILTER (overall >= 95) AS n95, count(*) FILTER (overall >= 90) AS n90, count(*) FILTER (overall >= 80) AS n80, count(*) AS n FROM {R} WHERE gender='male' AND snapshot='latest' AND active AND confidence >= 0.4")[0]
    add(f"Men at the latest snapshot (active, confidence >= 0.4, n = {int(dist['n'])}): {int(dist['n95'])} at 95+, {int(dist['n90'])} at 90+, {int(dist['n80'])} at 80+ (round 2 had at least 8 at 99).\n")
    for col, lab in (("bat_ovr", "bat_ovr"), ("bowl_ovr", "bowl_ovr")):
        gcol = "bat_cons" if col == "bat_ovr" else "bowl_cons"
        el = ELIG_BAT if col == "bat_ovr" else ELIG_BOWL
        rows = q(f"SELECT name, {col} AS o, round({gcol}, 1) AS c FROM {R} WHERE gender='male' AND snapshot='latest' AND {el} ORDER BY {col} DESC, {gcol} DESC LIMIT 10")
        add(f"Top 10 men by `{lab}` (conservative value in brackets): " + "; ".join(f"{r['name']} {int(r['o'])} ({f(r['c'], 1)})" for r in rows) + "\n")

    add("**Where the named players land (latest snapshot, men).** Career balls = balls faced (batting) or faced by (bowling); SD in runs/100 balls; rank = rank by `overall` among active regulars.\n")
    rr = []
    for nm in ("Usman Tariq", "V Suryavanshi", "JJ Bumrah", "Rashid Khan", "SP Narine"):
        x = q(f"SELECT * FROM {R} WHERE gender='male' AND snapshot='latest' AND name ILIKE '%{nm}%' ORDER BY impact DESC NULLS LAST LIMIT 1")
        if not x:
            continue
        x = x[0]
        rk = q(f"SELECT count(*) + 1 AS r FROM {R} WHERE gender='male' AND snapshot='latest' AND active AND confidence >= 0.4 AND impact > {x['impact']}")[0]["r"]
        side_b = x["impact_bat"] >= x["impact_bowl"]
        rr.append([x["name"], f(x["age"], 0), int(x["bat_balls_career"] or 0), int(x["bowl_balls_career"] or 0),
                   f"{f(x['bat_mean'])} / {f(x['bat_sd'])} / {f(x['bat_cons'])}" if x["bat_mean"] is not None else "–",
                   f"{f(x['bowl_mean'])} / {f(x['bowl_sd'])} / {f(x['bowl_cons'])}" if x["bowl_mean"] is not None else "–",
                   f(x["impact"], 2), x["overall"], f"#{int(rk)}"])
    add(table(["Player", "Age", "Bat balls", "Bowl balls", "Bat mean / SD / cons", "Bowl mean / SD / cons", "Impact", "Overall", "Rank"], rr))
    ks = (0.0, 0.5, 1.0, 2.0, 3.0)
    rk_rows = {}
    for k in ks:
        ib = f"CASE WHEN bat_value IS NULL THEN 0 ELSE (coalesce(bat_value_proj, bat_value) - {k} * coalesce(bat_sd, 0)) * coalesce(bat_balls_per_match, 0) / 100 END"
        iw = f"CASE WHEN bowl_value IS NULL THEN 0 ELSE (coalesce(bowl_value_proj, bowl_value) - {k} * coalesce(bowl_sd, 0)) * coalesce(bowl_balls_per_match, 0) / 100 END"
        imp = f"(greatest({ib}, {iw}) + 0.5 * greatest(least({ib}, {iw}), 0))"
        for r in q(f"SELECT name, rank() OVER (ORDER BY {imp} DESC) AS rk FROM {R} WHERE gender='male' AND snapshot='latest' AND active AND confidence >= 0.4 AND (bat_balls_per_match >= 8 OR bowl_balls_per_match >= 8)"):
            rk_rows.setdefault(r["name"], {})[k] = int(r["rk"])
    add("**How much conservatism would it take?** Rank by `overall`-style impact among active men at different k (the published ratings use k = 0.5):\n")
    add(table(["Player"] + [f"k={k}" for k in ks], [[nm] + [f"#{rk_rows.get(nm, {}).get(k, '–')}" for k in ks] for nm in ("Usman Tariq", "V Suryavanshi", "JJ Bumrah", "Rashid Khan", "SP Narine", "Imran Tahir", "HC Brook", "Abhishek Sharma")]))
    add("Previous round (for comparison, `overall` / rank by impact): Tariq 99 / #5, Sooryavanshi 99 / #2, Bumrah 99 / #3, Rashid 99 / #7, Narine 99 / #1.\n")

    cb, cw = stab["consistency_stability_bat"], stab["consistency_stability_bow"]
    cs = stab["clutch_stability"]
    add("**Consistency (`bat_consistency`, `bowl_consistency`, `*_match_sd`).** Per-match SD of impact: per-innings value for batters, per-spell value for bowlers, as a dispersion index "
        "(squared deviation of match value from balls x the player's own per-ball mean, in units of the per-ball variance), shrunk toward the population value with 800 pseudo-balls, "
        "5-year half-life. `*_match_sd` is the SD in runs of a typical innings/spell of that player (the game can draw match form ~ Normal(skill mean x balls, match SD)); "
        "`*_consistency` is 99 x the normal CDF of how far below the population index he sits (higher = steadier).\n")
    add("*Year-to-year stability* (same player, consecutive calendar years, >= 150 balls batting / >= 120 bowling in both, weighted by the smaller sample):\n")
    add(table(["", "men", "women"], [
        ["Batting consistency: correlation across consecutive years", f"{f(cb['male']['corr'], 2)} (n={cb['male']['pairs']})", f"{f(cb['female']['corr'], 2)} (n={cb['female']['pairs']})"],
        ["Batting, after removing batting-position effect", f(cb['male'].get('corr_within_batting_position'), 2), f(cb['female'].get('corr_within_batting_position'), 2)],
        ["Bowling consistency: correlation across consecutive years", f"{f(cw['male']['corr'], 2)} (n={cw['male']['pairs']})", f"{f(cw['female']['corr'], 2)} (n={cw['female']['pairs']})"]]))
    rows = q(f"SELECT name, bat_consistency, bat_match_sd, bat_balls_per_match FROM {R} WHERE gender='male' AND snapshot='latest' AND {ELIG_BAT} AND bat_consistency IS NOT NULL ORDER BY bat_consistency DESC LIMIT 5")
    rows2 = q(f"SELECT name, bat_consistency, bat_match_sd, bat_balls_per_match FROM {R} WHERE gender='male' AND snapshot='latest' AND {ELIG_BAT} AND bat_consistency IS NOT NULL ORDER BY bat_consistency ASC LIMIT 5")
    add("Steadiest regular batters: " + "; ".join(f"{r['name']} {int(r['bat_consistency'])}" for r in rows) + ". Most volatile: " + "; ".join(f"{r['name']} {int(r['bat_consistency'])}" for r in rows2) + ".\n")
    add("**Clutch (`clutch`, `big_matches`, `big_match_delta`).** Big matches = Cricsheet stage contains final / semi / quarter / qualifier / eliminator / knockout / challenger / play-off and not place play-off, group, super or first-round "
        f"(about {stab['big_matches_in_data']} T20 matches, {stab['big_match_balls']:,} balls with a known batter or bowler). Performance = opponent-adjusted value per ball in big matches minus the same player's value in all other matches "
        f"(batting and bowling combined), shrunk with the reliability measured below; experience = big matches played (full credit at 20). clutch = 50 + 0.5 x shrunk delta (capped +/-15) + up to 10 for experience.\n")
    add(table(["Big-match delta persistence (players with >= 6 big matches, >= 120 big balls)", "players", "split-half corr", "Spearman-Brown reliability"],
              [["first half of his big matches vs second half", cs["chronological"]["players"], f(cs["chronological"]["split_half_corr"], 3), f(cs["chronological"]["spearman_brown_reliability"], 3)],
               ["odd vs even big matches", cs["odd_even"]["players"], f(cs["odd_even"]["split_half_corr"], 3), f(cs["odd_even"]["spearman_brown_reliability"], 3)]]))
    add(f"Shrinkage used: K = {stab['clutch_shrinkage_K_balls']:.0f} balls (reliability {stab['clutch_reliability_used']:.2f} at the median player's volume), so the performance part moves a typical player's clutch by a point or two at most. "
        "Experience (volume) is the part that actually differentiates players.\n")
    rows = q(f"SELECT name, clutch, big_matches, round(big_match_delta, 1) AS d FROM {R} WHERE gender='male' AND snapshot='latest' AND active AND confidence >= 0.4 ORDER BY clutch DESC, big_matches DESC LIMIT 10")
    add("Highest `clutch` (men): " + "; ".join(f"{r['name']} {int(r['clutch'])} ({int(r['big_matches'])} big matches, delta {f(r['d'], 1)})" for r in rows) + "\n")

    add("## 11. Round-3 status (historical: written before round 4; numbers below are from that run and are superseded by section 12 where they differ)\n")
    add("""| # | Item | Status |
|---|---|---|
| 1 | Overall saturates at 99 | **Fixed.** Calibrated normal-CDF scale: Narine 99, Bumrah 98, Sooryavanshi 97, Brook 95, Tariq 95, Rashid 93, B Kumar 92. 5 men at 95+, 14 at 90+ (round 2: at least 8 at 99). Women's top is still tight (five at 98) because their top six really are within ~0.8 runs/match of each other. |
| 2 | Proven-at-the-top (Tariq, Sooryavanshi) | **Implemented as asked (posterior SD, conservative rating), but it does not move them.** Tariq: bowl mean 19.5, SD 4.6 vs Narine 2.3 and Bumrah 3.1, so conservative 17.2; he stays #5. Sooryavanshi: mean 35.3, SD 9.3, conservative 30.6; #3. Even at k = 3 they are #8 and #7. A normal posterior measures statistical precision, and ~1,500 or ~600 balls at this per-ball level are informative; it does not encode 'has done it for several seasons'. If the owner wants Tariq/Sooryavanshi pulled down, that needs an explicit seasons-at-elite-level term (my earlier sketch: confidence from seasons with >= N elite/mid balls) on top of, or instead of, k. |
| 2b | Accuracy cost of conservatism | Validation says k = 0 is best for point prediction (MSE 240 -> 261 for men's batting, 254 -> 282 for men's bowling on the 2025-26 holdout at k = 0.5) and is nearly indifferent for top-N selection: only men's batting prefers k > 0 (0.5); the 26-Mar-2026 test prefers k = 0 for both men's sides (top-25 realised value 13.8 vs 11.4 batting, 9.0 vs 7.4 bowling at k = 0 vs 0.5). The published k = 0.5 is a policy floor, not a validated optimum. |
| 3 | Consistency | **Usable for batting, not for bowling.** Batting: year-to-year r = 0.34 men, 0.28 women (0.29 / 0.20 after removing batting position): a real but modest, player-specific trait. Bowling per-spell: r = 0.15 / 0.14, i.e. mostly noise; the game should not use `bowl_consistency` (or should shrink it to the population value). `bat_match_sd` is the number to sample match form from. |
| 4 | Clutch | **Mostly noise.** Big-match over/under-performance does not persist: split-half r = 0.05 (first vs second half of a player's big matches), 0.03 (odd vs even), reliability about 0.10. The shrinkage therefore makes the performance part nearly irrelevant; `clutch` effectively measures big-match experience (volume), which is real but is not 'performance under pressure'. I would not describe it to users as clutch ability. |

**Still wrong or weak (carried over and new)**
- Round-2 caveats stand: age projection is heavy for 36+ (about 80 player-years behind it); bowling age curve is flat; weak-league-only players are pinned to the bottom by policy; the IPL 2026 squad order does not correlate with 2026 win rates (n = 10, noisy); fielding/keeping and pace/spin matchups are not modelled.
- The posterior SD uses per-ball noise from the whole population and treats runs and dismissals as independent; it does not include uncertainty in the opponent-adjustment or league-translation parameters, so SDs are somewhat too small, most of all for weak-tier players.
- The SD of the form-blended mean is taken from the long-run posterior (form is a small adjustment).
- Consistency is confounded with role (openers vs finishers) and with how many balls a player faces; the dispersion index removes the ball-count effect but not the role effect for bowlers.
- Big-match definition relies on Cricsheet `stage` text; matches with no stage (13,000 of 14,700 T20s) are all treated as non-big, which includes some unlabelled knockout games.
""")
    # ───── 12. round 4 ─────
    PREV = f"'{DATA}/player_ratings_by_season_round4a.parquet'"
    has_prev = (DATA / "player_ratings_by_season_round4a.parquet").exists()
    tp = json.load(open(DATA / "tuned_params.json"))
    ext = val["external_march_2026"]
    add("## 12. Round 4: proven seasons, international experience, gentler age curve, state-based wicket pricing\n")
    add("""**Columns to rank by.** The proven-adjusted rating is `bat_rank_value_proj` / `bowl_rank_value_proj` (runs per 100 balls: age-projected mean - k x SD, then the proven pull toward the role prior). Without the age projection: `bat_rank_value` / `bowl_rank_value`. The raw skill means for simulation are unchanged: `bat_mean` (= `bat_value`) and `bowl_mean`, with `bat_sd`/`bowl_sd`; `bat_cons`/`bowl_cons` = mean - k SD before the pull. `overall`, `bat_ovr`, `bowl_ovr` are computed from the proven-adjusted columns (`overall_unproven` and `impact_unproven` show them without the pull).\n""")
    add("""**Proven factor.** `elite_seasons` = sum over years of min(1, max(elite/mid-tier balls that year / 120, weighted T20I caps that year / 6)), batting or bowling whichever is larger, using only balls before the snapshot; a full-member T20I counts 1 cap, an associate T20I 0.5. `proven_weight` = min(1, elite_seasons / 5). A conservative rating that sits above the player's role prior may sit only `proven_weight` of the way above it (ratings at or below the prior are untouched), so 1 season keeps 20%, 2 keep 40%, 5+ keep all of it.\n""")
    add("""**Experience attribute** (separate from skill): `intl_matches` (T20Is), `intl_full_member_matches` (T20Is where both sides are full members), `intl_odi_matches`, `intl_test_matches`, `elite_seasons`, `big_matches`, and `experience` 0-99 = 99 x (0.45 x log(1+seasons)/log(16) + 0.35 x log(1+weighted caps)/log(151) + 0.20 x log(1+big matches)/log(41)), each term capped at 1; weighted caps = full-member T20I 1, associate T20I 0.4, full-member ODI 0.35, other ODI 0.15, Test 0.5. Caps count matches in which the player batted or bowled. **Data gap:** this Cricsheet extract contains no Afghanistan internationals at all, so Afghan players (Rashid Khan, Noor Ahmad, Mujeeb, Nabi) have near-zero caps and their national-team balls are missing from every rating.\n""")
    add("**Accuracy effect of the proven pull** (corr / MSE / realised value of the top-N; N = 25 men, 12 women; mean = raw skill mean, conservative = mean - k SD, proven = conservative + pull):\n")
    rows = []
    for g in ("male", "female"):
        for side, label in (("bat", "batting"), ("bow", "bowling")):
            fo = tp[f"{g}_{side}"]["proven_effect_folds"]
            avg = {v: {m: sum(fo[y][v][m] for y in fo) / len(fo) for m in ("corr", "top_realised")} for v in ("mean", "conservative", "proven")}
            ho = val[g][side]["proven_effect"]
            cells = [f"{g} {label}"]
            for v in ("mean", "conservative", "proven"):
                cells.append(f"{f(avg[v]['corr'], 3)} / {f(avg[v]['top_realised'], 1)}")
            for v in ("mean", "conservative", "proven"):
                cells.append(f"{f(ho[v]['corr'], 3)} / {f(ho[v]['mse'], 0)} / {f(ho[v]['top_realised'], 1)}")
            rows.append(cells)
    for side, label in (("bat", "batting"), ("bow", "bowling")):
        e = ext[side]["proven_effect"]
        rows.append([f"men {label}, 26-Mar-2026 test", "", "", ""] + [f"{f(e[v]['corr'], 3)} / {f(e[v]['mse'], 0)} / {f(e[v]['top_realised'], 1)}" for v in ("mean", "conservative", "proven")])
    add(table(["model", "folds 2021-24: mean (corr / top-N)", "conservative", "proven", "holdout 2025-26 or test: mean (corr / MSE / top-N)", "conservative", "proven"], rows))
    add("The pull is a policy choice, not a fitted effect. Its cost is the difference between the 'conservative' and 'proven' columns: it is within +/-0.005 correlation everywhere, because most players with a rating above their prior and a meaningful target already have 5+ seasons; its effect is on the few thin-record players at the top of the list (below).\n")

    # named players
    def pick(nm, g="male", extra=""):
        r = q(f"SELECT * FROM {R} WHERE gender='{g}' AND snapshot='latest' AND name ILIKE '{nm}' {extra} ORDER BY coalesce(bat_balls_career, 0) + coalesce(bowl_balls_career, 0) DESC LIMIT 1")
        return r[0] if r else None
    named = [("Usman Tariq", "Usman Tariq"), ("V Suryavanshi", "V Suryavanshi"), ("JJ Bumrah", "JJ Bumrah"), ("Rashid Khan", "Rashid Khan"), ("SP Narine", "SP Narine"),
             ("HC Brook", "HC Brook"), ("Abhishek Sharma", "Abhishek Sharma"), ("V Kohli", "V Kohli"), ("JC Buttler", "JC Buttler"), ("TM Head", "TM Head")]
    rr = []
    for nm, pat in named:
        x = pick(pat)
        if not x:
            continue
        rk = q(f"SELECT count(*) + 1 AS r FROM {R} WHERE gender='male' AND snapshot='latest' AND active AND confidence >= 0.4 AND impact > {x['impact']}")[0]["r"]
        rku = q(f"SELECT count(*) + 1 AS r FROM {R} WHERE gender='male' AND snapshot='latest' AND active AND confidence >= 0.4 AND impact_unproven > {x['impact_unproven']}")[0]["r"]
        rr.append([x["name"], f(x["age"], 0), f(x["elite_seasons"], 1), f"{x['intl_matches']} / {x['intl_full_member_matches']}", x["experience"], f(x["proven_weight"], 2),
                   f"{x['overall_unproven']} (#{int(rku)}) -> {x['overall']} (#{int(rk)})", f(x["bat_rank_value_proj"]), f(x["bowl_rank_value_proj"])])
    add("**Where they land** (latest snapshot, men; overall before -> after the proven pull, with rank among active regulars):\n")
    add(table(["Player", "Age", "Elite seasons", "T20Is / full-member T20Is", "Experience", "Proven weight", "Overall (rank): unproven -> proven", "bat_rank_value_proj", "bowl_rank_value_proj"], rr))
    for g, n in (("male", 10), ("female", 10)):
        rows = q(f"SELECT name, overall, round(impact, 2) AS impact FROM {R} WHERE gender='{g}' AND snapshot='latest' AND active AND confidence >= 0.4 AND (bat_balls_per_match >= 8 OR bowl_balls_per_match >= 8) ORDER BY impact DESC LIMIT {n}")
        add(f"Top {n} {g} by `overall`: " + "; ".join(f"{r['name']} {int(r['overall'])}" for r in rows) + "\n")
    for col, el, lab in (("bat_rank_value_proj", ELIG_BAT, "bat_ovr"), ("bowl_rank_value_proj", ELIG_BOWL, "bowl_ovr")):
        rows = q(f"SELECT name, {lab} AS o, round({col}, 1) AS c FROM {R} WHERE gender='male' AND snapshot='latest' AND {el} ORDER BY {col} DESC LIMIT 10")
        add(f"Top 10 men by `{col}` ({lab}): " + "; ".join(f"{r['name']} {int(r['o'])} ({f(r['c'], 1)})" for r in rows) + "\n")
    rows = q(f"SELECT name, experience, elite_seasons, intl_matches, big_matches FROM {R} WHERE gender='male' AND snapshot='latest' AND active ORDER BY experience DESC, intl_matches DESC LIMIT 10")
    add("Highest `experience` (men): " + "; ".join(f"{r['name']} {int(r['experience'])} ({f(r['elite_seasons'], 0)} seasons, {int(r['intl_matches'])} T20Is, {int(r['big_matches'] or 0)} big matches)" for r in rows) + "\n")

    # age curve
    add("**Age effect, now shrunk where data are thin.** Each age's yearly change is multiplied by n / (n + 150), n = player-year pairs behind that age (itself and neighbouring ages), before building the cumulative curve. "
        "Holdout (2025-26) accuracy of the projection under different shrinkage (men; correlation / MSE):\n")
    rows = []
    for side, label in (("bat", "batting"), ("bow", "bowling")):
        av = val["male"][side]["age_projection_variants"]
        rows.append([label] + [f"{f(av[k]['corr'], 3)} / {f(av[k]['mse'], 0)}" for k in av])
    add(table(["men"] + list(val["male"]["bat"]["age_projection_variants"].keys()), rows))
    ac = list(csv.DictReader(open(DATA / "age_curve.csv")))
    kcol = [c for c in ac[0] if c.startswith("cumulative_level_shrunk")][0]
    d_ = {(r["gender"], r["side"], int(r["age"])): r for r in ac}
    add("Cumulative age level (runs/100 balls vs age 27), men batting, unshrunk -> shrunk: " + "; ".join(
        f"{a}: {d_[('male', 'bat', a)]['cumulative_level_unshrunk']} -> {d_[('male', 'bat', a)][kcol]}" for a in (31, 34, 36, 37) if ('male', 'bat', a) in d_) + ".\n")
    old = [("V Kohli", "V Kohli"), ("RG Sharma", "RG Sharma"), ("MS Dhoni", "MS Dhoni"), ("AD Russell", "AD Russell"), ("KA Pollard", "KA Pollard"), ("SP Narine", "SP Narine"), ("Imran Tahir", "Imran Tahir")]
    rows = []
    for nm, pat in old:
        x = pick(pat)
        if not x:
            continue
        cur_b = None
        if has_prev:
            pv = q(f"SELECT * FROM {PREV} WHERE gender='male' AND snapshot='latest' AND player_id = '{x['player_id']}'")
            pv = pv[0] if pv else None
        else:
            pv = None
        def rank_bat(expr_col, tbl):
            if x[expr_col.split(' ')[0]] is None and False:
                return None
            return None
        rb_after = q(f"SELECT count(*) + 1 AS r FROM {R} WHERE gender='male' AND snapshot='latest' AND {ELIG_BAT} AND bat_rank_value_proj > {x['bat_rank_value_proj']}")[0]["r"] if x["bat_rank_value_proj"] is not None else None
        rb_before = None
        if pv and pv["bat_value_proj"] is not None:
            rb_before = q(f"SELECT count(*) + 1 AS r FROM {PREV} WHERE gender='male' AND snapshot='latest' AND active AND bat_confidence >= 0.5 AND bat_balls_per_match >= 8 AND coalesce(bat_value_proj, bat_value) - 0.5 * bat_sd > {pv['bat_value_proj'] - 0.5 * pv['bat_sd']}")[0]["r"]
        rows.append([x["name"], f(x["age"], 0), f(x["bat_value"]),
                     f"{f(pv['bat_value_proj']) if pv else '–'} -> {f(x['bat_value_proj'])}",
                     f"{f(pv['bat_value_proj'] - 0.5 * pv['bat_sd']) if pv and pv['bat_value_proj'] is not None else '–'} -> {f(x['bat_rank_value_proj'])}",
                     f"#{int(rb_before)} -> #{int(rb_after)}" if rb_before and rb_after else "–",
                     f"{f(pv['bowl_value_proj']) if pv else '–'} -> {f(x['bowl_value_proj'])}", f"{pv['overall'] if pv else '–'} -> {x['overall']}"])
    add("Older players, before (round 4a: raw age curve, phase-constant wicket price) -> after (this run). Batting rank is among eligible regulars; before-rank uses bat_value_proj - 0.5 SD:\n")
    add(table(["Player", "Age", "bat_value (unprojected)", "bat_value_proj", "ranking rating (proj - 0.5 SD; after = proven)", "bat rank", "bowl_value_proj", "overall"], rows))

    # narine
    add("**Dismissal pricing by state (Narine).** A dismissal is now priced at the expected runs the batting team loses at that over and number of wickets down (first-innings states, smoothed over adjacent overs), instead of one constant per phase (12.0 / 7.9 / 2.9). Implemented by scaling each ball's dismissal residual by wicket_value(over, wickets down) / phase average.\n")
    xs = pick("SP Narine")
    if xs and has_prev:
        pv = q(f"SELECT * FROM {PREV} WHERE gender='male' AND snapshot='latest' AND player_id = '{xs['player_id']}'")[0]
        add(table(["Narine (men, latest)", "phase-constant price (before)", "state-based price (after)"],
                  [["bat_value (mean)", f(pv["bat_value"]), f(xs["bat_value"])], ["bat_runs (runs component, per 100 balls)", f(pv["bat_runs"]), f(xs["bat_runs"])],
                   ["bat_dismissal (dismissal component; unit differs: after = phase-equivalent)", f(pv["bat_dismissal"], 3), f(xs["bat_dismissal"], 3)],
                   ["bat_value_proj", f(pv["bat_value_proj"]), f(xs["bat_value_proj"])], ["bat_ovr", pv["bat_ovr"], xs["bat_ovr"]],
                   ["bat_pp (powerplay batting value)", f(pv["bat_pp"]), f(xs["bat_pp"])], ["overall", pv["overall"], xs["overall"]]]))
    add("Why it does not rescue him: the state price is **close to the old constant** in the states where an opener gets out. From the wicket-value table (men, first innings): with no wickets down, 13.3 / 12.5 / 10.9 / 9.7 runs at overs 0 / 1 / 2 / 3 and 8.0 at over 5; with one down, 15.3 / 14.5 / 13.8 / 12.3 / 9.5 (against the 12.1 powerplay average). "
        "So it is slightly cheaper late in the powerplay and slightly dearer with a wicket already down, and his number barely moves (-22.2 -> -22.9). His runs component is positive (+7.8 per 100 balls) and the dismissal term is what takes him negative: he is dismissed about 3.4 times more per 100 balls than the average ball faced in the same situations. "
        "The model therefore says the extra runs do not pay for the extra dismissals, at any plausible wicket price. If the game wants a pinch-hitter to carry a deliberate dismissal tolerance, that has to be a role-based adjustment (price depends on declared role), which I have not built.\n")

    add("**Accuracy under the two wicket prices** (men batting, 2025-26 holdout correlation with the same-definition target): phase constant 0.438 (naive career baseline 0.361, game with look-ahead 0.651); state-based 0.398 (naive 0.330, game with look-ahead 0.604). The state-priced target is noisier, so every correlation falls, but the model's margin over the naive baseline is similar (+0.077 vs +0.068). On the 26-Mar-2026 test: model minus game-snapshot -0.016 (phase) vs +0.013 (state). Neither price is clearly better; state pricing is the published default and the old behaviour is available with `RATINGS_WICKET_PRICING=phase`.\n")
    add("**Hassan Khan / MLC check.** MLC is classed elite (learned pool -1.1 runs/100 for batters vs IPL 0, seeded at about -2.4 from `league_strength.csv`). Link evidence does not suggest leakage: the 62 men with 100+ balls in MLC and in other elite leagues score about 2 runs/100 *worse* in MLC after opponent adjustment (weighted -2.1), and their performance in MLC relative to their performance everywhere else is about 6.6 below, so MLC runs are not over-credited. The Hassan Khan in question (876 balls faced, 1,630 bowled; 397 of the batting balls in MLC at +21.8 runs/100 vs the MLC average, PSL +9.3, CPL +13.9, BBL -5.4) rates bat_value 5.8, bowl_value about -6, overall 76 in this model, not 90; the 61 USA T20I balls are classed weak-tier and carry little weight. A second 'Hassan Khan' (61 balls) exists in the data, so name matching can mix them up. I did not change MLC's tier.\n")
    # ───── 13. ball-handling audit ─────
    add("## 13. Ball-handling audit (round 5)\n")
    add("Every case was checked against real Cricsheet encodings (`data/cricsheet/all_json`), the pipeline code, and an executable test: `python3 -I src/analysis/__tests__/ball_handling.test.py` builds synthetic matches, runs them through `cricsheet-deliveries.ts` and `player-seasons.sql`, asserts per-player balls / runs / conceded / wickets, and spot-checks real match ids (61 assertions).\n")
    add("""| Case | Correct treatment | Behaviour before | Fixed? |
|---|---|---|---|
| Wide | Not a ball faced, not legal; all its runs are the bowler's | Correct (`wides=0` = faced). Wide + byes / leg-byes / no-ball never occur in the data | Already right |
| Stumped / hit wicket / bowled / caught off a wide (409 balls), run out off a wide (147) | The striker is out and the bowler is credited for the first group; the wide still is not a ball faced | These rows were dropped from the ratings model entirely: no charge to the batter, no credit to the bowler (the season tables credited the bowler, the model did not) | **Fixed**: such a ball counts as faced for dismissal accounting only; run-out-off-wide stays uncredited to the bowler |
| No-ball | Faced by the batter, bat runs are his, the no-ball and bat runs are the bowler's, not a legal delivery | Correct | Already right (tested incl. four off a no-ball) |
| Free hit (14,457 balls) | Runs inflated, bowler-credited dismissals impossible | Mixed into ordinary context cells: batters credited for extra runs, bowlers charged, dismissal-avoidance inflated for batters | **Fixed**: free hits get their own data-derived multiplier on every expectation (runs, sixes, fours, outs); detected as the next non-wide ball after a no-ball (wides do not use it up). Bowler-credited dismissals on free hits are 0.0% in 2025-26 |
| Byes, leg-byes (58k balls), incl. byes off a no-ball (642) | Faced; not the batter's, not the bowler's (only the no-ball is conceded) | Correct | Already right (tested) |
| Penalty runs (46 deliveries, 5 runs each) | Team only | Charged to the bowler as conceded runs and as extras | **Fixed** (`penalty` column, subtracted from `bowler_runs` / `bowler_extras`) |
| Overthrows | Credited to the batter when off the bat | Cricsheet already puts them in `runs.batter`; correct | Already right. Limit: a 5 / 7-run overthrow ball is not a four or six and cannot be identified as a boundary |
| All-run fours (240 balls with `non_boundary`) | Runs, but not a boundary | Counted as fours (and in the power / timing components) | **Fixed** (`is_four` / `is_six` exclude `non_boundary`) |
| Legal-ball numbering; 5-ball (Hundred) sets; short last overs | 6 (or 5) legal balls per over; extras do not advance it | Correct. The 9.9k overs with != 6 legal balls are incomplete final overs, not data errors | Already right (tested: [1,1,1,2,3,4,5,5]) |
| Phase boundaries | Use the innings' own powerplay | Hard-coded over < 6 / < 15: in The Hundred (25-ball powerplay, sets 0-4) set 5 was wrongly 'powerplay' | **Fixed**: powerplay end read from the innings `powerplays` (T20 overs 0-5, Hundred sets 0-4); death = last five overs / sets |
| Bowler-credited dismissals | Whitelist: bowled, caught, caught and bowled, lbw, stumped, hit wicket | Blacklist missed `retired not out`, `handled the ball`, `hit the ball twice`, `timed out` (a handful of balls) | **Fixed** (whitelist) |
| Run out of the non-striker, incl. at the bowler's end (7,719; 48% of run outs) | Debit the player who was out | Batting season tables only counted outs on the striker's row, so non-striker run-outs were never charged to anyone | **Fixed**: `outs_non_striker`, `outs` = on-strike + non-striker (the ratings model deliberately ignores run-outs in its dismissal metric: they are shared luck, and it never mis-assigned them) |
| Retired hurt (247) / retired not out (14) | Not a dismissal; innings continues for the team | `is_wicket = 1`: inflated wickets-down (wrong context cell for the rest of the innings) and batters' `outs` | **Fixed**: stored as `retired_kind`, `is_wicket = 0` |
| Retired out (121) | Team loses a wicket; not the bowler's, and a tactical choice for the player | Counted as a wicket for context (kept), excluded from bowler credit (kept) | Right; documented |
| Two dismissals on one ball (11) | One genuine dismissal | Only entry [0] stored: could be the retirement rather than the dismissal | **Fixed** (first genuine entry, real dismissals preferred over retirements; `wickets_on_ball`) |
| Super overs (208 innings) | Excluded from player value and from context cells | Correct (`super_over = 0`) | Already right (tested) |
| Rain-reduced / D/L (835 chases with `target.overs` < 20, 505 D/L matches) | Not comparable with full innings | Included and phased as if 20 overs | **Fixed**: reduced innings (and a first innings cut short in such a match) are excluded from player value and context: 104,884 balls, 3.1% |
| No result / abandoned / awarded | Balls bowled still count | Included | Right; the 4 'awarded' matches have no balls |
| Chase target / revised target | Would matter if the model used a chase context | The model has no target term at all (context = competition-season x phase x wickets x innings) | Not used; reduced chases are excluded instead |
| Impact-player and concussion substitutes (1,518 balls carry `replacements`) | Attribute balls to whoever bats or bowls | By name / register id from the delivery: correct | Already right |
| Non-T20 formats | Only T20 / IT20 (incl. The Hundred) feed T20 ratings; ODI / Test only for caps | Correct (tested: ODI and Test balls absent from `ball_values`); 19 'T20' matches carry `overs = 50` metadata but have 20-over innings and are kept | Already right |
| The Hundred | Comparable per-ball value | 5-ball sets, own powerplay (now handled), own competition-season cells; league level via the translation layer | Right after the phase fix |
| Incomplete innings, matches ending mid-over, follow-on / declarations | No special handling needed | No multi-day matches in T20 data | n/a |
| `miscounted_overs` (179 innings) | Umpire miscount of an over | Ignored; affects over bookkeeping only | Not an issue |
""")
    PRE = f"'{DATA}/player_ratings_by_season_preaudit.parquet'"
    if (DATA / "player_ratings_by_season_preaudit.parquet").exists():
        pv = json.load(open(DATA / "ratings_validation_preaudit.json"))
        add("**Impact of the fixes on ratings** (latest snapshot, men; before = round 4 output, after = this run). Raw volume: 3.1% of T20 balls dropped (reduced innings); retired-hurt, free-hit, penalty and boundary fixes touch well under 1% of balls each.\n")
        a_top = lambda tbl, col, n: [r["name"] for r in q(f"SELECT name FROM {tbl} WHERE gender='male' AND snapshot='latest' AND active AND confidence >= 0.5 AND {col} IS NOT NULL ORDER BY {col} DESC LIMIT {n}")]
        for lab, col_b, col_a in (("batters (by impact_bat)", "impact_bat", "impact_bat"), ("bowlers (by impact_bowl)", "impact_bowl", "impact_bowl"), ("overall", "impact", "impact")):
            before, after = a_top(PRE, col_b, 25), a_top(R, col_a, 25)
            add(f"Top-25 men {lab}: {len(set(before) & set(after))} of 25 names unchanged; in now: {', '.join(n for n in after if n not in before) or 'none'}; out: {', '.join(n for n in before if n not in after) or 'none'}.\n")
        mv = q(f"SELECT a.name, b.overall AS o_b, a.overall AS o_a, a.overall - b.overall AS d, round(b.bat_value, 1) AS bv_b, round(a.bat_value, 1) AS bv_a, round(b.bowl_value, 1) AS wv_b, round(a.bowl_value, 1) AS wv_a "
               f"FROM {R} a JOIN {PRE} b ON a.player_id = b.player_id AND a.snapshot = b.snapshot AND a.gender = b.gender "
               f"WHERE a.snapshot = 'latest' AND a.gender = 'male' AND a.active AND a.confidence >= 0.5 AND b.overall IS NOT NULL AND a.overall IS NOT NULL ORDER BY abs(a.overall - b.overall) DESC LIMIT 15")
        add("Largest changes in `overall` (active, confidence >= 0.5):\n")
        add(table(["Player", "overall before", "after", "change", "bat_value before -> after", "bowl_value before -> after"], [[r["name"], int(r["o_b"]), int(r["o_a"]), int(r["d"]), f"{f(r['bv_b'])} -> {f(r['bv_a'])}", f"{f(r['wv_b'])} -> {f(r['wv_a'])}"] for r in mv]))
        cnt = q(f"SELECT count(*) AS n, count(*) FILTER (abs(a.overall - b.overall) >= 3) AS n3, count(*) FILTER (abs(a.overall - b.overall) >= 5) AS n5, round(avg(abs(a.overall - b.overall)), 2) AS mad "
                f"FROM {R} a JOIN {PRE} b ON a.player_id = b.player_id AND a.snapshot = b.snapshot AND a.gender = b.gender WHERE a.snapshot = 'latest' AND a.gender = 'male' AND a.active AND a.confidence >= 0.5 AND b.overall IS NOT NULL")[0]
        add(f"Of {int(cnt['n'])} active men, {int(cnt['n3'])} moved by 3+ overall points and {int(cnt['n5'])} by 5+ (mean absolute change {cnt['mad']}). The 0-99 scale is recalibrated each run, so some of this is scale movement.\n")
        rows = []
        for g in ("male", "female"):
            for side, label in (("bat", "batting"), ("bow", "bowling")):
                a_, b_ = val[g][side], pv[g][side]
                rows.append([f"{g} {label}", f"{f(b_['new_full']['corr'], 3)} / {f(b_['naive_career_to_2024']['corr'], 3)} / {f(b_['game_overall_rating']['corr'], 3)}",
                             f"{f(a_['new_full']['corr'], 3)} / {f(a_['naive_career_to_2024']['corr'], 3)} / " + ("n/a (game file now circular)" if GAME_CIRCULAR else f(a_['game_overall_rating']['corr'], 3))])
        for side, label in (("bat", "batting"), ("bow", "bowling")):
            e0, e1 = pv["external_march_2026"][side], val["external_march_2026"][side]
            rows.append([f"men {label}, 26-Mar-2026 test", f"{f(e0['new_full']['corr'], 3)} / {f(e0['game_mar2026_mean_of_components']['corr'], 3)} (game snapshot)", f"{f(e1['new_full']['corr'], 3)} / {f(e1['game_mar2026_mean_of_components']['corr'], 3)} (game snapshot)"])
        add("**Validation before -> after** (2025-26 holdout correlation: new final model / naive career baseline / Oct-2026 game ratings with look-ahead; targets are recomputed under the new definitions, so levels shift for every predictor):\n")
        add(table(["model", "before", "after"], rows))
    open(DATA / "ratings-report.md", "w").write("\n".join(md))
    print(f"wrote {DATA / 'ratings-report.md'}")


if __name__ == "__main__":
    main()
