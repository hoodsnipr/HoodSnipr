// Build the board from CHAIN data (authoritative, unlimited) and use the public
// indexers only as a cosmetic overlay for logos/socials. This inverts the old
// design, where indexer rate limits capped how many tokens could ever appear.
import { rpcBatch } from "./_rpc.mjs";

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const Q96 = 2n ** 96n;

const STABLE = ["USDC","USDT","USDG","DAI","USDE","FDUSD","USD1","PYUSD","TUSD","USDS","GHO","FRAX","LUSD","BUSD"];
const ETHISH = ["WETH","ETH","WSTETH","STETH","RETH","CBETH","EZETH","WEETH","METH"];
const STOCKS = ["AAPL","TSLA","NVDA","MSFT","AMZN","GOOGL","GOOG","META","AMD","NFLX","COIN","HOOD","SPY","QQQ","PLTR","MSTR","GME","AMC","INTC","JPM","V","MA","DIS","BA","XOM","WMT","KO","PFE","T","F","NIO","BABA","SOFI","RIVN","LCID","CRCL","UNH","LLY","AVGO","ORCL","CRM","ADBE","ABNB","UBER","SHOP","PYPL","SNAP","RDDT","SMCI","ARM","MU","QCOM","TSM","IBIT","GLD","SLV","VOO","VTI","DJT","MARA","RIOT"];

// Robinhood Chain is full of tokenized equities. A fixed ticker list can never
// keep up (there are thousands of listed securities), so we match on the SHAPE
// of a security token as well: corporate suffixes, share-class markers, ETF and
// fund language, and the xTICKER convention. Memecoins essentially never carry
// "Inc.", "N.V.", "Class A", or "ETF" in their name.
const CORP_RE = /\b(inc|inc\.|incorporated|corp|corp\.|corporation|company|co\.|ltd|ltd\.|limited|plc|llc|lp|n\.?v\.?|s\.?a\.?|a\.?g\.?|s\.?p\.?a\.?|ab|asa|oyj|holdings?|group|partners|technologies|technology inc|industries|international|enterprises|motors|pharmaceuticals?|biosciences?|therapeutics|laboratories|systems inc|class [abc]|adr|ads|depositary|preferred|common stock|ordinary shares?|shares?)\b/i;
const FUND_RE = /\b(etf|etn|fund|index|trust|reit|spdr|ishares|vanguard|invesco|proshares|direxion|wisdomtree|treasury|bond|futures|leveraged|inverse|2x|3x)\b/i;
const TOKENIZED_RE = /\b(tokenized|xstock|x-stock|equity|equities|stock|security token|rwa)\b/i;

export function excluded(sym, name) {
  const S = String(sym || "").toUpperCase().trim();
  const N = String(name || "").trim();
  const both = (N + " " + S).toLowerCase();

  if (!S || S === "?" || S.length > 16) return true;
  if (/\bclosed\b|\brugged\b|\btest\b/.test(both)) return true;
  if (ETHISH.includes(S)) return true;
  if (STABLE.includes(S) || STABLE.includes(S.replace(/^W/, ""))) return true;
  if (/^(USD|EUR|GBP|JPY|CHF|CAD|AUD)[A-Z]?$/.test(S)) return true;

  // explicit ticker list (fast path for the megacaps)
  const base = /^X/.test(S) && S.length > 2 ? S.slice(1) : (/X$/.test(S) && S.length > 2 ? S.slice(0, -1) : S);
  if (STOCKS.includes(S) || STOCKS.includes(base)) return true;

  // shape-based security detection — this is what catches the long tail
  if (CORP_RE.test(N)) return true;
  if (FUND_RE.test(N)) return true;
  if (TOKENIZED_RE.test(both)) return true;

  // xTICKER / TICKERx convention with a plausible equity ticker underneath
  if (/^X[A-Z]{2,5}$/.test(S) || /^[A-Z]{2,5}X$/.test(S)) {
    if (!/^(X|[A-Z]{2,5}X)$/.test(base) && base.length >= 2 && base.length <= 5) {
      // only exclude when the name also reads like a company/fund
      if (CORP_RE.test(N) || FUND_RE.test(N) || /\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(N)) return true;
    }
  }
  return false;
}

// Volume from compact buckets: 12 fine (5-min) covering an hour, 24 hourly
// covering a day. Same numbers as before at ~1/90th the storage.
const FINE = 12, HOURS = 24;
function volFine(v) { return v ? v.f[Math.floor(Date.now() / 300000) % FINE] || 0 : 0; }
function volHour(v) { return v ? v.f.reduce((a, b) => a + (b || 0), 0) : 0; }
function volHours(v, n) {
  if (!v) return 0;
  const hb = Math.floor(Date.now() / 3600000) % HOURS;
  let s = 0;
  for (let i = 0; i < n; i++) s += v.h[((hb - i) % HOURS + HOURS) % HOURS] || 0;
  return s;
}

