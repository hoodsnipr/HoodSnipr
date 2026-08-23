// 30-DAY VOLUME, SERVER-SIDE
//
// This used to be fetched pool-by-pool from the browser, capped at 60 pools and
// rate-limited by GeckoTerminal — so past roughly the top 20 every token showed
// $0 and the 30D board was meaningless below the fold.
//
// Now the indexer fills it progressively: each run refreshes the most stale
// entries, rotating through the board, and results are cached for 12 hours.
// Coverage builds to the whole board within a few minutes of uptime and is
// shared by every visitor instead of being re-fetched per browser.
import { store as _store } from "./_store.mjs";

const GT = "https://api.geckoterminal.com/api/v2";
const NET = "robinhood";
const TTL = 12 * 3600e3;

async function gt(path) {
  const r = await fetch(GT + path, { headers: { accept: "application/json;version=20230302" } });
  if (r.status === 429) throw new Error("rate");
  if (!r.ok) throw new Error("gt " + r.status);
  return r.json();
}

// Sum daily volume over the last 30 candles.
async function poolVol30(pool) {
  const j = await gt(`/networks/${NET}/pools/${pool}/ohlcv/day?limit=30`);
  const list = j?.data?.attributes?.ohlcv_list || [];
  if (!list.length) return null;
  let sum = 0;
  for (const row of list) sum += +row[5] || 0;     // [ts,o,h,l,c,volume]
  return sum > 0 ? sum : 0;
}

export async function fillVol30(rows, { budgetMs = 5000, max = 12 } = {}) {
  const t0 = Date.now();
  const store = await _store("hoodsnipr-cache");
  const cache = (await store.get("vol30", { type: "json" }).catch(() => null)) || {};
  const now = Date.now();

  // Refresh the stalest first, but always prioritise tokens with real 24h
  // activity — those are the ones a 30D ranking actually needs.
  const candidates = (rows || [])
    .filter(r => r.p && /^0x[0-9a-f]{40}$/i.test(String(r.p)))
    .map(r => {
      const k = String(r.p).toLowerCase();
      const c = cache[k];
      return { k, h24: r.h24 || 0, age: c ? now - c.t : Infinity, known: !!c };
    })
    .filter(x => x.age > TTL)
    .sort((a, b) => (b.h24 || 0) - (a.h24 || 0));

  let filled = 0, rateLimited = false;
  for (const c of candidates) {
    if (filled >= max || Date.now() - t0 > budgetMs - 600) break;
    try {
      const v = await poolVol30(c.k);
      cache[c.k] = { v: v == null ? 0 : v, t: now };
      filled++;
    } catch (e) {
      if (String(e.message) === "rate") { rateLimited = true; break; }
      cache[c.k] = { v: 0, t: now };          // don't retry a dead pool immediately
    }
  }

  // keep the blob bounded
  const keys = Object.keys(cache);
  if (keys.length > 5000) {
    const trimmed = {};
    for (const k of keys.slice(-3500)) trimmed[k] = cache[k];
    await store.setJSON("vol30", trimmed).catch(() => {});
  } else {
    await store.setJSON("vol30", cache).catch(() => {});
  }

  return { filled, rateLimited, cached: keys.length, pending: candidates.length - filled };
}

export async function vol30Map() {
  const store = await _store("hoodsnipr-cache");
  const c = (await store.get("vol30", { type: "json" }).catch(() => null)) || {};
  const out = {};
  for (const k of Object.keys(c)) out[k] = c[k].v || 0;
  return out;
}
