// BOARD BUILDER — screener-aligned.
//
// Goal: open HoodSnipr, pick a timeframe, and see the same tokens a user would
// see on a screener for that timeframe. So we rank strictly by that timeframe's
// volume, keep exactly one contract per ticker, and drop anything that looks
// like an impersonator or a security token.
import { store as _store } from "./_store.mjs";
import { fetchUniverse, refreshKnown, dsSlug, finalizeTokens } from "./_feeds.mjs";
import { ponsMap } from "./_pons.mjs";
import { isDenied, normSym } from "./_denylist.mjs";
import { getBans } from "./banlist.mjs";
import { vol30Map } from "./_vol30.mjs";
import { hasCcStamp } from "./_letscash.mjs";

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
// A paid boost or a completed profile costs money and takes effort. Neither
// proves a token is good, but both are things wash-trade bots almost never do,
// so they earn a modest lift — never enough to outrank genuine volume.
function promoFactor(t) {
  let f = 1;
  if (t.boosts > 0) f *= Math.min(1.35, 1 + Math.log10(1 + t.boosts) * 0.25);
  if (t.hasProfile) f *= 1.05;
  return f;
}
// Trade COUNT matters as well as size: many small trades from many wallets is a
// healthier signal than one enormous print.
function txFactor(t, tf) {
  const x = t.txns && t.txns[tf];
  if (!x) return 1;
  const total = (x.b || 0) + (x.s || 0);
  if (total <= 0) return 0.85;
  return Math.min(1.3, 0.85 + Math.log10(1 + total) * 0.18);
}
export function trendScore(t, tf) {
  const vol = +t[tf] || 0;
  if (vol <= 0) return 0;
  // sqrt keeps a whale trade from dominating outright
  return Math.sqrt(vol) * accelFactor(t, tf) * buyFactor(t, tf)
       * depthFactor(t.liq) * txFactor(t, tf) * promoFactor(t);
}

// ---------------------------------------------------------------------------
// HOLDER COUNTS (Blockscout) — used to catch wash-traded scams.
//
// A token doing six figures of 24h volume across fewer than 100 holders is
// almost always wash trading: the same few wallets cycling volume to climb the
// board. Real distribution lags real volume, never the reverse.
const BS_API = "https://robinhoodchain.blockscout.com/api/v2";

export async function fetchHolders(store, addrs, { calls = 40, deadline = 0 } = {}) {
  const cache = (await store.get("holders", { type: "json" }).catch(() => null)) || { d: {}, cursor: 0 };
  const now = Date.now();
  const stale = addrs.filter(a => {
    const rec = cache.d[a];
    return !rec || (now - rec.t) > 30 * 60e3;     // refresh every 30 min
  });
  let done = 0;
  for (const a of stale) {
    if (done >= calls) break;
    if (deadline && Date.now() > deadline) break;
    try {
      const r = await fetch(`${BS_API}/tokens/${a}`, { headers: { accept: "application/json" } });
      if (r.ok) {
        const j = await r.json();
        const raw = j.holders_count != null ? j.holders_count : j.holders;
        const n = parseInt(String(raw).replace(/[^0-9]/g, ""), 10);
        cache.d[a] = { h: isNaN(n) ? null : n, t: now };
      } else {
        cache.d[a] = { h: null, t: now };
      }
    } catch (e) { cache.d[a] = { h: null, t: now }; }
    done++;
  }
  // keep the blob bounded
  const keys = Object.keys(cache.d);
  if (keys.length > 4000) {
    const trimmed = {};
    for (const k of keys.slice(-3000)) trimmed[k] = cache.d[k];
    cache.d = trimmed;
  }
  await store.setJSON("holders", cache).catch(() => {});
  return cache.d;
}

// Wash-trading signature: heavy volume, almost no holders.
export const MIN_HOLDERS = 100;
export const HIGH_VOL_USD = 50000;
export function washSuspect(row) {
  const h = row.h;
  if (h == null) return false;                 // unknown holders — don't punish
  if (h >= MIN_HOLDERS) return false;
  const vol = Math.max(row.h24 || 0, row.h6 || 0);
  if (vol < HIGH_VOL_USD) return false;        // low volume + few holders = just new
  return true;
}

