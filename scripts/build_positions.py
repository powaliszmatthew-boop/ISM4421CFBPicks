"""Builds data/positions.json: the position (QB, RB, WR or TE) of every college player on an
FBS or FCS roster, keyed by ESPN athlete ID. ESPN box scores don't list positions, so the player
props model reads them from here. Players missing from the rosters (late additions) get a
position from their stats instead (see props.js).

Source: sportsdataverse/cfbfastR-data rosters (CollegeFootballData, ESPN athlete IDs).
Run each preseason and once or twice during the season:  python3 scripts/build_positions.py 2026
"""
import csv, io, json, sys, urllib.request

RAW = "https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/rosters/csv/cfb_rosters_{}.csv"
SEASON = int(sys.argv[1]) if len(sys.argv) > 1 else 2026
OUT = "data/positions.json"
KEEP = {"QB": "QB", "RB": "RB", "FB": "RB", "WR": "WR", "TE": "TE"}

positions = {}
# Last season first, so this season's roster wins when a player changed position.
for season in (SEASON - 1, SEASON):
    try:
        with urllib.request.urlopen(RAW.format(season)) as r:
            text = r.read().decode()
    except Exception as err:  # this season's roster may not be published yet
        print(f"skipped {season}: {err}")
        continue
    n = 0
    for row in csv.DictReader(io.StringIO(text)):
        pid, pos = row["athlete_id"].strip(), row["position"].strip().upper()
        if not pid.isdigit():
            continue
        if pos in KEEP:
            positions[pid] = KEEP[pos]
            n += 1
        elif pos not in ("", "NA", "?", "ATH"):
            positions.pop(pid, None)   # moved to defense or special teams
    print(f"{season}: {n} QB/RB/WR/TE")

with open(OUT, "w") as f:
    json.dump({"source": "sportsdataverse/cfbfastR-data rosters", "seasons": [SEASON - 1, SEASON],
               "positions": dict(sorted(positions.items(), key=lambda kv: int(kv[0])))}, f, separators=(",", ":"))
print(f"wrote {len(positions)} players to {OUT}")
