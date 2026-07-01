'use strict';
const express     = require('express');
const axios       = require('axios');
const cors        = require('cors');
const compression = require('compression');
const cron        = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(compression());
app.use(express.json());

// ── CONFIG ────────────────────────────────────────────────────
const ETHPLORER_KEY = process.env.ETHPLORER_KEY || 'EK-sySN3-HMADYLm-uN3uQ';
const TOP_N         = parseInt(process.env.TOP_N || '300');
const CONCURRENCY   = parseInt(process.env.CONCURRENCY || '5');
const DELAY_MS      = parseInt(process.env.FETCH_DELAY_MS || '250');
const TOKEN_ADDR    = '0x73d7c860998ca3c01ce8c808f5577d94d545d1b4';
const CG_KEY        = process.env.COINGECKO_KEY || 'CG-HTUFfTCjWQRWAxyecoNWGPGA';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── CACHE ─────────────────────────────────────────────────────
let cache = {
  status: 'idle', data: null, progress: { done: 0, total: 0 },
  error: null, startedAt: null, completedAt: null,
};

// ── PRICE HELPERS ─────────────────────────────────────────────
let _priceMap = null, _priceAt = 0, _currentPx = null;

async function getCurrentPrice() {
  try {
    const { data } = await axios.get(
      'https://api.dexscreener.com/latest/dex/tokens/' + TOKEN_ADDR,
      { timeout: 10000 }
    );
    const pair = data && data.pairs && data.pairs.find(p => p.chainId === 'ethereum');
    if (pair && pair.priceUsd) {
      _currentPx = parseFloat(pair.priceUsd);
      return _currentPx;
    }
  } catch (e) { console.warn('[IXS] DexScreener error:', e.message); }
  const { data } = await axios.get(
    'https://api.ethplorer.io/getTokenInfo/' + TOKEN_ADDR + '?apiKey=' + ETHPLORER_KEY,
    { timeout: 10000 }
  );
  _currentPx = parseFloat(data && data.price && data.price.rate) || 0;
  return _currentPx;
}

async function getPriceMap() {
  if (_priceMap && Date.now() - _priceAt < 3_600_000) return _priceMap;
  _priceMap = new Map();
  // Try CoinGecko with demo key
  const cgUrls = [
    'https://pro-api.coingecko.com/api/v3/coins/ix-swap/market_chart?vs_currency=usd&days=365&interval=daily',
    'https://api.coingecko.com/api/v3/coins/ix-swap/market_chart?vs_currency=usd&days=365&interval=daily',
  ];
  for (const url of cgUrls) {
    try {
      const { data } = await axios.get(url, { timeout: 15000, headers: { 'Accept': 'application/json', 'x-cg-pro-api-key': CG_KEY } });
      if (data && data.prices && data.prices.length > 1) {
        for (const [ts, px] of data.prices)
          _priceMap.set(new Date(ts).toISOString().slice(0, 10), px);
        console.log('[IXS] Price map loaded:', _priceMap.size, 'days from', url.slice(0,50));
        break;
      }
    } catch (e) { console.warn('[IXS] CG attempt failed:', e.message); }
  }
  if (_priceMap.size === 0 && _currentPx) {
    _priceMap.set(new Date().toISOString().slice(0, 10), _currentPx);
    console.warn('[IXS] Using only current price as fallback');
  }
  _priceAt = Date.now();
  return _priceMap;
}

function priceAt(ts, map) {
  const d = new Date(ts * 1000).toISOString().slice(0, 10);
  if (map.has(d)) return map.get(d);
  for (let i = 1; i <= 7; i++) {
    const dk = new Date(ts * 1000 - i * 86_400_000).toISOString().slice(0, 10);
    if (map.has(dk)) return map.get(dk);
  }
  return null;
}

// ── FETCH ─────────────────────────────────────────────────────
async function fetchHolders() {
  const { data } = await axios.get(
    `https://api.ethplorer.io/getTopTokenHolders/${TOKEN_ADDR}?apiKey=${ETHPLORER_KEY}&limit=${Math.min(TOP_N, 1000)}`,
    { timeout: 30000 }
  );
  return data.holders || [];
}

async function fetchHistory(address) {
  const { data } = await axios.get(
    `https://api.ethplorer.io/getAddressHistory/${address}?apiKey=${ETHPLORER_KEY}&token=${TOKEN_ADDR}&type=transfer&limit=1000`,
    { timeout: 20000 }
  );
  return data.operations || [];
}