// CREDIBILITY GATE
//
// The tokens slipping through were showing large volume on our board while not
// trending anywhere else — which means the volume itself is manufactured. A
// badge after the fact is too late; these need to not appear at all.
//
// Each rule below describes something that cannot be true of an honest market,
// and each is checked against data we already hold, so the gate costs nothing.
// CREDIBILITY GATE — v2
//
// v1 hid real tokens like $CASHCAT. The reason: volume is aggregated across
// every pool a token trades in, while `liq` is whatever one pool the feed
// reported. Any ratio built on those two numbers is therefore unreliable, and
// ratio rules fired hardest on the deepest, most-traded tokens — the opposite
// of the intent.
//
// The rebuild inverts the logic. Instead of hunting for reasons to hide, we
// first look for evidence a token is REAL. Real markets leave traces that are
// expensive or impossible to fake in volume: a broad holder base, a long tail
// of transactions, sustained age, a paid profile. If any solid evidence of
// legitimacy exists, automated rules never hide the token — only the manual
// denylist can. Hiding is reserved for tokens with a manipulation signature AND
// no supporting evidence at all.
export function legitimacy(t, holders) {
  const h = (holders && holders[t.a] && holders[t.a].h != null) ? holders[t.a].h : null;
  const tx = t.txns && t.txns.h24 ? t.txns.h24 : null;
  const tx24 = tx ? ((tx.b || 0) + (tx.s || 0)) : null;
  const ageH = t.cr ? (Date.now() - t.cr) / 3600e3 : null;
  const ev = [];

  // Evidence must be EXPENSIVE to fake. Transaction count deliberately isn't
  // here: cycling bots manufacture transactions cheaply, and counting them as
  // legitimacy let a wash-trading token exempt itself from the very rule
  // designed to catch it.
  if (h != null && h >= 100) ev.push("holders:" + h);
  if ((+t.liq || 0) >= 50000) ev.push("liquidity");
  if ((+t.mc || 0) >= 250000) ev.push("marketcap");
  if (ageH != null && ageH >= 24 && (+t.h24 || 0) > 1000) ev.push("age");
  if (t.boosts > 0) ev.push("boosted");
  if (t.hasProfile || t.tw || t.site) ev.push("profile");
  if (t.pons) ev.push("pons-launch");
  // many traders AND a real holder base together are hard to fake at once
  if (h != null && h >= 40 && tx24 != null && tx24 >= 100) ev.push("distribution");
  return ev;
}

export function credibility(t, holders) {
  const liq = +t.liq || 0;
  const vol = +t.h24 || 0;
  const h = (holders && holders[t.a] && holders[t.a].h != null) ? holders[t.a].h : null;
  const tx = t.txns && t.txns.h24 ? t.txns.h24 : null;
  const tx24 = tx ? ((tx.b || 0) + (tx.s || 0)) : null;

  const evidence = legitimacy(t, holders);
  const severe = [];

  // Signals that describe trade STRUCTURE rather than data ratios. These don't
  // depend on liquidity being reported correctly, which is what broke v1.

  // Entirely one-sided flow over a meaningful sample: nobody is selling, or
  // nobody is buying, yet volume accrues.
  if (tx24 != null && tx24 >= 50 && tx && (tx.b === 0 || tx.s === 0))
    severe.push("every trade in the same direction");

  // Buys and sells matched to within 1% over a large sample is a cycle, not a
  // market. Real order flow is never that symmetrical.
  if (tx24 != null && tx24 >= 100 && tx && vol > 50000 &&
      Math.abs((tx.b || 0) - (tx.s || 0)) / tx24 < 0.01)
    severe.push("buys and sells matched to within 1% — cycling pattern");

  // Big money, essentially no holders. Distribution cannot lag volume this far.
  if (h != null && h < 10 && vol > 100000)
    severe.push(`$${Math.round(vol/1000)}k volume across only ${h} holders`);

  // Big money, a handful of trades — a few enormous prints, not a market.
  if (tx24 != null && tx24 < 10 && vol > 100000)
    severe.push(`only ${tx24} trades behind $${Math.round(vol/1000)}k of volume`);

  // Dust pool with no trading at all and no legitimacy evidence.
  const dead = liq > 0 && liq < 500 && vol < 100 && !t.pons;

  // THE RULE: evidence of legitimacy overrides every automated signal.
  const hide = evidence.length === 0 && (severe.length >= 1 || dead);

  return {
    severe, evidence, hide,
    reasons: severe,
    warn: severe.length && !hide ? severe[0] : null
  };
}

