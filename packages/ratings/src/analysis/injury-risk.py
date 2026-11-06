#!/usr/bin/env python3
"""
Injury likelihood by archetype and age, from CricketArchive scorecards (senior cricket, 1998+).

There is no injury register, so every absence is classified by how sure we can be it was an injury:

  confirmed   in-match evidence on the card for match i: "retired hurt" / "absent hurt" / "retired ill" /
              "absent ill"; a scorecard note naming him as replaced by a concussion/injury substitute; or an
              IPL/WPL replacement signing that names him as the replaced player (with an injury reason).
  likely      he was a regular (played match i and >= 2 of the team's previous 3 matches that season), then
              missed >= 2 consecutive team matches, did NOT play any other match anywhere in that window (rules
              out international duty / other leagues), came back to the same team (in-season, or in a later
              season for long layoffs) and so did not retire / get permanently dropped, and his form going into
              the gap was not poor vs his own career (or his archetype's, if < 10 matches) (rules out dropped).
  unknown     any other in-season absence of a regular that isn't explained by playing elsewhere: single-match
              misses (rest / rotation / tactical), absences after poor form, absences that run into the end of
              the season, or players who never play again.
  elsewhere   absence explained by playing another match in the window (excluded; not an absence).

Main results use confirmed + likely ("injury absence"). Bounds: confirmed only (low), + all unknown (high).

Unit of exposure: one appearance by a player who is a regular for that team and has another team match later in
the same season. Event: an injury absence that starts right after that appearance.

Run from packages/ratings:  python3 -I src/analysis/injury-risk.py
Outputs (data/analysis/): injury_spells.parquet, injury_rates.csv, injury_model.json, injury-risk-report.md
         and data-export/injury-risk.json (engine-ready table; committed).
Needs: data/cricket.db, data/scorecards/scorecards.jsonl (notes), data/external-rankings/ipl_auction_retention_prices.csv,
       duckdb CLI (parquet output only). Stdlib otherwise.
"""
import csv, datetime as dt, json, math, os, re, sqlite3, subprocess, sys, time
from array import array
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
OUT = DATA / "analysis"
EXPORT = ROOT / "data-export"
TMP = Path(os.environ.get("TMPDIR", "/tmp")) / "injury-risk"
TMP.mkdir(parents=True, exist_ok=True)
EXPORT.mkdir(parents=True, exist_ok=True)

START = "1998-01-01"
SEASON_GAP = 45        # days between a team's matches that ends its season
EXIT_DAYS = 400        # (unused) earlier exit window; exit now = never plays senior cricket again
INJURY_DISMISSALS = {"retired hurt": "hurt", "absent hurt": "hurt", "retired ill": "ill", "absent ill": "ill"}
AGE_BANDS = [(0, 22.999, "<=22"), (23, 26.999, "23-26"), (27, 30.999, "27-30"), (31, 33.999, "31-33"), (34, 99, "34+")]
ARCHETYPES = ["batter", "wicketkeeper", "batting all-rounder", "bowling all-rounder",
              "express/fast", "fast-medium", "medium", "finger spin", "wrist spin", "bowler (style unknown)"]
BOWL_THR = {"T20": 12, "LA": 24, "FC": 60}       # balls per match to count as a frontline bowler
BAT_RUNS_AR = {"T20": 12, "LA": 20, "FC": 30}    # runs per match for a bowler to count as a bowling all-rounder

t0 = time.time()
def log(*a):
    print(f"[{time.time() - t0:6.0f}s]", *a, flush=True)

def day(s):
    try:
        return dt.date.fromisoformat(s[:10]).toordinal()
    except Exception:
        return None

def fmt_of(levels):
    if "Twenty20" in levels: return "T20"
    if "List A" in levels: return "LA"
    if "First-Class" in levels: return "FC"
    return None

def age_band(age):
    if age is None: return "unk"
    for lo, hi, b in AGE_BANDS:
        if lo <= age <= hi: return b
    return "unk"

def era_of(year):
    return "1998-2009" if year <= 2009 else ("2010-2017" if year <= 2017 else "2018-2026")

def balls_of(overs, balls):
    if balls: return balls
    if not overs: return 0
    try:
        o = str(overs)
        if "." in o:
            a, b = o.split(".", 1)
            return int(a) * 6 + int(b or 0)
        return int(float(o)) * 6
    except Exception:
        return 0

def bowl_type(style):
    s = (style or "").lower().split(",")[0]
    if not s.strip() or "unknown style" in s or s.strip() in ("underarm",): return None
    if "googly" in s or "leg-break" in s or "wrist" in s or "chinaman" in s: return "wrist spin"
    if "off-break" in s or "orthodox" in s or re.search(r"\bslow\b", s) and "medium" not in s: return "finger spin"
    if "fast-medium" in s or "medium-fast" in s: return "fast-medium"
    if "fast" in s: return "express/fast"
    if "medium" in s: return "medium"
    return None