// ── FIFO PnL ──────────────────────────────────────────────────
function computePnL(address, ops, currentPx, priceMap) {
  const addr = address.toLowerCase();
  const transfers = ops.filter(o => o.type === 'transfer').sort((a, b) => a.timestamp - b.timestamp);
  const lots = [];
  let realizedPnL = 0, qtyBought = 0, qtySold = 0;
  let totalSpentUSD = 0, totalSoldUSD = 0;
  let firstBuyTs = null, lastActivityTs = null;
  const trades = [];

  for (const op of transfers) {
    const qty  = parseFloat(op.value) / 1e18;
    const px   = priceAt(op.timestamp, priceMap);
    const usd  = px ? qty * px : null;
    const isIn = op.to?.toLowerCase() === addr;
    const ts   = op.timestamp;
    if (!lastActivityTs || ts > lastActivityTs) lastActivityTs = ts;

    if (isIn) {
      if (!firstBuyTs) firstBuyTs = ts;
      lots.push({ qty, cost: px || 0, ts });
      qtyBought += qty;
      if (usd) totalSpentUSD += usd;
      trades.push({ ts, type: 'BUY', qty, priceUSD: px, valueUSD: usd });
    } else {
      let rem = qty;
      qtySold += qty;
      if (usd) totalSoldUSD += usd;
      trades.push({ ts, type: 'SELL', qty, priceUSD: px, valueUSD: usd });
      while (rem > 1e-9 && lots.length > 0) {
        const lot = lots[0];
        const m = Math.min(lot.qty, rem);
        realizedPnL += m * ((px || lot.cost) - lot.cost);
        lot.qty -= m; rem -= m;
        if (lot.qty < 1e-9) lots.shift();
      }
    }
  }

  const remainingQty = lots.reduce((s, l) => s + l.qty, 0);
  const avgCost = remainingQty > 0
    ? lots.reduce((s, l) => s + l.qty * l.cost, 0) / remainingQty : 0;
  const unrealizedPnL = remainingQty * (currentPx - avgCost);
  const holdingSecs = remainingQty > 1 && firstBuyTs
    ? Math.floor(Date.now() / 1000) - firstBuyTs : 0;

  // Activity buckets
  const now = Math.floor(Date.now() / 1000);
  const windows = { '1H': 3600, '6H': 21600, '24H': 86400, '1W': 604800, '1M': 2592000 };
  const activity = {};
  for (const [label, secs] of Object.entries(windows)) {
    const cutoff = now - secs;
    const bucket = trades.filter(t => t.ts >= cutoff);
    const buys  = bucket.filter(t => t.type === 'BUY');
    const sells = bucket.filter(t => t.type === 'SELL');
    activity[label] = {
      buys: buys.length, sells: sells.length,
      buyVol:  buys.reduce((s, t) => s + (t.valueUSD || 0), 0),
      sellVol: sells.reduce((s, t) => s + (t.valueUSD || 0), 0),
    };
  }

  return {
    realizedPnL, unrealizedPnL, totalPnL: realizedPnL + unrealizedPnL,
    remainingQty, avgCost, qtyBought, qtySold,
    totalSpentUSD, totalSoldUSD, firstBuyTs, lastActivityTs,
    holdingSecs, txCount: transfers.length,
    truncated: transfers.length >= 1000,
    trades: trades.slice(-50), activity,
  };
}

// ── MAIN ANALYSIS ─────────────────────────────────────────────
async function runAnalysis() {
  if (cache.status === 'running') return;
  cache.status = 'running'; cache.startedAt = new Date().toISOString();
  cache.progress = { done: 0, total: 0 }; cache.error = null;
  console.log('[IXS] Starting analysis...');
  try {
    const [holders, priceMap, currentPx] = await Promise.all([
      fetchHolders(), getPriceMap(), getCurrentPrice()
    ]);
    const total = holders.length;
    cache.progress.total = total;
    const results = [];

    for (let i = 0; i < total; i += CONCURRENCY) {
      const batch = holders.slice(i, i + CONCURRENCY);
      const batchRes = await Promise.all(batch.map(async h => {
        try {
          const ops = await fetchHistory(h.address);
          const pnl = computePnL(h.address, ops, currentPx, priceMap);
          return {
            address: h.address, balance: parseFloat(h.balance),
            sharePercent: parseFloat(h.share),
            currentValueUSD: parseFloat(h.balance) * currentPx,
            ...pnl,
          };
        } catch (e) {
          return {
            address: h.address, balance: parseFloat(h.balance),
            sharePercent: parseFloat(h.share),
            currentValueUSD: parseFloat(h.balance) * currentPx,
            realizedPnL: 0, unrealizedPnL: 0, totalPnL: 0,
            remainingQty: 0, avgCost: 0, qtyBought: 0, qtySold: 0,
            totalSpentUSD: 0, totalSoldUSD: 0, firstBuyTs: null,
            lastActivityTs: null, holdingSecs: 0, txCount: 0,
            truncated: false, trades: [], activity: {}, error: e.message,
          };
        }
      }));
      results.push(...batchRes);
      cache.progress.done = Math.min(i + CONCURRENCY, total);
      if (i + CONCURRENCY < total) await sleep(DELAY_MS);
    }

    results.sort((a, b) => b.totalPnL - a.totalPnL);
    results.forEach((r, i) => { r.rank = i + 1; });
    cache.data = { results, currentPx, updatedAt: new Date().toISOString() };
    cache.status = 'ready'; cache.completedAt = new Date().toISOString();
    console.log(`[IXS] Done — ${results.length} wallets`);
  } catch (e) {
    cache.status = 'error'; cache.error = e.message;
    console.error('[IXS] Error:', e.message);
  }
}

// ── API ROUTES ────────────────────────────────────────────────
app.get('/api/status', (req, res) => res.json({
  status: cache.status, progress: cache.progress,
  startedAt: cache.startedAt, completedAt: cache.completedAt,
  error: cache.error, wallets: cache.data?.results?.length || 0,
  updatedAt: cache.data?.updatedAt || null, currentPx: cache.data?.currentPx || null,
}));

