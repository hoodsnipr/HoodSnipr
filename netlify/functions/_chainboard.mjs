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

// ONE ROW PER TOKEN. A token can trade in several venues (v2 pair, v3 pools at
// different fee tiers, a v4 pool in the singleton PoolManager). Previously each
// of those could produce its own row, so users saw the same token repeatedly.
// Now venues are collected onto a single row and the UI lets the user choose.
export function buildChainRows({ poolsIdx, swaps, tokmeta, ethUsd, liqMap, overlay, market }) {
  const tok2 = {};   // token address -> aggregated record

  function ensure(tok) {
    if (!tok2[tok]) tok2[tok] = { a: tok, venues: [], _seenPools: new Set() };
    return tok2[tok];
  }
  function addVenue(rec, v) {
    if (!v || !v.pool) return;
    const key = String(v.pool).toLowerCase();
    if (rec._seenPools.has(key)) return;
    rec._seenPools.add(key);
    rec.venues.push({ pool: key, ver: (v.ver || "v3").toLowerCase(), liq: +v.liq || 0, fee: v.fee || null });
  }

  // ---- 1. chain-derived pools (v2/v3, discovered from factory logs) ----
  for (const pool of Object.keys(poolsIdx.pools || {})) {
    const entry = poolsIdx.pools[pool];
    const tok = typeof entry === "string" ? entry : entry.t;
    if (!tok || tok === WETH) continue;
    const tm = (tokmeta || {})[tok] || {};
    const ov = (overlay || {})[tok] || {};
    const sym = ov.s || tm.s || "?", name = ov.n || tm.n || "";
    if (excluded(sym, name)) continue;

    const vArr = (swaps.v || swaps.vol || {})[pool];
    const pxRec = (swaps.px || {})[pool];
    const dec = tm.d == null ? 18 : tm.d;
    const liq = liqMap[pool] || 0;
    const hasAny = vArr || liq > 25 || ov.px;
    if (!hasAny) continue;

    const rec = ensure(tok);
    addVenue(rec, { pool, ver: "v3", liq });
    rec.d = dec;
    rec.s = sym; rec.n = name;
    rec._chainPx = pxRec ? priceFromSqrt(pxRec.s, pxRec.t0 === 1, dec, ethUsd) : rec._chainPx;
    rec._chainVol = {
      m5: Math.max(rec._chainVol?.m5 || 0, volFine(vArr) * ethUsd),
      h1: Math.max(rec._chainVol?.h1 || 0, volHour(vArr) * ethUsd),
      h6: Math.max(rec._chainVol?.h6 || 0, volHours(vArr, 6) * ethUsd),
      h24: Math.max(rec._chainVol?.h24 || 0, volHours(vArr, 24) * ethUsd)
    };
    rec._chainLiq = Math.max(rec._chainLiq || 0, liq);
  }

  // ---- 2. market data (adds v4, which has no per-pool contract to scan) ----
  if (market) {
    for (const tok of Object.keys(market)) {
      const m = market[tok];
      if (!m || tok === WETH) continue;
      if (excluded(m.s, m.n)) continue;
      const live = (m.h24 > 0 || m.h6 > 0 || m.h1 > 0 || m.m5 > 0 || m.liq > 25);
      if (!live && !tok2[tok]) continue;
      const rec = ensure(tok);
      addVenue(rec, { pool: m.pool, ver: m.ver || "v3", liq: m.liq });
      rec.s = rec.s && rec.s !== "?" ? rec.s : (m.s || "?");
      rec.n = rec.n || m.n || "";
      rec._mkt = m;
    }
  }

  // ---- 3. flatten to display rows ----
  const rows = [];
  for (const tok of Object.keys(tok2)) {
    const rec = tok2[tok];
    const m = rec._mkt || {};
    const cv = rec._chainVol || {};
    // "indexed" means the market feed actually has trading data for this token
    const hasMarketVol = !!rec._mkt && ((m.h24 || 0) > 0 || (m.h6 || 0) > 0 || (m.h1 || 0) > 0 || (m.m5 || 0) > 0 || (m.liq || 0) > 0);
    if (excluded(rec.s || m.s, rec.n || m.n)) continue;

    // deepest venue is the default route
    rec.venues.sort((a, b) => (b.liq || 0) - (a.liq || 0));
    const primary = rec.venues[0] || { pool: m.pool, ver: m.ver || "v3", liq: m.liq || 0 };
    const versions = [...new Set(rec.venues.map(v => v.ver))];

    const row = {
      a: tok,
      p: primary.pool,
      s: rec.s && rec.s !== "?" ? rec.s : (m.s || "?"),
      n: rec.n || m.n || "",
      d: rec.d == null ? 18 : rec.d,
      img: m.img || null,
      px: (hasMarketVol ? m.px : null) || rec._chainPx || m.px || null,
      mc: m.mc || null,
      liq: hasMarketVol ? (m.liq || 0) : (rec._chainLiq || 0),
      // ONE coherent source per token. Taking max() per timeframe let a token
      // pull h24 from the indexer but 5M from our partial chain scan, so its
      // rank jumped incoherently between tabs and didn't match DexScreener.
      // Indexer data is complete, so it wins outright when present; our
      // chain-derived volume is the fallback for pools too new to be indexed.
      ...(hasMarketVol
        ? { m5: m.m5 || 0, h1: m.h1 || 0, h6: m.h6 || 0, h24: m.h24 || 0, vsrc: "idx" }
        : { m5: cv.m5 || 0, h1: cv.h1 || 0, h6: cv.h6 || 0, h24: cv.h24 || 0, vsrc: "chain" }),
      cm5: m.cm5 || 0, c1: m.c1 || 0, c6: m.c6 || 0, c24: m.c24 || 0,
      site: m.site || null, tw: m.tw || null, tg: m.tg || null,
      cr: m.cr || null,
      ver: primary.ver,
      vers: versions,                                    // e.g. ["v3","v4"]
      venues: rec.venues.slice(0, 4).map(v => ({ p: v.pool, v: v.ver, l: Math.round(v.liq || 0) }))
    };
    if (row.s === "?" || !row.s) continue;               // unnamed = not displayable
    // A trending board should look like a trading venue, not a graveyard: a
    // token needs either real volume or meaningful liquidity to make the list.
    const anyVol = row.h24 > 0 || row.h6 > 0 || row.h1 > 0 || row.m5 > 0;
    const alive = (anyVol && row.liq >= 250) || row.liq >= 1000;
    if (!alive) continue;
    rows.push(row);
  }

  rows.sort((x, y) => (y.h24 || 0) - (x.h24 || 0) || (y.liq || 0) - (x.liq || 0) || (x.a < y.a ? -1 : 1));
  return collapseTickers(rows);
}

