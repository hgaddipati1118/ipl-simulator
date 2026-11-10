"""
Flatten the scraped Cricinfo ball-by-ball commentary into one row per ball.

Input : data/commentary/*.jsonl.gz   (raw, one match per line; written by the scraper in docs/COMMENTARY.md)
Output: data/commentary/balls.jsonl.gz   one JSON object per delivery with
        - who/what: ids, short + long names (for slotting), batter hand, bowler style/kind, gender
        - outcome class (dot/1/2/3/4/5/6/wide/noball/legbye/bye/wicket) + dismissal kind + fielder
        - tags: shot, line, length, wagon zone, control
        - situation: innings, over, phase, wickets, target/required rate, batter score, pressure bucket
        - text: the plain commentary text (HTML stripped)
        data/commentary/names.json       every real player/team/ground token seen (the leak lexicon)
        data/commentary/corpus-stats.json

Run from packages/ratings:   python3 -I src/analysis/commentary-extract.py
Raw files are never modified; re-running regenerates everything from them.
"""
import gzip
import html
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "commentary"
OUT_BALLS = DATA / "balls.jsonl.gz"
OUT_NAMES = DATA / "names.json"
OUT_STATS = DATA / "corpus-stats.json"

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")


def html_to_text(s: str) -> str:
    s = re.sub(r"<br\s*/?>", " ", s or "")
    s = TAG_RE.sub("", s)
    s = html.unescape(s).replace("\xa0", " ")
    return WS_RE.sub(" ", s).strip()


def items_text(items) -> str:
    """Join the HTML items of a comment into plain text (drops tweets, images, videos)."""
    if not items:
        return ""
    return " ".join(t for t in (html_to_text(i.get("html", "")) for i in items if i.get("type") == "HTML") if t)


def walk_players(o, out):
    """Collect every player-like dict (has longName + id) anywhere in the page payload."""
    if isinstance(o, dict):
        if "longName" in o and "id" in o and "battingStyles" in o:
            out[o["id"]] = o
        for v in o.values():
            walk_players(v, out)
    elif isinstance(o, list):
        for v in o:
            walk_players(v, out)


def bowl_kind(styles) -> str:
    """fast | medium | offspin | orthodox | legspin | unknown from Cricinfo bowlingStyles codes."""
    s = (styles or [""])[0]
    if s in ("rf", "lf", "rfm", "lfm"):
        return "fast"
    if s in ("rm", "lm", "rmf", "lmf"):
        return "medium"
    if s in ("ob",):
        return "offspin"
    if s in ("sla",):
        return "orthodox"
    if s in ("lb", "lbg", "lws", "rws", "lwo"):
        return "legspin"
    return "unknown"


def dismissal_kind(short: str, long: str) -> str:
    s = (short or "").lower()
    l = (long or "").lower()
    if "run out" in s or "run out" in l:
        return "run_out"
    if "stump" in s:
        return "stumped"
    if "lbw" in s:
        return "lbw"
    if "bowled" in s and "caught" not in s:
        return "bowled"
    if "caught" in s:
        return "caught_bowled" if l.startswith("c & b") else "caught"
    if "hit wicket" in s:
        return "hit_wicket"
    return s or "other"


def outcome_class(c) -> str:
    bat = c.get("batsmanRuns") or 0
    total = c.get("totalRuns") or 0
    if c.get("isWicket"):
        return "wicket"
    if (c.get("wides") or 0) > 0:
        return "wide" if bat == 0 else "other"
    if (c.get("noballs") or 0) > 0:
        return "noball" if bat == 0 else "other"
    if (c.get("legbyes") or 0) > 0:
        return "legbye"
    if (c.get("byes") or 0) > 0:
        return "bye"
    if c.get("isSix") or bat == 6:
        return "6"
    if c.get("isFour") or bat == 4:
        return "4"
    if total in (0, 1, 2, 3, 5):
        return str(total) if total else "dot"
    return "other"


def phase_of(legal: int, max_balls: int) -> str:
    """powerplay: first 30% of the innings' balls (6 overs of 20, 25-30 balls of the Hundred), death: last 25%"""
    return "pp" if legal < 0.3 * max_balls else ("mid" if legal < 0.75 * max_balls else "death")


def read_records(path, stats):
    """Yield the match records of an appended-gzip JSONL file; a half-written tail (rsync mid-append) is skipped."""
    try:
        with gzip.open(path, "rt") as g:
            for line in g:
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    stats["bad_lines"] += 1
    except (EOFError, OSError, gzip.BadGzipFile):
        stats["truncated_files"] += 1


