// REAL chain stats for Robinhood Chain, not indexer guesswork.
// Blockscout /stats gives chain-wide totals (txns today, blocks, avg block time).
// DEX volume/liquidity stay indexer-derived but are computed once, server-side,
// so every client shows the SAME number instead of each aggregating its own.
import { store as _store, storeMode } from "./_store.mjs";

const BS = "https://robinhoodchain.blockscout.com/api/v2";
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const TTL_MS = 8000;   // token census should feel live

const json = (c, b) => new Response(JSON.stringify(b), {
  status: c, headers: { "content-type": "application/json", "cache-control": "public, max-age=8" }
});

async function blockscoutStats() {
  try {
    const r = await fetch(`${BS}/stats`, { headers: { accept: "application/json" } });
    if (!r.ok) throw 0;
    const s = await r.json();
    const num = v => { const n = parseInt(String(v ?? "").replace(/[^0-9]/g, ""), 10); return isNaN(n) ? null : n; };
    return {
      txns24: num(s.transactions_today),
      totalTxns: num(s.total_transactions),
      totalBlocks: num(s.total_blocks),
      addresses: num(s.total_addresses),
      avgBlockTime: s.average_block_time ?? null,
      gas: s.gas_prices?.average?.price ?? s.gas_prices?.average ?? null
    };
  } catch (e) { return {}; }
}

async function blockNumber() {
  try {
    const r = await fetch(RPC, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] })
    });
    return parseInt((await r.json()).result, 16) || null;
  } catch (e) { return null; }
}

export default async () => {
  const store = await _store("hoodsnipr-cache");
  const cached = await store.get("chainstats", { type: "json" }).catch(() => null);
  if (cached && Date.now() - cached.ts < TTL_MS) return json(200, cached);
  const [bs, blk, mkt] = await Promise.all([
    blockscoutStats(),
    blockNumber(),
    store.get("market", { type: "json" }).catch(() => null)
  ]);
  const dex = (mkt && mkt.stats) || {};
  const out = {
    ts: Date.now(),
    block: blk ?? bs.totalBlocks ?? null,
    txns24: bs.txns24 ?? dex.txns24 ?? null,
    totalTxns: bs.totalTxns ?? null,
    addresses: bs.addresses ?? null,
    avgBlockTime: bs.avgBlockTime ?? null,
    vol24: dex.vol24 ?? null,
    liq: dex.liq ?? null,
    tokenCount: dex.tokenCount ?? null,
    tokensCreated: dex.tokensCreated ?? null,
    tokensNewHour: dex.tokensNewHour ?? null,
    tokensNewDay: dex.tokensNewDay ?? null
  };
  if (out.block || out.txns24 || out.vol24) await store.setJSON("chainstats", out).catch(() => {});
  return json(200, out);
};
