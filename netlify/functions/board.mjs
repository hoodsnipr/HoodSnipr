// BOARD — CDN-cached read of the trending list the scheduled indexer maintains.
// Scale: after the first request in each 15s window Netlify's edge serves every
// other user without invoking this function, so 1 user and 100,000 cost the same.
import { store as _store } from "./_store.mjs";
import { rebuild } from "./_board.mjs";
import { getBans, getAllows } from "./banlist.mjs";

export default async () => {
  const store = await _store("hoodsnipr-cache");
  let board = await store.get("board2", { type: "json" }).catch(() => null);

  // cold start (fresh deploy, before the first scheduled tick) — build it now
  if (!board || !board.rows || !board.rows.length) {
    board = await rebuild({}).catch(() => null);
  }
  let body = board && board.rows ? board : { ts: Date.now(), rows: [], stats: { warming: true } };
  // Whitelisted tokens are guaranteed a row in the SERVED payload, not just
  // in the next rebuild. Without this an override waits on both the
  // scheduled rebuild and the CDN cache before anything appears.
  try {
    const _allows = await getAllows();
    const _keys = Object.keys(_allows || {});
    if (_keys.length && payload && payload.rows) {
      const have = new Set(payload.rows.map(r => String(r.a).toLowerCase()));
      const missing = _keys.filter(k => !have.has(k));
      if (missing.length) {
        const store2 = await _store('hoodsnipr-cache');
        const wl = (await store2.get('wlmeta', { type: 'json' }).catch(() => null)) || {};
        const add = missing.map(k => wl[k]).filter(Boolean);
        if (add.length) payload = { ...payload, rows: payload.rows.concat(add) };
      }
      // mark them so the client can bypass its own filters
      payload = { ...payload, rows: payload.rows.map(r =>
        _allows[String(r.a).toLowerCase()] ? { ...r, wl: true } : r) };
    }
  } catch (e) {}
  // Owner bans apply even to a payload that was already built and cached.
  try {
    const _bans = await getBans();
    if (_bans && Object.keys(_bans).length && body && body.rows) {
      body = { ...body, rows: body.rows.filter(r => !_bans[String(r.a).toLowerCase()]) };
    }
  } catch (e) {}
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=20",
      "netlify-cdn-cache-control": "public, s-maxage=15, stale-while-revalidate=60, durable"
    }
  });
};
