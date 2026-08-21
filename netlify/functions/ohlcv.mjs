// 30-day volume per pool: sums 30 daily candles from GT, cached 6h and SHARED
// across all users — the 30D tab stops costing per-user rate limit entirely.
import { store as _store, storeMode } from "./_store.mjs";
const GT = "https://api.geckoterminal.com/api/v2";
const NET = "robinhood";
const json = (c, b) => new Response(JSON.stringify(b), { status: c, headers: { "content-type": "application/json", "cache-control": "public, max-age=600" } });

export default async (req) => {
  const pool = new URL(req.url).searchParams.get("pool") || "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(pool)) return json(400, { error: "bad pool" });
  const store = await _store("hoodsnipr-cache");
  const key = "d30:" + pool.toLowerCase();
  const cached = await store.get(key, { type: "json" }).catch(() => null);
  if (cached && Date.now() - cached.t < 6 * 3600e3) return json(200, cached);
  try {
    const r = await fetch(`${GT}/networks/${NET}/pools/${pool}/ohlcv/day?limit=30`, { headers: { accept: "application/json" } });
    if (!r.ok) throw 0;
    const j = await r.json();
    const list = (((j.data || {}).attributes) || {}).ohlcv_list || [];
    const v = list.reduce((a, c) => a + (+c[5] || 0), 0);
    const out = { v, t: Date.now() };
    await store.setJSON(key, out);
    return json(200, out);
  } catch (e) {
    if (cached) return json(200, cached);
    return json(502, { error: "ohlcv unavailable" });
  }
};
