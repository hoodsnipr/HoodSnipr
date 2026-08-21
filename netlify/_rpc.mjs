// Minimal JSON-RPC layer for Robinhood Chain. This is the foundation of the
// chain-native indexer: the RPC has no third-party rate limit, so unlike the
// public indexer APIs we can enumerate the ENTIRE chain.
const RPC = "https://rpc.mainnet.chain.robinhood.com";

let id = 0;
export async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })
  });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + (j.error.message || "rpc error"));
  return j.result;
}

// batched call — one HTTP round trip for many reads
export async function rpcBatch(calls) {
  if (!calls.length) return [];
  const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params }));
  const r = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  const out = new Array(calls.length).fill(null);
  if (Array.isArray(j)) for (const item of j) if (!item.error) out[item.id] = item.result;
  return out;
}

export const hex = n => "0x" + BigInt(n).toString(16);
export const num = h => (h == null ? null : Number(BigInt(h)));
export const big = h => (h == null ? 0n : BigInt(h));

// ---- ABI bits (hand-rolled; no ethers needed server-side) ----
export const TOPIC = {
  // PoolCreated(address,address,uint24,int24,address) — Uniswap v3 factory
  POOL_CREATED: "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118",
  // PairCreated(address,address,address,uint256) — Uniswap v2 factory
  PAIR_CREATED: "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9",
  // Swap(address,address,int256,int256,uint160,uint128,int24) — v3 pool
  SWAP_V3: "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  // Swap(address,uint256,uint256,uint256,uint256,address) — v2 pair
  SWAP_V2: "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822"
};

export function addrFromTopic(t) { return "0x" + String(t).slice(26).toLowerCase(); }

// decode a packed hex data blob into 32-byte words
export function words(data) {
  const s = String(data || "0x").slice(2);
  const out = [];
  for (let i = 0; i < s.length; i += 64) out.push(s.slice(i, i + 64));
  return out;
}
export function toInt256(w) {
  let v = BigInt("0x" + w);
  if (v >= (1n << 255n)) v -= (1n << 256n);
  return v;
}
export function toUint(w) { return BigInt("0x" + w); }

// ---- ERC-20 metadata reads (symbol/name/decimals), tolerant of bytes32 ----
const SEL = { symbol: "0x95d89b41", name: "0x06fdde03", decimals: "0x313ce567" };
export function metaCalls(addr) {
  return [
    { method: "eth_call", params: [{ to: addr, data: SEL.symbol }, "latest"] },
    { method: "eth_call", params: [{ to: addr, data: SEL.name }, "latest"] },
    { method: "eth_call", params: [{ to: addr, data: SEL.decimals }, "latest"] }
  ];
}
export function decodeStr(res) {
  if (!res || res === "0x") return null;
  const s = res.slice(2);
  if (s.length === 64) {                       // bytes32 style
    const bytes = s.replace(/(00)+$/, "");
    try { return Buffer.from(bytes, "hex").toString("utf8").replace(/\u0000/g, "").trim() || null; }
    catch { return null; }
  }
  try {
    const len = Number(BigInt("0x" + s.slice(64, 128)));
    const body = s.slice(128, 128 + len * 2);
    return Buffer.from(body, "hex").toString("utf8").replace(/\u0000/g, "").trim() || null;
  } catch { return null; }
}
export function decodeUint(res) { try { return Number(BigInt(res)); } catch { return null; } }

export async function getLogs(fromBlock, toBlock, topics, address) {
  const p = { fromBlock: hex(fromBlock), toBlock: hex(toBlock), topics };
  if (address) p.address = address;
  return rpc("eth_getLogs", [p]);
}
