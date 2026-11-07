"""
Commentary template builder tests.  Run from packages/ratings:   python3 -I src/analysis/__tests__/commentary_build.test.py

Pushes synthetic ball rows through the real name-slotting / filtering code of src/analysis/commentary-build.py
(no corpus needed) and asserts what becomes a template and what is dropped.  Exit code is non-zero on failure.
"""
import importlib.util
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("cb", HERE / "commentary-build.py")
cb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cb)

spec_x = importlib.util.spec_from_file_location("cx", HERE / "commentary-extract.py")
cx = importlib.util.module_from_spec(spec_x)
spec_x.loader.exec_module(cx)

FAILS, PASSES = [], 0


def check(name, cond):
    global PASSES
    if cond:
        PASSES += 1
    else:
        FAILS.append(name)


def player(pid, long, mobile=None, field=None):
    return {"id": pid, "name": long, "longName": long, "mobileName": mobile or long.split()[-1], "battingName": long, "fieldingName": field or long.split()[-1]}


# lexicon: names of players in the corpus + ordinary lowercase words
words = Counter({w: 500 for w in "short of a length outside off and he drives cover for four pulls it over midwicket the ball on to wide dot no run slog sweeps through gets stands taken at long onto".split()})
names = {"Virat": 9, "Kohli": 9, "Jasprit": 9, "Bumrah": 9, "Shreyas": 9, "Iyer": 9, "Rohit": 9, "Sharma": 9, "Kane": 9, "Short": 9}
lex = cb.Lexicon(names.keys(), {"Mumbai": 3, "Indians": 3, "RCB": 3}, words, None)

kohli, bumrah, iyer, rohit = player(1, "Virat Kohli"), player(2, "Jasprit Bumrah"), player(3, "Shreyas Iyer"), player(4, "Rohit Sharma")
row = {"batter": kohli, "bowler": bumrah, "fielder": iyer, "nons": rohit, "g": "M", "text": ""}


def make(text, **kw):
    r = dict(row, text=text, **kw)
    return cb.make_template(r, lex, 190, Counter())


cb.RARE_BELOW = 0  # synthetic lexicon: disable the typo filter except where tested
t = make("Short and outside off, Kohli pulls it over midwicket. He gets it away for four")
check("names become slots", t is not None and "{batter}" in t and "Kohli" not in t)
check("pronouns become slots", t is not None and "{he}" in t.lower() and not any(w in t.split() for w in ("He", "he")))
check("bowler and fielder slots", (make("Bumrah bowls it short, taken at long on by Iyer") or "") == "{bowler} bowls it short, taken at long on by {fielder}")
check("full name is one slot", (make("Virat Kohli drives it for four") or "").startswith("{batter} drives"))
check("another real player's name drops the line", make("Short and outside off, Kane pulls it over midwicket") is None)
check("team name drops the line", make("Short and outside off, pulls it over midwicket, Mumbai fans erupt") is None)
check("digits drop the line", make("Short and outside off, pulls it for four, that is 34 off 20") is None)
check("context drops the line", make("Short and outside off, pulls it for four, again") is None)
check("review drops the line", make("Short and outside off, hits the pad, the umpire turns down the appeal after a review") is None)
check("hand-specific words drop the line", make("Angles it in to the left-hander, pulls it over midwicket") is None)
check("unknown proper noun mid-sentence drops the line", make("Short and outside off, pulls it over midwicket as Zorblax watches") is None)
check("women's ambiguous 'her' drops the line", make("Short and outside off, pulls it over midwicket with her usual flair", g="F") is None)
check("women's she becomes the same slot", "{he}" in (make("Short and outside off, she pulls it over midwicket for four", g="F") or ""))
check("ambiguous name (shared by two roles) drops the line", cb.slot_text("Sharma pulls it", dict(row, bowler=player(5, "Karn Sharma"), nons=rohit), lex, Counter()) is None)
check("max length", len(make("Short and outside off, he pulls it over midwicket for four. " * 6) or "x" * 999) <= 190)
check("leading 'FOUR!' echo stripped", not (make("FOUR! Short and outside off, he pulls it over midwicket") or "FOUR").startswith("FOUR"))

