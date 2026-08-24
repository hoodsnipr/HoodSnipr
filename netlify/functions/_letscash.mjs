// LETSCASH.FUN INTEGRATION
//
// letscash is CASHCAT's launchpad. Unlike pons (Uniswap v3), its tokens launch
// into UNISWAP V4 pools with a fee hook — which is why so many of the hook
// addresses our v4 scanner learned end in "cc". Per its docs the tokens trade
// on standard v4 rails, so HoodSnipr's existing v4 route executes them with no
// new swap code. What we add here is identification and the two things that
// genuinely change a trade:
//
//   1. A TRADING TAX of 1 / 3 / 5 or 10 percent, chosen at launch, taken in the
//      pool's quote asset. A user needs to see that before they buy.
//   2. Some pools are priced in USDG rather than ETH. Our v4 path settles the
//      ETH leg, so a USDG-quoted pool is not routable by us and must say so
//      rather than failing at signature time.
//
// Identification: the factory enforces that EVERY letscash token address ends
// in "cc". That alone is weak — one address in 256 ends that way by chance — so
// it's only accepted alongside a v4 pool whose hook is a known letscash hook.
// The hook set is learned from the chain: a hook shared by many "cc" tokens is
// the launchpad's fee engine.
import { store as _store } from "./_store.mjs";
import { rpc, rpcBatch, getLogs, decodeStr, addrFromTopic, words } from "./_rpc.mjs";

// CONFIRMED FROM LIVE CHAIN DATA: this hook appears on dozens of cc-stamped
// tokens carrying ipfs logos (Turbine, DENS, CATEYES, CRYCAT, CASHDEPT, …).
// Note that plenty of genuine letscash tokens have NO hook at all — Pibble,
// GATO, LEVCAT, FOMEOW, SIMBA — so the hook confirms a token, it never gates it.
export const KNOWN_HOOKS = new Set([
  "0x75a54357d9c78a2db19004a5fdc76c50f9242aec"
]);

export const LETSCASH = {
  site: "https://www.letscash.fun",
  legacy: "https://legacy.letscash.fun",
  suffix: "cc",
  taxRates: [100, 300, 500, 1000],      // bps, from the docs' ladder
  platformBps: 30                        // 0.3% at every rate
};

export function hasCcStamp(addr) {
  return /cc$/i.test(String(addr || "").trim());
}

// Learn which hooks belong to letscash by seeing which ones recur across
// "cc"-stamped tokens. One shared hook across many stamped tokens is the fee
// engine; a hook seen once under a single token is not evidence.
export async function learnLetscashHooks(v4Keys) {
  const store = await _store("hoodsnipr-cache");
  const st = (await store.get("letscash", { type: "json" }).catch(() => null)) || { hooks: {}, tokens: {} };
  const ZERO = "0x0000000000000000000000000000000000000000";

  for (const token of Object.keys(v4Keys || {})) {
    if (!hasCcStamp(token)) continue;
    for (const k of (v4Keys[token] || [])) {
      const h = String(k.hooks || "").toLowerCase();
      if (!h || h === ZERO) continue;
      st.hooks[h] = (st.hooks[h] || 0) + 1;
    }
  }
  await store.setJSON("letscash", st).catch(() => {});
  return st;
}

// A hook counts as letscash once it has been seen under at least two distinct
// stamped tokens — a single sighting could be coincidence.
export async function letscashHookSet(min = 2) {
  const store = await _store("hoodsnipr-cache");
  const st = (await store.get("letscash", { type: "json" }).catch(() => null)) || { hooks: {} };
  const set = new Set(KNOWN_HOOKS);
  for (const h of Object.keys(st.hooks || {})) if (st.hooks[h] >= min) set.add(h);
  return set;
}

// Classify a token from what we already know — no extra RPC.
export function classify(token, poolKeys, hookSet, wethAddr, usdgAddr) {
  if (!hasCcStamp(token)) return null;
  const keys = poolKeys || [];
  if (!keys.length) return null;

  const ZERO = "0x0000000000000000000000000000000000000000";
  const weth = String(wethAddr || "").toLowerCase();
  const usdg = String(usdgAddr || "").toLowerCase();

  for (const k of keys) {
    const h = String(k.hooks || "").toLowerCase();
    if (!h || h === ZERO) continue;
    if (hookSet && hookSet.size && !hookSet.has(h)) continue;

    const c0 = String(k.c0).toLowerCase(), c1 = String(k.c1).toLowerCase();
    const other = (c0 === String(token).toLowerCase()) ? c1 : c0;
    const quote = other === ZERO ? "ETH"
                : other === weth ? "WETH"
                : (usdg && other === usdg) ? "USDG"
                : "OTHER";
    return {
      isLetscash: true,
      hook: h,
      quote,
      routable: quote === "ETH" || quote === "WETH",
      poolId: k.id || null,
      fee: k.fee,
      tokenUrl: `${LETSCASH.site}/token/${token}`
    };
  }
  return null;
}


