"""Builds data/history.json: every FBS game since 2014 with its final score and the
consensus (median across sportsbooks) closing spread, total and moneylines.

Source: sportsdataverse/cfbfastR-data (schedules from ESPN, lines from CollegeFootballData).
Run once per offseason:  python3 scripts/build_history.py
The current season comes live from the site's odds function, so it isn't stored here.
"""
import csv, gzip, io, json, statistics, sys, urllib.request
from collections import defaultdict

RAW = "https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main"
FIRST, LAST = 2014, int(sys.argv[1]) if len(sys.argv) > 1 else 2025
OUT = "data/history.json"


def fetch(path):
    with urllib.request.urlopen(f"{RAW}/{path}") as r:
        data = r.read()
    return gzip.decompress(data).decode() if path.endswith(".gz") else data.decode()


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def subseq(short, name):
    """True if the letters of an abbreviation like 'UTH' appear in order in 'Utah'."""
    it = iter(name.lower())
    return all(c in it for c in short.lower() if c.isalnum())


def side_of(label, home, away):
    """Which team a line row is about: 'home', 'away' or None if it can't be told."""
    lab = label.strip().lower()
    if lab == home.lower():
        return "home"
    if lab == away.lower():
        return "away"
    h, a = subseq(lab, home), subseq(lab, away)
    return "home" if h and not a else "away" if a and not h else None


games, teams = {}, {}
for season in range(FIRST, LAST + 1):
    for r in csv.DictReader(io.StringIO(fetch(f"schedules/csv/cfb_schedules_{season}.csv"))):
        if "fbs" not in (r["home_division"], r["away_division"]) or r["completed"] != "TRUE":
            continue
        if num(r["home_points"]) is None or num(r["away_points"]) is None:
            continue
        for side in ("home", "away"):
            teams[r[f"{side}_id"]] = [r[f"{side}_team"], r[f"{side}_division"], r[f"{side}_conference"]]
        games[r["game_id"]] = {
            "id": r["game_id"], "season": season, "week": int(r["week"]),
            "post": 1 if r["season_type"] == "postseason" else 0, "date": r["start_date"][:10],
            "home": r["home_id"], "away": r["away_id"], "home_name": r["home_team"], "away_name": r["away_team"],
            "hs": int(num(r["home_points"])), "as": int(num(r["away_points"])),
            "neutral": 1 if r["neutral_site"] == "TRUE" else 0, "conf": 1 if r["conference_game"] == "TRUE" else 0,
        }

lines = defaultdict(lambda: defaultdict(list))
unmatched = 0
for r in csv.DictReader(io.StringIO(fetch("betting/csv/cfb_line_odds.csv.gz"))):
    g = games.get(r["game_id"])
    if not g or r["book"] == "consensus":
        continue
    m = r["market_type"]
    if m == "total":
        if num(r["lines"]) is not None:
            lines[g["id"]]["total"].append(num(r["lines"]))
        continue
    side = side_of(r["abbr"], g["home_name"], g["away_name"])
    if side is None:
        unmatched += 1
        continue
    if m == "spread" and num(r["lines"]) is not None:
        # Store as the expected home margin: positive when the home team is favored.
        lines[g["id"]]["spread"].append(-num(r["lines"]) if side == "home" else num(r["lines"]))
    elif m == "money_line" and num(r["odds"]) is not None and abs(num(r["odds"])) >= 100:
        lines[g["id"]][f"{side}ML"].append(num(r["odds"]))

med = lambda xs: round(statistics.median(xs) * 2) / 2 if xs else None
rows = []
for g in sorted(games.values(), key=lambda g: (g["season"], g["post"], g["week"], g["date"])):
    L = lines.get(g["id"], {})
    ml = lambda k: int(statistics.median(L[k])) if L.get(k) else None
    rows.append([int(g["id"]), g["season"], g["week"], g["post"], g["date"], g["home"], g["away"], g["hs"], g["as"],
                 g["neutral"], g["conf"], med(L.get("spread", [])), med(L.get("total", [])), ml("homeML"), ml("awayML")])

out = {
    "source": "sportsdataverse/cfbfastR-data (ESPN schedules, CollegeFootballData lines)",
    "seasons": [FIRST, LAST],
    "cols": ["id", "season", "week", "post", "date", "home", "away", "home_score", "away_score",
             "neutral", "conference_game", "spread", "total", "home_ml", "away_ml"],
    "teams": teams, "games": rows,
}
with open(OUT, "w") as f:
    json.dump(out, f, separators=(",", ":"))
with_spread = sum(1 for r in rows if r[11] is not None)
print(f"{len(rows)} games, {with_spread} with a closing spread, {len(teams)} teams, {unmatched} line rows not matched to a side")
for s in range(FIRST, LAST + 1):
    ss = [r for r in rows if r[1] == s]
    print(s, len(ss), "games", sum(r[11] is not None for r in ss), "spreads", sum(r[12] is not None for r in ss), "totals",
          sum(r[13] is not None for r in ss), "moneylines")
