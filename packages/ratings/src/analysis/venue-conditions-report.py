"""
Write data/analysis/venue-conditions-report.md (+ docs/VENUE-CONDITIONS-REPORT.md) and data-export/venue-conditions.json from
the outputs of venue-conditions.py.  Run from packages/ratings:  python3 -I src/analysis/venue-conditions-report.py
"""
import csv, json, math, os, subprocess, sys, time
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DATA = ROOT / "data" / "analysis"
REPO = ROOT.parents[1]
EXPORT = ROOT / "data-export"
TMP = Path(os.environ.get("VENUE_WORK", "/Volumes/Data/tmp/venue"))

MAJOR = {"IND", "PAK", "SL", "BDESH", "AFG", "ENG", "AUS", "RSA", "NZ", "WI", "ZIM", "IRELAND", "UAE"}
IPL_GROUNDS = ["Wankhede Stadium", "M Chinnaswamy Stadium", "MA Chidambaram Stadium (Chepauk)", "Eden Gardens",
               "Arun Jaitley Stadium (Feroz Shah Kotla)", "Rajiv Gandhi International Stadium", "Sawai Mansingh Stadium",
               "Punjab Cricket Association IS Bindra Stadium", "Narendra Modi Stadium (Motera)", "Ekana Cricket Stadium",
               "Maharaja Yadavindra Singh Stadium", "Barsapara Cricket Stadium", "HPCA Stadium", "ACA-VDCA Stadium",
               "Brabourne Stadium", "DY Patil Stadium", "Maharashtra Cricket Association Stadium",
               "Dubai International Cricket Stadium", "Sheikh Zayed Stadium", "Sharjah Cricket Stadium"]
TEST_GROUNDS = ["Lord's", "The Oval", "Old Trafford", "Headingley", "Edgbaston", "Trent Bridge", "The Rose Bowl",
                "Melbourne Cricket Ground", "Sydney Cricket Ground", "Adelaide Oval", "The Gabba", "WACA Ground", "Perth Stadium",
                "Bellerive Oval", "Newlands", "Wanderers Stadium", "Kingsmead", "SuperSport Park", "St George's Park",
                "Basin Reserve", "Hagley Oval", "Seddon Park", "Eden Park", "Bay Oval", "Eden Gardens", "Wankhede Stadium",
                "MA Chidambaram Stadium (Chepauk)", "Arun Jaitley Stadium (Feroz Shah Kotla)", "M Chinnaswamy Stadium",
                "Narendra Modi Stadium (Motera)", "Galle International Stadium", "Sinhalese Sports Club Ground",
                "R Premadasa Stadium", "P Sara Oval", "Pallekele International Stadium", "Shere Bangla National Stadium",
                "Zahur Ahmed Chowdhury Stadium", "Gaddafi Stadium", "National Stadium", "Rawalpindi Cricket Stadium",
                "Multan Cricket Stadium", "Kensington Oval", "Queen's Park Oval", "Sabina Park", "Providence Stadium",
                "Harare Sports Club", "Queens Sports Club", "Dubai International Cricket Stadium", "Sheikh Zayed Stadium"]


def rd(name):
    p = DATA / name
    with open(p, newline="") as f:
        return list(csv.DictReader(f))


def f(x, d=None):
    try:
        return float(x)
    except (TypeError, ValueError):
        return d


def fmt_num(x, nd=1, sign=False):
    v = f(x)
    if v is None: return "–"
    s = f"{v:+.{nd}f}" if sign else f"{v:.{nd}f}"
    return s


def same_ground(name, g):
    return name == g or name.startswith(g + ",")


def table(headers, rows):
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(c) for c in r) + " |")
    return "\n".join(out)


