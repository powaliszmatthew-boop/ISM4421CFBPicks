// GridIron Edge CFB model: walk-forward, week-by-week online logistic regression,
// plus pricing every side at every sportsbook's own line and odds.
// Works in the browser (window.CFBModel) and in Node (module.exports).
(function (root) {
  "use strict";

  // ---- Tunable settings (chosen by backtest on 2016-2023, checked on 2024-2025) ----
  const ELO_K = 30;
  const ELO_HFA = 55;            // home-field advantage in Elo points
  const ELO_PER_POINT = 25;      // Elo points per point of expected margin
  const ELO_REGRESS = 0.3;       // pull toward the team's division mean at each new season
  const ELO_START = { fbs: 1500, fcs: 1200, other: 1050 };
  const FORM_ALPHA = 0.25;       // weight of the most recent game in rolling stats
  const FORM_REGRESS = 0.4;      // carry-over of rolling stats into a new season
  const LEAGUE_PPG = 28;
  const MARGIN_SD = 15.6;        // spread of final margins around the closing spread (2014-2025)
  const TOTAL_SD = 16.2;         // spread of final totals around the closing total
  const LR = { win: 0.01, cover: 0.004, total: 0.004 };
  const L2 = 1e-3;

  // ---- Odds helpers --------------------------------------------------------
  const impliedProb = am => (am < 0 ? -am / (-am + 100) : 100 / (am + 100));
  const decimalOdds = am => (am < 0 ? 1 + 100 / -am : 1 + am / 100);
  const sigmoid = z => 1 / (1 + Math.exp(-z));
  const logit = p => Math.log(p / (1 - p));
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const median = xs => {
    const s = xs.filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b);
    if (!s.length) return null;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // Normal CDF (Abramowitz-Stegun) and its inverse (Acklam).
  function normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }
  function normInv(p) {
    p = clamp(p, 1e-6, 1 - 1e-6);
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const q = p < 0.02425 ? Math.sqrt(-2 * Math.log(p)) : p > 1 - 0.02425 ? Math.sqrt(-2 * Math.log(1 - p)) : null;
    if (q !== null) {
      const x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
      return p < 0.5 ? x : -x;
    }
    const r = p - 0.5, s = r * r;
    return (((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r /
      (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1);
  }

  // No-vig market probability that the home team wins.
  function marketHomeProb(g) {
    if (g.homeML != null && g.awayML != null) {
      const h = impliedProb(g.homeML), a = impliedProb(g.awayML);
      return h / (h + a);
    }
    if (g.spread != null) return normCdf(g.spread / MARGIN_SD);
    return null;
  }

  // ---- Data ----------------------------------------------------------------
  // Game shape used everywhere:
  // { id, season, week, post, date, home, away, homeName, awayName, homeScore, awayScore, played,
  //   neutral, conf, spread (expected home margin, + = home favored), totalLine, homeML, awayML, books }
  function fromHistory(h) {
    const ix = Object.fromEntries(h.cols.map((c, i) => [c, i]));
    return h.games.map(r => ({
      id: String(r[ix.id]), season: r[ix.season], week: r[ix.week], post: r[ix.post] === 1, date: r[ix.date],
      home: String(r[ix.home]), away: String(r[ix.away]),
      homeName: (h.teams[r[ix.home]] || [])[0], awayName: (h.teams[r[ix.away]] || [])[0],
      homeScore: r[ix.home_score], awayScore: r[ix.away_score], played: true,
      neutral: r[ix.neutral] === 1, conf: r[ix.conference_game] === 1,
      spread: r[ix.spread], totalLine: r[ix.total], homeML: r[ix.home_ml], awayML: r[ix.away_ml],
    }));
  }

  // Consensus line across sportsbooks: median spread and total, moneylines from the median no-vig chance.
  function consensus(books) {
    const list = Object.values(books || {});
    const spread = median(list.map(b => b.homeSpread == null ? null : -b.homeSpread));
    const total = median(list.map(b => b.total));
    const pHome = median(list.filter(b => b.homeML != null && b.awayML != null).map(b => {
      const h = impliedProb(b.homeML), a = impliedProb(b.awayML);
      return h / (h + a);
    }));
    const ml = p => (p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p));
    return {
      spread: spread == null ? null : Math.round(spread * 2) / 2,
      totalLine: total == null ? null : Math.round(total * 2) / 2,
      homeML: pHome == null ? null : ml(pHome), awayML: pHome == null ? null : ml(1 - pHome),
    };
  }

  // ---- Logistic regression trained with SGD -------------------------------
  class OnlineLogit {
    constructor(names, lr, offsetIndex = -1) {
      this.names = names;
      this.offsetIndex = offsetIndex;   // feature added with a fixed weight of 1
      this.w = new Array(names.length).fill(0);
      this.lr = lr;
      this.seen = 0;
    }
    predict(x) {
      let z = this.offsetIndex >= 0 ? x[this.offsetIndex] : 0;
      for (let i = 0; i < x.length; i++) if (i !== this.offsetIndex) z += this.w[i] * x[i];
      return sigmoid(z);
    }
    update(x, y) {
      const err = y - this.predict(x);
      for (let i = 0; i < x.length; i++) {
        if (i === this.offsetIndex) continue;
        const reg = i === 0 ? 0 : L2 * this.w[i];
        this.w[i] += this.lr * (err * x[i] - reg);
      }
      this.seen++;
    }
  }

  const MODELS = {
    win: ["bias", "market log-odds (fixed)", "Elo edge", "point-diff form", "rest edge", "ATS form"],
    cover: ["bias", "Elo margin vs spread", "form margin vs spread", "spread size", "ATS form", "rest edge", "conference game"],
    total: ["bias", "form total vs line", "over/under form", "line size", "conference game"],
  };

  // ---- Team state ----------------------------------------------------------
  function newTeam(division) {
    const elo = ELO_START[division] ?? ELO_START.other;
    return { elo, base: elo, pf: LEAGUE_PPG, pa: LEAGUE_PPG, ats: 0, ou: 0, games: 0, season: null,
             w: 0, l: 0, lastDate: null };
  }

  function seasonReset(s, season) {
    if (s.season === season) return;
    if (s.season !== null) {
      s.elo = s.elo * (1 - ELO_REGRESS) + s.base * ELO_REGRESS;
      s.pf = s.pf * FORM_REGRESS + LEAGUE_PPG * (1 - FORM_REGRESS);
      s.pa = s.pa * FORM_REGRESS + LEAGUE_PPG * (1 - FORM_REGRESS);
      s.ats *= FORM_REGRESS;
      s.ou *= FORM_REGRESS;
      s.lastDate = null;
    }
    s.season = season;
    s.w = s.l = 0;
  }

  const days = (a, b) => (Date.parse(a) - Date.parse(b)) / 864e5;

  function features(g, H, A) {
    const hfa = g.neutral ? 0 : ELO_HFA;
    const eloDiff = H.elo + hfa - A.elo;
    const eloMargin = eloDiff / ELO_PER_POINT;
    const formMargin = ((H.pf - H.pa) - (A.pf - A.pa)) / 2 + (g.neutral ? 0 : 2.5);
    const rest = t => (t.lastDate ? clamp(days(g.date, t.lastDate), 3, 21) : 10);
    const restDiff = clamp((rest(H) - rest(A)) / 7, -2, 2);
    const spread = g.spread ?? eloMargin;
    const totalLine = g.totalLine ?? (H.pf + H.pa + A.pf + A.pa) / 2;
    const formTotal = (H.pf + A.pa + A.pf + H.pa) / 2;
    const pMkt = clamp(marketHomeProb(g) ?? normCdf(eloMargin / MARGIN_SD), 0.01, 0.99);
    return {
      eloDiff, eloMargin, formMargin, formTotal, pMkt, restDiff,
      win: [1, logit(pMkt), eloDiff / 100, ((H.pf - H.pa) - (A.pf - A.pa)) / 10, restDiff, (H.ats - A.ats) / 10],
      cover: [1, (eloMargin - spread) / 10, (formMargin - spread) / 10, spread / 10, (H.ats - A.ats) / 10, restDiff, g.conf ? 1 : 0],
      total: [1, (formTotal - totalLine) / 10, (H.ou + A.ou) / 10, (totalLine - 55) / 10, g.conf ? 1 : 0],
    };
  }

  function updateTeams(g, H, A) {
    const margin = g.homeScore - g.awayScore;
    const hfa = g.neutral ? 0 : ELO_HFA;
    const expHome = 1 / (1 + Math.pow(10, -(H.elo + hfa - A.elo) / 400));
    const actual = margin > 0 ? 1 : margin < 0 ? 0 : 0.5;
    const movMult = Math.log(Math.abs(margin) + 1) * (2.2 / ((actual === 1 ? 1 : -1) * (H.elo + hfa - A.elo) * 0.001 + 2.2));
    const delta = ELO_K * (margin === 0 ? 1 : movMult) * (actual - expHome);
    H.elo += delta; A.elo -= delta;

    const a = FORM_ALPHA;
    H.pf = H.pf * (1 - a) + g.homeScore * a; H.pa = H.pa * (1 - a) + g.awayScore * a;
    A.pf = A.pf * (1 - a) + g.awayScore * a; A.pa = A.pa * (1 - a) + g.homeScore * a;
    if (g.spread != null) {
      const atsHome = margin - g.spread;
      H.ats = H.ats * (1 - a) + atsHome * a; A.ats = A.ats * (1 - a) - atsHome * a;
    }
    if (g.totalLine != null) {
      const ou = g.homeScore + g.awayScore - g.totalLine;
      H.ou = H.ou * (1 - a) + ou * a; A.ou = A.ou * (1 - a) + ou * a;
    }
    H.games++; A.games++;
    H.lastDate = g.date; A.lastDate = g.date;
    if (margin > 0) { H.w++; A.l++; } else if (margin < 0) { H.l++; A.w++; }
  }

  // ---- Walk-forward run ----------------------------------------------------
  // For every week in order: predict all of that week's games using only data
  // from earlier weeks, then learn from that week's results before moving on.
  function run(games, divisions = {}) {
    const teams = {};
    const models = {
      win: new OnlineLogit(MODELS.win, LR.win, 1),
      cover: new OnlineLogit(MODELS.cover, LR.cover),
      total: new OnlineLogit(MODELS.total, LR.total),
    };
    const sorted = games.slice().sort((x, y) =>
      x.season - y.season || (x.post - y.post) || x.week - y.week || x.date.localeCompare(y.date));
    const weeks = [];
    for (const g of sorted) {
      const last = weeks[weeks.length - 1];
      if (last && last.season === g.season && last.post === g.post && last.week === g.week) last.games.push(g);
      else weeks.push({ season: g.season, post: g.post, week: g.week, games: [g] });
    }
    const team = (id, name) => {
      if (!teams[id]) teams[id] = { ...newTeam(divisions[id]), name, division: divisions[id] || "other" };
      if (name) teams[id].name = name;
      return teams[id];
    };

    const predictions = [];
    for (const wk of weeks) {
      const rows = wk.games.map(g => {
        const H = team(g.home, g.homeName), A = team(g.away, g.awayName);
        seasonReset(H, g.season);
        seasonReset(A, g.season);
        const f = features(g, H, A);
        const pred = {
          game: g, f,
          pHomeWin: models.win.predict(f.win),
          pHomeCover: models.cover.predict(f.cover),
          pOver: models.total.predict(f.total),
          homeElo: H.elo, awayElo: A.elo,
        };
        predictions.push(pred);
        return pred;
      });
      for (const p of rows) {
        const g = p.game;
        if (!g.played) continue;
        const margin = g.homeScore - g.awayScore;
        if (margin !== 0) models.win.update(p.f.win, margin > 0 ? 1 : 0);
        if (g.spread != null && margin !== g.spread) models.cover.update(p.f.cover, margin > g.spread ? 1 : 0);
        const total = g.homeScore + g.awayScore;
        if (g.totalLine != null && total !== g.totalLine) models.total.update(p.f.total, total > g.totalLine ? 1 : 0);
      }
      for (const p of rows) if (p.game.played) updateTeams(p.game, teams[p.game.home], teams[p.game.away]);
    }
    return { predictions, teams, models };
  }

  // ---- Pricing at any line ----------------------------------------------------
  // The cover and total models give a chance at the consensus line. Turning that into an
  // expected margin (or total) lets us price other books' lines, including pushes.
  function lineProbs(mean, sd, line) {
    // Chance the result lands over / exactly on / under `line` for whole-number outcomes.
    if (Number.isInteger(line)) {
      const lo = normCdf((line - 0.5 - mean) / sd), hi = normCdf((line + 0.5 - mean) / sd);
      return { over: 1 - hi, push: hi - lo, under: lo };
    }
    const under = normCdf((line - mean) / sd);
    return { over: 1 - under, push: 0, under };
  }

  function expected(p) {
    const g = p.game;
    const marginMean = g.spread != null ? g.spread + MARGIN_SD * normInv(p.pHomeCover) : p.f.eloMargin;
    const totalMean = g.totalLine != null ? g.totalLine + TOTAL_SD * normInv(p.pOver) : p.f.formTotal;
    return { marginMean, totalMean };
  }

  function option(p, market, side, label, prob, push, american, book) {
    const dec = decimalOdds(american), lose = 1 - prob - push;
    const ev = prob * (dec - 1) - lose;
    return { pred: p, market, side, label, prob, push, american, book,
             breakeven: (1 - push) / dec, ev, kelly: ev > 0 ? ev / (dec - 1) : 0 };
  }

  const fmtLine = x => (x > 0 ? `+${x}` : `${x}`);
  const fmtOdds = am => (am > 0 ? `+${am}` : `${am}`);

  // Every bettable side at every sportsbook, priced with the model.
  function betOptions(p) {
    const g = p.game, out = [];
    const { marginMean, totalMean } = expected(p);
    const books = g.books && Object.keys(g.books).length ? g.books
      : { consensus: { homeML: g.homeML, awayML: g.awayML, homeSpread: g.spread == null ? null : -g.spread,
          homeSpreadOdds: -110, awaySpreadOdds: -110, total: g.totalLine, overOdds: -110, underOdds: -110 } };
    for (const [book, b] of Object.entries(books)) {
      if (b.homeML != null && b.awayML != null) {
        out.push(option(p, "ML", "home", `${g.homeName} ML`, p.pHomeWin, 0, b.homeML, book));
        out.push(option(p, "ML", "away", `${g.awayName} ML`, 1 - p.pHomeWin, 0, b.awayML, book));
      }
      if (b.homeSpread != null) {
        const pr = lineProbs(marginMean, MARGIN_SD, -b.homeSpread);
        out.push(option(p, "ATS", "home", `${g.homeName} ${fmtLine(b.homeSpread)}`, pr.over, pr.push, b.homeSpreadOdds ?? -110, book));
        out.push(option(p, "ATS", "away", `${g.awayName} ${fmtLine(-b.homeSpread)}`, pr.under, pr.push, b.awaySpreadOdds ?? -110, book));
      }
      if (b.total != null) {
        const pr = lineProbs(totalMean, TOTAL_SD, b.total);
        out.push(option(p, "TOT", "over", `Over ${b.total}`, pr.over, pr.push, b.overOdds ?? -110, book));
        out.push(option(p, "TOT", "under", `Under ${b.total}`, pr.under, pr.push, b.underOdds ?? -110, book));
      }
    }
    return out;
  }

  // Best positive-EV side per market per game (shopping every book) above the edge threshold.
  function selectBets(preds, { minEdge = 0.03, markets = ["ML", "ATS", "TOT"], minProb = 0 } = {}) {
    const bets = [];
    for (const p of preds) {
      const opts = betOptions(p).filter(o => markets.includes(o.market));
      for (const m of markets) {
        const best = opts.filter(o => o.market === m).sort((a, b) => b.ev - a.ev)[0];
        if (best && best.ev >= minEdge && best.prob >= minProb) bets.push(best);
      }
    }
    return bets.sort((a, b) => b.ev - a.ev);
  }

  // Grading for the backtest, at the consensus line. 1 = win, 0 = loss, 0.5 = push, null = not graded.
  function grade(bet) {
    const g = bet.pred.game;
    if (!g.played) return null;
    const margin = g.homeScore - g.awayScore;
    if (bet.market === "ML") {
      if (margin === 0) return 0.5;
      return (margin > 0) === (bet.side === "home") ? 1 : 0;
    }
    if (bet.market === "ATS") {
      // bet.line is the home team's spread, so the home side covers when margin > -line.
      const t = -bet.line;
      if (margin === t) return 0.5;
      return (margin > t) === (bet.side === "home") ? 1 : 0;
    }
    const total = g.homeScore + g.awayScore;
    if (total === bet.line) return 0.5;
    return (total > bet.line) === (bet.side === "over") ? 1 : 0;
  }

  // Backtest bets: the model's sides at the closing consensus line (-110 for spreads and totals).
  function backtestBets(preds, settings) {
    return selectBets(preds.map(p => ({ ...p, game: { ...p.game, books: null } })), settings)
      .map(b => ({ ...b, line: b.market === "ATS" ? -b.pred.game.spread : b.market === "TOT" ? b.pred.game.totalLine : null }));
  }

  function profit(bet) {
    const r = grade(bet);
    if (r === null || r === 0.5) return 0;
    return r === 1 ? decimalOdds(bet.american) - 1 : -1;
  }

  function summarize(bets) {
    const s = { n: 0, w: 0, l: 0, p: 0, units: 0 };
    for (const b of bets) {
      const r = grade(b);
      if (r === null) continue;
      s.n++;
      if (r === 1) s.w++; else if (r === 0) s.l++; else s.p++;
      s.units += profit(b);
    }
    s.roi = s.n ? s.units / s.n : 0;
    s.hitRate = s.w + s.l ? s.w / (s.w + s.l) : 0;
    return s;
  }

  // Calibration metrics of the win model vs. the betting market.
  function winModelMetrics(preds) {
    let n = 0, correct = 0, mktCorrect = 0, brier = 0, mktBrier = 0;
    for (const p of preds) {
      const g = p.game;
      if (!g.played || g.homeScore === g.awayScore || marketHomeProb(g) == null) continue;
      const y = g.homeScore > g.awayScore ? 1 : 0;
      n++;
      correct += (p.pHomeWin > 0.5) === (y === 1) ? 1 : 0;
      mktCorrect += (p.f.pMkt > 0.5) === (y === 1) ? 1 : 0;
      brier += (p.pHomeWin - y) ** 2;
      mktBrier += (p.f.pMkt - y) ** 2;
    }
    return { n, acc: n ? correct / n : 0, mktAcc: n ? mktCorrect / n : 0,
             brier: n ? brier / n : 0, mktBrier: n ? mktBrier / n : 0 };
  }

  const api = { MODELS, MARGIN_SD, TOTAL_SD, fromHistory, consensus, run, betOptions, selectBets, backtestBets, grade,
                profit, summarize, winModelMetrics, marketHomeProb, expected, lineProbs, fmtLine, fmtOdds,
                impliedProb, decimalOdds, normCdf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CFBModel = api;
})(typeof window !== "undefined" ? window : globalThis);
