// PONS LAUNCHPAD INTEGRATION
//
// pons is a main Robinhood Chain launchpad, and it integrates cleanly because
// it does NOT use a bonding curve or a custom router: every token launches
// straight into a Uniswap V3 pool against WETH at the 1% fee tier, using the
// same SwapRouter02 and QuoterV2 HoodSnipr already trades through. So pons
// tokens are snipeable on our existing v3 path with no new execution code.
//
// What we add here is discovery and context:
//   • index TokenLaunched from both factories -> token + pool, from birth
//   • read metadata straight off the token (it is self-describing onchain)
//   • surface graduation progress and the launch-protection window
//
// Verified against docs.ponsfamily.com: the TokenLaunched topic below equals
// keccak of the documented event signature.
import { rpc, rpcBatch, getLogs, addrFromTopic, words, decodeStr, decodeUint } from "./_rpc.mjs";
import { store as _store } from "./_store.mjs";

export const PONS = {
  activeFactory: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB",
  activeFrom: 8991118,
  legacyFactory: "0x0c37a24F5D23A486FA692d1500881d698B1F77a4",
  legacyFrom: 8600612,
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  poolFee: 10000,                       // 1% — every pons pool
  supply: "1000000000",
  gradThresholdEth: 4.2,
  app: "https://www.ponsfamily.com/launchpad"
};
// keccak("TokenLaunched(address,address,address,address,address,uint256,uint256,uint256,uint256,uint256)")
const TOKEN_LAUNCHED = "0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a";

const SEL = {
  name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567",
  logo: "0xfb7f21eb", description: "0x7284e416", liquidityPool: "0x665a11ca",
  socials: "0x53cd512a", graduationStatus: "0x98d652f1"
};
const padAddr = a => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");

// TokenLaunched: token, deployer, dexFactory indexed; the rest in data.
function decodeLaunch(lg) {
  if (!lg || !lg.topics || lg.topics.length < 4) return null;
  const w = words(lg.data);
  if (w.length < 6) return null;
  return {
    token: addrFromTopic(lg.topics[1]),
    deployer: addrFromTopic(lg.topics[2]),
    pairToken: "0x" + w[0].slice(24),
    pool: "0x" + w[1].slice(24),
    restrictionsEndBlock: Number(BigInt("0x" + w[4])),
    block: Number(BigInt(lg.blockNumber))
  };
}

// Walk both factories forward from their documented start blocks. The public
// RPC rejects wide ranges, so this is chunked and resumable.
export async function indexLaunches(budgetMs = 7000) {
  const t0 = Date.now();
  const store = await _store("hoodsnipr-cache");
  const st = (await store.get("pons", { type: "json" }).catch(() => null))
    || { tokens: {}, cursors: {}, chunk: 40000 };
  if (!st.chunk) st.chunk = 40000;

  let head;
  try { head = Number(BigInt(await rpc("eth_blockNumber", []))); }
  catch (e) { return { ok: false, error: "rpc: " + e.message }; }

  let found = 0;
  for (const [factory, startBlock] of [
    [PONS.activeFactory, PONS.activeFrom],
    [PONS.legacyFactory, PONS.legacyFrom]
  ]) {
    const key = factory.toLowerCase();
    let from = st.cursors[key] != null ? st.cursors[key] : startBlock;
    while (Date.now() - t0 < budgetMs - 1500 && from < head) {
      const to = Math.min(head, from + st.chunk);
      try {
        const logs = await getLogs(from, to, [TOKEN_LAUNCHED], factory) || [];
        for (const lg of logs) {
          const L = decodeLaunch(lg);
          if (!L || !L.token) continue;
          const k = L.token.toLowerCase();
          if (!st.tokens[k]) {
            st.tokens[k] = {
              token: k, pool: (L.pool || "").toLowerCase(), deployer: L.deployer,
              factory: key, block: L.block, restrictionsEndBlock: L.restrictionsEndBlock,
              seen: Date.now()
            };
            found++;
          }
        }
        from = to;
        st.cursors[key] = from;
      } catch (e) {
        st.chunk = Math.max(2000, Math.floor(st.chunk / 3));
        if (st.chunk <= 2000) { from = to; st.cursors[key] = from; }
      }
    }
  }
  await store.setJSON("pons", st).catch(() => {});
  return {
    ok: true, head, found,
    totalTokens: Object.keys(st.tokens).length,
    cursors: st.cursors, chunk: st.chunk,
    caughtUp: Object.values(st.cursors).every(c => head - c < 5000)
  };
}

