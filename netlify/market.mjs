// FULL-CHAIN market cache for Robinhood Chain (4663).
//
// The point of HoodSnipr is catching volume EARLY, which means tracking every
// pool on the chain — not the top of one sorted list. So this does two things:
//
//   1. DISCOVERY — fans out across many entry points (trending, new pools,
//      several sort orders, DexScreener searches + boost/profile feeds).
//      Different sorts surface different pools; new_pools catches launches.
//   2. REGISTRY — every pool ever discovered is persisted in Blobs. Each cycle
//      refreshes a rotating slice via GT's multi-pool endpoint (30 per call),
//      so the tracked universe GROWS instead of resetting to page 1.
//
// One shared cache serves all users, so this costs the same whether 1 or 10,000
// people are on the site.
import { getStore } from "@netlify/blobs";

const GT = "https://api.geckoterminal.com/api/v2";
const NET = "robinhood";
const DS = "https://api.dexscreener.com";
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const TTL_MS = 20000;        // hot discovery
const ROTATE_TTL_MS = 60000; // registry refresh slice
const REGISTRY_CAP = 3500;   // headroom so the client can page 2500 deep

const json = (code, body, age) => new Response(JSON.stringify(body), {
  status: code,
  headers: {
    "content-type": "application/json",
    "cache-control": "public, max-age=10",
    ...(age != null ? { "x-cache-age-ms": String(age) } : {})
  }
});

async function j(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("upstream " + r.status);
  return r.json();
}
const ok = s => s.status === "fulfilled";

// ---------- discovery: many doors into the chain ----------
function discoveryUrls() {
  return [
    `${GT}/networks/${NET}/trending_pools?page=1&include=base_token`,
    `${GT}/networks/${NET}/new_pools?page=1&include=base_token`,
    `${GT}/networks/${NET}/new_pools?page=2&include=base_token`,
    `${GT}/networks/${NET}/pools?page=1&sort=h24_volume_usd_desc&include=base_token`,
    `${GT}/networks/${NET}/pools?page=2&sort=h24_volume_usd_desc&include=base_token`,
    `${GT}/networks/${NET}/pools?page=1&sort=h24_tx_count_desc&include=base_token`
  ];
}

const DS_QUERIES = ["WETH", "USDG", "robinhood", "hood", WETH];

async function collectDS() {
  const settled = await Promise.allSettled(
    DS_QUERIES.map(q => j(`${DS}/latest/dex/search?q=${encodeURIComponent(q)}`))
  );
  let all = [];
  for (const s of settled) if (ok(s)) all = all.concat(s.value.pairs || []);
  let slug = null;
  for (const p of all) if (/robinhood/i.test(p.chainId || "")) { slug = p.chainId; break; }
  let pairs = all.filter(p => slug ? p.chainId === slug : /robinhood/i.test(p.chainId || ""));

  if (slug) {
    const feeds = await Promise.allSettled([
      j(`${DS}/token-profiles/latest/v1`),
      j(`${DS}/token-boosts/latest/v1`),
      j(`${DS}/token-boosts/top/v1`)
    ]);
    const addrs = new Set();
    for (const f of feeds) {
      if (!ok(f)) continue;
      const list = Array.isArray(f.value) ? f.value : (f.value.data || []);
      for (const t of list) if (t.chainId === slug && t.tokenAddress) addrs.add(t.tokenAddress.toLowerCase());
    }
    const known = new Set(pairs.map(p => (p.baseToken?.address || "").toLowerCase()));
    const missing = [...addrs].filter(a => !known.has(a)).slice(0, 60);
    for (let i = 0; i < missing.length; i += 30) {
      try {
        const res = await j(`${DS}/tokens/v1/${slug}/${missing.slice(i, i + 30).join(",")}`);
        pairs = pairs.concat(Array.isArray(res) ? res : (res.pairs || []));
      } catch (e) {}
    }
  }
  const seen = new Set(), out = [];
  for (const p of pairs) {
    const k = (p.pairAddress || "").toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(p);
  }
  return { pairs: out, slug };
}

