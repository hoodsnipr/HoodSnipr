// CHAIN INDEXER — built for the real scale of Robinhood Chain (~22,000+ pairs).
//
// Two things were making this stall, both fixed here:
//
//  1. BACKFILL SPEED. I was scanning 5,000 blocks per chunk. Across ~40M blocks
//     that's 8,000 chunks — over 30 HOURS. But PoolCreated logs are rare (a few
//     tens of thousands in all of history), so a 1,000,000-block query returns
//     only a few hundred logs. Chunks now start at 1M and adapt down only if the
//     RPC complains. Whole-chain backfill drops to minutes.
//
//  2. STORAGE SIZE. Keeping 288 volume buckets for 22k pools is ~52MB per write
//     — the blob write timed out, so nothing persisted. Volume is now 12 fine
//     (5-min) + 24 hourly buckets per pool = ~576KB. Same accuracy for
//     5M/1H/6H/24H, 90x smaller.
import { getStore } from "@netlify/blobs";
import { rpc, rpcBatch, getLogs, TOPIC, addrFromTopic, words, toInt256, metaCalls, decodeStr, decodeUint } from "./_rpc.mjs";
import { buildChainRows, poolLiquidity } from "./_chainboard.mjs";

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const FINE = 12, HOURS = 24;            // 12x5min = 1h, 24x1h = 24h
const fineIdx = () => Math.floor(Date.now() / 300000) % FINE;
const hourIdx = () => Math.floor(Date.now() / 3600000) % HOURS;

