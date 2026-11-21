"""
Real home advantage in franchise T20 leagues and in internationals (docs/LEAGUES.md, "Home advantage").

Run from packages/ratings:  python3 -I src/analysis/home-advantage.py     (needs the duckdb CLI)
Output: docs/data/home_advantage.json and a table on stdout.

A league match has a home side when the ground is one of that side's home grounds (HOME below: a franchise's own grounds,
by name, over the years, its former names included) and not one of the opponent's; anything else is neutral (shared
grounds, hubs, the UAE legs of the IPL and PSL, festival grounds). Whole seasons played in a bubble or hub are left out
(BUBBLE: IPL 2020-22, PSL 2021, CPL 2020-21, WBBL 2020-21, WPL 2023), as is the first-listed side, which is not the home
side. An international has a home side when the venue's country (data/analysis/venue_map.csv, as country-validation.py)
is one side's; venues the map does not place are left out. Decided matches only (a super-over or D/L winner counts).
Share of decided matches won by the home side, with its binomial standard error, all years, and the benchmark's two
halves: fit (2021 to 2024) and holdout (2025 on).
"""
import json
import math
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
OUT = ROOT.parent.parent / "docs" / "data" / "home_advantage.json"

EVENTS = {
    "ipl": ("Indian Premier League",), "psl": ("Pakistan Super League",), "bbl": ("Big Bash League",), "sa20": ("SA20",),
    "cpl": ("Caribbean Premier League",), "hundred-m": ("The Hundred Men's Competition",), "ilt20": ("International League T20",),
    "mlc": ("Major League Cricket",), "bpl": ("Bangladesh Premier League",), "lpl": ("Lanka Premier League",),
    "wbbl": ("Women's Big Bash League",), "hundred-w": ("The Hundred Women's Competition",), "wpl": ("Women's Premier League",),
}

