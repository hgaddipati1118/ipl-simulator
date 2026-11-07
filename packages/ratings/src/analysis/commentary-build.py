"""
Build the engine-ready commentary model from the flattened ball table (commentary-extract.py).

What it does
  1. Turns each real commentary line into a TEMPLATE: player names -> {batter} {bowler} {fielder} {nonstriker},
     pronouns -> {he} {him} {his} {himself} (so women's and men's lines are interchangeable), keeps all cricket
     vocabulary and fielding positions.
  2. Drops lines that only make sense in context (digits, "again", "earlier", milestones, targets, reviews ...),
     lines that still contain a real person/team/ground name, lines that contradict their outcome
     (a dot ball that says "four", a bowled that says "caught"), lines that are too long.
  3. Dedupes (normalised text), keeps a diverse, size-capped sample per outcome and writes the tag joint
     distribution P(shot, line, length, zone, control | outcome, bowler kind, batter hand) so the engine can invent
     consistent tags for a simulated ball that has none.

Output: packages/app/public/data/commentary-model.json (generated; served lazily, ~1 MB gzipped)
        data/commentary/model-report.json       (counts, drop reasons, size)

Run from packages/ratings (after commentary-extract.py):
    python3 -I src/analysis/commentary-build.py [--max-gz-kb 1400] [--max-len 190]
"""
import argparse
import gzip
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "commentary"
OUT_MODEL = ROOT.parent / "app" / "public" / "data" / "commentary-model.json"
OUT_REPORT = DATA / "model-report.json"

CLASSES = ["dot", "1", "2", "3", "4", "6", "wide", "noball", "legbye"]
WICKET_KINDS = ["bowled", "caught", "lbw", "run_out", "stumped", "caught_bowled"]
# Run outs are two classes because the template must say WHO was out: "W:run_out" = the striker (the batter who played the
# ball, slot {batter}), "W:run_out_ns" = the non-striker (the partner, slot {nonstriker}; {batter} is still the striker who
# played the shot and survives). "W:caught_and_bowled" = the bowler's own catch (no {fielder}).
RUN_OUT_STRIKER, RUN_OUT_NONSTRIKER, CAUGHT_BOWLED = "W:run_out", "W:run_out_ns", "W:caught_and_bowled"
BK = ["unknown", "fast", "medium", "offspin", "orthodox", "legspin"]
PHASES = ["pp", "mid", "death"]
PRESSURE = ["relaxed", "normal", "tense"]
HANDS = ["unknown", "rhb", "lhb"]

# ----------------------------------------------------------------------------- filters
CONTEXT_RE = re.compile(
    r"(\d|%|\bagain\b|\bearlier\b|\bbefore\b|\bprevious(ly)?\b|\blast (ball|over|delivery|one)\b|\bsame\b|\banother\b|"
    r"\b(second|third|fourth|fifth|first|sixth|seventh) (time|ball|delivery|over|wicket|boundary|four|six|run|straight|successive|consecutive|in a row|of the|on the trot|dismissal)\b|\bback[- ]to[- ]back\b|\bconsecutive\b|\bsuccessive\b|\bin a row\b|"
    r"\bso far\b|\balready\b|\byet\b|\bfinally\b|\bat last\b|\btoday\b|\btonight\b|\bthis (over|innings|match|game|season|tournament|series|year)\b|"
    r"\bnext (ball|over|delivery)\b|\bfifty\b|\bhalf[- ]?century\b|\bcentury\b|\bhundred\b|\bton\b|\bmaiden\b|\bduck\b|\bhat[- ]?trick\b|"
    r"\bmilestone\b|\bpartnership\b|\bneeds?\b|\brequired\b|\btarget\b|\bequation\b|\boverseas\b|\bdebut\b|\bcareer\b|"
    r"\bdrs\b|\breview(s|ed)?\b|\bumpire('s)?\b|\bthird[- ]umpire\b|\breplay(s)?\b|\bultra[- ]?edge\b|\bsnicko\b|\bhawk[- ]?eye\b|\bsoft signal\b|"
    r"\bsuper over\b|\bplayer of the\b|\bimpact (player|sub)\b|\bsubstitute\b|\bsub\b|\bbreak\b|\btimeout\b|\bstrategic\b|\binjur|\bphysio\b|\brain\b|\bcovers\b on\b|"
    r"\bnew (batter|batsman|man|ball|bowler)\b|\bopen(er|ers|ing)\b|\b(two|three|four|five|six|seven|eight|nine|ten|double|triple) (wickets?|overs?|balls? in a|boundaries|sixes|fours|in the over|in an over)\b|\bbrace\b|\b\w+-fer\b|\bwicket[- ]maiden\b|\bhat[- ]trick\b|\b(left|right)[- ]hand(ed|er|ers)?\b|\bleft[- ]arm(er)?\b|\bright[- ]arm(er)?\b|\blefty\b|\brighty\b|\bsouthpaw\b|\bcontinu\w*|\bkeeps?\b|\bgetting\b|\bdo(es)? it\b|\bfirst up\b|\bbigger and bigger\b|\bspell\b|\bonce (more|again)\b|\byet again\b|\bonce more\b|\bsame\b|\b(to )?end (of )?the over\b|\bnow\b|\bfinal\b|\blast\b|\bstarts? off\b|\bopens?\b|\b(his|her) (first|second|third|fourth|fifth)\b|\bbonus\b|\bthis time\b|\b(one|two|three|four|six|yet|any) more\b|\bmore of (the same|that)\b|\bwelcomes?\b|\bfollow(ing|ed|s)\b|\bsuch a\b|\bwhat a\b|\bhere comes\b|\bover to\b|\bcomes? (on|into) (the )?attack\b|\bintroduc|\bbrings? (on|himself|herself|up)\b|\bwelcome\b|\bcheers?\b|\bhello\b|"
    r"\bipl\b|\bwpl\b|\bt20\b|\bseason\b|\bcrowd\b|\bstadium\b|\bgrandstand\b|\bsponsor|\bcamera\b|\btv\b|\bbroadcast|\bcommentat|\blive\b|"
    r"\bwe\b|\bour\b|\bus\b|\bi\b|\bi'm\b|\bi'd\b|\byou\b|\byour\b|[?]|[@#]|https?:|\bwww\b|\(|\)|\[|\]|\bquote\b|\"|“|”|;)",
    re.I,
)
# phrases that only make sense for a certain outcome class (we drop them elsewhere)
BOUNDARY_WORDS = re.compile(r"\b(four|fours|six|sixes|boundary|boundaries|maximum|over the rope|into the stands|into the crowd|ropes?|fence)\b", re.I)
RUN_WORDS = re.compile(r"\b(single|singles|couple|two runs?|three runs?|one run|runs? taken|sprint|scamper|scurr)\w*\b", re.I)
WICKET_WORDS = re.compile(
    r"(\bis out\b|\bgiven out\b|\bout!|\bcaught\b|\blbw\b|\bstumped\b|\brun[- ]out\b|\bdismiss|\bdeparts?\b|\bhas to go\b|\bgone\b|\bwalks?\b|\bwicket!|"
    r"(?<!over the )(?<!around the )(?<!round the )\bwicket\b(?! ?keeper)|\bbreakthrough\b|\bsent back\b|\bpoints? the way\b|\bpacking\b)", re.I)
