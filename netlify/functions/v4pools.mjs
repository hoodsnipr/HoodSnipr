// UNISWAP V4 POOL DISCOVERY
//
// v4 has no per-pool contract — every pool lives inside a singleton PoolManager
// and is identified by a PoolKey (currency0, currency1, fee, tickSpacing, hooks).
// You cannot route a v4 swap without that key, and no screener API exposes it.
//
// The PoolManager emits Initialize(id, currency0, currency1, fee, tickSpacing,
// hooks, sqrtPriceX96, tick) for every pool ever created, so scanning that one
// topic gives us the keys AND reveals the PoolManager address itself (it's the
// log emitter) without having to hardcode a deployment we can't verify.
import { store as _store } from "./_store.mjs";
import { rpc, getLogs, addrFromTopic, words } from "./_rpc.mjs";

// v4 changed the Initialize signature during development, and a chain may run
// any of them. Matching only one means the scanner finds NOTHING and reports
// "no v4 pool" for pools that exist — so we match all known variants.
const INIT_TOPICS = [
  "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438", // ...,uint160,int24
  "0x3fd553db44f207b1f41348cfc4d251860814af9eadc470e8e7895e4d120511f4", // no price/tick
  "0x9e5fdb1dbcd8227784f3a3765e991e72fd8e71bfc967286dcf973ff804adc183"  // ...,uint160
];
const INIT_TOPIC = INIT_TOPICS;
const CHUNK_START = 50000;   // node caps results at 10k logs — stay well under

const json = (c, b) => new Response(JSON.stringify(b), {
  status: c, headers: { "content-type": "application/json", "cache-control": "public, max-age=30" }
});

function decodeInit(lg) {
  // indexed: id, currency0, currency1 | data: fee, tickSpacing, hooks, sqrtPriceX96, tick
  const c0 = addrFromTopic(lg.topics[2]);
  const c1 = addrFromTopic(lg.topics[3]);
  const w = words(lg.data);
  if (w.length < 3) return null;   // fee, tickSpacing, hooks are in every variant
  const fee = Number(BigInt("0x" + w[0]));
  // tickSpacing is int24 — handle the two's-complement case
  let ts = BigInt("0x" + w[1]);
  if (ts >= (1n << 255n)) ts -= (1n << 256n);
  const hooks = "0x" + w[2].slice(24);
  return {
    manager: String(lg.address || "").toLowerCase(),
    id: lg.topics[1],
    c0, c1, fee, ts: Number(ts), hooks: hooks.toLowerCase(),
    blk: Number(BigInt(lg.blockNumber))
  };
}