// ---------------------------------------------------------------------------
// DISCOVERY
//
// Tagging tokens the screener feeds already knew about was not enough: the
// feeds do not always carry a letscash token's image, and with the logo filter
// in place those tokens were being dropped from trending entirely. Their docs
// are explicit that a token stores "its logo, description, and socials on
// chain" — so we read the metadata from the contract instead of waiting for a
// screener to index it, exactly as we do for pons.
//
// Discovery needs no factory address. Every letscash pool is a v4 pool whose
// hook is the launchpad's fee engine, and we already index v4 pool keys. So the
// token list falls out of data we hold.
const META_SEL = {
  symbol: "0x95d89b41", name: "0x06fdde03", decimals: "0x313ce567",
  logo: "0xfb7f21eb",                 // logo()
  image: "0xf3ccaac0",                // image() — fallback naming
  description: "0x7284e416",
  socials: "0x53cd512a"
};

// Every token that has a v4 pool under a known letscash hook.
export async function discoverTokens(v4Keys, hookSet) {
  const out = {};
  const ZERO = "0x0000000000000000000000000000000000000000";
  for (const token of Object.keys(v4Keys || {})) {
    for (const k of (v4Keys[token] || [])) {
      const h = String(k.hooks || "").toLowerCase();
      if (!h || h === ZERO) continue;
      if (!hookSet.has(h)) continue;
      out[token] = { token, pool: k.id || null, hook: h, fee: k.fee, ts: k.ts, c0: k.c0, c1: k.c1 };
      break;
    }
  }
  return out;
}

// Pull symbol / name / logo straight off the contract. Batched, and cached so a
// token is only read once.
export async function hydrateTokens(addrs, { budgetMs = 6000, limit = 30 } = {}) {
  const t0 = Date.now();
  const store = await _store("hoodsnipr-cache");
  const st = (await store.get("letscash", { type: "json" }).catch(() => null)) || { hooks: {}, tokens: {} };
  st.tokens = st.tokens || {};

  // Hard guard: only cc-stamped addresses can ever enter this store.
  const need = addrs
    .filter(a => hasCcStamp(a))
    .filter(a => !st.tokens[a] || !st.tokens[a].sym)
    .slice(0, limit);
  let done = 0;
  for (let i = 0; i < need.length && Date.now() - t0 < budgetMs - 800; i += 6) {
    const slice = need.slice(i, i + 6);
    const calls = [];
    for (const a of slice) {
      calls.push({ method: "eth_call", params: [{ to: a, data: META_SEL.symbol }, "latest"] });
      calls.push({ method: "eth_call", params: [{ to: a, data: META_SEL.name }, "latest"] });
      calls.push({ method: "eth_call", params: [{ to: a, data: META_SEL.logo }, "latest"] });
      calls.push({ method: "eth_call", params: [{ to: a, data: META_SEL.image }, "latest"] });
      calls.push({ method: "eth_call", params: [{ to: a, data: META_SEL.socials }, "latest"] });
    }
    const res = await rpcBatch(calls).catch(() => []);
    slice.forEach((a, n) => {
      const b = n * 5;
      const rec = st.tokens[a] || (st.tokens[a] = { token: a });
      rec.sym = decodeStr(res[b]) || rec.sym || null;
      rec.name = decodeStr(res[b + 1]) || rec.name || null;
      const logo = decodeStr(res[b + 2]) || decodeStr(res[b + 3]);
      if (logo && /^(https?:\/\/|ipfs:\/\/|data:image)/i.test(logo)) rec.logo = logo;
      const soc = decodeStr(res[b + 4]);
      if (soc) rec.socials = soc.slice(0, 300);
      rec.t = Date.now();
      done++;
    });
  }
  await store.setJSON("letscash", st).catch(() => {});
  return { hydrated: done, total: Object.keys(st.tokens).length };
}