DOT_WORDS = re.compile(r"\b(dot ball|no run|no runs|dot)\b", re.I)
EXTRA_WORDS = re.compile(r"\b(wide|wides|no[- ]ball|free[- ]hit|bye|byes|leg[- ]?byes?|extras?|overstep\w*)\b", re.I)
BOWLED_ONLY = re.compile(r"\b(stumps?|bails?|timber|castle\w*|cartwheel\w*|rattle\w*|knocked over|clean bowled|bowled|off stump|middle stump|leg stump|uprooted|kisses the stumps?|hit the stumps?)\b", re.I)
KIND_WORDS = {
    "bowled": re.compile(r"\b(caught|lbw|stumped|run[- ]out|keeper|slip|taken|pouch\w*|catch\w*|trapped|plumb|pads?|thigh)\b", re.I),
    "caught": re.compile(r"\b(bowled him|clean bowled|lbw|stumped|run[- ]out|castle\w*|rattle\w*|cartwheel\w*|timber|plumb|pinned|trapped|bails?|stumps?)\b", re.I),
    "lbw": re.compile(r"\b(caught|bowled him|clean bowled|stumped|run[- ]out|catch\w*|taken|pouch\w*|castle\w*|rattle\w*|cartwheel\w*|bails?|timber|edge\w*|nick\w*)\b", re.I),
    "run_out": re.compile(r"\b(caught|lbw|stumped|bowled him|clean bowled|catch\w*|edge\w*|nick\w*|castle\w*|trapped|plumb|pads?)\b", re.I),
    "stumped": re.compile(r"\b(caught|lbw|run[- ]out|bowled him|clean bowled|catch\w*|edge\w*|nick\w*|castle\w*|plumb|pads?|trapped)\b", re.I),
}
KIND_REQUIRE = {  # a wicket line should actually describe how the batter went
    "bowled": re.compile(r"\b(stumps?|bails?|timber|castle\w*|cartwheel\w*|rattle\w*|knocked|bowled|uprooted|off stump|middle stump|leg stump|top of|kiss\w*|shatter\w*|dislodg\w*|trimm?\w*|gate|flatten\w*|crash\w*|splatter\w*|disturb\w*|clean)\b", re.I),
    "caught": re.compile(r"\b(caught|catch\w*|taken|pouch\w*|holes? out|takes? it|snaffl\w*|gobbl\w*|hangs? on|grabs?|swallow\w*|edge\w*|nick\w*|top[- ]edge\w*|skie\w*|balloon\w*|in the air|up in the air|straight to|miscue\w*|spoons?|holed|holing|gloved?|gloves)\b", re.I),
    "lbw": re.compile(r"\b(lbw|pads?|in front|trapped|plumb|pinned|finger|rapped|thigh|knee|boot|dead)\b", re.I),
    "run_out": re.compile(r"\b(run[- ]out|direct hit|hit the stumps|throw\w*|crease|mix[- ]?up|stump\w*|bails?|backing up|sent back|scramble\w*|short of)\b", re.I),
    "stumped": re.compile(r"\b(stump\w*|bails?|keeper|crease|down the (track|pitch)|dragged|out of (his|her) (ground|crease)|whips?|off the crease|leaves? the crease|advanc\w*)\b", re.I),
}
KIND_WORDS["caught_bowled"] = re.compile(r"\b(clean bowled|bowled him|lbw|stumped|run[- ]out|castle\w*|rattle\w*|cartwheel\w*|timber|plumb|pinned|trapped|bails?|stumps?|slip|keeper|boundary|rope)\b", re.I)
KIND_REQUIRE["caught_bowled"] = re.compile(r"\b(caught|catch\w*|taken|pouch\w*|grabs?|holds?|snaffl\w*|gobbl\w*|hangs? on|swallow\w*|back (to|at) the bowler|returns?|back to|plucks?|clutch\w*|reflex|reacts?|dives?|lunges?|collects?|gathers?|takes? it)\b", re.I)
LOW_MID_ONLY = re.compile(r"\b(he'd|she'd|he's|she's|he'll|she'll)\b", re.I)
LEADING_CONJ = re.compile(r"^(and|but|so|then|also|plus|anyway|because|although|though|however|meanwhile|instead|otherwise|or|yet|still|even|just|only|too|either|neither|both|that one|this one)\b", re.I)
NONWICKET_CONTEXT = re.compile(r"\b(catch\w*|dropp\w*|drops?|put down|misfield\w*|fumbl\w*|overthrow\w*|appeal\w*|edge[sd]? (and|but) (falls|drops)|just short of)\b", re.I)
SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"'])")
ECHO_LEAD = re.compile(r"^\s*(four|six|out|wide|no[- ]ball|dot ball|no run|leg[- ]?byes?|byes?|free[- ]hit|wicket|caught|bowled|lbw|stumped|run out|that's|and)\b[ ,!.:\-]*", re.I)
CAP_TOKEN = re.compile(r"\b[A-Z][A-Za-z'’\-]*\b")
ALLOW_CAPS = {"I", "OK", "Hawk-Eye", "DRS", "LBW", "TV", "UltraEdge", "Powerplay", "Yorker", "Free", "Hit", "Super", "Over", "Out", "Wide", "Four", "Six",
              "Boom", "Wow", "Oh", "Ooh", "Ah", "Aha", "Whoa", "Phew", "Ouch", "Yes", "No", "Not", "That", "This", "There", "Here", "What", "How", "Why", "When", "Where"}