app.post('/api/refresh', (req, res) => {
  if (cache.status === 'running') return res.json({ ok: false, message: 'Already running' });
  runAnalysis();
  res.json({ ok: true });
});

app.get('/api/summary', (req, res) => {
  if (!cache.data) return res.status(503).json({ error: 'Not ready' });
  const r = cache.data.results;
  res.json({
    totalWallets: r.length,
    profitable: r.filter(x => x.totalPnL > 0).length,
    inLoss: r.filter(x => x.totalPnL < 0).length,
    holding: r.filter(x => x.remainingQty > 1).length,
    totalRealizedPnL: r.reduce((s, x) => s + (x.realizedPnL || 0), 0),
    totalUnrealizedPnL: r.reduce((s, x) => s + (x.unrealizedPnL || 0), 0),
    currentPx: cache.data.currentPx, updatedAt: cache.data.updatedAt,
  });
});

app.get('/api/holders', (req, res) => {
  if (!cache.data) return res.status(503).json({ error: 'Not ready' });
  let rows = cache.data.results;
  const { search, filter, sort = 'totalPnL', order = 'desc', page = 1, limit = 50 } = req.query;
  if (search) rows = rows.filter(r => r.address.toLowerCase().includes(search.toLowerCase()));
  if (filter === 'profitable') rows = rows.filter(r => r.totalPnL > 0);
  if (filter === 'loss')       rows = rows.filter(r => r.totalPnL < 0);
  if (filter === 'holding')    rows = rows.filter(r => r.remainingQty > 1);
  if (filter === 'exited')     rows = rows.filter(r => r.remainingQty < 1);
  rows = [...rows].sort((a, b) => order === 'asc' ? (a[sort]||0)-(b[sort]||0) : (b[sort]||0)-(a[sort]||0));
  const pg = parseInt(page), lim = parseInt(limit);
  const total = rows.length;
  res.json({
    total, page: pg, limit: lim, pages: Math.ceil(total / lim),
    currentPx: cache.data.currentPx, updatedAt: cache.data.updatedAt,
    rows: rows.slice((pg-1)*lim, pg*lim),
  });
});

app.get('/api/wallet/:address', (req, res) => {
  if (!cache.data) return res.status(503).json({ error: 'Not ready' });
  const w = cache.data.results.find(r => r.address.toLowerCase() === req.params.address.toLowerCase());
  if (!w) return res.status(404).json({ error: 'Not found' });
  res.json(w);
});

app.get('/api/activity', (req, res) => {
  if (!cache.data) return res.status(503).json({ error: 'Not ready' });
  const { window = '24H', type } = req.query;
  const rows = cache.data.results
    .filter(r => r.activity?.[window])
    .map(r => {
      const b = r.activity[window];
      if (b.buys + b.sells === 0) return null;
      if (type === 'BUY' && b.buys === 0) return null;
      if (type === 'SELL' && b.sells === 0) return null;
      return {
        address: r.address, balance: r.balance, totalPnL: r.totalPnL,
        buys: b.buys, sells: b.sells, buyVol: b.buyVol, sellVol: b.sellVol,
        netFlow: b.buyVol - b.sellVol,
      };
    })
    .filter(Boolean);
  res.json({ window, count: rows.length, currentPx: cache.data.currentPx, rows });
});

