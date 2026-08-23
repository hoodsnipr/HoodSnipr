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
// Bumped when the cache format or its trustworthiness changes. An earlier build
// wrote v:0 on every failed fetch, so thousands of live tokens were cached as
// "$0 for 12 hours". Those entries can't be told apart from genuine zeros, so
// the whole cache is discarded once at this version.
const CACHE_VERSION = 2;

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

export async function fillVol30(rows, { budgetMs = 5000, max = 25 } = {}) {
  const t0 = Date.now();
  const store = await _store("hoodsnipr-cache");
  let cache = (await store.get("vol30", { type: "json" }).catch(() => null)) || {};
  if (cache.__v !== CACHE_VERSION) {
    cache = { __v: CACHE_VERSION };          // discard the poisoned generation
  }
  const now = Date.now();

  // Refresh the stalest first, but always prioritise tokens with real 24h
  // activity — those are the ones a 30D ranking actually needs.
  const candidates = (rows || [])
    .filter(r => r.p && /^0x[0-9a-f]{40}$/i.test(String(r.p)))
    .filter(r => (r.h24 || 0) > 0 || (r.liq || 0) > 0)   // don't burn calls on dead pools
    .map(r => {
      const k = String(r.p).toLowerCase();
      const c = cache[k];
      return { k, h24: r.h24 || 0, age: c ? now - c.t : Infinity, known: !!c };
    })
    .filter(x => x.age > TTL)
    .sort((a, b) => (b.h24 || 0) - (a.h24 || 0));

  // Small concurrent batches. Serial fetching managed roughly a dozen pools a
  // run, which left most of the board without a 30D figure for hours.
  let filled = 0, rateLimited = false;
  for (let i = 0; i < candidates.length && filled < max; i += 5) {
    if (Date.now() - t0 > budgetMs - 700 || rateLimited) break;
    const batch = candidates.slice(i, i + 5);
    const results = await Promise.all(batch.map(async c => {
      try { return { k: c.k, v: await poolVol30(c.k) }; }
      catch (e) { return { k: c.k, err: String(e.message) }; }
    }));
    for (const r of results) {
      if (r.err) {
        if (r.err === "rate") { rateLimited = true; continue; }
        // Caching a FAILED fetch as 0 is how tokens showed $0 for a full 12
        // hours. Store null with a short backoff so nothing reads it as real.
        cache[r.k] = { v: null, t: now - (TTL - 10 * 60e3), failed: true };
      } else {
        // No OHLCV history genuinely means no 30-day volume; that zero is real.
        cache[r.k] = { v: r.v == null ? 0 : r.v, t: now };
        filled++;
      }
    }
  }

  // keep the blob bounded
  const keys = Object.keys(cache).filter(k => k !== "__v");
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
  if (c.__v !== CACHE_VERSION) return out;   // stale generation — ignore wholesale
  for (const k of Object.keys(c)) {
    if (k === "__v") continue;
    // null means "not measured yet" and must never surface as 0.
    if (c[k] && c[k].v != null) out[k] = c[k].v;
  }
  return out;
}
