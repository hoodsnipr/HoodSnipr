// Shared crawl engine — used by both the scheduled crawler and the board
// endpoint. Keeping it in one place means the timer-driven crawl and any
// on-demand cold-start burst can never drift apart.
import { getStore } from "@netlify/blobs";

const GT = "https://api.geckoterminal.com/api/v2";
const NET = "robinhood";
const DS = "https://api.dexscreener.com";
const BS = "https://robinhoodchain.blockscout.com/api/v2";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

const MAX_TOKENS = 2500;
const BOARD_TTL = 25000;
const GT_CALLS = 12;          // per invocation — stays under 30/min
const REGISTRY_CAP = 3000;

const json = (c, b) => new Response(JSON.stringify(b), {
  status: c, headers: { "content-type": "application/json", "cache-control": "public, max-age=10" }
});
const j = async (u) => {
  const r = await fetch(u, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(u.replace(GT, "") + " -> " + r.status);
  return r.json();
};

// ---------- filters ----------
const STABLE = ["USDC","USDT","USDG","DAI","USDE","FDUSD","USD1","PYUSD","TUSD","USDS","GHO","FRAX","LUSD","BUSD","USDB"];
const ETHISH = ["WETH","ETH","WSTETH","STETH","RETH","CBETH","EZETH","WEETH","METH"];
const STOCKS = ["AAPL","TSLA","NVDA","MSFT","AMZN","GOOGL","GOOG","META","AMD","NFLX","COIN","HOOD","SPY","QQQ","PLTR","MSTR","GME","AMC","INTC","JPM","V","MA","DIS","BA","XOM","WMT","KO","PFE","T","F","NIO","BABA","SOFI","RIVN","LCID","CRCL","UNH","LLY","AVGO","ORCL","CRM","ADBE","ABNB","UBER","SHOP","PYPL","SNAP","RDDT","SMCI","ARM","MU","QCOM","TSM","IBIT","GLD","SLV","VOO","VTI","DJT","MARA","RIOT"];

function excluded(sym, name) {
  const S = String(sym || "").toUpperCase().trim();
  const N = (String(name || "") + " " + S).toLowerCase();
  if (!S || S === "?") return true;
  if (/\bclosed\b|\brugged\b/.test(N)) return true;
  if (ETHISH.includes(S)) return true;
  if (STABLE.includes(S) || STABLE.includes(S.replace(/^W/, ""))) return true;
  const base = /x$/.test(String(sym || "")) && S.length > 2 ? S.slice(0, -1) : S;
  if (STOCKS.includes(base) || STOCKS.includes(S)) return true;
  if (/xstock|tokenized|\betf\b|\bequity\b|\bshares?\b/.test(N)) return true;
  return false;
}

// ---------- the crawl plan: every sort × every free page ----------
function buildPlan() {
  const plan = [];
  const sorts = ["h24_volume_usd_desc", "h24_tx_count_desc", "h24_volume_usd_liquidity_desc"];
  for (let p = 1; p <= 10; p++) for (const s of sorts) plan.push(`${GT}/networks/${NET}/pools?page=${p}&sort=${s}&include=base_token`);
  for (let p = 1; p <= 10; p++) plan.push(`${GT}/networks/${NET}/new_pools?page=${p}&include=base_token`);
  plan.push(`${GT}/networks/${NET}/trending_pools?page=1&include=base_token`);
  plan.push(`${GT}/networks/${NET}/trending_pools?page=2&include=base_token`);
  return plan;
}

function absorbGT(page, reg, now) {
  let added = 0;
  const inc = {};
  for (const t of (page.included || [])) if (t.type === "token") inc[t.id] = t.attributes || {};
  for (const p of (page.data || [])) {
    const a = p.attributes || {};
    const pool = String(a.address || "").toLowerCase();
    if (!pool) continue;
    const btId = p.relationships?.base_token?.data?.id;
    const tok = btId ? btId.split("_").pop().toLowerCase() : null;
    if (!tok) continue;
    const meta = inc[btId] || {};
    const nm = String(a.name || "").toLowerCase();
    if (/\bclosed\b/.test(nm)) { delete reg[pool]; continue; }
    const v = a.volume_usd || {}, ch = a.price_change_percentage || {};
    if (!reg[pool]) added++;
    const prev = reg[pool] || {};
    reg[pool] = {
      tok, pool,
      s: meta.symbol || prev.s || String(a.name || "?").split(" / ")[0],
      n: meta.name || prev.n || "",
      img: (meta.image_url && meta.image_url !== "missing.png") ? meta.image_url : (prev.img || null),
      px: +a.base_token_price_usd || prev.px || null,
      liq: +(a.reserve_in_usd || 0),
      mc: +a.market_cap_usd || +a.fdv_usd || prev.mc || null,
      m5: +(v.m5 || 0), h1: +(v.h1 || 0), h6: +(v.h6 || 0), h24: +(v.h24 || 0),
      cm5: +(ch.m5 || 0), c1: +(ch.h1 || 0), c6: +(ch.h6 || 0), c24: +(ch.h24 || 0),
      cr: a.pool_created_at ? new Date(a.pool_created_at).getTime() : (prev.cr || null),
      site: prev.site || null, tw: prev.tw || null, tg: prev.tg || null,
      seen: now
    };
  }
  return added;
}

async function absorbDS(reg, now) {
  const queries = ["WETH", "USDG", "robinhood", "hood", WETH];
  const settled = await Promise.allSettled(queries.map(q => j(`${DS}/latest/dex/search?q=${encodeURIComponent(q)}`)));
  let all = [], slug = null, added = 0;
  for (const s of settled) if (s.status === "fulfilled") all = all.concat(s.value.pairs || []);
  for (const p of all) if (/robinhood/i.test(p.chainId || "")) { slug = p.chainId; break; }
  for (const p of all) {
    if (slug ? p.chainId !== slug : !/robinhood/i.test(p.chainId || "")) continue;
    const pool = String(p.pairAddress || "").toLowerCase();
    const tok = String(p.baseToken?.address || "").toLowerCase();
    if (!pool || !tok) continue;
    if (!reg[pool]) added++;
    const prev = reg[pool] || {};
    reg[pool] = {
      ...prev, tok, pool,
      s: p.baseToken?.symbol || prev.s || "?",
      n: p.baseToken?.name || prev.n || "",
      img: p.info?.imageUrl || prev.img || null,
      px: +p.priceUsd || prev.px || null,
      liq: +(p.liquidity?.usd || prev.liq || 0),
      mc: +p.marketCap || +p.fdv || prev.mc || null,
      m5: +(p.volume?.m5 || 0), h1: +(p.volume?.h1 || 0), h6: +(p.volume?.h6 || 0), h24: +(p.volume?.h24 || 0),
      cm5: +(p.priceChange?.m5 || 0), c1: +(p.priceChange?.h1 || 0),
      c6: +(p.priceChange?.h6 || 0), c24: +(p.priceChange?.h24 || 0),
      cr: p.pairCreatedAt || prev.cr || null,
      site: p.info?.websites?.[0]?.url || prev.site || null,
      tw: (p.info?.socials || []).find(x => x.type === "twitter")?.url || prev.tw || null,
      tg: (p.info?.socials || []).find(x => x.type === "telegram")?.url || prev.tg || null,
      seen: now
    };
  }
  return { added, slug };
}

// Blockscout is OPTIONAL — used only for the chain-wide token count. It must
// never be able to empty the board (that bug capped the list at the fallback).
async function tokenCensus(store) {
  const cur = (await store.get("census2", { type: "json" }).catch(() => null)) || { n: 0, next: null, seen: {}, ts: 0 };
  try {
    let next = cur.next, pages = 0;
    while (pages < 3) {
      const qs = next ? "?type=ERC-20&" + new URLSearchParams(next).toString() : "?type=ERC-20";
      const page = await j(`${BS}/tokens${qs}`);
      for (const t of (page.items || [])) {
        const a = String(t.address || t.address_hash || "").toLowerCase();
        if (a && !cur.seen[a]) { cur.seen[a] = 1; cur.n++; }
      }
      pages++;
      next = page.next_page_params || null;
      if (!next) break;
    }
    cur.next = next; cur.ts = Date.now();
    if (Object.keys(cur.seen).length > 8000) cur.seen = {};   // keep the blob small
    await store.setJSON("census2", cur).catch(() => {});
  } catch (e) { /* explorer down — board still works */ }
  return cur;
}

function buildRows(reg) {
  const byTok = {};
  for (const pool of Object.keys(reg)) {
    const r = reg[pool];
    if (!r || !r.tok) continue;
    if (r.tok === WETH) continue;
    if (excluded(r.s, r.n)) continue;
    // one deterministic rule, applied server-side only, so every client that
    // fetches this board sees byte-identical rows
    const hasMarket = (r.h24 > 0 || r.h6 > 0 || r.h1 > 0 || r.m5 > 0 || r.liq > 100);
    if (!hasMarket) continue;
    if (!r.px && !(r.liq > 0)) continue;   // no price and no liquidity = not tradeable
    const cur = byTok[r.tok];
    if (!cur || (r.liq || 0) > (cur.liq || 0)) {
      byTok[r.tok] = cur ? { ...cur, ...r, img: r.img || cur.img, site: r.site || cur.site, tw: r.tw || cur.tw, tg: r.tg || cur.tg, mc: r.mc || cur.mc } : r;
    } else {
      cur.img = cur.img || r.img; cur.site = cur.site || r.site;
      cur.tw = cur.tw || r.tw; cur.tg = cur.tg || r.tg; cur.mc = cur.mc || r.mc;
    }
  }
  const rows = Object.values(byTok).map(r => ({
    a: r.tok, p: r.pool, s: r.s, n: r.n, img: r.img || null,
    px: r.px, mc: r.mc, liq: r.liq,
    m5: r.m5, h1: r.h1, h6: r.h6, h24: r.h24,
    cm5: r.cm5, c1: r.c1, c6: r.c6, c24: r.c24,
    site: r.site, tw: r.tw, tg: r.tg, cr: r.cr
  }));
  rows.sort((x, y) =>
    (y.h24 || 0) - (x.h24 || 0) ||
    (y.liq || 0) - (x.liq || 0) ||
    (x.a < y.a ? -1 : x.a > y.a ? 1 : 0));   // address tie-break = stable everywhere
  return rows.slice(0, MAX_TOKENS);
}


// ---------- one crawl pass ----------
export async function crawlOnce(store, calls) {
  const reg = (await store.get("reg2", { type: "json" }).catch(() => null)) || {};
  const cur = (await store.get("cursor2", { type: "json" }).catch(() => null)) || { i: 0 };
  const plan = buildPlan();
  const now = Date.now();

  const slice = [];
  for (let k = 0; k < calls; k++) slice.push(plan[(cur.i + k) % plan.length]);
  const pages = await Promise.allSettled(slice.map(u => j(u)));
  let added = 0, okPages = 0;
  for (const p of pages) if (p.status === "fulfilled") { okPages++; added += absorbGT(p.value, reg, now); }

  const ds = await absorbDS(reg, now).catch(() => ({ added: 0, slug: null }));
  added += ds.added;

  for (const k of Object.keys(reg)) if (now - (reg[k].seen || 0) > 45 * 60e3) delete reg[k];
  let out = reg;
  const left = Object.keys(reg);
  if (left.length > REGISTRY_CAP) {
    left.sort((a, b) => (reg[b].liq || 0) - (reg[a].liq || 0));
    out = {};
    for (const k of left.slice(0, REGISTRY_CAP)) out[k] = reg[k];
  }
  await store.setJSON("reg2", out).catch(() => {});
  await store.setJSON("cursor2", { i: (cur.i + calls) % plan.length }).catch(() => {});
  return { added, okPages, pools: Object.keys(out).length, dsSlug: ds.slug, cursor: cur.i };
}

// ---------- rebuild + cache the finished board ----------
export async function rebuildBoard(store) {
  const reg = (await store.get("reg2", { type: "json" }).catch(() => null)) || {};
  const census = await tokenCensus(store).catch(() => ({ n: 0 }));
  const rows = buildRows(reg);
  const now = Date.now();
  let vol24 = 0, liq = 0;
  for (const r of rows) { vol24 += r.h24 || 0; liq += r.liq || 0; }
  const hourAgo = now - 3600e3, dayAgo = now - 86400e3;
  let newHour = 0, newDay = 0;
  for (const r of rows) { if (r.cr >= hourAgo) newHour++; if (r.cr >= dayAgo) newDay++; }
  const payload = {
    ts: now, v: 2, rows,
    stats: {
      tokensCreated: Math.max(census.n || 0, rows.length),
      tokensTradeable: rows.length,
      tokensNewHour: newHour, tokensNewDay: newDay,
      vol24, liq, pools: Object.keys(reg).length
    }
  };
  await store.setJSON("board2", payload).catch(() => {});
  return payload;
}

export { buildRows, tokenCensus };
