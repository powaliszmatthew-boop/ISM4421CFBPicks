// One week of college football player stat lines (passing, rushing, receiving) from ESPN box scores,
// for the player props model. Every finished game in the week involving an FBS team.
//   GET /.netlify/functions/player-stats?season=2026&type=2&week=9
// Response: { season, type, week, complete, cols, players: {id: name}, teams: {id: abbr},
//             rows: [[playerId, teamId, oppId, gameId, ...cols]] }

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard";
const SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; ISM4421CFBPicks/1.0)", Accept: "application/json" };
const FBS = 80;
export const STAT_COLS = [
  "completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions",
  "carries", "rushing_yards", "rushing_tds", "receptions", "receiving_yards", "receiving_tds",
];
// ESPN box score keys -> our columns. Passing's first key is "completions/passingAttempts" ("18/30").
const KEYS = {
  passing: { passingYards: "passing_yards", passingTouchdowns: "passing_tds", interceptions: "passing_interceptions" },
  rushing: { rushingAttempts: "carries", rushingYards: "rushing_yards", rushingTouchdowns: "rushing_tds" },
  receiving: { receptions: "receptions", receivingYards: "receiving_yards", receivingTouchdowns: "receiving_tds" },
};
// IDs and names end up in the page; anything that doesn't look like one is skipped.
const ID_RE = /^\d{1,12}$/;
const ABBR_RE = /^[A-Za-z0-9&.'-]{1,8}$/;

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  return res.json();
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const num = v => {
  const n = Number(String(v ?? "").replace("−", "-"));
  return Number.isFinite(n) ? n : 0;
};

// One game's box score -> stat lines keyed by player.
export function parseBox(summary, gameId, players, teams) {
  const sides = (summary.boxscore && summary.boxscore.players) || [];
  const teamIds = sides.map(s => s.team && String(s.team.id));
  const lines = new Map();
  sides.forEach((side, i) => {
    const team = teamIds[i], opp = teamIds[1 - i];
    if (!ID_RE.test(team || "") || !ID_RE.test(opp || "")) return;
    const abbr = side.team.abbreviation;
    if (ABBR_RE.test(abbr || "")) teams[team] = abbr;
    for (const cat of side.statistics || []) {
      const map = KEYS[cat.name];
      if (!map) continue;
      const keys = cat.keys || [];
      for (const a of cat.athletes || []) {
        const id = a.athlete && String(a.athlete.id), name = a.athlete && a.athlete.displayName;
        if (!ID_RE.test(id || "") || !name || name.length > 80) continue;   // skips the "Team" row (negative id)
        players[id] = name;
        let s = lines.get(id);
        if (!s) { s = { team, opp }; for (const c of STAT_COLS) s[c] = 0; lines.set(id, s); }
        keys.forEach((k, j) => {
          const v = (a.stats || [])[j];
          if (k === "completions/passingAttempts") {
            const [c, att] = String(v || "").split("/");
            s.completions += num(c); s.attempts += num(att);
          } else if (map[k]) s[map[k]] += num(v);
        });
      }
    }
  });
  return [...lines.entries()].map(([id, s]) => [id, s.team, s.opp, gameId, ...STAT_COLS.map(c => s[c])]);
}

export async function loadWeek({ season, type, week }) {
  const q = new URLSearchParams({ groups: String(FBS), limit: "500", dates: String(season), seasontype: String(type), week: String(week) });
  const sb = await getJson(`${SCOREBOARD}?${q}`);
  const events = sb.events || [];
  const done = events.filter(e => e.competitions && e.competitions[0] && e.competitions[0].status.type.completed);
  // Postponed or canceled games never finish; four days after kickoff they no longer hold the week open.
  const settled = e => done.includes(e) || Date.parse(e.date) < Date.now() - 4 * 86400e3;
  const players = {}, teams = {}, rows = [];
  let failed = 0;
  await mapLimit(done, 16, async e => {
    try {
      rows.push(...parseBox(await getJson(`${SUMMARY}?event=${e.id}`), String(e.id), players, teams));
    } catch {
      failed++;
    }
  });
  return {
    source: "ESPN box scores", fetchedAt: new Date().toISOString(), season: Number(season), type: Number(type), week: Number(week),
    games: done.length, failed, complete: events.length > 0 && events.every(settled) && failed === 0,
    cols: STAT_COLS, players, teams, rows,
  };
}

const json = (status, body, cdn, keep) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json", "Cache-Control": "public, max-age=300",
      ...(cdn ? { "Netlify-CDN-Cache-Control": cdn } : {}),
      // A finished week never changes, so it stays cached across deploys (the page adds a version to the URL).
      ...(keep ? { "Netlify-Cache-ID": "cfb-player-stats" } : {}),
    },
  });

export default async req => {
  const u = new URL(req.url);
  const season = Number(u.searchParams.get("season")), type = Number(u.searchParams.get("type") || 2), week = Number(u.searchParams.get("week"));
  if (!(season >= 2014 && season <= 2100) || ![2, 3].includes(type) || !(week >= 1 && week <= 20)) {
    return json(400, { error: "Pass season, type (2 or 3) and week" });
  }
  try {
    const body = await loadWeek({ season, type, week });
    return body.complete
      ? json(200, body, "public, durable, max-age=2592000", true)
      : json(200, body, "public, durable, max-age=900, stale-while-revalidate=300");
  } catch (err) {
    return json(502, { error: err.message });
  }
};
