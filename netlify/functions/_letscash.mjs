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