// token price in USD from the pool's sqrtPriceX96
function priceFromSqrt(sqrtStr, wethIsT0, dec, ethUsd) {
  try {
    const sq = BigInt(sqrtStr);
    if (sq <= 0n) return null;
    // raw = (sqrt/2^96)^2 = amount1/amount0 in raw units — keep precision in BigInt
    const num = sq * sq;
    const SCALE = 10n ** 18n;
    const rawScaled = (num * SCALE) / (Q96 * Q96);      // raw * 1e18
    const raw = Number(rawScaled) / 1e18;
    if (!isFinite(raw) || raw <= 0) return null;
    const adj = Math.pow(10, dec - 18);
    const inEth = wethIsT0 ? (1 / raw) * adj : raw * adj;
    const usd = inEth * ethUsd;
    return isFinite(usd) && usd > 0 ? usd : null;
  } catch (e) { return null; }
}

// liquidity ≈ 2 × WETH held by the pool (standard AMM approximation)
export async function poolLiquidity(pools, ethUsd) {
  const out = {};
  const SEL = "0x70a08231";   // balanceOf(address)
  for (let i = 0; i < pools.length; i += 120) {
    const slice = pools.slice(i, i + 120);
    const calls = slice.map(p => ({
      method: "eth_call",
      params: [{ to: WETH, data: SEL + "000000000000000000000000" + p.slice(2) }, "latest"]
    }));
    const res = await rpcBatch(calls).catch(() => []);
    slice.forEach((p, k) => {
      try {
        const bal = Number(BigInt(res[k] || "0x0")) / 1e18;
        if (bal > 0) out[p] = bal * 2 * ethUsd;
      } catch (e) {}
    });
  }
  return out;
}

export function buildChainRows({ poolsIdx, swaps, tokmeta, ethUsd, liqMap, overlay, market }) {
  const byTok = {};
  for (const pool of Object.keys(poolsIdx.pools || {})) {
    const entry = poolsIdx.pools[pool];
    const tok = typeof entry === "string" ? entry : entry.t;
    if (!tok || tok === WETH) continue;
    const tm = (tokmeta || {})[tok] || {};
    const sym = tm.s || "?", name = tm.n || "";
    if (excluded(sym, name)) continue;

    const ov = (overlay || {})[tok] || {};
    const vArr = (swaps.v || swaps.vol || {})[pool];
    const pxRec = (swaps.px || {})[pool];
    const dec = tm.d == null ? 18 : tm.d;

    // our chain-derived volume is fresher for new pools; the market's is more
    // complete for established ones — take the larger of the two
    const m5 = Math.max(volFine(vArr) * ethUsd, ov.m5 || 0);
    const h1 = Math.max(volHour(vArr) * ethUsd, ov.h1 || 0);
    const h6 = Math.max(volHours(vArr, 6) * ethUsd, ov.h6 || 0);
    const h24 = Math.max(volHours(vArr, 24) * ethUsd, ov.h24 || 0);

    let px = pxRec ? priceFromSqrt(pxRec.s, pxRec.t0 === 1, dec, ethUsd) : null;
    const liq = liqMap[pool] || ov.liq || 0;

    // overlay: logos, socials, market cap, and a better price if the indexer has one
    if (ov.px) px = ov.px;                 // indexer price beats our sqrt estimate

    // A pool holding real WETH is tradeable even if we haven't recorded a swap
    // for it yet (volume history builds over the first 24h of indexing).
    const hasSomething = h24 > 0 || h6 > 0 || h1 > 0 || m5 > 0 || liq > 25;
    if (!hasSomething) continue;

    const row = {
      a: tok, p: pool, s: ov.s || sym, n: ov.n || name, d: dec,
      img: ov.img || null, px, mc: ov.mc || null, liq,
      m5, h1, h6, h24,
      cm5: ov.cm5 || 0, c1: ov.c1 || 0, c6: ov.c6 || 0, c24: ov.c24 || 0,
      site: ov.site || null, tw: ov.tw || null, tg: ov.tg || null,
      ver: ov.ver || "", dex: ov.dex || "",
      cr: null, blk: 0,
      chain: true
    };
    const cur = byTok[tok];
    if (!cur || (row.liq || 0) > (cur.liq || 0) || (row.h24 || 0) > (cur.h24 || 0)) byTok[tok] = row;
  }
  // Uniswap v4 uses a singleton PoolManager — there is no per-pool contract for
  // our factory-log scan to find. Those tokens only exist in the market data, so
  // they're added here or they'd be invisible to users.
  if (market) {
    for (const tok of Object.keys(market)) {
      const m = market[tok];
      if (!m || byTok[tok]) continue;
      if (excluded(m.s, m.n)) continue;
      const live = (m.h24 > 0 || m.h6 > 0 || m.h1 > 0 || m.m5 > 0 || m.liq > 25);
      if (!live) continue;
      byTok[tok] = {
        a: tok, p: m.pool, s: m.s, n: m.n, d: 18,
        img: m.img || null, px: m.px, mc: m.mc, liq: m.liq,
        m5: m.m5, h1: m.h1, h6: m.h6, h24: m.h24,
        cm5: m.cm5, c1: m.c1, c6: m.c6, c24: m.c24,
        site: m.site, tw: m.tw, tg: m.tg, cr: m.cr,
        ver: m.ver || "", dex: m.dex || "", chain: false
      };
    }
  }
  const rows = Object.values(byTok);
  rows.sort((x, y) => (y.h24 || 0) - (x.h24 || 0) || (y.liq || 0) - (x.liq || 0) || (x.a < y.a ? -1 : 1));
  return rows;
}
