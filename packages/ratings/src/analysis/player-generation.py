"""
Fit the model behind generated players and export it to the engine:
  packages/engine/src/generation-model.ts   (attribute vectors, roles, bowling styles, ages)
  packages/engine/src/name-model.ts         (first / last name pools per region and gender, blocklist of real names)

Attributes: for each stratum (gender x role class: batter, keeper, all-rounder, pace, spin) the game's 8 ratings
of the real rated players are turned into normal scores (rank -> normal quantile), regressed on age and region
(so a 19-year-old from Australia differs from a 33-year-old from Namibia), and the correlation of the residuals
is kept as a Cholesky factor. Sampling draws correlated normals, adds the age / region mean and maps each score
back through the stratum's own marginal quantiles, so the marginals, the correlations between attributes and the
age and region shifts all come from the real data (a Gaussian copula with regression margins).

Names: first and last names of the real players (ESPN long names, CricketArchive full names) pooled per region
and gender, to be mixed freely at generation time. A hashed blocklist of every real full name that the pools could
produce keeps a generated player from ever sharing a real person's full name.

Needs data/analysis/game_players.json (npx tsx src/analysis/export-game-players.ts).
Run from packages/ratings:  python3 -I src/analysis/player-generation.py
"""
import json, math, re, subprocess, unicodedata, csv, sys
from collections import Counter, defaultdict
from pathlib import Path
from statistics import NormalDist

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
ENGINE = ROOT.parent / "engine" / "src"
ND = NormalDist()
ATTRS = ["battingIQ", "timing", "power", "running", "wicketTaking", "economy", "accuracy", "clutch"]
QP = [0.003, 0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.975, 0.99, 0.997]
SPIN = {"off-spin", "leg-spin", "left-arm-orthodox", "left-arm-wrist-spin"}
AGE_MIN, AGE_MAX = 16, 43

REGIONS = ["india", "subcontinent", "anglo", "westindies", "tier2", "other"]
COUNTRY_REGION = {"India": "india"}
for c in ["Pakistan", "Bangladesh", "Sri Lanka", "Afghanistan", "Nepal"]:
    COUNTRY_REGION[c] = "subcontinent"
for c in ["England", "Australia", "New Zealand", "South Africa"]:
    COUNTRY_REGION[c] = "anglo"
COUNTRY_REGION["West Indies"] = "westindies"
for c in ["Zimbabwe", "Ireland", "Scotland", "Netherlands", "Namibia", "United Arab Emirates", "UAE", "USA", "Canada", "Oman",
          "Hong Kong", "Papua New Guinea", "Kenya", "Uganda", "Jersey", "Singapore"]:
    COUNTRY_REGION[c] = "tier2"

# name groups: where first / last names are borrowed from
NAME_GROUP = {"India": "india", "Pakistan": "pakistan", "Bangladesh": "bangladesh", "Sri Lanka": "sri-lanka", "Afghanistan": "afghanistan",
              "Nepal": "nepal", "Australia": "australia", "New Zealand": "new-zealand", "South Africa": "south-africa",
              "West Indies": "west-indies", "Zimbabwe": "africa"}
for c in ["England", "Scotland", "Ireland", "Wales", "Jersey", "Guernsey", "Isle of Man"]:
    NAME_GROUP[c] = "british-isles"
for c in ["Namibia", "Kenya", "Uganda", "Tanzania", "Malawi", "Botswana", "Nigeria", "Ghana", "Mozambique", "Rwanda", "Lesotho", "Eswatini",
          "Sierra Leone", "Gambia", "Cameroon", "Ethiopia", "Zambia", "Mali", "Seychelles", "Mauritius", "Morocco", "Egypt", "St Helena"]:
    NAME_GROUP[c] = "africa"
for c in ["UAE", "United Arab Emirates", "Qatar", "Oman", "Bahrain", "Saudi Arabia", "Kuwait"]:
    NAME_GROUP[c] = "gulf"
for c in ["Singapore", "Malaysia", "Hong Kong", "USA", "Canada", "Thailand"]:
    NAME_GROUP[c] = "diaspora"
for c in ["Indonesia", "Cambodia", "Japan", "China", "Philippines", "South Korea", "Vietnam", "Myanmar", "Bhutan", "Maldives", "Papua New Guinea",
          "Fiji", "Samoa", "Vanuatu", "Cook Islands", "Tonga"]:
    NAME_GROUP[c] = "asia-pacific"
NAME_GROUPS = ["india", "pakistan", "bangladesh", "sri-lanka", "afghanistan", "nepal", "british-isles", "australia", "new-zealand",
               "south-africa", "west-indies", "africa", "gulf", "diaspora", "asia-pacific", "europe"]  # everything else -> europe / other