# league -> Cricsheet team name -> venue substrings (case-insensitive) of its home grounds; optional (from, to) years per pattern
IPL = {
    "Chennai Super Kings": ["Chidambaram", "Chepauk"],
    "Mumbai Indians": ["Wankhede", "Brabourne"],
    "Royal Challengers Bangalore": ["Chinnaswamy"], "Royal Challengers Bengaluru": ["Chinnaswamy"],
    "Kolkata Knight Riders": ["Eden Gardens"],
    "Delhi Daredevils": ["Feroz Shah Kotla", "Arun Jaitley", ("Raipur", 2013, 2016)],
    "Delhi Capitals": ["Feroz Shah Kotla", "Arun Jaitley", ("Visakhapatnam", 2019, 2026)],
    "Kings XI Punjab": ["Mohali", "Dharamsala", "Indore", ("Cuttack", 2014, 2014)],
    "Punjab Kings": ["Mohali", "Dharamsala", "Mullanpur", "New Chandigarh"],
    "Rajasthan Royals": ["Sawai Mansingh", "Guwahati", ("Ahmedabad", 2010, 2015)],
    "Sunrisers Hyderabad": ["Rajiv Gandhi", "Uppal"],
    "Deccan Chargers": ["Rajiv Gandhi", "Uppal", ("Visakhapatnam", 2012, 2012), ("Cuttack", 2010, 2012)],
    "Gujarat Titans": [("Narendra Modi", 2022, 2030), ("Motera", 2022, 2030)],
    "Gujarat Lions": ["Rajkot", "Kanpur"],
    "Lucknow Super Giants": ["Ekana", "Lucknow"],
    "Pune Warriors": ["Subrata Roy", ("Maharashtra Cricket Association", 2013, 2013)],
    "Rising Pune Supergiant": ["Maharashtra Cricket Association"], "Rising Pune Supergiants": ["Maharashtra Cricket Association"],
    "Kochi Tuskers Kerala": ["Kochi", "Holkar"],
}
HOME = {
    "ipl": IPL,
    "psl": {"Lahore Qalandars": ["Gaddafi"], "Karachi Kings": ["Karachi"], "Islamabad United": ["Rawalpindi"], "Multan Sultans": ["Multan"],
            "Rawalpindiz": ["Rawalpindi"]},
    "bbl": {"Adelaide Strikers": ["Adelaide Oval"], "Brisbane Heat": ["Brisbane Cricket Ground", "Carrara", "Gabba"],
            "Hobart Hurricanes": ["Bellerive", "Launceston", "Blundstone"], "Melbourne Renegades": ["Etihad", "Marvel", "Docklands", "Geelong"],
            "Melbourne Stars": ["Melbourne Cricket Ground", "Junction Oval"], "Perth Scorchers": ["WACA", "Perth Stadium", "Optus"],
            "Sydney Sixers": ["Sydney Cricket Ground", "Coffs Harbour", "North Sydney"],
            "Sydney Thunder": ["Showground", "ANZ Stadium", "ENGIE", "Spotless", "Manuka", "Lavington"]},
    "sa20": {"Durban's Super Giants": ["Kingsmead"], "Joburg Super Kings": ["Wanderers"], "MI Cape Town": ["Newlands"], "Paarl Royals": ["Boland", "Paarl"],
             "Pretoria Capitals": ["SuperSport", "Centurion"], "Sunrisers Eastern Cape": ["St George"]},
    "cpl": {"Antigua Hawksbills": ["Antigua"], "Antigua and Barbuda Falcons": ["Antigua"], "Barbados Tridents": ["Kensington"], "Barbados Royals": ["Kensington"],
            "Guyana Amazon Warriors": ["Providence"], "Jamaica Tallawahs": ["Sabina"], "Jamaica Kingsmen": ["Sabina"], "St Kitts and Nevis Patriots": ["Warner Park"],
            "St Lucia Zouks": ["St Lucia"], "St Lucia Stars": ["St Lucia"], "St Lucia Kings": ["St Lucia"],
            "Trinidad & Tobago Red Steel": ["Trinidad"], "Trinbago Knight Riders": ["Trinidad"]},
    "hundred-m": {"Birmingham Phoenix": ["Edgbaston"], "London Spirit": ["Lord's"], "MI London": ["The Oval", "Kennington"], "Manchester Originals": ["Old Trafford"],
                  "Manchester Super Giants": ["Old Trafford"], "Northern Superchargers": ["Headingley"], "Sunrisers Leeds": ["Headingley"],
                  "Oval Invincibles": ["The Oval", "Kennington"], "Southern Brave": ["Rose Bowl", "Ageas", "Utilita"], "Trent Rockets": ["Trent Bridge"],
                  "Welsh Fire": ["Sophia Gardens", "Cardiff"]},
    # three grounds, six sides: the game's nominal homes (league_defs.py) and the benchmark's
    "ilt20": {"Abu Dhabi Knight Riders": ["Abu Dhabi"], "Dubai Capitals": ["Dubai"], "Desert Vipers": ["Dubai"], "Gulf Giants": ["Dubai"],
              "MI Emirates": ["Sharjah"], "Sharjah Warriors": ["Sharjah"], "Sharjah Warriorz": ["Sharjah"]},
    "mlc": {"Texas Super Kings": ["Grand Prairie"], "San Francisco Unicorns": ["Oakland"], "Los Angeles Knight Riders": ["Pomona"]},
    "bpl": {**{t: ["Mirpur", "Shere Bangla"] for t in ("Dhaka Gladiators", "Dhaka Dynamites", "Dhaka Platoon", "Dhaka Dominators", "Dhaka Capitals",
                                                        "Minister Group Dhaka", "Durdanto Dhaka")},
            **{t: ["Chattogram", "Chittagong", "Zahur Ahmed"] for t in ("Chittagong Kings", "Chittagong Vikings", "Chattogram Challengers", "Chattogram Royals")},
            **{t: ["Sylhet"] for t in ("Sylhet Royals", "Sylhet Super Stars", "Sylhet Sixers", "Sylhet Sunrisers", "Sylhet Thunder", "Sylhet Strikers", "Sylhet Titans")},
            **{t: ["Khulna"] for t in ("Khulna Royal Bengals", "Khulna Titans", "Khulna Tigers")}},
    "lpl": {**{t: ["Pallekele"] for t in ("Kandy Tuskers", "Kandy Warriors", "Kandy Falcons", "B-Love Kandy", "Kandy Royals")},
            **{t: ["Dambulla"] for t in ("Dambulla Viiking", "Dambulla Giants", "Dambulla Aura", "Dambulla Sixers")},
            **{t: ["Premadasa", "Colombo"] for t in ("Colombo Kings", "Colombo Stars", "Colombo Strikers", "Colombo Kaps")}},
    "wpl": {"Mumbai Indians": ["Mumbai"], "Delhi Capitals": ["Arun Jaitley", "Delhi"], "Royal Challengers Bangalore": ["Chinnaswamy"],
            "Royal Challengers Bengaluru": ["Chinnaswamy"], "UP Warriorz": ["Ekana", "Lucknow"], "Gujarat Giants": ["Vadodara", "Kotambi", "Ahmedabad"]},
}
HOME["wbbl"] = {**HOME["bbl"], "Adelaide Strikers": ["Adelaide Oval", "Karen Rolton"], "Hobart Hurricanes": ["Bellerive", "Launceston", "Blundstone", "Ninja Stadium"],
                "Perth Scorchers": ["WACA", "Perth Stadium", "Lilac Hill"], "Brisbane Heat": ["Brisbane Cricket Ground", "Allan Border", "Gabba"],
                "Sydney Sixers": ["Sydney Cricket Ground", "North Sydney", "Drummoyne"], "Melbourne Stars": ["Melbourne Cricket Ground", "Junction Oval", "CitiPower"],
                "Melbourne Renegades": ["Marvel", "Docklands", "Geelong", "Eastern Oval"]}
