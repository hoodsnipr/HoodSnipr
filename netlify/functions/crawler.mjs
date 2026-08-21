// OVERLAY FETCHER — cosmetic only.
// The chain indexer owns prices, volume, and the token universe. This just
// grabs logos/socials/market-cap from the public screeners, at a call volume
// far under GeckoTerminal's 30/min so we stop getting 429'd.
import { store as _store, storeMode } from "./_store.mjs";

const GT = "https://api.geckoterminal.com/api/v2";
const NET = "robinhood";
const DS = "https://api.dexscreener.com";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const j = async (u) => {
  const r = await fetch(u, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

export default async () => {
  const store = await _store("hoodsnipr-cache");
  const ov = (await store.get("overlay", { type: "json" }).catch(() => null)) || {};

  // 4 GT calls + 2 DS calls per minute — comfortably inside every limit
  const urls = [
    `${GT}/networks/${NET}/trending_pools?page=1&include=base_token`,
    `${GT}/networks/${NET}/new_pools?page=1&include=base_token`,
    `${GT}/networks/${NET}/pools?page=1&sort=h24_volume_usd_desc&include=base_token`,
    `${GT}/networks/${NET}/pools?page=2&sort=h24_volume_usd_desc&include=base_token`
  ];
  const res = await Promise.allSettled(urls.map(u => j(u)));
  for (const r of res) {
    if (r.status !== "fulfilled") continue;
    const inc = {};
    for (const t of (r.value.included || [])) if (t.type === "token") inc[t.id] = t.attributes || {};
    for (const p of (r.value.data || [])) {
      const a = p.attributes || {}, bt = p.relationships?.base_token?.data?.id;
      if (!bt) continue;
      const addr = bt.split("_").pop().toLowerCase();
      const m = inc[bt] || {}, ch = a.price_change_percentage || {};
      ov[addr] = {
        ...(ov[addr] || {}),
        s: m.symbol || ov[addr]?.s, n: m.name || ov[addr]?.n,
        img: (m.image_url && m.image_url !== "missing.png") ? m.image_url : (ov[addr]?.img || null),
        px: +a.base_token_price_usd || ov[addr]?.px || null,
        mc: +a.market_cap_usd || +a.fdv_usd || ov[addr]?.mc || null,
        cm5: +(ch.m5 || 0), c1: +(ch.h1 || 0), c6: +(ch.h6 || 0), c24: +(ch.h24 || 0),
        t: Date.now()
      };
    }
  }

  // DexScreener for socials + logos
  try {
    const d = await j(`${DS}/latest/dex/search?q=WETH`);
    for (const p of (d.pairs || [])) {
      if (!/robinhood/i.test(p.chainId || "")) continue;
      const addr = String(p.baseToken?.address || "").toLowerCase();
      if (!addr) continue;
      ov[addr] = {
        ...(ov[addr] || {}),
        s: p.baseToken?.symbol || ov[addr]?.s, n: p.baseToken?.name || ov[addr]?.n,
        img: p.info?.imageUrl || ov[addr]?.img || null,
        mc: +p.marketCap || +p.fdv || ov[addr]?.mc || null,
        site: p.info?.websites?.[0]?.url || ov[addr]?.site || null,
        tw: (p.info?.socials || []).find(x => x.type === "twitter")?.url || ov[addr]?.tw || null,
        tg: (p.info?.socials || []).find(x => x.type === "telegram")?.url || ov[addr]?.tg || null,
        t: Date.now()
      };
    }
  } catch (e) {}

  // ETH price for USD conversion in the indexer
  try {
    const px = await j(`${GT}/simple/networks/${NET}/token_price/${WETH}`);
    const map = ((px.data || {}).attributes || {}).token_prices || {};
    const v = +map[WETH.toLowerCase()];
    if (v > 0) await store.setJSON("ethusd", { v, ts: Date.now() });
  } catch (e) {}

  const keys = Object.keys(ov);
  if (keys.length > 4000) { const t = {}; for (const k of keys.slice(-3000)) t[k] = ov[k]; await store.setJSON("overlay", t); }
  else await store.setJSON("overlay", ov);

  return new Response(JSON.stringify({ ok: true, overlay: Object.keys(ov).length }), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "* * * * *" };
