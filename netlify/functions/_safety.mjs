// TOKEN TRUST SCORING
//
// The FOMO exploit works like this: a token's contract force-sends tokens to a
// wallet and pulls them back immediately after a buy. Every cycle emits Transfer
// events and looks like trading activity, so a volume-ranked board promotes it.
// The screener can't tell a "blackhole function" from a real swap.
//
// The defence can't be "distrust new tokens" — a genuine launch is also new,
// low-holder, and suddenly volatile. That's the whole point of a sniper. So we
// score CONTRACT BEHAVIOUR and TRADE AUTHENTICITY, never age:
//
//   1. Transfer/Swap ratio   — forced transfers emit Transfers with no matching
//                              Swap. Real trading keeps these roughly in step.
//   2. Round-trip ratio      — the same address buying then selling within
//                              seconds, repeatedly, is wash trading by definition.
//   3. Trader concentration  — a real run has many distinct buyers; fake volume
//                              is a handful of addresses cycling.
//   4. Counterparty spread   — how much of the volume comes from the top address.
//
// A brand-new token with real buyers scores well immediately. A token with
// $500k of "volume" across four addresses does not.
import { rpc, getLogs, addrFromTopic, words, toInt256 } from "./_rpc.mjs";
import { store as _store } from "./_store.mjs";

const V4_SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V2_SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const GOPLUS = "https://api.gopluslabs.io/api/v1/token_security";

// GoPlus almost certainly doesn't index chain 4663 yet — try it, and treat a
// miss as "no data", never as a pass or a fail.
export async function goPlusCheck(chainId, token) {
  try {
    const r = await fetch(`${GOPLUS}/${chainId}?contract_addresses=${token}`,
      { headers: { accept: "application/json" } });
    if (!r.ok) return { available: false };
    const j = await r.json();
    const d = j && j.result && j.result[String(token).toLowerCase()];
    if (!d) return { available: false };
    return {
      available: true,
      honeypot: d.is_honeypot === "1",
      cannotSell: d.cannot_sell_all === "1",
      blacklist: d.is_blacklisted === "1",
      mintable: d.is_mintable === "1",
      proxy: d.is_proxy === "1",
      buyTax: +d.buy_tax || 0,
      sellTax: +d.sell_tax || 0,
      holderCount: +d.holder_count || null
    };
  } catch (e) { return { available: false }; }
}

// Pull recent activity for one token/pool pair and derive the signals.
export async function analyseActivity(token, pool, { blocks = 120000, budgetMs = 7000 } = {}) {
  const t0 = Date.now();
  let head;
  try { head = Number(BigInt(await rpc("eth_blockNumber", []))); }
  catch (e) { return { ok: false, error: "rpc" }; }

  const from = Math.max(0, head - blocks);
  const swaps = [], transfers = [];

  // --- swaps on this pool ---
  let win = 20000, cur = head;
  while (Date.now() - t0 < budgetMs * 0.45 && cur > from) {
    const lo = Math.max(from, cur - win);
    try {
      const logs = await getLogs(lo, cur, [[V4_SWAP_TOPIC, V3_SWAP_TOPIC, V2_SWAP_TOPIC]], pool) || [];
      for (const lg of logs) swaps.push(lg);
    } catch (e) { win = Math.max(2000, Math.floor(win / 3)); }
    cur = lo;
    if (swaps.length > 400) break;
  }

  // --- transfers of this token ---
  win = 20000; cur = head;
  while (Date.now() - t0 < budgetMs * 0.9 && cur > from) {
    const lo = Math.max(from, cur - win);
    try {
      const logs = await getLogs(lo, cur, [TRANSFER_TOPIC], token) || [];
      for (const lg of logs) transfers.push(lg);
    } catch (e) { win = Math.max(2000, Math.floor(win / 3)); }
    cur = lo;
    if (transfers.length > 1500) break;
  }

  // --- signals ---
  const traders = {};              // address -> {buys, sells}
  const perTx = {};
  for (const lg of swaps) {
    const sender = lg.topics && lg.topics.length >= 3 ? addrFromTopic(lg.topics[2]) : null;
    if (!sender) continue;
    const t = traders[sender] || (traders[sender] = { n: 0, tx: new Set() });
    t.n++; t.tx.add(lg.transactionHash);
    perTx[lg.transactionHash] = (perTx[lg.transactionHash] || 0) + 1;
  }
  const uniqueTraders = Object.keys(traders).length;
  const swapCount = swaps.length;
  const transferCount = transfers.length;

  // Transfers that belong to a swap share that swap's transaction hash. Anything
  // far in excess of that is movement the market never asked for.
  const swapTxs = new Set(swaps.map(s => s.transactionHash));
  let transfersInSwapTx = 0, forcedTransfers = 0;
  for (const tr of transfers) {
    if (swapTxs.has(tr.transactionHash)) transfersInSwapTx++;
    else forcedTransfers++;
  }

  // Round trips: an address that both sent and received the token repeatedly
  // outside of swap transactions is the signature of the force-send exploit.
  const moved = {};
  for (const tr of transfers) {
    if (!tr.topics || tr.topics.length < 3) continue;
    const f = addrFromTopic(tr.topics[1]), t2 = addrFromTopic(tr.topics[2]);
    if (f) (moved[f] || (moved[f] = { in: 0, out: 0 })).out++;
    if (t2) (moved[t2] || (moved[t2] = { in: 0, out: 0 })).in++;
  }
  const cyclers = Object.keys(moved).filter(a => moved[a].in >= 2 && moved[a].out >= 2).length;
  const movers = Object.keys(moved).length || 1;

  // Concentration: share of swaps from the busiest address.
  let topShare = 0;
  if (swapCount > 0) {
    const counts = Object.values(traders).map(t => t.n).sort((a, b) => b - a);
    topShare = counts.length ? counts[0] / swapCount : 0;
  }

  return {
    ok: true, head, blocksScanned: head - from,
    swapCount, transferCount, uniqueTraders,
    transfersInSwapTx, forcedTransfers,
    transferSwapRatio: swapCount > 0 ? +(transferCount / swapCount).toFixed(2) : null,
    forcedRatio: transferCount > 0 ? +(forcedTransfers / transferCount).toFixed(3) : null,
    cyclerRatio: +(cyclers / movers).toFixed(3),
    topTraderShare: +topShare.toFixed(3)
  };
}