// ipfs:// won't render in an <img>; normalise to a gateway.
export function normalizeLogo(u) {
  if (!u) return null;
  const s2 = String(u).trim();
  if (/^ipfs:\/\//i.test(s2)) return "https://ipfs.io/ipfs/" + s2.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//, "");
  if (/^(https?:\/\/|data:image)/i.test(s2)) return s2;
  return null;
}

// The store had picked up WETH, USDG, Robinhood stock tokens and ~150 unrelated
// addresses, because an early hydrate call was handed too broad a list. They
// can't be letscash tokens — the factory stamps every one with a trailing "cc"
// — and they were eating the hydration budget that real tokens needed.
export async function pruneStore() {
  const store = await _store("hoodsnipr-cache");
  const st = (await store.get("letscash", { type: "json" }).catch(() => null)) || { tokens: {} };
  const before = Object.keys(st.tokens || {}).length;
  const kept = {};
  for (const a of Object.keys(st.tokens || {})) if (hasCcStamp(a)) kept[a] = st.tokens[a];
  st.tokens = kept;
  await store.setJSON("letscash", st).catch(() => {});
  return { before, after: Object.keys(kept).length, removed: before - Object.keys(kept).length };
}

// Everything we know, keyed by token address, for the board to merge.
export async function letscashMap() {
  const store = await _store("hoodsnipr-cache");
  const st = (await store.get("letscash", { type: "json" }).catch(() => null)) || { tokens: {} };
  return st.tokens || {};
}


// The socials field is a free-form string on chain — sometimes JSON, sometimes
// a delimited list. Pull whatever URLs are in it and sort them into the fields
// the board already understands.
export function parseSocials(raw) {
  const out = { tw: null, tg: null, site: null };
  if (!raw) return out;
  let text = String(raw);
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object") {
      text = Object.values(j).filter(v => typeof v === "string").join(" ");
    }
  } catch (e) { /* not JSON, treat as text */ }

  const urls = text.match(/(https?:\/\/[^\s",'\]}]+)/gi) || [];
  for (const u of urls) {
    const l = u.toLowerCase();
    if (!out.tw && /(twitter\.com|x\.com)/.test(l)) out.tw = u;
    else if (!out.tg && /t\.me/.test(l)) out.tg = u;
    else if (!out.site) out.site = u;
  }
  // bare handles are common too
  if (!out.tw) {
    const h = text.match(/(?:^|[\s,"])@([A-Za-z0-9_]{2,15})/);
    if (h) out.tw = "https://x.com/" + h[1];
  }
  return out;
}


// ---------------------------------------------------------------------------
// COMPLETE ENUMERATION
//
// Deriving the token list from pools we happened to have indexed was never
// going to be complete — a token only entered that index if something looked it
// up first, so established coins like $INTERN were simply absent. pons works
// because we walk its factory events end to end; letscash needs the same.
//
// We don't need their factory address to do it. Every letscash token address
// ends in "cc", enforced by the factory, and every letscash pool is a Uniswap
// v4 pool — so walking the PoolManager's Initialize events and keeping the
// currencies that carry the stamp enumerates the whole launchpad. The onchain
// logo() call then confirms each one, because an ordinary ERC-20 doesn't
// implement it.
const INIT_TOPICS = [
  "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438",
  "0x3fd553db44f207b1f41348cfc4d251860814af9eadc470e8e7895e4d120511f4",
  "0x9e5fdb1dbcd8227784f3a3765e991e72fd8e71bfc967286dcf973ff804adc183"
];
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export async function scanLetscash(budgetMs = 7000) {
  const t0 = Date.now();
  const store = await _store("hoodsnipr-cache");
  const st = (await store.get("letscash", { type: "json" }).catch(() => null))
    || { hooks: {}, tokens: {} };
  st.tokens = st.tokens || {};
  st.scan = st.scan || { lo: null, chunk: 40000, done: false };

  const v4 = (await store.get("v4pools", { type: "json" }).catch(() => null)) || {};
  const manager = v4.manager;
  if (!manager) return { ok: false, error: "PoolManager unknown — run v4pools?findmanager=1" };
  const topics = (v4.topics && v4.topics.length) ? v4.topics : INIT_TOPICS;

  let head;
  try { head = Number(BigInt(await rpc("eth_blockNumber", []))); }
  catch (e) { return { ok: false, error: "rpc: " + e.message }; }
  if (st.scan.lo == null) st.scan.lo = head;

  let found = 0, scanned = 0;
  while (Date.now() - t0 < budgetMs - 1200 && !st.scan.done && st.scan.lo > 0) {
    const size = Math.max(4000, st.scan.chunk);
    const from = Math.max(0, st.scan.lo - size), to = st.scan.lo;
    try {
      const logs = await getLogs(from, to, [topics], manager) || [];
      for (const lg of logs) {
        if (!lg.topics || lg.topics.length !== 4) continue;
        const c0 = addrFromTopic(lg.topics[2]);
        const c1 = addrFromTopic(lg.topics[3]);
        const w = words(lg.data);
        if (w.length < 3) continue;
        const fee = Number(BigInt("0x" + w[0]));
        let ts = BigInt("0x" + w[1]); if (ts >= (1n << 255n)) ts -= (1n << 256n);
        const hooks = ("0x" + w[2].slice(24)).toLowerCase();

        for (const side of [c0, c1]) {
          if (!side || side === ZERO_ADDR) continue;
          if (!hasCcStamp(side)) continue;
          if (st.tokens[side]) continue;
          st.tokens[side] = {
            token: side, poolId: lg.topics[1], c0, c1,
            fee, ts: Number(ts), hooks,
            block: Number(BigInt(lg.blockNumber)), seen: Date.now()
          };
          if (hooks && hooks !== ZERO_ADDR) st.hooks[hooks] = (st.hooks[hooks] || 0) + 1;
          found++;
        }
      }
      scanned += (to - from);
      st.scan.lo = from;
      if (st.scan.chunk < 40000) st.scan.chunk = Math.min(40000, st.scan.chunk * 2);
      if (from === 0) st.scan.done = true;
    } catch (e) {
      st.scan.chunk = Math.max(2000, Math.floor(st.scan.chunk / 3));
      if (st.scan.chunk <= 2000) st.scan.lo = from;
    }
    await store.setJSON("letscash", st).catch(() => {});
  }

  return {
    ok: true, found, scanned, cursor: st.scan.lo, done: st.scan.done,
    tokens: Object.keys(st.tokens).length
  };
}

// Find one token now, without waiting for the sweep. Initialize indexes both
// currencies, so a direct filter answers immediately.
export async function findToken(token) {
  const store = await _store("hoodsnipr-cache");
  const st = (await store.get("letscash", { type: "json" }).catch(() => null)) || { hooks: {}, tokens: {} };
  st.tokens = st.tokens || {};
  const t = String(token || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(t)) return { ok: false, error: "bad token" };
  if (st.tokens[t]) return { ok: true, cached: true, rec: st.tokens[t] };

  const v4 = (await store.get("v4pools", { type: "json" }).catch(() => null)) || {};
  const manager = v4.manager;
  if (!manager) return { ok: false, error: "PoolManager unknown" };
  const topics = (v4.topics && v4.topics.length) ? v4.topics : INIT_TOPICS;
  const pad = "0x" + t.replace(/^0x/, "").padStart(64, "0");

  for (const slot of [2, 3]) {
    const filter = [topics, null, null, null];
    filter[slot] = pad;
    try {
      const logs = await rpc("eth_getLogs", [{
        fromBlock: "0x0", toBlock: "latest", address: manager, topics: filter
      }]);
      for (const lg of (logs || [])) {
        if (!lg.topics || lg.topics.length !== 4) continue;
        const w = words(lg.data);
        if (w.length < 3) continue;
        let ts = BigInt("0x" + w[1]); if (ts >= (1n << 255n)) ts -= (1n << 256n);
        st.tokens[t] = {
          token: t, poolId: lg.topics[1],
          c0: addrFromTopic(lg.topics[2]), c1: addrFromTopic(lg.topics[3]),
          fee: Number(BigInt("0x" + w[0])), ts: Number(ts),
          hooks: ("0x" + w[2].slice(24)).toLowerCase(),
          block: Number(BigInt(lg.blockNumber)), seen: Date.now()
        };
        await store.setJSON("letscash", st).catch(() => {});
        return { ok: true, rec: st.tokens[t] };
      }
    } catch (e) {}
  }
  return { ok: false, error: "no v4 Initialize log found for that token" };
}
