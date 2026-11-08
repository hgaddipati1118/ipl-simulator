"""
Each player's Test profile for the Test engine (docs/FORMATS.md, Test section 3.2). It holds where he usually bats and how much
he bowls in first-class cricket (Tests first), whether he keeps wicket, and how regularly he plays his country's recent
Tests. Written as a generated engine table, packages/engine/src/test-profile-data.ts. The engine orders a Test XI by the
usual position, takes a player into the attack on his bowling workload rather than his T20 role (a T20 "batsman" can be a
Test spinner), designates one keeper on the keeping record, and picks the regulars of the country's recent Tests first.

Inputs:
  data/analysis/ca_cells.parquet          CricketArchive, per player, competition and season: batting innings with the mean
                                          batting position, balls bowled
  data/analysis/fielding_ca_keepers.csv   CricketArchive, per player and format: matches, matches keeping wicket
  data/analysis/ca_espn_map.csv           CricketArchive id -> ESPN id
  data/analysis/game_players.json         the game's players (ESPN ids)
  ../app/public/pool/ca-*-senior.json.gz  the extended pool's senior players (CricketArchive ids, `ca_<id>`): those who have
                                          played their country's recent Tests get a profile too
  data/analysis/venue_map.csv             venue -> country (the host of each real Test, for the evaluation fixture)
  data/cricsheet/people.csv               Cricsheet register (Cricsheet id -> ESPN and CricketArchive ids)
  $CRICSHEET_TEST_JSON_DIR                raw Cricsheet Test JSON (the line-ups). Default packages/ratings/data/cricsheet/tests_json.
                                          To create it: download https://cricsheet.org/downloads/tests_json.zip and unzip into an
                                          empty directory. Files are untrusted and only json.load-ed.

Per player, from first-class cells (Tests are the class "intl_full"), the first window with enough innings:
  Tests in the last six seasons, all first-class cricket in the last six, Tests ever, first-class cricket ever.
  position = the innings-weighted mean batting position (6 innings at least; 4 for the last window)
  workload = balls bowled per innings in the field (innings batted or bowled in, whichever is more):
             2 = front-line (36+ balls, six overs), 1 = part-time (6+), 0 = does not bowl
Keeping: the share of his first-class matches in which he kept wicket (5 matches at least).
Recency, from the Cricsheet line-ups of his country's last 15 Tests (men and women separately; most recent first, each one
counting 0.85 of the one after it): his weighted share of those Tests, and how many of them have been played since his last.

It also writes the evaluation fixture packages/app/src/__tests__/fixtures/test-recent-xis.json: each country's last 5 real
Test XIs (each player as "espn_<id>|ca_<id>", whichever ids he has; date, host country), which the app's auto Test XIs are
compared with.

Needs the `duckdb` CLI on PATH. Run from packages/ratings:
  CRICSHEET_TEST_JSON_DIR=/path/to/tests_json python3 -I src/analysis/test-player-profiles.py
  SHOW="Name,Name" prints those players' evidence. HOLDOUT=5 leaves each country's last 5 Tests out of the recency (an
  out-of-sample check of the picker against those Tests; do not commit its output).
"""
import csv
import gzip
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "analysis"
OUT_TS = ROOT.parent / "engine" / "src" / "test-profile-data.ts"
OUT_XIS = ROOT.parent / "app" / "src" / "__tests__" / "fixtures" / "test-recent-xis.json"
TESTS_JSON = Path(os.environ.get("CRICSHEET_TEST_JSON_DIR", str(ROOT / "data" / "cricsheet" / "tests_json")))
HOLDOUT = int(os.environ.get("HOLDOUT", "0"))
POOL = ROOT.parent / "app" / "public" / "pool"

RECENT = 6           # seasons counted as recent (up to the latest season in the data)
MIN_INNS = 6         # innings a window needs (MIN_LAST for the last one)
MIN_LAST = 4
FRONT_LINE = 36      # balls per innings in the field (six overs)
PART_TIME = 6
KEEP_MIN = 5         # first-class matches for a keeping share
LAST = 15            # the country's recent Tests for the recency share
DECAY = 0.85         # weight of each Test relative to the one after it
EVAL = 5             # real XIs per country in the evaluation fixture


def duck(sql):
    p = subprocess.run(["duckdb", "-json", "-c", sql], capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"duckdb failed: {p.stderr}\n{sql[:600]}")
    return json.loads(p.stdout) if p.stdout.strip() else []


