"""
Trim data-export/venue-conditions.json into a small engine module (packages/engine/src/venue-data.ts).

Only what the T20 engine uses: the home grounds of the game's franchises (men's and women's
versions), per-country T20 fallbacks, and chase/toss baselines by competition.

Run from packages/ratings:  python3 -I src/analysis/export-engine-venues.py
"""
import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from league_defs import LEAGUES, team_grounds, team_id  # extra leagues (BBL, PSL, ...): home grounds and competitions

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "data-export" / "venue-conditions.json"
TOSS = ROOT / "data" / "analysis" / "toss_chase.csv"
OUT = ROOT.parent / "engine" / "src" / "venue-data.ts"

# Game team id -> ground name in the venue export (current home grounds).
TEAM_GROUNDS = {
    # IPL
    "srh": "Rajiv Gandhi International Stadium",
    "dc": "Arun Jaitley Stadium (Feroz Shah Kotla)",
    "rcb": "M Chinnaswamy Stadium",
    "kkr": "Eden Gardens",
    "rr": "Sawai Mansingh Stadium",
    "csk": "MA Chidambaram Stadium (Chepauk)",
    "mi": "Wankhede Stadium",
    "pbks": "Maharaja Yadavindra Singh Stadium",  # PBKS home since 2024 (Mullanpur)
    "gt": "Narendra Modi Stadium (Motera)",
    "lsg": "Ekana Cricket Stadium",
    # WPL (grounds as configured in team.ts)
    "mi-w": "DY Patil Stadium",
    "dc-w": "Arun Jaitley Stadium (Feroz Shah Kotla)",
    "rcb-w": "M Chinnaswamy Stadium",
    "gg-w": "Narendra Modi Stadium (Motera)",
    "upw": "Ekana Cricket Stadium",
}
WOMEN_TEAMS = {"mi-w", "dc-w", "rcb-w", "gg-w", "upw"}
for _team, (_ground, _gender) in team_grounds().items():
    TEAM_GROUNDS[_team] = _ground
    if _gender == "female":
        WOMEN_TEAMS.add(_team)

# Engine bowling-style groups -> keys used in the export's bowlerTypeEdges
EDGE_KEYS = ["RA fast", "RA fast-medium", "RA medium", "LA pace", "off-spin", "wrist-spin", "LA orthodox"]

MIN_WOMEN_GROUND_MATCHES = 15  # below this, use the men's ground shrunk halfway to average


def r(x, nd=3):
    return None if x is None else round(float(x), nd)


def compact(g, shrink=1.0):
    """Ground record -> engine profile. shrink < 1 pulls factors toward 100 / edges toward 0."""
    def f(key):
        v = g.get(key)
        return 100.0 if v is None else 100.0 + (float(v) - 100.0) * shrink
    edges = {}
    for k, e in (g.get("bowlerTypeEdges") or {}).items():
        if k not in EDGE_KEYS:
            continue
        edges[k] = {"wkts": r(e.get("wkts_eff_per100", 0.0) * shrink), "econ": r(e.get("econ_eff", 0.0) * shrink)}
    return {
        "name": g["name"],
        "country": g.get("country"),
        "matches": g["matches"],
        "runFactor": r(f("runFactor"), 1),
        "sixFactor": r(f("sixFactor"), 1),
        "wicketFactor": r(f("wicketFactor"), 1),
        "chaseAdvantage": r(g.get("chaseAdvantage")),
        "edges": edges,
    }


