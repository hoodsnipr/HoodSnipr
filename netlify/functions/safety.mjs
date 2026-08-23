// /safety?token=0x…&pool=0x…  -> trust score for one token
// Cached, so repeated views cost nothing and the board can batch-request.
import { store as _store } from "./_store.mjs";
import { analyseActivity, goPlusCheck, scoreToken } from "./_safety.mjs";

const CHAIN_ID = 4663;
const TTL_MS = 10 * 60e3;

const json = (c, b) => new Response(JSON.stringify(b), {
  status: c, headers: { "content-type": "application/json", "cache-control": "public, max-age=120" }
});

export default async (req) => {
  try {
    const url = new URL(req.url);
    const token = String(url.searchParams.get("token") || "").toLowerCase();
    const pool = String(url.searchParams.get("pool") || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(token)) return json(400, { error: "bad token" });

    const store = await _store("hoodsnipr-cache");
    const cache = (await store.get("safety", { type: "json" }).catch(() => null)) || {};
    const hit = cache[token];
    if (hit && Date.now() - hit.t < TTL_MS && url.searchParams.get("fresh") !== "1") {
      return json(200, { ...hit.v, cached: true });
    }

    // board data gives us liquidity / volume / holders without extra calls
    let liq = 0, vol24 = 0, holders = null, poolAddr = pool;
    try {
      const board = await store.get("board2", { type: "json" });
      const row = ((board && board.rows) || []).find(r => String(r.a).toLowerCase() === token);
      if (row) { liq = row.liq || 0; vol24 = row.h24 || 0; holders = row.h ?? null; poolAddr = poolAddr || String(row.p || "").toLowerCase(); }
    } catch (e) {}

    const [activity, goplus] = await Promise.all([
      poolAddr && /^0x[0-9a-f]{40}$/.test(poolAddr)
        ? analyseActivity(token, poolAddr, { budgetMs: 6000 }).catch(() => null)
        : Promise.resolve(null),
      goPlusCheck(CHAIN_ID, token).catch(() => ({ available: false }))
    ]);

    const result = scoreToken({ activity, goplus, liq, vol24, holders });
    const payload = {
      token, pool: poolAddr, ...result,
      signals: activity && activity.ok ? {
        swaps: activity.swapCount, transfers: activity.transferCount,
        uniqueTraders: activity.uniqueTraders,
        forcedRatio: activity.forcedRatio, cyclerRatio: activity.cyclerRatio,
        topTraderShare: activity.topTraderShare
      } : null,
      externalData: !!(goplus && goplus.available),
      ts: Date.now()
    };

    cache[token] = { t: Date.now(), v: payload };
    const keys = Object.keys(cache);
    if (keys.length > 1500) { const trimmed = {}; for (const k of keys.slice(-1000)) trimmed[k] = cache[k]; await store.setJSON("safety", trimmed).catch(() => {}); }
    else await store.setJSON("safety", cache).catch(() => {});

    return json(200, payload);
  } catch (e) {
    return json(500, { error: String(e && e.message || e).slice(0, 150) });
  }
};