LEAK_TOKENS = defaultdict(Counter)  # reason -> token -> count (written to the report to tune the lexicon)


def sha(s: str) -> int:
    return int(hashlib.md5(s.encode()).hexdigest()[:8], 16)


# ----------------------------------------------------------------------------- name slotting
def name_tokens(p: dict, keys=("name", "longName", "mobileName", "battingName", "fieldingName", "indexName")):
    toks = set()
    for k in keys:
        for t in re.findall(r"[A-Za-z][A-Za-z'’\-]+", (p or {}).get(k) or ""):
            if len(t) >= 3:
                toks.add(t)
    return toks


def full_names(p: dict):
    out = set()
    for k in ("longName", "mobileName", "name", "battingName", "fieldingName"):
        v = (p or {}).get(k)
        if v and " " in v.strip():
            out.add(v.strip())
    return out


class Lexicon:
    def __init__(self, names, teams, lower_counts, total_counts, cap_mid_counts=None):
        self.lower = lower_counts  # token.lower() -> count of lowercase occurrences in corpus text
        self.cap_mid = cap_mid_counts or Counter()  # Token -> count of capitalised mid-sentence occurrences
        self.names = {t for t in names}
        self.teams = {t for t in teams}
        self.common = {t for t in (self.names | self.teams) if lower_counts.get(t.lower(), 0) >= 40}
        self.leak = {t for t in (self.names | self.teams) if t not in self.common and len(t) >= 3}
        # strict-name check set is case sensitive on the capitalised form
        self.leak_lower = {t.lower() for t in self.leak}

    def is_common_word(self, tok):
        return self.lower.get(tok.lower(), 0) >= 40

    def name_like(self, tok):
        """a player name that is also an ordinary word ("Head", "Wood", "Short") but is used as a name often enough that
        a capitalised sentence-initial use is more likely the player ("Head tries to pull") than the word"""
        return tok in self.names and self.cap_mid.get(tok, 0) >= 0.15 * max(1, self.lower.get(tok.lower(), 0))


