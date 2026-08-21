// BOARD — pure cache read. The scheduled indexer keeps this warm, so this
// endpoint does zero upstream work and returns the full list immediately.
import { store as _store, storeMode } from "./_store.mjs";

const json = (c, b) => new Response(JSON.stringify(b), {
  status: c, headers: { "content-type": "application/json", "cache-control": "public, max-age=8" }
});

export default async () => {
  const store = await _store("hoodsnipr-cache");
  const board = await store.get("board2", { type: "json" }).catch(() => null);
  if (board && board.rows) return json(200, board);
  return json(200, { ts: Date.now(), rows: [], stats: { warming: true } });
};
