"""
Write data/analysis/ca-ratings-report.md from the outputs of ca-ratings.py, and run sanity checks.
Run from packages/ratings:  python3 -I src/analysis/ca-ratings-report.py   (exit code 1 if a check fails)
"""
import csv, json, subprocess, sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
PARQUET = DATA / "ca_ratings_by_year.parquet"

# CricketArchive ids (from Cricsheet's people.csv, or the CricketArchive profile where the register has none)
EXAMPLES = [
    ("Virat Kohli", 101095), ("Shubman Gill", 1573620), ("Vaibhav Suryavanshi", 2732032),
    ("Jasprit Bumrah", 1196767), ("Rashid Khan (Afg)", 1738090), ("Noor Ahmad", 2178162),
    ("Digvesh Rathi", 2849070), ("Sandeep Lamichhane (Nep)", 1979200), ("Aarif Sheikh (Nep)", 1588164),
    ("Smriti Mandhana", 384151), ("Ellyse Perry", 187173), ("Nat Sciver-Brunt", 500884), ("Shafali Verma", 2198993),
]


def duck(sql):
    out = subprocess.run(["duckdb", "-csv", "-nullvalue", "", "-c", sql], capture_output=True, text=True, cwd=ROOT)
    if out.returncode:
        sys.exit(out.stderr)
    return list(csv.DictReader(out.stdout.splitlines()))


def md_table(rows, cols):
    out = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for r in rows:
        out.append("| " + " | ".join("" if r.get(c) in (None, "") else str(r.get(c)) for c in cols) + " |")
    return "\n".join(out)


