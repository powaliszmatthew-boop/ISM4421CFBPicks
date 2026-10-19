const M = window.CFBModel;
const T = window.GridIronTrack;
const $ = sel => document.querySelector(sel);
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const signed = (x, d = 1) => (x > 0 ? "+" : "") + x.toFixed(d);
const MARKET_NAMES = { ML: "Moneyline", ATS: "Spread", TOT: "Over/Under" };
const MAX_STAKE = 0.03;
const FN = "/.netlify/functions";
const REFRESH_MS = 3 * 60 * 1000;
const BOOKS_REFRESH_MS = 15 * 60 * 1000;
const GAMES_PAGE = 25;
const BOOK_NAMES = {
  draftkings: "DraftKings", hardrockbet: "Hard Rock Bet", hardrockbet_fl: "Hard Rock Bet (FL)", fanduel: "FanDuel",
  betmgm: "BetMGM", williamhill_us: "Caesars", espnbet: "theScore Bet", fanatics: "Fanatics", betrivers: "BetRivers",
  bovada: "Bovada", consensus: "Consensus",
};
const bookName = k => BOOK_NAMES[k] || k;
// "-10 -110" for spreads and totals, "-380" for moneylines.
const priceText = o => (o.market === "ML" ? M.fmtOdds(o.american) : `${o.label.split(" ").pop()} ${M.fmtOdds(o.american)}`);

let history = null;        // data/history.json
let seasonWeeks = new Map(); // "type|week" -> ESPN week payload for this season
let current = null;        // the current ESPN week payload
let splits = { status: "loading" };
let books = { status: "loading" };
let state = null;          // model output
let gamesShown = GAMES_PAGE;
const openGames = new Set();

function settings() {
  return {
    minEdge: Number($("#edge").value) / 100,
    markets: [...document.querySelectorAll(".markets input:checked")].map(i => i.value),
    bankroll: Math.max(0, Number($("#bankroll").value) || 0),
  };
}

