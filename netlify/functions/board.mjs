// BOARD — CDN-cached read of the trending list the scheduled indexer maintains.
// Scale: after the first request in each 15s window Netlify's edge serves every
// other user without invoking this function, so 1 user and 100,000 cost the same.
import { store as _store } from "./_store.mjs";
import { rebuild } from "./_board.mjs";

export default async () => {
  const store = await _store("hoodsnipr-cache");
  let board = await store.get("board2", { type: "json" }).catch(() => null);

  // cold start (fresh deploy, before the first scheduled tick) — build it now
  if (!board || !board.rows || !board.rows.length) {
    board = await rebuild({}).catch(() => null);
  }
  const body = board && board.rows ? board : { ts: Date.now(), rows: [], stats: { warming: true } };
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=10",
      "netlify-cdn-cache-control": "public, s-maxage=15, stale-while-revalidate=60, durable"
    }
  });
};
