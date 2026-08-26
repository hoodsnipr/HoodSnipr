// SIGNATURE-GATED TOKEN BAN
//
// Only wallets in OWNERS can ban. Authorisation is a wallet signature over a
// message that names the exact action, the exact token, and a timestamp — so a
// captured signature can't be replayed later or reused for a different token.
// The URL is unguessable but the URL is NOT the security: the signature is.
import { store as _store } from "./_store.mjs";
import { verifyMessage, getAddress } from "ethers";

const OWNERS = new Set([
  "0xae06e1ae756e7e9c2c1ffe6af236e4f3e6c19d67"
]);

const MAX_AGE_MS = 5 * 60e3;          // a signature is good for five minutes
const json = (c, b) => new Response(JSON.stringify(b), {
  status: c, headers: { "content-type": "application/json", "cache-control": "no-store" }
});

export function banMessage(action, token, ts) {
  return [
    "HoodSnipr admin action",
    "action: " + action,
    "token: " + String(token).toLowerCase(),
    "timestamp: " + ts
  ].join("\n");
}

export async function getBans() {
  const store = await _store("hoodsnipr-cache");
  return (await store.get("bans", { type: "json" }).catch(() => null)) || {};
}

// Build a board row for a whitelisted token from whatever the chain and the
// screeners can tell us. A whitelisted token with no market data still gets a
// row — the whole point of the override is that our filters were wrong.
const DS = "https://api.dexscreener.com";
const RPC = "https://rpc.mainnet.chain.robinhood.com";

async function callSel(to, data) {
  try {
    const r = await fetch(RPC, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] })
    });
    const j = await r.json();
    return j.result && j.result !== "0x" ? j.result : null;
  } catch (e) { return null; }
}
// Two encodings are in the wild for symbol()/name(): the ABI string form
// (offset + length + data) and the older fixed bytes32 form. The decoder only
// handled the first, so a bytes32 token returned null — and because a null
// symbol aborted the whole resolve, whitelisting such a token silently produced
// no row at all.
function decodeStrHex(hex) {
  if (!hex || hex === "0x") return null;
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const hexToStr = (bytes) => {
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const c = parseInt(bytes.substr(i, 2), 16);
      if (c > 0 && c < 0xff) out += String.fromCharCode(c);
    }
    return out.replace(/[^\x20-\x7E]/g, "").trim() || null;
  };
  try {
    // ABI string: 32-byte offset, 32-byte length, then the data
    if (h.length >= 128) {
      const len = parseInt(h.slice(64, 128), 16);
      if (len > 0 && len <= 256 && h.length >= 128 + len * 2) {
        const v = hexToStr(h.slice(128, 128 + len * 2));
        if (v) return v;
      }
    }
    // fixed bytes32
    if (h.length === 64) return hexToStr(h);
    // anything else: salvage the printable characters
    return hexToStr(h);
  } catch (e) { return null; }
}

