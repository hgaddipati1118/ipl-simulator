#!/usr/bin/env python3
"""
Write data/analysis/injury-risk-report.md and data-export/injury-risk.json from injury-risk.py's outputs.
Run from packages/ratings after injury-risk.py:  python3 -I src/analysis/injury-risk-report.py
"""
import csv, json, math, subprocess
from collections import defaultdict, Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "analysis"
EXPORT = ROOT / "data-export"
S = json.load(open(OUT / "injury_model.json"))
rates = list(csv.DictReader(open(OUT / "injury_rates.csv")))
M = S["model"]
AGES = ["<=22", "23-26", "27-30", "31-33", "34+"]
ARCH = ["express/fast", "fast-medium", "medium", "wrist spin", "finger spin", "batter", "bowling all-rounder",
        "batting all-rounder", "wicketkeeper"]
PACE = {"express/fast", "fast-medium", "medium"}; SPIN = {"finger spin", "wrist spin"}

def rr(name):
    v = M.get(name)
    return (1.0, None) if v is None else (v["rr"], v["se"])
def ci(name):
    v = M.get(name)
    if not v or v["se"] is None: return "ref"
    lo, hi = math.exp(v["coef"] - 1.96 * v["se"]), math.exp(v["coef"] + 1.96 * v["se"])
    return f"{v['rr']:.2f} ({lo:.2f}-{hi:.2f})"

def roll(filt, keyf):
    out = defaultdict(lambda: [0, 0, 0, 0])
    for r in rates:
        if not filt(r): continue
        o = out[keyf(r)]
        o[0] += int(r["exposures"]); o[1] += int(r["confirmed"]); o[2] += int(r["likely"]); o[3] += int(r["unknown"])
    return out
def per100(o, which="main"):
    n = o[0]
    if not n: return float("nan")
    return 100 * {"main": o[1] + o[2], "low": o[1], "high": o[1] + o[2] + o[3]}[which] / n

L = []
w = L.append
w("# Injury likelihood by player type and age")
w("")
w(f"_Generated {S['generated']} by `src/analysis/injury-risk.py` + `injury-risk-report.py` from CricketArchive senior scorecards (1998+)._")
w("")
w("**Short version.** Pace bowlers miss time about 1.7-1.8x as often as batters, spinners about 1.2-1.3x, and wicketkeepers")
w("and all-rounders the least. A previous injury in the last two years adds 11-22%. The data can't see a workload effect (heavy")
w("recent bowling *lowers* measured risk, which is selection: only fit bowlers get heavy loads). Age is ambiguous: confirmed")
w("in-match injuries rise with age, but absence-based 'likely' injuries are highest for players 22 and under, which mostly")
w("reflects young fringe players being rotated or dropped. The model ranks risk modestly (held-out AUC "
  f"{S['validation']['full (+ prior injury, era)']['auc']:.2f}); use it for relative risk by type, not to predict individuals.")
w("")
w("## 1. What counts as an injury")
w("")
w("There's no injury register, so every absence of a regular is classified by evidence:")
w("")
w("| Class | Rule | Spells |")
w("|---|---|---|")
sp = S["spells"]
w(f"| confirmed | 'retired hurt' / 'absent hurt' / 'retired ill' / 'absent ill' on the card, or named as replaced by a concussion/injury substitute; then missed the next match | {sp.get('confirmed', 0):,} |")
w(f"| confirmed, no time missed | same in-match evidence, but played the next match | {sp.get('confirmed_no_time_missed', 0):,} |")
w(f"| likely | regular (played >= 2 of the team's previous 3 that season), missed >= 2 straight team matches, played nowhere else in the gap, came back to the same team (same season or a later one, within 3 years), form going in not poor | {sp.get('likely', 0):,} |")
w(f"| unknown | any other absence of a regular: single-match misses (rest/rotation), absences after poor form, never back with that team, career exit | {sp.get('unknown', 0):,} |")
w(f"| elsewhere (excluded) | played any other match (international duty, another league) during the gap | {sp.get('elsewhere', 0):,} |")
w("")
w(f"Exposure = one appearance by a regular whose team plays again that season ({S['exposures']:,} exposures). Main results use confirmed + likely; "
  "**low** = confirmed only, **high** = + every unknown absence.")
w("")
w("Breakdown of reasons: " + ", ".join(f"{k} {v:,}" for k, v in S["reasons"].items()) + ".")
w("")
sn = S["substitute_notes"]
cat = Counter()
for k, v in sn.items():
    kl = k.lower()
    cat["concussion" if "concuss" in kl else ("injury / medical" if ("injur" in kl or "medical" in kl) else (
        "Impact Player (tactical)" if "impact" in kl or "imapct" in kl else (
        "international / squad call-up" if any(x in kl for x in ("called up", "squad", "international", "national", "released", "returning", "join")) else "other (covid, family, misc)")))] += v
