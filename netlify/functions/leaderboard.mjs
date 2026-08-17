// HoodSnipr leaderboard — stores per-address PnL stats, returns top 50.
// NOTE: v0.2 stats are client-reported (trades recorded in the app). Treat as
// social, not settlement. v0.3 verifies trades against chain data before ranking.
import { getStore } from "@netlify/blobs";

const json = (code, body) => new Response(JSON.stringify(body), {
  status: code, headers: { "content-type": "application/json" }
});

export default async (req) => {
  const stats = getStore("hoodsnipr-stats");
  const profiles = getStore("hoodsnipr-profiles");

  if (req.method === "POST") {
    let b;
    try { b = await req.json(); } catch { return json(400, { error: "bad json" }); }
    const addr = String(b.addr || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return json(400, { error: "bad addr" });
    const pnl = Math.max(-1e9, Math.min(1e9, +b.pnl || 0));
    const trades = Math.max(0, Math.min(1e6, parseInt(b.trades, 10) || 0));
    await stats.setJSON(addr, { addr, pnl, trades, ts: Date.now() });
    return json(200, { ok: true });
  }

  // GET → merged top 50
  const { blobs } = await stats.list();
  const rows = [];
  for (const blob of blobs.slice(0, 500)) {
    const s = await stats.get(blob.key, { type: "json" });
    if (!s) continue;
    const p = await profiles.get(blob.key, { type: "json" }).catch(() => null);
    rows.push({
      addr: s.addr, pnl: s.pnl, trades: s.trades,
      name: p ? p.name : null, x: p ? p.x : null, pfp: p ? p.pfp : null
    });
  }
  rows.sort((a, b) => b.pnl - a.pnl);
  return json(200, { list: rows.slice(0, 50) });
};
