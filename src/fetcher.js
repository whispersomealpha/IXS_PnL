'use strict';
const axios = require('axios');

const TOKEN  = '0x73d7c860998ca3c01ce8c808f5577d94d545d1b4';
const EKEY   = process.env.ETHPLORER_KEY || 'EK-sySN3-HMADYLm-uN3uQ';
const EP     = 'https://api.ethplorer.io';
const CG     = 'https://api.coingecko.com/api/v3';
const DELAY  = parseInt(process.env.FETCH_DELAY_MS || '250');
const CONC   = parseInt(process.env.CONCURRENCY    || '5');
const TOP_N  = parseInt(process.env.TOP_N          || '300');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Price history cache ──────────────────────────────────────
let _priceMap   = null;   // Map<"YYYY-MM-DD", price>
let _currentPx  = null;
let _priceAt    = 0;

async function getPriceMap() {
  if (_priceMap && Date.now() - _priceAt < 3_600_000) return _priceMap;
  const { data } = await axios.get(
    `${CG}/coins/ix-swap/market_chart?vs_currency=usd&days=max&interval=daily`,
    { timeout: 30000 }
  );
  _priceMap = new Map();
  for (const [ts, px] of data.prices) {
    _priceMap.set(new Date(ts).toISOString().slice(0, 10), px);
  }
  _priceAt = Date.now();
  return _priceMap;
}

