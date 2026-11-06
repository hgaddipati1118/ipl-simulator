"""Venue canonicalisation shared by venue-conditions.py: CricketArchive and Cricsheet venue strings -> one ground id.

Order: explicit alias regex (venue_aliases.csv: renames + sponsor names) -> generic key (sponsor words and generic
ground words stripped, plus the city) -> Cricsheet strings fuzzily matched to a CricketArchive key in the same city.
"""
import csv, re, unicodedata
from pathlib import Path

SPONSOR = [
    "world sports betting", "hollywoodbets", "dafabet", "bidvest", "imperial", "dp world", "sahara", "emirates",
    "kia", "brit", "specsavers", "uptonsteel", "seat unique", "cloudfm", "cloud", "incora", "1st central", "fischer",
    "cooper associates", "blundstone arena", "ninja", "gmhba", "simonds", "metricon", "people first", "westpac",
    "sky", "optus", "etihad", "marvel", "goodyear", "chevrolet", "outsurance", "senwes", "de beers", "jb marks",
    "mercedes benz", "momentum", "standard bank", "ageas", "utilita", "emerald", "carnegie", "swalec", "national bank",
    "pallekele", "the", "dr", "sir",
]
GENERIC = {"cricket", "ground", "stadium", "international", "club", "association", "sports", "sport", "and", "of",
           "cc", "csa", "c", "a", "s", "arena", "complex", "new", "no", "main"}


def strip_accents(s):
    return "".join(ch for ch in unicodedata.normalize("NFKD", s) if not unicodedata.combining(ch))


def norm_text(s):
    s = strip_accents(s or "").lower().replace("&", " and ").replace("'s", "s").replace("’s", "s")
    s = re.sub(r"[^a-z0-9 ,]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def split_ground_city(raw, city=None):
    t = norm_text(raw)
    parts = [p.strip() for p in t.split(",") if p.strip()]
    ground = parts[0] if parts else t
    c = norm_text(city) if city else (parts[-1] if len(parts) > 1 else "")
    return ground, c


def core_tokens(ground):
    g = " " + ground + " "
    for sp in SPONSOR:
        g = g.replace(" " + sp + " ", " ")
    toks = [w for w in g.split() if w not in GENERIC]
    return toks


CITY_ALIASES = {"bengaluru": "bangalore", "chattogram": "chittagong", "gqeberha": "port elizabeth", "mumbai": "bombay",
                "kolkata": "calcutta", "chennai": "madras", "dhaka": "mirpur", "kennington": "london",
                "st johns wood": "london", "brighton": "hove", "kigali city": "kigali"}


def norm_city(c):
    c = norm_text(c)
    return CITY_ALIASES.get(c, c)


class VenueCanon:
    def __init__(self, alias_csv):
        self.aliases = []
        lines = [l for l in Path(alias_csv).read_text().splitlines() if l.strip() and not l.startswith("#")]
        for row in csv.DictReader(lines):
            self.aliases.append((re.compile(row["pattern"], re.I), row["canonical"], row["city"], row["country"]))

    SECONDARY = re.compile(r"nursery|no ?\d\b|\b[abc] (ground|field)\b|ground [b-c2-9]\b|ground \d|\bstadium [bc]\b|outer oval|"
                           r"west ground|academy ground|oval ground|playing field no|union ground|main oval|"
                           r"foundation|\bfield\b|second ground|\boval 2\b|indoor", re.I)

    def alias(self, raw):
        if self.SECONDARY.search(raw or ""):
            return None
        for rx, canon, city, country in self.aliases:
            if rx.search(raw or ""):
                return canon, city, country
        return None

    def key(self, raw, city=None):
        """(venue_id, display name, city, alias_country or None)"""
        a = self.alias(raw)
        if a:
            canon, c, country = a
            return "A:" + canon + "|" + c, canon, c, country
        ground, c = split_ground_city(raw, city)
        toks = core_tokens(ground)
        nc = norm_city(c)
        k = " ".join(toks) if toks else ground
        disp = (raw or "").split(",")[0].strip()
        return "K:" + k + "|" + nc, disp, (c.title() if c else ""), None


def jaccard(a, b):
    a, b = set(a), set(b)
    return len(a & b) / max(1, len(a | b))
