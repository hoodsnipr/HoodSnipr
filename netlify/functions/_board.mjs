// BOARD BUILDER — screener-aligned.
//
// Goal: open HoodSnipr, pick a timeframe, and see the same tokens a user would
// see on a screener for that timeframe. So we rank strictly by that timeframe's
// volume, keep exactly one contract per ticker, and drop anything that looks
// like an impersonator or a security token.
import { store as _store } from "./_store.mjs";
import { fetchUniverse, refreshKnown, dsSlug } from "./_feeds.mjs";

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

const STABLE = ["USDC","USDT","USDG","DAI","USDE","FDUSD","USD1","PYUSD","TUSD","USDS","GHO","FRAX","LUSD","BUSD","USDB"];
const ETHISH = ["WETH","ETH","WSTETH","STETH","RETH","CBETH","EZETH","WEETH","METH"];
const STOCKS = ["AAPL","TSLA","NVDA","MSFT","AMZN","GOOGL","GOOG","META","AMD","NFLX","COIN","HOOD","SPY","QQQ","PLTR","MSTR","GME","AMC","INTC","JPM","V","MA","DIS","BA","XOM","WMT","KO","PFE","T","F","NIO","BABA","SOFI","RIVN","LCID","CRCL","UNH","LLY","AVGO","ORCL","CRM","ADBE","ABNB","UBER","SHOP","PYPL","SNAP","RDDT","SMCI","ARM","MU","QCOM","TSM","IBIT","GLD","SLV","VOO","VTI","DJT","MARA","RIOT","BRKB","ASML","TQQQ"];

const CORP_RE = /\b(inc|inc\.|incorporated|corp|corp\.|corporation|company|co\.|ltd|ltd\.|limited|plc|llc|lp|n\.?v\.?|s\.?a\.?|a\.?g\.?|holdings?|group|partners|industries|international|enterprises|motors|pharmaceuticals?|biosciences?|therapeutics|laboratories|class [abc]|adr|ads|depositary|preferred|common stock|ordinary shares?)\b/i;
const FUND_RE = /\b(etf|etn|fund|index|trust|reit|spdr|ishares|vanguard|invesco|proshares|direxion|wisdomtree|treasury|bond|futures|leveraged|inverse|2x|3x)\b/i;

export function excluded(sym, name) {
  const S = String(sym || "").toUpperCase().trim();
  const N = String(name || "").trim();
  const both = (N + " " + S).toLowerCase();
  if (!S || S === "?" || S.length > 16) return true;
  if (/\bclosed\b|\brugged\b|\btest\b/.test(both)) return true;
  if (ETHISH.includes(S)) return true;
  if (STABLE.includes(S) || STABLE.includes(S.replace(/^W/, ""))) return true;
  const base = /^X/.test(S) && S.length > 2 ? S.slice(1) : (/X$/.test(S) && S.length > 2 ? S.slice(0, -1) : S);
  if (STOCKS.includes(S) || STOCKS.includes(base)) return true;
  if (CORP_RE.test(N) || FUND_RE.test(N)) return true;
  if (/xstock|tokenized|\betf\b|\bequity\b|security token|\brwa\b/.test(both)) return true;
  return false;
}

// "$$CLOCKIN" is a copycat of "$CLOCKIN": strip every leading $ and any
// non-alphanumerics so both normalise to the same key and only one survives.
export const normTicker = s => String(s || "").toUpperCase().replace(/^\$+/, "").replace(/[^A-Z0-9]/g, "");

// Impersonators typically pair a famous ticker with implausible numbers — a
// multi-billion market cap on a few thousand dollars of liquidity. Real tokens
// don't look like that.
function looksFake(t) {
  const liq = +t.liq || 0, mc = +t.mc || 0, vol = +t.h24 || 0;
  if (mc > 0 && liq > 0 && mc / liq > 100000) return true;    // absurd mcap vs depth
  if (mc > 1e9 && liq < 250000) return true;                  // "billion dollar" dust
  if (liq < 100 && vol < 100) return true;                    // no real market at all
  return false;
}