# ── 1. Load senior matches and per-player match lines ─────────────────────
db = sqlite3.connect(f"file:{DATA / 'cricket.db'}?mode=ro", uri=True)
db.execute("PRAGMA temp_store=FILE")
os.environ.setdefault("SQLITE_TMPDIR", str(TMP))

matches = {}   # id -> (day, fmt, gender, event, intl, year)
for mid, date, levels, event, lists in db.execute(
        "SELECT id, date, levels, event, lists FROM matches WHERE date >= ?", (START,)):
    f = fmt_of(levels or "")
    d = day(date or "")
    if not f or d is None: continue
    gender = "female" if "Women's" in (levels or "") else "male"
    lv = (levels or "") + (lists or "")
    intl = any(k in lv for k in ("Test", "ODI", "International Twenty20"))
    matches[mid] = (d, f, gender, event or "", intl, dt.date.fromordinal(d).year)
log("senior matches", len(matches))

# line[(mid, pid)] = [team_id, runs, wickets, balls_bowled, keeper, injury_flag, card_name]
line = {}
for mid, tid, pid, name, keeper, dismissal, runs in db.execute(
        "SELECT match_id, team_id, player_id, player_name, keeper, dismissal, runs FROM batting"):
    if mid not in matches or pid is None: continue
    k = (mid, pid)
    L = line.get(k)
    if L is None:
        L = line[k] = [tid, 0, 0, 0, 0, None, name]
    L[1] += runs or 0
    if keeper: L[4] = 1
    inj = INJURY_DISMISSALS.get((dismissal or "").strip().lower())
    if inj: L[5] = inj
for mid, tid, pid, name, overs, balls, wkts in db.execute(
        "SELECT match_id, team_id, player_id, player_name, overs, balls, wickets FROM bowling"):
    if mid not in matches or pid is None: continue
    k = (mid, pid)
    L = line.get(k)
    if L is None:
        L = line[k] = [tid, 0, 0, 0, 0, None, name]
    L[2] += wkts or 0
    L[3] += balls_of(overs, balls)
log("player-match lines", len(line))

# All appearances at any level (incl. minor cricket) for the "playing elsewhere" check
anyday = defaultdict(lambda: array("i"))
for pid, date in db.execute(
        "SELECT DISTINCT b.player_id, m.date FROM batting b JOIN matches m ON m.id = b.match_id WHERE m.date >= ? "
        "UNION SELECT DISTINCT w.player_id, m.date FROM bowling w JOIN matches m ON m.id = w.match_id WHERE m.date >= ?",
        (START, START)):
    d = day(date or "")
    if pid is not None and d is not None: anyday[pid].append(d)
for pid in anyday:
    anyday[pid] = array("i", sorted(set(anyday[pid])))
log("players with any appearance", len(anyday))

players = {}
for pid, name, full, dob, style in db.execute("SELECT id, name, full_name, dob, bowling_style FROM players"):
    players[pid] = (name, full, day(dob or "") if dob else None, style)

# ── 2. Confirmed evidence: substitutes in notes, IPL/WPL replacements ──────
sub_re = re.compile(r"full substitute:\s*(.+?)\s+for\s+(.+?)\s*\((?:after|before)[^)]*\)\s*\(([^)]*)\)", re.I)
match_names = defaultdict(dict)   # mid -> {card name lower: pid}
for (mid, pid), L in line.items():
    if L[6]: match_names[mid][L[6].lower()] = pid
sub_evidence = {}  # (mid, pid) -> reason
n_sub_notes = Counter()
with open(DATA / "scorecards" / "scorecards.jsonl", "rb") as fh:
    for raw in fh:
        if b"substitute" not in raw: continue
        try:
            o = json.loads(raw)
        except Exception:
            continue
        mid = o.get("id")
        if mid not in matches: continue
        for note in o.get("notes") or []:
            m = sub_re.search(note)
            if not m: continue
            reason = m.group(3).strip().lower()
            n_sub_notes[reason] += 1
            if not any(w in reason for w in ("concussion", "injur", "medical", "ill")): continue
            replaced = m.group(2).strip().lower()
            pid = match_names[mid].get(replaced)
            if pid is None:  # fall back to surname match within the match
                sur = replaced.split()[-1]
                cands = [p for nm, p in match_names[mid].items() if nm.split()[-1] == sur]
                pid = cands[0] if len(cands) == 1 else None
            if pid is not None:
                sub_evidence[(mid, pid)] = "concussion" if "concussion" in reason else "injury"
