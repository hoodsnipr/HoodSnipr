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

// Confirmed on Robinhood Chain (4663) from live logs, not assumed:
//   PoolManager 0x8366a39cc670b4001a1121b8f6a443a643e40951
//   Swap topic  keccak("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")
//               -> canonical Uniswap v4
const KNOWN_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const V4_SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";

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

// Same derivation the client uses, exposed for diagnostics:
//   /v4pools?derive=<poolId>&token=<addr>
import { keccak256, AbiCoder } from "ethers";
const FEES=[100,500,3000,10000,20000,25000,2500,0x800000];
const SPACINGS=[1,10,60,200,2,4,20,50,100,500];
const ZERO="0x0000000000000000000000000000000000000000";
const WETHA="0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
function poolIdOf(c0,c1,fee,ts,hooks){
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["address","address","uint24","int24","address"],[c0,c1,fee,ts,hooks]));
}
export function deriveKey(token, targetId){
  const t=String(token||"").toLowerCase(), id=String(targetId||"").toLowerCase();
  if(!/^0x[0-9a-f]{40}$/.test(t) || !/^0x[0-9a-f]{64}$/.test(id)) return null;
  const sort=(a,b)=> a.toLowerCase()<b.toLowerCase()? [a,b]:[b,a];
  for(const [base,wrap] of [[ZERO,false],[WETHA,true]]){
    const [c0,c1]=sort(base,t);
    for(const fee of FEES) for(const ts of SPACINGS){
      if(poolIdOf(c0,c1,fee,ts,ZERO).toLowerCase()===id)
        return { key:{c0:c0.toLowerCase(),c1:c1.toLowerCase(),fee,ts,hooks:ZERO,id}, wrap };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// TIME-TARGETED PROBE — the reliable way to get a PoolKey WITH hooks.
//
// Local derivation can only recover pools whose hooks are the zero address. But
// memecoin launchpads on v4 deploy pools WITH hook contracts (that's the point
// of v4), and a 160-bit hook address can't be brute-forced. The Initialize log
// carries the hooks address — we just have to find it without scanning 40M
// blocks on an RPC that caps queries.
//
// DexScreener tells us WHEN the pair was created, so we can convert a timestamp
// into an approximate block and search a narrow window around it. That turns an
// unbounded history scan into two or three cheap queries.
async function estimateBlockAt(tsSec) {
  const headHex = await rpc("eth_blockNumber", []);
  const head = Number(BigInt(headHex));
  const hb = await rpc("eth_getBlockByNumber", [headHex, false]);
  const headTs = Number(BigInt(hb.timestamp));
  // sample an older block to measure the real block time
  const back = Math.min(head, 500000);
  const ob = await rpc("eth_getBlockByNumber", ["0x" + (head - back).toString(16), false]);
  const oldTs = Number(BigInt(ob.timestamp));
  const secsPerBlock = Math.max(0.02, (headTs - oldTs) / back);
  const delta = Math.max(0, headTs - tsSec);
  const est = Math.max(0, Math.round(head - delta / secsPerBlock));
  return { head, est, secsPerBlock, headTs };
}

export async function probeByTime(poolId, createdAtMs, budgetMs = 13000) {
  const t0 = Date.now();
  const store = await _store("hoodsnipr-cache");
  const st = (await store.get("v4pools", { type: "json" }).catch(() => null))
    || { keys: {}, manager: null, lo: null, done: false, chunk: CHUNK_START };
  const id = String(poolId || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(id)) return { ok: false, error: "poolId must be 32 bytes" };

  const cache = (await store.get("v4probe", { type: "json" }).catch(() => null)) || {};
  if (cache[id] && cache[id].key) return { ok: true, key: cache[id].key, cached: true, manager: st.manager };

  let est;
  try { est = await estimateBlockAt(Math.floor(Number(createdAtMs) / 1000)); }
  catch (e) { return { ok: false, error: "block estimate failed: " + String(e.message).slice(0, 70) }; }

  // widen outward from the estimate — creation is usually within a few thousand
  // blocks of it, but block-time drift means we can't assume precision
  const spans = [5000, 25000, 100000, 400000, 1500000];
  let scanned = 0, lastErr = null;
  for (const span of spans) {
    if (Date.now() - t0 > budgetMs - 1500) break;
    const from = Math.max(0, est.est - span), to = Math.min(est.head, est.est + span);
    try {
      const logs = await rpc("eth_getLogs", [{
        fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [null, id]
      }]);
      scanned = to - from;
      for (const lg of (logs || [])) {
        if (!lg.topics || lg.topics.length < 4) continue;
        const k = decodeInit(lg);
        if (!k) continue;
        if (!st.manager) st.manager = k.manager;
        st.topics = st.topics || [];
        if (!st.topics.includes(lg.topics[0])) st.topics.push(lg.topics[0]);
        // remember hook contracts so local derivation can try them next time
        const ZERO = "0x0000000000000000000000000000000000000000";
        if (k.hooks && k.hooks !== ZERO) {
          st.hooks = st.hooks || [];
          if (!st.hooks.includes(k.hooks)) st.hooks.push(k.hooks);
        }
        for (const side of [k.c0, k.c1]) {
          if (!side || side === ZERO) continue;
          const list = st.keys[side] || (st.keys[side] = []);
          if (!list.some(x => x.id === k.id)) list.push(k);
        }
        cache[id] = { key: k, t: Date.now() };
        await store.setJSON("v4pools", st).catch(() => {});
        await store.setJSON("v4probe", cache).catch(() => {});
        return { ok: true, key: k, topic0: lg.topics[0], manager: k.manager, blocksScanned: scanned, estBlock: est.est };
      }
    } catch (e) { lastErr = String(e.message || e).slice(0, 80); }
  }
  return { ok: false, error: lastErr || "not found near estimated block " + est.est, estBlock: est.est, secsPerBlock: est.secsPerBlock };
}

// ---------------------------------------------------------------------------
// ROUTER DISCOVERY.
//
// "execution reverted (no data present)" on a pool that clearly has liquidity
// means the call never reached a working router. The UniversalRouter address I
// hardcoded is Ethereum mainnet's — chain 4663 almost certainly deploys it
// elsewhere, and calling execute() on an unrelated contract reverts exactly
// like this.
//
// We can find the real one empirically: v4's Swap event indexes `sender`, which
// is whatever contract called PoolManager.swap(). Scan recent swaps and the most
// frequent sender IS the router traders are actually using.
export async function discoverRouter(budgetMs = 12000) {
  const t0 = Date.now();
  const store = await _store("hoodsnipr-cache");
  const st = (await store.get("v4pools", { type: "json" }).catch(() => null)) || {};

  const cached = await store.get("v4router", { type: "json" }).catch(() => null);
  if (cached && cached.router && Date.now() - cached.t < 6 * 3600e3) return { ok: true, ...cached, cached: true };

  const manager = st.manager || KNOWN_MANAGER;

  let head;
  try { head = Number(BigInt(await rpc("eth_blockNumber", []))); }
  catch (e) { return { ok: false, error: "rpc: " + e.message }; }

  const senders = {};
  let win = 3000, from = head;
  while (Date.now() - t0 < budgetMs - 2000 && Object.keys(senders).length < 40 && from > head - 400000) {
    const lo = Math.max(0, from - win);
    try {
      const logs = await rpc("eth_getLogs", [{
        fromBlock: "0x" + lo.toString(16), toBlock: "0x" + from.toString(16), address: manager
      }]);
      for (const lg of (logs || [])) {
        // v4 Swap(PoolId indexed id, address indexed sender, ...)
        if (!lg.topics || lg.topics.length < 3) continue;
        const sender = addrFromTopic(lg.topics[2]);
        if (!sender || /^0x0+$/.test(sender)) continue;
        senders[sender] = (senders[sender] || 0) + 1;
      }
      from = lo;
    } catch (e) {
      win = Math.max(200, Math.floor(win / 3));
      if (win <= 200) from = Math.max(0, from - 200);
    }
  }

  const ranked = Object.entries(senders).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { ok: false, error: "no v4 swaps seen recently", manager };

  // keep only addresses that are contracts (an EOA would be a direct caller)
  const out = [];
  for (const [addr, count] of ranked.slice(0, 6)) {
    try {
      const code = await rpc("eth_getCode", [addr, "latest"]);
      if (code && code !== "0x") out.push({ addr, swaps: count, codeSize: (code.length - 2) / 2 });
    } catch (e) {}
  }
  if (!out.length) return { ok: false, error: "no contract senders found", manager, ranked: ranked.slice(0, 5) };

  const rec = { router: out[0].addr, candidates: out, manager, t: Date.now() };
  await store.setJSON("v4router", rec).catch(() => {});
  return { ok: true, ...rec };
}

// ---------------------------------------------------------------------------
// BOOTSTRAP — find the PoolManager AND the router in ONE query.
//
// Router discovery needed the PoolManager, which was only learned from a log
// lookup — but local key derivation skips the chain entirely, so the manager
// was never learned and discovery silently fell back to the mainnet address.
// That's why swaps kept reverting against 0x8876…0904.
//
// The fix: v4's Swap event has topics [sig, poolId, sender]. We already know
// real v4 pool ids from the board, so a single getLogs filtered on
// topics[1] ∈ knownPoolIds returns swaps whose EMITTER is the PoolManager and
// whose topics[2] is the router. One query, both answers, no prior state.
// Two candidates came back with IDENTICAL code size and near-tied swap counts,
// so ranking by popularity is a coin flip — and picking wrong means every swap
// reverts with no data. Instead we ASK each candidate whether it implements
// execute(bytes,bytes[],uint256):
//
//   • call it with an already-expired deadline
//   • a real UniversalRouter reverts with TransactionDeadlinePassed() — revert
//     data is PRESENT, proving the function exists and ran
//   • a contract without that function reverts empty (or returns nothing)
//
// That's a definitive capability test rather than a guess.
const EXECUTE_SELECTOR = "0x3593564c";
async function rawCall(to, data) {
  const r = await fetch("https://rpc.mainnet.chain.robinhood.com", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to, data }, "latest"] })
  });
  return r.json();
}
export async function probeRouter(addr) {
  // execute("0x", [], 1) — empty commands, empty inputs, deadline in 1970
  const enc = EXECUTE_SELECTOR
    + "0000000000000000000000000000000000000000000000000000000000000060"  // offset commands
    + "0000000000000000000000000000000000000000000000000000000000000080"  // offset inputs
    + "0000000000000000000000000000000000000000000000000000000000000001"  // deadline = 1
    + "0000000000000000000000000000000000000000000000000000000000000000"  // commands length 0
    + "0000000000000000000000000000000000000000000000000000000000000000"; // inputs length 0
  try {
    const j = await rawCall(addr, enc);
    if (j.error) {
      const d = j.error.data;
      const hasData = typeof d === "string" && d.length > 2;
      const msg = String(j.error.message || "");
      return {
        addr, implementsExecute: hasData || /deadline|expired|Transaction/i.test(msg),
        revertData: hasData ? String(d).slice(0, 12) : null, message: msg.slice(0, 70)
      };
    }
    // returned successfully — the function exists and accepted an empty batch
    return { addr, implementsExecute: true, returned: true };
  } catch (e) {
    return { addr, implementsExecute: false, error: String(e.message).slice(0, 60) };
  }
}