PARTICLES = {"de", "van", "von", "der", "den", "du", "le", "la", "bin", "ben", "al", "el", "di", "da", "dos", "mc", "mac", "st", "ten", "ter", "te", "o"}


def norm_country(c):
    c = re.sub(r"\s+Women$", "", c).strip()
    return c


def region_of(country):
    return COUNTRY_REGION.get(norm_country(country), "other")


def name_group_of(country):
    return NAME_GROUP.get(norm_country(country), "europe")


def role_class(p):
    if p["wk"] and p["role"] != "bowler":
        return "keeper"
    if p["role"] == "all-rounder":
        return "allround"
    if p["role"] == "bowler":
        return "spin" if p["bs"] in SPIN else "pace"
    return "batter"


# ---------------------------------------------------------------------------------------------------- linear algebra
def solve(A, b):
    k = len(b)
    M = [A[i][:] + [b[i]] for i in range(k)]
    for i in range(k):
        p = max(range(i, k), key=lambda r: abs(M[r][i]))
        M[i], M[p] = M[p], M[i]
        piv = M[i][i] if abs(M[i][i]) > 1e-12 else 1e-12
        for r in range(k):
            if r != i:
                m = M[r][i] / piv
                for c in range(i, k + 1):
                    M[r][c] -= m * M[i][c]
    return [M[i][k] / (M[i][i] if abs(M[i][i]) > 1e-12 else 1e-12) for i in range(k)]


def ols(X, y, lam=1e-3):
    k = len(X[0])
    A = [[0.0] * k for _ in range(k)]
    b = [0.0] * k
    for xi, yi in zip(X, y):
        for i in range(k):
            b[i] += xi[i] * yi
            for j in range(k):
                A[i][j] += xi[i] * xi[j]
    for i in range(1, k):
        A[i][i] += lam
    return solve(A, b)


def cholesky(S):
    n = len(S)
    L = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1):
            s = S[i][j] - sum(L[i][k] * L[j][k] for k in range(j))
            if i == j:
                L[i][j] = math.sqrt(max(s, 1e-6))
            else:
                L[i][j] = s / L[j][j]
    return L


def quantile(v, p):
    i = p * (len(v) - 1)
    lo = int(math.floor(i))
    hi = min(len(v) - 1, lo + 1)
    return v[lo] + (v[hi] - v[lo]) * (i - lo)


def age_feats(age):
    a = (age - 27.0) / 5.0
    return [1.0, a, a * a]


def region_feats(region):
    return [1.0 if region == r else 0.0 for r in REGIONS[:-1]]  # "other" is the reference


# ---------------------------------------------------------------------------------------------------- attributes
def fit_stratum(players):
    n = len(players)
    # normal scores per attribute (rank based, ties averaged)
    scores = []
    margins = []
    for a in ATTRS:
        vals = [p["r"][a] for p in players]
        order = sorted(range(n), key=lambda i: vals[i])
        z = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j + 1 < n and vals[order[j + 1]] == vals[order[i]]:
                j += 1
            rank = (i + j) / 2.0
            for k in range(i, j + 1):
                z[order[k]] = ND.inv_cdf((rank + 0.5) / n)
            i = j + 1
        scores.append(z)
        sv = sorted(vals)
        margins.append([round(quantile(sv, q), 2) for q in QP])
    X = [age_feats(p["age"]) + region_feats(region_of(p["country"]))[:] for p in players]
    coefs, resid = [], []
    for z in scores:
        beta = ols(X, z)
        coefs.append([round(b, 4) for b in beta])
        resid.append([zi - sum(bi * xi for bi, xi in zip(beta, x)) for zi, x in zip(z, X)])
    S = [[sum(resid[i][k] * resid[j][k] for k in range(n)) / n for j in range(len(ATTRS))] for i in range(len(ATTRS))]
    L = cholesky(S)
    return {
        "n": n,
        "quantiles": margins,
        "coef": coefs,
        "chol": [[round(v, 4) for v in row] for row in L],
        "corr": [[round(S[i][j] / math.sqrt(S[i][i] * S[j][j]), 3) for j in range(len(ATTRS))] for i in range(len(ATTRS))],
    }


def fit_attributes(players):
    out = {}
    for gender in ("male", "female"):
        for rc in ("batter", "keeper", "allround", "pace", "spin"):
            ps = [p for p in players if p["g"] == gender and role_class(p) == rc]
            if len(ps) < 30:
                print("skipping tiny stratum", gender, rc, len(ps))
                continue
            out[f"{gender}/{rc}"] = fit_stratum(ps)
    return out


