// DIAGNOSTIC — /.netlify/functions/status  (add ?run=1 to force a refresh)
import { store as _store, storeMode } from "./_store.mjs";
import { rebuild } from "./_board.mjs";

export default async (req) => {
  const url = new URL(req.url);
  const store = await _store("hoodsnipr-cache");
  const out = { now: new Date().toISOString(), storeMode: storeMode() };

  try {
    const b = await store.get("board2", { type: "json" });
    out.board = b ? {
      ageSec: Math.round((Date.now() - b.ts) / 1000),
      rows: b.rows?.length,
      stats: b.stats,
      top10: (b.rows || []).slice(0, 10).map(r => ({ s: r.s, h24: Math.round(r.h24), liq: Math.round(r.liq), ver: r.ver }))
    } : null;
  } catch (e) { out.boardError = e.message; }

  try {
    const u = await store.get("universe", { type: "json" });
    out.universeTokens = u ? Object.keys(u.t || {}).length : 0;
    out.feedPage = u?.page ?? null;
  } catch (e) { out.universeError = e.message; }

  try {
    const v4 = await store.get("v4pools", { type: "json" });
    out.v4 = v4 ? {
      manager: v4.manager, tokensWithKeys: Object.keys(v4.keys || {}).length,
      backfillDone: !!v4.done, cursor: v4.lo ?? null,
      skippedRanges: (v4.gaps || []).length, tipCursor: v4.tip ?? null
    } : { tokensWithKeys: 0 };
  } catch (e) { out.v4Error = e.message; }

  if (url.searchParams.get("run") === "1") {
    const r = await rebuild({ deep: url.searchParams.get("deep") === "1" }).catch(e => ({ error: e.message }));
    out.run = { rows: r.rows?.length ?? 0, stats: r.stats, error: r.error };
  }
  return new Response(JSON.stringify(out, null, 2), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
