// MARKET DATA SWEEP — DexScreener batch enrichment over our chain-derived
// token universe.
//
// Why not keep sweeping the RPC? Because Robinhood's public RPC throttles us:
// the balanceOf sweep burned 780 calls and returned NOTHING (liqChecked: 0).
// Meanwhile DexScreener has already indexed this chain — including Uniswap v4,
// which our PoolCreated/PairCreated log scan structurally cannot see (v4 uses a
// singleton PoolManager with an Initialize event and no per-pool contract).
//
// Division of labour:
//   chain logs      -> the complete token UNIVERSE (v2/v3 pools + token addrs)
//   DexScreener     -> MARKET DATA for those tokens, v4 included
//   our swap scan   -> the EDGE: volume on brand-new pools before DS indexes them
const DS = "https://api.dexscreener.com";
const BATCH = 30;          // DS tokens/v1 accepts up to 30 addresses
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function dsJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (r.status === 429) throw new Error("429");
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

export async function detectSlug() {
  try {
    const j = await dsJson(`${DS}/latest/dex/search?q=WETH`);
    for (const p of (j.pairs || [])) if (/robinhood/i.test(p.chainId || "")) return p.chainId;
  } catch (e) {}
  return "robinhood";
}

function pickBest(pairs) {
  // deepest pair per token wins — that's the one a snipe would route through
  const best = {};
  for (const p of (pairs || [])) {
    const a = String(p.baseToken?.address || "").toLowerCase();
    if (!a) continue;
    const liq = +(p.liquidity?.usd || 0);
    if (!best[a] || liq > best[a]._liq) { best[a] = p; best[a]._liq = liq; }
  }
  return best;
}

export function normalize(p) {
  const labels = [].concat(p.labels || []);
  const ver = labels.find(l => /^v\d/i.test(l)) || (p.dexId === "uniswap" ? "v3" : "");
  return {
    pool: p.pairAddress,
    s: p.baseToken?.symbol || "?",
    n: p.baseToken?.name || "",
    img: p.info?.imageUrl || null,
    px: +p.priceUsd || null,
    liq: +(p.liquidity?.usd || 0),
    mc: +p.marketCap || +p.fdv || null,
    m5: +(p.volume?.m5 || 0), h1: +(p.volume?.h1 || 0),
    h6: +(p.volume?.h6 || 0), h24: +(p.volume?.h24 || 0),
    cm5: +(p.priceChange?.m5 || 0), c1: +(p.priceChange?.h1 || 0),
    c6: +(p.priceChange?.h6 || 0), c24: +(p.priceChange?.h24 || 0),
    site: p.info?.websites?.[0]?.url || null,
    tw: (p.info?.socials || []).find(x => x.type === "twitter")?.url || null,
    tg: (p.info?.socials || []).find(x => x.type === "telegram")?.url || null,
    cr: p.pairCreatedAt || null,
    ver,                                   // "v2" | "v3" | "v4" — routing depends on this
    dex: p.dexId || "",
    t: Date.now()
  };
}

// Rotate through the token universe, enriching a slice per invocation.
export async function sweepMarket(store, tokens, { calls = 45, deadline = 0 } = {}) {
  const st = (await store.get("mkt", { type: "json" }).catch(() => null)) || { d: {}, cursor: 0, laps: 0 };
  if (!tokens.length) return { st, enriched: 0, calls: 0 };
  const slug = (await store.get("dsslug", { type: "json" }).catch(() => null))?.v || await detectSlug();
  await store.setJSON("dsslug", { v: slug }).catch(() => {});

  let c = st.cursor || 0, used = 0, enriched = 0, limited = false;
  for (let i = 0; i < calls; i++) {
    if (deadline && Date.now() > deadline) break;
    const slice = [];
    for (let k = 0; k < BATCH; k++) { slice.push(tokens[c % tokens.length]); c++; }
    const uniq = [...new Set(slice)];
    try {
      const res = await dsJson(`${DS}/tokens/v1/${slug}/${uniq.join(",")}`);
      const pairs = Array.isArray(res) ? res : (res.pairs || []);
      const best = pickBest(pairs);
      for (const a of Object.keys(best)) { st.d[a] = normalize(best[a]); enriched++; }
      used++;
    } catch (e) {
      if (String(e.message) === "429") { limited = true; await sleep(1500); }
      used++;
    }
    if (c >= tokens.length) { c = 0; st.laps = (st.laps || 0) + 1; }
  }
  st.cursor = c;
  // keep the blob bounded: drop the least liquid when it grows large
  const keys = Object.keys(st.d);
  if (keys.length > 6000) {
    keys.sort((a, b) => (st.d[b].liq || 0) - (st.d[a].liq || 0));
    const keep = {};
    for (const k of keys.slice(0, 5000)) keep[k] = st.d[k];
    st.d = keep;
  }
  await store.setJSON("mkt", st).catch(() => {});
  return { st, enriched, calls: used, limited, slug };
}