log("substitute notes by reason", dict(n_sub_notes.most_common(8)), "| linked injury/concussion subs", len(sub_evidence))

# IPL/WPL replacement signings: "replaced <Name> | <reason>"
repl = []  # (season, replaced name, reason, injury?)
rep_file = DATA / "external-rankings" / "ipl_auction_retention_prices.csv"
if rep_file.exists():
    for r in csv.DictReader(open(rep_file)):
        if r.get("acquisition_type") != "replacement": continue
        m = re.search(r"replaced\s+([^|]+?)\s*(?:\||$)(.*)", r.get("set_or_notes") or "", re.I)
        if not m: continue
        reason = m.group(2).strip()
        injury = bool(re.search(r"injur|surgery|fracture|strain|tear|stress|hamstring|back|knee|ankle|shoulder|finger|concussion|ruled out|fitness", reason, re.I))
        repl.append((int(r["season"]), m.group(1).strip(), reason, injury, r["league"]))
log("IPL replacement rows with a named replaced player", len(repl), "| injury-coded", sum(1 for x in repl if x[3]))

# ── 4. Archetypes ─────────────────────────────────────────────────────────
agg = defaultdict(lambda: [0, 0, 0, 0])   # (pid, fmt) -> apps, balls, runs, keeper apps
for (mid, pid), L in line.items():
    a = agg[(pid, matches[mid][1])]
    a[0] += 1; a[1] += L[3]; a[2] += L[1]; a[3] += L[4]
def archetype(pid, f):
    a = agg.get((pid, f))
    if not a or a[0] < 5:
        # pool across formats, scaling balls/runs to this format's thresholds
        tot = [0, 0.0, 0.0, 0]
        for ff in ("T20", "LA", "FC"):
            b = agg.get((pid, ff))
            if b:
                tot[0] += b[0]; tot[1] += b[1] / BOWL_THR[ff] * BOWL_THR[f]; tot[2] += b[2] / BAT_RUNS_AR[ff] * BAT_RUNS_AR[f]; tot[3] += b[3]
        a = tot
    if a[0] == 0: return "batter"
    apps, balls, runs, kp = a
    bpm, rpm = balls / apps, runs / apps
    if kp / apps >= 0.3: return "wicketkeeper"
    style = bowl_type(players.get(pid, (None, None, None, None))[3])
    if bpm >= BOWL_THR[f]:
        if rpm >= BAT_RUNS_AR[f]: return "bowling all-rounder"
        return style or "bowler (style unknown)"
    if bpm >= BOWL_THR[f] / 3 and rpm >= BAT_RUNS_AR[f]: return "batting all-rounder"
    return "batter"
arch_cache = {}
def arch(pid, f):
    k = (pid, f)
    if k not in arch_cache: arch_cache[k] = archetype(pid, f)
    return arch_cache[k]

# ── 3. Team sequences and absence spells ──────────────────────────────────
seq = defaultdict(list)   # (team_id, fmt, gender) -> [(day, mid)]
team_players = defaultdict(set)
for (mid, pid), L in line.items():
    team_players[(mid, L[0])].add(pid)
for (mid, tid) in team_players:
    d, f, g = matches[mid][:3]
    seq[(tid, f, g)].append((d, mid))
for k in seq: seq[k].sort()
log("team sequences", len(seq))

def played_elsewhere(pid, lo, hi, team_days):
    """Any appearance strictly after lo and up to hi that isn't one of this team's match days."""
    a = anyday.get(pid)
    if not a: return False
    import bisect
    i = bisect.bisect_right(a, lo)
    while i < len(a) and a[i] <= hi:
        if a[i] not in team_days: return True
        i += 1
    return False

def next_senior_after(pid, d):
    a = anyday.get(pid)
    if not a: return None
    import bisect
    i = bisect.bisect_right(a, d)
    return a[i] if i < len(a) else None

# career contribution per player-format for the form check
contrib = defaultdict(list)
for (mid, pid), L in line.items():
    contrib[(pid, matches[mid][1])].append((matches[mid][0], L[1] + 20 * L[2]))
career_mean = {k: (sum(c for _, c in v) / len(v), len(v)) for k, v in contrib.items()}
_ref = defaultdict(lambda: [0.0, 0])
for (pid, f), (m_, n_) in career_mean.items():
    r = _ref[(arch(pid, f), f)]; r[0] += m_ * n_; r[1] += n_
arch_mean = {k: v[0] / v[1] for k, v in _ref.items() if v[1]}