export async function bootstrapV4(poolIds, budgetMs = 9000) {
  const t0 = Date.now();
  const store = await _store("hoodsnipr-cache");

  const cached = await store.get("v4boot", { type: "json" }).catch(() => null);
  if (cached && cached.router && Date.now() - cached.t < 6 * 3600e3) {
    return { ok: true, ...cached, cached: true };
  }

  let ids = (poolIds || []).map(x => String(x).toLowerCase()).filter(x => /^0x[0-9a-f]{64}$/.test(x));
  if (!ids.length) {
    // pull ids straight from the board if the caller didn't supply any
    const board = await store.get("board2", { type: "json" }).catch(() => null);
    ids = ((board && board.rows) || [])
      .filter(r => /^0x[0-9a-f]{64}$/i.test(String(r.p || "")))
      .slice(0, 20).map(r => String(r.p).toLowerCase());
  }
  if (!ids.length) return { ok: false, error: "no v4 pool ids available to bootstrap from" };

  let head;
  try { head = Number(BigInt(await rpc("eth_blockNumber", []))); }
  catch (e) { return { ok: false, error: "rpc: " + e.message }; }

  const senders = {};
  let manager = null, topic0 = null;
  let win = 20000, from = head, tries = 0;
  while (Date.now() - t0 < budgetMs - 1500 && from > head - 600000 && tries < 12) {
    tries++;
    const lo = Math.max(0, from - win);
    try {
      const logs = await rpc("eth_getLogs", [{
        fromBlock: "0x" + lo.toString(16), toBlock: "0x" + from.toString(16),
        topics: [null, ids]                 // any event about any known v4 pool
      }]);
      for (const lg of (logs || [])) {
        if (!lg.topics || lg.topics.length < 2) continue;
        manager = manager || String(lg.address || "").toLowerCase();
        if (lg.topics.length >= 3) {
          const sender = addrFromTopic(lg.topics[2]);
          if (sender && !/^0x0+$/.test(sender)) {
            senders[sender] = (senders[sender] || 0) + 1;
            topic0 = topic0 || lg.topics[0];
          }
        }
      }
      if (manager && Object.keys(senders).length) break;
      from = lo;
      win = Math.min(100000, win * 2);
    } catch (e) {
      win = Math.max(500, Math.floor(win / 3));
      if (win <= 500) from = Math.max(0, from - 500);
    }
  }

  if (!manager) return { ok: false, error: "no logs found for known v4 pool ids", idsTried: ids.length };

  const ranked = Object.entries(senders).sort((a, b) => b[1] - a[1]);
  const candidates = [];
  for (const [addr, count] of ranked.slice(0, 5)) {
    try {
      const code = await rpc("eth_getCode", [addr, "latest"]);
      if (code && code !== "0x") candidates.push({ addr, swaps: count, codeSize: (code.length - 2) / 2 });
    } catch (e) {}
  }

  // Capability test beats popularity: probe each candidate for execute().
  let chosen = null;
  for (const c of candidates) {
    const pr = await probeRouter(c.addr).catch(() => null);
    if (pr) { c.implementsExecute = !!pr.implementsExecute; c.revertData = pr.revertData || null; }
    if (pr && pr.implementsExecute && !chosen) chosen = c.addr;
  }
  // fall back to the busiest only if none respond to execute()
  const rec = {
    manager, router: chosen || candidates[0]?.addr || null,
    routerVerified: !!chosen, candidates,
    swapTopic: topic0, t: Date.now()
  };
  await store.setJSON("v4boot", rec).catch(() => {});
  // fold into the main state so other paths benefit
  const st = (await store.get("v4pools", { type: "json" }).catch(() => null)) || { keys: {} };
  st.manager = st.manager || manager;
  await store.setJSON("v4pools", st).catch(() => {});
  await store.setJSON("v4router", { router: rec.router, manager, t: Date.now() }).catch(() => {});
  return { ok: !!rec.router, ...rec };
}