HOME["hundred-w"] = HOME["hundred-m"]
# whole seasons in a bubble or hub (first year of the season)
BUBBLE = {"ipl": {2020, 2021, 2022, 2009}, "psl": {2021}, "cpl": {2020, 2021}, "wbbl": {2020, 2021}, "wpl": {2023}}

FULL = ["Afghanistan", "Australia", "Bangladesh", "England", "India", "Ireland", "New Zealand", "Pakistan",
        "South Africa", "Sri Lanka", "West Indies", "Zimbabwe"]
CODE = {"India": "IND", "England": "ENG", "Australia": "AUS", "South Africa": "RSA", "New Zealand": "NZ", "Pakistan": "PAK",
        "Sri Lanka": "SL", "West Indies": "WI", "Bangladesh": "BDESH", "Zimbabwe": "ZIM", "Ireland": "IRELAND", "Afghanistan": "AFG"}
INTL = {"t20i-men": (("T20", "IT20"), "male"), "t20i-women": (("T20", "IT20"), "female"), "odi-men": (("ODI", "ODM"), "male"),
        "odi-women": (("ODI", "ODM"), "female"), "test-men": (("Test", "MDM"), "male")}


def duck(sql: str) -> list:
    p = subprocess.run(["duckdb", "-json", "-c", "SET memory_limit='2GB'; " + sql], capture_output=True, text=True, cwd=DATA)
    if p.returncode != 0:
        raise SystemExit(f"duckdb failed: {p.stderr}\n{sql[:400]}")
    return json.loads(p.stdout) if p.stdout.strip() else []


def is_home(pats, venue: str, year: int) -> bool:
    v = venue.lower()
    for p in pats:
        if isinstance(p, tuple):
            if p[1] <= year <= p[2] and p[0].lower() in v:
                return True
        elif p.lower() in v:
            return True
    return False


def share(rows):
    n = len(rows)
    w = sum(rows)
    p = w / n if n else None
    return {"n": n, "homeWins": w, "share": round(p, 4) if n else None, "se": round(math.sqrt(p * (1 - p) / n), 4) if n else None}


def windows(rows):
    """rows: (date str, home won 0/1)"""
    return {"all": share([h for _, h in rows]), "since2015": share([h for d, h in rows if d >= "2015-01-01"]),
            "fit": share([h for d, h in rows if "2021-01-01" <= d <= "2024-12-31"]), "hold": share([h for d, h in rows if d >= "2025-01-01"])}