cb.RARE_BELOW = 2
check("typo / one-off word drops the line", make("Short and outside off, he pulls it over midwicket back to the bolwer") is None)
cb.RARE_BELOW = 0

# outcome consistency guards
c = cb.consistent
check("dot with 'four' is inconsistent", not c("Short and outside off, saved four runs", "dot", None))
check("dot ok", c("Short and outside off, left alone", "dot", None))
check("four with 'six' is inconsistent", not c("Cleared the rope for six", "4", None))
check("single with boundary is inconsistent", not c("Pulled to the boundary", "1", None))
check("single with 'couple' is inconsistent", not c("Worked for a couple", "1", None))
check("two with 'single' is inconsistent", not c("Nudged for a single", "2", None))
check("six with 'along the ground' is inconsistent", not c("Races along the ground", "6", None))
check("non-wicket mentioning a dismissal is inconsistent", not c("Caught at long on", "4", None))
check("bowled must describe the stumps", c("Beats the bat and hits the stumps", "wicket", "bowled") and not c("Pulled hard to the fielder", "wicket", "bowled"))
check("bowled that says caught is inconsistent", not c("Caught at the stumps and bowled", "wicket", "bowled"))
check("caught must describe a catch", c("Holes out to long on", "wicket", "caught") and not c("Beaten by the pace", "wicket", "caught"))
check("caught that says lbw is inconsistent", not c("Holes out, plumb lbw", "wicket", "caught"))
check("wide must say wide-ish", c("Too wide outside off, called wide", "wide", None) and not c("Pulled over midwicket", "wide", None))
check("a wicket line never says four", not c("Holes out to long on for four", "wicket", "caught"))

# bowler kind vocabulary
check("spin word on a pace bowler is rejected", not cb.bowler_vocab_ok("Flighted outside off", "fast"))
check("spin word on a spinner is accepted", cb.bowler_vocab_ok("Flighted outside off", "offspin"))
check("pace word on a spinner is rejected", not cb.bowler_vocab_ok("A yorker at the toes", "legspin"))
check("neutral line fits anyone", cb.bowler_vocab_ok("Pushed to cover", "unknown"))

# pressure buckets
check("pressure: steep chase is tense", cb.pressure_of({"inn": 2, "rrr": 13.0, "wkts": 2, "phase": "death"}) == 2)
check("pressure: easy chase is relaxed", cb.pressure_of({"inn": 2, "rrr": 6.0, "wkts": 1, "phase": "mid"}) == 0)
check("pressure: first innings is normal", cb.pressure_of({"inn": 1, "rrr": None, "wkts": 3, "phase": "death"}) == 1)

# extract: outcome classes, dismissal kinds, text cleaning
oc = cx.outcome_class
check("extract: dot", oc({"batsmanRuns": 0, "totalRuns": 0}) == "dot")
check("extract: four", oc({"batsmanRuns": 4, "totalRuns": 4, "isFour": True}) == "4")
check("extract: wide", oc({"batsmanRuns": 0, "totalRuns": 1, "wides": 1}) == "wide")
check("extract: no ball with runs off the bat is 'other'", oc({"batsmanRuns": 1, "totalRuns": 2, "noballs": 1}) == "other")
check("extract: leg bye", oc({"batsmanRuns": 0, "totalRuns": 1, "legbyes": 1}) == "legbye")
check("extract: wicket wins", oc({"batsmanRuns": 0, "totalRuns": 0, "isWicket": True}) == "wicket")
check("extract: caught and bowled", cx.dismissal_kind("caught", "c & b Azmatullah Omarzai") == "caught_bowled")
check("extract: lbw / bowled / stumped / run out", [cx.dismissal_kind(x, "") for x in ("lbw", "bowled", "stumped", "run out")] == ["lbw", "bowled", "stumped", "run_out"])
check("extract: html to text", cx.html_to_text("<strong>Wow</strong> &amp; <a href='x'>link</a><br>more") == "Wow & link more")
check("extract: bowler kinds", [cx.bowl_kind([x]) for x in ("rf", "lmf", "ob", "sla", "lbg")] == ["fast", "medium", "offspin", "orthodox", "legspin"])

for f in FAILS:
    print("FAIL", f)
print(f"{PASSES} passed, {len(FAILS)} failed")
sys.exit(1 if FAILS else 0)