// ── FRONTEND (embedded) ───────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IXS Tracker</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg0:#080b0f;--bg1:#0e1318;--bg2:#141c24;--bg3:#1c2730;
  --border:#1f2d3a;--border2:#2a3d4f;
  --text:#d4e4f0;--text2:#5d7a8a;--text3:#8fa8b8;
  --pos:#00e5a0;--pos-dim:#00e5a020;--neg:#ff4e6a;--neg-dim:#ff4e6a20;
  --accent:#2196f3;--warn:#ffc107;
  --mono:'IBM Plex Mono',monospace;--sans:'Inter',sans-serif;
}
body{background:var(--bg0);color:var(--text);font-family:var(--sans);font-size:13px;min-height:100vh}
.shell{display:flex;flex-direction:column;min-height:100vh}
header{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:52px;border-bottom:1px solid var(--border);background:var(--bg1);position:sticky;top:0;z-index:100}
.logo{display:flex;align-items:center;gap:10px;font-family:var(--mono);font-weight:600;font-size:15px}
.logo-dot{width:8px;height:8px;border-radius:50%;background:var(--pos);box-shadow:0 0 12px #00e5a050;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.header-right{display:flex;align-items:center;gap:16px}
.price-badge{font-family:var(--mono);font-size:12px;color:var(--text3)}
.price-badge span{color:var(--text);font-weight:600}
.status-pill{font-family:var(--mono);font-size:10px;padding:3px 8px;border-radius:20px;border:1px solid var(--border2);color:var(--text2)}
.status-pill.running{color:var(--warn);border-color:var(--warn);animation:blink 1s infinite}
.status-pill.ready{color:var(--pos);border-color:var(--pos)}
.status-pill.error{color:var(--neg);border-color:var(--neg)}
@keyframes blink{50%{opacity:.5}}
.btn{background:var(--bg3);border:1px solid var(--border2);color:var(--text3);font-family:var(--mono);font-size:11px;padding:5px 12px;border-radius:6px;cursor:pointer;transition:all .15s}
.btn:hover{border-color:var(--accent);color:var(--text)}
.stats-bar{display:flex;gap:1px;background:var(--border);border-bottom:1px solid var(--border)}
.stat{flex:1;background:var(--bg1);padding:14px 20px}
.stat-label{font-family:var(--mono);font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
.stat-value{font-family:var(--mono);font-size:18px;font-weight:600}
.stat-value.pos{color:var(--pos)}
.stat-value.neg{color:var(--neg)}
.stat-sub{font-size:11px;color:var(--text2);margin-top:2px}
.tabs{display:flex;border-bottom:1px solid var(--border);background:var(--bg1);padding:0 24px}
.tab{padding:12px 20px;font-family:var(--mono);font-size:12px;color:var(--text2);cursor:pointer;border-bottom:2px solid transparent;transition:all .15s}
.tab:hover{color:var(--text3)}
.tab.active{color:var(--text);border-bottom-color:var(--accent)}
.panel{display:none;flex:1;flex-direction:column}
.panel.active{display:flex}
.controls{display:flex;align-items:center;gap:10px;padding:12px 24px;background:var(--bg1);border-bottom:1px solid var(--border);flex-wrap:wrap}
.search-wrap{position:relative;flex:0 0 240px}
.search-wrap svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text2);pointer-events:none}
input[type=text]{width:100%;background:var(--bg2);border:1px solid var(--border2);color:var(--text);font-family:var(--mono);font-size:12px;padding:6px 10px 6px 30px;border-radius:6px;outline:none}
input[type=text]:focus{border-color:var(--accent)}
input[type=text]::placeholder{color:var(--text2)}
select{background:var(--bg2);border:1px solid var(--border2);color:var(--text3);font-family:var(--mono);font-size:12px;padding:6px 10px;border-radius:6px;outline:none;cursor:pointer}
.row-count{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--text2)}
.table-wrap{overflow:auto;flex:1}
table{width:100%;border-collapse:collapse;font-size:12px}
thead{position:sticky;top:0;z-index:10}
th{background:var(--bg2);color:var(--text2);font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.06em;padding:8px 12px;text-align:left;white-space:nowrap;border-bottom:1px solid var(--border);cursor:pointer;user-select:none;transition:color .15s}
th:hover{color:var(--text3)}
td{padding:7px 12px;border-bottom:1px solid var(--border);white-space:nowrap}
tr:hover td{background:var(--bg2);cursor:pointer}
td.pos{color:var(--pos);font-family:var(--mono)}
td.neg{color:var(--neg);font-family:var(--mono)}
td.mono{font-family:var(--mono)}
.addr-link{font-family:var(--mono);font-size:12px;color:var(--accent);text-decoration:none}
.addr-link:hover{text-decoration:underline}
.flag{font-size:9px;padding:2px 5px;border-radius:3px;border:1px solid var(--warn);color:var(--warn)}
.pnl-wrap{display:flex;align-items:center;gap:6px}
.pnl-bar{height:4px;border-radius:2px;min-width:2px}
.pnl-bar.pos{background:var(--pos)}
.pnl-bar.neg{background:var(--neg)}
.hold-chip{font-family:var(--mono);font-size:10px;padding:2px 6px;border-radius:3px;background:var(--bg3);border:1px solid var(--border2);color:var(--text3)}
.pagination{display:flex;align-items:center;justify-content:center;gap:6px;padding:12px;border-top:1px solid var(--border);background:var(--bg1)}
.page-btn{background:var(--bg2);border:1px solid var(--border2);color:var(--text3);font-family:var(--mono);font-size:12px;padding:4px 10px;border-radius:6px;cursor:pointer}
.page-btn:hover{border-color:var(--accent);color:var(--text)}
.page-btn.active{background:var(--accent);border-color:var(--accent);color:#fff}
.page-btn:disabled{opacity:.3;cursor:default}
.page-info{font-family:var(--mono);font-size:11px;color:var(--text2)}
.win-tabs{display:flex;gap:6px;padding:12px 24px;border-bottom:1px solid var(--border);background:var(--bg1);align-items:center}
.win-tab{font-family:var(--mono);font-size:11px;padding:4px 12px;border-radius:20px;border:1px solid var(--border2);color:var(--text2);cursor:pointer}
.win-tab.active{background:var(--accent);border-color:var(--accent);color:#fff}
.type-filter{margin-left:auto;display:flex;gap:6px}
.type-btn{font-family:var(--mono);font-size:11px;padding:4px 12px;border-radius:20px;border:1px solid var(--border2);color:var(--text2);cursor:pointer}
.type-btn.active{background:var(--bg3);border-color:var(--border2);color:var(--text)}
.type-btn.buy.active{background:var(--pos-dim);border-color:var(--pos);color:var(--pos)}
.type-btn.sell.active{background:var(--neg-dim);border-color:var(--neg);color:var(--neg)}
#loading{position:fixed;inset:0;background:var(--bg0);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;z-index:999}
#loading.hidden{display:none}
.load-title{font-family:var(--mono);font-size:22px;font-weight:600}
.prog-track{width:320px;height:3px;background:var(--bg3);border-radius:2px;overflow:hidden}
.prog-fill{height:100%;background:var(--pos);border-radius:2px;transition:width .3s}
.load-msg{font-family:var(--mono);font-size:12px;color:var(--text2)}
#modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:200;display:none;align-items:center;justify-content:center}
#modal-overlay.open{display:flex}
.modal{background:var(--bg1);border:1px solid var(--border2);border-radius:10px;width:780px;max-width:95vw;max-height:85vh;overflow:hidden;display:flex;flex-direction:column}
.modal-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border)}
.modal-title{font-family:var(--mono);font-size:13px;font-weight:600;word-break:break-all}
.modal-close{background:none;border:none;color:var(--text2);font-size:22px;cursor:pointer;line-height:1;padding:0 4px}
.modal-close:hover{color:var(--text)}
.modal-body{overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px}
.modal-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.mstat{background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:12px}
.mstat-label{font-size:10px;color:var(--text2);font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
.mstat-value{font-family:var(--mono);font-size:15px;font-weight:600}
.trades-title{font-family:var(--mono);font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.trade-row{display:flex;align-items:center;gap:12px;padding:6px 0;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:11px;color:var(--text3)}
.trade-type{width:36px;text-align:center;border-radius:3px;font-weight:600;font-size:10px;padding:2px 0}
.trade-type.BUY{color:var(--pos);border:1px solid var(--pos)}
.trade-type.SELL{color:var(--neg);border:1px solid var(--neg)}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:var(--bg0)}
::-webkit-scrollbar-thumb{background:var(--bg3);border-radius:3px}
</style>
</head>
<body>
<div id="loading">
  <div class="load-title">IXS TRACKER</div>
  <div class="prog-track"><div class="prog-fill" id="prog" style="width:0%"></div></div>
  <div class="load-msg" id="load-msg">Connecting…</div>
</div>

<div id="modal-overlay">
  <div class="modal">
    <div class="modal-header">
      <div class="modal-title" id="modal-addr"></div>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <div class="modal-body" id="modal-body"></div>
  </div>
</div>

<div class="shell">
  <header>
    <div class="logo"><div class="logo-dot"></div>IXS TRACKER</div>
    <div class="header-right">
      <div class="price-badge">IXS <span id="hdr-px">—</span></div>
      <div class="status-pill" id="pill">—</div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--text2)" id="hdr-updated"></div>
      <button class="btn" onclick="triggerRefresh()">↺ Refresh</button>
    </div>
  </header>

  <div class="stats-bar">
    <div class="stat"><div class="stat-label">Wallets</div><div class="stat-value" id="s-w">—</div></div>
    <div class="stat"><div class="stat-label">Profitable</div><div class="stat-value pos" id="s-p">—</div><div class="stat-sub" id="s-pp"></div></div>
    <div class="stat"><div class="stat-label">In Loss</div><div class="stat-value neg" id="s-l">—</div><div class="stat-sub" id="s-lp"></div></div>
    <div class="stat"><div class="stat-label">Still Holding</div><div class="stat-value" id="s-h">—</div></div>
    <div class="stat"><div class="stat-label">Total Realized PnL</div><div class="stat-value" id="s-r">—</div></div>
    <div class="stat"><div class="stat-label">Total Unrealized PnL</div><div class="stat-value" id="s-u">—</div></div>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="switchTab('holders',this)">Holders &amp; PnL</div>
    <div class="tab" onclick="switchTab('activity',this)">Activity Feed</div>
  </div>

  <div class="panel active" id="panel-holders">
    <div class="controls">
      <div class="search-wrap">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="text" id="search" placeholder="Search address…" oninput="debounce(loadHolders,400)()">
      </div>
      <select id="flt" onchange="loadHolders()">
        <option value="">All wallets</option>
        <option value="profitable">Profitable</option>
        <option value="loss">In Loss</option>
        <option value="holding">Still Holding</option>
        <option value="exited">Fully Exited</option>
      </select>
      <select id="srt" onchange="loadHolders()">
        <optgroup label="── PnL ──">
          <option value="totalPnL">Total PnL</option>
          <option value="realizedPnL">Realized PnL</option>
          <option value="unrealizedPnL">Unrealized PnL</option>
        </optgroup>
        <optgroup label="── Position ──">
          <option value="balance">IXS Balance</option>
          <option value="currentValueUSD">Value USD</option>
          <option value="avgCost">Avg Cost Basis</option>
          <option value="sharePercent">Supply %</option>
        </optgroup>
        <optgroup label="── Time ──">
          <option value="firstBuyTs">First Buy Date</option>
          <option value="lastActivityTs">Last Active</option>
          <option value="holdingSecs">Hold Duration</option>
        </optgroup>
        <optgroup label="── Activity ──">
          <option value="txCount">Tx Count</option>
          <option value="qtyBought">Total Bought</option>
          <option value="qtySold">Total Sold</option>
          <option value="totalSpentUSD">Total Spent USD</option>
          <option value="totalSoldUSD">Total Received USD</option>
        </optgroup>
      </select>
      <select id="ord" onchange="loadHolders()">
        <option value="desc">↓ Biggest first</option>
        <option value="asc">↑ Smallest first</option>
      </select>
      <span class="row-count" id="rc"></span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th onclick="sortBy('rank')"># <span id="sort-rank"></span></th>
          <th>Address</th>
          <th onclick="sortBy('balance')">Balance <span id="sort-balance"></span></th>
          <th onclick="sortBy('sharePercent')">Supply% <span id="sort-sharePercent"></span></th>
          <th onclick="sortBy('currentValueUSD')">Value USD <span id="sort-currentValueUSD"></span></th>
          <th onclick="sortBy('avgCost')">Avg Cost <span id="sort-avgCost"></span></th>
          <th onclick="sortBy('realizedPnL')">Realized PnL <span id="sort-realizedPnL"></span></th>
          <th onclick="sortBy('unrealizedPnL')">Unrealized PnL <span id="sort-unrealizedPnL"></span></th>
          <th onclick="sortBy('totalPnL')">Total PnL <span id="sort-totalPnL"></span></th>
          <th onclick="sortBy('firstBuyTs')">First Buy <span id="sort-firstBuyTs"></span></th>
          <th onclick="sortBy('holdingSecs')">Holding <span id="sort-holdingSecs"></span></th>
          <th onclick="sortBy('lastActivityTs')">Last Active <span id="sort-lastActivityTs"></span></th>
          <th onclick="sortBy('txCount')">Txs <span id="sort-txCount"></span></th>
        </tr></thead>
        <tbody id="htbody"></tbody>
      </table>
    </div>
    <div class="pagination" id="hpag"></div>
  </div>

  <div class="panel" id="panel-activity">
    <div class="win-tabs">
      <span style="font-family:var(--mono);font-size:11px;color:var(--text2);margin-right:4px">Window:</span>
      <div class="win-tab active" onclick="setWin('1H',this)">1H</div>
      <div class="win-tab" onclick="setWin('6H',this)">6H</div>
      <div class="win-tab" onclick="setWin('24H',this)">24H</div>
      <div class="win-tab" onclick="setWin('1W',this)">1W</div>
      <div class="win-tab" onclick="setWin('1M',this)">1M</div>
      <div class="type-filter">
        <div class="type-btn all active" onclick="setType('',this)">All</div>
        <div class="type-btn buy" onclick="setType('BUY',this)">Buys</div>
        <div class="type-btn sell" onclick="setType('SELL',this)">Sells</div>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Address</th><th>Balance</th><th>Total PnL</th>
          <th>Buys</th><th>Sells</th><th>Buy Vol</th><th>Sell Vol</th><th>Net Flow</th>
        </tr></thead>
        <tbody id="atbody"></tbody>
      </table>
    </div>
  </div>