def leagues() -> dict:
    out = {}
    for lg, events in EVENTS.items():
        ev = ", ".join("'" + e.replace("'", "''") + "'" for e in events)
        rows = duck(f"SELECT match_id, CAST(date AS VARCHAR) d, season, team1, team2, venue, coalesce(city, '') city, winner FROM 'matches.parquet' "
                    f"WHERE team_type = 'club' AND event IN ({ev}) ORDER BY date")
        home_rows, neutral, nores, bubble, per_team = [], 0, 0, 0, {}
        for r in rows:
            year = int(r["d"][:4])
            # a season over the new year (BBL, WBBL, SA20, ILT20 ...) is named by the year it starts in
            sy = int(str(r["season"])[:4]) if r["season"] else year
            if sy in BUBBLE.get(lg, set()):
                bubble += 1
                continue
            if not r["winner"] or r["winner"] not in (r["team1"], r["team2"]):
                nores += 1
                continue
            place = f"{r['venue']} {r['city']}"
            h = [is_home(HOME[lg].get(t, []), place, year) for t in (r["team1"], r["team2"])]
            if h[0] == h[1]:
                neutral += 1
                continue
            ht = r["team1"] if h[0] else r["team2"]
            won = 1 if r["winner"] == ht else 0
            home_rows.append((r["d"], won))
            per_team.setdefault(ht, []).append(won)
        out[lg] = {**windows(home_rows), "neutralDecided": neutral, "noResult": nores, "bubbleSeasonMatches": bubble,
                   "byTeam": {t: share(v) for t, v in sorted(per_team.items())}}
    return out


def internationals() -> dict:
    members = ", ".join(f"'{t}'" for t in FULL)
    out = {}
    for key, (types, g) in INTL.items():
        mt = ", ".join(f"'{t}'" for t in types)
        rows = duck(f"""
WITH vm AS (SELECT raw_venue, coalesce(raw_city, '') raw_city, any_value(country) country FROM read_csv('venue_map.csv', header=true, all_varchar=true) WHERE source = 'cs' GROUP BY 1, 2)
SELECT CAST(m.date AS VARCHAR) d, m.team1, m.team2, m.winner, m.result, coalesce(vm.country, 'UNK') vc FROM 'matches.parquet' m
LEFT JOIN vm ON vm.raw_venue = m.venue AND vm.raw_city = coalesce(m.city, '')
WHERE m.match_type IN ({mt}) AND m.gender = '{g}' AND m.team_type = 'international' AND m.team1 IN ({members}) AND m.team2 IN ({members}) ORDER BY m.date""")
        home_rows, home_all, neutral, unk = [], [], 0, 0
        for r in rows:
            if r["vc"] == "UNK":
                unk += 1
                continue
            h = [CODE[r["team1"]] == r["vc"], CODE[r["team2"]] == r["vc"]]
            if h[0] == h[1]:
                neutral += 1
                continue
            ht = r["team1"] if h[0] else r["team2"]
            decided = bool(r["winner"]) and r["winner"] in (r["team1"], r["team2"])
            # Tests: the home share of all results (draws in the base) as well as of decided matches
            home_all.append((r["d"], 1 if decided and r["winner"] == ht else 0))
            if decided:
                home_rows.append((r["d"], 1 if r["winner"] == ht else 0))
        out[key] = {**windows(home_rows), "neutralMatches": neutral, "unplacedVenue": unk}
        if key.startswith("test"):
            out[key]["homeWinOfAllResults"] = windows(home_all)
    return out


def fmt(w):
    return f"{w['share']:.3f} +- {w['se']:.3f} ({w['n']})" if w["n"] else "-"


def main():
    res = {"leagues": leagues(), "internationals": internationals()}
    OUT.write_text(json.dumps(res, indent=1))
    print("competition | all years | since 2015 | 2021-24 | 2025+ | neutral decided")
    for k, v in {**res["leagues"], **res["internationals"]}.items():
        print(f"{k} | {fmt(v['all'])} | {fmt(v['since2015'])} | {fmt(v['fit'])} | {fmt(v['hold'])} | {v.get('neutralDecided', v.get('neutralMatches'))}")
    print("wrote", OUT)


main()
