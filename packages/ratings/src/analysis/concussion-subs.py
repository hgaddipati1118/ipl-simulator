#!/usr/bin/env python3
"""
Concussion substitutes: how often, to whom, when, and who comes in.

Sources
  Cricsheet (data/cricsheet/all_json): delivery-level `replacements.match` with reason "concussion_substitute"
    (T20 leagues, T20Is, ODIs, Tests, some domestic one-day / multi-day), men and women.
  CricketArchive notes (data/scorecards/scorecards.jsonl): "X full substitute: A for B (after N overs of the T first
    innings) (concussion)", all senior cricket incl. domestic first-class and List A (a cross-check and the FC/LA count).

Per event: format, gender, year, whether the replaced player was on the batting side when the change was recorded,
whether he was hit batting (replaced during his side's innings, or at the start of the next innings right after he
batted), his batting position, his role (from his Cricsheet career: keeper / batter / all-rounder / bowler) and the
replacement's role, the over of the innings, and how many of his team's next matches he missed.

Run from packages/ratings:  python3 -I src/analysis/concussion-subs.py
Writes data-export/concussion-subs.json (committed) and prints the tables used in docs/RULES-MATCH.md.
"""
import csv, datetime as dt, glob, json, os, re, sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
EXPORT = ROOT / "data-export"
FIT_YEARS = {2023, 2024}
CHECK_YEARS = {2025, 2026}
START = "2019-08-01"  # ICC concussion replacements from 1 Aug 2019 (BBL had them from 2016-17)


def fmt_of(info):
    mt, tt = info.get("match_type"), info.get("team_type")
    if mt == "Test": return "Test"
    if mt == "ODI": return "ODI"
    if mt in ("T20", "IT20"): return "T20I" if tt == "international" else "T20 league"
    if mt == "ODM": return "List A (domestic)"
    if mt == "MDM": return "First-class (domestic)"
    return None


# ── 1. Cricsheet: one pass for careers (roles) and match records ──────────
files = sorted(glob.glob(str(DATA / "cricsheet" / "all_json" / "*.json")))
career = defaultdict(lambda: {"m": 0, "bowled": 0, "balls_bowled": 0, "pos_sum": 0, "pos_n": 0, "stumpings": 0, "keep_m": 0})
matches = []  # dicts
events = []
for f in files:
    try:
        d = json.load(open(f))
    except Exception:
        continue
    info = d["info"]
    date = info["dates"][0]
    fmt = fmt_of(info)
    reg = info.get("registry", {}).get("people", {})
    pid = lambda n: reg.get(n, n)
    xi = {t: [pid(p) for p in ps] for t, ps in (info.get("players") or {}).items()}
    for t, ps in xi.items():
        for p in ps: career[p]["m"] += 1
    bowled_m = defaultdict(int)
    stumped_m = set()
    order = []  # per innings: list of player ids in order of arrival
    inns = []
    for ii, inn in enumerate(d.get("innings") or []):
        if inn.get("super_over"): continue
        seen = []
        legal = 0
        rec = {"team": inn["team"], "balls": [], "legal": 0}
        for o in inn.get("overs") or []:
            for b in o["deliveries"]:
                for who in (b["batter"], b["non_striker"]):
                    w = pid(who)
                    if w not in seen: seen.append(w)
                ex = b.get("extras") or {}
                if "wides" not in ex and "noballs" not in ex:
                    legal += 1
                bowled_m[pid(b["bowler"])] += 1
                for w in b.get("wickets") or []:
                    if w.get("kind") == "stumped":
                        for fl in w.get("fielders") or []:
                            if fl.get("name"): stumped_m.add(pid(fl["name"]))
                    if w.get("player_out") and pid(w["player_out"]) not in seen: seen.append(pid(w["player_out"]))
                rec["balls"].append((o["over"], pid(b["batter"]), pid(b["non_striker"]), pid(b["bowler"])))
                for r in (b.get("replacements") or {}).get("match") or []:
                    if r.get("reason") == "concussion_substitute":
                        events.append({"file": f, "date": date, "fmt": fmt, "gender": info.get("gender"),
                                       "event": (info.get("event") or {}).get("name", ""), "inn": len(inns), "over": o["over"],
                                       "ball_idx": len(rec["balls"]) - 1, "team": r["team"], "out": pid(r["out"]), "in": pid(r["in"]),
                                       "out_name": r["out"], "in_name": r["in"], "bat_team": inn["team"]})
        rec["legal"] = legal
        rec["order"] = seen
        inns.append(rec)
    for p, n in bowled_m.items():
        career[p]["bowled"] += 1
        career[p]["balls_bowled"] += n
    for p in stumped_m:
        career[p]["keep_m"] += 1
    for rec in inns:
        for k, p in enumerate(rec["order"]):
            career[p]["pos_sum"] += k + 1
            career[p]["pos_n"] += 1
    matches.append({"file": f, "date": date, "year": int(date[:4]), "fmt": fmt, "gender": info.get("gender"),
                    "teams": info.get("teams") or [], "xi": xi, "balls": sum(r["legal"] for r in inns),
                    "inns": [{"team": r["team"], "order": r["order"], "legal": r["legal"], "balls": r["balls"]} if any(e["file"] == f for e in events[-6:]) else {"team": r["team"], "legal": r["legal"]} for r in inns],
                    "event": (info.get("event") or {}).get("name", "")})