// ---------------- TRENDING SCORE ----------------
// Pure volume ranking answers "what traded most", which isn't the same question
// as "what's trending". A screener's trending tab surfaces tokens whose
// activity is ACCELERATING and where buyers dominate. Three factors:
//
//   accel  — recent trade rate vs the longer window's rate. A token doing
//            $50k in 5 minutes ($10k/min) against $600k over an hour
//            ($10k/min) is steady; the same token doing $50k in 5 min against
//            $120k in an hour ($2k/min) is heating up 5x.
//   buys   — buy share of transactions. Sell-dominated pumps get damped.
//   depth  — log-scaled liquidity, so a $2k pool can't outrank a $2M one on a
//            single lucky trade.
const WINDOW_MIN = { m5: 5, h1: 60, h6: 360, h24: 1440 };
const NEXT_WINDOW = { m5: "h1", h1: "h6", h6: "h24", h24: "h24" };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function accelFactor(t, tf) {
  const longer = NEXT_WINDOW[tf];
  if (longer === tf) return 1;
  const rNow = (+t[tf] || 0) / WINDOW_MIN[tf];
  const rRef = (+t[longer] || 0) / WINDOW_MIN[longer];
  if (rRef <= 0) return rNow > 0 ? 2.5 : 1;      // brand-new activity
  return clamp(rNow / rRef, 0.2, 5);
}
function buyFactor(t, tf) {
  const x = t.txns && t.txns[tf];
  if (!x) return 1;
  const total = (x.b || 0) + (x.s || 0);
  if (total < 5) return 1;                        // too few trades to read
  const share = x.b / total;                      // 0..1
  return clamp(0.55 + share * 0.9, 0.55, 1.45);   // 50/50 -> ~1.0
}
function depthFactor(liq) {
  const l = Math.max(0, +liq || 0);
  return clamp(Math.log10(l + 100) / 5.5, 0.15, 1.2);   // ~$316k -> 1.0
}
export function trendScore(t, tf) {
  const vol = +t[tf] || 0;
  if (vol <= 0) return 0;
  // sqrt keeps a whale trade from dominating outright
  return Math.sqrt(vol) * accelFactor(t, tf) * buyFactor(t, tf) * depthFactor(t.liq);
}

export function buildBoard(tokens) {
  const byTicker = {};
  for (const addr of Object.keys(tokens)) {
    const t = tokens[addr];
    if (!t || addr === WETH) continue;
    if (excluded(t.s, t.n)) continue;
    if (looksFake(t)) continue;
    const hasMarket = (t.h24 > 0 || t.h6 > 0 || t.h1 > 0 || t.m5 > 0) && (t.liq || 0) >= 200;
    if (!hasMarket) continue;

    const k = normTicker(t.s);
    if (!k) continue;
    const cur = byTicker[k];
    if (!cur) { byTicker[k] = t; continue; }
    // Highest 24h volume is the one a screener surfaces for that ticker.
    const better = (t.h24 || 0) > (cur.h24 || 0) ||
      ((t.h24 || 0) === (cur.h24 || 0) && (t.liq || 0) > (cur.liq || 0));
    if (better) byTicker[k] = t;
  }

  const rows = Object.values(byTicker).map(t => ({
    ts5: trendScore(t, "m5"), ts1: trendScore(t, "h1"),
    ts6: trendScore(t, "h6"), ts24: trendScore(t, "h24"),
    txns: t.txns || null,
    a: t.a, p: t.pool, s: String(t.s || "").replace(/^\$+/, ""), n: t.n,
    img: t.img || null, px: t.px, mc: t.mc, liq: t.liq,
    m5: t.m5 || 0, h1: t.h1 || 0, h6: t.h6 || 0, h24: t.h24 || 0,
    cm5: t.cm5 || 0, c1: t.c1 || 0, c6: t.c6 || 0, c24: t.c24 || 0,
    site: t.site || null, tw: t.tw || null, tg: t.tg || null,
    cr: t.cr || null, ver: t.ver || "v3", dex: t.dex || "", src: t.src || ""
  }));
  rows.sort((x, y) => (y.ts24 || 0) - (x.ts24 || 0) || (y.h24 || 0) - (x.h24 || 0));
  return rows;
}

export async function rebuild({ deep = false } = {}) {
  const store = await _store("hoodsnipr-cache");
  const known = (await store.get("universe", { type: "json" }).catch(() => null)) || { t: {}, page: 1 };

  // rotate the GT volume page so we reach beyond the first 20 pools over time
  const page = deep ? ((known.page || 1) % 10) + 1 : 1;
  const { tokens, slug, errors } = await fetchUniverse(store, { gtPage: page });
  for (const a of Object.keys(tokens)) known.t[a] = tokens[a];

  // refresh the tokens already on the board so figures stay current
  const stale = Object.keys(known.t)
    .sort((a, b) => (known.t[b].h24 || 0) - (known.t[a].h24 || 0))
    .slice(0, 360);
  const fresh = await refreshKnown(store, stale, slug, { calls: 12 }).catch(() => ({}));
  for (const a of Object.keys(fresh)) known.t[a] = fresh[a];

  // forget tokens we haven't seen in any feed for 24h — they aren't trending
  const cutoff = Date.now() - 24 * 3600e3;
  for (const a of Object.keys(known.t)) if ((known.t[a].t || 0) < cutoff) delete known.t[a];

  known.page = page;
  await store.setJSON("universe", known).catch(() => {});

  const rows = buildBoard(known.t);
  let vol24 = 0, liq = 0;
  for (const r of rows) { vol24 += r.h24 || 0; liq += r.liq || 0; }

  const payload = {
    ts: Date.now(), v: 6, rows: rows.slice(0, 2000),
    stats: {
      tokensTradeable: rows.length,
      universeTokens: Object.keys(known.t).length,
      vol24, liq,
      feedPage: page,
      errors: errors.slice(0, 3)
    }
  };
  await store.setJSON("board2", payload).catch(() => {});
  return payload;
}
