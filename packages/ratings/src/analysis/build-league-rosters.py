"""
Build the squads for the extra T20 leagues from data on disk (no web access).

Inputs (packages/ratings/data, shared and read-only here):
  cricket.db                         CricketArchive scorecards: full XIs per match (batting rows include "did not bat")
  analysis/people.parquet            Cricsheet people register (Cricinfo id <-> CricketArchive id)
  analysis/ca_espn_map.csv           CricketArchive id <-> Cricinfo id (other mappings)
  analysis/player_ratings_by_season.parquet   ratings model, 'latest' snapshot (fallback ratings)
  ../src/all-players.ts, ../src/wpl-players.ts  the game's pool (ids "espn_<cricinfo id>")

A team's squad is its players from the league's most recent complete season, ranked by appearances and
trimmed to the league's squad size / overseas limits. Players are matched to the pool by Cricinfo id; the
rest get ids "ca_<CricketArchive id>" (the id the full CricketArchive pool uses) and a model-based fallback
rating.

Outputs:
  packages/ratings/src/league-rosters.ts   squads
  packages/engine/src/league-defs.ts       teams + rules
  packages/ratings/data/analysis/league_squads_report.json   match rates (new file; data dir is shared)

Run from packages/ratings:  python3 -I src/analysis/build-league-rosters.py
"""
import collections
import csv
import json
import re
import sqlite3
import subprocess
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from league_defs import LEAGUES, team_id  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
OUT_ROSTERS = ROOT / "src" / "league-rosters.ts"
OUT_DEFS = ROOT.parent / "engine" / "src" / "league-defs.ts"
OUT_REPORT = DATA / "analysis" / "league_squads_report.json"
TODAY = date(2026, 11, 6)  # the data's "now" (latest scorecards are from 2026-11-02)

INTL_LEVELS = ("Test", "ODI", "International Twenty20", "Women's Test", "Women's ODI", "Women's International Twenty20")
WI_PLACES = {"Jamaica", "Barbados", "Trinidad and Tobago", "Guyana", "Antigua and Barbuda", "Saint Kitts and Nevis",
             "St Kitts and Nevis", "Saint Lucia", "St Lucia", "Grenada", "Saint Vincent and the Grenadines", "Dominica",
             "Anguilla", "Montserrat", "British Virgin Islands", "Sint Maarten", "Antigua", "Trinidad", "Tobago",
             "St Vincent", "Saint Vincent", "Nevis", "St Kitts"}
BORN_FIX = {"United States of America": "USA", "United States": "USA", "United Arab Emirates": "UAE", "Northern Ireland": "Ireland",
            "Netherlands Antilles": "West Indies", "Scotland": "Scotland",
            "Wales": "England", "Scotland": "Scotland", "Hong Kong": "Hong Kong", "Sri Lanka": "Sri Lanka"}


def duck(sql):
    out = subprocess.run(["duckdb", "-json", "-c", sql], capture_output=True, text=True, check=True).stdout
    return json.loads(out) if out.strip() else []


def clamp(x, lo=15, hi=99):
    return max(lo, min(hi, int(round(x))))


# ---------------------------------------------------------------------------------------------
# The game's pool (espn ids -> country, name, ratings)
# ---------------------------------------------------------------------------------------------
POOL_RE = re.compile(
    r'\{\s*id: "espn_(\d+)",\s*name: "((?:[^"\\]|\\.)*)",\s*age: (\d+),\s*country: "([^"]*)",\s*role: "([^"]*)",\s*'
    r'ratings: \{ battingIQ: (\d+), timing: (\d+), power: (\d+), running: (\d+), wicketTaking: (\d+), economy: (\d+), accuracy: (\d+), clutch: (\d+) \}')


def load_pool():
    pool = {"men": {}, "women": {}}
    for fn, g in (("all-players.ts", "men"), ("wpl-players.ts", "women")):
        s = (ROOT / "src" / fn).read_text()
        for m in POOL_RE.finditer(s):
            e, name, age, country, role, *r = m.groups()
            pool[g][int(e)] = dict(name=name, age=int(age), country=re.sub(r" Women$", "", country), role=role, r=[int(x) for x in r])
    return pool


# ---------------------------------------------------------------------------------------------
# Fallback ratings: OLS from the ratings-model snapshot onto the pool's 8 attributes
# ---------------------------------------------------------------------------------------------
TARGETS = ["battingIQ", "timing", "power", "running", "wicketTaking", "economy", "accuracy", "clutch"]
FEATS = ["bat_ovr", "bowl_ovr", "bat_timing", "bat_power", "bat_running", "bowl_economy", "bowl_wickets", "bowl_accuracy", "clutch"]


