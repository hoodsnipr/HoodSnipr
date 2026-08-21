// TRENDING UNIVERSE — built from the screener feeds, not from the chain.
//
// We previously enumerated every pool ever created (401,908 of them) from
// factory logs. That was the wrong universe: the overwhelming majority will
// never trend, they crowd the board with junk, and the counts ended up
// contradicting each other. A user opening HoodSnipr expects the same tokens
// they'd see on DexScreener — so the universe IS the screener feeds:
//
//   • GeckoTerminal trending_pools        (what's trending now)
//   • GeckoTerminal pools by 24h volume   (the top of the market)
//   • GeckoTerminal new_pools             (so fresh launches appear immediately)
//   • DexScreener search + boosts         (their view, incl. Uniswap v4)
//
// Anything that later starts trending shows up through these same feeds, so
// nothing is missed — we just stop carrying 400k dead pools.
const GT = "https://api.geckoterminal.com/api/v2";
const NET = "robinhood";
const DS = "https://api.dexscreener.com";

const j = async (u) => {
  const r = await fetch(u, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(u.slice(-40) + " -> " + r.status);
  return r.json();
};
const ok = s => s.status === "fulfilled";

export function gtFeedUrls(page = 1) {
  return [
    `${GT}/networks/${NET}/trending_pools?page=1&include=base_token`,
    `${GT}/networks/${NET}/trending_pools?page=2&include=base_token`,
    `${GT}/networks/${NET}/pools?page=${page}&sort=h24_volume_usd_desc&include=base_token`,
    `${GT}/networks/${NET}/pools?page=${page}&sort=h24_tx_count_desc&include=base_token`,
    `${GT}/networks/${NET}/new_pools?page=1&include=base_token`
  ];
}

export function parseGT(page, out) {
  const inc = {};
  for (const t of (page.included || [])) if (t.type === "token") inc[t.id] = t.attributes || {};
  for (const p of (page.data || [])) {
    const a = p.attributes || {};
    const bt = p.relationships?.base_token?.data?.id;
    if (!bt) continue;
    const addr = bt.split("_").pop().toLowerCase();
    const m = inc[bt] || {};
    const v = a.volume_usd || {}, ch = a.price_change_percentage || {};
    const prev = out[addr];
    const liq = +(a.reserve_in_usd || 0);
    if (prev && (prev.liq || 0) > liq) continue;     // keep the deepest pool
    out[addr] = {
      a: addr, pool: a.address,
      s: m.symbol || String(a.name || "?").split(" / ")[0],
      n: m.name || "",
      img: (m.image_url && m.image_url !== "missing.png") ? m.image_url : (prev?.img || null),
      px: +a.base_token_price_usd || null,
      liq,
      mc: +a.market_cap_usd || +a.fdv_usd || null,
      m5: +(v.m5 || 0), h1: +(v.h1 || 0), h6: +(v.h6 || 0), h24: +(v.h24 || 0),
      cm5: +(ch.m5 || 0), c1: +(ch.h1 || 0), c6: +(ch.h6 || 0), c24: +(ch.h24 || 0),
      cr: a.pool_created_at ? new Date(a.pool_created_at).getTime() : null,
      txns: (function(){
        const tx = a.transactions || {};
        const pick = k => tx[k] ? { b: +tx[k].buys || 0, s: +tx[k].sells || 0 } : null;
        return { m5: pick("m5"), h1: pick("h1"), h6: pick("h6"), h24: pick("h24") };
      })(),
      ver: "v3", src: "gt", t: Date.now()
    };
  }
}

export function parseDS(pairs, out, slug) {
  for (const p of (pairs || [])) {
    if (slug ? p.chainId !== slug : !/robinhood/i.test(p.chainId || "")) continue;
    const addr = String(p.baseToken?.address || "").toLowerCase();
    if (!addr) continue;
    const liq = +(p.liquidity?.usd || 0);
    const prev = out[addr];
    // DexScreener is the reference for what users expect to see, so its record
    // wins on ties — we only skip it for a strictly deeper pool.
    if (prev && prev.src === "ds" && (prev.liq || 0) > liq) continue;
    const labels = [].concat(p.labels || []);
    out[addr] = {
      a: addr, pool: p.pairAddress,
      s: p.baseToken?.symbol || prev?.s || "?",
      n: p.baseToken?.name || prev?.n || "",
      img: p.info?.imageUrl || prev?.img || null,
      px: +p.priceUsd || prev?.px || null,
      liq,
      mc: +p.marketCap || +p.fdv || prev?.mc || null,
      m5: +(p.volume?.m5 || 0), h1: +(p.volume?.h1 || 0),
      h6: +(p.volume?.h6 || 0), h24: +(p.volume?.h24 || 0),
      cm5: +(p.priceChange?.m5 || 0), c1: +(p.priceChange?.h1 || 0),
      c6: +(p.priceChange?.h6 || 0), c24: +(p.priceChange?.h24 || 0),
      txns: {
        m5: p.txns?.m5 ? { b: +p.txns.m5.buys || 0, s: +p.txns.m5.sells || 0 } : null,
        h1: p.txns?.h1 ? { b: +p.txns.h1.buys || 0, s: +p.txns.h1.sells || 0 } : null,
        h6: p.txns?.h6 ? { b: +p.txns.h6.buys || 0, s: +p.txns.h6.sells || 0 } : null,
        h24: p.txns?.h24 ? { b: +p.txns.h24.buys || 0, s: +p.txns.h24.sells || 0 } : null
      },
      txns24: p.txns?.h24 ? ((+p.txns.h24.buys || 0) + (+p.txns.h24.sells || 0)) : null,
      site: p.info?.websites?.[0]?.url || prev?.site || null,
      tw: (p.info?.socials || []).find(x => x.type === "twitter")?.url || prev?.tw || null,
      tg: (p.info?.socials || []).find(x => x.type === "telegram")?.url || prev?.tg || null,
      cr: p.pairCreatedAt || prev?.cr || null,
      ver: labels.find(l => /^v\d/i.test(l))?.toLowerCase() || "v3",
      dex: p.dexId || "",
      src: "ds", t: Date.now()
    };
  }
}

export async function dsSlug(store) {
  const cached = await store.get("dsslug", { type: "json" }).catch(() => null);
  if (cached?.v) return cached.v;
  try {
    const r = await j(`${DS}/latest/dex/search?q=WETH`);
    for (const p of (r.pairs || [])) if (/robinhood/i.test(p.chainId || "")) {
      await store.setJSON("dsslug", { v: p.chainId }).catch(() => {});
      return p.chainId;
    }
  } catch (e) {}
  return "robinhood";
}

// Pull the whole trending universe in one pass.
export async function fetchUniverse(store, { gtPage = 1 } = {}) {
  const out = {};
  const errors = [];
  const slug = await dsSlug(store);

  // GeckoTerminal first (broad coverage of the chain's active pools)
  const gtRes = await Promise.allSettled(gtFeedUrls(gtPage).map(u => j(u)));
  for (const r of gtRes) { if (ok(r)) parseGT(r.value, out); else errors.push(String(r.reason).slice(0, 60)); }

  // DexScreener second so its data takes precedence where they overlap
  const dsQueries = ["WETH", "USDG", "robinhood", "hood", "pump", "cat", "dog", "moon"];
  const dsRes = await Promise.allSettled(dsQueries.map(q => j(`${DS}/latest/dex/search?q=${encodeURIComponent(q)}`)));
  for (const r of dsRes) if (ok(r)) parseDS(r.value.pairs, out, slug);

  const boosts = await Promise.allSettled([
    j(`${DS}/token-boosts/top/v1`),
    j(`${DS}/token-boosts/latest/v1`),
    j(`${DS}/token-profiles/latest/v1`)
  ]);
  const extra = new Set();
  for (const r of boosts) {
    if (!ok(r)) continue;
    const list = Array.isArray(r.value) ? r.value : (r.value.data || []);
    for (const t of list) if (t.chainId === slug && t.tokenAddress) extra.add(t.tokenAddress.toLowerCase());
  }
  const missing = [...extra].filter(a => !out[a]).slice(0, 60);
  for (let i = 0; i < missing.length; i += 30) {
    try {
      const res = await j(`${DS}/tokens/v1/${slug}/${missing.slice(i, i + 30).join(",")}`);
      parseDS(Array.isArray(res) ? res : (res.pairs || []), out, slug);
    } catch (e) {}
  }
  return { tokens: out, slug, errors };
}

// Refresh tokens we already know about so the board never goes stale between
// full passes — 30 addresses per call against DexScreener.
export async function refreshKnown(store, addrs, slug, { calls = 12 } = {}) {
  const out = {};
  for (let i = 0; i < calls && i * 30 < addrs.length; i++) {
    const batch = addrs.slice(i * 30, i * 30 + 30);
    if (!batch.length) break;
    try {
      const res = await j(`${DS}/tokens/v1/${slug}/${batch.join(",")}`);
      parseDS(Array.isArray(res) ? res : (res.pairs || []), out, slug);
    } catch (e) {}
  }
  return out;
}
