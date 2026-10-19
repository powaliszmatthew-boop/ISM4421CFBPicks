// Live college football betting splits (% of money and % of bets on each side) and DraftKings
// odds from DraftKings Network's public splits page, keyed by DraftKings event id (ESPN's
// DraftKings links carry the same id, so games match exactly).
// Runs server-side because the page can't be fetched from the browser (CORS).

const PAGE = "https://dknetwork.draftkings.com/draftkings-sportsbook-betting-splits/";
const NCAAF_GROUP = "87637";
const MAX_PAGES = 10;

const text = html => html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const odds = s => {
  const n = Number(s.replace("−", "-").replace("+", ""));
  return Number.isFinite(n) ? n : null;
};

// DraftKings outcome ids end in _1 for the home side and _3 for the away side.
function parseRow(row, market) {
  const label = text((row.match(/tb-slipline[^>]*>([\s\S]*?)<\/div>/) || [])[1] || "");
  const price = text((row.match(/tb-odd-s[^>]*>([\s\S]*?)<\/a>/) || [])[1] || "");
  const href = (row.match(/outcomes=([^&"]+)/) || [])[1] || "";
  const pcts = [...row.matchAll(/<div class="flex-1">\s*(\d+)%/g)].map(m => Number(m[1]));
  let side = null, line = null;
  if (market === "total") {
    side = /^over/i.test(label) ? "over" : /^under/i.test(label) ? "under" : null;
    line = Number(label.split(" ").pop());
  } else {
    side = /_1$/.test(href) ? "home" : /_3$/.test(href) ? "away" : null;
    if (market === "spread") line = Number(label.split(" ").pop().replace("−", "-"));
  }
  return { side, label, odds: price ? odds(price) : null, line: Number.isFinite(line) ? line : null,
           handle: pcts[0] ?? null, bets: pcts[1] ?? null };
}

export function parsePage(html) {
  const games = [];
  for (const block of html.split(/class="tb-se /).slice(1)) {
    const event = (block.match(/sportsbook\.draftkings\.com\/event\/(\d+)/) || [])[1];
    if (!event) continue;
    const title = text((block.match(/<h5[^>]*>([\s\S]*?)<\/h5>/) || [])[1] || "");
    const [away, home] = title.split(" @ ");
    const time = text((block.match(/<\/h5>\s*<span[^>]*>([\s\S]*?)<\/span>/) || [])[1] || "");
    const game = { event, away, home, time, ml: null, spread: null, total: null };
    for (const m of block.split(/tb-se-head/).slice(1)) {
      const name = text((m.match(/<div class="flex-1">([\s\S]*?)<\/div>/) || [])[1] || "");
      const market = name === "Moneyline" ? "ml" : name === "Spread" ? "spread" : name === "Total" ? "total" : null;
      if (!market) continue;
      const bySide = {};
      for (const r of m.split(/tb-sodd/).slice(1).map(x => parseRow(x, market))) if (r.side) bySide[r.side] = r;
      game[market] = bySide;
    }
    games.push(game);
  }
  return games;
}

const json = (status, body, cdn) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60",
               ...(cdn ? { "Netlify-CDN-Cache-Control": cdn } : {}) },
  });

export default async () => {
  try {
    const games = [], seen = new Set();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${PAGE}?tb_eg=${NCAAF_GROUP}&tb_edate=n7days&tb_emt=0&tb_page=${page}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ISM4421CFBPicks/1.0)", Accept: "text/html" },
      });
      if (!res.ok) throw new Error(`DraftKings Network returned ${res.status}`);
      const found = parsePage(await res.text()).filter(g => !seen.has(g.event));
      found.forEach(g => seen.add(g.event));
      games.push(...found);
      if (found.length < 10) break;
    }
    return json(200, { source: "DraftKings Sportsbook (all jurisdictions)", fetchedAt: new Date().toISOString(), games },
      "public, durable, max-age=300");
  } catch (err) {
    return json(502, { error: err.message });
  }
};