def main():
    files = sorted(DATA.glob("*.jsonl.gz"))
    files = [f for f in files if f.name != "balls.jsonl.gz"]
    if not files:
        sys.exit(f"no raw files in {DATA}")
    stats = Counter()
    name_tokens = Counter()
    team_tokens = Counter()
    per_comp = Counter()
    per_comp_text = Counter()
    # a match can appear twice (the scraper re-tries incomplete ones): keep the record with the most balls
    best = {}
    for f in files:
        for i, rec in enumerate(read_records(f, stats)):
            n = sum(len(v) for v in rec["commentary"].values())
            if rec["matchId"] not in best or n > best[rec["matchId"]][0]:
                best[rec["matchId"]] = (n, f.name, i)
    stats["duplicate_records_dropped"] = 0
    with gzip.open(OUT_BALLS, "wt") as out:
        for f in files:
            for i, rec in enumerate(read_records(f, stats)):
                if best[rec["matchId"]][1:] != (f.name, i):
                    stats["duplicate_records_dropped"] += 1
                    continue
                stats["matches"] += 1
                emit_match(rec, out, stats, name_tokens, team_tokens, per_comp, per_comp_text)
    json.dump({"names": name_tokens, "teams": team_tokens}, OUT_NAMES.open("w"))
    stats["balls_with_text_pct"] = round(100 * stats["balls_text"] / max(1, stats["balls"]), 1)
    stats["balls_with_shot_pct"] = round(100 * stats["balls_shot"] / max(1, stats["balls"]), 1)
    stats["balls_with_line_length_pct"] = round(100 * stats["balls_linelen"] / max(1, stats["balls"]), 1)
    out_stats = dict(stats)
    out_stats["by_comp_matches"] = dict(per_comp)
    out_stats["by_comp_balls_with_text"] = dict(per_comp_text)
    json.dump(out_stats, OUT_STATS.open("w"), indent=1)
    print(json.dumps(out_stats, indent=1))


