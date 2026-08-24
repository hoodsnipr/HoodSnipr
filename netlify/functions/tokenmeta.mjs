// Holders (Blockscout, 10-min TTL) + socials (GT info, 24h TTL) for up to 10
// tokens per call, cached in Blobs and shared by every user. First visitor
// pays the lookup; everyone after reads cache.
import { store as _store, storeMode } from "./_store.mjs";
const GT = "https://api.geckoterminal.com/api/v2";
const NET = "robinhood";
const BS = "https://robinhoodchain.blockscout.com/api/v2";
const json = (c, b) => new Response(JSON.stringify(b), { status: c, headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } });

export default async (req) => {
  const raw = (new URL(req.url).searchParams.get("addrs") || "").toLowerCase();
  const addrs = raw.split(",").filter(a => /^0x[0-9a-f]{40}$/.test(a)).slice(0, 10);
  if (!addrs.length) return json(400, { error: "no addrs" });
  const store = await _store("hoodsnipr-cache");
  const out = {};
  let i = 0;
  async function worker() {
    while (i < addrs.length) {
      const a = addrs[i++];
      const key = "meta:" + a;
      let m = await store.get(key, { type: "json" }).catch(() => null) || {};
      const now = Date.now();
      const needH = m.hT == null || now - m.hT > 10 * 60e3;
      const needS = m.sT == null || now - m.sT > 24 * 3600e3;
      if (needH) {
        try {
          const r = await fetch(`${BS}/tokens/${a}`);
          if (r.ok) {
            const t = await r.json();
            const h = parseInt(t.holders_count != null ? t.holders_count : t.holders, 10);
            m.h = isNaN(h) ? null : h;
            // same response carries the token icon — a logo source we were
            // discarding while paying for the request anyway
            if (t.icon_url && /^https?:\/\//i.test(t.icon_url)) m.img = t.icon_url;
          }
          m.hT = now;
        } catch (e) {}
      }
      if (needS) {
        try {
          const r = await fetch(`${GT}/networks/${NET}/tokens/${a}/info`, { headers: { accept: "application/json" } });
          if (r.ok) {
            const at = (((await r.json()).data || {}).attributes) || {};
            m.site = (at.websites && at.websites[0]) || null;
            m.tw = at.twitter_handle ? "https://x.com/" + at.twitter_handle : null;
            m.tg = at.telegram_handle ? "https://t.me/" + at.telegram_handle : null;
          }
          m.sT = now;
        } catch (e) {}
      }
      if (needH || needS) await store.setJSON(key, m).catch(() => {});
      out[a] = { h: m.h ?? null, site: m.site ?? null, tw: m.tw ?? null, tg: m.tg ?? null };
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return json(200, out);
};