export const hiddenLog = [];
export function buildBoard(tokens, holders, blocked, bans) {
  hiddenLog.length = 0;
  const byTicker = {};
  for (const addr of Object.keys(tokens)) {
    const t = tokens[addr];
    if (!t || addr === WETH) continue;
    if (excluded(t.s, t.n)) continue;
    if (looksFake(t)) continue;

    // manual override — human judgement beats any heuristic
    if (isDenied(addr, t.s)) continue;
    // owner-signed bans: absolute, no evidence test, no exemption
    if (bans && bans[addr]) continue;

    // Cached DANGER verdicts from the deeper on-chain analysis — but only when
    // the token has no independent evidence of being real.
    if (blocked && blocked[addr] && legitimacy(t, holders).length === 0) continue;

    // credibility gate: two independent impossibilities means it isn't a market
    const cred = credibility(t, holders);
    if (cred.hide) { hiddenLog.push({ s: t.s, a: addr, why: cred.reasons[0] || "no market" }); continue; }
    t._credWarn = cred.warn;
    // A pons launch is legitimate from block one, even before any volume
    // exists. Requiring volume would hide exactly the launches a sniper wants.
    const hasMarket = (t.h24 > 0 || t.h6 > 0 || t.h1 > 0 || t.m5 > 0) && (t.liq || 0) >= 200;
    if (!hasMarket && !t.pons) continue;

    const k = normSym(t.s) || normTicker(t.s);
    if (!k) continue;
    const cur = byTicker[k];
    if (!cur) { byTicker[k] = t; continue; }
    // Highest 24h volume is the one a screener surfaces for that ticker.
    const better = (t.h24 || 0) > (cur.h24 || 0) ||
      ((t.h24 || 0) === (cur.h24 || 0) && (t.liq || 0) > (cur.liq || 0));
    if (better) byTicker[k] = t;
  }

  const H = holders || {};
  const rows = Object.values(byTicker).map(t => ({
    h: (H[t.a] && H[t.a].h != null) ? H[t.a].h : null,
    ts5: trendScore(t, "m5"), ts1: trendScore(t, "h1"),
    ts6: trendScore(t, "h6"), ts24: trendScore(t, "h24"),
    txns: t.txns || null, pools: t.poolCount || 1,
    // letscash stamps every token address with a trailing "cc". On its own
    // that's weak evidence, so the client confirms against the pool's hook
    // before showing the badge.
    cc: hasCcStamp(t.a),
    pons: !!t.pons, ponsBlock: t.ponsBlock || null,
    restrictionsEndBlock: t.restrictionsEndBlock || null,
    a: t.a, p: t.pool, s: String(t.s || "").replace(/^\$+/, ""), n: t.n,
    img: t.img || null, px: t.px, mc: t.mc, liq: t.liq,
    m5: t.m5 || 0, h1: t.h1 || 0, h6: t.h6 || 0, h24: t.h24 || 0,
    cm5: t.cm5 || 0, c1: t.c1 || 0, c6: t.c6 || 0, c24: t.c24 || 0,
    site: t.site || null, tw: t.tw || null, tg: t.tg || null,
    boosts: t.boosts || 0, hasProfile: !!t.hasProfile,
    credWarn: t._credWarn || null,
    cr: t.cr || null, ver: t.ver || "v3", dex: t.dex || "", src: t.src || ""
  }));
  for (const r of rows) r.wash = washSuspect(r);
  rows.sort((x, y) => (y.ts24 || 0) - (x.ts24 || 0) || (y.h24 || 0) - (x.h24 || 0));
  return rows;
}