w(f"Substitute notes on cards: {', '.join(f'{k} {v}' for k, v in cat.most_common())}; {S['linked_substitutes']} injury/concussion substitutions were linked to the replaced player.")
ipl = S["ipl_replacements"]
w(f"IPL/WPL replacement signings: {ipl['rows']} name the replaced player, but only {ipl['injury']} give an injury reason and almost all happen before the season "
  "(the player never becomes an in-season regular), so they are used as a separate check in section 4 rather than as evidence.")
w("")
w("## 2. Risk by player type (men, all formats)")
w("")
w("Model relative risk vs batters (Poisson on exposure cells, adjusted for format, gender, age, era, workload, schedule density, previous injury), with 95% CI; raw rates per 100 regular appearances.")
w("")
w("| Type | Relative risk | Main /100 | Low (confirmed) /100 | High (+unknown) /100 | Appearances |")
w("|---|---|---|---|---|---|")
bya = roll(lambda r: r["gender"] == "male", lambda r: r["archetype"])
for a in ARCH:
    o = bya.get(a)
    if not o: continue
    w(f"| {a} | {ci('archetype=' + a) if a != 'batter' else '1 (ref)'} | {per100(o):.2f} | {per100(o, 'low'):.2f} | {per100(o, 'high'):.1f} | {o[0]:,} |")
w("")
w("Confirmed in-match injuries are batter-heavy (retired hurt is mostly being hit), so the 'low' column ranks types differently from the main one; absences after the match are where bowlers dominate.")
w("")
w("## 3. Age")
w("")
w("| Age | Model RR (all types) | Pace main /100 | Spin main /100 | Bat/WK/AR main /100 | Bat/WK/AR confirmed /100 |")
w("|---|---|---|---|---|---|")
grp = lambda r: "pace" if r["archetype"] in PACE else ("spin" if r["archetype"] in SPIN else "other")
bag = roll(lambda r: r["gender"] == "male" and r["age_band"] != "unk", lambda r: (grp(r), r["age_band"]))
for ab in AGES:
    w(f"| {ab} | {ci('age=' + ab) if ab != '27-30' else '1 (ref)'} | {per100(bag[('pace', ab)]):.2f} | {per100(bag[('spin', ab)]):.2f} | "
      f"{per100(bag[('other', ab)]):.2f} | {per100(bag[('other', ab)], 'low'):.3f} |")
w("")
w("Read this carefully. Absence-based risk falls with age for every type, but young players are the ones most often rested or left out while still in "
  "form, which the 'likely' rule can't fully separate from injury. Confirmed in-match injuries for batters go the other way, roughly doubling from the early "
  "20s to 31+. For pace bowlers the honest answer is that the data shows no clear rise with age once they're regulars (survivors: quicks who break down "
  "early stop being regulars and leave the at-risk pool).")
w("")
# relative risk headline examples
def pred(arch, age, fmt="T20"):
    eta = M["intercept"]["coef"]
    for k in (f"archetype={arch}", f"age={age}", f"format={fmt}"):
        if k in M: eta += M[k]["coef"]
    return 1 - math.exp(-math.exp(eta))
ex = [("express/fast", "31-33", "finger spin", "23-26"), ("fast-medium", "<=22", "batter", "27-30"), ("wrist spin", "27-30", "finger spin", "27-30"),
      ("medium", "34+", "wicketkeeper", "27-30")]
w("Examples (model, T20 men, 2018+, same workload/schedule):")
w("")
for a1, g1, a2, g2 in ex:
    w(f"- {a1} aged {g1} vs {a2} aged {g2}: **{pred(a1, g1) / pred(a2, g2):.1f}x** ({100 * pred(a1, g1):.1f}% vs {100 * pred(a2, g2):.1f}% per match)")
w("")
w("## 4. Independent check: who gets replaced in the IPL")
w("")
r_ = S["ipl_replaced"]
A = Counter(); B = Counter()
for k, c in r_["by_archetype_age"].items(): A[k.split("|")[0]] += c
for k, c in r_["base_player_seasons"].items(): B[k.split("|")[0]] += c
w(f"{r_['resolved']} replaced players were matched to CricketArchive. Share of IPL squad-seasons (players who played that season) that ended with the player being replaced:")
w("")
w("| Type | Replaced | Squad-seasons | % |")
w("|---|---|---|---|")
for a in sorted(B, key=lambda a: -A[a] / B[a] if B[a] else 0):
    if B[a] < 50: continue
    w(f"| {a} | {A[a]} | {B[a]} | {100 * A[a] / B[a]:.1f}% |")