def slot_text(text: str, row: dict, lex: Lexicon, reasons: Counter):
    """-> templated text or None."""
    roles = [("batter", row["batter"]), ("bowler", row["bowler"])]
    f = row.get("fielder")
    if f and not (row.get("wk") == "caught_bowled" and f.get("id") == (row["bowler"] or {}).get("id")):
        roles.append(("fielder", f))
    if row.get("nons") and row["nons"].get("id"):
        roles.append(("nonstriker", row["nons"]))
    # token -> role (ambiguous tokens, shared by several roles, drop the template if they occur)
    tok_role = {}
    ambiguous = set()
    for role, p in roles:
        if not p or not p.get("id"):
            continue
        for t in name_tokens(p):
            if t in tok_role and tok_role[t] != role:
                ambiguous.add(t)
            tok_role[t] = role
    for t in list(tok_role):
        if t in ambiguous:
            tok_role.pop(t)
    # a bowler who is also the fielder (caught and bowled) keeps its first role
    out = text
    # full multi-word names first
    for role, p in roles:
        if not p or not p.get("id"):
            continue
        for fn in sorted(full_names(p), key=len, reverse=True):
            out = re.sub(r"\b" + re.escape(fn) + r"\b", "{" + role + "}", out)
    for t in sorted(tok_role, key=len, reverse=True):
        role = tok_role[t]
        if lex.is_common_word(t):
            # ordinary word that is also a name ("Short", "Will"): only a capitalised mid-sentence use is a name
            out = re.sub(r"(?<=[a-z,;] )" + re.escape(t) + r"\b", "{" + role + "}", out)
            continue
        out = re.sub(r"\b" + re.escape(t) + r"\b", "{" + role + "}", out)
    out = re.sub(r"(\{(\w+)\})(?:\s+\{\2\})+", r"\1", out)  # "{batter} {batter}" -> "{batter}"
    # other tokens that are names in this match, ambiguous ones included -> unusable
    if ambiguous and any(re.search(r"\b" + re.escape(t) + r"\b", out) for t in ambiguous):
        reasons["ambiguous_name"] += 1
        return None
    # leak check: any remaining capitalised token must be a plain word
    stripped = re.sub(r"\{\w+\}", " ", out)
    for m in CAP_TOKEN.finditer(stripped):
        tok = m.group(0)
        tl = tok.lower().rstrip("'’s") if tok.endswith(("'s", "’s")) else tok.lower()
        base = re.sub(r"['’]s$", "", tok)
        if base in ALLOW_CAPS:
            continue
        if base.isupper() and len(base) >= 2:
            reasons["unknown_proper_noun"] += 1   # initials / nicknames in capitals: "SKY", "DDP", "KL"
            LEAK_TOKENS["unknown_proper_noun"][base] += 1
            return None
        pre = stripped[: m.start()].rstrip()
        sentence_start = (pre == "") or pre.endswith((".", "!", "?", ":", "—", "-")) or pre.endswith('"')
        if sentence_start and lex.name_like(base):
            reasons["name_leak_sentence_start"] += 1
            LEAK_TOKENS["name_leak"][base] += 1
            return None
        if base in lex.leak or base.lower() in lex.leak_lower:
            if not (sentence_start and lex.is_common_word(base)):
                reasons["name_leak"] += 1
                LEAK_TOKENS["name_leak"][base] += 1
                return None
        if base in lex.teams and not lex.is_common_word(base):
            reasons["team_leak"] += 1
            LEAK_TOKENS["team_leak"][base] += 1
            return None
        if not sentence_start and not lex.is_common_word(base):
            reasons["unknown_proper_noun"] += 1
            LEAK_TOKENS["unknown_proper_noun"][base] += 1
            return None
        if sentence_start and not lex.is_common_word(base) and base.lower() not in lex.lower:
            reasons["unknown_proper_noun_start"] += 1
            LEAK_TOKENS["unknown_proper_noun_start"][base] += 1
            return None
    return out


PRON = [
    (re.compile(r"\bhimself\b", re.I), "{himself}"), (re.compile(r"\bherself\b", re.I), "{himself}"),
    (re.compile(r"\bhim\b", re.I), "{him}"), (re.compile(r"\bhis\b", re.I), "{his}"),
    (re.compile(r"\bhe\b", re.I), "{he}"), (re.compile(r"\bshe\b", re.I), "{he}"),
]


def slot_pronouns(text: str, female: bool):
    if female and re.search(r"\bher\b", text, re.I):
        return None  # "her" is both him and his: not worth guessing
    out = text
    for rx, rep in PRON:
        def sub(m, rep=rep):
            w = m.group(0)
            r = rep
            return r[0].upper() + r[1:] if w[0].isupper() else r
        out = rx.sub(sub, out)
    return out


def trim_sentences(text: str, max_len: int):
    sents = SENT_SPLIT.split(text)
    out = ""
    for s in sents:
        cand = (out + " " + s).strip()
        if len(cand) > max_len:
            break
        out = cand
    return out


