// Scheduled every minute. Bounded so it always finishes and always saves.
import { runIndex } from "./_index.mjs";

export default async () => {
  const out = await runIndex({ budgetMs: 20000, rpcBudget: 1200 });
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "* * * * *" };