spells = []   # dicts
regular_at = []  # exposures: (pid, mid, team_key, spell_idx or -1)
for key, ms in seq.items():
    tid, f, g = key
    days_set = set(d for d, _ in ms)
    present = [team_players[(mid, tid)] for _, mid in ms]
    n = len(ms)
    for i in range(n):
        d_i, mid_i = ms[i]
        if i + 1 >= n or ms[i + 1][0] - d_i > SEASON_GAP: continue   # no later team match this season
        for pid in present[i]:
            prev = 0
            j = i - 1; cnt = 0
            while j >= 0 and cnt < 3 and ms[j + 1][0] - ms[j][0] <= SEASON_GAP:
                if pid in present[j]: prev += 1
                cnt += 1; j -= 1
            if cnt < 3 or prev < 2: continue   # not (yet) a regular
            sp = -1
            if pid not in present[i + 1]:
                # absence spell: count the team's matches he misses this season
                k = i + 1; missed = 0; returned = False
                while k < n and ms[k][0] - ms[k - 1][0] <= SEASON_GAP:
                    if pid in present[k]:
                        returned = True; break
                    missed += 1; k += 1
                last_missed_day = ms[i + missed][0]
                # long layoff: ran past the team's season end; is he back with this team later (<= 3 years)?
                back_to_team = returned
                if not returned:
                    kk = i + missed + 1
                    while kk < n and ms[kk][0] - d_i <= 3 * 365:
                        if pid in present[kk]:
                            back_to_team = True; break
                        kk += 1
                L = line[(mid_i, pid)]
                inj_flag = L[5]
                sub = sub_evidence.get((mid_i, pid))
                elsewhere = played_elsewhere(pid, d_i, last_missed_day, days_set)
                nxt = next_senior_after(pid, d_i)
                exited = nxt is None   # never plays senior cricket again
                # form going in: last 3 team appearances vs career mean in format
                recent = [line[(ms[j][1], pid)][1] + 20 * line[(ms[j][1], pid)][2]
                          for j in range(max(0, i - 3), i + 1) if pid in present[j]][-3:]
                cm, cn = career_mean.get((pid, f), (0, 0))
                ref = cm if cn >= 10 else arch_mean.get((arch(pid, f), f), 0)
                poor = ref > 0 and (sum(recent) / len(recent)) < 0.5 * ref
                if inj_flag or sub:
                    cls = "confirmed"
                elif elsewhere:
                    cls = "elsewhere"
                elif missed >= 2 and back_to_team and not exited and not poor:
                    cls = "likely"
                else:
                    cls = "unknown"
                if inj_flag: why = "in-match " + inj_flag
                elif sub: why = "substitute: " + sub
                elif elsewhere: why = "played elsewhere"
                elif cls == "likely": why = "missed>=2, back with team (in season)" if returned else "long layoff, back with team later"
                elif missed < 2: why = "single-match miss"
                elif exited: why = "career exit"
                elif poor: why = "poor form before"
                elif not back_to_team: why = "never back with this team"
                else: why = "other"
                sp = len(spells)
                spells.append(dict(player_id=pid, match_id=mid_i, team_id=tid, format=f, gender=g, day=d_i,
                                   year=matches[mid_i][5], matches_missed=missed, returned_in_season=returned,
                                   evidence=cls, reason=why, injury_kind=(inj_flag or sub or "")))
            elif line[(mid_i, pid)][5] or sub_evidence.get((mid_i, pid)):
                # injured in-match but did not miss the next match: record, not an absence
                L = line[(mid_i, pid)]
                sp = len(spells)
                spells.append(dict(player_id=pid, match_id=mid_i, team_id=tid, format=f, gender=g, day=d_i,
                                   year=matches[mid_i][5], matches_missed=0, returned_in_season=True,
                                   evidence="confirmed_no_time_missed",
                                   reason="in-match " + (L[5] or "substitute"), injury_kind=(L[5] or sub_evidence.get((mid_i, pid)))))
            regular_at.append((pid, mid_i, key, sp))
log("exposures", len(regular_at), "| spells", len(spells), Counter(s["evidence"] for s in spells))

# IPL replacements -> confirm matching IPL spells (same season) for the replaced player
ipl_names = {}
for s in spells:
    if s["format"] == "T20" and "indian premier league" in matches[s["match_id"]][3].lower() or "women's premier league" in matches[s["match_id"]][3].lower():
        p = players.get(s["player_id"])
        if p:
            for nm in {p[0], p[1]}:
                if nm: ipl_names.setdefault((s["year"], nm.lower()), []).append(s)
