// One week of FBS games from ESPN: teams, kickoff, live status and scores, and DraftKings lines.
// Upcoming games carry current and opening lines from the scoreboard. Finished games carry
// DraftKings' closing line from ESPN's per-game odds feed (the scoreboard drops it after kickoff).
//   GET /.netlify/functions/week                         -> the current week, plus the season calendar
//   GET /.netlify/functions/week?season=2026&type=2&week=7

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard";
const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; ISM4421CFBPicks/1.0)", Accept: "application/json" };
const FBS = 80;

const american = v => {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) && Math.abs(v) >= 100 ? Math.round(v) : null;
  const s = String(v).trim().toUpperCase().replace("−", "-");
  if (s === "EVEN" || s === "EV") return 100;
  const n = Number(s.replace("+", ""));
  return Number.isFinite(n) && Math.abs(n) >= 100 ? Math.round(n) : null;
};
const line = v => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/^[ou]/i, "").replace("−", "-").replace("+", ""));
  return Number.isFinite(n) ? n : null;
};
const dkEvent = obj => {
  const m = JSON.stringify(obj).match(/event(?:%2F|\/)(\d{6,})/);
  return m ? m[1] : null;
};

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  return res.json();
}

// Upcoming games: the scoreboard's odds block (DraftKings), with opening lines.
function scoreboardOdds(o) {
  if (!o) return null;
  const side = (m, s, k) => o[m] && o[m][s] && o[m][s][k];
  return {
    homeSpread: line(side("pointSpread", "home", "close")?.line) ?? (o.spread ?? null),
    homeSpreadOdds: american(side("pointSpread", "home", "close")?.odds) ?? -110,
    awaySpreadOdds: american(side("pointSpread", "away", "close")?.odds) ?? -110,
    total: line(side("total", "over", "close")?.line) ?? (o.overUnder ?? null),
    overOdds: american(side("total", "over", "close")?.odds) ?? -110,
    underOdds: american(side("total", "under", "close")?.odds) ?? -110,
    homeML: american(side("moneyline", "home", "close")?.odds),
    awayML: american(side("moneyline", "away", "close")?.odds),
    open: {
      homeSpread: line(side("pointSpread", "home", "open")?.line),
      total: line(side("total", "over", "open")?.line),
      homeML: american(side("moneyline", "home", "open")?.odds),
      awayML: american(side("moneyline", "away", "open")?.odds),
    },
  };
}

// Finished games: ESPN's per-game odds feed keeps DraftKings' final (closing) line.
async function closingOdds(id) {
  try {
    const j = await getJson(`${CORE}/events/${id}/competitions/${id}/odds`);
    const o = (j.items || []).find(x => x.provider && x.provider.name === "DraftKings") || (j.items || [])[0];
    if (!o) return { odds: null, event: null };
    return {
      event: dkEvent(o.links || []),
      odds: {
        homeSpread: o.spread ?? null,
        homeSpreadOdds: american(o.homeTeamOdds?.spreadOdds) ?? -110,
        awaySpreadOdds: american(o.awayTeamOdds?.spreadOdds) ?? -110,
        total: o.overUnder ?? null, overOdds: american(o.overOdds) ?? -110, underOdds: american(o.underOdds) ?? -110,
        homeML: american(o.homeTeamOdds?.moneyLine), awayML: american(o.awayTeamOdds?.moneyLine),
      },
    };
  } catch {
    return { odds: null, event: null };
  }
}

function team(c) {
  const rank = c.curatedRank && c.curatedRank.current;
  return {
    id: c.team.id, name: c.team.displayName, school: c.team.location, short: c.team.shortDisplayName,
    abbr: c.team.abbreviation, rank: rank && rank < 26 ? rank : null,
    score: c.score === "" || c.score == null ? null : Number(c.score),
    record: (c.records || []).find(r => r.type === "total")?.summary || null,
  };
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

export async function loadWeek(params) {
  const q = new URLSearchParams({ groups: String(FBS), limit: "500" });
  if (params.season) q.set("dates", params.season);
  if (params.type) q.set("seasontype", params.type);
  if (params.week) q.set("week", params.week);
  const sb = await getJson(`${SCOREBOARD}?${q}`);
  const season = sb.season.year, type = sb.season.type, week = sb.week ? sb.week.number : Number(params.week);
  const finished = [];
  const games = sb.events.map(e => {
    const c = e.competitions[0], st = c.status.type;
    const home = c.competitors.find(x => x.homeAway === "home"), away = c.competitors.find(x => x.homeAway === "away");
    const g = {
      id: e.id, season, type, week, date: e.date, state: st.state, completed: !!st.completed,
      detail: st.shortDetail || st.detail, neutral: !!c.neutralSite, conf: !!c.conferenceCompetition,
      home: team(home), away: team(away), dk: null, dkEvent: null,
    };
    if (c.odds && c.odds.length && st.state === "pre") {
      const o = c.odds.find(x => x.provider && x.provider.name === "DraftKings") || c.odds[0];
      g.dk = scoreboardOdds(o);
      g.dkEvent = dkEvent(o);
    } else finished.push(g);
    return g;
  });
  await mapLimit(finished, 16, async g => {
    const r = await closingOdds(g.id);
    g.dk = r.odds;
    g.dkEvent = r.event;
  });
  const calendar = (sb.leagues && sb.leagues[0] && sb.leagues[0].calendar || []).map(t => ({
    type: Number(t.value), label: t.label,
    weeks: (t.entries || []).map(w => ({ week: Number(w.value), label: w.label, start: w.startDate, end: w.endDate })),
  }));
  return { source: "ESPN (DraftKings lines)", fetchedAt: new Date().toISOString(), season, type, week, calendar, games };
}

const json = (status, body, cdn) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60",
               ...(cdn ? { "Netlify-CDN-Cache-Control": cdn } : {}) },
  });

export default async req => {
  const u = new URL(req.url);
  const params = { season: u.searchParams.get("season"), type: u.searchParams.get("type"), week: u.searchParams.get("week") };
  try {
    const body = await loadWeek(params);
    // A week where every game is final won't change, so keep it for a day. Otherwise refresh every 2 minutes.
    const done = body.games.length && body.games.every(g => g.completed);
    return json(200, body, done ? "public, durable, max-age=86400" : "public, durable, max-age=120, stale-while-revalidate=60");
  } catch (err) {
    return json(502, { error: err.message });
  }
};
