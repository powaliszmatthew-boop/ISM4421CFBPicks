// Loading a college football season from the site's ESPN functions, shared by the game lines and
// player props pages. Bowl and playoff weeks are numbered 100 + week so every week sorts in order.
(function (root) {
  "use strict";

  const FN = "/.netlify/functions";

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

  // Which ESPN weeks of this season to load: every finished week, this week, and next week.
  // Leaves out the current week, which the caller already has.
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

  // Every week of a finished season, from its calendar.
  function allWeeks(cal) {
    const out = [];
    for (const t of cal.filter(c => c.type === 2 || c.type === 3)) for (const w of t.weeks) out.push([t.type, w.week]);
    return out;
  }

  const seq = (type, week) => (type === 3 ? 100 + week : week);

  root.CFBSeason = { FN, getJson, mapLimit, weeksToLoad, allWeeks, seq };
})(typeof window !== "undefined" ? window : globalThis);