def main():
    vf = rd("venue_factors.csv"); vfe = rd("venue_factors_by_era.csv"); tc = rd("toss_chase.csv"); geo = rd("geography_effects.csv")
    val = rd("venue_validation.csv"); bt = rd("venue_bowler_types.csv"); vb = rd("venue_ball_factors.csv")
    misc = json.load(open(TMP / "misc.json")) if (TMP / "misc.json").exists() else {}
    splits = list(csv.DictReader(open(TMP / "player_region_splits.csv"))) if (TMP / "player_region_splits.csv").exists() else []
    L = []
    W = L.append
    W("# Venues, pitches, toss/chase and geography\n")
    W(f"Generated {time.strftime('%Y-%m-%d')} by `src/analysis/venue-conditions.py` + `venue-conditions-report.py`. Analysis only; "
      "nothing here changes player ratings or the engine.\n")
    W("## 1. Method in one screen\n")
    W("- **Match level (CricketArchive, every senior match 2000+; T20, List A, first-class, men and women).** Each innings: "
      "`y = mu[competition x season x innings] + beta x (batting XI strength - bowling XI strength) + region + country + ground` "
      "for runs per 100 balls (bowler-charged: bat + wides + no-balls), wickets per 100 balls and sixes per 100 balls. "
      "Strengths are the pre-match ratings from `match_strength.parquet`, so a ground isn't credited for the teams that play there. "
      "Ground effects are shrunk to the country, the country to the region (priors: 12 / 40 / 150 innings-equivalents). "
      "Factors: 100 = an average ground for that format and gender; 110 = 10% more runs (or wickets, sixes) than the same teams "
      "would get on an average ground.")
    W("- **Pitch profile** (same model): 2nd minus 1st innings scoring (FC: innings 1-4 and late-minus-early), variability "
      "(spread of innings residuals vs the format's; 1.0 = typical), low-score rate (share of innings in the format's bottom 15% "
      "after allowing for the teams), collapse rate (more than 1.5 sd below the full expectation; baseline 6.7%), dismissal mix "
      "(bowled + lbw share: low/skiddy; caught-behind share: bounce and carry; stumpings: turn), first-class draw / result rates. "
      "Everything shrunk to the format baseline by sample size.")
    W("- **Ball level (Cricsheet, 2005+).** Each ball's runs / bowler wicket / six minus its context mean (format x gender x "
      "event-season x innings x phase), then batter + bowler + country + ground effects by alternating shrunken least squares. "
      "What's left, averaged per ground (or country, region) x bowler type (x phase, x batter hand), is the type's **edge**: how much "
      "better or worse that type does there than the same bowlers do elsewhere. "
      "Value = runs saved per 100 balls + wicket value x extra wickets per 100 balls (8 runs a wicket in T20, 15 in List A, 25 in FC). "
      "Bowler types come from ESPNcricinfo bowling styles, falling back to CricketArchive (first listed style); 87-99% of balls have a "
      "type. Test days are approximate (90 overs a day).")
    W("- **Toss / chase / home**: logistic regressions on the strength gap (per 10 runs/100 balls), with home terms; venue and "
      "competition chase effects are random-intercept estimates shrunk toward the format.  'Were captains right?' compares each toss "
      "decision with the chase effect at that ground and competition estimated from **earlier seasons only**.\n")

    W("## 2. Validation: does knowing the ground help predict 2025-26?\n")
    W("Fit on 2000-2024, predict every 2025-26 innings (runs and wickets per 100 balls) from the teams' strengths, with and "
      "without the ground effects. Ground effects only help where the ground was seen before 2025.\n")
    W(table(["format", "gender", "metric", "test innings", "RMSE without ground", "RMSE with ground", "MSE reduction", "grounds seen"],
            [[r["format"], r["gender"], {"rp100": "runs/100", "wp100": "wkts/100"}[r["metric"]], r["test_innings"], r["rmse_no_venue"],
              r["rmse_with_venue"], r["mse_reduction_pct"] + "%", r["grounds_seen_in_training_pct"] + "%"] for r in val]))
    W("")

    def top(fmt, scope, g, key, n, min_m, reverse=True, era="all"):
        rows = [r for r in vf if r["format"] == fmt and r["scope"] == scope and r["gender"] == g and int(r["matches"]) >= min_m
                and f(r[key]) is not None and r["country"] in MAJOR]
        rows.sort(key=lambda r: f(r[key]), reverse=reverse)
        return rows[:n]

    def ground_rows(rows, fc=False):
        out = []
        for r in rows:
            base = [r["venue"], r["country"], r["matches"], fmt_num(r["run_factor"]), fmt_num(r["wkt_factor"])]
            base += [fmt_num(r.get("runs_per_wkt_factor"))] if fc else [fmt_num(r.get("six_factor"))]
            if fc:
                base += [fmt_num(r.get("late_minus_early_run"), 1, True), fmt_num(r.get("draw_rate"), 2), fmt_num(r["variability"], 2),
                         fmt_num(r["bowled_lbw_share_pp"], 1, True), fmt_num(r["caught_behind_share_pp"], 1, True)]
            else:
                base += [fmt_num(r.get("inn2_minus_inn1_run"), 1, True), fmt_num(r["variability"], 2), fmt_num(r["collapse_rate"], 3),
                         fmt_num(r["bowled_lbw_share_pp"], 1, True), fmt_num(r["caught_behind_share_pp"], 1, True)]
            out.append(base)
        return out

    LO_H = ["ground", "country", "matches", "run factor", "wkt factor", "six factor", "2nd-1st inn (runs/100)", "variability",
            "collapse rate", "bowled+lbw pp", "caught-behind pp"]
    FC_H = ["ground", "country", "matches", "run-rate factor", "wkt factor", "runs per wkt factor", "late-early inn (runs/100)", "draw rate",
            "variability", "bowled+lbw pp", "caught-behind pp"]
    W("## 3. Most batting- and bowling-friendly grounds\n")
    W("Headline tables list grounds in full-member countries plus the UAE; associate grounds (and women's first-class, too thin "
      "to rank) are in `venue_factors.csv`.\n")
    W("Run factor 100 = average; the standard error is about 1 point at well-used grounds and 2-3 at thin ones (`run_se` in the CSV is "
      "in runs per 100 balls). Wicket factor > 100 = more wickets than the same teams would lose elsewhere. First-class and Tests are "
      "ranked by runs per wicket (run-rate factor / wicket factor), the usual meaning of a batting pitch in long-form cricket; "
      "limited-overs grounds by run rate.\n")
    for fmt, scope, g, min_m, label in [("T20", "all", "male", 40, "T20, men"), ("T20", "all", "female", 20, "T20, women"),
                                        ("T20", "T20I", "male", 15, "T20Is, men"),
                                        ("ListA", "all", "male", 40, "List A, men"), ("ListA", "ODI", "male", 15, "ODIs, men"),
                                        ("ListA", "ODI", "female", 8, "ODIs, women"),
                                        ("FC", "Test", "male", 10, "Tests, men"), ("FC", "all", "male", 40, "First-class, men")]:
        fc = fmt == "FC"
        key = "runs_per_wkt_factor" if fc else "run_factor"
        hi = top(fmt, scope, g, key, 10, min_m); lo = top(fmt, scope, g, key, 10, min_m, reverse=False)
        if not hi: continue
        W(f"### {label} (min {min_m} matches)\n")
        W("**Best for batting**\n"); W(table(FC_H if fc else LO_H, ground_rows(hi, fc))); W("")
        W("**Best for bowling**\n"); W(table(FC_H if fc else LO_H, ground_rows(lo, fc))); W("")

    W("## 4. Pitch profile extremes\n")
    for fmt, scope, g, min_m, label in [("T20", "all", "male", 40, "T20 men"), ("ListA", "ODI", "male", 15, "ODIs men"),
                                        ("FC", "Test", "male", 10, "Tests men")]:
        rows = [r for r in vf if r["format"] == fmt and r["scope"] == scope and r["gender"] == g and int(r["matches"]) >= min_m
                and r["country"] in MAJOR]
        if not rows: continue
        W(f"### {label} (full-member and UAE grounds)\n")
        def lst(key, rev=True, n=6, nd=2):
            rr = sorted([r for r in rows if f(r.get(key)) is not None], key=lambda r: f(r[key]), reverse=rev)[:n]
            return ", ".join(f"{r['venue']} ({fmt_num(r[key], nd, key.endswith('pp') or 'minus' in key)})" for r in rr)
        W(f"- **Most variable** (spread of scores vs expectation): {lst('variability')}")
        W(f"- **Most predictable**: {lst('variability', False)}")
        W(f"- **Highest collapse rate**: {lst('collapse_rate', nd=3)}")
        W(f"- **Bounce / carry** (caught-behind share, pp vs format): {lst('caught_behind_share_pp', nd=1)}")
        W(f"- **Low / skiddy** (bowled + lbw share, pp): {lst('bowled_lbw_share_pp', nd=1)}")
        W(f"- **Turn** (stumping share, pp): {lst('stumped_share_pp', nd=1)}")
        if fmt == "FC":
            W(f"- **Deteriorates most** (innings 3-4 minus 1-2, runs/100): {lst('late_minus_early_run', False, nd=1)}")
            W(f"- **Gets better to bat on**: {lst('late_minus_early_run', True, nd=1)}")
            W(f"- **Most results** (lowest draw rate): {lst('draw_rate', False)}")
            W(f"- **Most draws**: {lst('draw_rate', True)}")
        else:
            W(f"- **Easier to bat 2nd** (runs/100, 2nd minus 1st innings): {lst('inn2_minus_inn1_run', True, nd=1)}")
            W(f"- **Harder to bat 2nd**: {lst('inn2_minus_inn1_run', False, nd=1)}")
        W("")

    W("## 5. IPL grounds over time (T20 men, all T20 at the ground)\n")
    eras = ["2000-07", "2008-13", "2014-19", "2020-23", "2024-26"]
    by = defaultdict(dict)
    for r in vfe:
        if r["format"] == "T20" and r["gender"] == "male" and r["scope"] == "all":
            by[r["venue"]][r["era"]] = r
    allv = {r["venue"]: r for r in vf if r["format"] == "T20" and r["gender"] == "male" and r["scope"] == "all"}
    rows = []
    for g0 in IPL_GROUNDS:
        gname = next((n for n in allv if same_ground(n, g0)), None)
        if not gname: continue
        row = [gname, allv[gname]["matches"], fmt_num(allv[gname]["run_factor"])]
        for e in eras[1:]:
            x = by[gname].get(e)
            row.append(f"{fmt_num(x['run_factor'])} ({x['matches']})" if x else "–")
        row.append(fmt_num(allv[gname].get("inn2_minus_inn1_run"), 1, True))
        rows.append(row)
    rows.sort(key=lambda r: -f(r[2], 0))
    W("Run factor per era (matches in brackets); the era value is shrunk toward the ground's overall value, so thin eras move less.\n")
    W(table(["ground", "matches", "overall", "2008-13", "2014-19", "2020-23", "2024-26", "2nd-1st inn"], rows)); W("")

    # bowler types
    W("## 6. Which bowler types work where\n")
    W("Edge = value per 100 balls vs what the same bowlers do elsewhere (runs saved + wicket value x extra wickets); ± = 1 SE. "
      "Thin cells are shrunk hard, so small edges are the norm; treat |edge| < 2 SE as noise.\n")
    def region_table(fmt, g):
        rows = [r for r in bt if r["level"] == "region" and r["format"] == fmt and r["gender"] == g]
        types = ["RA fast", "RA fast-medium", "RA medium", "LA pace", "off-spin", "wrist-spin", "LA orthodox"]
        regs = sorted({r["key"] for r in rows if int(r["balls"]) > 20000})
        out = []
        for reg in regs:
            line = [reg]
            for t in types:
                x = next((r for r in rows if r["key"] == reg and r["bowler_type"] == t), None)
                line.append(f"{fmt_num(x['value_per100'], 1, True)}" if x and int(x["balls"]) >= 2000 else "–")
            out.append(line)
        return table(["region"] + types, out)
    for fmt, g, label in [("T20", "male", "T20 men"), ("ListA", "male", "List A men"), ("FC", "male", "First-class men"),
                          ("T20", "female", "T20 women")]:
        W(f"### By region, {label} (edge per 100 balls)\n"); W(region_table(fmt, g)); W("")
    def pick_avoid(fmt, g, grounds, level="venue", scope="all", min_balls=1500):
        rows = [r for r in bt if r["level"] == level and r["format"] == fmt and r["gender"] == g and r.get("scope", "all") == scope]
        out = []
        for g0 in grounds:
            xs = [r for r in rows if same_ground(r["name"], g0) and int(r["balls"]) >= min_balls]
            gname = xs[0]["name"] if xs else g0
            if len(xs) < 3: continue
            xs.sort(key=lambda r: f(r["value_per100"]), reverse=True)
            b, w_ = xs[0], xs[-1]
            def cell(r):
                return f"{r['bowler_type']} {fmt_num(r['value_per100'], 1, True)} ±{fmt_num(r['value_se'], 1)}"
            sig = lambda r: abs(f(r["value_per100"])) > 2 * f(r["value_se"])
            out.append([gname, cell(b) + (" *" if sig(b) else ""), cell(w_) + (" *" if sig(w_) else ""),
                        ", ".join(f"{r['bowler_type']} {fmt_num(r['value_per100'], 1, True)}" for r in xs[1:-1])])
        return out
    W("### At this ground, pick X; avoid Y\n")
    W("`*` = edge more than 2 SE from zero. 'Others' lists the remaining types best to worst.\n")
    W("**IPL grounds (T20 men, all T20 at the ground)**\n")
    W(table(["ground", "pick", "avoid", "others"], pick_avoid("T20", "male", IPL_GROUNDS))); W("")
    W("**Test grounds (Tests + other first-class at the ground, men)**\n")
    W(table(["ground", "pick", "avoid", "others"], pick_avoid("FC", "male", TEST_GROUNDS, min_balls=3000))); W("")
    W("**ODI grounds (List A men)**\n")
    W(table(["ground", "pick", "avoid", "others"], pick_avoid("ListA", "male", TEST_GROUNDS + [g for g in IPL_GROUNDS if g not in TEST_GROUNDS], min_balls=2000))); W("")
    # phases
    W("### Phase splits: which types gain where, by phase (country level, men)\n")
    for fmt in ("T20", "ListA", "FC"):
        rows = [r for r in bt if r["level"] == "country_phase" and r["format"] == fmt and r["gender"] == "male" and int(r["balls"]) >= 6000]
        rows.sort(key=lambda r: f(r["value_per100"]), reverse=True)
        if not rows: continue
        W(f"**{fmt}**: biggest gains: " + "; ".join(f"{r['bowler_type']} in {r['key']}, {r['phase']} ({fmt_num(r['value_per100'], 1, True)} ±{fmt_num(r['value_se'], 1)})" for r in rows[:6]))
        W(f"; biggest losses: " + "; ".join(f"{r['bowler_type']} in {r['key']}, {r['phase']} ({fmt_num(r['value_per100'], 1, True)} ±{fmt_num(r['value_se'], 1)})" for r in rows[-6:]) + "\n")
    # matchups
    W("### Matchups: bowler type vs batter hand\n")
    W("Overall (after batter and bowler quality), edge per 100 balls for the bowler:\n")
    th = [r for r in bt if r["level"] == "overall_hand"]
    rows = []
    for fmt in ("T20", "ListA", "FC"):
        for g in ("male",):
            for t in ["RA fast", "RA fast-medium", "RA medium", "LA pace", "off-spin", "wrist-spin", "LA orthodox"]:
                l = next((r for r in th if r["format"] == fmt and r["gender"] == g and r["bowler_type"] == t and r["batter_hand"] == "LHB"), None)
                rr = next((r for r in th if r["format"] == fmt and r["gender"] == g and r["bowler_type"] == t and r["batter_hand"] == "RHB"), None)
                if l and rr:
                    rows.append([fmt, t, f"{fmt_num(rr['value_per100'], 1, True)}", f"{fmt_num(l['value_per100'], 1, True)}",
                                 f"{fmt_num(f(l['value_per100']) - f(rr['value_per100']), 1, True)}"])
    W(table(["format", "type", "vs RHB", "vs LHB", "LHB minus RHB"], rows)); W("")
    vh = [r for r in bt if r["level"] == "venue_hand" and r["gender"] == "male" and int(r["balls"]) >= 1500]
    vh.sort(key=lambda r: abs(f(r["value_per100"])) / max(0.1, f(r["value_se"])), reverse=True)
    W("Strongest ground-specific matchups (largest edge relative to its SE, men):\n")
    W(table(["format", "ground", "type", "vs", "edge/100", "SE", "balls"],
            [[r["format"], r["name"], r["bowler_type"], r["batter_hand"], fmt_num(r["value_per100"], 1, True), fmt_num(r["value_se"], 1), r["balls"]]
             for r in vh[:15]])); W("")

    W("## 7. Phase profiles\n")
    def phase_cols(fmt):
        return {"T20": ["powerplay (1-6)", "middle (7-15)", "death (16-20)"], "ListA": ["overs 1-10", "overs 11-40", "overs 41-50"],
                "FC": ["new ball (1-20)", "middle (21-80)", "old/2nd new ball (81+)"]}[fmt]
    for fmt, label, grounds, mb in [("T20", "IPL grounds, T20 men (runs per 100 balls vs average, by phase)", IPL_GROUNDS, 3000),
                                    ("ListA", "ODI grounds, List A men (runs per 100 balls vs average; overs 1-10 / 11-40 / 41-50)", TEST_GROUNDS, 4000)]:
        rows = []
        for r in vb:
            if r["format"] == fmt and r["gender"] == "male" and any(same_ground(r["venue"], g0) for g0 in grounds) and int(r["balls"]) >= mb:
                rows.append([r["venue"], r["balls"], fmt_num(r["run_factor"]), fmt_num(r.get("six_factor"))] +
                            [fmt_num(r.get(f"phase {p} runs_eff_per100"), 1, True) for p in phase_cols(fmt)])
        rows.sort(key=lambda x: -f(x[2], 0))
        W(f"### {label}\n"); W(table(["ground", "balls", "run factor", "six factor"] + phase_cols(fmt), rows)); W("")
    if misc.get("fc_day"):
        W("### Test and first-class matches day by day (approximate days, 90 overs each; men)\n")
        W("Runs and wickets per 100 balls vs the innings-phase expectation, after batter and bowler quality. Later days are a "
          "selected sample (only matches still going), which is why domestic day 4 looks flat: those are mostly drifting draws.\n")
        rows = [[r["scope"], r["test_day"], r["n"], fmt_num(100 * f(r["eff_r"]), 2, True), fmt_num(100 * f(r["eff_w"]), 3, True)]
                for r in misc["fc_day"] if r["gender"] == "male" and r["test_day"] and int(r["test_day"]) >= 1]
        rows.sort(key=lambda x: (x[0], int(x[1])))
        W(table(["scope", "day", "balls", "runs/100 vs expected", "wkts/100 vs expected"], rows)); W("")
        tg = []
        for r in vb:
            if r["format"] == "FC" and r["gender"] == "male" and any(same_ground(r["venue"], g0) for g0 in TEST_GROUNDS) and int(r["balls"]) >= 20000:
                d1 = f(r.get("day 1 runs_eff_per100")); d4 = f(r.get("day 4 runs_eff_per100")); d5 = f(r.get("day 5 runs_eff_per100"))
                w1 = f(r.get("day 1 wkts_eff_per100")); w4 = f(r.get("day 4 wkts_eff_per100"))
                if d1 is not None and d4 is not None:
                    tg.append([r["venue"], r["balls"], fmt_num(d1, 1, True), fmt_num(d4, 1, True), fmt_num(d5, 1, True),
                               fmt_num((d4 - d1), 1, True), fmt_num((w4 or 0) - (w1 or 0), 2, True)])
        tg.sort(key=lambda x: f(x[5], 0))
        W("Per-ground day profile (runs/100 vs average on days 1, 4, 5; most deteriorating first):\n")
        W(table(["ground", "balls", "day 1", "day 4", "day 5", "day 4 - day 1 runs", "day 4 - day 1 wkts"], tg[:25])); W("")

    W("## 8. Bat first or chase? The toss\n")
    def tcr(analysis, fmt, scope, g, gt, grp=None):
        return [r for r in tc if r["analysis"] == analysis and r["format"] == fmt and r["scope"] == scope and r["gender"] == g
                and r["group_type"] == gt and (grp is None or r["group"] == grp)]
    W("Chase advantage = P(chasing side wins) - 50% for two equal teams at a neutral ground. Toss value = P(toss winner wins) - 50% "
      "after strength.\n")
    rows = []
    for fmt, g in [("T20", "male"), ("T20", "female"), ("ListA", "male"), ("ListA", "female")]:
        for scope in ["all", "T20I" if fmt == "T20" else "ODI", "domestic"]:
            for e in ["all"] + eras:
                x = tcr("chase_advantage", fmt, scope, g, "era" if e != "all" else "overall", e)
                if x:
                    x = x[0]
                    tv = tcr("toss_value_win", fmt, scope, g, "era" if e != "all" else "overall", e)
                    ch = tcr("toss_choice_field_share", fmt, scope, g, "era" if e != "all" else "overall", e)
                    rows.append([fmt, g, scope, e, x["n"], f"{100 * f(x['estimate']):+.1f}% ±{100 * f(x['se']):.1f}",
                                 f"{100 * f(tv[0]['estimate']):+.1f}%" if tv else "–", f"{100 * f(ch[0]['estimate']):.0f}%" if ch else "–"])
    W(table(["format", "gender", "scope", "era", "matches", "chase advantage", "toss value", "captains choose to field"], rows)); W("")
    yr = sorted(tcr("chase_advantage", "T20", "all", "male", "year"), key=lambda r: r["group"])
    ch = {r["group"]: r for r in tcr("toss_choice_field_share", "T20", "all", "male", "year")}
    W("**T20 men by year**: " + ", ".join(f"{r['group']} {100 * f(r['estimate']):+.0f}% (field {100 * f(ch[r['group']]['estimate']):.0f}%)" if r['group'] in ch else f"{r['group']} {100 * f(r['estimate']):+.0f}%" for r in yr if int(r["group"]) >= 2008) + "\n")
    ipl = sorted([r for r in tc if r["analysis"] == "chase_advantage" and r["group_type"] == "competition_era" and r["group"].startswith("Indian Premier League")], key=lambda r: r["group"])
    if ipl:
        W("**IPL by era**: " + ", ".join(f"{r['group'].split('| ')[1]} {100 * f(r['estimate']):+.1f}% ±{100 * f(r['se']):.1f} (n={r['n']})" for r in ipl) + "\n")
    dn = [r for r in tc if r["analysis"] == "chase_advantage" and r["group_type"] == "day_night" and r["scope"] == "all"]
    if dn:
        W("**Day vs day/night**: " + "; ".join(f"{r['format']} {r['gender']} {r['group']} {100 * f(r['estimate']):+.1f}% (n={r['n']})" for r in dn) + "\n")
    al = [r for r in tc if r["analysis"] == "toss_choice_aligned_effect"]
    if al:
        W("**Were captains right?** Decision 'aligned' = chose to field where earlier seasons at that ground/competition favoured "
          "chasing, or to bat where they favoured batting first.\n")
        W(table(["format", "gender", "era", "matches", "share aligned", "win-prob effect of aligning"],
                [[r["format"], r["gender"], r["group"], r["n"], f"{100 * f(r['aligned_share']):.0f}%", f"{100 * f(r['estimate']):+.1f}% ±{100 * f(r['se']):.1f}"]
                 for r in sorted(al, key=lambda r: (r["format"], r["gender"], r["group"]))])); W("")
    vc = [r for r in tc if r["analysis"] == "chase_advantage" and r["group_type"] == "venue" and r["format"] == "T20" and r["gender"] == "male" and int(r["n"]) >= 40]
    vc.sort(key=lambda r: f(r["estimate"]))
    if vc:
        W("**Grounds where batting first wins most (T20 men, >= 40 results)**: " + ", ".join(f"{r.get('venue') or r['group']} {100 * f(r['estimate']):+.0f}%" for r in vc[:8]))
        W("\n**Grounds where chasing wins most**: " + ", ".join(f"{r.get('venue') or r['group']} {100 * f(r['estimate']):+.0f}%" for r in vc[-8:][::-1]) + "\n")
    W("### Tests and first-class: toss, bat first or bowl first, draws\n")
    rows = []
    for scope in ("Test", "all"):
        for g in ("male", "female"):
            for e in ["all"] + eras:
                d = [r for r in tc if r["analysis"] == "fc_draw_rate" and r["scope"] == scope and r["gender"] == g and r["group"] == e]
                if not d: continue
                b = [r for r in tc if r["analysis"] == "fc_toss_bat_first" and r["scope"] == scope and r["gender"] == g and r["group"] == e]
                fl = [r for r in tc if r["analysis"] == "fc_toss_field_first" and r["scope"] == scope and r["gender"] == g and r["group"] == e]
                ch = [r for r in tc if r["analysis"] == "toss_choice_field_share" and r["format"] == "FC" and r["scope"] == scope and r["gender"] == g and r["group"] == e]
                bf = [r for r in tc if r["analysis"] == "fc_bat_first_win_given_result" and r["scope"] == scope and r["gender"] == g and r["group"] == e]
                def wdl(x):
                    if not x: return "–"
                    x = x[0]; return f"W {100 * f(x['estimate']):.0f} / D {100 * f(x['draw_prob']):.0f} / L {100 * f(x['loss_prob']):.0f} (n={x['n']})"
                rows.append([scope, g, e, d[0]["n"], f"{100 * f(d[0]['estimate']):.0f}%", f"{100 * f(ch[0]['estimate']):.0f}%" if ch else "–",
                             wdl(b), wdl(fl), f"{100 * f(bf[0]['estimate']):.0f}%" if bf else "–"])
    W("Toss-winner outcomes are for two equal teams at a neutral ground (W/D/L %, from logistic fits on the strength gap).\n")
    W(table(["scope", "gender", "era", "matches", "draw rate", "toss winners field", "toss winner bats: W/D/L", "toss winner fields: W/D/L",
             "side batting first wins (of results)"], rows)); W("")

    W("## 9. Geography\n")
    def geor(analysis, **kw):
        return [r for r in geo if r["analysis"] == analysis and all(r.get(k) == v for k, v in kw.items())]
    rows = []
    for fmt in ("T20", "ListA", "FC"):
        for g in ("male", "female"):
            for scope in ("international", "domestic"):
                for e in ["all"] + eras:
                    x = geor("home_advantage", format=fmt, gender=g, scope=scope, group_type="era", group=e)
                    if x:
                        rows.append([fmt, g, scope, e, x[0]["n"], f"{100 * f(x[0]['estimate']):+.1f}% ±{100 * f(x[0]['se']):.1f}"])
    W("Home advantage = win-probability gain for the home side over an equal team on neutral ground (results only; FC draws excluded). "
      "Domestic 'home' = the team's home ground(s) that season.\n")
    W(table(["format", "gender", "scope", "era", "matches", "home advantage"], rows)); W("")
    rows = []
    for fmt in ("T20", "ListA", "FC"):
        xs = sorted([r for r in geor("home_advantage", format=fmt, gender="male", group_type="host_country") if int(r["n"]) >= 80],
                    key=lambda r: -f(r["estimate"]))
        if xs:
            rows.append([fmt, ", ".join(f"{r['group']} {100 * f(r['estimate']):+.0f}% ±{100 * f(r['se']):.0f} (n={r['n']})" for r in xs)])
    W("**Home advantage by host country (internationals, men; hosts with at least 80 results)**\n"); W(table(["format", "host countries, strongest first"], rows)); W("")
    rows = []
    for fmt in ("T20", "ListA", "FC"):
        for g in ("male", "female"):
            for e in ("all", "2000-13", "2014-26"):
                a = geor("travel_sub_team_in_SENA", format=fmt, gender=g, group=e); b = geor("travel_SENA_team_in_sub", format=fmt, gender=g, group=e)
                if a and b:
                    rows.append([fmt, g, e, a[0]["n"], f"{100 * f(a[0]['estimate']):+.1f}% ±{100 * f(a[0]['se']):.1f}", f"{100 * f(b[0]['estimate']):+.1f}% ±{100 * f(b[0]['se']):.1f}"])
    W("**Travel: subcontinent sides in SENA and vice versa** (full-member internationals; extra win-probability shift on top of normal "
      "home advantage; negative = they do worse than an ordinary away side)\n")
    W(table(["format", "gender", "era", "matches", "subcontinent team in SENA", "SENA team in subcontinent"], rows)); W("")
    rows = []
    for fmt in ("T20", "ListA", "FC"):
        rr = geor("region_conditions_run_rate_eff_per100", format=fmt, gender="male")
        ww = {r["group"]: r for r in geor("region_conditions_wkt_rate_eff_per100", format=fmt, gender="male")}
        for r in sorted(rr, key=lambda r: -f(r["estimate"])):
            rows.append([fmt, r["group"], fmt_num(r["estimate"], 2, True), fmt_num(ww.get(r["group"], {}).get("estimate"), 3, True)])
    W("**Regional conditions (men; runs and wickets per 100 balls vs average, after the teams)**\n")
    W(table(["format", "region", "runs/100", "wkts/100"], rows)); W("")
    # player adapters
    if splits:
        W("### Players who adapt well or badly away from home\n")
        W("Per 100 balls vs the player's own home-region level (home region = where he plays his domestic cricket; shrunk with 800 "
          "balls of prior in T20, 3,000 in FC; runs for batters, value = runs saved + wicket value x wickets for bowlers). "
          "Minimum 1,500 balls abroad and at home (FC), 400 (T20). Bracket = home region.\n")
        for fmt, side, minb in (("FC", "bat", 1500), ("T20", "bat", 400), ("FC", "bowl", 1500), ("T20", "bowl", 400)):
            agg = defaultdict(lambda: [0.0, 0.0, None, None, 0.0])
            for r in splits:
                if r["format"] != fmt or r["side"] != side or r["gender"] != "male" or r["region"] == r["home_region"]: continue
                if int(r["home_balls"]) < minb: continue
                a = agg[r["player_id"]]; b = f(r["balls"])
                metric = f(r["diff_vs_home_runs_per100"]) if side == "bat" else (-f(r["diff_vs_home_runs_per100"]) + (25 if fmt == "FC" else 8) * f(r["diff_vs_home_wkts_per100"], 0))
                a[0] += metric * b; a[1] += b; a[2] = r["name"]; a[3] = r["home_region"]
            ok = [(pid, v[0] / v[1], v[1], v[2], v[3]) for pid, v in agg.items() if v[1] >= minb]
            ok.sort(key=lambda x: x[1], reverse=True)
            if not ok: continue
            lab = f"{fmt} {'batters' if side == 'bat' else 'bowlers (value per 100 balls)'}"
            W(f"**{lab}**: travel best: " + ", ".join(f"{n} ({h}) {v:+.1f}" for _, v, b, n, h in ok[:8]))
            W(f"; travel worst: " + ", ".join(f"{n} ({h}) {v:+.1f}" for _, v, b, n, h in ok[-8:][::-1]) + "\n")

    W("## 10. Caveats\n")
    W("- Ground effects are relative to the teams that played there, so a ground isn't 'flat' just because strong batting sides "
      "play at home. But conditions and home-team selection are partly entangled (teams pick for their pitch).")
    W("- Single-venue tournaments (e.g. UAE-hosted IPL/PSL seasons) put competition-season level and ground in the same matches; "
      "the shrinkage splits them, so those grounds' factors lean on other competitions held there.")
    W("- Bowler types come from ESPNcricinfo styles, falling back to CricketArchive (first listed); 1-13% of balls (by format) "
      "have no type and are left out of type tables. Matchup edges are partly selection: captains bowl a type at the batters "
      "it suits, which flatters the bowler side of each matchup.")
    W("- Player 'travel' splits are vs the player's own home level, so a player picked abroad only when in form looks better than "
      "he is (and vice versa); treat single names as anecdotes, not ratings.")
    W("- Test days are approximate (90 overs per day of cumulative play); Cricsheet has no day stamps.")
    W("- Caught-behind is matched by the keeper's name on the card; substitutes and keeper changes are missed.")
    W("- Sixes are missing on many first-class cards, so FC six factors are thin or absent.")
    W("- Day/night comes from CricketArchive's '(day/night)' tag; it's missing for some matches, so 'day' includes some unlabelled night games.")
    W("- 'Were captains right?' uses each ground's chase record from earlier seasons, which is itself noisy at thin grounds.\n")

    W("## 11. Where this would plug into the engine (not wired in)\n")
    W("The engine's venue model is hand-set per team in `packages/engine/src/team.ts` (`stadiumBowlingRating`, `pitchType` "
      "flat/seaming/turning/balanced, `boundarySize`, `dewFactor`), read by `getVenueContext` in `match.ts`. `getPitchModifier` "
      "in `matchups.ts` turns pitchType + dew into wicket / boundary multipliers for pace and spin, and `decideTossChoice` picks bat "
      "or bowl from dew and pitch type. `data-export/venue-conditions.json` has what would replace them: run / wicket / six factors "
      "per ground (-> stadiumBowlingRating, boundarySize), per-type edges (-> pitch modifiers by bowler type and phase), 2nd-innings "
      "change and the ground's chase advantage (-> dewFactor and the toss decision).\n")

    md = "\n".join(L)
    (DATA / "venue-conditions-report.md").write_text(md)
    (REPO / "docs").mkdir(exist_ok=True)
    (REPO / "docs" / "VENUE-CONDITIONS-REPORT.md").write_text(md)

    # engine export
    EXPORT.mkdir(exist_ok=True)
    vcha = {(r["format"], r["gender"], r["group"]): r for r in tc if r["analysis"] == "chase_advantage" and r["group_type"] == "venue"}
    types = defaultdict(dict)
    for r in bt:
        if r["level"] == "venue" and int(r["balls"]) >= 1500:
            types[(r["format"], r["gender"], r["key"])][r["bowler_type"]] = {"value_per100": f(r["value_per100"]), "se": f(r["value_se"]),
                                                                              "econ_eff": f(r["econ_eff_per_over"]), "wkts_eff_per100": f(r["wkts_eff_per100"])}
    grounds = []
    for r in vf:
        if r["scope"] != "all" or int(r["matches"]) < 10: continue
        k = (r["format"], r["gender"], r["vid"])
        ch = vcha.get(k)
        grounds.append({"id": r["vid"], "name": r["venue"], "city": r["city"], "country": r["country"], "format": r["format"],
                        "gender": r["gender"], "matches": int(r["matches"]), "runFactor": f(r["run_factor"]), "wicketFactor": f(r["wkt_factor"]),
                        "sixFactor": f(r.get("six_factor")), "secondInningsRunsPer100": f(r.get("inn2_minus_inn1_run")),
                        "lateMinusEarlyRunsPer100": f(r.get("late_minus_early_run")), "variability": f(r["variability"]),
                        "drawRate": f(r.get("draw_rate")),
                        "chaseAdvantage": f(ch["estimate"]) if ch else None, "bowlerTypeEdges": types.get(k, {})})
    glob = {}
    for r in tc:
        if r["group_type"] == "overall" and r["analysis"] in ("chase_advantage", "toss_value_win", "toss_choice_field_share"):
            glob.setdefault(f"{r['format']}|{r['scope']}|{r['gender']}", {})[r["analysis"]] = f(r["estimate"])
    home = {f"{r['format']}|{r['scope']}|{r['gender']}": f(r["estimate"]) for r in geo if r["analysis"] == "home_advantage" and r["group_type"] == "era" and r["group"] == "all"}
    def rnd(x):
        if isinstance(x, float): return round(x, 3)
        if isinstance(x, dict): return {k: rnd(v) for k, v in x.items() if v is not None}
        if isinstance(x, list): return [rnd(v) for v in x]
        return x
    out = rnd({"generated": time.strftime("%Y-%m-%d"), "note": "Analysis export from venue-conditions.py; not used by the engine yet.",
               "units": {"factors": "100 = average ground", "edges": "value per 100 balls vs same bowlers elsewhere",
                         "chaseAdvantage": "P(chaser wins) - 0.5, equal teams", "homeAdvantage": "P(home wins) - 0.5"},
               "global": glob, "homeAdvantage": home, "grounds": grounds})
    with open(EXPORT / "venue-conditions.json", "w") as fh:
        fh.write("{\n" + ",\n".join(f"{json.dumps(k)}: {json.dumps(v, separators=(',', ':'))}" for k, v in out.items() if k != "grounds"))
        fh.write(',\n"grounds": [\n' + ",\n".join(json.dumps(g, separators=(",", ":")) for g in out["grounds"]) + "\n]}\n")
    print(f"report: {len(md)} chars; export: {len(grounds)} ground rows")


if __name__ == "__main__":
    main()