// pons tokens describe themselves onchain, so metadata needs no off-chain source.
export async function hydrate(budgetMs = 6000, limit = 40) {
  const t0 = Date.now();
  const store = await _store("hoodsnipr-cache");
  const st = (await store.get("pons", { type: "json" }).catch(() => null)) || { tokens: {} };
  const need = Object.keys(st.tokens).filter(k => !st.tokens[k].sym).slice(0, limit);
  if (!need.length) return { ok: true, hydrated: 0, total: Object.keys(st.tokens).length };

  let done = 0;
  for (let i = 0; i < need.length && Date.now() - t0 < budgetMs - 1200; i += 10) {
    const slice = need.slice(i, i + 10);
    const calls = [];
    for (const a of slice) {
      calls.push({ method: "eth_call", params: [{ to: a, data: SEL.symbol }, "latest"] });
      calls.push({ method: "eth_call", params: [{ to: a, data: SEL.name }, "latest"] });
      calls.push({ method: "eth_call", params: [{ to: a, data: SEL.decimals }, "latest"] });
      calls.push({ method: "eth_call", params: [{ to: a, data: SEL.logo }, "latest"] });
      calls.push({ method: "eth_call", params: [{ to: a, data: SEL.liquidityPool }, "latest"] });
    }
    const res = await rpcBatch(calls).catch(() => []);
    slice.forEach((a, k) => {
      const base = k * 5;
      const t = st.tokens[a];
      if (!t) return;
      t.sym = decodeStr(res[base]) || "?";
      t.name = decodeStr(res[base + 1]) || "";
      t.dec = decodeUint(res[base + 2]) ?? 18;
      const logo = decodeStr(res[base + 3]);
      if (logo && /^https?:\/\//.test(logo)) t.logo = logo;
      const lp = res[base + 4];
      if (lp && lp !== "0x" && lp.length >= 66) t.pool = ("0x" + lp.slice(-40)).toLowerCase();
      done++;
    });
  }
  await store.setJSON("pons", st).catch(() => {});
  return { ok: true, hydrated: done, total: Object.keys(st.tokens).length };
}

// Graduation progress for a single token, straight from the factory.
export async function graduation(token) {
  const store = await _store("hoodsnipr-cache");
  const st = (await store.get("pons", { type: "json" }).catch(() => null)) || { tokens: {} };
  const rec = st.tokens[String(token).toLowerCase()];
  if (!rec) return null;
  const factory = rec.factory || PONS.activeFactory;
  try {
    const res = await rpc("eth_call", [{
      to: factory, data: SEL.graduationStatus + padAddr(token)
    }, "latest"]);
    if (!res || res === "0x") return null;
    const w = words(res);
    if (w.length < 3) return null;
    const paired = BigInt("0x" + w[0]), threshold = BigInt("0x" + w[1]);
    const graduated = BigInt("0x" + w[2]) === 1n;
    return {
      pairedEth: +(Number(paired) / 1e18).toFixed(4),
      thresholdEth: +(Number(threshold) / 1e18).toFixed(4),
      graduated,
      progress: threshold > 0n ? Math.min(1, Number(paired) / Number(threshold)) : 0
    };
  } catch (e) { return null; }
}

// Everything the board needs, keyed by token address.
export async function ponsMap() {
  const store = await _store("hoodsnipr-cache");
  const st = (await store.get("pons", { type: "json" }).catch(() => null)) || { tokens: {} };
  return st.tokens || {};
}
