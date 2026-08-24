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
import { rpcBatch, decodeStr } from "./_rpc.mjs";

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
  const set = new Set();
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

  const need = addrs.filter(a => !st.tokens[a] || !st.tokens[a].sym).slice(0, limit);
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