def role(p):
    c = career.get(p)
    if not c or c["m"] == 0: return "unknown"
    bowl_share = c["bowled"] / c["m"]
    pos = c["pos_sum"] / c["pos_n"] if c["pos_n"] else 11
    if c["keep_m"] >= 2 and c["keep_m"] / c["m"] >= 0.08 and bowl_share < 0.1: return "wicket-keeper"
    if bowl_share < 0.2: return "batter"
    if bowl_share >= 0.5 and pos >= 7: return "bowler"
    if bowl_share >= 0.5 and pos < 7 or bowl_share >= 0.2: return "all-rounder"
    return "batter"


by_file = {m["file"]: m for m in matches}
rows = []
for e in events:
    m = by_file[e["file"]]
    inns = m["inns"]
    cur = inns[e["inn"]]
    batting_side = e["team"] == e["bat_team"]
    out = e["out"]
    # Where was he hit? Batting: he faced/was at the crease earlier in this innings (his side batting), or he batted in
    # the innings that just ended and is replaced at the start of the next one. Fielding: everything else (replaced
    # mid-innings in the field, or at the start of his side's innings after fielding without having batted yet).
    prev = e["inn"] - 1
    batted_now = batting_side and "balls" in cur and any(out in (b[1], b[2]) for b in cur["balls"][:e["ball_idx"]])
    batted_prev = (not batting_side and e["over"] <= 1 and prev >= 0 and inns[prev]["team"] == e["team"]
                   and "order" in inns[prev] and out in inns[prev]["order"])
    hit_batting = bool(batted_now or batted_prev)
    bat_pos = None
    for k in range(e["inn"], -1, -1):
        if "order" in inns[k] and inns[k]["team"] == e["team"] and out in inns[k]["order"]:
            bat_pos = inns[k]["order"].index(out) + 1
            break
    on_field_bat = False
    if batting_side and "balls" in cur:
        lo = max(0, e["ball_idx"] - 1)
        on_field_bat = any(out in (b[1], b[2]) for b in cur["balls"][lo:e["ball_idx"] + 1])
    # sub's later involvement
    in_bat = any("order" in r and e["in"] in r["order"] for r in inns[e["inn"]:])
    in_bowl = any("balls" in r and any(b[3] == e["in"] for b in r["balls"]) for r in inns[e["inn"]:])
    # next team matches missed (same format+gender+event, within 60 days)
    d0 = dt.date.fromisoformat(m["date"])
    nxt = sorted((x for x in matches if x["fmt"] == m["fmt"] and x["gender"] == m["gender"] and e["team"] in x["teams"]
                  and x["date"] > m["date"] and (dt.date.fromisoformat(x["date"]) - d0).days <= 60
                  and (x["event"] == m["event"] or m["fmt"] in ("Test", "ODI", "T20I"))), key=lambda x: x["date"])
    missed, back = 0, None
    for x in nxt[:10]:
        if out in x["xi"].get(e["team"], []):
            back = True
            break
        missed += 1
    rows.append({**{k: e[k] for k in ("date", "fmt", "gender", "event", "inn", "over", "out_name", "in_name", "team")},
                 "year": int(e["date"][:4]), "batting_side": batting_side, "hit_batting": hit_batting, "on_field_batting": on_field_bat,
                 "bat_pos": bat_pos, "out_role": role(out), "in_role": role(e["in"]), "in_bat": in_bat, "in_bowl": in_bowl,
                 "missed": missed, "returned": bool(back), "next_known": len(nxt) > 0})

