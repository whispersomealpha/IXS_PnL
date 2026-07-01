# IXS_PnL

Real-time holder intelligence dashboard for the IXS token — top 300 holders ranked by PnL, with realized + unrealized breakdown, hold duration, and activity feed.

## Features

- **Holders & PnL tab** — top 300 holders ranked by Total PnL, with realized + unrealized breakdown, avg cost basis, hold duration, first buy date
- **Activity Feed tab** — 1H / 6H / 24H / 1W / 1M windows showing which wallets bought/sold, buy & sell volume, net flow
- **Wallet detail modal** — click any row to see full stats + last 50 transfers
- Auto-refresh every 6 hours via cron
- Manual refresh button in header

## Local development

```bash
npm install
ETHPLORER_KEY=your-key node server.js
```

Open http://localhost:3000

## Deploy to Railway via GitHub

1. Push this repo to GitHub:

```bash
cd ixs-tracker

git init
git add .
git commit -m "init IXS tracker"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/IXS_PnL.git
git push -u origin main
```

2. Go to https://railway.app → New Project → Deploy from GitHub repo
3. Select the `IXS_PnL` repo
4. Add environment variables in Railway dashboard:

| Variable | Value |
|---|---|
| `ETHPLORER_KEY` | `EK-sySN3-HMADYLm-uN3uQ` |
| `TOP_N` | `300` |
| `CONCURRENCY` | `5` |
| `FETCH_DELAY_MS` | `250` |

5. Railway will auto-detect Node.js and run `npm start`
6. Go to Settings → Networking → Generate Domain to get your public URL
7. First analysis starts automatically on boot (~10-12 min for 300 wallets)

## Environment variables

| Var | Default | Description |
|---|---|---|
| `ETHPLORER_KEY` | — | Required. Your Ethplorer API key |
| `PORT` | `3000` | HTTP port (Railway sets this automatically) |
| `TOP_N` | `300` | Number of top holders to analyze |
| `CONCURRENCY` | `5` | Parallel wallet fetches |
| `FETCH_DELAY_MS` | `250` | Delay between batches (ms) |

## Architecture

```
server.js          Express server, API routes, cron scheduler
src/fetcher.js     Ethplorer + CoinGecko data fetching, FIFO PnL engine
public/index.html  Single-page frontend (no build step)
```

Data is stored in-memory. On Railway, the analysis re-runs on each deploy and every 6h via cron.

## API endpoints

| Endpoint | Description |
|---|---|
| `GET /api/status` | Analysis status + progress |
| `POST /api/refresh` | Trigger manual re-analysis |
| `GET /api/holders` | Paginated holders list (sort, filter, search) |
| `GET /api/wallet/:address` | Full wallet detail + trades |
| `GET /api/activity?window=24H` | Activity feed by time window |
| `GET /api/summary` | Aggregate stats |

## Updating the app

Any time you make changes locally, just push and Railway redeploys automatically:

```bash
git add .
git commit -m "your change"
git push
```
