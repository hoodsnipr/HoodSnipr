// BOARD — pure cache read, served from the CDN edge.
//
// Scale note: this is the ONLY endpoint the app polls for the token list. It
// reads one pre-built blob and sets CDN cache headers, so 1 user and 100,000
// users cost the same — after the first request in each 15s window, Netlify's
// edge serves everyone without invoking this function at all.
import { store as _store } from "./_store.mjs";

export default async () => {
  const store = await _store("hoodsnipr-cache");
  const board = await store.get("board2", { type: "json" }).catch(() => null);
  const body = board && board.rows ? board : { ts: Date.now(), rows: [], stats: { warming: true } };
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      // browser 10s, CDN 15s, and serve stale for a minute while revalidating —
      // users never wait on a cold rebuild
      "cache-control": "public, max-age=10",
      "netlify-cdn-cache-control": "public, s-maxage=15, stale-while-revalidate=60, durable"
    }
  });
};