// Turn signals into a score. Deductions only — a token starts trusted and loses
// points for OBSERVED manipulation, so being new is never itself a penalty.
export function scoreToken({ activity, goplus, liq, vol24, holders }) {
  const flags = [];
  let score = 100;
  let confidence = "high";

  if (!activity || !activity.ok || activity.swapCount < 5) {
    confidence = "low";                    // not enough history to judge
  } else {
    const a = activity;

    // 1. forced transfers — the FOMO exploit's fingerprint
    if (a.forcedRatio != null && a.forcedRatio > 0.85 && a.transferCount > 30) {
      score -= 40; flags.push({ id: "forced-transfers", sev: "high",
        msg: "most token movements happen outside real swaps — possible forced transfers" });
    } else if (a.forcedRatio != null && a.forcedRatio > 0.65 && a.transferCount > 30) {
      score -= 18; flags.push({ id: "transfer-noise", sev: "med",
        msg: "unusually high transfer activity relative to trades" });
    }

    // 2. addresses cycling tokens in and out repeatedly
    if (a.cyclerRatio > 0.4 && a.transferCount > 20) {
      score -= 25; flags.push({ id: "round-tripping", sev: "high",
        msg: "the same wallets receive and return tokens repeatedly — wash-trade pattern" });
    }

    // 3. volume concentrated in very few hands
    if (a.uniqueTraders <= 3 && a.swapCount >= 15) {
      score -= 30; flags.push({ id: "few-traders", sev: "high",
        msg: `only ${a.uniqueTraders} distinct trader(s) behind ${a.swapCount} swaps` });
    } else if (a.uniqueTraders <= 8 && a.swapCount >= 30) {
      score -= 15; flags.push({ id: "thin-participation", sev: "med",
        msg: `${a.uniqueTraders} distinct traders across ${a.swapCount} swaps` });
    }

    // 4. one address dominating
    if (a.topTraderShare > 0.8 && a.swapCount >= 10) {
      score -= 20; flags.push({ id: "single-actor", sev: "high",
        msg: `${Math.round(a.topTraderShare * 100)}% of swaps come from one address` });
    }
  }

  // 5. external security data, when the chain is actually covered
  if (goplus && goplus.available) {
    if (goplus.honeypot)   { score -= 60; flags.push({ id:"honeypot", sev:"high", msg:"flagged as a honeypot" }); }
    if (goplus.cannotSell) { score -= 50; flags.push({ id:"cannot-sell", sev:"high", msg:"holders may be unable to sell" }); }
    if (goplus.blacklist)  { score -= 25; flags.push({ id:"blacklist", sev:"med",  msg:"contract can blacklist addresses" }); }
    if (goplus.mintable)   { score -= 15; flags.push({ id:"mintable", sev:"med",   msg:"supply can still be minted" }); }
    if (goplus.sellTax > 15) { score -= 20; flags.push({ id:"sell-tax", sev:"med", msg:`${goplus.sellTax}% sell tax` }); }
  }

  // 6. economic sanity — heavy volume on almost no liquidity isn't real trading
  if (liq > 0 && vol24 > 0 && vol24 / liq > 200) {
    score -= 20; flags.push({ id:"vol-liq-mismatch", sev:"med",
      msg:"24h volume is enormous relative to pool depth" });
  }
  if (holders != null && holders < 25 && vol24 > 100000) {
    score -= 20; flags.push({ id:"volume-without-holders", sev:"high",
      msg:`$${Math.round(vol24/1000)}k volume across only ${holders} holders` });
  }

  score = Math.max(0, Math.min(100, score));
  const label = confidence === "low" ? "UNPROVEN"
    : score >= 80 ? "CLEAN"
    : score >= 55 ? "WATCH"
    : score >= 30 ? "RISKY" : "DANGER";

  return { score, label, confidence, flags };
}