export async function scanV4(budgetMs = 12000) {
  const t0 = Date.now();
  const store = await _store("hoodsnipr-cache");
  const st = (await store.get("v4pools", { type: "json" }).catch(() => null))
    || { keys: {}, manager: null, lo: null, done: false, chunk: CHUNK_START };
  const errors = [];

  let head;
  try { head = Number(BigInt(await rpc("eth_blockNumber", []))); }
  catch (e) { return { ok: false, error: "rpc: " + e.message }; }
  if (st.lo == null) st.lo = head;

  // prefer topics we've actually observed on this chain over my guesses
  const TOPICS = (st.topics && st.topics.length) ? st.topics : INIT_TOPICS;
  let found = 0, chunks = 0;
  while (Date.now() - t0 < budgetMs - 2500 && !st.done && st.lo > 0) {
    const size = Math.max(5000, st.chunk);
    const from = Math.max(0, st.lo - size), to = st.lo;
    try {
      const logs = await getLogs(from, to, [TOPICS]);
      for (const lg of logs) {
        const k = decodeInit(lg);
        if (!k) continue;
        if (!st.manager) st.manager = k.manager;
        // BUG THIS FIXES: we used to index only the "non-native" side, which
        // assumed every v4 pool pairs against native ETH. A TOKEN/WETH pool has
        // two non-zero currencies, so it got filed under WETH and a lookup by
        // the token found nothing — hence "no indexed v4 pool" for pools that
        // plainly exist. Index under BOTH sides instead.
        const ZERO = "0x0000000000000000000000000000000000000000";
        for (const side of [k.c0, k.c1]) {
          if (!side || side === ZERO) continue;
          const list = st.keys[side] || (st.keys[side] = []);
          if (!list.some(x => x.id === k.id)) { list.push(k); found++; }
        }
      }
      chunks++;
      if (st.chunk < CHUNK_START) st.chunk = Math.min(CHUNK_START, st.chunk * 2);
      st.lo = from;
      // only truly done when no ranges were skipped
      if (from === 0) st.done = !(st.gaps && st.gaps.length);
    } catch (e) {
      st.chunk = Math.max(2000, Math.floor(st.chunk / 4));
      if (errors.length < 3) errors.push("logs@" + from + ": " + e.message.slice(0, 50));
      if (st.chunk <= 2000) {
        // Give up on this window, but REMEMBER it. Previously we advanced the
        // cursor and could still reach block 0 and declare the backfill "done",
        // so permanently-missing pools looked like "this token has no v4 pool".
        st.gaps = (st.gaps || []);
        if (st.gaps.length < 200) st.gaps.push([from, to]);
        st.lo = from;
      }
    }
    await store.setJSON("v4pools", st).catch(() => {});
  }

  // second pass: revisit ranges we had to skip
  if (st.lo <= 0 && st.gaps && st.gaps.length && Date.now() - t0 < budgetMs - 2000) {
    const remaining = [];
    for (const [gf, gt] of st.gaps) {
      if (Date.now() - t0 > budgetMs - 1500) { remaining.push([gf, gt]); continue; }
      try {
        const logs = await getLogs(gf, gt, [INIT_TOPIC]);
        const ZERO = "0x0000000000000000000000000000000000000000";
        for (const lg of logs) {
          const k = decodeInit(lg);
          if (!k) continue;
          if (!st.manager) st.manager = k.manager;
          for (const side of [k.c0, k.c1]) {
            if (!side || side === ZERO) continue;
            const list = st.keys[side] || (st.keys[side] = []);
            if (!list.some(x => x.id === k.id)) { list.push(k); found++; }
          }
        }
      } catch (e) { remaining.push([gf, gt]); }
    }
    st.gaps = remaining;
    if (!remaining.length) st.done = true;
    await store.setJSON("v4pools", st).catch(() => {});
  }

  return {
    ok: true, manager: st.manager, tokens: Object.keys(st.keys).length,
    gaps: (st.gaps || []).length,
    foundThisRun: found, chunks, backfillDone: !!st.done, cursor: st.lo, errors
  };
}

// Scan only the newest blocks — used when a user asks for a token we haven't
// indexed yet. Runs independently of the historical backfill cursor.
export async function scanTip(budgetMs = 8000) {
  const t0 = Date.now();
  const store = await _store("hoodsnipr-cache");
  const st = (await store.get("v4pools", { type: "json" }).catch(() => null))
    || { keys: {}, manager: null, lo: null, done: false, chunk: CHUNK_START };
  let head;
  try { head = Number(BigInt(await rpc("eth_blockNumber", []))); }
  catch (e) { return { ok: false, error: e.message }; }

  const tipFrom = st.tip ?? Math.max(0, head - 300000);
  let from = tipFrom, found = 0;
  const ZERO = "0x0000000000000000000000000000000000000000";
  while (Date.now() - t0 < budgetMs - 1500 && from < head) {
    const to = Math.min(head, from + 50000);
    try {
      const logs = await getLogs(from + 1, to, [INIT_TOPIC]);
      for (const lg of logs) {
        const k = decodeInit(lg);
        if (!k) continue;
        if (!st.manager) st.manager = k.manager;
        for (const side of [k.c0, k.c1]) {
          if (!side || side === ZERO) continue;
          const list = st.keys[side] || (st.keys[side] = []);
          if (!list.some(x => x.id === k.id)) { list.push(k); found++; }
        }
      }
      from = to;
    } catch (e) { from = Math.min(head, from + 10000); }
  }
  st.tip = from;
  await store.setJSON("v4pools", st).catch(() => {});
  return { ok: true, manager: st.manager, foundThisRun: found, tip: st.tip, head, tokens: Object.keys(st.keys).length };
}

