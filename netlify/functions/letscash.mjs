// /letscash            -> what we know about the launchpad on this chain
// /letscash?token=0x…  -> classification for one token
import { store as _store } from "./_store.mjs";
import { LETSCASH, hasCcStamp, learnLetscashHooks, letscashHookSet, classify } from "./_letscash.mjs";

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const json = (c, b) => new Response(JSON.stringify(b), {
  status: c, headers: { "content-type": "application/json", "cache-control": "public, max-age=60" }
});

async function usdgAddress(store) {
  // learned from the board rather than hardcoded, so a wrong guess can't
  // mislabel pools
  try {
    const board = await store.get("board2", { type: "json" });
    const row = ((board && board.rows) || []).find(r => /^usdg$/i.test(String(r.s || "")));
    return row ? String(row.a).toLowerCase() : null;
  } catch (e) { return null; }
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const store = await _store("hoodsnipr-cache");
    const v4 = (await store.get("v4pools", { type: "json" }).catch(() => null)) || { keys: {} };

    if (url.searchParams.get("learn") === "1") {
      const st = await learnLetscashHooks(v4.keys || {});
      const hooks = Object.entries(st.hooks || {}).sort((a, b) => b[1] - a[1]);
      return json(200, { learned: hooks.length, topHooks: hooks.slice(0, 8) });
    }

    const token = String(url.searchParams.get("token") || "").toLowerCase();
    const hookSet = await letscashHookSet();
    const usdg = await usdgAddress(store);

    if (token) {
      if (!/^0x[0-9a-f]{40}$/.test(token)) return json(400, { error: "bad token" });
      const info = classify(token, (v4.keys || {})[token] || [], hookSet, WETH, usdg);
      return json(200, info || { isLetscash: false, stamped: hasCcStamp(token) });
    }

    return json(200, {
      site: LETSCASH.site,
      knownHooks: [...hookSet],
      taxRates: LETSCASH.taxRates.map(b => (b / 100) + "%"),
      platformCut: "0.3%",
      usdg: usdg || null,
      note: "letscash tokens trade on standard Uniswap v4 rails; HoodSnipr routes ETH-quoted pools directly."
    });
  } catch (e) {
    return json(500, { error: String(e && e.message || e).slice(0, 160) });
  }
};