# ── 2. Exposure and rates ─────────────────────────────────────────────────
expo = Counter(); balls = Counter(); ev = Counter(); ev_bat = Counter(); ev_field = Counter()
for m in matches:
    if not m["fmt"] or m["date"] < START: continue
    k = (m["fmt"], m["gender"], m["year"])
    expo[k] += 1
    balls[k] += m["balls"]
for r in rows:
    if not r["fmt"] or r["date"] < START: continue
    k = (r["fmt"], r["gender"], r["year"])
    ev[k] += 1
    (ev_bat if r["hit_batting"] else ev_field)[k] += 1


def agg(pred):
    E = sum(v for k, v in expo.items() if pred(k)); B = sum(v for k, v in balls.items() if pred(k))
    n = sum(v for k, v in ev.items() if pred(k)); nb = sum(v for k, v in ev_bat.items() if pred(k)); nf = sum(v for k, v in ev_field.items() if pred(k))
    return {"matches": E, "balls": B, "events": n, "hit_batting": nb, "hit_fielding": nf,
            "per_1000_matches": round(1000 * n / E, 2) if E else None,
            "per_1000_matches_jeffreys": round(1000 * (n + 0.5) / (E + 1), 2) if E else None,
            "per_ball_batting": (nb + 0.5) / B if B else None, "per_ball_fielding": (nf + 0.5) / B if B else None}


FMTS = ["T20 league", "T20I", "ODI", "Test", "List A (domestic)", "First-class (domestic)"]
table = {}
for f in FMTS:
    for g in ("male", "female"):
        table[f"{f}|{g}|fit"] = agg(lambda k, f=f, g=g: k[0] == f and k[1] == g and k[2] in FIT_YEARS)
        table[f"{f}|{g}|check"] = agg(lambda k, f=f, g=g: k[0] == f and k[1] == g and k[2] in CHECK_YEARS)
        table[f"{f}|{g}|2020-22"] = agg(lambda k, f=f, g=g: k[0] == f and k[1] == g and 2020 <= k[2] <= 2022)
by_year = {f"{f}|{y}": agg(lambda k, f=f, y=y: k[0] == f and k[2] == y) for f in FMTS for y in range(2019, 2027)}

# ── 2b. Engine fit: per legal ball, by engine format, fit years, both genders ──────
# Engine formats: T20 = leagues + T20Is; ODI = ODIs (Cricsheet's domestic List A records almost no replacements);
# Test = Tests + domestic first-class (Tests alone have 3 events in the fit years). Gamma(k + 0.5) (Jeffreys) per
# format, shrunk toward the all-format per-ball rate with a prior worth SHRINK_EVENTS events.
SHRINK_EVENTS = 5
FAMILY = {"T20": ("T20 league", "T20I"), "ODI": ("ODI",), "Test": ("Test", "First-class (domestic)")}
def fam_agg(fam, years, gender=None):
    fs = FAMILY[fam]
    return agg(lambda k: k[0] in fs and k[2] in years and (gender is None or k[1] == gender))