repl_confirmed = repl_preseason = 0
for season, name, reason, injury, league in repl:
    if not injury: continue
    nm = name.lower()
    hits = ipl_names.get((season, nm), [])
    if not hits:  # try surname + first initial against card names
        sur = nm.split()[-1]
        hits = [s for (yr, n2), ss in ipl_names.items() if yr == season and n2.split()[-1] == sur and n2[:1] == nm[:1] for s in ss]
    hits = [s for s in hits if s["evidence"] in ("likely", "unknown")]
    if hits:
        for s in hits:
            s["evidence"] = "confirmed"; s["reason"] = f"IPL replacement: {reason[:60]}"; s["injury_kind"] = "replacement"
        repl_confirmed += 1
    else:
        repl_preseason += 1
log("IPL injury replacements: upgraded spells", repl_confirmed, "| no in-season spell (pre-season / not regular)", repl_preseason)

# ── 5. Exposure cells with covariates ─────────────────────────────────────
import bisect
# per-player senior (day, balls) for workload, all formats
work = defaultdict(list)
for (mid, pid), L in line.items():
    work[pid].append((matches[mid][0], L[3]))
for pid in work: work[pid].sort()
work_days = {pid: [d for d, _ in v] for pid, v in work.items()}
work_cum = {}
for pid, v in work.items():
    c = [0]
    for _, b in v: c.append(c[-1] + b)
    work_cum[pid] = c
def balls_window(pid, d, w):
    ds = work_days[pid]; c = work_cum[pid]
    hi = bisect.bisect_right(ds, d); lo = bisect.bisect_right(ds, d - w)
    return c[hi] - c[lo], hi - lo
MAIN = ("confirmed", "likely")
inj_days = defaultdict(list)
for s in spells:
    if s["evidence"] in MAIN: inj_days[s["player_id"]].append(s["day"])
for pid in inj_days: inj_days[pid].sort()
def prior_injuries(pid, d):
    a = inj_days.get(pid)
    if not a: return 0
    return bisect.bisect_left(a, d) - bisect.bisect_left(a, d - 730)

def wl_band(b30):
    return "0" if b30 == 0 else ("1-150" if b30 <= 150 else ("151-400" if b30 <= 400 else ("401-800" if b30 <= 800 else "800+")))
def dens_band(m14):
    return "1-2" if m14 <= 2 else ("3-4" if m14 <= 4 else "5+")

cells = defaultdict(lambda: [0, 0, 0, 0, 0])   # key -> n, conf, likely, unknown, balls bowled
ps_cells = defaultdict(Counter)                 # (pid, year, fmt) -> Counter(cellkey w/o year)
ps_event = Counter()
for pid, mid, key, sp in regular_at:
    d, f, g, ev, intl, yr = matches[mid]
    p = players.get(pid)
    age = (d - p[2]) / 365.2425 if p and p[2] else None
    b30, _ = balls_window(pid, d, 30)
    _, m14 = balls_window(pid, d, 14)
    b7, _ = balls_window(pid, d, 7)
    b28, _ = balls_window(pid, d, 28)
    if b28 < 60: spike = "low/none"
    else:
        acwr = b7 / (b28 / 4)
        spike = "<0.8" if acwr < 0.8 else ("0.8-1.3" if acwr <= 1.3 else ("1.3-1.6" if acwr <= 1.6 else ">1.6"))
    pri = min(prior_injuries(pid, d), 2)
    ck = (f, g, arch(pid, f), age_band(age), era_of(yr), wl_band(b30), dens_band(m14), str(pri) if pri < 2 else "2+", spike)
    c = cells[ck + (yr,)]
    c[0] += 1; c[4] += line[(mid, pid)][3]
    if sp >= 0:
        e = spells[sp]["evidence"]
        if e == "confirmed": c[1] += 1
        elif e == "likely": c[2] += 1
        elif e == "unknown": c[3] += 1
        if e in MAIN: ps_event[(pid, yr, f)] += 1
    ps_cells[(pid, yr, f)][ck] += 1
log("cells", len(cells))

# ── 6. Rates table ────────────────────────────────────────────────────────
def roll(keyfn):
    out = defaultdict(lambda: [0, 0, 0, 0, 0])
    for k, c in cells.items():
        kk = keyfn(k)
        if kk is None: continue
        o = out[kk]
        for j in range(5): o[j] += c[j]
    return out