// TICKER COLLISION.
// Three "$NARWHAL" rows with $11M / $405K / $65K market caps and different
// holder counts are THREE DIFFERENT CONTRACTS wearing the same ticker, not one
// token in three pools. Memecoin chains are full of these impersonators, and
// showing them all is confusing and dangerous — a user sniping "NARWHAL" could
// easily buy the fake.
//
// One entry per ticker: keep the deepest-liquidity contract and drop the rest
// entirely. No badges, no alternates list — the impostors simply don't exist.
function normTicker(sym) {
  return String(sym || "").toUpperCase().replace(/^\$+/, "").replace(/[^A-Z0-9]/g, "");
}
function collapseTickers(rows) {
  const byTicker = {};
  const order = [];
  for (const r of rows) {
    const k = normTicker(r.s);
    if (!k) continue;
    if (!byTicker[k]) { byTicker[k] = r; order.push(k); continue; }
    const keep = byTicker[k];
    // Deepest liquidity is the real market for this ticker. Everything else is
    // discarded outright — as far as the app is concerned it doesn't exist.
    const challengerBetter =
      (r.liq || 0) > (keep.liq || 0) ||
      ((r.liq || 0) === (keep.liq || 0) && (r.h24 || 0) > (keep.h24 || 0));
    if (challengerBetter) byTicker[k] = r;
  }
  const out = order.map(k => byTicker[k]);
  out.sort((x, y) => (y.h24 || 0) - (x.h24 || 0) || (y.liq || 0) - (x.liq || 0) || (x.a < y.a ? -1 : 1));
  return out;
}