def role_mix(players):
    """P(role class) by gender and region, shrunk toward the gender-wide mix"""
    rcs = ["batter", "keeper", "allround", "pace", "spin"]
    mix = {}
    for gender in ("male", "female"):
        g = [p for p in players if p["g"] == gender]
        base = Counter(role_class(p) for p in g)
        for region in REGIONS:
            c = Counter(role_class(p) for p in g if region_of(p["country"]) == region)
            tot = sum(c.values())
            prior = 40.0
            w = [(c.get(r, 0) + prior * base[r] / len(g)) / (tot + prior) for r in rcs]
            mix[f"{gender}/{region}"] = [round(x, 4) for x in w]
    # players on IPL / WPL rosters: the mix a squad needs (a generated pool stands in for the players who get picked)
    for gender in ("male", "female"):
        sq = [p for p in players if p["g"] == gender and p.get("team")]
        c = Counter(role_class(p) for p in sq)
        mix[f"{gender}/squad"] = [round(c.get(r, 0) / len(sq), 4) for r in rcs]
    return {"classes": rcs, "mix": mix}


def style_mix(players):
    out = {}
    for gender in ("male", "female"):
        for rc in ("batter", "keeper", "allround", "pace", "spin"):
            ps = [p for p in players if p["g"] == gender and role_class(p) == rc]
            c = Counter(p["bs"] for p in ps)
            tot = sum(c.values())
            out[f"{gender}/{rc}"] = {"styles": [s for s, _ in c.most_common()], "weights": [round(n / tot, 4) for _, n in c.most_common()],
                                     "left": round(sum(1 for p in ps if p["bh"] == "left") / len(ps), 3)}
    return out


def age_hist(players):
    out = {}
    for gender in ("male", "female"):
        c = Counter(min(AGE_MAX, max(AGE_MIN, p["age"])) for p in players if p["g"] == gender)
        out[gender] = [c.get(a, 0) for a in range(AGE_MIN, AGE_MAX + 1)]
    return out


# ---------------------------------------------------------------------------------------------------- names
def strip(s):
    s = unicodedata.normalize("NFKD", s)
    return "".join(ch for ch in s if not unicodedata.combining(ch))


def clean_token(t):
    return re.sub(r"[^A-Za-z'\-]", "", strip(t))


def split_name(full):
    toks = [t for t in re.split(r"\s+", full.strip()) if t]
    if len(toks) < 2:
        return None
    first = clean_token(toks[0])
    j = len(toks) - 1
    last_toks = [toks[j]]
    while j - 1 >= 1 and toks[j - 1].lower().strip(".") in PARTICLES:
        j -= 1
        last_toks.insert(0, toks[j])
    last = " ".join(clean_token(t) if t.lower() not in PARTICLES else t.lower() for t in last_toks).strip()
    if len(first) < 3 or re.fullmatch(r"[A-Z]{1,3}", first) or "." in toks[0] or len(clean_token(toks[-1])) < 2:
        return None
    if first.isupper() and len(first) <= 4:
        return None
    return first, last


def norm_full(first, last):
    s = strip(f"{first} {last}").lower()
    return re.sub(r"[^a-z ]", "", s).strip()


def fnv(s):
    h = 0x811C9DC5
    for ch in s.encode("utf8"):
        h ^= ch
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def b36(n):
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    if n == 0:
        return "0"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out


def build_names(game):
    espn = json.load(open(DATA / "scraped" / "espn-players.json"))
    country_of = {int(p["id"].split("_")[1]): p for p in game if p["id"].split("_")[-1].isdigit()}
    known = {norm_country(p["country"]) for p in game}
    people = []  # (long name, country, gender)
    for e in espn:
        pr = e["profile"]
        name = pr.get("longName") or ""
        gp = country_of.get(pr["espnId"])
        if gp:
            country, gender = norm_country(gp["country"]), gp["g"]
        else:
            teams = pr.get("teams") or []
            country = next((norm_country(t) for t in teams[:1] if norm_country(t) in known), None)
            gender = "female" if pr.get("gender") == "F" else "male"
            if country is None:
                continue
        people.append((name, country, gender))
    pools = defaultdict(lambda: (Counter(), Counter()))
    real_full = set()
    for name, country, gender in people:
        sp = split_name(name)
        if not sp:
            continue
        f, l = sp
        grp = name_group_of(country)
        pools[(grp, gender)][0][f] += 1
        pools[(grp, gender)][1][l] += 1
        real_full.add(norm_full(f, l))
    # CricketArchive full names (all senior players) widen the blocklist; first / last pools only from rated players
    out = subprocess.run(["duckdb", "-csv", "-noheader", "-c", f"SELECT DISTINCT full_name FROM '{DATA}/analysis/ca_ratings_by_year.parquet' WHERE full_name IS NOT NULL"],
                         capture_output=True, text=True, cwd=ROOT)
    for row in csv.reader(out.stdout.splitlines()):
        sp = split_name(row[0]) if row else None
        if sp:
            real_full.add(norm_full(*sp))
    model = {}
    for (grp, gender), (fc, lc) in sorted(pools.items()):
        firsts = [(n, c) for n, c in fc.most_common(300)]
        lasts = [(n, c) for n, c in lc.most_common(500)]
        model[f"{grp}/{gender}"] = {
            "first": [n for n, _ in firsts], "firstW": [c for _, c in firsts],
            "last": [n for n, _ in lasts], "lastW": [c for _, c in lasts],
        }
    # a women's group too small to stand alone borrows nothing here; the engine falls back (see name-model users)
    producible = set()
    for key, m in model.items():
        for f in m["first"]:
            for l in m["last"]:
                h = norm_full(f, l)
                if h in real_full:
                    producible.add(fnv(h))
    return model, sorted(producible), len(real_full)