rates = roll(lambda k: (k[0], k[1], k[2], k[3]))
with open(OUT / "injury_rates.csv", "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["format", "gender", "archetype", "age_band", "exposures", "confirmed", "likely", "unknown",
                "rate_per_100_main", "rate_per_100_low_confirmed", "rate_per_100_high_incl_unknown", "se_main",
                "per_1000_balls_main", "balls_bowled"])
    for (f, g, a, ab), c in sorted(rates.items()):
        n = c[0]
        if n < 50: continue
        main = c[1] + c[2]
        r = main / n
        w.writerow([f, g, a, ab, n, c[1], c[2], c[3], round(100 * r, 3), round(100 * c[1] / n, 3),
                    round(100 * (main + c[3]) / n, 3), round(100 * math.sqrt(max(r * (1 - r), 1e-9) / n), 3),
                    round(1000 * main / c[4], 3) if c[4] > 5000 else "", c[4]])
log("wrote injury_rates.csv")

# ── 7. Poisson GLM (log-linear, exposure offset) on aggregated cells ──────
FACTORS = [("format", 0, "T20"), ("gender", 1, "male"), ("archetype", 2, "batter"), ("age", 3, "27-30"),
           ("era", 4, "2018-2026"), ("wl30", 5, "0"), ("density14", 6, "1-2"), ("prior", 7, "0"), ("acwr", 8, "0.8-1.3")]
def design(train_filter):
    levels = {}
    agg2 = defaultdict(lambda: [0, 0])
    for k, c in cells.items():
        if not train_filter(k): continue
        if k[3] == "unk": continue
        kk = k[:9]
        agg2[kk][0] += c[0]; agg2[kk][1] += c[1] + c[2]
    for name, idx, ref in FACTORS:
        levels[name] = sorted({kk[idx] for kk in agg2} - {ref})
    cols = ["intercept"] + [f"{n}={l}" for n, idx, ref in FACTORS for l in levels[n]]
    rows = []
    for kk, (n, y) in agg2.items():
        x = [1.0] + [1.0 if kk[idx] == l else 0.0 for n_, idx, ref in FACTORS for l in levels[n_]]
        rows.append((x, n, y))
    return cols, rows, levels