def solve(A, b):
    n = len(A)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for i in range(n):
        p = max(range(i, n), key=lambda r: abs(M[r][i]))
        M[i], M[p] = M[p], M[i]
        piv = M[i][i] or 1e-9
        for j in range(i, n + 1):
            M[i][j] /= piv
        for r in range(n):
            if r != i:
                f = M[r][i]
                for j in range(i, n + 1):
                    M[r][j] -= f * M[i][j]
    return [M[i][n] for i in range(n)]


def ols(X, y, ridge=1e-3):
    k = len(X[0])
    A = [[sum(x[i] * x[j] for x in X) + (ridge if i == j and i > 0 else 0) for j in range(k)] for i in range(k)]
    b = [sum(x[i] * yy for x, yy in zip(X, y)) for i in range(k)]
    return solve(A, b)


def model_rows():
    rows = duck("select cricinfo_id, cricketarchive_id, gender, age, player_role, keeper, bat_ovr, bowl_ovr, bat_timing, bat_power, "
                "bat_running, bowl_economy, bowl_wickets, bowl_accuracy, clutch, bowl_balls_eff, bat_balls_career "
                "from read_parquet('%s') where snapshot='latest'" % (DATA / "analysis" / "player_ratings_by_season.parquet"))
    return rows


def feat_vec(row):
    return [1.0] + [float(row.get(f) if row.get(f) is not None else (50.0 if f == "clutch" else 0.0)) for f in FEATS]


def fit_fallback(model, pool):
    coefs = {}
    by_cricinfo = {r["cricinfo_id"]: r for r in model if r["cricinfo_id"] is not None}
    for g, mg in (("men", "male"), ("women", "female")):
        X, Y = [], [[] for _ in TARGETS]
        for e, p in pool[g].items():
            r = by_cricinfo.get(e)
            if not r or r["gender"] != mg:
                continue
            X.append(feat_vec(r))
            for i in range(len(TARGETS)):
                Y[i].append(p["r"][i])
        coefs[g] = [ols(X, Y[i]) for i in range(len(TARGETS))]
        # report fit quality
        for i, t in enumerate(TARGETS):
            pred = [sum(c * x for c, x in zip(coefs[g][i], xv)) for xv in X]
            ybar = sum(Y[i]) / len(Y[i])
            ss_res = sum((a - b) ** 2 for a, b in zip(Y[i], pred))
            ss_tot = sum((a - ybar) ** 2 for a in Y[i])
            print(f"  fallback fit {g:5} {t:12} n={len(X)} R2={1 - ss_res / ss_tot:.2f}", file=sys.stderr)
    return coefs, by_cricinfo


def fallback_ratings(coefs, g, row, role):
    if row is None:
        # no model row: a low-end default for the role
        d = dict(batsman=dict(bat_ovr=38, bowl_ovr=4), bowler=dict(bat_ovr=10, bowl_ovr=38), **{"all-rounder": dict(bat_ovr=28, bowl_ovr=28)})[role]
        row = dict(d, clutch=45)
    x = feat_vec(row)
    return [clamp(sum(c * v for c, v in zip(coefs[g][i], x))) for i in range(len(TARGETS))]


# ---------------------------------------------------------------------------------------------
def bowling_style(ca_style):
    if not ca_style:
        return "unknown"
    s = ca_style.split(",")[0].strip().lower()
    left = s.startswith("left") or s.startswith("slow left")
    table = [
        ("slow left-arm wrist", "left-arm-wrist-spin"), ("slow left-arm orthodox", "left-arm-orthodox"),
        ("off-break", "off-spin"), ("leg-break", "leg-spin"),
        ("fast-medium", "left-arm-fast-medium" if left else "right-arm-fast-medium"),
        ("medium-fast", "left-arm-medium-fast" if left else "right-arm-medium-fast"),
        ("medium pace", "left-arm-medium" if left else "right-arm-medium"),
        ("slow-medium", "left-arm-slow" if left else "right-arm-slow"),
        ("slow", "left-arm-slow" if left else "right-arm-slow"),
        ("fast", "left-arm-fast" if left else "right-arm-fast"),
    ]
    for k, v in table:
        if k in s:
            return v
    return "unknown"