const time = iso => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
function kickoff(g) {
  const d = new Date(g.kickoff);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + ", " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
const teamLabel = (t, rank) => `${rank ? `<span class="rank">#${rank}</span> ` : ""}${T.esc(t)}`;
const weekLabel = g => (g.post ? (g.week - 100 === 1 ? "Bowls" : "Playoff") : `Week ${g.week}`);

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${url} returned ${res.status}`);
  return body;
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// ---- Loading the season --------------------------------------------------------
// Which ESPN weeks of this season to load: every finished week, this week, and next week.
function weeksToLoad(cur) {
  const reg = cur.calendar.find(c => c.type === 2), post = cur.calendar.find(c => c.type === 3);
  const list = [];
  const regWeeks = reg ? reg.weeks.map(w => w.week) : [];
  if (cur.type === 2) {
    for (const w of regWeeks) if (w <= cur.week + 1) list.push([2, w]);
  } else if (cur.type === 3 || cur.type === 4) {
    for (const w of regWeeks) list.push([2, w]);
    if (post) for (const w of post.weeks) if (cur.type === 4 || w.week <= cur.week + 1) list.push([3, w.week]);
  }
  return list.filter(([t, w]) => !(t === cur.type && w === cur.week));
}

async function loadSeason() {
  current = await getJson(`${FN}/week`);
  seasonWeeks.set(`${current.type}|${current.week}`, current);
  await mapLimit(weeksToLoad(current), 4, async ([t, w]) => {
    try {
      seasonWeeks.set(`${t}|${w}`, await getJson(`${FN}/week?season=${current.season}&type=${t}&week=${w}`));
    } catch { /* a week that fails to load is skipped this time */ }
  });
}

async function refreshLive() {
  // The current and next week change during the season; finished weeks are cached.
  const cur = await getJson(`${FN}/week`);
  current = cur;
  seasonWeeks.set(`${cur.type}|${cur.week}`, cur);
  const next = `${cur.type}|${cur.week + 1}`;
  if (seasonWeeks.has(next)) {
    try { seasonWeeks.set(next, await getJson(`${FN}/week?season=${cur.season}&type=${cur.type}&week=${cur.week + 1}`)); } catch { /* keep old */ }
  }
}

async function loadSplits() {
  try {
    const body = await getJson(`${FN}/splits`);
    splits = { status: "ok", ...body, byEvent: new Map(body.games.map(g => [g.event, g])) };
  } catch (err) {
    splits = { status: "error", error: err.message };
  }
}

// One Odds API event's prices, by book, from the home team's point of view.
function normalizeEvent(ev) {
  const out = {};
  for (const b of ev.bookmakers || []) {
    const row = { title: b.title, updated: b.last_update };
    for (const m of b.markets || []) {
      const by = name => m.outcomes.find(o => o.name === name);
      if (m.key === "h2h") {
        row.homeML = by(ev.home_team)?.price ?? null;
        row.awayML = by(ev.away_team)?.price ?? null;
      } else if (m.key === "spreads") {
        const h = by(ev.home_team), a = by(ev.away_team);
        if (h && h.point != null) { row.homeSpread = h.point; row.homeSpreadOdds = h.price; row.awaySpreadOdds = a ? a.price : null; }
      } else if (m.key === "totals") {
        const o = by("Over"), u = by("Under");
        if (o && o.point != null) { row.total = o.point; row.overOdds = o.price; row.underOdds = u ? u.price : null; }
      }
    }
    out[b.key] = row;
  }
  return { id: ev.id, commence: ev.commence_time, home: ev.home_team, away: ev.away_team, books: out };
}

// Other sportsbooks: Supabase fetches them from The Odds API every 5 hours in season (the key
// stays in Supabase Vault) and caches them in odds_cache. The Netlify books function is a fallback
// for setups that put ODDS_API_KEY in Netlify instead.
async function loadBooks() {
  try {
    const sb = window.GridIronAuth && window.GridIronAuth.client;
    const { data, error } = sb ? await sb.from("odds_cache").select("fetched_at, remaining, body").eq("id", 1).maybeSingle()
      : { data: null, error: null };
    if (!error && data && Array.isArray(data.body) && data.fetched_at) {
      books = { status: "ok", source: "The Odds API", fetchedAt: data.fetched_at, refreshMinutes: 300,
        remaining: data.remaining, events: data.body.map(normalizeEvent) };
      return;
    }
    const body = await getJson(`${FN}/books`);
    books = body.enabled ? { status: "ok", ...body } : { status: "off", reason: body.reason };
  } catch (err) {
    books = { status: "error", error: err.message };
  }
}

// ---- Matching other books' events to ESPN games --------------------------------------
const norm = s => String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const tokens = s => new Set(norm(s).split(" ").filter(Boolean));
function similar(a, b) {
  if (norm(a) === norm(b)) return 1;
  const x = tokens(a), y = tokens(b);
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / Math.max(x.size, y.size, 1);
}

function attachBooks(espnGames) {
  if (books.status !== "ok") return;
  const pool = espnGames.filter(g => g.state === "pre");
  for (const ev of books.events) {
    let best = null, bestScore = 0;
    for (const g of pool) {
      if (Math.abs(Date.parse(ev.commence) - Date.parse(g.date)) > 36 * 3600e3) continue;
      const straight = Math.min(similar(ev.home, g.home.name), similar(ev.away, g.away.name));
      const swapped = Math.min(similar(ev.home, g.away.name), similar(ev.away, g.home.name));
      const score = Math.max(straight, swapped);
      if (score > bestScore) { best = { g, swapped: swapped > straight }; bestScore = score; }
    }
    if (!best || bestScore < 0.6) continue;
    const { g, swapped } = best;
    g.books = g.books || {};
    for (const [key, raw] of Object.entries(ev.books)) {
      if (key === "draftkings" && g.dk) continue;   // ESPN's DraftKings line refreshes more often
      const b = swapped ? {
        title: raw.title, updated: raw.updated, homeML: raw.awayML, awayML: raw.homeML,
        homeSpread: raw.homeSpread == null ? null : -raw.homeSpread, homeSpreadOdds: raw.awaySpreadOdds, awaySpreadOdds: raw.homeSpreadOdds,
        total: raw.total, overOdds: raw.overOdds, underOdds: raw.underOdds,
      } : raw;
      // A line far from DraftKings' (say +10 where DraftKings has -10) means the match went wrong; skip it.
      if (g.dk && g.dk.homeSpread != null && b.homeSpread != null && Math.abs(b.homeSpread - g.dk.homeSpread) > 7) continue;
      g.books[key] = b;
    }
  }
}

// ESPN game -> the model's game shape.
function toModelGame(e) {
  const post = e.type === 3;
  const bk = { ...(e.books || {}) };
  if (e.dk) bk.draftkings = e.dk;
  const c = M.consensus(bk);
  return {
    id: e.id, season: e.season, week: post ? 100 + e.week : e.week, post, date: e.date.slice(0, 10), kickoff: e.date,
    home: e.home.id, away: e.away.id, homeName: e.home.short || e.home.school, awayName: e.away.short || e.away.school,
    homeSchool: e.home.school, awaySchool: e.away.school, homeRank: e.home.rank, awayRank: e.away.rank,
    homeRecord: e.home.record, awayRecord: e.away.record,
    homeScore: e.home.score, awayScore: e.away.score, played: e.completed && e.home.score != null,
    state: e.state, detail: e.detail, neutral: e.neutral, conf: e.conf,
    spread: c.spread, totalLine: c.totalLine, homeML: c.homeML, awayML: c.awayML,
    books: bk, open: e.dk && e.dk.open, dkEvent: e.dkEvent,
  };
}

function buildModel() {
  const espn = [...seasonWeeks.values()].flatMap(w => w.games);
  const unique = [...new Map(espn.map(g => [g.id, { ...g, books: null }])).values()];
  attachBooks(unique);
  const divisions = Object.fromEntries(Object.entries(history.teams).map(([id, t]) => [id, t[1]]));
  const histGames = M.fromHistory(history).filter(g => g.season < current.season);
  const seasonGames = unique.map(toModelGame);
  const { predictions, teams, models } = M.run([...histGames, ...seasonGames], divisions);
  const upcoming = predictions.filter(p => p.game.season === current.season && p.game.state === "pre")
    .sort((a, b) => a.game.kickoff.localeCompare(b.game.kickoff));
  const played = predictions.filter(p => p.game.played);
  state = { predictions, teams, models, upcoming, played, season: current.season,
    lastPlayed: played.length ? played[played.length - 1].game : null };
}

// ---- Rendering -----------------------------------------------------------------
function trackedBet(o, stake) {
  const g = o.pred.game, b = g.books[o.book] || {};
  let line = null;
  if (o.market === "ATS") line = o.side === "home" ? b.homeSpread : -b.homeSpread;
  if (o.market === "TOT") line = b.total;
  if (stake == null) stake = o.ev > 0 ? settings().bankroll * Math.min(MAX_STAKE, o.kelly / 4) : T.defaultStake();
  return {
    kind: "game", description: `${o.label} (${g.awayName} @ ${g.homeName}) · ${bookName(o.book)}`, odds: o.american,
    stake: Math.round(stake * 100) / 100, model_prob: Number(o.prob.toFixed(5)), edge: Number(o.ev.toFixed(5)),
    market: o.market, game_id: g.id, side: o.side, line, season: g.season, week: g.week,
  };
}

function splitFor(g, market, side) {
  if (splits.status !== "ok" || !g.dkEvent) return null;
  const s = splits.byEvent.get(g.dkEvent);
  const key = { ML: "ml", ATS: "spread", TOT: "total" }[market];
  return s && s[key] && s[key][side] || null;
}

function reasons(o) {
  const p = o.pred, g = p.game, f = p.f, out = [];
  const { marginMean, totalMean } = M.expected(p);
  if (o.market === "TOT") {
    out.push(`Model expects ${totalMean.toFixed(1)} points vs. a consensus total of ${g.totalLine ?? "–"}`);
    out.push(`Recent scoring projects ${f.formTotal.toFixed(1)} points`);
  } else {
    out.push(`Model expects ${g.homeName} by ${signed(marginMean)} (consensus ${g.homeName} ${g.spread == null ? "–" : M.fmtLine(-g.spread)})`);
    out.push(`Elo ratings: ${g.homeName} ${Math.round(p.homeElo)}, ${g.awayName} ${Math.round(p.awayElo)}${g.neutral ? " (neutral site)" : ""}`);
  }
  out.push(`Model ${pct(o.prob, 1)} vs. ${pct(o.breakeven, 1)} needed at ${bookName(o.book)}`);
  const sp = splitFor(g, o.market, o.side);
  if (sp && sp.handle != null) out.push(`DraftKings: ${sp.handle}% of the money and ${sp.bets}% of bets are on this side`);
  return out;
}

function renderPicks() {
  const s = settings();
  const bets = M.selectBets(state.upcoming, s);
  const box = $("#picks");
  box.innerHTML = "";
  if (!state.upcoming.length) {
    $("#picks-sub").textContent = "No upcoming games with lines right now. Check back when the next week's odds are posted.";
    return;
  }
  $("#picks-sub").textContent = bets.length
    ? `${bets.length} bet${bets.length > 1 ? "s" : ""} clear a ${pct(s.minEdge)} edge across ${state.upcoming.length} upcoming games, best first.`
    : `None of the ${state.upcoming.length} upcoming games clear a ${pct(s.minEdge)} edge. Passing is a valid bet. Lower the edge to see weaker leans.`;
  for (const b of bets) {
    const g = b.pred.game;
    const stake = s.bankroll * Math.min(MAX_STAKE, b.kelly / 4);
    const others = M.betOptions(b.pred).filter(o => o.market === b.market && o.side === b.side && o.book !== b.book)
      .sort((x, y) => y.ev - x.ev).slice(0, 4);
    const card = document.createElement("article");
    card.className = "pick";
    card.innerHTML = `
      <div class="pick-top">
        <span class="badge ${b.market}">${MARKET_NAMES[b.market]}</span>
        <span class="muted">${weekLabel(g)} · ${kickoff(g)}</span>
      </div>
      <h3>${T.esc(b.label)} <span class="odds">${M.fmtOdds(b.american)}</span></h3>
      <p class="matchup">${teamLabel(g.awaySchool, g.awayRank)} @ ${teamLabel(g.homeSchool, g.homeRank)}${g.neutral ? " (neutral)" : ""}</p>
      <p class="best-book">Best price: <strong>${bookName(b.book)}</strong>${others.length ? ` <span class="muted small">· also ${others.map(o => `${bookName(o.book)} ${priceText(o)}`).join(", ")}</span>` : ""}</p>
      <div class="meter" title="Model probability vs. break-even">
        <div class="fill" style="width:${(b.prob * 100).toFixed(1)}%"></div>
        <div class="mark" style="left:${(b.breakeven * 100).toFixed(1)}%"></div>
      </div>
      <dl class="stats">
        <div><dt>Win chance</dt><dd>${pct(b.prob, 1)}</dd></div>
        <div><dt>Edge (EV)</dt><dd class="pos">${signed(b.ev * 100)}%</dd></div>
        <div><dt>Suggested stake</dt><dd>$${stake.toFixed(2)}</dd></div>
      </dl>
      <ul class="why">${reasons(b).map(r => `<li>${T.esc(r)}</li>`).join("")}</ul>
      <div class="card-actions">${T.actions(trackedBet(b, stake), { track: "Track bet" })}</div>`;
    box.appendChild(card);
  }
}

// The best price for each side of a game across every book.
function bestSides(p) {
  const best = {};
  for (const o of M.betOptions(p)) {
    const k = `${o.market}|${o.side}`;
    if (!best[k] || o.ev > best[k].ev) best[k] = o;
  }
  return best;
}

function booksTable(p) {
  const g = p.game, opts = M.betOptions(p);
  const cell = (book, market, side) => {
    const o = opts.find(x => x.book === book && x.market === market && x.side === side);
    if (!o) return "<td class=\"muted\">–</td>";
    return `<td><div class="price"><span><strong>${T.esc(priceText(o))}</strong></span>
      <span class="small ${o.ev >= 0 ? "pos" : "neg"}">${signed(o.ev * 100)}%</span></div>
      ${T.actions(() => trackedBet(o))}</td>`;
  };
  const rows = Object.keys(g.books).sort((a, b) => bookName(a).localeCompare(bookName(b))).map(book => `<tr>
    <th scope="row">${bookName(book)}${g.books[book].updated ? `<div class="muted small">${time(g.books[book].updated)}</div>` : ""}</th>
    ${cell(book, "ATS", "away")}${cell(book, "ATS", "home")}${cell(book, "TOT", "over")}${cell(book, "TOT", "under")}
    ${cell(book, "ML", "away")}${cell(book, "ML", "home")}</tr>`).join("");
  return `<div class="scroll"><table class="table books-table"><thead><tr><th>Book</th>
    <th>${T.esc(g.awayName)} spread</th><th>${T.esc(g.homeName)} spread</th><th>Over</th><th>Under</th>
    <th>${T.esc(g.awayName)} ML</th><th>${T.esc(g.homeName)} ML</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted small">Each cell shows the line and odds, then the model's edge at that price.${g.open && g.open.homeSpread != null ?
      ` DraftKings opened ${T.esc(g.homeName)} ${M.fmtLine(g.open.homeSpread)}, total ${g.open.total ?? "–"}.` : ""}</p>`;
}

function renderGames() {
  const term = $("#search").value.trim().toLowerCase(), rankedOnly = $("#ranked").checked;
  const list = state.upcoming.filter(p => {
    const g = p.game;
    if (rankedOnly && !g.homeRank && !g.awayRank) return false;
    return !term || [g.homeSchool, g.awaySchool, g.homeName, g.awayName].some(x => String(x || "").toLowerCase().includes(term));
  });
  const shown = list.slice(0, gamesShown);
  $("#games").innerHTML = shown.map(p => {
    const g = p.game, best = bestSides(p), { marginMean, totalMean } = M.expected(p);
    const side = (k, title) => {
      const o = best[k];
      if (!o) return `<div class="side-best"><div class="muted small">${title}</div><div class="muted">–</div></div>`;
      const sp = splitFor(g, o.market, o.side);
      return `<div class="side-best"><div class="muted small">${title}</div>
        <div><strong>${T.esc(priceText(o))}</strong> <span class="muted small">${bookName(o.book)}</span></div>
        <div class="small"><span class="${o.ev >= 0 ? "pos" : "neg"}">${signed(o.ev * 100)}%</span> · model ${pct(o.prob)}${sp && sp.handle != null ? ` · ${sp.handle}% $` : ""}</div></div>`;
    };
    const nBooks = Object.keys(g.books).length;
    return `<article class="game" data-game="${g.id}">
      <div class="game-head">
        <div><strong>${teamLabel(g.awaySchool, g.awayRank)}</strong> <span class="muted small">${g.awayRecord || ""}</span>
          <span class="muted">${g.neutral ? "vs" : "@"}</span>
          <strong>${teamLabel(g.homeSchool, g.homeRank)}</strong> <span class="muted small">${g.homeRecord || ""}</span></div>
        <div class="muted small">${weekLabel(g)} · ${kickoff(g)}</div>
      </div>
      <p class="small game-model">Consensus: ${g.spread == null ? "no line yet" : `${T.esc(g.homeName)} ${M.fmtLine(-g.spread)}`}, total ${g.totalLine ?? "–"} ·
        Model: ${T.esc(g.homeName)} wins ${pct(p.pHomeWin)}, by ${signed(marginMean)}, ${totalMean.toFixed(1)} total points</p>
      <div class="sides">
        ${side("ATS|away", `${T.esc(g.awayName)} spread`)}${side("ATS|home", `${T.esc(g.homeName)} spread`)}
        ${side("TOT|over", "Over")}${side("TOT|under", "Under")}
        ${side("ML|away", `${T.esc(g.awayName)} ML`)}${side("ML|home", `${T.esc(g.homeName)} ML`)}
      </div>
      ${nBooks ? `<details class="all-books"${openGames.has(g.id) ? " open" : ""}><summary>All books (${nBooks})</summary>${booksTable(p)}</details>` : ""}
    </article>`;
  }).join("") || '<p class="muted">No upcoming games match.</p>';
  $("#games-more").hidden = list.length <= gamesShown;
  $("#games-more").textContent = `Show more games (${list.length - gamesShown} more)`;
}

$("#games").addEventListener("toggle", e => {
  const d = e.target.closest("details.all-books");
  if (!d) return;
  const id = d.closest("[data-game]").dataset.game;
  if (d.open) openGames.add(id); else openGames.delete(id);
}, true);

function renderRecord() {
  const s = settings();
  const season = Number($("#season").value);
  const preds = state.predictions.filter(p => p.game.season === season && p.game.played);
  const bets = M.backtestBets(preds, s);
  const sum = M.summarize(bets);
  const wm = M.winModelMetrics(preds);
  const tile = (label, value, cls = "") => `<div class="tile"><div class="muted small">${label}</div><div class="big ${cls}">${value}</div></div>`;
  $("#tiles").innerHTML =
    tile("Bets", sum.n) +
    tile("Record (W-L-P)", `${sum.w}-${sum.l}-${sum.p}`) +
    tile("Hit rate", sum.w + sum.l ? pct(sum.hitRate, 1) : "–") +
    tile("Units won", signed(sum.units, 2), sum.units >= 0 ? "pos" : "neg") +
    tile("ROI", sum.n ? signed(sum.roi * 100) + "%" : "–", sum.roi >= 0 ? "pos" : "neg") +
    tile("Winner picked (model / market)", wm.n ? `${pct(wm.acc, 1)} / ${pct(wm.mktAcc, 1)}` : "–");
  const weeks = new Map();
  for (const p of preds) if (!weeks.has(p.game.week)) weeks.set(p.game.week, { label: weekLabel(p.game), bets: [] });
  for (const b of bets) weeks.get(b.pred.game.week).bets.push(b);
  let cum = 0;
  const rows = [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => {
    const ws = M.summarize(w.bets);
    cum += ws.units;
    return { label: w.label, ...ws, cum };
  });
  $("#weekly").innerHTML = `<thead><tr><th>Week</th><th>Bets</th><th>W-L-P</th><th>Units</th><th>Running total</th></tr></thead><tbody>${
    rows.map(r => `<tr><td>${r.label}</td><td>${r.n}</td><td>${r.w}-${r.l}-${r.p}</td>
      <td class="${r.units >= 0 ? "pos" : "neg"}">${signed(r.units, 2)}</td>
      <td class="${r.cum >= 0 ? "pos" : "neg"}">${signed(r.cum, 2)}</td></tr>`).join("") ||
    '<tr><td colspan="5" class="muted">No completed games yet.</td></tr>'}</tbody>`;
  renderChart(rows);
}

function renderChart(rows) {
  if (rows.length < 2) { $("#chart").innerHTML = ""; return; }
  const W = 600, H = 160, pad = 28, padRight = 56;
  const vals = [0, ...rows.map(r => r.cum)];
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const x = i => pad + (i * (W - pad - padRight)) / (vals.length - 1);
  const y = v => pad / 2 + ((hi - v) * (H - pad)) / span;
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = vals[vals.length - 1];
  $("#chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Running units won by week, ending at ${signed(last, 2)}">
    <line x1="${pad}" x2="${W - padRight}" y1="${y(0)}" y2="${y(0)}" class="zero"/>
    <text x="${pad - 4}" y="${y(0) + 4}" text-anchor="end" class="axis">0</text>
    <polyline points="${pts}" class="${last >= 0 ? "up" : "down"}"/>
    <text x="${W - padRight + 6}" y="${y(last) + 4}" class="axis">${signed(last, 1)}u</text>
  </svg>`;
}