def solve(A, b):
    n = len(b); M = [A[i][:] + [b[i]] for i in range(n)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        if abs(M[c][c]) < 1e-12: M[c][c] = 1e-12
        for r in range(n):
            if r != c:
                f = M[r][c] / M[c][c]
                if f:
                    for j in range(c, n + 1): M[r][j] -= f * M[c][j]
    return [M[i][n] / M[i][i] for i in range(n)]

def fit_poisson(rows, k, ridge=1.0, iters=40):
    """Poisson IRLS with log-exposure offset; rows = (x dense list, n, y). Sparse internally."""
    sp = [([i for i, xi in enumerate(x) if xi], n, y) for x, n, y in rows]
    beta = [0.0] * k
    tot_n = sum(n for _, n, _ in sp); tot_y = sum(y for _, _, y in sp)
    beta[0] = math.log(max(tot_y, 1) / tot_n)
    H = None
    for _ in range(iters):
        H = [[0.0] * k for _ in range(k)]; g = [0.0] * k
        for act, n, y in sp:
            eta = sum(beta[a] for a in act) + math.log(n)
            mu = math.exp(min(eta, 30))
            r = y - mu
            for a in act:
                g[a] += r
                Ha = H[a]
                for b2 in act: Ha[b2] += mu
        for a in range(1, k): H[a][a] += ridge; g[a] -= ridge * beta[a]
        step = solve(H, g)
        beta = [b + s_ for b, s_ in zip(beta, step)]
        if max(abs(s_) for s_ in step) < 1e-7: break
    cov_diag = [solve(H, [1.0 if i == j else 0.0 for i in range(k)])[j] for j in range(k)]
    return beta, cov_diag

cols, rows, levels = design(lambda k: True)
beta, cov = fit_poisson(rows, len(cols))
model = {c: dict(coef=b, rr=math.exp(b), se=(math.sqrt(v) if v and v > 0 else None)) for c, b, v in zip(cols, beta, cov or [None] * len(cols))}
log("full model fitted:", len(cols), "params,", len(rows), "cells")

# ── 8. Validation: train <= 2018, test 2019+ ──────────────────────────────
def predictor(beta_, cols_):
    idx = {c: i for i, c in enumerate(cols_)}
    def p(ck):
        if ck[3] == "unk": return None
        eta = beta_[0]
        for name, i, ref in FACTORS:
            c = f"{name}={ck[i]}"
            if c in idx: eta += beta_[idx[c]]
        return 1 - math.exp(-math.exp(eta))
    return p
def auc(scores):
    scores.sort(key=lambda t: t[0])
    pos = sum(1 for _, y in scores if y); neg = len(scores) - pos
    if pos == 0 or neg == 0: return float("nan")
    rank_sum = 0; i = 0
    while i < len(scores):
        j = i
        while j < len(scores) and scores[j][0] == scores[i][0]: j += 1
        avg = (i + j + 1) / 2
        rank_sum += avg * sum(1 for t in scores[i:j] if t[1])
        i = j
    return (rank_sum - pos * (pos + 1) / 2) / (pos * neg)

val = {}
SUBSETS = {"format+gender": {"format", "gender"},
           "+ archetype + age": {"format", "gender", "archetype", "age"},
           "+ workload + density": {"format", "gender", "archetype", "age", "wl30", "density14", "acwr"},
           "full (+ prior injury, era)": {n for n, _, _ in FACTORS}}
for label, keep in SUBSETS.items():
    cols_t, rows_t, _ = design(lambda k: k[9] <= 2018)
    keep_idx = [0] + [i for i, c in enumerate(cols_t) if i and c.split("=")[0] in keep]
    rows_k = [([x[i] for i in keep_idx], n, y) for x, n, y in rows_t]
    b_t, _ = fit_poisson(rows_k, len(keep_idx))
    pred = predictor(b_t, [cols_t[i] for i in keep_idx])
    sc = []; calib = []
    for (pid, yr, f), cc in ps_cells.items():
        if yr < 2019: continue
        ps = [(pred(ck), m) for ck, m in cc.items()]
        ps = [(p, m) for p, m in ps if p is not None]
        if not ps: continue
        exp_ = sum(p * m for p, m in ps)
        sc.append((exp_, 1 if ps_event[(pid, yr, f)] else 0))
        calib.append((exp_, ps_event[(pid, yr, f)]))
    calib.sort()
    dec = []
    for q in range(10):
        part = calib[q * len(calib) // 10:(q + 1) * len(calib) // 10]
        if part: dec.append((round(sum(a for a, _ in part) / len(part), 4), round(sum(b for _, b in part) / len(part), 4)))
    val[label] = dict(auc=round(auc(sc), 4), n_player_seasons=len(sc), events=sum(y for _, y in sc), calibration_deciles=dec)
    log("validation", label, val[label]["auc"])

# ── 9. Named-player sanity checks ─────────────────────────────────────────
NAMED = ["Jofra Archer", "Jasprit Bumrah", "Mitchell Starc", "Mark Wood", "Anrich Nortje", "Pat Cummins", "Josh Hazlewood",
         "James Anderson", "Trent Boult", "Tim Southee", "Ravichandran Ashwin", "Nathan Lyon", "Rashid Khan", "Virat Kohli", "Joe Root"]
by_full = defaultdict(list)
for pid, (nm, full, dob, st) in players.items():
    for x in {nm, full}:
        if x: by_full[x.lower()].append(pid)
exp_by_pid = defaultdict(float); n_by_pid = Counter()
pred_full = predictor(beta, cols)
for (pid, yr, f), cc in ps_cells.items():
    for ck, m in cc.items():
        p = pred_full(ck)
        if p is not None: exp_by_pid[pid] += p * m; n_by_pid[pid] += m
spells_by_pid = defaultdict(list)
for s in spells: spells_by_pid[s["player_id"]].append(s)
def resolve(name):
    first, *rest = name.split()
    sur = rest[-1].lower() if rest else first.lower()
    cands = set(by_full.get(name.lower(), [])) | {pid for pid, (nm, full, _, _) in players.items()
             if full and full.lower().split()[-1] == sur and first.lower() in full.lower().split()}
    return max(cands, key=lambda p: n_by_pid[p]) if cands else None
named = []
for nm in NAMED:
    pid = resolve(nm)
    if pid is None: named.append(dict(name=nm, found=False)); continue
    ss = spells_by_pid[pid]
    c = Counter(s["evidence"] for s in ss)
    main = c["confirmed"] + c["likely"]
    named.append(dict(name=nm, player_id=pid, archetype_T20=arch(pid, "T20"), archetype_FC=arch(pid, "FC"),
                      exposures=n_by_pid[pid], confirmed=c["confirmed"], likely=c["likely"], unknown=c["unknown"],
                      observed=main, expected=round(exp_by_pid[pid], 2),
                      obs_over_exp=round(main / exp_by_pid[pid], 2) if exp_by_pid[pid] else None,
                      per_100=round(100 * main / n_by_pid[pid], 2) if n_by_pid[pid] else None))

# ── 9b. IPL/WPL replacements: who gets replaced ─────────────────────────
ipl_players = defaultdict(set)
for (mid, pid), L in line.items():
    ev = matches[mid][3].lower()
    if "indian premier league" in ev or "women's premier league" in ev:
        ipl_players[matches[mid][5]].add(pid)
def resolve_ipl(name, season):
    pool = set().union(*[ipl_players.get(y, set()) for y in range(season - 2, season + 2)])
    nm = name.lower(); first, *rest = nm.split(); sur = rest[-1] if rest else first
    exact = [p for p in pool if players.get(p) and any(x and x.lower() == nm for x in players[p][:2])]
    if len(exact) == 1: return exact[0]
    fuzzy = [p for p in pool if players.get(p) and players[p][1] and players[p][1].lower().split()[-1] == sur
             and first in players[p][1].lower().split()]
    return fuzzy[0] if len(fuzzy) == 1 else None
repl_tab = Counter(); repl_resolved = 0
for season, name, reason, injury, league in repl:
    pid = resolve_ipl(name, season)
    if pid is None: continue
    repl_resolved += 1
    p = players.get(pid)
    age = (dt.date(season, 4, 1).toordinal() - p[2]) / 365.2425 if p and p[2] else None
    repl_tab[(arch(pid, "T20"), age_band(age))] += 1
# baseline: IPL squad-season appearances by archetype x age (who was available to be replaced)
ipl_base = Counter()
for yr, pids in ipl_players.items():
    for pid in pids:
        p = players.get(pid)
        age = (dt.date(yr, 4, 1).toordinal() - p[2]) / 365.2425 if p and p[2] else None
        ipl_base[(arch(pid, "T20"), age_band(age))] += 1

# ── 10. Spell length distribution (matches missed) by archetype group ─────
length = defaultdict(Counter)
for s in spells:
    if s["evidence"] not in MAIN or s["matches_missed"] == 0: continue
    grp = "pace" if arch(s["player_id"], s["format"]) in ("express/fast", "fast-medium", "medium") else (
        "spin" if arch(s["player_id"], s["format"]) in ("finger spin", "wrist spin") else "other")
    m = s["matches_missed"]
    length[(s["format"], grp)]["1-2" if m <= 2 else ("3-5" if m <= 5 else "6+")] += 1

# ── 11. Write outputs ─────────────────────────────────────────────────────
spell_csv = TMP / "injury_spells.csv"
with open(spell_csv, "w", newline="") as fh:
    keys = ["player_id", "name", "match_id", "team_id", "format", "gender", "date", "year", "archetype", "age",
            "matches_missed", "returned_in_season", "evidence", "reason", "injury_kind"]
    w = csv.DictWriter(fh, fieldnames=keys); w.writeheader()
    for s in spells:
        p = players.get(s["player_id"])
        age = round((s["day"] - p[2]) / 365.2425, 2) if p and p[2] else None
        w.writerow(dict(player_id=s["player_id"], name=(p[0] if p else ""), match_id=s["match_id"], team_id=s["team_id"],
                        format=s["format"], gender=s["gender"], date=dt.date.fromordinal(s["day"]).isoformat(), year=s["year"],
                        archetype=arch(s["player_id"], s["format"]), age=age, matches_missed=s["matches_missed"],
                        returned_in_season=s["returned_in_season"], evidence=s["evidence"], reason=s["reason"],
                        injury_kind=s["injury_kind"]))
subprocess.run(["duckdb", "-c", f"SET temp_directory='{TMP}'; COPY (SELECT * FROM read_csv('{spell_csv}', header=true)) "
                f"TO '{OUT / 'injury_spells.parquet'}' (FORMAT parquet)"], check=True)

summary = dict(
    generated=dt.datetime.now().isoformat(timespec="seconds"),
    exposures=len(regular_at), spells=dict(Counter(s["evidence"] for s in spells)),
    reasons=dict(Counter(s["reason"].split(":")[0] for s in spells).most_common(20)),
    substitute_notes=dict(n_sub_notes), linked_substitutes=len(sub_evidence),
    ipl_replacements=dict(rows=len(repl), injury=sum(1 for x in repl if x[3]), upgraded=repl_confirmed, no_spell=repl_preseason),
    model={k: {kk: (round(vv, 4) if isinstance(vv, float) else vv) for kk, vv in v.items()} for k, v in model.items()},
    validation=val, named=named,
    ipl_replaced=dict(resolved=repl_resolved, by_archetype_age={f"{a}|{b}": v for (a, b), v in repl_tab.items()},
                      base_player_seasons={f"{a}|{b}": v for (a, b), v in ipl_base.items()}), spell_length={f"{k[0]}|{k[1]}": dict(v) for k, v in length.items()})
json.dump(summary, open(OUT / "injury_model.json", "w"), indent=1)
json.dump({f"{f}|{g}|{a}|{ab}": c for (f, g, a, ab), c in rates.items()}, open(TMP / "rates_raw.json", "w"))
log("done; summary in data/analysis/injury_model.json")
