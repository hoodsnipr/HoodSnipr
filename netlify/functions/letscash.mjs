// /letscash            -> what we know about the launchpad on this chain
// /letscash?token=0x…  -> classification for one token
import { store as _store } from "./_store.mjs";
import { LETSCASH, hasCcStamp, learnLetscashHooks, letscashHookSet, classify,
         scanLetscash, findToken, hydrateTokens, letscashMap, normalizeLogo } from "./_letscash.mjs";

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

    // ?scan=1 — advance the full launchpad sweep
    if (url.searchParams.get("scan") === "1") {
      const sweep = await scanLetscash(8000);
      const all = await letscashMap();
      const hyd = await hydrateTokens(Object.keys(all), { budgetMs: 4000, limit: 40 });
      return json(200, { sweep, hydrated: hyd.hydrated, total: Object.keys(all).length });
    }

    // ?find=0x… — locate one token immediately, no waiting for the sweep
    const find = url.searchParams.get("find");
    if (find) {
      const q = String(find).trim().toLowerCase().replace(/^\$/, "");
      const all0 = await letscashMap();

      // A symbol is far easier to paste than an address, so accept either.
      if (!/^0x[0-9a-f]{40}$/.test(q)) {
        const hits = Object.values(all0).filter(t =>
          String(t.sym || "").toLowerCase() === q ||
          String(t.name || "").toLowerCase().includes(q));
        if (hits.length) return json(200, { ok: true, matchedBy: "symbol", count: hits.length, tokens: hits.slice(0, 10) });
        return json(200, {
          ok: false,
          error: `no indexed letscash token matches "${find}"`,
          hint: "pass the contract address instead, or hit ?scan=1 a few times — the sweep may not have reached it yet",
          indexed: Object.keys(all0).length
        });
      }

      // Adopt from the token contract first — it works even when the sweep
      // hasn't reached this token yet, which is the common case for an
      // established coin.
      const { adoptToken } = await import("./_letscash.mjs");
      const adopted = await adoptToken(q);
      const r = adopted.ok ? { ok: true, adopted: true } : await findToken(q);
      const all = await letscashMap();
      return json(200, { ...r, adoption: adopted, meta: all[q] || null });
    }

    // ?adopt=0x…,0x… — pull specific tokens in immediately
    const adopt = url.searchParams.get("adopt");
    if (adopt) {
      const { adoptToken } = await import("./_letscash.mjs");
      const list = adopt.split(",").map(x => x.trim()).filter(Boolean).slice(0, 20);
      const results = [];
      for (const a of list) results.push(await adoptToken(a));
      return json(200, { requested: list.length, adopted: results.filter(r => r.ok).length, results });
    }

    // ?prune=1 — drop anything that isn't cc-stamped
    if (url.searchParams.get("prune") === "1") {
      const { pruneStore } = await import("./_letscash.mjs");
      return json(200, await pruneStore());
    }

    // ?list=1 — everything enumerated so far
    if (url.searchParams.get("list") === "1") {
      const all = await letscashMap();
      const rows = Object.values(all).map(t => ({
        token: t.token, sym: t.sym || null, name: t.name || null,
        logo: normalizeLogo(t.logo) || null, hooks: t.hooks || null
      }));
      const withMeta = rows.filter(r => r.sym);
      const withLogo = rows.filter(r => r.logo);
      const stAll = await store.get("letscash", { type: "json" }).catch(() => null);
      return json(200, {
        total: rows.length,
        withMetadata: withMeta.length,
        withLogo: withLogo.length,
        awaitingHydration: rows.length - withMeta.length,
        sweep: stAll && stAll.scan
          ? { cursor: stAll.scan.lo, complete: !!stAll.scan.done,
              note: stAll.scan.done ? "full history scanned"
                                    : "still walking back — older tokens may not be indexed yet" }
          : null,
        tokens: rows.slice(0, 200)
      });
    }

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