function renderPower() {
  const teams = Object.entries(state.teams).filter(([, t]) => t.division === "fbs" && t.season === state.season)
    .sort((a, b) => b[1].elo - a[1].elo).slice(0, 25);
  $("#power").innerHTML = `<thead><tr><th>#</th><th>Team</th><th>Record</th><th>Elo</th>
    <th>Pts for</th><th>Pts against</th><th>ATS form</th></tr></thead><tbody>${
    teams.map(([, t], i) => `<tr><td>${i + 1}</td><td><strong>${T.esc(t.name)}</strong></td>
      <td>${t.w}-${t.l}</td><td>${Math.round(t.elo)}</td>
      <td>${t.pf.toFixed(1)}</td><td>${t.pa.toFixed(1)}</td>
      <td class="${t.ats >= 0 ? "pos" : "neg"}">${signed(t.ats)}</td></tr>`).join("")}</tbody>`;
}

function renderSources() {
  const parts = [`<li><strong>DraftKings</strong> via ESPN · updated ${time(current.fetchedAt)}</li>`];
  parts.push(splits.status === "ok"
    ? `<li><strong>DraftKings betting splits</strong> · ${splits.games.length} games · updated ${time(splits.fetchedAt)}</li>`
    : `<li class="muted"><strong>DraftKings betting splits</strong> unavailable${splits.error ? ` (${T.esc(splits.error)})` : ""}</li>`);
  if (books.status === "ok") {
    const names = new Set(books.events.flatMap(e => Object.keys(e.books)));
    parts.push(`<li><strong>${[...names].filter(k => k !== "draftkings").map(bookName).join(", ") || "No other books"}</strong> via The Odds API · ${books.events.length} games · updated ${time(books.fetchedAt)} (refreshes every ${books.refreshMinutes >= 60 ? `${Math.round(books.refreshMinutes / 60)} hours` : `${books.refreshMinutes} min`})</li>`);
  } else if (books.status === "off") {
    parts.push('<li class="muted"><strong>Hard Rock Bet, FanDuel, BetMGM, Caesars and more</strong> need a free The Odds API key (see README). Until then, lines come from DraftKings.</li>');
  } else if (books.status === "error") {
    parts.push(`<li class="muted"><strong>Other sportsbooks</strong> unavailable (${T.esc(books.error)})</li>`);
  }
  $("#sources").innerHTML = `<ul class="source-list">${parts.join("")}</ul>`;
}