w("")
w("This uses a completely different signal (replacement signings, mostly injuries) and agrees on the ordering: express quicks are replaced far more often than anyone, finger spinners least.")
w("")
w("## 5. Workload, schedule and previous injury")
w("")
w("| Factor | Level | Relative risk (95% CI) |")
w("|---|---|---|")
for f_, lv in [("wl30", ["0", "1-150", "151-400", "401-800", "800+"]), ("acwr", ["low/none", "<0.8", "0.8-1.3", "1.3-1.6", ">1.6"]),
               ("density14", ["1-2", "3-4", "5+"]), ("prior", ["0", "1", "2+"]), ("format", ["T20", "LA", "FC"]), ("gender", ["male", "female"]),
               ("era", ["1998-2009", "2010-2017", "2018-2026"])]:
    for l in lv:
        k = f"{f_}={l}"
        w(f"| {f_} | {l} | {ci(k) if k in M else '1 (ref)'} |")
w("")
w("- **Previous injury** is the one workload-type signal that behaves as expected: one injury absence in the last two years raises risk ~11%, two or more ~22%.")
w("- **Balls bowled in the last 30 days** and **matches in the last 14 days** both come out *protective*. That's selection, not physiology: bowlers who are carrying a niggle get "
  "managed down before they break, and the ones bowling 800+ balls a month are the fit ones. The acute:chronic ratio (last 7 days vs the 28-day average) shows no effect at all.")
w("  Scorecards can't measure training load, so treat workload as **not measurable here** rather than 'safe'.")
w("- Women's absences are ~40% rarer per appearance, and first-class cricket ~25% more injury-prone than T20 per appearance (multi-day matches = more exposure each).")
w("- The modern era (2018+) shows more absences, which is mostly more rotation and workload management being counted as 'likely'.")
w("")
w("## 6. Validation")
w("")
w("Fit on seasons up to 2018, predict 2019-2026 player-seasons (did the player have an injury absence that season?).")
w("")
w("| Model | AUC | Player-seasons | With an injury |")
w("|---|---|---|---|")
for k, v in S["validation"].items():
    w(f"| {k} | {v['auc']:.3f} | {v['n_player_seasons']:,} | {v['events']:,} |")
cal = S["validation"]["full (+ prior injury, era)"]["calibration_deciles"]
w("")
w("Calibration (full model, deciles of predicted risk; predicted vs observed injury absences per player-season): " +
  ", ".join(f"{a:.3f}/{b:.3f}" for a, b in cal) + ".")
w("The ordering is right (observed rises with predicted) but the model is overconfident at both ends, so predicted risks should be shrunk toward the mean "
  "(roughly halve the distance) before use. AUC ~0.6 means type, age, history and schedule explain only a small part of who gets injured.")
w("")
w("## 7. Named players (observed injury absences vs what their type/age/schedule predicts)")
w("")
w("| Player | Type (T20) | Regular appearances | Likely | Confirmed | Unknown | Expected | Obs/Exp |")
w("|---|---|---|---|---|---|---|---|")
for n in S["named"]:
    if not n.get("exposures"): continue
    w(f"| {n['name']} | {n['archetype_T20']} | {n['exposures']} | {n['likely']} | {n['confirmed']} | {n['unknown']} | {n['expected']} | {n['obs_over_exp']} |")
w("")
w("Mark Wood (3.2x), Josh Hazlewood (1.3x) and Anrich Nortje (1.1x) come out above their type; durable players (Rashid Khan 0.3x, Joe Root 0.3x, Kohli 0.5x, "
  "Boult 0.5x, Nathan Lyon 0) below. Jofra Archer (0.4x) and Bumrah (0.9x) are under-counted: their big layoffs started at the end of a season or a series and "
  "lasted more than a year, and players are only counted at risk while their team still has matches that season. Following players across the season break "
  "was tried and dropped: it pulled in so much squad turnover that held-out AUC fell from 0.60 to 0.53.")
w("")
w("## 8. Time missed (injury absences)")
w("")
w("| Format | Group | 1-2 matches | 3-5 | 6+ |")
w("|---|---|---|---|---|")
for k, v in sorted(S["spell_length"].items()):
    f_, g_ = k.split("|"); tot = sum(v.values())
    w(f"| {f_} | {g_} | {100 * v.get('1-2', 0) / tot:.0f}% | {100 * v.get('3-5', 0) / tot:.0f}% | {100 * v.get('6+', 0) / tot:.0f}% |")