def prev_season_event(lg):
    """CricketArchive event prefix of the season before lg['season'] (e.g. '... 2025/26' -> '... 2024/25')."""
    ev, season = lg["ca_event"], lg["season"]
    if "/" in season:
        y = int(season.split("/")[0])
        prev = f"{y - 1}/{str(y)[2:]}"
    else:
        prev = str(int(season) - 1)
    return ev.replace(season, prev)


def overseas_c(country, home):
    if home == "England":
        return country not in ("England", "Wales")
    return country != home


def main():
    db = sqlite3.connect(str(DATA / "cricket.db"))
    pool = load_pool()
    print(f"pool: {len(pool['men'])} men, {len(pool['women'])} women", file=sys.stderr)

    # id maps
    ca2espn = {}
    for r in duck("select cricketarchive_id ca, cricinfo_id e from read_parquet('%s') where cricketarchive_id is not null and cricinfo_id is not null" % (DATA / "analysis" / "people.parquet")):
        ca2espn[int(r["ca"])] = int(r["e"])
    with open(DATA / "analysis" / "ca_espn_map.csv") as f:
        for r in csv.DictReader(f):
            ca2espn.setdefault(int(r["ca_id"]), int(r["espn_id"]))
    model = model_rows()
    coefs, model_by_cricinfo = fit_fallback(model, pool)
    model_by_ca = {int(r["cricketarchive_id"]): r for r in model if r["cricketarchive_id"] is not None}

    def model_row(ca_id):
        e = ca2espn.get(ca_id)
        return model_by_cricinfo.get(e) if e else model_by_ca.get(ca_id)

    def nationality(ca_id, g, born, home=None):
        e = ca2espn.get(ca_id)
        if e and e in pool[g]:
            return pool[g][e]["country"]
        rows = db.execute("select team, years from player_teams where player_id=? and level in (%s)" % ",".join("?" * len(INTL_LEVELS)),
                          (ca_id, *INTL_LEVELS)).fetchall()
        best = None
        for team, years in rows:
            if re.search(r"Under-?19|XI|World|Lions|\bA\b$", team or ""):
                continue
            m = re.findall(r"(\d{4})", years or "")
            last = int(m[-1]) if m else 0
            if best is None or last > best[0]:
                best = (last, re.sub(r" Women$", "", team))
        if best:
            return BORN_FIX.get(best[1], best[1])
        if born:
            c = born.split(",")[-1].strip()
            if c in WI_PLACES or any(p in born for p in WI_PLACES):
                return "West Indies"
            c = BORN_FIX.get(c, c)
            if re.search(r"\d", c) or len(c) < 3:   # birthplace missing (the field is just a date)
                return home
            return c
        return home

    out_rosters = {}
    report = {}
    for lg in LEAGUES:
        g = lg["gender"]
        mg = "female" if g == "women" else "male"
        rules = lg["rules"]
        home = lg["homeCountry"]
        rows = db.execute(
            "select b.team, b.player_id, count(distinct b.match_id) apps, (sum(b.keeper) * 2 >= count(distinct b.match_id)) keeper, sum(case when b.position<=2 then 1 else 0 end) opens "
            "from batting b join matches m on m.id=b.match_id where m.event like ? and b.team not like '%super over%' group by b.team, b.player_id",
            (lg["ca_event"] + "%",)).fetchall()
        # each player's main team this season
        by_player = {}
        for team, pid, apps, keeper, opens in rows:
            if pid not in by_player or apps > by_player[pid][1]:
                by_player[pid] = (team, apps, keeper, opens)
        by_team = collections.defaultdict(list)
        for pid, (team, apps, keeper, opens) in by_player.items():
            by_team[team].append((pid, apps, keeper))
        # observed overseas count per XI over the season (for checking the league's rules against the data)
        xi = collections.defaultdict(list)
        for mid, team, pid in db.execute(
                "select b.match_id, b.team, b.player_id from batting b join matches m on m.id=b.match_id "
                "where m.event like ? and b.team not like '%super over%'", (lg["ca_event"] + "%",)):
            xi[(mid, team)].append(pid)
        nat_cache = {}

        def nat_of(pid):
            if pid not in nat_cache:
                r = db.execute("select born from players where id=?", (pid,)).fetchone()
                nat_cache[pid] = nationality(pid, g, r[0] if r else None, home)
            return nat_cache[pid]
        counts = collections.Counter(sum(1 for pid in pids if overseas_c(nat_of(pid), home)) for pids in xi.values())
        teams_out = []
        rep_teams = {}
        bowled_matches = dict(db.execute(
            "select b.player_id, count(distinct b.match_id) from bowling b join matches m on m.id=b.match_id where m.event like ? group by b.player_id",
            (lg["ca_event"] + "%",)).fetchall())
        pinfo = {r[0]: r for r in db.execute(
            "select id, name, full_name, dob, born, batting_hand, bowling_style from players where id in (%s)" % ",".join(str(p) for p in by_player))}

        def overseas(country):
            return overseas_c(country, home)

        for t in lg["teams"]:
            tid = team_id(lg["id"], t[0])
            plist = sorted(by_team.get(t[7], []), key=lambda x: (-x[1], x[0]))
            if not plist:
                raise SystemExit(f"no CA rows for {t[7]} in {lg['ca_event']}")
            squad, n_over = [], 0
            skipped = []
            for pid, apps, keeper in plist:
                _, name, full, dob, born, hand, style = pinfo[pid]
                country = nationality(pid, g, born, home)
                is_over = overseas(country)
                if len(squad) >= rules["maxSquadSize"]:
                    skipped.append(name)
                    continue
                if is_over and n_over >= rules["maxOverseasInSquad"]:
                    skipped.append(name)
                    continue
                n_over += is_over
                squad.append((pid, name, dob, born, hand, style, country, apps, keeper))
            # short squads (players who never made an XI are invisible in scorecards): top up from the same franchise's
            # previous season, most appearances first
            if len(squad) < rules["minSquadSize"]:
                prev_event = prev_season_event(lg)
                prows = db.execute(
                    "select b.player_id, count(distinct b.match_id) apps, (sum(b.keeper) * 2 >= count(distinct b.match_id)) from batting b join matches m on m.id=b.match_id "
                    "where m.event like ? and b.team = ? group by b.player_id order by apps desc", (prev_event + "%", t[7])).fetchall()
                have = {s_[0] for s_ in squad}
                taken_elsewhere = set(by_player) - {p_[0] for p_ in plist}
                for pid, apps, keeper in prows:
                    if len(squad) >= rules["minSquadSize"]:
                        break
                    if pid in have or pid in taken_elsewhere:
                        continue
                    if pid not in pinfo:
                        pinfo[pid] = db.execute("select id, name, full_name, dob, born, batting_hand, bowling_style from players where id=?", (pid,)).fetchone()
                    _, name, full, dob, born, hand, style = pinfo[pid]
                    country = nationality(pid, g, born, home)
                    if overseas(country) and n_over >= rules["maxOverseasInSquad"]:
                        continue
                    n_over += overseas(country)
                    squad.append((pid, name, dob, born, hand, style, country, 0, keeper))
            # make sure there is a keeper
            if not any(s[8] for s in squad):
                ks = [(p, a, k) for p, a, k in plist if k]
                if ks:
                    pid = ks[0][0]
                    _, name, full, dob, born, hand, style = pinfo[pid]
                    squad[-1] = (pid, name, dob, born, hand, style, nationality(pid, g, born, home), ks[0][1], 1)
            players, matched = [], 0
            for pid, name, dob, born, hand, style, country, apps, keeper in squad:
                e = ca2espn.get(pid)
                in_pool = e is not None and e in pool[g]
                matched += in_pool
                age = None
                if dob:
                    y, mo, d = map(int, dob.split("-"))
                    age = TODAY.year - y - ((TODAY.month, TODAY.day) < (mo, d))
                p = dict(name=pool[g][e]["name"] if in_pool else name, ca=pid)
                if e:
                    p["espn"] = e
                p["country"] = country
                if age is not None:
                    p["age"] = age
                p["apps"] = apps
                if keeper:
                    p["keeper"] = True
                p["hand"] = "left" if (hand or "").lower().startswith("left") else "right"
                if not in_pool:
                    mr = model_row(pid)
                    # role: model's role when available, else from bowling / batting use
                    bowled = (0, bowled_matches.get(pid, 0))
                    if mr and mr["player_role"]:
                        role = {"batter": "batsman"}.get(mr["player_role"], mr["player_role"])
                    else:
                        role = "all-rounder" if bowled[1] >= 3 and apps >= 3 else ("bowler" if bowled[1] >= 3 else "batsman")
                    p["role"] = role
                    bs = bowling_style(style)
                    if bs == "unknown" and role in ("bowler", "all-rounder"):
                        bs = "right-arm-medium"
                    p["bowl"] = bs
                    p["fb"] = fallback_ratings(coefs, g, mr, role)
                    p["fbSource"] = "model" if mr else "default"
                players.append(p)
            teams_out.append(dict(teamId=tid, caTeam=t[7], players=players))
            rep_teams[tid] = dict(name=t[1], squad=len(players), matched=matched, generated=len(players) - matched,
                                  overseas=sum(overseas(p["country"]) for p in players), skippedByLimits=skipped,
                                  candidates=len(plist))
        out_rosters[lg["id"]] = dict(season=lg["season"], source=lg["ca_event"], teams=teams_out)
        tot = sum(v["squad"] for v in rep_teams.values())
        mt = sum(v["matched"] for v in rep_teams.values())
        report[lg["id"]] = dict(name=lg["name"], season=lg["season"], players=tot, matched=mt, generated=tot - mt, teams=rep_teams,
                                observedOverseasInXI={str(k): v for k, v in sorted(counts.items())})
        print("  overseas per XI (count: team-matches):", dict(sorted(counts.items())), file=sys.stderr)
        print(f"{lg['id']:10} {lg['season']:8} players {tot:4}  matched {mt:4} ({100 * mt / tot:.0f}%)  generated {tot - mt:3}", file=sys.stderr)

    write_rosters(out_rosters)
    write_defs()
    OUT_REPORT.write_text(json.dumps(report, indent=1))
    print("wrote", OUT_ROSTERS, OUT_DEFS, OUT_REPORT, file=sys.stderr)


