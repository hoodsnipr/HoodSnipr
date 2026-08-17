// HoodSnipr profile claim — signature-verified against the claiming wallet.
import { getStore } from "@netlify/blobs";
import { verifyMessage } from "ethers";

const json = (code, body) => new Response(JSON.stringify(body), {
  status: code, headers: { "content-type": "application/json" }
});

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
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
  const store = getStore("hoodsnipr-profiles");
  await store.setJSON(clean.addr, clean);
  return json(200, { ok: true });
};