export default async (req) => {
  const url = new URL(req.url);
  const store = await _store("hoodsnipr-cache");

  if (url.searchParams.get("scan") === "1") {
    return json(200, await scanV4(15000));
  }

  // ?derive=<poolId>&token=<addr> — rebuild the PoolKey with no chain queries
  const der = url.searchParams.get("derive");
  if (der) {
    const tok = url.searchParams.get("token") || "";
    const r = deriveKey(tok, der);
    return json(200, r ? { ok: true, ...r } : { ok: false, error: "no standard fee/spacing combination matches this id (custom hooks?)" });
  }

  // ?attime=<poolId>&ts=<createdAtMs> — narrow, timestamp-targeted lookup
  const attime = url.searchParams.get("attime");
  if (attime) {
    const ts = Number(url.searchParams.get("ts") || 0);
    if (!ts) return json(400, { ok: false, error: "ts (ms) required" });
    return json(200, await probeByTime(attime, ts));
  }

  // ?testrouter=<addr> — does this contract implement execute()?
  const tr = url.searchParams.get("testrouter");
  if (tr) return json(200, await probeRouter(tr));

  // ?boot=1 — one-shot: PoolManager + router
  if (url.searchParams.get("boot") === "1") {
    const idsParam = (url.searchParams.get("ids") || "").split(",").filter(Boolean);
    return json(200, await bootstrapV4(idsParam));
  }

  // ?router=1 — discover the router that actually executes v4 swaps here
  if (url.searchParams.get("router") === "1") {
    return json(200, await discoverRouter());
  }

  // ?hooks=1 — hook contracts we've seen, so the client can include them
  // as derivation candidates
  if (url.searchParams.get("hooks") === "1") {
    const st = (await store.get("v4pools", { type: "json" }).catch(() => null)) || {};
    let rt = await store.get("v4router", { type: "json" }).catch(() => null);
    if (!rt || !rt.router) {
      const b = await bootstrapV4([]).catch(() => null);
      if (b && b.router) rt = { router: b.router, manager: b.manager };
    }
    return json(200, {
      hooks: st.hooks || [], manager: (rt && rt.manager) || st.manager || null,
      router: (rt && rt.router) || null
    });
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
