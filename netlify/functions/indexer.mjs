// Scheduled every minute: refreshes the trending board from the screener feeds,
// and keeps the Uniswap v4 PoolKey index backfilling so v4 tokens are snipeable.
import { rebuild } from "./_board.mjs";
import { scanV4, learnHooks } from "./v4pools.mjs";
import { indexLaunches, hydrate } from "./_pons.mjs";
import { fillVol30 } from "./_vol30.mjs";
import { learnLetscashHooks, letscashHookSet, discoverTokens, hydrateTokens, scanLetscash, pruneStore } from "./_letscash.mjs";

export default async () => {
  const deep = new Date().getMinutes() % 5 === 0;
  const out = await rebuild({ deep }).catch(e => ({ error: e.message }));
  // v4 discovery gets the remaining budget — it only needs to finish once,
  // then it just tracks new pools at the chain tip.
  // Learning hook addresses is the highest-value v4 work: once known, pools
  // derive locally with no RPC. Do that first, backfill with what's left.
  // Budgets must leave headroom inside the platform's execution limit —
  // overrunning gets the invocation killed and nothing is written at all.
  // pons launches first — catching a token at birth is the highest-value work
  const pons = await indexLaunches(5000).catch(e => ({ error: e.message }));
  await hydrate(3000, 30).catch(() => {});
  // top up 30D volume coverage every run — this is what makes the 30D board
  // meaningful below the top 20
  const v30 = await fillVol30(out.rows || [], { budgetMs: 4000, max: 12 }).catch(e => ({ error: e.message }));
  const hooks = await learnHooks(2500).catch(e => ({ error: e.message }));
  // cheap: reads the v4 key index we already hold, no RPC
  const lc = await (async () => {
    try {
      const { store } = await import("./_store.mjs");
      const s2 = await store("hoodsnipr-cache");
      const v4s = await s2.get("v4pools", { type: "json" });
      const keys = (v4s && v4s.keys) || {};
      await learnLetscashHooks(keys);
      // Enumerate the launchpad end to end from PoolManager Initialize logs,
      // the same way pons is enumerated from its factory. This is what makes
      // established tokens appear rather than only ones we happened to index.
      await pruneStore();                       // drop anything not cc-stamped
      // Bigger slice per run: the backward walk was only a few hundred tokens
      // deep after hours of uptime, which left established coins unindexed.
      const sweep = await scanLetscash(5000);
      const { letscashMap } = await import("./_letscash.mjs");
      const all = await letscashMap();
      const hyd = await hydrateTokens(Object.keys(all), { budgetMs: 4000, limit: 60 });
      return {
        tokens: sweep.tokens, foundThisRun: sweep.found,
        sweepDone: sweep.done, cursor: sweep.cursor,
        hydrated: hyd.hydrated
      };
    } catch (e) { return { error: e.message }; }
  })();
  const v4 = await scanV4(2000).catch(e => ({ error: e.message }));
  return new Response(JSON.stringify({
    ok: !out.error, deep,
    rows: out.rows?.length ?? 0,
    universe: out.stats?.universeTokens ?? 0,
    pons: { tokens: pons.totalTokens, found: pons.found, caughtUp: pons.caughtUp },
    vol30: v30, letscash: lc,
    v4: { manager: v4.manager || hooks.manager, tokens: v4.tokens,
          hooks: (hooks.hooks || []).length, done: v4.backfillDone, cursor: v4.cursor },
    error: out.error
  }), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "* * * * *" };