function renderStatus() {
  const lp = state.lastPlayed;
  $("#status").textContent = `Trained on ${state.played.length.toLocaleString()} games through ${lp ? `${lp.season} ${weekLabel(lp)}` : "last season"}. ` +
    `${state.upcoming.length} upcoming FBS games. Lines refresh automatically every few minutes.`;
}

function renderAccuracy() {
  const recent = state.predictions.filter(p => p.game.played && p.game.season >= 2024 && p.game.season < state.season);
  const wm = M.winModelMetrics(recent);
  const sum = m => M.summarize(M.backtestBets(recent, { minEdge: 0.03, markets: [m] }));
  const ats = sum("ATS"), tot = sum("TOT");
  $("#accuracy").textContent = `Over the 2024 and 2025 seasons, picked walk-forward with only earlier games: the model picked the winner ${pct(wm.acc, 1)} of the time vs. ${pct(wm.mktAcc, 1)} for the betting favorite. ` +
    `Spread picks at a 3% edge went ${ats.w}-${ats.l} (${pct(ats.hitRate, 1)}), and over/under picks went ${tot.w}-${tot.l} (${pct(tot.hitRate, 1)}). Break-even at -110 is 52.4%. ` +
    `In short, the model is about as sharp as the closing line, not reliably better, so look for picks where you can get a better number than the market.`;
}