def emit_match(rec, out, stats, name_tokens, team_tokens, per_comp, per_comp_text):
    players = {}
    walk_players(rec.get("page", {}), players)
    for p in players.values():
        for k in ("name", "longName", "mobileName", "battingName", "fieldingName", "indexName"):
            for tok in re.findall(r"[A-Za-z][A-Za-z'\-]+", p.get(k) or ""):
                name_tokens[tok] += 1
    match = rec.get("page", {}).get("match") or {}
    for t in match.get("teams", []):
        tt = t.get("team") or {}
        for k in ("name", "longName", "abbreviation", "unofficialName", "slug"):
            for tok in re.findall(r"[A-Za-z][A-Za-z'\-]+", str(tt.get(k) or "")):
                team_tokens[tok] += 1
    g = (match.get("ground") or {})
    for k in ("name", "smallName", "longName"):
        for tok in re.findall(r"[A-Za-z][A-Za-z'\-]+", g.get(k) or ""):
            team_tokens[tok] += 1
    for k in ("name", "area"):
        for tok in re.findall(r"[A-Za-z][A-Za-z'\-]+", (g.get("town") or {}).get(k) or ""):
            team_tokens[tok] += 1

    innings = {i["inningNumber"]: i for i in rec["page"].get("innings", [])}
    # dismissal lookup: (inning, out player id) -> (kind, fielder dict)
    dism = {}
    for n, inn in innings.items():
        for b in inn.get("inningBatsmen", []):
            if b.get("isOut") and b.get("player"):
                dt = b.get("dismissalText") or {}
                fl = [f for f in (b.get("dismissalFielders") or []) if f.get("player")]
                dism[(n, b["player"]["id"])] = (dismissal_kind(dt.get("short"), dt.get("long")), fl[0]["player"] if fl else None,
                                               (fl[0] or {}).get("isKeeper") if fl else False)
    runs_by_inn = {n: (i.get("runs") or 0) for n, i in innings.items()}
    # scheduled length of an innings in balls (T20 120, the Hundred 100)
    max_balls = int((match.get("scheduledOvers") or 20) * (match.get("ballsPerOver") or 6)) or 120
    comp = rec.get("comp")
    series_name = (rec.get("fixture") or {}).get("seriesSlug") or rec.get("seriesSlug") or ""
    per_comp[comp] += 1
    match_gender = None
    for n_str, balls in rec["commentary"].items():
        if not str(n_str).isdigit():
            stats["innings_without_number"] += len(balls)   # balls the scraper could not file under an innings
            continue
        n = int(n_str)
        # chase target: first innings total + 1 (for innings 2 of a normal match)
        target = runs_by_inn.get(1, 0) + 1 if n == 2 else None
        inn_max_balls = max_balls
        if n >= 3:
            # a super over (innings 3.. = one over each, the even ones chase the odd one before): six balls, a target built from
            # the previous super-over innings' balls (the scorecard lists only the two regular innings)
            inn_max_balls = 6
            if n % 2 == 0:
                target = sum((b.get("totalRuns") or 0) for b in rec["commentary"].get(str(n - 1), [])) + 1
        legal = 0
        score = 0
        wkts = 0
        bat_runs = defaultdict(int)
        bat_balls = defaultdict(int)
        for c in balls:
            stats["balls"] += 1
            bid, wid = c.get("batsmanPlayerId"), c.get("bowlerPlayerId")
            bp, wp = players.get(bid), players.get(wid)
            if not bp or not wp:
                stats["balls_no_player"] += 1
            gender = (bp or wp or {}).get("gender")
            match_gender = match_gender or gender
            oc = outcome_class(c)
            bat = c.get("batsmanRuns") or 0
            total = c.get("totalRuns") or 0
            is_legal = not ((c.get("wides") or 0) > 0 or (c.get("noballs") or 0) > 0)
            over = (c.get("overNumber") or 1) - 1
            text = items_text(c.get("commentTextItems"))
            pre = items_text(c.get("commentPreTextItems"))
            kind = fielder = keeper = None
            if c.get("isWicket"):
                dk = dism.get((n, c.get("outPlayerId")))
                dt = c.get("dismissalText") or {}
                kind = dk[0] if dk else dismissal_kind(dt.get("short"), dt.get("long"))
                fielder = dk[1] if dk else None
                keeper = dk[2] if dk else False
            # situation before this ball
            crr = (score * 6 / legal) if legal else 0.0
            rrr = None
            if target is not None and legal < inn_max_balls:
                rrr = (target - score) * 6 / (inn_max_balls - legal)
            row = {
                "m": rec["matchId"], "comp": comp, "season": (rec.get("fixture") or {}).get("startDate", "")[:4], "g": gender,
                "inn": n, "over": over, "ball": c.get("ballNumber"), "legal": legal, "oc": oc, "tot": total, "bat": bat,
                "wk": kind, "keeper": bool(keeper), "out": c.get("outPlayerId"),
                "shot": c.get("shotType"), "line": c.get("pitchLine"), "len": c.get("pitchLength"),
                "zone": c.get("wagonZone"), "ctl": c.get("shotControl"),
                "phase": "death" if n >= 3 else phase_of(legal, max_balls), "score": score, "wkts": wkts, "crr": round(crr, 2), "rrr": None if rrr is None else round(rrr, 2),
                "bruns": bat_runs[bid], "bballs": bat_balls[bid],
                "hand": ((bp or {}).get("battingStyles") or [None])[0],
                "bstyle": ((wp or {}).get("bowlingStyles") or [None])[0], "bk": bowl_kind((wp or {}).get("bowlingStyles")),
                "batter": {k: (bp or {}).get(k) for k in ("id", "name", "longName", "mobileName", "battingName", "fieldingName")},
                "bowler": {k: (wp or {}).get(k) for k in ("id", "name", "longName", "mobileName", "battingName", "fieldingName")},
                "nons": {k: (players.get(c.get("nonStrikerPlayerId")) or {}).get(k) for k in ("id", "name", "longName", "mobileName", "fieldingName")},
                "fielder": None if not fielder else {k: fielder.get(k) for k in ("id", "name", "longName", "mobileName", "battingName", "fieldingName")},
                "text": text, "pre": pre,
            }
            out.write(json.dumps(row, separators=(",", ":")) + "\n")
            if text:
                stats["balls_text"] += 1
                per_comp_text[comp] += 1
            if row["shot"]:
                stats["balls_shot"] += 1
            if row["line"] and row["len"]:
                stats["balls_linelen"] += 1
            # advance state
            score += total
            if c.get("isWicket"):
                wkts += 1
            if is_legal:
                legal += 1
                bat_balls[bid] += 1
            bat_runs[bid] += bat


if __name__ == "__main__":
    main()