export async function resolveWhitelistRow(token, symHint) {
  let sym = symHint || null, name = null, img = null;
  let px = null, liq = 0, mc = null, pool = null;
  let m5 = 0, h1 = 0, h6 = 0, h24 = 0, cr = null, ver = "v3";

  // identity from the contract
  const [sRaw, nRaw, lRaw] = await Promise.all([
    callSel(token, "0x95d89b41"),   // symbol()
    callSel(token, "0x06fdde03"),   // name()
    callSel(token, "0xfb7f21eb")    // logo()
  ]);
  const symOnchain = decodeStrHex(sRaw);
  sym = symOnchain || sym;
  let symSrc = symOnchain ? "contract" : (symHint ? "operator" : null);
  name = decodeStrHex(nRaw);
  const rawLogo = decodeStrHex(lRaw);
  if (rawLogo && /^ipfs:\/\//i.test(rawLogo)) img = "https://ipfs.io/ipfs/" + rawLogo.replace(/^ipfs:\/\//i, "");
  else if (rawLogo && /^https?:\/\//i.test(rawLogo)) img = rawLogo;

  // market data, if any screener knows the token
  try {
    const r = await fetch(`${DS}/tokens/v1/robinhood/${token}`, { headers: { accept: "application/json" } });
    if (r.ok) {
      const arr = await r.json();
      const pairs = Array.isArray(arr) ? arr : (arr.pairs || []);
      let best = null;
      for (const p of pairs) {
        const l = +(p.liquidity?.usd || 0);
        if (!best || l > best._l) { best = p; best._l = l; }
        liq += l;
        m5 += +(p.volume?.m5 || 0); h1 += +(p.volume?.h1 || 0);
        h6 += +(p.volume?.h6 || 0); h24 += +(p.volume?.h24 || 0);
      }
      if (best) {
        pool = best.pairAddress; px = +best.priceUsd || null;
        mc = +best.marketCap || +best.fdv || null;
        cr = best.pairCreatedAt || null;
        if (!img && best.info?.imageUrl) img = best.info.imageUrl;
        if (!sym && best.baseToken?.symbol) { sym = best.baseToken.symbol; symSrc = "dexscreener"; }
        if (!name && best.baseToken?.name) name = best.baseToken.name;
        const labels = [].concat(best.labels || []);
        ver = labels.find(l => /^v\d/i.test(l))?.toLowerCase() || "v3";
      }
    }
  } catch (e) {}

  // NEVER give up. If the contract answers nothing and no screener knows the
  // token, still produce a row — an override that silently does nothing is the
  // worst possible outcome, because there is no way to tell it apart from a
  // bug. A short address stands in for the symbol until real data arrives.
  if (!sym) sym = token.slice(2, 8).toUpperCase();
  return {
    a: token, p: pool, s: String(sym).replace(/^\$+/, ""), n: name || "",
    img: img || null, px, mc, liq,
    m5, h1, h6, h24, cm5: 0, c1: 0, c6: 0, c24: 0,
    ts5: Math.sqrt(m5 || 0), ts1: Math.sqrt(h1 || 0),
    ts6: Math.sqrt(h6 || 0), ts24: Math.sqrt(h24 || 0),
    h: null, cr, ver, dex: "", src: "whitelist",
    boosts: 0, hasProfile: !!img, txns: null, pools: pool ? 1 : 0,
    _symSrc: symSrc || "address fallback",
    wl: true, cc: /cc$/i.test(token), lc: false, pons: false,
    wash: false, credWarn: null, d30: null
  };
}

export async function getAllows() {
  const store = await _store("hoodsnipr-cache");
  return (await store.get("allows", { type: "json" }).catch(() => null)) || {};
}

export default async (req) => {
  try {
    const store = await _store("hoodsnipr-cache");
    const url = new URL(req.url);

    if (req.method === "GET") {
      if (url.searchParams.get("list") === "allows") {
        const allows = await getAllows();
        return json(200, {
          count: Object.keys(allows).length,
          allows: Object.entries(allows).map(([a, v]) => ({
            token: a, sym: v.sym || null, at: v.at, by: v.by, reason: v.reason || null
          })).sort((x, y) => y.at - x.at)
        });
      }
      const bans = await getBans();
      // public read: the list itself isn't secret, only the ability to change it
      return json(200, {
        count: Object.keys(bans).length,
        bans: Object.entries(bans).map(([a, v]) => ({
          token: a, sym: v.sym || null, at: v.at, by: v.by, reason: v.reason || null
        })).sort((x, y) => y.at - x.at)
      });
    }

    if (req.method !== "POST") return json(405, { error: "method" });

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "ban");
    const token = String(body.token || "").toLowerCase();
    const ts = Number(body.ts || 0);
    const sig = String(body.signature || "");
    const reason = String(body.reason || "").slice(0, 200);
    const sym = String(body.sym || "").slice(0, 32);

    if (!/^0x[0-9a-f]{40}$/.test(token)) return json(400, { error: "token must be a contract address" });
    if (!["ban", "unban", "allow", "unallow"].includes(action))
      return json(400, { error: "action must be ban, unban, allow or unallow" });
    if (!ts || Math.abs(Date.now() - ts) > MAX_AGE_MS)
      return json(400, { error: "signature expired — sign again" });
    if (!sig) return json(400, { error: "signature required" });

    // Recover the signer and check it against the owner allowlist.
    let signer;
    try { signer = getAddress(await verifyMessage(banMessage(action, token, ts), sig)); }
    catch (e) { return json(401, { error: "bad signature" }); }
    if (!OWNERS.has(signer.toLowerCase()))
      return json(403, { error: "wallet not authorised", signer });

    if (action === "allow" || action === "unallow") {
      // WHITELIST
      //
      // The automated filters are deliberately strict, and strict filters have
      // false negatives. This is the override: a whitelisted token appears in
      // trending regardless of logo, holder count, credibility score or wash
      // heuristics. It never bypasses a BAN — an explicit block always wins
      // over an explicit allow, so the two lists can't contradict each other.
      const allows = await getAllows();
      if (action === "allow") {
        allows[token] = { at: Date.now(), by: signer, reason: reason || null, sym: sym || null };
      } else {
        delete allows[token];
      }
      await store.setJSON("allows", allows);
      await store.setJSON("bansVersion", { v: Date.now() }).catch(() => {});

      // Writing the allow list isn't enough on its own: the board is rebuilt on
      // a schedule and served from cache, so a whitelisted token could sit
      // invisible for minutes. Resolve it NOW and put the row straight into the
      // published payload, so the override takes effect on the next page load.
      let injected = null;
      if (action === "allow") {
        injected = await resolveWhitelistRow(token, sym).catch(() => null);
        if (injected) {
          const wl = (await store.get("wlmeta", { type: "json" }).catch(() => null)) || {};
          wl[token] = injected;
          await store.setJSON("wlmeta", wl).catch(() => {});
          try {
            const board = await store.get("board2", { type: "json" });
            if (board && board.rows && !board.rows.some(r => String(r.a).toLowerCase() === token)) {
              board.rows.push(injected);
              await store.setJSON("board2", board);
            }
          } catch (e) {}
        }
      } else {
        const wl = (await store.get("wlmeta", { type: "json" }).catch(() => null)) || {};
        delete wl[token];
        await store.setJSON("wlmeta", wl).catch(() => {});
      }

      return json(200, {
        ok: true, action, token, by: signer,
        total: Object.keys(allows).length,
        resolved: injected ? { sym: injected.s, liq: injected.liq, h24: injected.h24, logo: !!injected.img } : null,
        diagnostics: injected ? {
          symbolSource: injected._symSrc || "unknown",
          marketData: injected.liq > 0 || injected.h24 > 0 ? "found" : "none yet",
          logo: injected.img ? "found" : "none",
          pool: injected.p || null
        } : null,
        note: injected
          ? "row injected into the live board — visible on the next load"
          : "could not build a row; check the address is a contract on this chain"
      });
    }

    const bans = await getBans();
    if (action === "ban") {
      bans[token] = { at: Date.now(), by: signer, reason: reason || null, sym: sym || null };
      // a ban supersedes a whitelist entry rather than fighting with it
      const allows = await getAllows();
      if (allows[token]) { delete allows[token]; await store.setJSON("allows", allows); }
    } else {
      delete bans[token];
    }
    await store.setJSON("bans", bans);

    // drop it from the live board immediately rather than waiting for a rebuild
    try {
      const board = await store.get("board2", { type: "json" });
      if (board && board.rows) {
        board.rows = board.rows.filter(r => String(r.a).toLowerCase() !== token || action === "unban");
        await store.setJSON("board2", board);
      }
    } catch (e) {}

    // bump a version stamp so the board endpoint knows its cache is stale
    await store.setJSON("bansVersion", { v: Date.now() }).catch(() => {});

    return json(200, { ok: true, action, token, by: signer, total: Object.keys(bans).length });
  } catch (e) {
    return json(500, { error: String(e && e.message || e).slice(0, 160) });
  }
};