def normalise_key(t: str) -> str:
    return re.sub(r"[^a-z{}]+", " ", t.lower()).strip()


RARE_BELOW = 2
WORD_RE = re.compile(r"[a-z][a-z'’\-]{3,}")
_LOWER = {}


def has_rare_word(text: str, lex) -> bool:
    """typos and one-off words ("bolwer", nicknames): a lowercase word the whole corpus uses fewer than RARE_BELOW times"""
    low = re.sub(r"\{\w+\}", " ", text.lower())
    if re.search(r"(?<![\w'’-])[b-hj-z](?![\w'’-])", low):   # a stray letter: "it's s four", "a  b"
        return True
    for w in WORD_RE.findall(low):
        if lex.lower.get(w, 0) < RARE_BELOW:
            return True
    return False


def clean_sentence(sent: str, row, lex, reasons):
    """one sentence -> slotted text, or None when it cannot be reused"""
    if CONTEXT_RE.search(sent):
        reasons["context"] += 1
        return None
    t = slot_text(sent, row, lex, reasons)
    if t is None:
        return None
    p = slot_pronouns(t, row.get("g") == "F")
    if p is None:
        reasons["her"] += 1
        return None
    t = re.sub(r"\s+", " ", p).strip()
    if re.search(r"[^\x20-\x7e’‘—–…]", t):
        reasons["odd_chars"] += 1
        return None
    if has_rare_word(t, lex):
        reasons["rare_word_or_typo"] += 1
        return None
    return t


def make_templates(row, lex, max_len, reasons):
    """A ball's commentary -> 0..n templates. Sentences that cannot be reused (a name, a score, "again") are cut out; every
    maximal run of clean sentences becomes one or more templates of at most max_len characters."""
    text = row["text"]
    if not text or len(text) < 14:
        reasons["too_short"] += 1
        return []
    # "boundary.Waits on" -> "boundary. Waits on" (missing space after a full stop in the source text)
    text = re.sub(r"(?<=[a-z])([.!?])(?=[A-Z][a-z])", r"\1 ", text)
    text = text.lstrip(" .,;:!?-—")
    if not text:
        reasons["too_short"] += 1
        return []
    if text[0].islower():
        text = text[0].upper() + text[1:]
    sents = [x.strip() for x in SENT_SPLIT.split(text) if x.strip()]
    cleaned = [clean_sentence(x, row, lex, reasons) for x in sents]
    out = []
    run = []
    for c in cleaned + [None]:
        if c is not None:
            run.append(c)
            continue
        cur = ""
        for sent in run:
            if len(sent) > max_len:
                cur = ""
                continue
            cand = (cur + " " + sent).strip()
            if len(cand) > max_len:
                out.append(cur)
                cand = sent
            cur = cand
        if cur:
            out.append(cur)
        run = []
    res = []
    for t in out:
        # strip echoes of the outcome that the engine prefix already says
        for _ in range(2):
            if re.match(r"^\s*(four|six|out|wide|no[- ]ball|dot ball|no run|leg[- ]?byes?|byes?|free[- ]hit|wicket)\b", t, re.I):
                t = ECHO_LEAD.sub("", t, count=1)
        t = t.strip(" -—:").lstrip(".,;!? ")
        if t and t[0].islower():
            t = t[0].upper() + t[1:]
        if LEADING_CONJ.match(t):
            reasons["leading_conjunction"] += 1
            continue
        if len(t) < 14:
            reasons["too_short_after_trim"] += 1
            continue
        res.append(t)
    return res


SPIN_VOCAB = re.compile(r"\b(googly|googlies|doosra|carrom|flight(ed|y)?|flighting|spinner|spinners|spin(s|ning)?|leggie|offie|arm ball|drift(s|ed|ing)?|dip(s|ped)?|loop(s|ed|y|ing)?|tossed|toss(es)? it up|turn(s|ed|ing)?|bite(s)?|gripped|gripping|wrist|slider|topspinner|chinaman)\b", re.I)
PACE_VOCAB = re.compile(r"\b(bouncer|bumper|yorker|yorkers|seam(s|ed|ing|er)?|slower ball|slower one|cutter|cutters|knuckle|back of a length|pace|paceman|pacy|quick|quicker|express|swing(s|ing)?|swung|hurried|hurries|rushed|fast|full toss|beamer|short ball|banged|bang(s)? it|hit the deck|slower)\b", re.I)


def bowler_vocab_ok(t: str, bk: str) -> bool:
    """spin words only for spinners, pace words only for pace bowlers (unknown kind: neither)."""
    spin = bk in ("offspin", "orthodox", "legspin")
    pace = bk in ("fast", "medium")
    if SPIN_VOCAB.search(t) and not spin:
        return False
    if PACE_VOCAB.search(t) and not pace:
        return False
    return True


