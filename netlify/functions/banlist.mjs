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

export default async (req) => {
  try {
    const store = await _store("hoodsnipr-cache");
    const url = new URL(req.url);

    if (req.method === "GET") {
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
    if (!["ban", "unban"].includes(action)) return json(400, { error: "action must be ban or unban" });
    if (!ts || Math.abs(Date.now() - ts) > MAX_AGE_MS)
      return json(400, { error: "signature expired — sign again" });
    if (!sig) return json(400, { error: "signature required" });

    // Recover the signer and check it against the owner allowlist.
    let signer;
    try { signer = getAddress(await verifyMessage(banMessage(action, token, ts), sig)); }
    catch (e) { return json(401, { error: "bad signature" }); }
    if (!OWNERS.has(signer.toLowerCase()))
      return json(403, { error: "wallet not authorised", signer });

    const bans = await getBans();
    if (action === "ban") {
      bans[token] = { at: Date.now(), by: signer, reason: reason || null, sym: sym || null };
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

    return json(200, { ok: true, action, token, by: signer, total: Object.keys(bans).length });
  } catch (e) {
    return json(500, { error: String(e && e.message || e).slice(0, 160) });
  }
};