def register_ids():
    """Cricsheet register id -> (ESPN id, CricketArchive id), either None when the register has none"""
    out = {}
    with open(ROOT / "data" / "cricsheet" / "people.csv", newline="") as f:
        for row in csv.DictReader(f):
            def first(keys):
                for k in keys:
                    v = (row.get(k) or "").strip()
                    if v.isdigit():
                        return int(v)
                return None
            out[row["identifier"]] = (first(("key_cricinfo", "key_cricinfo_2", "key_cricinfo_3")),
                                      first(("key_cricketarchive", "key_cricketarchive_2")))
    return out


# Cricket West Indies' territories: their players play for West Indies
WI_TERRITORIES = {"Jamaica", "Barbados", "Guyana", "Trinidad", "Trinidad and Tobago", "Tobago", "Antigua", "St Kitts", "Nevis",
                  "Montserrat", "Anguilla", "St Vincent", "St Lucia", "Grenada", "Dominica", "St Maarten", "British Virgin Islands"}


def extended_senior():
    """The extended pool's senior players: CricketArchive id -> (name, country) (gzip JSON shards, rows [id, name, age, country#, ...])"""
    out = {}
    for f in sorted(POOL.glob("ca-*-senior.json.gz")):
        shard = json.loads(gzip.decompress(f.read_bytes()))
        countries = shard.get("countries", [])
        for r in shard.get("rows", []):
            c = countries[r[3]] if isinstance(r[3], int) and r[3] < len(countries) else ""
            out[int(r[0])] = (str(r[1]), "West Indies" if c in WI_TERRITORIES else c)
    return out


def name_matcher(extended):
    """Match a Cricsheet name ("T Chanderpaul", "Azan Awais") to one extended-pool player of the same country: the same surname
    and first initial, accepted only when exactly one player fits"""
    idx = {}
    for ca, (name, country) in extended.items():
        parts = name.split()
        if parts:
            idx.setdefault((country, parts[-1].lower()), []).append((ca, name))

    def match(cricsheet_name, country):
        parts = cricsheet_name.split()
        if not parts:
            return None
        cands = idx.get((country, parts[-1].lower()), [])
        full = [ca for ca, n in cands if n.lower() == cricsheet_name.lower()]
        if len(full) == 1:
            return full[0]
        first = parts[0][0].lower() if len(parts) > 1 else ""
        same = [ca for ca, n in cands if first and n.split()[0][0].lower() == first]
        return same[0] if len(same) == 1 else None
    return match


def venue_countries():
    out = {}
    with open(DATA / "venue_map.csv", newline="") as f:
        for row in csv.DictReader(f):
            out.setdefault((row["raw_venue"] or "").strip(), row["country"])
    return out


def lineups(match=None):
    """Every Test's XIs from the Cricsheet JSON: per country (gender, team) its Tests in date order, each player as (ESPN id,
    CricketArchive id); `match(name, team)` finds a CricketArchive id the register lacks"""
    reg_ids = register_ids()
    venues = venue_countries()
    files = sorted(TESTS_JSON.glob("*.json"))
    if not files:
        raise SystemExit(f"no Cricsheet Test JSON in {TESTS_JSON} (set CRICSHEET_TEST_JSON_DIR)")
    by_country = {}
    for f in files:
        d = json.load(open(f))
        info = d.get("info") or {}
        if info.get("match_type") != "Test" or not info.get("dates"):
            continue
        reg = (info.get("registry") or {}).get("people") or {}
        venue = str(info.get("venue") or "")
        host = venues.get(venue) or venues.get(f"{venue}, {info.get('city')}")
        for team, names in (info.get("players") or {}).items():
            ids = []
            for n in names:
                espn, ca = reg_ids.get(reg.get(n), (None, None))
                if ca is None and match is not None:
                    ca = match(n, team)
                ids.append((espn, ca))
            by_country.setdefault((info.get("gender", "male"), team), []).append({
                "mid": f.stem, "date": str(info["dates"][0]), "venue": venue, "host": host,
                "opponent": next((t for t in info.get("teams", []) if t != team), None), "xi": [i for i in ids if i != (None, None)],
            })
    for tests in by_country.values():
        tests.sort(key=lambda t: (t["date"], t["mid"]))
    return by_country


