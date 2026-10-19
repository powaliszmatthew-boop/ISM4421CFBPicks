// College football lines from many sportsbooks at once (Hard Rock Bet, FanDuel, BetMGM, Caesars,
// ESPN BET, Fanatics, BetRivers, Bovada, DraftKings) via The Odds API (https://the-odds-api.com).
// Needs a free API key in the Netlify environment variable ODDS_API_KEY.
//
// Each refresh costs 3 credits (3 markets x up to 10 named books). The free plan has 500
// credits a month, so responses are cached for ODDS_REFRESH_MINUTES (default 300 = 5 hours,
// about 432 credits in a 30-day month). With a paid plan, set it lower (e.g. 15).

const SPORT = "americanfootball_ncaaf";
const BOOKS = ["hardrockbet_fl", "hardrockbet", "draftkings", "fanduel", "betmgm", "williamhill_us",
  "espnbet", "fanatics", "betrivers", "bovada"];

const json = (status, body, cdn) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300",
               ...(cdn ? { "Netlify-CDN-Cache-Control": cdn } : {}) },
  });

// One event's prices, by book, from the home team's point of view.
export function normalize(ev) {
  const books = {};
  for (const b of ev.bookmakers || []) {
    const out = { title: b.title, updated: b.last_update };
    for (const m of b.markets || []) {
      const by = name => m.outcomes.find(o => o.name === name);
      if (m.key === "h2h") {
        out.homeML = by(ev.home_team)?.price ?? null;
        out.awayML = by(ev.away_team)?.price ?? null;
      } else if (m.key === "spreads") {
        const h = by(ev.home_team), a = by(ev.away_team);
        if (h && h.point != null) {
          out.homeSpread = h.point;
          out.homeSpreadOdds = h.price;
          out.awaySpreadOdds = a ? a.price : null;
        }
      } else if (m.key === "totals") {
        const o = by("Over"), u = by("Under");
        if (o && o.point != null) {
          out.total = o.point;
          out.overOdds = o.price;
          out.underOdds = u ? u.price : null;
        }
      }
    }
    books[b.key] = out;
  }
  return { id: ev.id, commence: ev.commence_time, home: ev.home_team, away: ev.away_team, books };
}

export default async () => {
  const key = process.env.ODDS_API_KEY;
  if (!key) {
    return json(200, { enabled: false, reason: "Add a free The Odds API key as ODDS_API_KEY in Netlify to compare Hard Rock, FanDuel, BetMGM, Caesars and more." },
      "public, durable, max-age=600");
  }
  const minutes = Math.max(1, Number(process.env.ODDS_REFRESH_MINUTES) || 300);
  const q = new URLSearchParams({ apiKey: key, markets: "h2h,spreads,totals", oddsFormat: "american",
    dateFormat: "iso", bookmakers: BOOKS.join(",") });
  try {
    const res = await fetch(`https://api.the-odds-api.com/v4/sports/${SPORT}/odds?${q}`);
    const body = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(body)) throw new Error((body && body.message) || `The Odds API returned ${res.status}`);
    return json(200, {
      enabled: true, source: "The Odds API", fetchedAt: new Date().toISOString(), refreshMinutes: minutes,
      remaining: res.headers.get("x-requests-remaining"), events: body.map(normalize),
    }, `public, durable, max-age=${minutes * 60}`);
  } catch (err) {
    // Cache failures briefly so a bad key or an outage doesn't burn credits on every page load.
    return json(502, { enabled: true, error: err.message }, "public, durable, max-age=600");
  }
};