def consistent(t: str, oc: str, wk: str | None):
    """Does the line plausibly describe this outcome? (cheap keyword guard, deliberately conservative)"""
    if oc == "wicket":
        if re.search(r"\b(no run|dot ball|four|six|boundary|single)\b", t, re.I):
            return False
        if wk in KIND_WORDS and KIND_WORDS[wk].search(t):
            return False
        if wk in KIND_REQUIRE and not KIND_REQUIRE[wk].search(t):
            return False
        return True
    if WICKET_WORDS.search(t):
        return False
    if oc == "dot":
        return not (BOUNDARY_WORDS.search(t) or RUN_WORDS.search(t) or EXTRA_WORDS.search(t))
    if oc in ("1", "2", "3"):
        if BOUNDARY_WORDS.search(t) or DOT_WORDS.search(t) or EXTRA_WORDS.search(t):
            return False
        if oc == "1":
            return not re.search(r"\b(two|twos|couple|brace|three|second run|second|both ends|and back)\b", t, re.I)
        if oc == "2":
            return not re.search(r"\b(single|one run|just the one|three|third run|only one)\b", t, re.I)
        return not re.search(r"\b(single|one run|couple|two runs|just the one|only one)\b", t, re.I)
    if oc == "4":
        return not (re.search(r"\b(six|sixes|maximum|over the rope|single|couple|dot|no run)\b", t, re.I) or EXTRA_WORDS.search(t))
    if oc == "6":
        return not (re.search(r"\b(four|fours|single|couple|dot|no run|along the ground|races|bounce|bounces)\b", t, re.I) or EXTRA_WORDS.search(t))
    if oc == "wide":
        return not (BOUNDARY_WORDS.search(t) or RUN_WORDS.search(t) and not re.search(r"\bwide\b", t, re.I)) and bool(re.search(r"\b(wide|wides|down leg|too (far|wide)|outside|leg side|signals?)\b", t, re.I))
    if oc == "noball":
        return bool(re.search(r"\b(no[- ]ball|front[- ]foot|overstep\w*|free[- ]hit|waist|full toss|beamer|crease|line)\b", t, re.I)) and not BOUNDARY_WORDS.search(t)
    if oc == "legbye":
        return bool(re.search(r"\b(leg[- ]?bye|pad|thigh|body|off the|glance|deflect\w*|hits? (him|her)|struck)\b", t, re.I)) and not BOUNDARY_WORDS.search(t)
    return False


# ----------------------------------------------------------------------------- run-out tagging
# Who was out decides which slot may carry the dismissal. {batter} is always the striker (who played the ball) and
# {nonstriker} the partner.
OUT_PHRASE = r"(is|was|has been|gets|got|ends up|looks to be|is going to be|is adjudged)\s+(\w+\s+)?(run[- ]?out|out|gone|stranded|short|sent back|dismissed|walking)"
PARTNER_SHOT = re.compile(r"\{nonstriker\}\s+(went|goes|looks?|looked|tried|tries|plays?|played|pulls?|pulled|drives?|drove|cuts?|flicks?|hooks?|punche[sd]|tap(s|ped)|nudge[sd]|push(es|ed)|swings?|swung|slog(s|ged)|swats?|sweeps?|swept|glances?|glanced|clips?|clipped|slashe[sd]|hits?|struck|smashe[sd]|whack(s|ed)|chips?|chipped|works?|worked|steers?|steered|mows?|mowed|launche[sd]|lofts?|lofted|dabs?|dabbed|defends?|defended|blocks?|blocked|edges|edged|misses|missed|beaten)\b", re.I)
SLOT_OUT = lambda slot: re.compile(r"\{" + slot + r"\}(?:'s)?\s+(?:\w+\s+){0,2}?" + OUT_PHRASE, re.I)
BATTER_OUT = SLOT_OUT("batter")
PARTNER_OUT = SLOT_OUT("nonstriker")
POSS_RUN_OUT = re.compile(r"\{(batter|nonstriker)\}'s\s+(run[- ]?out|dismissal|wicket)", re.I)


def run_out_class(r):
    """The class of a run-out ball by who was out: striker (the batter who faced), non-striker (the partner), or None when unknown"""
    out_id = r.get("out")
    if out_id and out_id == (r.get("batter") or {}).get("id"):
        return RUN_OUT_STRIKER
    if out_id and out_id == (r.get("nons") or {}).get("id"):
        return RUN_OUT_NONSTRIKER
    return None


def run_out_tag_ok(t: str, ck: str) -> bool:
    """A run-out template must be truthful for the end that was out (see RUN_OUT_* above)."""
    if PARTNER_SHOT.search(t):
        return False                      # the partner never plays the shot, in either class
    if re.search(r"\b(from|by|off) the (bowler|keeper|wicketkeeper)\b|\bupstairs\b|\bthird[- ]umpire\b", t, re.I):
        return False                      # names a particular fielder / a referral: the engine's fielder may be anyone
    if ck == RUN_OUT_NONSTRIKER:
        if "{nonstriker}" not in t:
            return False                  # every non-striker line must refer to the partner
        if BATTER_OUT.search(t):
            return False                  # ... and must not describe the striker's own dismissal
        if re.search(r"\{batter\}'s\s+(run[- ]?out|dismissal|wicket)", t, re.I):
            return False
        return True
    if ck == RUN_OUT_STRIKER:
        if PARTNER_OUT.search(t) or re.search(r"\{nonstriker\}'s\s+(run[- ]?out|dismissal|wicket)", t, re.I):
            return False                  # a striker line must not say the partner is the one out
        return True
    return True


