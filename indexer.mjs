// Scheduled every minute. Bounded so it always finishes and always saves.
import { runIndex } from "./_index.mjs";

export default async () => {
  const out = await runIndex({ budgetMs: 22000, rpcBudget: 2400 });
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "* * * * *" };