pool_k = sum(fam_agg(f, FIT_YEARS)["events"] for f in FAMILY); pool_b = sum(fam_agg(f, FIT_YEARS)["balls"] for f in FAMILY)
pooled = (pool_k + 0.5) / pool_b
fit_rows_y = [r for r in rows if r["year"] in FIT_YEARS and r["fmt"] in sum(FAMILY.values(), ())]
nb = sum(r["hit_batting"] for r in fit_rows_y); share_bat = (nb + 0.5) / (len(fit_rows_y) + 1)
engine = {"pooled_per_ball": pooled, "batting_share": share_bat, "batting_share_n": [nb, len(fit_rows_y)], "formats": {}}
for fam in FAMILY:
    a = fam_agg(fam, FIT_YEARS)
    m = SHRINK_EVENTS / pooled
    rate = (a["events"] + 0.5 + SHRINK_EVENTS) / (a["balls"] + m)
    bpm = a["balls"] / a["matches"]
    chk = fam_agg(fam, CHECK_YEARS); old = agg(lambda k, fs=FAMILY[fam]: k[0] in fs and 2020 <= k[2] <= 2022)
    engine["formats"][fam] = {"per_ball": rate, "per_ball_batting": rate * share_bat, "per_ball_fielding": rate * (1 - share_bat),
                              "balls_per_match": round(bpm, 1), "fit": a, "check": chk, "2020-22": old,
                              "fit_per_1000": round(1000 * rate * bpm, 2),
                              "men_fit": fam_agg(fam, FIT_YEARS, "male"), "women_fit": fam_agg(fam, FIT_YEARS, "female"),
                              "men_all": agg(lambda k, fs=FAMILY[fam]: k[0] in fs and k[1] == "male" and k[2] >= 2020),
                              "women_all": agg(lambda k, fs=FAMILY[fam]: k[0] in fs and k[1] == "female" and k[2] >= 2020)}
# Return interval: team matches missed after the concussion (next team matches in the same competition within 60 days)
known = [r for r in rows if r["date"] >= START and r["next_known"]]
engine["missed_next"] = {str(k): v for k, v in sorted(Counter(min(r["missed"], 6) for r in known).items())}
engine["missed_next_n"] = len(known)
engine["like_for_like"] = dict(Counter(f'{r["out_role"]} -> {r["in_role"]}' for r in rows if r["date"] >= START))

# ── 2c. Retired hurt / in-match breakdowns: what they cost after the match (CricketArchive spells, injury-risk.py) ──
# injury_spells.parquet: every in-match 'retired hurt' / 'absent hurt' of a regular whose team played again that season, with the
# team matches he then missed ("confirmed" = missed the next match, "confirmed_no_time_missed" = played it).
spells = DATA / "analysis" / "injury_spells.parquet"
hurt = {"miss_prob": {}, "missed": {}, "bowler_miss_prob": None}
def duck(sql):
    import subprocess
    out = subprocess.run(["duckdb", "-csv", "-c", sql], capture_output=True, text=True, check=True).stdout.strip().splitlines()
    return list(csv.reader(out))[1:]
if spells.exists():
    src = f"read_parquet('{spells}')"
    for fmt_ca, fam in (("T20", "T20"), ("LA", "ODI"), ("FC", "Test")):
        r = duck(f"select sum(case when evidence='confirmed' then 1 else 0 end), count(*) from {src} where reason='in-match hurt' and format='{fmt_ca}'")[0]
        hurt["miss_prob"][fam] = [int(r[0]), int(r[1])]
    r = duck(f"select sum(case when evidence='confirmed' then 1 else 0 end), count(*) from {src} where reason='in-match hurt' and archetype in "
             "('express/fast','fast-medium','medium','finger spin','wrist spin','bowler (style unknown)')")[0]
    hurt["bowler_miss_prob"] = [int(r[0]), int(r[1])]
    for k, n in duck(f"select least(matches_missed, 10), count(*) from {src} where reason='in-match hurt' and evidence='confirmed' group by 1 order by 1"):
        hurt["missed"][str(int(float(k)))] = int(n)