export async function rebuild({ deep = false, budgetMs = 12000 } = {}) {
  const _t0 = Date.now();
  const timeLeft = () => budgetMs - (Date.now() - _t0);
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
  // scale the refresh to whatever time remains
  const refreshCalls = timeLeft() > 6000 ? 12 : (timeLeft() > 3000 ? 6 : 2);
  const fresh = await refreshKnown(store, stale, slug, { calls: refreshCalls }).catch(() => ({}));
  for (const a of Object.keys(fresh)) known.t[a] = fresh[a];

  // forget tokens we haven't seen in any feed for 24h — they aren't trending
  const cutoff = Date.now() - 24 * 3600e3;
  for (const a of Object.keys(known.t)) if ((known.t[a].t || 0) < cutoff) delete known.t[a];

  known.page = page;
  await store.setJSON("universe", known).catch(() => {});

  // Roll every pool up into token-level liquidity and volume BEFORE anything
  // reads those numbers — filtering, scoring and holder priority all depend on
  // them being consistent with each other.
  finalizeTokens(known.t);

  // Prioritise holder lookups for the high-volume tokens — those are the ones
  // where the wash-trading test actually matters.
  const hot = Object.keys(known.t)
    .sort((a, b) => (known.t[b].h24 || 0) - (known.t[a].h24 || 0))
    .slice(0, 150);
  const holders = await fetchHolders(store, hot, {
    calls: deep ? 60 : 30, deadline: Date.now() + Math.min(5000, timeLeft() - 1500)
  }).catch(() => ({}));

  // pons launches are indexed straight from its factory events, so a token
  // appears the moment it is created — before any screener has picked it up.
  // That's the whole point of a sniper.
  let ponsTagged = 0;
  try {
    const pm = await ponsMap();
    for (const addr of Object.keys(pm)) {
      const p = pm[addr];
      if (!p.sym || p.sym === "?") continue;
      const ex = known.t[addr];
      if (ex) {
        ex.pons = true; ex.ponsPool = p.pool; ex.ponsBlock = p.block;
        ex.restrictionsEndBlock = p.restrictionsEndBlock;
        if (!ex.img && p.logo) ex.img = p.logo;
        ponsTagged++;
      } else {
        // brand-new launch no feed knows about yet
        known.t[addr] = {
          a: addr, pool: p.pool, s: p.sym, n: p.name || "",
          img: p.logo || null, px: null, liq: 0, mc: null,
          m5: 0, h1: 0, h6: 0, h24: 0, cm5: 0, c1: 0, c6: 0, c24: 0,
          cr: null, ver: "v3", src: "pons", pons: true, ponsPool: p.pool,
          ponsBlock: p.block, restrictionsEndBlock: p.restrictionsEndBlock,
          t: Date.now()
        };
        ponsTagged++;
      }
    }
  } catch (e) {}

  // DANGER verdicts from the on-chain safety analysis, cached from earlier runs
  let out30 = null;
  let blocked = {};
  try {
    const sf = await store.get("safety", { type: "json" });
    if (sf) for (const k of Object.keys(sf)) {
      const v = sf[k] && sf[k].v;
      if (v && v.label === "DANGER") blocked[k] = true;
    }
  } catch (e) {}

  const bans = await getBans().catch(() => ({}));
  const rows = buildBoard(known.t, holders, blocked, bans);

  // attach server-side 30D volume so the client never has to fetch per pool
  try {
    const v30 = await vol30Map();
    let have = 0;
    for (const r of rows) {
      const v = v30[String(r.p || "").toLowerCase()];
      if (v != null) { r.d30 = v; have++; }
    }
    out30 = { attached: have, total: rows.length };
  } catch (e) {}
  // CHAIN TOTALS
  //
  // The headline liquidity figure was reading in the trillions, which no chain
  // this size can support. A single token with a corrupt reserve figure — GT
  // occasionally reports reserve_in_usd against a broken price — is enough to
  // dominate a naive sum. So outliers are excluded from the aggregate and
  // reported instead of silently distorting the number.
  const MAX_TOKEN_LIQ = 5e7;      // $50M in one token's pools
  const MAX_TOKEN_VOL = 5e8;      // $500M in 24h for one token
  let vol24 = 0, liq = 0;
  const dropped = [];
  for (const r of rows) {
    const l = +r.liq || 0, v = +r.h24 || 0;
    if (l > MAX_TOKEN_LIQ || v > MAX_TOKEN_VOL) {
      dropped.push({ s: r.s, a: r.a, liq: Math.round(l), vol: Math.round(v) });
      continue;
    }
    if (Number.isFinite(l)) liq += l;
    if (Number.isFinite(v)) vol24 += v;
  }
  // the biggest honest contributors, so the total can be sanity-checked
  const topLiq = rows.slice()
    .filter(r => (+r.liq || 0) <= MAX_TOKEN_LIQ)
    .sort((a, b) => (b.liq || 0) - (a.liq || 0)).slice(0, 5)
    .map(r => ({ s: r.s, liq: Math.round(r.liq || 0) }));

  const payload = {
    ts: Date.now(), v: 6, rows: rows.slice(0, 2000),
    stats: {
      tokensTradeable: rows.length,
      universeTokens: Object.keys(known.t).length,
      vol24, liq,
      liqOutliers: dropped.slice(0, 10),
      liqOutlierCount: dropped.length,
      topLiquidity: topLiq,
      washFiltered: rows.filter(r => r.wash).length,
      blockedByScore: Object.keys(blocked).length,
      bannedTokens: Object.keys(bans || {}).length,
      vol30Coverage: out30,
      hiddenSample: hiddenLog.slice(0, 25),
      hiddenCount: hiddenLog.length,
      ponsTokens: ponsTagged,
      feedPage: page,
      errors: errors.slice(0, 3)
    }
  };
  await store.setJSON("board2", payload).catch(() => {});
  return payload;
}
