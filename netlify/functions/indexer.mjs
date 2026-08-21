// Scheduled every minute. Refreshes the trending universe from the screener
// feeds — no chain-wide pool enumeration. Deep pass every 5th minute rotates
// through GeckoTerminal's volume pages so coverage extends past the first page.
import { rebuild } from "./_board.mjs";

export default async () => {
  const deep = new Date().getMinutes() % 5 === 0;
  const out = await rebuild({ deep }).catch(e => ({ error: e.message }));
  return new Response(JSON.stringify({
    ok: !out.error, deep,
    rows: out.rows?.length ?? 0,
    universe: out.stats?.universeTokens ?? 0,
    error: out.error
  }), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "* * * * *" };
