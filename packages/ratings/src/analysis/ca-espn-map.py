"""
Map ESPNcricinfo players (the game's pool, data/scraped/espn-players.json) to CricketArchive ids.

1. Cricsheet's people.csv register (key_cricinfo <-> key_cricketarchive) where it has both.
2. Otherwise: same date of birth AND compatible names (same surname token, and the same first-name
   initial or a shared full given name). A DOB with several compatible CA players is left unmatched.
Output: data/analysis/ca_espn_map.csv  (espn_id, ca_id, method)
Run from packages/ratings:  python3 -I src/analysis/ca-espn-map.py
"""
import csv, json, re, subprocess, sys, unicodedata
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def norm_tokens(name):
    s = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z\s-]", " ", s).replace("-", " ")
    return [t for t in s.split() if t]


def compatible(espn_names, ca_names):
    for en in espn_names:
        et = norm_tokens(en)
        if not et:
            continue
        for cn in ca_names:
            ct = norm_tokens(cn)
            if not ct:
                continue
            if et[-1] != ct[-1] and et[-1] not in ct and ct[-1] not in et:
                continue
            egiven, cgiven = set(et[:-1]), set(ct[:-1])
            if egiven & cgiven:
                return True
            if et[0][0] == ct[0][0]:
                return True
    return False


def main():
    out = subprocess.run(["duckdb", "-csv", "-nullvalue", "", "-c",
                          "LOAD sqlite; ATTACH 'data/cricket.db' AS c (TYPE sqlite, READ_ONLY); "
                          "SELECT id, name, full_name, dob FROM c.players WHERE dob IS NOT NULL AND dob <> ''"],
                         capture_output=True, text=True, cwd=ROOT)
    if out.returncode:
        sys.exit(out.stderr)
    by_dob = defaultdict(list)
    for r in csv.DictReader(out.stdout.splitlines()):
        by_dob[r["dob"]].append(r)
    register = {}
    with open(ROOT / "data" / "cricsheet" / "people.csv", newline="") as f:
        for r in csv.DictReader(f):
            ca = r.get("key_cricketarchive")
            for k in ("key_cricinfo", "key_cricinfo_2", "key_cricinfo_3"):
                if r.get(k) and ca:
                    register[int(r[k])] = int(ca)
    players = json.load(open(ROOT / "data" / "scraped" / "espn-players.json"))
    rows, n_reg, n_dob, n_amb, n_none = [], 0, 0, 0, 0
    for p in players:
        prof = p["profile"]
        eid = int(prof["espnId"])
        if eid in register:
            rows.append((eid, register[eid], "register")); n_reg += 1
            continue
        d = prof.get("dateOfBirth") or {}
        if not (d.get("year") and d.get("month") and d.get("date")):
            n_none += 1
            continue
        dob = f"{int(d['year']):04d}-{int(d['month']):02d}-{int(d['date']):02d}"
        names = [prof.get("longName"), prof.get("name"), prof.get("fullName")]
        cands = [c for c in by_dob.get(dob, []) if compatible(names, [c["name"], c["full_name"]])]
        if len(cands) == 1:
            rows.append((eid, int(cands[0]["id"]), "dob+name")); n_dob += 1
        elif len(cands) > 1:
            n_amb += 1
        else:
            n_none += 1
    with open(ROOT / "data" / "analysis" / "ca_espn_map.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["espn_id", "ca_id", "method"])
        w.writerows(rows)
    print(f"ESPN players {len(players)}: register {n_reg}, dob+name {n_dob}, ambiguous {n_amb}, unmatched {n_none}")


if __name__ == "__main__":
    main()
