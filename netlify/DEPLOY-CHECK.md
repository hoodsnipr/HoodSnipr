# HoodSnipr — Deployment Check

Your functions were returning **404**, which means Netlify never deployed them.
Everything server-side (the chain indexer, the full token board, shared caching)
has therefore been dead code on the live site, and the app silently fell back to
direct GeckoTerminal calls — that's the 14–30 token list, the slowness, and the
rate limiting, all from one cause.

Work through these in order. Stop at the first one that fails.

## 1. Is the code actually on GitHub?

Open your repo on github.com and confirm this folder exists with files in it:

    netlify/functions/

You should see `hello.mjs`, `board.mjs`, `indexer.mjs`, `status.mjs`, `_index.mjs`,
`_rpc.mjs`, `_chainboard.mjs`, and others.

**If the folder is missing:** you've been pushing only `app.html` / `index.html`.
Copy the ENTIRE contents of the zip over your local repo folder, then commit and
push everything. In GitHub Desktop, check that the changed-files list includes
the `netlify/functions/` entries before you commit.

## 2. Smoke test — is ANY function deploying?

After the deploy finishes, open:

    https://hoodsnipr.com/.netlify/functions/hello

- **JSON response** → functions work. Go to step 4.
- **404** → functions are not deploying. Go to step 3.

## 3. Check Netlify's build settings

In Netlify: **Site configuration → Build & deploy → Build settings**

- **Base directory:** must be EMPTY (unless your repo has the site in a subfolder,
  in which case it must be that subfolder).
- **Publish directory:** `.`
- **Functions directory:** `netlify/functions`

UI settings override `netlify.toml`, so a wrong value here silently wins.

Then open **Deploys → (latest deploy) → Deploy log** and search for `Functions`.
A healthy build logs something like `Packaging Functions from netlify/functions
directory: 11 files`. If it says **0 files** or the section is absent, Netlify
isn't seeing the directory — the cause is almost always step 1 or the base
directory in step 3.

## 4. Verify the indexer

    https://hoodsnipr.com/.netlify/functions/status?run=1

Give it ~20 seconds. Key fields:

- `blobsOk: true` — storage works. If false, enable Blobs for the site.
- `poolsIndexed` — pools found from chain logs. Should climb into the thousands.
- `backfillChunk` — should sit near `1000000`. If it has collapsed to `2000`,
  the RPC is rejecting wide log queries.
- `errors: []` — anything here names the exact failure.

Run it two or three times; `backfillCursor` should fall each time as it walks
back through chain history.


## If `hello` works but `status` 404s (this was your case)

`hello.mjs` imports nothing. Every other function imported `@netlify/blobs`.
When Netlify doesn't install dependencies, those functions fail to BUNDLE and
are never deployed — so they 404 while `hello` works fine.

Two causes, both now fixed in this repo:

1. **`package-lock.json` was gitignored.** Netlify needs the lockfile to install
   dependencies reliably. It is now committed — make sure it reaches GitHub.
2. **The build command was empty.** With no build command Netlify can skip
   `npm install` entirely. It is now `npm install --no-audit --no-fund`.

On top of that, all dependency imports are now **dynamic and guarded**. If a
package is ever missing again, the function still deploys and still responds —
it degrades and reports `storeMode: "memory:..."` in `/status` instead of
disappearing behind a 404.

In the deploy log you should now see npm installing packages, then
`Packaging Functions from netlify/functions directory: 15 files`.

## 5. Confirm the schedule

**Netlify → Functions** should list `indexer` and `crawler` with a schedule of
`* * * * *`. Scheduled functions only run on published production deploys, never
on deploy previews or branch deploys.

Once `hello` returns JSON and `status` shows `poolsIndexed` climbing, the app will
fill in on its own within a few minutes.