def write_rosters(out):
    lines = [
        "/**",
        " * GENERATED by packages/ratings/src/analysis/build-league-rosters.py. Do not edit by hand.",
        " *",
        " * Squads for the extra T20 leagues (BBL, WBBL, PSL, SA20, The Hundred, CPL, ILT20, MLC, BPL, LPL): each team's",
        " * players from the league's most recent complete season in the CricketArchive scorecards (data/cricket.db),",
        " * ranked by appearances and trimmed to the league's squad size and overseas limits.",
        " *",
        " * Players are matched to the game pool by Cricinfo id (`espn_<id>`, see league-players.ts). `ca` is the",
        " * CricketArchive id (`ca_<id>` in the full CricketArchive pool). Entries with `fb` were not in the pool at",
        " * generation time: `fb` is a fallback rating (battingIQ, timing, power, running, wicketTaking, economy,",
        " * accuracy, clutch) regressed from the ratings model, used only if neither the pool nor the CA pool has them.",
        " */",
        "",
        'import type { LeagueRosters } from "./league-players.js";',
        "",
        "export const LEAGUE_ROSTERS: Record<string, LeagueRosters> = {",
    ]
    for lid, lr in out.items():
        lines.append(f'  "{lid}": {{ season: "{lr["season"]}", source: {json.dumps(lr["source"])}, teams: [')
        for t in lr["teams"]:
            lines.append(f'    {{ teamId: "{t["teamId"]}", caTeam: {json.dumps(t["caTeam"])}, players: [')
            for p in t["players"]:
                lines.append("      " + json.dumps(p, ensure_ascii=False) + ",")
            lines.append("    ] },")
        lines.append("  ] },")
    lines.append("};")
    lines.append("")
    OUT_ROSTERS.write_text("\n".join(lines))


def write_defs():
    leagues = []
    for lg in LEAGUES:
        rules = dict(lg["rules"])
        rules.pop("salaryCap", None)
        leagues.append(dict(
            id=lg["id"], name=lg["name"], short=lg["short"], competition=lg["competition"], gender=lg["gender"], homeCountry=lg["homeCountry"],
            season=lg["season"], rules=rules,
            teams=[dict(id=team_id(lg["id"], t[0]), shortName=t[0], name=t[1], city=t[2], primaryColor=t[3], secondaryColor=t[4], stadiumName=t[5])
                   for t in lg["teams"]]))
    lines = [
        "/**",
        " * GENERATED by packages/ratings/src/analysis/build-league-rosters.py from league_defs.py. Do not edit by hand.",
        " * Teams and rules of the extra T20 leagues; see leagues.ts and docs/LEAGUES.md.",
        " */",
        "",
        'import type { LeagueDefData } from "./leagues.js";',
        "",
        "export const LEAGUE_DEFS: LeagueDefData[] = " + json.dumps(leagues, indent=2, ensure_ascii=False) + ";",
        "",
    ]
    OUT_DEFS.write_text("\n".join(lines))


if __name__ == "__main__":
    main()