// ---------- registry: the growing universe ----------
// A closed pool comes back with a placeholder symbol. Never register it —
// otherwise the rotation wastes calls refreshing dead pairs forever.
function isClosedPool(p) {
  const a = p.attributes || {};
  const nm = String(a.name || "").toLowerCase();
  if (/\bclosed\b/.test(nm)) return true;
  const liq = +(a.reserve_in_usd || 0), v24 = +((a.volume_usd || {}).h24 || 0);
  return liq === 0 && v24 === 0;
}
function poolsFromPages(pages) {
  const addrs = [];
  for (const pg of pages) for (const p of (pg.data || [])) {
    if (isClosedPool(p)) continue;
    const a = (p.attributes?.address || "").toLowerCase();
    if (a) addrs.push(a);
  }
  return addrs;
}
function stripClosed(pages) {
  return pages.map(pg => ({ ...pg, data: (pg.data || []).filter(p => !isClosedPool(p)) }));
}

async function refreshRegistrySlice(store, registry) {
  // rotate through the registry, 30 pools per multi-call
  const meta = await store.get("rotate", { type: "json" }).catch(() => null);
  const now = Date.now();
  if (meta && now - meta.ts < ROTATE_TTL_MS) return { pages: meta.pages || [], cursor: meta.cursor };
  const cursor = meta?.cursor || 0;
  const all = Object.keys(registry);
  if (!all.length) return { pages: [], cursor: 0 };
  const SLICE = 30, CALLS = 8;
  const pages = [];
  let c = cursor;
  for (let n = 0; n < CALLS; n++) {
    const chunk = [];
    for (let i = 0; i < SLICE && chunk.length < SLICE; i++) {
      chunk.push(all[c % all.length]); c++;
      if (c % all.length === 0 && chunk.length >= all.length) break;
    }
    if (!chunk.length) break;
    try { pages.push(await j(`${GT}/networks/${NET}/pools/multi/${[...new Set(chunk)].join(",")}?include=base_token`)); }
    catch (e) {}
    if (all.length <= SLICE * (n + 1)) break;  // registry smaller than what we've covered
  }
  await store.setJSON("rotate", { ts: now, cursor: c, pages }).catch(() => {});
  return { pages, cursor: c };
}

async function latestBlock() {
  try {
    const r = await fetch(RPC, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] })
    });
    return parseInt((await r.json()).result, 16) || null;
  } catch (e) { return null; }
}

// Every unique base token ever seen on the chain, with the moment we first saw
// it. This is what makes "TOKENS CREATED" a real, monotonically rising counter
// instead of a snapshot of whatever the current page happens to hold.
function harvestTokens(gtPages, dsPairs) {
  const found = new Map();   // addr -> createdAt (ms) if known
  for (const pg of gtPages) for (const p of (pg.data || [])) {
    const a = p.attributes || {};
    const bt = p.relationships?.base_token?.data?.id;
    if (!bt) continue;
    const addr = bt.split("_").pop().toLowerCase();
    const created = a.pool_created_at ? new Date(a.pool_created_at).getTime() : null;
    const prev = found.get(addr);
    if (prev == null || (created && created < prev)) found.set(addr, created ?? prev ?? null);
  }
  for (const p of dsPairs) {
    const addr = (p.baseToken?.address || "").toLowerCase();
    if (!addr) continue;
    const created = p.pairCreatedAt || null;
    const prev = found.get(addr);
    if (prev == null || (created && created < prev)) found.set(addr, created ?? prev ?? null);
  }
  return found;
}

