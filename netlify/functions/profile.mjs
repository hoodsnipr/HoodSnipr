// HoodSnipr profile claim — signature-verified against the claiming wallet.
import { store as _store, storeMode } from "./_store.mjs";

const json = (code, body) => new Response(JSON.stringify(body), {
  status: code, headers: { "content-type": "application/json" }
});

// ethers is loaded lazily: if it's unavailable the endpoint still works for
// reads, it just can't verify signatures on writes.
async function verifyMessage(msg, sig){
  const m = await import("ethers").catch(() => null);
  if (!m) throw new Error("signature verification unavailable");
  return (m.verifyMessage || m.ethers?.verifyMessage)(msg, sig);
}

export default async (req) => {
  // GET ?addr=0x… → the profile bound to that wallet. This is what makes a
  // profile actually follow the address instead of living in one browser.
  if (req.method === "GET") {
    const addr = (new URL(req.url).searchParams.get("addr") || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return json(400, { error: "bad addr" });
    const p = await await _store("hoodsnipr-profiles").get(addr, { type: "json" }).catch(() => null);
    return json(200, p || {});
  }
  if (req.method !== "POST") return json(405, { error: "GET or POST only" });
  let b;
  try { b = await req.json(); } catch { return json(400, { error: "bad json" }); }
  const { addr, msg, sig, name, x, pfp } = b || {};
  if (!addr || !msg || !sig) return json(400, { error: "addr/msg/sig required" });

  // 1) signature must recover to the claimed address
  let rec;
  try { rec = verifyMessage(msg, sig); } catch { return json(400, { error: "bad signature" }); }
  if (rec.toLowerCase() !== addr.toLowerCase()) return json(401, { error: "signature mismatch" });

  // 2) the signed message must actually claim this addr + name (no replay of someone else's sig)
  if (!msg.includes("HoodSnipr profile claim") || !msg.includes("addr:" + addr))
    return json(400, { error: "malformed claim" });

  // 3) sanitize + size-cap
  const clean = {
    addr: addr.toLowerCase(),
    name: String(name || "").slice(0, 24),
    x: String(x || "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 15),
    pfp: typeof pfp === "string" && pfp.startsWith("data:image/") && pfp.length < 60000 ? pfp : null,
    ts: Date.now()
  };
  const store = await _store("hoodsnipr-profiles");
  await store.setJSON(clean.addr, clean);
  return json(200, { ok: true });
};
