'use strict';
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const path        = require('path');
const cron        = require('node-cron');
const { runFullAnalysis, getCurrentPrice } = require('./src/fetcher');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory cache ───────────────────────────────────────────
let cache = {
  data      : null,      // full analysis result
  status    : 'idle',    // idle | running | ready | error
  progress  : { done: 0, total: 0 },
  error     : null,
  startedAt : null,
  completedAt: null,
};

async function runAnalysis() {
  if (cache.status === 'running') return;
  cache.status    = 'running';
  cache.startedAt = new Date().toISOString();
  cache.progress  = { done: 0, total: 0 };
  cache.error     = null;
  console.log('[IXS] Starting full analysis...');
  try {
    const result = await runFullAnalysis((done, total) => {
      cache.progress = { done, total };
      if (done % 50 === 0) console.log(`[IXS] Progress: ${done}/${total}`);
    });
    cache.data        = result;
    cache.status      = 'ready';
    cache.completedAt = new Date().toISOString();
    console.log(`[IXS] Analysis complete — ${result.results.length} wallets`);
  } catch (e) {
    cache.status = 'error';
    cache.error  = e.message;
    console.error('[IXS] Analysis failed:', e.message);
  }
}

// ── API routes ────────────────────────────────────────────────

// Status / progress
app.get('/api/status', (req, res) => {
  res.json({
    status     : cache.status,
    progress   : cache.progress,
    startedAt  : cache.startedAt,
    completedAt: cache.completedAt,
    error      : cache.error,
    wallets    : cache.data?.results?.length || 0,
    updatedAt  : cache.data?.updatedAt || null,
    currentPx  : cache.data?.currentPx || null,
  });
});

// Trigger manual refresh
app.post('/api/refresh', (req, res) => {
  if (cache.status === 'running') {
    return res.json({ ok: false, message: 'Analysis already running' });
  }
  runAnalysis();
  res.json({ ok: true, message: 'Analysis started' });
});

// Holders list (paginated, sortable, filterable)
app.get('/api/holders', (req, res) => {
  if (!cache.data) return res.status(503).json({ error: 'Data not ready' });

  let rows = cache.data.results;

  // Filter
  const { search, filter, sort, order, page = 1, limit = 50 } = req.query;
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(r => r.address.toLowerCase().includes(q));
  }
  if (filter === 'profitable') rows = rows.filter(r => r.totalPnL > 0);
  if (filter === 'loss')       rows = rows.filter(r => r.totalPnL < 0);
  if (filter === 'holding')    rows = rows.filter(r => r.remainingQty > 1);
  if (filter === 'exited')     rows = rows.filter(r => r.remainingQty < 1);

  // Sort
  const sortKey = sort || 'totalPnL';
  const asc     = order === 'asc';
  rows = [...rows].sort((a, b) => {
    const va = a[sortKey] ?? -Infinity;
    const vb = b[sortKey] ?? -Infinity;
    return asc ? va - vb : vb - va;
  });

  const total = rows.length;
  const pg    = parseInt(page);
  const lim   = parseInt(limit);
  const paged = rows.slice((pg - 1) * lim, pg * lim);

  res.json({
    total,
    page : pg,
    limit: lim,
    pages: Math.ceil(total / lim),
    currentPx: cache.data.currentPx,
    updatedAt: cache.data.updatedAt,
    rows : paged.map(r => ({
      rank            : r.rank,
      address         : r.address,
      balance         : r.balance,
      sharePercent    : r.sharePercent,
      currentValueUSD : r.currentValueUSD,
      realizedPnL     : r.realizedPnL,
      unrealizedPnL   : r.unrealizedPnL,
      totalPnL        : r.totalPnL,
      avgCost         : r.avgCost,
      qtyBought       : r.qtyBought,
      qtySold         : r.qtySold,
      totalSpentUSD   : r.totalSpentUSD,
      totalSoldUSD    : r.totalSoldUSD,
      firstBuyTs      : r.firstBuyTs,
      lastActivityTs  : r.lastActivityTs,
      holdingSecs     : r.holdingSecs,
      txCount         : r.txCount,
      truncated       : r.truncated,
      error           : r.error || null,
    })),
  });
});

// Single wallet detail + trades
app.get('/api/wallet/:address', (req, res) => {
  if (!cache.data) return res.status(503).json({ error: 'Data not ready' });
  const w = cache.data.results.find(
    r => r.address.toLowerCase() === req.params.address.toLowerCase()
  );
  if (!w) return res.status(404).json({ error: 'Wallet not found' });
  res.json(w);
});

// Activity feed (all wallets, bucketed by time window)
app.get('/api/activity', (req, res) => {
  if (!cache.data) return res.status(503).json({ error: 'Data not ready' });
  const window = req.query.window || '24H';
  const type   = req.query.type;   // BUY | SELL | undefined

  const rows = cache.data.results
    .filter(r => r.activity?.[window])
    .map(r => {
      const b = r.activity[window];
      const buys  = b.buys  || [];
      const sells = b.sells || [];
      const items = [...(type === 'SELL' ? [] : buys), ...(type === 'BUY' ? [] : sells)];
      if (items.length === 0) return null;
      return {
        address     : r.address,
        balance     : r.balance,
        totalPnL    : r.totalPnL,
        buys        : buys.length,
        sells       : sells.length,
        buyVol      : b.buyVol,
        sellVol     : b.sellVol,
        netFlow     : b.buyVol - b.sellVol,
        lastTs      : items.sort((a,b) => b.ts - a.ts)[0]?.ts,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.lastTs - a.lastTs);

  res.json({ window, count: rows.length, currentPx: cache.data.currentPx, rows });
});

// Summary stats
app.get('/api/summary', (req, res) => {
  if (!cache.data) return res.status(503).json({ error: 'Data not ready' });
  const results = cache.data.results;
  const profitable = results.filter(r => r.totalPnL > 0);
  const inLoss     = results.filter(r => r.totalPnL < 0);
  const holding    = results.filter(r => r.remainingQty > 1);

  res.json({
    totalWallets    : results.length,
    profitable      : profitable.length,
    inLoss          : inLoss.length,
    holding         : holding.length,
    exited          : results.length - holding.length,
    totalRealizedPnL: results.reduce((s,r) => s+(r.realizedPnL||0), 0),
    totalUnrealizedPnL: results.reduce((s,r) => s+(r.unrealizedPnL||0), 0),
    biggestWinner   : results[0] || null,
    biggestLoser    : results[results.length-1] || null,
    currentPx       : cache.data.currentPx,
    updatedAt       : cache.data.updatedAt,
  });
});

// ── Cron: refresh every 6 hours ───────────────────────────────
cron.schedule('0 */6 * * *', () => {
  console.log('[IXS] Cron refresh triggered');
  runAnalysis();
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[IXS] Server running on :${PORT}`);
  // Kick off initial analysis on startup
  runAnalysis();
});