def main():
    players = json.load(open(DATA / "game_players.json"))
    espn_names = {int(p["id"][5:]): p["name"] for p in players if p["id"].startswith("espn_") and p["id"][5:].isdigit()}
    ca_of_espn = {}
    with open(DATA / "ca_espn_map.csv", newline="") as f:
        for row in csv.DictReader(f):
            if row["espn_id"].isdigit() and row["ca_id"].isdigit():
                ca_of_espn.setdefault(int(row["espn_id"]), int(row["ca_id"]))
    extended_full = extended_senior()
    extended = {ca: name for ca, (name, _) in extended_full.items()}

    def key_of(ids):
        """The profile key of a line-up player: his ESPN id when the game has him, else `ca_<id>` when the extended pool does
        (the CricketArchive id from the register, else from the ESPN id through ca_espn_map.csv)"""
        espn, ca = ids
        if ca is None and espn is not None:
            ca = ca_of_espn.get(espn)
        if espn in espn_names:
            return espn
        if ca in extended:
            return f"ca_{ca}"
        return None

    # recency: the weighted share of the country's last Tests and the Tests since the last one played
    match = name_matcher(extended_full)

    def resolve(name, team):
        return match(name, team)
    countries = lineups(resolve)
    share, since = {}, {}
    for key, tests in countries.items():
        recent = (tests[:-HOLDOUT] if HOLDOUT else tests)[-LAST:][::-1]
        total = sum(DECAY ** k for k in range(len(recent)))
        acc = {}
        for k, t in enumerate(recent):
            for ids in t["xi"]:
                e = key_of(ids)
                if e is None:
                    continue
                acc[e] = acc.get(e, 0) + DECAY ** k
                since[e] = min(since.get(e, 99), k)
        for e, w in acc.items():
            share[e] = max(share.get(e, 0), w / total)

    # profile keys: every game player, and the extended pool's players who have played their country's recent Tests
    ca_of = {e: ca_of_espn.get(e) for e in espn_names}
    ca_of.update({k: int(k[3:]) for k in share if isinstance(k, str)})
    names = {**espn_names, **{k: extended[int(k[3:])] for k in share if isinstance(k, str)}}

    keep_ca = {int(x["c"]): float(x["kept"]) / float(x["m"]) for x in duck(f"""
SELECT ca_id c, sum(matches) m, sum(keeper_matches) kept FROM read_csv_auto('{DATA / "fielding_ca_keepers.csv"}')
WHERE fmt = 'FC' GROUP BY 1 HAVING sum(matches) >= {KEEP_MIN}""")}
    rows = duck(f"""
WITH fc AS (SELECT c.player_id ca, c.side, c.comp_class = 'intl_full' AS test, c.year, c.inns, c.balls, c.mean_position
       FROM '{DATA / "ca_cells.parquet"}' c WHERE c.format = 'FC'),
lim AS (SELECT max(year) - {RECENT - 1} y FROM fc)
SELECT ca, CAST(test AS INT) test, CAST(year >= (SELECT y FROM lim) AS INT) recent,
  sum(CASE WHEN side = 'bat' THEN inns ELSE 0 END) bat_inns,
  sum(CASE WHEN side = 'bat' THEN mean_position * inns ELSE 0 END) pos_sum,
  sum(CASE WHEN side = 'bowl' THEN inns ELSE 0 END) bowl_inns,
  sum(CASE WHEN side = 'bowl' THEN balls ELSE 0 END) balls_bowled
FROM fc GROUP BY ALL""")
    by_ca = {}
    for x in rows:
        by_ca.setdefault(int(x["ca"]), []).append(x)
    cells = {k: by_ca[c] for k, c in ca_of.items() if c is not None and c in by_ca}
    keep = {k: keep_ca[c] for k, c in ca_of.items() if c is not None and c in keep_ca}

    def window(xs, test, recent):
        sel = [x for x in xs if (not test or int(x["test"]) == 1) and (not recent or int(x["recent"]) == 1)]
        bat = sum(int(x["bat_inns"]) for x in sel)
        bowl = sum(int(x["bowl_inns"]) for x in sel)
        return {"bat": bat, "pos": sum(float(x["pos_sum"] or 0) for x in sel) / bat if bat else None,
                "field": max(bat, bowl), "balls": sum(float(x["balls_bowled"] or 0) for x in sel)}

    out = {}
    show = {s.strip() for s in os.environ.get("SHOW", "").split(",") if s.strip()}
    # ESPN ids in number order, then the extended pool's `ca_<id>`
    order = lambda k: (isinstance(k, str), k if isinstance(k, int) else int(k[3:]))
    for e in sorted(set(cells) | set(keep) | set(share), key=order):
        xs = cells.get(e, [])
        wins = [window(xs, True, True), window(xs, False, True), window(xs, True, False), window(xs, False, False)]
        pos = next((w["pos"] for i, w in enumerate(wins) if w["pos"] is not None and w["bat"] >= (MIN_LAST if i == 3 else MIN_INNS)), None)
        load = next((w["balls"] / w["field"] for i, w in enumerate(wins) if w["field"] >= (MIN_LAST if i == 3 else MIN_INNS)), None)
        bowl = None if load is None else 2 if load >= FRONT_LINE else 1 if load >= PART_TIME else 0
        kp = keep.get(e)
        out[e] = (round(pos * 10) if pos is not None else 0, "-" if bowl is None else bowl, "-" if kp is None else round(kp * 10),
                  round(share.get(e, 0) * 100), "-" if e not in since else since[e])
        if names[e] in show:
            print(names[e], e, [(w["bat"], None if w["pos"] is None else round(w["pos"], 1), w["field"], round(w["balls"] / w["field"], 1) if w["field"] else None) for w in wins],
                  "keep", kp, "share", round(share.get(e, 0), 2), "since", since.get(e), "->", out[e], file=sys.stderr)

    # "espn id, position x 10 (0 unknown), workload (2 front-line, 1 part-time, 0 none, - unknown), keeping share x 10 (- unknown),
    # recent Tests share % , Tests since his last (- none of the last 15)" joined by ";"
    def fields(e, rec):
        vals = [str(v) for v in (e, *rec)]
        # trailing defaults left off: "-" for since, 0 for the share, "-" for keeping, "-" for workload
        for default in ("-", "0", "-", "-"):
            if len(vals) > 3 and vals[-1] == default:
                vals.pop()
            else:
                break
        return ",".join(vals)
    body = ";".join(fields(e, rec) for e, rec in sorted(out.items(), key=lambda kv: order(kv[0])))
    extended_n = sum(1 for e in out if isinstance(e, str))
    front = sum(1 for r in out.values() if r[1] == 2)
    regulars = sum(1 for r in out.values() if r[3] >= 50)
    OUT_TS.write_text(f"""// GENERATED by packages/ratings/src/analysis/test-player-profiles.py from CricketArchive first-class cells and the Cricsheet
// Test line-ups. Do not edit.
/**
 * Test profiles (docs/FORMATS.md, Test section 3.2): per ESPN id (an extended-pool player: "ca_<CricketArchive id>"), joined by ";":
 *   the usual first-class batting position (x 10, Tests first, the last {RECENT} seasons first; 0 = unknown),
 *   the bowling workload (2 = front-line, {FRONT_LINE}+ balls an innings in the field; 1 = part-time; 0 = does not bowl; "-" = unknown),
 *   the share of his first-class matches keeping wicket (x 10; "-" = unknown),
 *   his weighted share of his country's last {LAST} Tests (percent; each Test {DECAY} of the one after it),
 *   the country's Tests since his last one ("-" = none of the last {LAST}).
 * {len(out)} players ({extended_n} from the extended pool), {front} front-line bowlers, {regulars} regulars (50%+ of the recent Tests){f", recency without each country's last {HOLDOUT} Tests" if HOLDOUT else ""}.
 */
export const TEST_PROFILE_DATA = "{body}";
""")
    print(f"wrote {OUT_TS}: {len(out)} profiles ({extended_n} extended, {front} front-line bowlers, {regulars} regulars), {len(body) // 1024} KB", file=sys.stderr)

    if not HOLDOUT:
        fixture = {"source": "test-player-profiles.py: each country's last 5 Tests in the Cricsheet line-ups", "countries": []}
        for (gender, team), tests in sorted(countries.items()):
            last = tests[-EVAL:]
            if len(last) < EVAL or last[-1]["date"] < "2023":
                continue
            fixture["countries"].append({"team": team, "gender": gender, "tests": [
                {"date": t["date"], "host": t["host"], "opponent": t["opponent"],
                 "xi": ["|".join(x for x in (f"espn_{e}" if e else "", f"ca_{c}" if c else "") if x) for e, c in t["xi"]]} for t in last]})
        OUT_XIS.parent.mkdir(parents=True, exist_ok=True)
        OUT_XIS.write_text(json.dumps(fixture, indent=1) + "\n")
        print(f"wrote {OUT_XIS}: {len(fixture['countries'])} countries", file=sys.stderr)


if __name__ == "__main__":
    main()
