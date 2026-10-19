# ISM4421CFBPicks: GridIron Edge CFB

College football betting picks from a model that learns week to week, priced against every sportsbook it can reach, with a bet and parlay tracker.

## Pages

- **Game picks** (`index.html`): recommended bets at the sportsbook with the best price, a line-shopping card for every upcoming FBS game (best price per side, every book's line, the model's edge at each, DraftKings money and bet percentages), a season-by-season track record, and Elo power rankings. Every side at every book has **Track** and **+ Parlay** buttons.
- **My bets** (`bets.html`): every bet and parlay you track, with record, profit, ROI, and a running-profit chart. Odds, stake, and results can be edited in place. Bets and parlay legs tracked from the picks page settle automatically from ESPN final scores.
- **Parlay slip** (bottom left of every page): combined odds, the model's chance, edge, and payout. It warns about same-game legs.

## Where the data comes from

| Source | What | Refresh | Key needed |
|---|---|---|---|
| `data/history.json` | Every FBS game since 2014 with scores and the consensus (median) closing spread, total, and moneylines | Rebuilt each offseason | No |
| ESPN (`netlify/functions/week.mjs`) | This season's schedule, live scores, DraftKings lines with openers, and DraftKings closing lines for finished games | 2 minutes (finished weeks: 1 day) | No |
| DraftKings Network (`netlify/functions/splits.mjs`) | DraftKings odds plus % of money and % of bets on each side | 5 minutes | No |
| The Odds API (`netlify/functions/books.mjs`) | Hard Rock Bet (and Hard Rock FL), FanDuel, BetMGM, Caesars, ESPN BET, Fanatics, BetRivers, Bovada | `ODDS_REFRESH_MINUTES` (default 300) | Yes, free |

Responses are cached in Netlify's shared ("durable") cache, so each source is called once per refresh window no matter how many people load the page. The page re-checks every 3 minutes.

## Setup

1. **Netlify:** Add new site → Import an existing project → GitHub → `ISM4421CFBPicks`. Leave the build settings as they are (`netlify.toml` publishes the repo root and deploys the functions).
2. **More sportsbooks (optional):** sign up for a free key at [the-odds-api.com](https://the-odds-api.com). In Netlify, go to Site configuration → Environment variables and add `ODDS_API_KEY`, then redeploy. The free plan has 500 credits a month and each refresh uses 3, so the default 5-hour refresh fits. On a paid plan, add `ODDS_REFRESH_MINUTES` (for example `10`).
3. **Accounts:** sign-in uses the same Supabase project as the NFL site (`config.js`), so the same email and password work on both. Bets are tagged `sport = 'cfb'` and stay separate. For sign-up confirmation and password-reset emails to come back to this site, add its Netlify URL under Supabase → Authentication → URL Configuration → Redirect URLs.

## The model

`model.js` walks through every week since 2014 in order. Each week it predicts games using only earlier results, then learns from them:

- **Team ratings:** Elo with margin of victory, home field (none at neutral sites), FCS teams starting lower, and regression toward the mean each offseason. Plus rolling points for and against, against-the-spread form, and over/under form.
- **Three online logistic regressions:** win (starting from the market's no-vig probability), cover, and over.
- **Every book's price:** the cover and over chances become an expected margin and total (final margins vary by about 15.6 points around the closing spread, totals by about 16.2). That prices each book's own line and odds, including half points and pushes. A bet is recommended at the book with the highest expected value, if that clears your minimum edge.

Walk-forward on 2024–2025: the model picked winners 75.5% of the time vs. 75.4% for the betting favorite. Spread picks at a 3% edge went 97-105, and totals went 264-226 (53.9%). Treat it as being about as sharp as the closing line, and use it to find better numbers across books.

To refresh the history after a season: `python3 scripts/build_history.py 2026`.

## Run locally

```sh
python3 -m http.server 8000
```

The functions only run on Netlify (or with `netlify dev`), so a plain local server shows an error for live data.

For education and entertainment. Bet responsibly (1-800-GAMBLER).