function renderAll() {
  $("#edge-out").textContent = `${$("#edge").value}%`;
  renderPicks();
  renderGames();
  renderRecord();
}

function rebuild() {
  buildModel();
  renderStatus();
  renderSources();
  renderAll();
  renderPower();
}

async function init() {
  try {
    const [h] = await Promise.all([getJson("data/history.json"), loadSeason(), loadSplits(), loadBooks()]);
    history = h;
    buildModel();
    const seasons = [...new Set(state.played.filter(p => p.game.season >= 2016).map(p => p.game.season))].reverse();
    $("#season").innerHTML = seasons.map(s => `<option>${s}</option>`).join("");
    renderStatus();
    renderSources();
    renderAll();
    renderPower();
    renderAccuracy();
    $("#edge").addEventListener("input", renderAll);
    $("#bankroll").addEventListener("input", () => { renderPicks(); renderGames(); });
    $("#season").addEventListener("change", renderRecord);
    $("#search").addEventListener("input", () => { gamesShown = GAMES_PAGE; renderGames(); });
    $("#ranked").addEventListener("change", () => { gamesShown = GAMES_PAGE; renderGames(); });
    $("#games-more").addEventListener("click", () => { gamesShown += GAMES_PAGE; renderGames(); });
    document.querySelectorAll(".markets input").forEach(i => i.addEventListener("change", renderAll));
    setInterval(async () => {
      await Promise.all([refreshLive().catch(() => {}), loadSplits()]);
      rebuild();
    }, REFRESH_MS);
    setInterval(async () => { await loadBooks(); rebuild(); }, BOOKS_REFRESH_MS);
  } catch (err) {
    $("#status").textContent = `Couldn't load college football data: ${err.message}. Check your connection and reload.`;
    $("#status").classList.add("error");
  }
}

// auth.js calls start() once someone signs in; later sign-ins just re-render with their settings.
let started = false;
window.GridIron = {
  start() {
    if (!started) { started = true; init(); }
    else if (state) renderAll();
  },
};
