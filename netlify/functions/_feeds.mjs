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
    // Record this POOL rather than overwriting the token. A token can trade in
    // several pools; keeping only the deepest one threw away the rest of its
    // volume, and GT and DS often pick different pools for the same token —
    // which is how liquidity and volume ended up describing different markets.
    addPool(out, addr, a.address, {
      liq,
      m5: +(v.m5 || 0), h1: +(v.h1 || 0), h6: +(v.h6 || 0), h24: +(v.h24 || 0),
      px: +a.base_token_price_usd || null,
      txns: (function(){
        const tx = a.transactions || {};
        const pick = k => tx[k] ? { b: +tx[k].buys || 0, s: +tx[k].sells || 0 } : null;
        return { m5: pick("m5"), h1: pick("h1"), h6: pick("h6"), h24: pick("h24") };
      })()
    });
    if (prev && (prev.liq || 0) > liq) continue;     // metadata from the deepest
    out[addr] = {
      a: addr, pool: a.address,
      pools: out[addr] && out[addr].pools,     // live map, includes this pool
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

// Pools are keyed by ADDRESS, so the same pool seen from both GeckoTerminal and
// DexScreener is stored once — no double counting. The last writer wins per
// pool, which is fine: both sources describe the same market.
export function addPool(out, tokenAddr, poolAddr, data) {
  if (!poolAddr) return;
  const t = out[tokenAddr] || (out[tokenAddr] = { a: tokenAddr });
  if (!t.pools) t.pools = {};
  t.pools[String(poolAddr).toLowerCase()] = data;
}

// Derive the token-level numbers from every pool we've seen. Liquidity and
// volume are SUMS across pools, so they finally describe the same thing, and
// the headline pool is the deepest one (what we chart and route through).
export function finalizeTokens(out) {
  for (const addr of Object.keys(out)) {
    const t = out[addr];
    const pools = t.pools;
    if (!pools) continue;
    const keys = Object.keys(pools);
    if (!keys.length) continue;

    let liq = 0, m5 = 0, h1 = 0, h6 = 0, h24 = 0;
    const tx = { m5:{b:0,s:0}, h1:{b:0,s:0}, h6:{b:0,s:0}, h24:{b:0,s:0} };
    let best = null, bestLiq = -1;
    for (const k of keys) {
      const p = pools[k];
      liq += +p.liq || 0;
      m5 += +p.m5 || 0; h1 += +p.h1 || 0; h6 += +p.h6 || 0; h24 += +p.h24 || 0;
      for (const w of ["m5","h1","h6","h24"]) {
        const x = p.txns && p.txns[w];
        if (x) { tx[w].b += x.b || 0; tx[w].s += x.s || 0; }
      }
      if ((+p.liq || 0) > bestLiq) { bestLiq = +p.liq || 0; best = { k, p }; }
    }

    t.liq = liq;
    t.m5 = m5; t.h1 = h1; t.h6 = h6; t.h24 = h24;
    t.txns = tx;
    t.txns24 = tx.h24.b + tx.h24.s;
    t.poolCount = keys.length;
    if (best) {
      t.pool = best.k;                       // deepest pool: charts and routing
      if (best.p.px) t.px = best.p.px;       // price from the deepest market
    }
    delete t.pools;                          // don't ship the detail to clients
  }
  return out;
}

export function parseDS(pairs, out, slug) {
  for (const p of (pairs || [])) {
    if (slug ? p.chainId !== slug : !/robinhood/i.test(p.chainId || "")) continue;
    const addr = String(p.baseToken?.address || "").toLowerCase();
    if (!addr) continue;
    const liq = +(p.liquidity?.usd || 0);
    const prev = out[addr];
    addPool(out, addr, p.pairAddress, {
      liq,
      m5: +(p.volume?.m5 || 0), h1: +(p.volume?.h1 || 0),
      h6: +(p.volume?.h6 || 0), h24: +(p.volume?.h24 || 0),
      px: +p.priceUsd || null,
      txns: {
        m5: p.txns?.m5 ? { b: +p.txns.m5.buys || 0, s: +p.txns.m5.sells || 0 } : null,
        h1: p.txns?.h1 ? { b: +p.txns.h1.buys || 0, s: +p.txns.h1.sells || 0 } : null,
        h6: p.txns?.h6 ? { b: +p.txns.h6.buys || 0, s: +p.txns.h6.sells || 0 } : null,
        h24: p.txns?.h24 ? { b: +p.txns.h24.buys || 0, s: +p.txns.h24.sells || 0 } : null
      }
    });
    // DexScreener is the reference for what users expect to see, so its record
    // wins on ties — we only skip it for a strictly deeper pool.
    if (prev && prev.src === "ds" && (prev.liq || 0) > liq) continue;
    const labels = [].concat(p.labels || []);
    out[addr] = {
      a: addr, pool: p.pairAddress,
      pools: out[addr] && out[addr].pools,     // live map, includes this pool
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
      // DexScreener exposes no trending-pairs endpoint, but `boosts.active` is
      // on the pair — paid promotion is a real component of what surfaces on
      // their board, and it costs money, which fake tokens rarely spend.
      boosts: +(p.boosts && p.boosts.active) || 0,
      hasProfile: !!(p.info && (p.info.imageUrl || (p.info.socials || []).length)),
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