engine["retired_hurt"] = hurt

# ── 2d. The engine's table (packages/engine/src/in-match-injury-data.ts) ──
def ts_obj(o, ind=1):
    pad = "  " * ind
    if isinstance(o, dict):
        return "{\n" + "".join(f"{pad}{json.dumps(k) if not k.isidentifier() else k}: {ts_obj(v, ind + 1)},\n" for k, v in o.items()) + "  " * (ind - 1) + "}"
    if isinstance(o, float): return f"{o:.4g}"
    return json.dumps(o)
fam_out = {f: {"perBall": v["per_ball"], "fitMatches": v["fit"]["matches"], "fitEvents": v["fit"]["events"]} for f, v in engine["formats"].items()}
eng_table = {
    "concussion": {"formats": fam_out, "battingShare": share_bat,
                   "missed": [engine["missed_next"].get(str(k), 0) for k in range(7)]},
    "retiredHurt": {"missProb": {f: round(a / b, 4) for f, (a, b) in hurt["miss_prob"].items()},
                    "missed": [hurt["missed"].get(str(k), 0) for k in range(1, 11)]},
    "bowlerBreakdown": {"missProb": round(hurt["bowler_miss_prob"][0] / hurt["bowler_miss_prob"][1], 4) if hurt["bowler_miss_prob"] else 0.67},
}
eng_ts = ROOT.parent / "engine" / "src" / "in-match-injury-data.ts"
eng_ts.write_text(
    "// Generated by packages/ratings/src/analysis/concussion-subs.py; do not edit by hand.\n"
    "// concussion: Cricsheet `replacements.match` (concussion_substitute), fit years " + "/".join(map(str, sorted(FIT_YEARS))) +
    ", both genders; per legal ball (Jeffreys, shrunk toward the all-format rate),\n"
    "//   the share hit batting, and team matches missed after (0, 1, ..., 6+).\n"
    "// retiredHurt / bowlerBreakdown: CricketArchive in-match 'retired hurt' / 'absent hurt' spells of regulars (injury-risk.py):\n"
    "//   share that missed the next match, and team matches missed when they did (1, ..., 10+).\n"
    "export const IN_MATCH_INJURY_DATA = " + ts_obj(eng_table) + " as const;\n")

# ── 3. CricketArchive notes ───────────────────────────────────────────────
sub_re = re.compile(r"(.+?)\s+full substitute:\s*(.+?)\s+for\s+(.+?)\s*\((after|before)\s+([^)]*)\)\s*\(([^)]*)\)", re.I)
ca = []
sc = DATA / "scorecards" / "scorecards.jsonl"
if sc.exists():
    with open(sc, "rb") as fh:
        for raw in fh:
            if b"oncussion" not in raw: continue
            try:
                o = json.loads(raw)
            except Exception:
                continue
            lv = o.get("levels") or []
            date = None
            for note in o.get("notes") or []:
                mm = sub_re.search(note)
                if not mm or "concussion" not in mm.group(6).lower(): continue
                team, when = mm.group(1).strip(), mm.group(5)
                wm = re.search(r"([\d.]+)\s+overs?\s+of the\s+(.+?)\s+(first|second|third|fourth)\s+innings", when)
                fmt = ("Test" if "Test" in lv else "ODI" if "ODI" in lv else "T20I" if any("International Twenty20" in x for x in lv)
                       else "T20 league" if any("Twenty20" in x for x in lv) else "List A (domestic)" if any("List A" in x for x in lv)
                       else "First-class (domestic)" if any("First-Class" in x for x in lv) else "other")
                ca.append({"id": o.get("id"), "fmt": fmt, "gender": o.get("gender"), "team": team,
                           "batting_side": bool(wm) and wm.group(2).strip() == team, "over": float(wm.group(1)) if wm else None})
