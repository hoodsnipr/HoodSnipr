// Storage with a safety net.
//
// Every function that did `import { getStore } from "@netlify/blobs"` at the top
// level would FAIL TO BUNDLE — and therefore 404 — if the dependency wasn't
// installed on the build. A 404 is invisible to the app, which just falls back
// to a worse data path. That's exactly the failure we hit.
//
// So the import is now dynamic and guarded: if Blobs is unavailable for any
// reason, we degrade to an in-process store and SAY SO, instead of the whole
// endpoint vanishing.
let _getStore = null;
let _mode = "unknown";
const memory = new Map();

async function loadBlobs() {
  if (_getStore) return _getStore;
  try {
    const mod = await import("@netlify/blobs");
    if (mod && typeof mod.getStore === "function") { _getStore = mod.getStore; _mode = "blobs"; return _getStore; }
    throw new Error("getStore missing");
  } catch (e) {
    _mode = "memory:" + (e.message || "unavailable").slice(0, 60);
    _getStore = null;
    return null;
  }
}

function memStore(name) {
  const pfx = name + "::";
  const k = key => pfx + key;
  return {
    async get(key) { const v = memory.get(k(key)); return v === undefined ? null : v; },
    async setJSON(key, val) { memory.set(k(key), val); },
    async set(key, val) { memory.set(k(key), val); },
    async delete(key) { memory.delete(k(key)); },
    async list() {
      const blobs = [];
      for (const key of memory.keys()) if (key.startsWith(pfx)) blobs.push({ key: key.slice(pfx.length) });
      return { blobs };
    }
  };
}

export async function store(name = "hoodsnipr-cache") {
  const gs = await loadBlobs();
  if (!gs) return memStore(name);
  try {
    const s = gs(name);
    // wrap so a runtime blobs failure degrades instead of throwing upward
    return {
      async get(key, opts) { try { return await s.get(key, opts); } catch (e) { return null; } },
      async setJSON(key, val) { try { await s.setJSON(key, val); } catch (e) { memory.set(name + "::" + key, val); } },
      async set(key, val) { try { await s.set(key, val); } catch (e) { memory.set(name + "::" + key, val); } },
      async delete(key) { try { await s.delete(key); } catch (e) {} },
      async list(opts) { try { return (await s.list(opts)) || { blobs: [] }; } catch (e) { return { blobs: [] }; } }
    };
  } catch (e) {
    _mode = "memory:getStore threw";
    return memStore(name);
  }
}
export function storeMode() { return _mode; }