w("")
w("Matches missed within the season only (long layoffs that run into the next season count their in-season part), so 6+ is understated.")
w("")
w("## 9. Engine")
w("")
w("`packages/engine/src/injury.ts` already has an injury roll after each match: a flat base chance by role (batsman 1.5%, bowler 4%, all-rounder 3%, wicket-keeper 2%), "
  "+2 points over age 34, a fatigue term above 55, and a 60/30/10 minor/moderate/severe split for 1-2 / 3-5 / 6-10 matches out. `data-export/injury-risk.json` is shaped to "
  "replace `BASE_INJURY_CHANCE` with a per-type, per-age table (T20 men 2018+), add the previous-injury multiplier, and replace `SEVERITY_DISTRIBUTION` with the observed "
  "split for pace / spin / other. It isn't wired in. Two things to decide before using it: (1) these rates include some rest/rotation, so scale toward the 'low' column "
  "if the game should only injure players who are really hurt; (2) the data gives no support for a workload-driven injury curve, so keep the existing fatigue term as a "
  "game-design choice rather than something this data backs.")
w("")
w("## 10. Caveats")
w("")
w("- Absence is a proxy. 'Likely' still includes some rest, rotation, personal leave and paternity breaks; 'unknown' still includes some real injuries.")
w("- Only senior cricket since 1998 is used, so injuries in minor cricket or while not a regular are invisible.")
w("- Gender, format and era effects partly reflect how often teams rotate, not how often players get hurt.")
w("- Pace bands come from CricketArchive bowling styles ('fast' vs 'fast-medium'), which lag a player's actual pace and don't separate genuinely express bowlers well; express/fast and fast-medium come out the same.")
w("- Workload uses balls bowled in senior matches only; nets, training and franchise practice aren't visible.")
open(OUT / "injury-risk-report.md", "w").write("\n".join(L) + "\n")

# ── engine table ───────────────────────────────────────────────────────────
t20 = roll(lambda r: r["format"] == "T20" and r["gender"] == "male", lambda r: r["archetype"])
age_mult = {ab: (rr("age=" + ab)[0] if ab != "27-30" else 1.0) for ab in AGES}
# center age multipliers so the archetype base is the all-ages rate
tot_age = roll(lambda r: r["format"] == "T20" and r["gender"] == "male" and r["age_band"] != "unk", lambda r: r["age_band"])
wsum = sum(tot_age[ab][0] for ab in AGES); mean_mult = sum(age_mult[ab] * tot_age[ab][0] for ab in AGES) / wsum
table = {}
for a in ARCH:
    o = t20.get(a)
    if not o or not o[0]: continue
    base = (o[1] + o[2]) / o[0]
    table[a] = {ab: round(base * age_mult[ab] / mean_mult, 5) for ab in AGES}
sev = {}
for k, v in S["spell_length"].items():
    f_, g_ = k.split("|")
    if f_ != "T20": continue
    tot = sum(v.values())
    sev[g_] = {b: round(v.get(b, 0) / tot, 3) for b in ("1-2", "3-5", "6+")}
engine = dict(
    description="Per-match probability that a regular starts an injury absence after the match (T20 men, 2018+ rates; confirmed + likely evidence). Validation-grade, not wired into the engine.",
    source="packages/ratings/src/analysis/injury-risk.py (see docs/INJURY-RISK-REPORT.md)",
    base_per_match_by_archetype_and_age=table,
    low_bound_scale=round(sum((t20[a][1]) for a in t20) / max(1, sum(t20[a][1] + t20[a][2] for a in t20)), 3),
    previous_injury_multiplier={"0": 1.0, "1": round(rr("prior=1")[0], 3), "2+": round(rr("prior=2+")[0], 3)},
    women_multiplier=round(rr("gender=female")[0], 3),
    format_multiplier={"T20": 1.0, "ODI/List A": round(rr("format=LA")[0], 3), "Test/FC": round(rr("format=FC")[0], 3)},
    matches_missed_distribution=sev,
    workload_note="Scorecard workload shows no injury-raising effect (selection); keep any fatigue penalty as a design choice.",
    role_map={"batsman": "batter", "wicket-keeper": "wicketkeeper", "all-rounder": "batting all-rounder / bowling all-rounder",
              "bowler": "express/fast | fast-medium | medium | finger spin | wrist spin (by bowlingStyle)"},
)
json.dump(engine, open(EXPORT / "injury-risk.json", "w"), indent=1)
print("wrote", OUT / "injury-risk-report.md", "and", EXPORT / "injury-risk.json")