// ---------------------------------------------------------------------------
// POOL-ID PROBE — the reliable path.
//
// Guessing the Initialize topic hash has failed repeatedly, and if the hash is
// wrong the scan silently finds nothing. But the PoolId is the FIRST INDEXED
// argument of Initialize, so we can search by it directly with topics
// [null, poolId] — no topic0 filter, no signature assumption. Whatever event
// carries that id in topic1 is the pool's Initialize, and it also tells us the
// real topic0 and the PoolManager address for free.
//
// DexScreener reports a v4 "pairAddress" as the 32-byte PoolId, so the client
// already has the id it needs to ask about.
export async function probePoolId(poolId, budgetMs = 13000) {
  const t0 = Date.now();
  const store = await _store("hoodsnipr-cache");
  const st = (await store.get("v4pools", { type: "json" }).catch(() => null))
    || { keys: {}, manager: null, lo: null, done: false, chunk: CHUNK_START };

  const id = String(poolId || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(id)) return { ok: false, error: "poolId must be 32 bytes" };

  // already known?
  for (const tok of Object.keys(st.keys || {})) {
    const hit = (st.keys[tok] || []).find(k => String(k.id).toLowerCase() === id);
    if (hit) return { ok: true, key: hit, manager: st.manager, cached: true };
  }

  const cache = (await store.get("v4probe", { type: "json" }).catch(() => null)) || {};
  if (cache[id] && cache[id].key) return { ok: true, key: cache[id].key, manager: st.manager, cached: true };

  let head;
  try { head = Number(BigInt(await rpc("eth_blockNumber", []))); }
  catch (e) { return { ok: false, error: "rpc: " + e.message }; }

  // This RPC rejects wide ranges ("logs matched by query exceeds limit of
  // 10000"), so walk BACKWARDS from the tip in chunks. Trending tokens are new,
  // so their pool is usually found within the first few windows.
  let chunk = 100000;
  let hi = head;
  let scanned = 0, lastErr = null;
  while (Date.now() - t0 < budgetMs - 1500 && hi > 0) {
    const lo = Math.max(0, hi - chunk);
    try {
      const logs = await rpc("eth_getLogs", [{
        fromBlock: "0x" + lo.toString(16),
        toBlock: "0x" + hi.toString(16),
        topics: [null, id]
      }]);
      scanned += (hi - lo);
      for (const lg of (logs || [])) {
        if (!lg.topics || lg.topics.length < 4) continue;
        const k = decodeInit(lg);
        if (!k) continue;
        if (!st.manager) st.manager = k.manager;
        st.topics = st.topics || [];
        if (!st.topics.includes(lg.topics[0])) st.topics.push(lg.topics[0]);
        const ZERO = "0x0000000000000000000000000000000000000000";
        for (const side of [k.c0, k.c1]) {
          if (!side || side === ZERO) continue;
          const list = st.keys[side] || (st.keys[side] = []);
          if (!list.some(x => x.id === k.id)) list.push(k);
        }
        cache[id] = { key: k, t: Date.now() };
        await store.setJSON("v4pools", st).catch(() => {});
        await store.setJSON("v4probe", cache).catch(() => {});
        return { ok: true, key: k, topic0: lg.topics[0], manager: k.manager, scannedBlocks: scanned };
      }
      hi = lo;
      if (chunk < 400000) chunk = Math.min(400000, chunk * 2);   // widen while it works
    } catch (e) {
      lastErr = String(e.message || e).slice(0, 90);
      chunk = Math.max(2000, Math.floor(chunk / 4));
      if (chunk <= 2000) { hi = Math.max(0, hi - 2000); }
    }
  }
  return { ok: false, error: lastErr || "not found in " + scanned.toLocaleString() + " blocks scanned", scannedBlocks: scanned, head };
}

