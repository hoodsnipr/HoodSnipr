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

// keccak256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")
const INIT_TOPIC = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
const CHUNK_START = 200000;

const json = (c, b) => new Response(JSON.stringify(b), {
  status: c, headers: { "content-type": "application/json", "cache-control": "public, max-age=30" }
});

function decodeInit(lg) {
  // indexed: id, currency0, currency1 | data: fee, tickSpacing, hooks, sqrtPriceX96, tick
  const c0 = addrFromTopic(lg.topics[2]);
  const c1 = addrFromTopic(lg.topics[3]);
  const w = words(lg.data);
  if (w.length < 3) return null;
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

  let found = 0, chunks = 0;
  while (Date.now() - t0 < budgetMs - 2500 && !st.done && st.lo > 0) {
    const size = Math.max(5000, st.chunk);
    const from = Math.max(0, st.lo - size), to = st.lo;
    try {
      const logs = await getLogs(from, to, [INIT_TOPIC]);
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
      if (from === 0) st.done = true;
    } catch (e) {
      st.chunk = Math.max(2000, Math.floor(st.chunk / 4));
      if (errors.length < 3) errors.push("logs@" + from + ": " + e.message.slice(0, 50));
      if (st.chunk <= 2000) st.lo = from;
    }
    await store.setJSON("v4pools", st).catch(() => {});
  }

  return {
    ok: true, manager: st.manager, tokens: Object.keys(st.keys).length,
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

export default async (req) => {
  const url = new URL(req.url);
  const store = await _store("hoodsnipr-cache");

  if (url.searchParams.get("scan") === "1") {
    return json(200, await scanV4(15000));
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