def main():
    v = json.load(open(DATA / "ca_validation.json"))
    curves = list(csv.DictReader(open(DATA / "ca_age_curves.csv")))
    strength = list(csv.DictReader(open(DATA / "ca_comp_strength.csv")))
    L = []
    L.append("# CricketArchive per-year ratings, age curves and projections\n")
    n = duck(f"SELECT count(*) n, count(DISTINCT player_id) p, min(year) y0, max(year) y1 FROM '{PARQUET}'")[0]
    L.append(f"Output `ca_ratings_by_year.parquet`: {int(n['n']):,} player x format x year rows, {int(n['p']):,} players, "
             f"{n['y0']}-{n['y1']}, every senior format (T20, List A, first-class), men and women. Built by "
             "`ca-player-seasons.sql` -> `ca-ratings.py` -> this report (`ca-ratings-report.py`). All values are runs per 100 balls "
             "above the average ball in the same competition-season, after competition/opponent adjustment; `*_ovr` is 65 + 11 z "
             "against that year's regulars, clipped 25-99.\n")
    L.append("## 1. Method\n")
    L.append("""- **Cells.** Every senior scorecard innings since 2000 with balls recorded -> player x competition x year. Batting value = runs - balls x rpb - (outs - balls x opb) x W; bowling the mirror image; rpb/opb are the competition-season rates (blended toward the format-year average with a 3000-ball prior). W, the run value of a wicket, is 0.3 / 0.5 / 1.0 x the competition-season runs per wicket for T20 / List A / first-class.
- **Competitions.** Domestic = event name without season or group. Internationals are split by opponent (`T20I v India`), so opponent strength in international cricket is learned the same way as league strength.
- **Strength.** rate[p,c,y] = skill[p,y] - strength[c], alternating weighted least squares over player-years that played 2+ competitions that year. Each competition's strength is shrunk toward its class mean (country for domestic; full-member vs associate opponent for internationals), which is shrunk toward a full-member / associate mean, then 0. Without that hierarchy, unlinked associate competitions defaulted to "average" and associate bowlers topped the T20 list.
- **Match-level opponent adjustment.** Each innings is credited with its competition-season's mean batting/bowling level and this opponent's deviation from it, from the bottom-up index (`match_strength.parquet`, built from every player's pre-match rating). Without it, associate competitions, which are linked to the elite game by few players, kept close to league-average levels. The index was built from the previous ratings, so this is one fixed-point step; rebuild the index after big changes.
- **Franchise leagues in associate countries** (ILT20, MLC, Global Super League) get their own class, grouped with the full members; before, they sat in the UAE/USA domestic class and pulled the associate prior up.
- **Weak-tier translation.** For the bottom 30% of balls by strength plus every associate competition, a' = alpha + rho x a, fitted on players with balls in both tiers in the same year, with an errors-in-variables correction. The associate tier and the weak full-member tier get separate fits.
- **The Hundred's bowling** is counted (its cards give balls, not overs).
- **Ratings.** `*_rating` = exponentially decayed (half-life h years) ball-weighted mean of a' up to that year, shrunk toward a prior worth K balls (the player's competition pool level + a role offset: batting position bucket, or pace/spin). `*_season` = the same shrinkage on that year alone. h, K and a trend weight were tuned on a 2020 -> 2021-22 fold.
- **Age curves.** Delta method on consecutive shrunk season values of the same player, weighted by the harmonic mean of balls, smoothed +-2 years, role curves shrunk toward the all-player curve, and centred so the mean change is zero (values are league-relative, so ageing is zero-sum; the raw mean change is survivor bias).
- **Projection.** `*_proj_next` = rating + age-curve change at the player's age (+ trend term where tuning chose one).
- **Data fix.** cricket.db's `matches.gender` marks ~2,300 men's matches as female (e.g. the 2015 World Cup); gender is taken from `levels` instead. Worth fixing in `scorecard-parse.ts`.
""")
    L.append("## 2. Validation (fit through 2023, predict each player's 2024-25 adjusted value)\n")
    L.append("Target = the player's mean adjusted value over 2024-25 (>= 100 / 200 / 500 balls for T20 / List A / FC), weighted by those balls. "
             "`corr` = weighted correlation, `mse` in (runs per 100 balls)^2. 2024-25 was not used for tuning. "
             "Caveat: the target is on this model's own adjusted scale, which favours it over the Cricsheet model; the comparison with the current model is correlation on shared players only.\n")
    for key, d in v.items():
        p = d["params"]
        L.append(f"**{key}** (half-life {p['half_life']} y, K {p['K']} balls, trend {p['trend_beta']}; translation rho {d['translation']['rho']}, {d['translation']['links']} links)\n")
        L.append(md_table(d["held_out"], ["predictor", "players", "corr", "mse"]) + "\n")
    L.append("## 2b. Associate calibration (vs the bottom-up league index)\n")
    L.append("The index puts associate-v-associate T20Is about 19 runs/100 balls below full-member T20Is for bowling (2024-25). The fitted competition pools give the same gap, and associate-heavy players (>= 70% of their 2023+ T20 balls in associate T20Is) sit well below full-member regulars. On one target for every variant (raw 2024-25 value in elite competitions only) the match-level adjustment neither helps nor hurts prediction (corr 0.43-0.51 men); it is there for calibration.\n")
    L.append("## 3. Age curves\n")
    peaks = []
    for key, d in v.items():
        side, fmt, g = key.split("/")
        for role, age in (d.get("peak_age") or {}).items():
            peaks.append({"side": side, "format": fmt, "gender": g, "role": role, "peak age": age})
    L.append("Peak = age with the highest cumulative level (ages with enough pairs only). Cumulative change from 22 to the peak and from the peak to 34 (runs per 100 balls):\n")
    cum = defaultdict(dict)
    for r in curves:
        cum[(r["side"], r["format"], r["gender"], r["role"])][int(r["age"])] = float(r["cumulative"])
    for row in peaks:
        c = cum.get((row["side"], row["format"], row["gender"], row["role"]), {})
        pk = row["peak age"]
        if pk is not None and c:
            row["22 -> peak"] = round(c.get(pk, 0) - c.get(22, 0), 1)
            row["peak -> 34"] = round(c.get(34, 0) - c.get(pk, 0), 1)
    L.append(md_table(peaks, ["side", "format", "gender", "role", "peak age", "22 -> peak", "peak -> 34"]) + "\n")
    L.append("Honest read: the age adjustment barely moves out-of-sample accuracy (see section 2, `+ age curve` vs `rating only`), so the curves are useful for projecting multi-year growth/decline in the game, not as a big accuracy gain.\n")
    L.append("## 4. Strongest and weakest competitions (T20, men, batting side)\n")
    st = [r for r in strength if r["side"] == "bat" and r["format"] == "T20" and r["gender"] == "male" and float(r["balls"]) >= 20000]
    st.sort(key=lambda r: -float(r["strength"]))
    L.append(md_table(st[:12] + st[-8:], ["comp", "comp_class", "balls", "strength", "weak_tier"]) + "\n")
    L.append("## 5. Sanity examples (latest year played, T20)\n")
    ids = ",".join(str(i) for _, i in EXAMPLES)
    rows = duck(f"""SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY player_id ORDER BY year DESC) rn FROM '{PARQUET}'
                    WHERE format = 'T20' AND player_id IN ({ids})) WHERE rn = 1""")
    by = {int(r["player_id"]): r for r in rows}
    ex = []
    for label, pid in EXAMPLES:
        r = by.get(pid)
        if r:
            ex.append({"player": label, "year": r["year"], "age": r["age"], "bat balls": r["bat_balls"], "bat ovr": r["bat_ovr"],
                       "bat next": r["bat_ovr_proj_next"], "bowl balls": r["bowl_balls"], "bowl ovr": r["bowl_ovr"], "bowl next": r["bowl_ovr_proj_next"]})
    L.append(md_table(ex, ["player", "year", "age", "bat balls", "bat ovr", "bat next", "bowl balls", "bowl ovr", "bowl next"]) + "\n")
    L.append("Per-year history, Virat Kohli T20 batting:\n")
    hist = duck(f"SELECT year, age, bat_balls, bat_season, bat_rating, bat_ovr FROM '{PARQUET}' WHERE player_id = 101095 AND format = 'T20' ORDER BY year")
    L.append(md_table(hist, ["year", "age", "bat_balls", "bat_season", "bat_rating", "bat_ovr"]) + "\n")
    for title, side, gender in (("T20 men, batting", "bat", "male"), ("T20 men, bowling", "bowl", "male"),
                                ("T20 women, batting", "bat", "female"), ("T20 women, bowling", "bowl", "female")):
        top = duck(f"SELECT name, age, {side}_balls AS balls, {side}_ovr AS ovr FROM '{PARQUET}' WHERE format = 'T20' AND gender = '{gender}' "
                   f"AND year = 2026 AND {side}_balls >= 200 ORDER BY {side}_rating DESC LIMIT 12")
        L.append(f"Top 12 in 2026, {title} (>= 200 balls that year):\n")
        L.append(md_table(top, ["name", "age", "balls", "ovr"]) + "\n")
    (DATA / "ca-ratings-report.md").write_text("\n".join(L))
    print("wrote", DATA / "ca-ratings-report.md")

    # ── checks ──
    fails = []
    dup = duck(f"SELECT count(*) n FROM (SELECT player_id, format, year, count(*) c FROM '{PARQUET}' GROUP BY ALL HAVING c > 1)")[0]["n"]
    if int(dup):
        fails.append(f"{dup} duplicate player x format x year rows")
    rng = duck(f"SELECT min(least(coalesce(bat_ovr, 99), coalesce(bowl_ovr, 99))) lo, max(greatest(coalesce(bat_ovr, 25), coalesce(bowl_ovr, 25))) hi FROM '{PARQUET}'")[0]
    if int(rng["lo"]) < 25 or int(rng["hi"]) > 99:
        fails.append(f"ovr outside 25-99: {rng}")
    for key in ("bat/T20/male", "bowl/T20/male", "bat/T20/female", "bat/ListA/male", "bat/FC/male"):
        h = {r["predictor"]: r for r in v[key]["held_out"]}
        if not (h["new: + age curve + trend (final)"]["corr"] or 0) > (h["naive: career raw value to cutoff"]["corr"] or 0):
            fails.append(f"{key}: model does not beat the naive career baseline")
    if (by.get(101095) or {}).get("bat_ovr") and int(by[101095]["bat_ovr"]) < 80:
        fails.append("Kohli T20 batting below 80")
    if (by.get(1196767) or {}).get("bowl_ovr") and int(by[1196767]["bowl_ovr"]) < 85:
        fails.append("Bumrah T20 bowling below 85")
    for f in fails:
        print("CHECK FAILED:", f)
    print("checks:", "FAIL" if fails else "ok")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