ca_by = Counter((r["fmt"], r["gender"]) for r in ca)
ca_bat = Counter((r["fmt"], r["gender"]) for r in ca if r["batting_side"])

# ── 4. Summaries ──────────────────────────────────────────────────────────
fit_rows = [r for r in rows if r["date"] >= START]
summary = {
    "out_role": Counter(r["out_role"] for r in fit_rows), "in_role": Counter(r["in_role"] for r in fit_rows),
    "pair": Counter(f'{r["out_role"]} -> {r["in_role"]}' for r in fit_rows),
    "hit_batting": Counter(r["hit_batting"] for r in fit_rows), "batting_side": Counter(r["batting_side"] for r in fit_rows),
    "on_field_batting": Counter(r["on_field_batting"] for r in fit_rows if r["batting_side"]),
    "bat_pos_hit_batting": Counter(r["bat_pos"] for r in fit_rows if r["hit_batting"]),
    "innings": Counter(r["inn"] for r in fit_rows),
    "over_bucket_limited": Counter(("0-5" if r["over"] < 6 else "6-14" if r["over"] < 15 else "15-19" if r["over"] < 20 else "20+")
                                   for r in fit_rows if r["fmt"] in ("T20 league", "T20I")),
    "sub_batted": Counter(r["in_bat"] for r in fit_rows), "sub_bowled": Counter(r["in_bowl"] for r in fit_rows),
    "missed_next": Counter(min(r["missed"], 6) for r in fit_rows if r["next_known"]),
    "missed_by_fmt": {f: Counter(min(r["missed"], 6) for r in fit_rows if r["next_known"] and r["fmt"] == f) for f in FMTS},
}
out = {"generated": dt.datetime.now().isoformat(timespec="seconds"), "fit_years": sorted(FIT_YEARS), "check_years": sorted(CHECK_YEARS),
       "engine": engine, "cricsheet_events": len(rows), "cricsheet_events_since_2019_08": len(fit_rows), "rates": table, "by_year": by_year,
       "summary": {k: dict(v) if isinstance(v, Counter) else {kk: dict(vv) for kk, vv in v.items()} for k, v in summary.items()},
       "cricketarchive": {"events": len(ca), "by_format_gender": {f"{k[0]}|{k[1]}": v for k, v in ca_by.items()},
                          "batting_side": {f"{k[0]}|{k[1]}": v for k, v in ca_bat.items()}}}
EXPORT.mkdir(exist_ok=True)
json.dump(out, open(EXPORT / "concussion-subs.json", "w"), indent=1, default=str)
with open(DATA / "analysis" / "concussion_events.csv", "w", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
    w.writeheader(); w.writerows(rows)

print("cricsheet events", len(rows), "since 2019-08", len(fit_rows), "| CA notes", len(ca))
print(f"{'cell':44s} {'matches':>8s} {'ev':>4s} {'bat':>4s} {'fld':>4s} {'/1000':>7s} {'/1000J':>7s}")
for k, v in table.items():
    if v["matches"]:
        print(f"{k:44s} {v['matches']:8d} {v['events']:4d} {v['hit_batting']:4d} {v['hit_fielding']:4d} {v['per_1000_matches']:7.2f} {v['per_1000_matches_jeffreys']:7.2f}")
for k, v in summary.items():
    print(k, dict(v) if isinstance(v, Counter) else {kk: dict(vv) for kk, vv in v.items()})
print(json.dumps(engine, indent=1, default=str))
print("CA", dict(ca_by), "batting side", dict(ca_bat))