function aggregate(gtPages, dsPairs) {
  let vol24 = 0, txns24 = 0, liq = 0;
  const tokens = new Set(), seen = new Set();
  for (const pg of gtPages) for (const p of (pg.data || [])) {
    const a = p.attributes || {};
    const key = (a.address || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    vol24 += +((a.volume_usd || {}).h24 || 0);
    liq += +(a.reserve_in_usd || 0);
    const t = (a.transactions || {}).h24;
    if (t) txns24 += (+t.buys || 0) + (+t.sells || 0);
    const bt = p.relationships?.base_token?.data?.id;
    if (bt) tokens.add(bt.split("_").pop().toLowerCase());
  }
  for (const p of dsPairs) {
    const k = (p.pairAddress || "").toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    vol24 += +(p.volume?.h24 || 0);
    liq += +(p.liquidity?.usd || 0);
    const t = p.txns?.h24;
    if (t) txns24 += (+t.buys || 0) + (+t.sells || 0);
    const a = (p.baseToken?.address || "").toLowerCase();
    if (a) tokens.add(a);
  }
  return { vol24, txns24, liq, tokenCount: tokens.size, poolCount: seen.size };
}

async function buildPayload(store) {
  const registry = (await store.get("registry", { type: "json" }).catch(() => null)) || {};
  const [discSettled, rot, dsRes, pxRes, blk] = await Promise.all([
    Promise.allSettled(discoveryUrls().map(u => j(u))),
    refreshRegistrySlice(store, registry).catch(() => ({ pages: [] })),
    collectDS().catch(() => ({ pairs: [], slug: null })),
    j(`${GT}/simple/networks/${NET}/token_price/${WETH}`).catch(() => null),
    latestBlock()
  ]);
  const discPages = discSettled.filter(ok).map(x => x.value);
  const gtPages = stripClosed(discPages.concat(rot.pages || []));

  // grow the registry with everything we just saw
  const now = Date.now();
  for (const a of poolsFromPages(gtPages)) registry[a] = now;

  // ---- cumulative token census ----
  const tokenStore = (await store.get("tokens", { type: "json" }).catch(() => null)) || {};
  const harvest = harvestTokens(gtPages, dsRes.pairs);
  let added = 0;
  for (const [addr, created] of harvest) {
    if (tokenStore[addr] == null) { tokenStore[addr] = created || now; added++; }
    else if (created && created < tokenStore[addr]) tokenStore[addr] = created;
  }
  if (added) await store.setJSON("tokens", tokenStore).catch(() => {});
  const tokenAddrs = Object.keys(tokenStore);
  const hourAgo = now - 3600e3, dayAgo = now - 86400e3;
  let newHour = 0, newDay = 0;
  for (const a of tokenAddrs) {
    const t = tokenStore[a];
    if (t >= hourAgo) newHour++;
    if (t >= dayAgo) newDay++;
  }
  const tokenCensus = { total: tokenAddrs.length, newHour, newDay, addedThisCycle: added };
  // drop registry entries whose pools came back closed this cycle
  for (const pg of (rot.pages || [])) for (const p of (pg.data || [])) {
    if (isClosedPool(p)) delete registry[(p.attributes?.address || "").toLowerCase()];
  }
  const keys = Object.keys(registry);
  if (keys.length > REGISTRY_CAP) {
    keys.sort((x, y) => registry[y] - registry[x]);          // freshest first
    const trimmed = {};
    for (const k of keys.slice(0, REGISTRY_CAP)) trimmed[k] = registry[k];
    await store.setJSON("registry", trimmed).catch(() => {});
  } else {
    await store.setJSON("registry", registry).catch(() => {});
  }

  let ethUsd = null;
  if (pxRes) {
    const m = ((pxRes.data || {}).attributes || {}).token_prices || {};
    const v = +m[WETH.toLowerCase()];
    if (v > 0) ethUsd = v;
  }
  if (!gtPages.length && !dsRes.pairs.length) throw new Error("all upstreams failed");

  return {
    ts: now,
    ethUsd,
    gtPages,
    dsPairs: dsRes.pairs,
    dsSlug: dsRes.slug,
    registrySize: Object.keys(registry).length,
    tokenCensus,
    stats: { ...aggregate(gtPages, dsRes.pairs), block: blk, tokensCreated: tokenCensus.total, tokensNewHour: tokenCensus.newHour, tokensNewDay: tokenCensus.newDay }
  };
}

export default async () => {
  const store = getStore("hoodsnipr-cache");
  const cached = await store.get("market", { type: "json" }).catch(() => null);
  const age = cached ? Date.now() - cached.ts : Infinity;
  if (cached && age < TTL_MS) return json(200, cached, age);
  try {
    const fresh = await buildPayload(store);
    await store.setJSON("market", fresh);
    return json(200, fresh, 0);
  } catch (e) {
    if (cached) return json(200, { ...cached, stale: true }, age);
    return json(503, { error: "market unavailable" });
  }
};
