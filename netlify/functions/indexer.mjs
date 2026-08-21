// Scheduled every minute: refreshes the trending board from the screener feeds,
// and keeps the Uniswap v4 PoolKey index backfilling so v4 tokens are snipeable.
import { rebuild } from "./_board.mjs";
import { scanV4 } from "./v4pools.mjs";

export default async () => {
  const deep = new Date().getMinutes() % 5 === 0;
  const out = await rebuild({ deep }).catch(e => ({ error: e.message }));
  // v4 discovery gets the remaining budget — it only needs to finish once,
  // then it just tracks new pools at the chain tip.
  const v4 = await scanV4(9000).catch(e => ({ error: e.message }));
  return new Response(JSON.stringify({
    ok: !out.error, deep,
    rows: out.rows?.length ?? 0,
    universe: out.stats?.universeTokens ?? 0,
    v4: { manager: v4.manager, tokens: v4.tokens, done: v4.backfillDone, cursor: v4.cursor },
    error: out.error
  }), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "* * * * *" };
