// PLATFORM STATS — derived from the chain, not self-reported.
//
// Every snipe and every loose pays a 0.25% fee to one frozen address, so that
// address IS the ledger. Counting its incoming transfers gives the number of
// trades; summing them gives fees collected; dividing by the fee rate gives the
// volume those fees were charged on. Anyone can check the figures against the
// explorer, which is the point — a launchpad stat nobody can verify is just
// marketing.
import { store as _store } from "./_store.mjs";

const BS = "https://robinhoodchain.blockscout.com/api/v2";
const FEE_WALLET = "0xb67cBE7fD1258108fE214bA0138d89FC0772791d";
const FEE_BPS = 25;                      // 0.25%
const TTL = 5 * 60e3;

const json = (c, b) => new Response(JSON.stringify(b), {
  status: c, headers: { "content-type": "application/json", "cache-control": "public, max-age=120" }
});

async function ethUsd() {
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot");
    if (r.ok) { const j = await r.json(); return +j?.data?.amount || null; }
  } catch (e) {}
  return null;
}

export default async (req) => {
  try {
    const store = await _store("hoodsnipr-cache");
    const url = new URL(req.url);
    const cached = await store.get("pstats", { type: "json" }).catch(() => null);
    if (cached && Date.now() - cached.t < TTL && url.searchParams.get("fresh") !== "1") {
      return json(200, { ...cached.v, cached: true });
    }

    let snipes = 0, feeWei = 0n, pages = 0, more = false;
    let next = `${BS}/addresses/${FEE_WALLET}/transactions?filter=to`;
    const t0 = Date.now();

    // Walk the fee wallet's incoming transactions. Bounded so the function
    // always answers; the running totals are cached between calls.
    while (next && pages < 8 && Date.now() - t0 < 6000) {
      const r = await fetch(next, { headers: { accept: "application/json" } });
      if (!r.ok) break;
      const j = await r.json();
      for (const tx of (j.items || [])) {
        if (String(tx.to?.hash || "").toLowerCase() !== FEE_WALLET.toLowerCase()) continue;
        const v = BigInt(tx.value || "0");
        if (v <= 0n) continue;
        snipes++; feeWei += v;
      }
      pages++;
      const np = j.next_page_params;
      if (np) {
        const qs = new URLSearchParams({ filter: "to", ...np }).toString();
        next = `${BS}/addresses/${FEE_WALLET}/transactions?${qs}`;
        more = true;
      } else { next = null; more = false; }
    }

    const feesEth = Number(feeWei) / 1e18;
    const volumeEth = feesEth * (10000 / FEE_BPS);      // fees are 0.25% of volume
    const px = await ethUsd();

    const payload = {
      snipes, feesEth: +feesEth.toFixed(6), volumeEth: +volumeEth.toFixed(4),
      feesUsd: px ? +(feesEth * px).toFixed(2) : null,
      volumeUsd: px ? +(volumeEth * px).toFixed(2) : null,
      ethUsd: px, feeWallet: FEE_WALLET, feeBps: FEE_BPS,
      partial: more,                                     // more pages remain
      explorer: `https://robinhoodchain.blockscout.com/address/${FEE_WALLET}`,
      ts: Date.now()
    };
    await store.setJSON("pstats", { t: Date.now(), v: payload }).catch(() => {});
    return json(200, payload);
  } catch (e) {
    return json(500, { error: String(e && e.message || e).slice(0, 160) });
  }
};
