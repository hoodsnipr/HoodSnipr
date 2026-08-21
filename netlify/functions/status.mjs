// DIAGNOSTIC ENDPOINT — visit /.netlify/functions/status in a browser.
// Scheduled functions can't be called over HTTP on Netlify, so this exposes the
// same indexing step plus real state, including any errors. If something is
// broken, this tells you exactly what instead of failing silently.
import { store as _store, storeMode } from "./_store.mjs";
import { runIndex } from "./_index.mjs";

export default async (req) => {
  const url = new URL(req.url);
  const store = await _store("hoodsnipr-cache");
  out.storeMode = storeMode();
  const out = { now: new Date().toISOString(), storeMode: storeMode() };

  try {
    const board = await store.get("board2", { type: "json" });
    out.board = board ? { ts: board.ts, ageSec: Math.round((Date.now() - board.ts) / 1000), rows: board.rows?.length, stats: board.stats } : null;
  } catch (e) { out.boardError = e.message; }

  try {
    const idx = await store.get("pools_idx", { type: "json" });
    out.poolsIndexed = idx ? Object.keys(idx.pools || {}).length : 0;
    out.backfill = idx ? { cursor: idx.lo, done: !!idx.done } : null;
  } catch (e) { out.poolsError = e.message; }

  try {
    const sw = await store.get("swaps", { type: "json" });
    out.poolsWithVolume = sw ? Object.keys(sw.vol || {}).length : 0;
    out.swapCursor = sw?.cursor ?? null;
  } catch (e) { out.swapsError = e.message; }

  // ?run=1 forces an indexing step right now and reports what happened
  if (url.searchParams.get("run") === "1") {
    out.run = await runIndex({ budgetMs: 20000 }).catch(e => ({ fatal: e.message }));
  }

  return new Response(JSON.stringify(out, null, 2), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