# ----------------------------------------------------------------------------- situation
def pressure_of(row) -> int:
    rrr = row.get("rrr")
    wk = row.get("wkts") or 0
    if row["inn"] >= 2 and rrr is not None:
        if rrr >= 12 or (rrr >= 9.5 and wk >= 5) or wk >= 8:
            return 2
        if rrr <= 7.5 and wk <= 3:
            return 0
        return 1
    if wk >= 6 and row["phase"] != "death":
        return 2
    if row["phase"] == "mid" and wk <= 1:
        return 0
    return 1


def bk_idx(row) -> int:
    return BK.index(row["bk"]) if row["bk"] in BK else 0


def hand_idx(row) -> int:
    return HANDS.index(row["hand"]) if row.get("hand") in HANDS else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-gz-kb", type=int, default=1400, help="size budget of the gzipped model")
    ap.add_argument("--max-len", type=int, default=190, help="max characters of a template")
    ap.add_argument("--joint-top", type=int, default=70, help="tag combinations kept per joint cell")
    ap.add_argument("--min-text-comps", default="", help="(unused) reserved")
    args = ap.parse_args()

    balls_f = DATA / "balls.jsonl.gz"
    names_f = DATA / "names.json"
    if not balls_f.exists():
        sys.exit("run commentary-extract.py first")
    nm = json.load(names_f.open())
    rows = [json.loads(l) for l in gzip.open(balls_f, "rt")]
    print(f"{len(rows)} balls")

    lower_counts = Counter()
    for r in rows:
        for w in re.findall(r"\b[a-z][a-z'’\-]+\b", r["text"]):
            lower_counts[w] += 1
    cap_mid = Counter()
    for r in rows:
        for w in re.findall(r"(?<=[a-z,;] )([A-Z][a-z'’\-]+)\b", r["text"]):
            cap_mid[w] += 1
    lex = Lexicon(nm["names"].keys(), nm["teams"].keys(), lower_counts, None, cap_mid)
    global RARE_BELOW
    RARE_BELOW = 3 if len(rows) > 100_000 else 2

    # ---- tag dictionaries
    dicts = {"shot": [None], "line": [None], "len": [None]}
    for r in rows:
        for k, f in (("shot", "shot"), ("line", "line"), ("len", "len")):
            v = r.get(f)
            if v and v not in dicts[k]:
                dicts[k].append(v)
    for k in dicts:
        dicts[k] = [None] + sorted(x for x in dicts[k] if x)
    idx = {k: {v: i for i, v in enumerate(vs)} for k, vs in dicts.items()}
    assert len(dicts["shot"]) < 64 and len(dicts["line"]) < 16 and len(dicts["len"]) < 16, "tag dictionary too large to pack"

    def cls_key(r):
        if r["oc"] == "wicket":
            if r["wk"] == "run_out":
                return run_out_class(r)
            if r["wk"] == "caught_bowled":
                return CAUGHT_BOWLED
            return ("W:" + r["wk"]) if r["wk"] in WICKET_KINDS else None
        return r["oc"] if r["oc"] in CLASSES else None

    def pack(r):
        zone = r.get("zone") if isinstance(r.get("zone"), int) and 0 <= r["zone"] <= 8 else 0
        ctl = r.get("ctl") if isinstance(r.get("ctl"), int) and 0 <= r["ctl"] <= 2 else 3
        return (idx["shot"].get(r.get("shot"), 0) | idx["line"].get(r.get("line"), 0) << 6 | idx["len"].get(r.get("len"), 0) << 10
                | zone << 14 | ctl << 18 | bk_idx(r) << 20 | PHASES.index(r["phase"]) << 23 | pressure_of(r) << 25 | hand_idx(r) << 27)

    # ---- joint tag distribution from every ball with tags (text not required)
    cell = defaultdict(Counter)
    for r in rows:
        ck = cls_key(r)
        if not ck or not (r.get("shot") or (r.get("line") and r.get("len"))):
            continue
        zone = r.get("zone") if isinstance(r.get("zone"), int) and 0 <= r["zone"] <= 8 else 0
        ctl = r.get("ctl") if isinstance(r.get("ctl"), int) and 0 <= r["ctl"] <= 2 else 3
        combo = (idx["shot"].get(r.get("shot"), 0), idx["line"].get(r.get("line"), 0), idx["len"].get(r.get("len"), 0), zone, ctl)
        bk = bk_idx(r)
        hd = hand_idx(r)
        cell[(ck, bk, hd)][combo] += 1
        cell[(ck, bk, 0)][combo] += 1   # hand-agnostic backoff
        cell[(ck, 0, hd)][combo] += 1   # style-agnostic backoff
        cell[(ck, 0, 0)][combo] += 1
    joint = {}
    for (ck, bk, hd), cnt in cell.items():
        tot = sum(cnt.values())
        if tot < 8 and (bk or hd):
            continue  # too thin: the engine backs off to a broader cell
        top = cnt.most_common(args.joint_top)
        joint[f"{ck}|{bk}|{hd}"] = [list(c) + [n] for c, n in top]

    # ---- templates
    reasons = Counter()
    by_class = defaultdict(dict)  # class -> normalised key -> [text, packed, n]
    n_text = 0
    for r in rows:
        ck = cls_key(r)
        if not ck or not r["text"]:
            continue
        n_text += 1
        for t in make_templates(r, lex, args.max_len, reasons):
            if not ck.startswith("W:") and NONWICKET_CONTEXT.search(t):
                reasons["nonwicket_event_word"] += 1
                continue
            if not bowler_vocab_ok(t, r["bk"]):
                reasons["bowler_kind_vocab"] += 1
                continue
            kind = {RUN_OUT_NONSTRIKER: "run_out", CAUGHT_BOWLED: "caught_bowled"}.get(ck, ck[2:] if ck.startswith("W:") else None)
            if not consistent(t, "wicket" if ck.startswith("W:") else ck, kind):
                reasons["inconsistent_with_outcome"] += 1
                continue
            if ck in (RUN_OUT_STRIKER, RUN_OUT_NONSTRIKER) and not run_out_tag_ok(t, ck):
                reasons["run_out_tag_" + ("nonstriker" if ck == RUN_OUT_NONSTRIKER else "striker")] += 1
                continue
            if ck == CAUGHT_BOWLED and "{fielder}" in t:
                reasons["caught_bowled_fielder_slot"] += 1
                continue
            key = normalise_key(t)
            slot = by_class[ck].get(key)
            if slot:
                slot[2] += 1
                continue
            by_class[ck][key] = [t, pack(r), 1]
    reasons["rows_with_text_in_known_class"] = n_text
    print("template candidates per class:", {k: len(v) for k, v in by_class.items()})

    # ---- cap per class, preferring variety over the tag space, then shrink to the size budget
    TARGET = {"dot": 9000, "1": 7000, "2": 3000, "3": 800, "4": 8000, "6": 7000, "wide": 1200, "noball": 400, "legbye": 700,
              "W:bowled": 1800, "W:caught": 4500, "W:lbw": 1500, "W:run_out": 700, "W:run_out_ns": 500, "W:stumped": 500, "W:caught_and_bowled": 400}

    def select(cands, cap):
        if len(cands) <= cap:
            return sorted(cands, key=lambda c: sha(c[0]))
        groups = defaultdict(list)
        for c in cands:
            groups[(c[1] & 0x3FFF, (c[1] >> 14) & 15)].append(c)  # shot/line/length + zone
        for g in groups.values():
            g.sort(key=lambda c: (-c[2], sha(c[0])))
        out = []
        i = 0
        ordered = sorted(groups.values(), key=lambda g: -len(g))
        while len(out) < cap and any(i < len(g) for g in ordered):
            for g in ordered:
                if i < len(g) and len(out) < cap:
                    out.append(g[i])
            i += 1
        return out

    scale = 1.0
    for attempt in range(8):
        lines = {}
        total = 0
        for ck, d in by_class.items():
            sel = select(list(d.values()), int(TARGET.get(ck, 500) * scale))
            lines[ck] = {"t": [c[0] for c in sel], "g": [c[1] for c in sel]}
            total += len(sel)
        model = {
            "v": 2, "dict": {"shot": dicts["shot"], "line": dicts["line"], "len": dicts["len"], "bk": BK, "hand": HANDS, "ph": PHASES, "pr": PRESSURE},
            "joint": joint, "lines": lines,
            "corpus": {"balls": len(rows), "balls_with_text": n_text, "templates": total},
        }
        blob = json.dumps(model, separators=(",", ":"), ensure_ascii=False).encode()
        gz = len(gzip.compress(blob, 9))
        print(f"scale {scale:.2f}: {total} templates, {len(blob)/1e6:.2f} MB raw, {gz/1e3:.0f} KB gz")
        if gz <= args.max_gz_kb * 1000:
            break
        scale *= 0.8
    OUT_MODEL.parent.mkdir(parents=True, exist_ok=True)
    OUT_MODEL.write_bytes(blob)
    report = {"templates": total, "raw_bytes": len(blob), "gz_bytes": gz, "per_class_candidates": {k: len(v) for k, v in by_class.items()},
              "per_class_kept": {k: len(v["t"]) for k, v in lines.items()}, "drop_reasons": dict(reasons), "joint_cells": len(joint),
              "top_dropped_tokens": {k: v.most_common(40) for k, v in LEAK_TOKENS.items()}}
    json.dump(report, OUT_REPORT.open("w"), indent=1)
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
