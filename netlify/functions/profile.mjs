// HoodSnipr profiles — a handle is claimed by a wallet ONCE and bound to that
// address permanently.
//
// Two records are kept:
//   profiles:<addr>    -> the wallet's profile
//   handles:<handle>   -> which address owns that handle (first claim wins)
//
// The handle index is what makes ownership durable: nobody else can ever take
// a claimed name, and the owner keeps it across devices and browsers.
import { store as _store } from "./_store.mjs";

const json = (code, body) => new Response(JSON.stringify(body), {
  status: code, headers: { "content-type": "application/json", "cache-control": "no-store" }
});

// ethers only loads when we actually need to verify a signature
async function recoverSigner(msg, sig) {
  const m = await import("ethers").catch(() => null);
  const vm = m && (m.verifyMessage || (m.ethers && m.ethers.verifyMessage));
  if (!vm) throw new Error("verifier unavailable");
  return vm(msg, sig);
}

const normHandle = h => String(h || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24);

export default async (req) => {
  const url = new URL(req.url);
  const profiles = await _store("hoodsnipr-profiles");
  const handles = await _store("hoodsnipr-handles");

  // ---- GET ?addr=0x…  -> profile for a wallet ----
  // ---- GET ?handle=xyz -> availability check ----
  if (req.method === "GET") {
    const handleQ = normHandle(url.searchParams.get("handle") || "");
    if (handleQ) {
      const owner = await handles.get(handleQ, { type: "json" }).catch(() => null);
      return json(200, { handle: handleQ, taken: !!owner, owner: owner?.addr || null });
    }
    const addr = String(url.searchParams.get("addr") || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return json(400, { error: "bad addr" });
    const p = await profiles.get(addr, { type: "json" }).catch(() => null);
    return json(200, p || {});
  }

  if (req.method !== "POST") return json(405, { error: "GET or POST only" });

  let b;
  try { b = await req.json(); } catch { return json(400, { error: "bad json" }); }
  const { addr, msg, sig, name, x, pfp } = b || {};
  if (!addr || !msg || !sig) return json(400, { error: "addr/msg/sig required" });

  // 1) signature must recover to the claiming address
  let rec;
  try {
    rec = await recoverSigner(msg, sig);          // <-- must be awaited; not awaiting
  } catch (e) {                                    //     it made every save fail
    return json(400, { error: "signature check failed: " + (e.message || "unknown") });
  }
  if (!rec || String(rec).toLowerCase() !== String(addr).toLowerCase())
    return json(401, { error: "signature mismatch" });

  // 2) the signed message must claim this exact address (blocks replay)
  if (!msg.includes("HoodSnipr profile claim") || !msg.includes("addr:" + addr))
    return json(400, { error: "malformed claim" });

  const me = String(addr).toLowerCase();
  const wanted = normHandle(name);

  // 3) HANDLE OWNERSHIP — first claim wins, forever
  if (wanted) {
    const owner = await handles.get(wanted, { type: "json" }).catch(() => null);
    if (owner && String(owner.addr).toLowerCase() !== me) {
      return json(409, { error: "handle taken", handle: wanted, takenBy: owner.addr });
    }
  }

  const prev = await profiles.get(me, { type: "json" }).catch(() => null);

  const clean = {
    addr: me,
    name: String(name || "").slice(0, 24),
    handle: wanted || (prev && prev.handle) || "",
    x: String(x || "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 15),
    pfp: typeof pfp === "string" && pfp.startsWith("data:image/") && pfp.length < 60000
      ? pfp : (prev ? prev.pfp : null),
    claimedAt: (prev && prev.claimedAt) || Date.now(),
    ts: Date.now()
  };

  await profiles.setJSON(me, clean);

  // bind the handle to this address permanently
  if (wanted) {
    await handles.setJSON(wanted, { addr: me, claimedAt: clean.claimedAt });
    // release a previous handle this wallet owned, if it renamed
    const oldHandle = prev && prev.handle;
    if (oldHandle && oldHandle !== wanted) {
      const oldOwner = await handles.get(oldHandle, { type: "json" }).catch(() => null);
      if (oldOwner && String(oldOwner.addr).toLowerCase() === me) {
        await handles.delete(oldHandle).catch(() => {});
      }
    }
  }

  return json(200, { ok: true, profile: clean });
};