export async function runIndex({ budgetMs = 20000 } = {}) {
  const t0 = Date.now();
  const left = () => budgetMs - (Date.now() - t0);
  const errors = [];
  const store = getStore("hoodsnipr-cache");

  let blobsOk = true;
  try { await store.setJSON("ping", { t: Date.now() }); }
  catch (e) { blobsOk = false; errors.push("blobs: " + e.message); }

  let head = null;
  try { head = Number(BigInt(await rpc("eth_blockNumber", []))); }
  catch (e) { errors.push("eth_blockNumber: " + e.message); return { ok: false, blobsOk, errors }; }

  // ---------- A. enumerate every pool from factory logs ----------
  const idx = (await store.get("pools_idx", { type: "json" }).catch(() => null))
    || { pools: {}, lo: head, done: false, chunk: 1000000 };
  if (!idx.chunk) idx.chunk = 1000000;
  let chunksRun = 0, poolsFound = 0;
  let dirty = false;

  while (left() > 4000 && !idx.done && idx.lo > 0) {
    const size = Math.max(2000, idx.chunk);
    const from = Math.max(0, idx.lo - size), to = idx.lo;
    try {
      const logs = await getLogs(from, to, [[TOPIC.POOL_CREATED, TOPIC.PAIR_CREATED]]);
      for (const lg of logs) {
        const ta = addrFromTopic(lg.topics[1]), tb = addrFromTopic(lg.topics[2]);
        const w = words(lg.data);
        const isV3 = String(lg.topics[0]).toLowerCase() === TOPIC.POOL_CREATED;
        const poolWord = isV3 ? w[1] : w[0];
        if (!poolWord) continue;
        const pool = "0x" + poolWord.slice(24).toLowerCase();
        const other = ta === WETH ? tb : (tb === WETH ? ta : null);
        if (!other) continue;                       // WETH-paired only = snipeable
        if (!idx.pools[pool]) { idx.pools[pool] = other; poolsFound++; dirty = true; }
      }
      chunksRun++;
      if (idx.chunk < 1000000) idx.chunk = Math.min(1000000, idx.chunk * 2);   // recover
      idx.lo = from;
      if (from === 0) idx.done = true;
    } catch (e) {
      // too many logs / range too wide — back off and retry the same window
      idx.chunk = Math.max(2000, Math.floor(idx.chunk / 4));
      errors.push("poolLogs@" + from + " (chunk->" + idx.chunk + "): " + e.message.slice(0, 80));
      if (idx.chunk <= 2000) { idx.lo = from; }    // give up on this window, move on
    }
    if (dirty) { await store.setJSON("pools_idx", idx).catch(e => errors.push("save pools: " + e.message)); dirty = false; }
  }
  if (dirty) await store.setJSON("pools_idx", idx).catch(() => {});

  // ---------- B. swaps -> price + compact volume ----------
  const sw = (await store.get("swaps", { type: "json" }).catch(() => null))
    || { cursor: Math.max(0, head - 20000), v: {}, px: {}, fb: -1, hb: -1, chunk: 20000 };
  if (!sw.chunk) sw.chunk = 20000;
  if (!sw.v) sw.v = {};

  const fb = fineIdx(), hb = hourIdx();
  if (sw.fb !== fb) { for (const p in sw.v) sw.v[p].f[fb] = 0; sw.fb = fb; }
  if (sw.hb !== hb) { for (const p in sw.v) sw.v[p].h[hb] = 0; sw.hb = hb; }

  if (head - sw.cursor > 500000) sw.cursor = head - 200000;   // never fall hopelessly behind
  let swapSlices = 0, swapsSeen = 0;
  while (left() > 3000 && sw.cursor < head) {
    const to = Math.min(head, sw.cursor + sw.chunk);
    try {
      const logs = await getLogs(sw.cursor + 1, to, [[TOPIC.SWAP_V3, TOPIC.SWAP_V2]]);
      for (const lg of logs) {
        const pool = String(lg.address || "").toLowerCase();
        const tok = idx.pools[pool];
        if (!tok) continue;
        const w = words(lg.data);
        const wethIsT0 = WETH < tok;
        let amt = 0n;
        if (String(lg.topics[0]).toLowerCase() === TOPIC.SWAP_V3) {
          const a0 = toInt256(w[0]), a1 = toInt256(w[1]);
          const sq = BigInt("0x" + (w[2] || "0"));
          amt = wethIsT0 ? (a0 < 0n ? -a0 : a0) : (a1 < 0n ? -a1 : a1);
          if (sq > 0n) sw.px[pool] = { s: sq.toString(), t0: wethIsT0 ? 1 : 0 };
        } else {
          const i0 = BigInt("0x" + (w[0] || "0")), i1 = BigInt("0x" + (w[1] || "0"));
          const o0 = BigInt("0x" + (w[2] || "0")), o1 = BigInt("0x" + (w[3] || "0"));
          amt = wethIsT0 ? (i0 + o0) : (i1 + o1);
        }
        if (amt <= 0n) continue;
        const eth = Number(amt) / 1e18;
        if (!sw.v[pool]) sw.v[pool] = { f: new Array(FINE).fill(0), h: new Array(HOURS).fill(0) };
        sw.v[pool].f[fb] += eth;
        sw.v[pool].h[hb] += eth;
        swapsSeen++;
      }
      swapSlices++;
      sw.cursor = to;
      if (sw.chunk < 20000) sw.chunk = Math.min(20000, sw.chunk * 2);
    } catch (e) {
      sw.chunk = Math.max(500, Math.floor(sw.chunk / 4));
      errors.push("swapLogs@" + sw.cursor + " (chunk->" + sw.chunk + "): " + e.message.slice(0, 80));
      if (sw.chunk <= 500) sw.cursor = to;
    }
  }
  // prune inactive pools so the blob stays small
  const vKeys = Object.keys(sw.v);
  if (vKeys.length > 2500) {
    const scored = vKeys.map(p => [p, sw.v[p].h.reduce((a, b) => a + b, 0)]).sort((a, b) => b[1] - a[1]);
    const keep = {};
    for (const [p] of scored.slice(0, 2000)) keep[p] = sw.v[p];
    sw.v = keep;
  }
  await store.setJSON("swaps", sw).catch(e => errors.push("save swaps: " + e.message));

  // ---------- C. metadata for tokens we can show ----------
  const tm = (await store.get("tokmeta", { type: "json" }).catch(() => null)) || {};
  if (left() > 2000) {
    // prioritise tokens that actually traded
    const active = Object.keys(sw.v).map(p => idx.pools[p]).filter(Boolean);
    const need = [];
    for (const t of active) if (t && !tm[t] && !need.includes(t)) { need.push(t); if (need.length >= 60) break; }
    if (need.length < 60) {
      for (const p in idx.pools) {
        const t = idx.pools[p];
        if (t && !tm[t] && !need.includes(t)) { need.push(t); if (need.length >= 60) break; }
      }
    }
    for (let i = 0; i < need.length && left() > 1500; i += 30) {
      const slice = need.slice(i, i + 30);
      try {
        const calls = [];
        for (const a of slice) calls.push(...metaCalls(a));
        const res = await rpcBatch(calls);
        slice.forEach((a, k) => {
          tm[a] = { s: decodeStr(res[k * 3]) || "?", n: decodeStr(res[k * 3 + 1]) || "", d: decodeUint(res[k * 3 + 2]) ?? 18 };
        });
      } catch (e) { errors.push("meta: " + e.message.slice(0, 60)); }
    }
    await store.setJSON("tokmeta", tm).catch(e => errors.push("save tokmeta: " + e.message));
  }

  // ---------- D. board ----------
  const ethUsd = (await store.get("ethusd", { type: "json" }).catch(() => null))?.v || 3400;
  let liqMap = {};
  if (left() > 1500) {
    const active = Object.keys(sw.v).slice(0, 400);
    liqMap = await poolLiquidity(active, ethUsd).catch(() => ({}));
  }
  const overlay = (await store.get("overlay", { type: "json" }).catch(() => null)) || {};
  const rows = buildChainRows({ poolsIdx: idx, swaps: sw, tokmeta: tm, ethUsd, liqMap, overlay });

  let vol24 = 0, liq = 0;
  for (const r of rows) { vol24 += r.h24 || 0; liq += r.liq || 0; }
  const payload = {
    ts: Date.now(), v: 5, rows: rows.slice(0, 2500),
    stats: {
      tokensTradeable: rows.length,
      poolsIndexed: Object.keys(idx.pools).length,
      poolsActive: Object.keys(sw.v).length,
      tokensCreated: Object.keys(tm).length,
      backfillDone: !!idx.done, backfillCursor: idx.lo, backfillChunk: idx.chunk,
      swapCursor: sw.cursor, head, vol24, liq, ethUsd
    }
  };
  await store.setJSON("board2", payload).catch(e => errors.push("save board: " + e.message));

  return {
    ok: true, blobsOk, head,
    chunksRun, poolsFound, swapSlices, swapsSeen,
    poolsIndexed: Object.keys(idx.pools).length,
    poolsActive: Object.keys(sw.v).length,
    tokensWithMeta: Object.keys(tm).length,
    boardRows: rows.length,
    backfillDone: !!idx.done, backfillCursor: idx.lo, backfillChunk: idx.chunk,
    msUsed: Date.now() - t0, errors
  };
}
