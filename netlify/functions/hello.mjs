// SMOKE TEST — the simplest possible function, no imports, no dependencies.
// If /.netlify/functions/hello 404s, functions aren't deploying at all and no
// amount of application code will help. If it returns JSON, the platform is
// fine and the problem is inside a specific function.
export default async () => new Response(
  JSON.stringify({
    ok: true,
    msg: "HoodSnipr functions are deployed",
    node: process.version,
    time: new Date().toISOString(),
    hasBlobsEnv: !!(process.env.NETLIFY_BLOBS_CONTEXT || process.env.SITE_ID || process.env.NETLIFY)
  }, null, 2),
  { headers: { "content-type": "application/json", "cache-control": "no-store" } }
);
