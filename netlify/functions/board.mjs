// BOARD — CDN-cached read of the trending list the scheduled indexer maintains.
// Scale: after the first request in each 15s window Netlify's edge serves every
// other user without invoking this function, so 1 user and 100,000 cost the same.
import { store as _store } from "./_store.mjs";
import { rebuild } from "./_board.mjs";
import { getBans } from "./banlist.mjs";

export default async () => {
  const store = await _store("hoodsnipr-cache");
  let board = await store.get("board2", { type: "json" }).catch(() => null);

  // cold start (fresh deploy, before the first scheduled tick) — build it now
  if (!board || !board.rows || !board.rows.length) {
    board = await rebuild({}).catch(() => null);
  }
  let body = board && board.rows ? board : { ts: Date.now(), rows: [], stats: { warming: true } };
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
      "cache-control": "public, max-age=10",
      "netlify-cdn-cache-control": "public, s-maxage=15, stale-while-revalidate=60, durable"
    }
  });
};