async function getCurrentPrice() {
  if (_currentPx && Date.now() - _priceAt < 60_000) return _currentPx;
  const { data } = await axios.get(
    `${CG}/simple/price?ids=ix-swap&vs_currencies=usd`,
    { timeout: 10000 }
  );
  _currentPx = data?.['ix-swap']?.usd || 0;
  return _currentPx;
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

// ── Fetch holders ────────────────────────────────────────────
async function fetchHolders() {
  const { data } = await axios.get(
    `${EP}/getTopTokenHolders/${TOKEN}?apiKey=${EKEY}&limit=${Math.min(TOP_N,1000)}`,
    { timeout: 30000 }
  );
  return data.holders || [];
}

// ── Fetch wallet history ─────────────────────────────────────
async function fetchHistory(address) {
  const { data } = await axios.get(
    `${EP}/getAddressHistory/${address}?apiKey=${EKEY}&token=${TOKEN}&type=transfer&limit=1000`,
    { timeout: 20000 }
  );
  return data.operations || [];
}

// ── FIFO PnL engine ──────────────────────────────────────────
function computePnL(address, ops, currentPx, priceMap) {
  const addr = address.toLowerCase();
  const transfers = ops
    .filter(o => o.type === 'transfer')
    .sort((a, b) => a.timestamp - b.timestamp);

  const lots = [];           // FIFO queue {qty, cost, ts}
  let realizedPnL   = 0;
  let qtyBought     = 0;
  let qtySold       = 0;
  let totalSpentUSD = 0;
  let totalSoldUSD  = 0;
  let firstBuyTs    = null;
  let lastActivityTs= null;
  const trades      = [];    // for activity tab

  for (const op of transfers) {
    const qty   = parseFloat(op.value) / 1e18;
    const px    = priceAt(op.timestamp, priceMap);
    const usd   = px ? qty * px : null;
    const isIn  = op.to?.toLowerCase() === addr;
    const ts    = op.timestamp;

    if (!lastActivityTs || ts > lastActivityTs) lastActivityTs = ts;

    if (isIn) {
      if (!firstBuyTs) firstBuyTs = ts;
      lots.push({ qty, cost: px || 0, ts });
      qtyBought  += qty;
      if (usd) totalSpentUSD += usd;
      trades.push({ ts, type: 'BUY', qty, priceUSD: px, valueUSD: usd, from: op.from, to: op.to });
    } else {
      let rem = qty;
      qtySold += qty;
      if (usd) totalSoldUSD += usd;
      trades.push({ ts, type: 'SELL', qty, priceUSD: px, valueUSD: usd, from: op.from, to: op.to });
      while (rem > 1e-9 && lots.length > 0) {
        const lot = lots[0];
        const m   = Math.min(lot.qty, rem);
        realizedPnL += m * ((px || lot.cost) - lot.cost);
        lot.qty -= m;
        rem     -= m;
        if (lot.qty < 1e-9) lots.shift();
      }
    }
  }

  const remainingQty = lots.reduce((s, l) => s + l.qty, 0);
  const avgCost = remainingQty > 0
    ? lots.reduce((s, l) => s + l.qty * l.cost, 0) / remainingQty : 0;
  const unrealizedPnL = remainingQty * (currentPx - avgCost);

  // Holding duration = now − first buy (if still holding)
  const holdingSecs = (remainingQty > 1 && firstBuyTs)
    ? Math.floor(Date.now() / 1000) - firstBuyTs : 0;

  return {
    realizedPnL,
    unrealizedPnL,
    totalPnL: realizedPnL + unrealizedPnL,
    remainingQty,
    avgCost,
    qtyBought,
    qtySold,
    totalSpentUSD,
    totalSoldUSD,
    firstBuyTs,
    lastActivityTs,
    holdingSecs,
    txCount: transfers.length,
    truncated: transfers.length >= 1000,
    trades,
  };
}

// ── Activity buckets ─────────────────────────────────────────
function bucketTrades(trades) {
  const now = Math.floor(Date.now() / 1000);
  const windows = { '1H': 3600, '6H': 21600, '24H': 86400, '1W': 604800, '1M': 2592000 };
  const result = {};
  for (const [label, secs] of Object.entries(windows)) {
    const cutoff = now - secs;
    const bucket = trades.filter(t => t.ts >= cutoff);
    result[label] = {
      buys  : bucket.filter(t => t.type === 'BUY'),
      sells : bucket.filter(t => t.type === 'SELL'),
      buyVol : bucket.filter(t => t.type === 'BUY').reduce((s, t) => s + (t.valueUSD||0), 0),
      sellVol: bucket.filter(t => t.type === 'SELL').reduce((s, t) => s + (t.valueUSD||0), 0),
    };
  }
  return result;
}

// ── Main run ─────────────────────────────────────────────────
async function runFullAnalysis(progressCb) {
  const [holders, priceMap, currentPx] = await Promise.all([
    fetchHolders(),
    getPriceMap(),
    getCurrentPrice(),
  ]);

  const results = [];
  const total   = holders.length;

  for (let i = 0; i < total; i += CONC) {
    const batch = holders.slice(i, i + CONC);
    const batchRes = await Promise.all(batch.map(async (h, bi) => {
      try {
        const ops = await fetchHistory(h.address);
        const pnl = computePnL(h.address, ops, currentPx, priceMap);
        const activity = bucketTrades(pnl.trades);
        return {
          address         : h.address,
          balance         : parseFloat(h.balance),
          sharePercent    : parseFloat(h.share),
          currentValueUSD : parseFloat(h.balance) * currentPx,
          ...pnl,
          activity,
          trades          : pnl.trades.slice(-50), // keep last 50 for detail view
        };
      } catch (e) {
        return {
          address: h.address, balance: parseFloat(h.balance),
          sharePercent: parseFloat(h.share),
          currentValueUSD: parseFloat(h.balance) * currentPx,
          error: e.message,
          realizedPnL:0, unrealizedPnL:0, totalPnL:0,
          remainingQty:0, avgCost:0, qtyBought:0, qtySold:0,
          totalSpentUSD:0, totalSoldUSD:0,
          firstBuyTs:null, lastActivityTs:null, holdingSecs:0,
          txCount:0, truncated:false, trades:[], activity:{},
        };
      }
    }));
    results.push(...batchRes);
    if (progressCb) progressCb(Math.min(i + CONC, total), total);
    if (i + CONC < total) await sleep(DELAY);
  }

  results.sort((a, b) => b.totalPnL - a.totalPnL);
  results.forEach((r, i) => { r.rank = i + 1; });

  return { results, currentPx, updatedAt: new Date().toISOString() };
}

module.exports = { runFullAnalysis, getCurrentPrice };