// ---------------------------------------------------------------------------
// DIAGNOSTIC — sample recent logs and report which topics actually appear, so
// we can identify the PoolManager and its real event signature instead of
// guessing hashes.
export async function diagTopics(blocks = 2000) {
  let head;
  try { head = Number(BigInt(await rpc("eth_blockNumber", []))); }
  catch (e) { return { ok: false, error: e.message }; }

  // The node caps results at 10,000 logs, so sample a SMALL window near the tip
  // and shrink further if it still complains.
  let win = Math.min(blocks, 2000);
  let logs = null, err = null;
  for (let attempt = 0; attempt < 5 && !logs; attempt++) {
    const from = Math.max(0, head - win);
    try {
      logs = await rpc("eth_getLogs", [{
        fromBlock: "0x" + from.toString(16), toBlock: "0x" + head.toString(16)
      }]);
    } catch (e) {
      err = String(e.message || e).slice(0, 100);
      win = Math.max(50, Math.floor(win / 4));
    }
  }
  if (!logs) return { ok: false, error: err, note: "even a small window failed" };

  const byTopic = {}, byAddr = {};
  for (const lg of logs) {
    const t = lg.topics?.[0];
    if (t) byTopic[t] = (byTopic[t] || 0) + 1;
    const a = String(lg.address || "").toLowerCase();
    if (lg.topics && lg.topics.length === 4) {
      byAddr[a] = byAddr[a] || { count: 0, topics: {} };
      byAddr[a].count++;
      byAddr[a].topics[t] = (byAddr[a].topics[t] || 0) + 1;
    }
  }
  return {
    ok: true, head, windowBlocks: win, logsSampled: logs.length,
    topTopics: Object.entries(byTopic).sort((a, b) => b[1] - a[1]).slice(0, 12),
    threeIndexedCandidates: Object.entries(byAddr).sort((a, b) => b[1].count - a[1].count).slice(0, 8)
      .map(([addr, v]) => ({ addr, logs: v.count, topics: Object.keys(v.topics).slice(0, 4) }))
  };
}

export default async (req) => {
  const url = new URL(req.url);
  const store = await _store("hoodsnipr-cache");

  if (url.searchParams.get("scan") === "1") {
    return json(200, await scanV4(15000));
  }

  // ?probe=<poolId> — find a pool by its id without knowing the event signature
  const probe = url.searchParams.get("probe");
  if (probe) return json(200, await probePoolId(probe));

  // ?diag=1 — what events does this chain actually emit?
  if (url.searchParams.get("diag") === "1") {
    return json(200, await diagTopics(Number(url.searchParams.get("blocks") || 40000)));
  }

  // ?tip=1 — scan the most recent blocks only. A pool created minutes ago sits
  // at the chain tip, so this finds it without waiting for the full backfill.
  if (url.searchParams.get("tip") === "1") {
    return json(200, await scanTip(8000));
  }

  const token = String(url.searchParams.get("token") || "").toLowerCase();
  const st = (await store.get("v4pools", { type: "json" }).catch(() => null)) || { keys: {}, manager: null };

  if (!token) {
    return json(200, {
      manager: st.manager, tokens: Object.keys(st.keys || {}).length,
      done: !!st.done, cursor: st.lo ?? null
    });
  }
  if (!/^0x[0-9a-f]{40}$/.test(token)) return json(400, { error: "bad token" });

  const keys = (st.keys || {})[token] || [];
  return json(200, {
    manager: st.manager, token, keys,
    scan: { done: !!st.done, cursor: st.lo ?? null, tokens: Object.keys(st.keys || {}).length }
  });
};