def main():
    d = json.loads(SRC.read_text())
    grounds = [g for g in d["grounds"] if g["format"] == "T20"]
    by = {}
    for g in grounds:
        key = (g["name"], g["gender"])
        if key not in by or g["matches"] > by[key]["matches"]:
            by[key] = g

    team_profiles = {}
    for team, ground in TEAM_GROUNDS.items():
        gender = "female" if team in WOMEN_TEAMS else "male"
        g = by.get((ground, gender))
        if g and (gender == "male" or g["matches"] >= MIN_WOMEN_GROUND_MATCHES):
            prof = compact(g)
            prof["source"] = f"{gender} T20 ground ({g['matches']} matches)"
        else:
            m = by.get((ground, "male"))
            if not m:
                raise SystemExit(f"no T20 record for {ground}")
            prof = compact(m, shrink=0.5)
            prof["source"] = f"men's T20 ground ({m['matches']} matches), shrunk 50%"
        team_profiles[team] = prof

    # Country fallbacks: match-weighted mean of that country's T20 grounds with 20+ matches.
    countries = {}
    for (name, gender), g in by.items():
        if g["matches"] < 20 or not g.get("country"):
            continue
        c = countries.setdefault((g["country"], gender), {"w": 0, "run": 0, "six": 0, "wkt": 0})
        w = g["matches"]
        c["w"] += w
        c["run"] += w * g["runFactor"]
        c["six"] += w * (g.get("sixFactor") or 100.0)
        c["wkt"] += w * g["wicketFactor"]
    country_profiles = {}
    for (country, gender), c in sorted(countries.items()):
        country_profiles[f"{country}|{gender}"] = {
            "runFactor": r(c["run"] / c["w"], 1),
            "sixFactor": r(c["six"] / c["w"], 1),
            "wicketFactor": r(c["wkt"] / c["w"], 1),
            "matches": int(c["w"]),
        }

    # Chase / toss baselines from toss_chase.csv
    rows = list(csv.DictReader(TOSS.open()))
    def est(analysis, gender, group_type, group):
        for row in rows:
            if (row["analysis"] == analysis and row["format"] == "T20" and row["scope"] == "all"
                    and row["gender"] == gender and row["group_type"] == group_type and row["group"] == group):
                return float(row["estimate"]), float(row["se"]) if row["se"] else None
        return None, None

    men_all, _ = est("chase_advantage", "male", "overall", "all")
    women_all, _ = est("chase_advantage", "female", "overall", "all")
    ipl_now, ipl_se = est("chase_advantage", "male", "competition_era", "Indian Premier League | 2024-26")
    wpl_all, wpl_se = est("chase_advantage", "female", "competition", "Women's Premier League")
    tau = 0.03  # spread of true competition chase advantages around the format mean
    def shrink(x, se, prior):
        w = tau ** 2 / (tau ** 2 + se ** 2)
        return prior + w * (x - prior)
    chase = {
        # IPL: the 2024-26 estimate as is (0.056 +- 0.035; all IPL seasons 0.048 +- 0.015 agree)
        "ipl": r(ipl_now),
        # WPL: only 87 matches (0.088 +- 0.056), so shrink toward the women's T20 mean
        "wpl": r(shrink(wpl_all, wpl_se, women_all)),
        "male": r(men_all),
        "female": r(women_all),
    }
    # Extra leagues: each competition's own chase record, shrunk toward the gender mean like the WPL's
    league_chase = {}
    for lg in LEAGUES:
        gender = "female" if lg["gender"] == "women" else "male"
        x, se = est("chase_advantage", gender, "competition", lg["competition"])
        prior = women_all if gender == "female" else men_all
        league_chase[lg["id"]] = r(shrink(x, se, prior)) if x is not None else r(prior)
    chase["leagues"] = league_chase
    toss_value, _ = est("toss_value_win", "male", "overall", "all")
    field_share, _ = est("toss_choice_field_share", "male", "era", "2024-26")

    data = {
        "teams": team_profiles,
        "countries": country_profiles,
        "chase": chase,
        "tossValueWin": r(toss_value),
        "fieldShare2024_26": r(field_share),
        "generated": d.get("generated"),
    }
    ts = (
        "/**\n"
        " * GENERATED by packages/ratings/src/analysis/export-engine-venues.py from\n"
        " * packages/ratings/data-export/venue-conditions.json and toss_chase.csv. Do not edit by hand.\n"
        " *\n"
        " * runFactor / sixFactor / wicketFactor: 100 = average T20 ground for that gender (after\n"
        " * adjusting for the two XIs' strength, shrunk by sample size). edges: per bowler type,\n"
        " * wickets per 100 balls and economy (runs/over) vs the same bowlers elsewhere.\n"
        " * chaseAdvantage: P(chasing side wins) - 0.5 for equal teams.\n"
        " */\n"
        "import type { VenueDataFile } from \"./venues.js\";\n\n"
        f"export const VENUE_DATA: VenueDataFile = {json.dumps(data, indent=1)};\n"
    )
    OUT.write_text(ts)
    print(f"wrote {OUT} ({len(ts)} bytes): {len(team_profiles)} team grounds, {len(country_profiles)} country profiles")
    for t, p in team_profiles.items():
        print(f"  {t:6} {p['name'][:34]:34} run {p['runFactor']:6} six {p['sixFactor']:6} wkt {p['wicketFactor']:6} chase {p['chaseAdvantage']}  [{p['source']}]")
    print("chase baselines", chase, "toss", toss_value, "field share", field_share)


if __name__ == "__main__":
    main()