def main():
    game = json.load(open(DATA / "analysis" / "game_players.json"))
    attrs = fit_attributes(game)
    model = {
        "attrs": ATTRS, "quantileProbs": QP, "regions": REGIONS, "ageMin": AGE_MIN, "ageMax": AGE_MAX,
        "strata": attrs, "roles": role_mix(game), "styles": style_mix(game), "ageHist": age_hist(game),
        "regionOf": {norm_country(c): r for c, r in COUNTRY_REGION.items()},
    }
    names, blocklist, n_real = build_names(game)
    gen_ts = [
        "// Generated by packages/ratings/src/analysis/player-generation.py from the game's rated players",
        "// (data/analysis/game_players.json). Do not edit by hand; re-run the script.",
        "//",
        "// Per stratum (gender / role class): marginal quantiles of the 8 ratings, normal-score regression on age and",
        "// region, and the Cholesky factor of the residual correlation. See docs/RATINGS-PIPELINE.md, \"Generated players\".",
        "",
        "export interface StratumModel {",
        "  n: number;",
        "  /** Per attribute, the rating at each of quantileProbs */",
        "  quantiles: number[][];",
        "  /** Per attribute: [intercept, age, age^2, ...region dummies (all but the last region)] on the normal score */",
        "  coef: number[][];",
        "  chol: number[][];",
        "  /** Correlation of the residual normal scores (documentation / tests) */",
        "  corr: number[][];",
        "}",
        "",
        "export const GENERATION_MODEL: {",
        "  attrs: string[];",
        "  quantileProbs: number[];",
        "  regions: string[];",
        "  ageMin: number;",
        "  ageMax: number;",
        "  strata: Record<string, StratumModel>;",
        "  roles: { classes: string[]; mix: Record<string, number[]> };",
        "  styles: Record<string, { styles: string[]; weights: number[]; left: number }>;",
        "  ageHist: Record<string, number[]>;",
        "  regionOf: Record<string, string>;",
        "} = " + json.dumps(model, separators=(",", ":")) + ";",
        "",
    ]
    (ENGINE / "generation-model.ts").write_text("\n".join(gen_ts))
    name_ts = [
        "// Generated by packages/ratings/src/analysis/player-generation.py from real players' names (ESPN long names).",
        "// Do not edit by hand; re-run the script.",
        "//",
        "// First and last name pools per name group and gender (with how common each is), and a hashed blocklist of the",
        f"// {n_real} real full names (ESPN + CricketArchive) that a first + last mix from these pools could reproduce.",
        "",
        "export interface NamePool {",
        "  first: string[];",
        "  firstW: number[];",
        "  last: string[];",
        "  lastW: number[];",
        "}",
        "",
        "export const NAME_POOLS: Record<string, NamePool> = " + json.dumps(names, separators=(",", ":"), ensure_ascii=False) + ";",
        "",
        "/** Country -> name group (countries not listed use \"europe\") */",
        "export const NAME_GROUP_OF: Record<string, string> = " + json.dumps({norm_country(c): g for c, g in NAME_GROUP.items()}, separators=(",", ":")) + ";",
        "",
        "/** FNV-1a hashes (base 36) of normalised real full names reachable from the pools */",
        "export const REAL_NAME_HASHES = \"" + ",".join(b36(h) for h in blocklist) + "\";",
        "",
    ]
    (ENGINE / "name-model.ts").write_text("\n".join(name_ts))
    print("strata:", {k: v["n"] for k, v in attrs.items()})
    print("name pools:", {k: (len(v["first"]), len(v["last"])) for k, v in names.items()})
    print("blocklist size:", len(blocklist), "of", n_real, "real names")


if __name__ == "__main__":
    main()
