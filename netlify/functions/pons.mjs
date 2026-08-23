// /pons            -> summary
// /pons?index=1    -> advance the launch index
// /pons?token=0x…  -> one token's launch record + graduation progress
import { indexLaunches, hydrate, graduation, ponsMap, PONS } from "./_pons.mjs";

const json = (c, b) => new Response(JSON.stringify(b), {
  status: c, headers: { "content-type": "application/json", "cache-control": "public, max-age=30" }
});

export default async (req) => {
  try {
    const url = new URL(req.url);

    const token = url.searchParams.get("token");
    if (token) {
      const map = await ponsMap();
      const rec = map[String(token).toLowerCase()];
      if (!rec) return json(200, { isPons: false });
      const grad = await graduation(token).catch(() => null);
      return json(200, { isPons: true, ...rec, graduation: grad, app: PONS.app });
    }

    if (url.searchParams.get("index") === "1") {
      const idx = await indexLaunches(6000);
      const hyd = await hydrate(4000, 40);
      return json(200, { index: idx, hydrate: hyd });
    }

    const map = await ponsMap();
    const all = Object.values(map);
    return json(200, {
      tokens: all.length,
      named: all.filter(t => t.sym && t.sym !== "?").length,
      contracts: { activeFactory: PONS.activeFactory, legacyFactory: PONS.legacyFactory },
      poolFee: PONS.poolFee, app: PONS.app
    });
  } catch (e) {
    return json(500, { error: String(e && e.message || e).slice(0, 160) });
  }
};