</div>

<script>
const $=id=>document.getElementById(id);
let state={ready:false,page:1,limit:50,win:'1H',type:''};
let _dt={};

function fU(n,s=false){
  if(n==null||isNaN(n))return'—';
  const a=Math.abs(n);
  let v=a>=1e6?(a/1e6).toFixed(2)+'M':a>=1e3?(a/1e3).toFixed(1)+'K':a.toFixed(2);
  return(n>=0?(s?'+':''):'−')+'$'+v;
}
function fN(n){if(n==null)return'—';return n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':n.toLocaleString('en-US',{maximumFractionDigits:2})}
function fA(a){return a.slice(0,6)+'…'+a.slice(-4)}
function fT(ts){if(!ts)return'—';return new Date(ts*1000).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}
function fD(s){
  if(!s||s<60)return'—';
  const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600);
  if(d>=365)return Math.floor(d/365)+'y '+Math.floor((d%365)/30)+'mo';
  if(d>=30)return Math.floor(d/30)+'mo '+d%30+'d';
  if(d>=1)return d+'d '+h+'h';
  return h+'h';
}
function pc(n){return n>0?'pos':n<0?'neg':''}
function bar(n,max){
  if(n==null||max===0)return'—';
  const w=Math.min(Math.abs(n)/max*80,80).toFixed(1);
  const c=n>=0?'pos':'neg';
  return\`<div class="pnl-wrap"><div class="pnl-bar \${c}" style="width:\${w}px"></div><span class="\${c}">\${fU(n,true)}</span></div>\`;
}

function debounce(fn,d){return function(){clearTimeout(_dt[fn]);_dt[fn]=setTimeout(fn,d)}}

function sortBy(col){
  const srt=$('srt'), ord=$('ord');
  if(srt.value===col){
    ord.value=ord.value==='desc'?'asc':'desc';
  } else {
    srt.value=col;
    ord.value='desc';
  }
  // Update all header indicators
  document.querySelectorAll('th span[id^="sort-"]').forEach(s=>s.textContent='');
  const ind=document.getElementById('sort-'+col);
  if(ind) ind.textContent=ord.value==='desc'?' ↓':' ↑';
  loadHolders();
}

async function api(url){const r=await fetch(url);if(!r.ok)throw new Error(await r.text());return r.json()}

async function pollStatus(){
  try{
    const s=await api('/api/status');
    const pill=$('pill');
    pill.textContent=s.status; pill.className='status-pill '+s.status;
    if(s.status==='running'){
      const pct=s.progress.total>0?Math.round(s.progress.done/s.progress.total*100):0;
      $('prog').style.width=pct+'%';
      $('load-msg').textContent=s.progress.total>0
        ?'Analyzing wallets '+s.progress.done+'/'+s.progress.total+' ('+pct+'%)'
        :'Fetching data…';
      setTimeout(pollStatus,2000); return;
    }
    if(s.status==='ready'){
      $('loading').classList.add('hidden');
      state.ready=true;
      if(s.currentPx) $('hdr-px').textContent='$'+s.currentPx.toFixed(4);
      if(s.updatedAt) $('hdr-updated').textContent='Updated '+new Date(s.updatedAt).toLocaleTimeString();
      loadSummary(); loadHolders(); return;
    }
    if(s.status==='error'){
      $('load-msg').textContent='Error: '+s.error+' — retrying in 30s';
      setTimeout(pollStatus,30000); return;
    }
    setTimeout(pollStatus,3000);
  }catch(e){$('load-msg').textContent='Connecting…';setTimeout(pollStatus,5000)}
}

async function triggerRefresh(){
  await fetch('/api/refresh',{method:'POST'});
  state.ready=false;
  $('loading').classList.remove('hidden');
  $('prog').style.width='0%';
  $('load-msg').textContent='Starting refresh…';
  pollStatus();
}

async function loadSummary(){
  const d=await api('/api/summary');
  $('s-w').textContent=d.totalWallets.toLocaleString();
  $('s-p').textContent=d.profitable.toLocaleString();
  $('s-pp').textContent=Math.round(d.profitable/d.totalWallets*100)+'% of holders';
  $('s-l').textContent=d.inLoss.toLocaleString();
  $('s-lp').textContent=Math.round(d.inLoss/d.totalWallets*100)+'% of holders';
  $('s-h').textContent=d.holding.toLocaleString();
  const re=$('s-r');re.textContent=fU(d.totalRealizedPnL,true);re.className='stat-value '+pc(d.totalRealizedPnL);
  const un=$('s-u');un.textContent=fU(d.totalUnrealizedPnL,true);un.className='stat-value '+pc(d.totalUnrealizedPnL);
  if(d.currentPx) $('hdr-px').textContent='$'+d.currentPx.toFixed(4);
}

let maxPnL=1;
async function loadHolders(reset=true){
  if(!state.ready)return;
  if(reset)state.page=1;
  const url=\`/api/holders?page=\${state.page}&limit=\${state.limit}&search=\${encodeURIComponent($('search').value)}&filter=\${$('flt').value}&sort=\${$('srt').value}&order=\${$('ord').value}\`;
  const d=await api(url);
  maxPnL=d.rows.reduce((m,r)=>Math.max(m,Math.abs(r.totalPnL||0)),1);
  $('rc').textContent=d.total.toLocaleString()+' wallets';
  $('htbody').innerHTML=d.rows.map(r=>{
    const trunc=r.truncated?'<span class="flag">TRUNC</span>':'';
    return \`<tr onclick="openWallet('\${r.address}')">
      <td class="mono" style="color:var(--text2)">\${r.rank}</td>
      <td><a class="addr-link" href="https://etherscan.io/address/\${r.address}" target="_blank" onclick="event.stopPropagation()">\${fA(r.address)}</a>\${trunc}</td>
      <td class="mono">\${fN(r.balance)}</td>
      <td class="mono" style="color:var(--text2)">\${r.sharePercent?.toFixed(2)}%</td>
      <td class="mono">\${fU(r.currentValueUSD)}</td>
      <td class="mono" style="color:var(--text2)">\${r.avgCost?'$'+r.avgCost.toFixed(4):'—'}</td>
      <td>\${bar(r.realizedPnL,maxPnL)}</td>
      <td>\${bar(r.unrealizedPnL,maxPnL)}</td>
      <td>\${bar(r.totalPnL,maxPnL)}</td>
      <td class="mono" style="color:var(--text2)">\${fT(r.firstBuyTs)}</td>
      <td><span class="hold-chip">\${fD(r.holdingSecs)}</span></td>
      <td class="mono" style="color:var(--text2)">\${fT(r.lastActivityTs)}</td>
      <td class="mono" style="color:var(--text2)">\${r.txCount??'—'}</td>
    </tr>\`;
  }).join('');
  renderPag(d.page,d.pages,d.total);
}

function renderPag(pg,pages,total){
  const el=$('hpag');
  if(pages<=1){el.innerHTML='';return}
  let h=\`<button class="page-btn" onclick="goPage(\${pg-1})" \${pg<=1?'disabled':''}>‹</button>\`;
  const s=Math.max(1,pg-3),e=Math.min(pages,pg+3);
  if(s>1)h+=\`<button class="page-btn" onclick="goPage(1)">1</button><span class="page-info">…</span>\`;
  for(let p=s;p<=e;p++)h+=\`<button class="page-btn \${p===pg?'active':''}" onclick="goPage(\${p})">\${p}</button>\`;
  if(e<pages)h+=\`<span class="page-info">…</span><button class="page-btn" onclick="goPage(\${pages})">\${pages}</button>\`;
  h+=\`<button class="page-btn" onclick="goPage(\${pg+1})" \${pg>=pages?'disabled':''}>›</button>\`;
  h+=\`<span class="page-info">\${total.toLocaleString()} total</span>\`;
  el.innerHTML=h;
}
function goPage(p){state.page=p;loadHolders(false)}

function setWin(w,el){state.win=w;document.querySelectorAll('.win-tab').forEach(t=>t.classList.remove('active'));el.classList.add('active');loadActivity()}
function setType(t,el){state.type=t;document.querySelectorAll('.type-btn').forEach(b=>b.classList.remove('active'));el.classList.add('active');loadActivity()}

async function loadActivity(){
  if(!state.ready)return;
  const d=await api(\`/api/activity?window=\${state.win}&type=\${state.type}\`);
  $('atbody').innerHTML=d.rows.length?d.rows.map(r=>{
    const nc=r.netFlow>=0?'pos':'neg';
    return\`<tr onclick="openWallet('\${r.address}')" style="cursor:pointer">
      <td><a class="addr-link" href="https://etherscan.io/address/\${r.address}" target="_blank" onclick="event.stopPropagation()">\${fA(r.address)}</a></td>
      <td class="mono">\${fN(r.balance)}</td>
      <td class="\${pc(r.totalPnL)} mono">\${fU(r.totalPnL,true)}</td>
      <td style="color:var(--pos);font-family:var(--mono)">\${r.buys}</td>
      <td style="color:var(--neg);font-family:var(--mono)">\${r.sells}</td>
      <td style="color:var(--pos);font-family:var(--mono)">\${fU(r.buyVol)}</td>
      <td style="color:var(--neg);font-family:var(--mono)">\${fU(r.sellVol)}</td>
      <td class="\${nc} mono">\${fU(r.netFlow,true)}</td>
    </tr>\`;
  }).join(''):'<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--text2);font-family:var(--mono)">No activity in this window</td></tr>';
}

async function openWallet(address){
  $('modal-overlay').classList.add('open');
  $('modal-addr').textContent=address;
  $('modal-body').innerHTML='<div style="color:var(--text2);font-family:var(--mono);font-size:12px">Loading…</div>';
  try{
    const w=await api(\`/api/wallet/\${address}\`);
    $('modal-body').innerHTML=\`
      <div class="modal-stats">
        <div class="mstat"><div class="mstat-label">Balance</div><div class="mstat-value">\${fN(w.balance)} IXS</div></div>
        <div class="mstat"><div class="mstat-label">Value USD</div><div class="mstat-value">\${fU(w.currentValueUSD)}</div></div>
        <div class="mstat"><div class="mstat-label">Avg Cost</div><div class="mstat-value">\${w.avgCost?'$'+w.avgCost.toFixed(4):'—'}</div></div>
        <div class="mstat"><div class="mstat-label">Holding</div><div class="mstat-value">\${fD(w.holdingSecs)}</div></div>
        <div class="mstat"><div class="mstat-label">Realized PnL</div><div class="mstat-value \${pc(w.realizedPnL)}">\${fU(w.realizedPnL,true)}</div></div>
        <div class="mstat"><div class="mstat-label">Unrealized PnL</div><div class="mstat-value \${pc(w.unrealizedPnL)}">\${fU(w.unrealizedPnL,true)}</div></div>
        <div class="mstat"><div class="mstat-label">Total PnL</div><div class="mstat-value \${pc(w.totalPnL)}">\${fU(w.totalPnL,true)}</div></div>
        <div class="mstat"><div class="mstat-label">Total Txs</div><div class="mstat-value">\${w.txCount}</div></div>
        <div class="mstat"><div class="mstat-label">First Buy</div><div class="mstat-value" style="font-size:13px">\${fT(w.firstBuyTs)}</div></div>
        <div class="mstat"><div class="mstat-label">Last Active</div><div class="mstat-value" style="font-size:13px">\${fT(w.lastActivityTs)}</div></div>
        <div class="mstat"><div class="mstat-label">Total Bought</div><div class="mstat-value" style="font-size:13px">\${fN(w.qtyBought)} IXS</div></div>
        <div class="mstat"><div class="mstat-label">Total Sold</div><div class="mstat-value" style="font-size:13px">\${fN(w.qtySold)} IXS</div></div>
      </div>
      \${(w.trades||[]).length?\`
      <div>
        <div class="trades-title">Recent Transfers</div>
        \${[...(w.trades||[])].reverse().map(t=>\`
          <div class="trade-row">
            <span class="trade-type \${t.type}">\${t.type}</span>
            <span style="flex:1;color:var(--text)">\${fN(t.qty)} IXS</span>
            <span>\${t.priceUSD?'@$'+t.priceUSD.toFixed(4):'—'}</span>
            <span style="color:\${t.type==='BUY'?'var(--pos)':'var(--neg)'}">\${t.valueUSD?fU(t.valueUSD):'—'}</span>
            <span style="margin-left:auto">\${fT(t.ts)}</span>
          </div>\`).join('')}
      </div>\`:''}
    \`;
  }catch(e){$('modal-body').innerHTML=\`<div style="color:var(--neg);font-family:var(--mono)">\${e.message}</div>\`}
}

function closeModal(){$('modal-overlay').classList.remove('open')}
$('modal-overlay').addEventListener('click',e=>{if(e.target===$('modal-overlay'))closeModal()})

function switchTab(name,el){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  $('panel-'+name).classList.add('active');
  if(name==='activity')loadActivity();
}

pollStatus();
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) res.send(HTML);
});

// ── CRON & START ──────────────────────────────────────────────
cron.schedule('0 */6 * * *', () => { console.log('[IXS] Cron refresh'); runAnalysis(); });

app.listen(PORT, () => {
  console.log('[IXS] Running on port ' + PORT);
  runAnalysis();
});
