# HoodSnipr v0.2 — go-live notes

## What is LIVE the moment you push

- **Trending board** — real pools from **GeckoTerminal** (network `robinhood`,
  trending + top-volume pages) merged with **DexScreener** (chain slug
  auto-probed at runtime), deduped by base-token address, dust pools under $500
  liquidity filtered out. Refreshes every 30s. The SOURCES readout in the UI
  shows which indexers answered.
- **5M / 1H / 24H** — straight from indexer volume fields.
- **30D** — neither indexer exposes a 30-day volume field, so the app sums 30
  daily OHLCV candles per pool from GeckoTerminal, lazily, top-20 pools only,
  throttled to respect the free tier (~30 req/min), cached 6h in the browser.
  First open of the 30D tab shows a RANGING progress line for ~1 min. That is
  the honest cost of a real 30-day number.
- **Live charts** — tapping any row opens the real GeckoTerminal candle chart
  (iframe embed) with liq/FDV/volume stats and DexScreener/GT link-outs.
- **Wallet connect** — real. Adds/switches to Robinhood Chain (4663,
  rpc.mainnet.chain.robinhood.com) via `wallet_addEthereumChain`.
- **HoodSnipr wallet (burner)** — real. Generated client-side with ethers,
  keys stored only in the user's browser, balance read live from chain RPC.
  Non-custodial by construction: you never hold user keys, which keeps you out
  of the money-transmitter blast radius that a server-side wallet would create.
- **Profiles** — name, PFP (downscaled client-side to 128px), X handle.
  Claiming signs a message with the connected wallet; the backend verifies the
  signature recovers to the claiming address before storing.
- **Leaderboard** — Netlify Function + Netlify Blobs, top 50 by PnL, joined
  with claimed profiles. Deploys automatically with the repo (Blobs needs no
  external account).
- **PnL share cards** — 1200×630 branded card drawn client-side on canvas
  (scope mark, HoodSnipr wordmark, green/red PnL, user name + @handle),
  downloaded as PNG + X intent opened. X has no API that attaches media from a
  web intent, so the flow is download → auto-opened compose → user attaches.
  That is the same flow every PnL-card product uses.

## What YOU must configure (CFG block at the top of app.html)

1. **`FEE_WALLET`** — currently `""` = dev mode, fee transfer skipped and the
   UI says so. Set it to your locked fee address to start collecting 0.25%.
2. **`SWAP`** — currently `{ mode: "disabled" }`. In this mode a snipe =
   fee transfer (if set) + opens the token's DEX page to finish the swap, and
   the UI labels execution as "FEE + DEX LINK-OUT". To go full one-tap:
   - Find the router on docs.robinhood.com/chain/protocol-contracts (Uniswap
     contracts are deployed on 4663) and **verify the address on Blockscout**.
   - If it's a v2-style router: `SWAP: { mode:"v2", router:"0x…", weth:"0x…" }`
     and the app executes `swapExactETHForTokensSupportingFeeOnTransferTokens`.
   - If it's Universal Router / v4 with launchpad hooks (likely for hood.fun
     and Flap tokens), the calldata is different per pool — that's a v0.3 task,
     not a config flag. Do NOT point mode:"v2" at the Universal Router.
   - ⚠️ amountOutMin is 0 in v0.2 (no slippage guard). Fine for testing; add a
     quote + minOut before pushing volume through it.

## Honest limitations to keep in your head

- **PnL is client-reported in v0.2.** Trades are recorded when fired through
  the app and priced against live indexer data — good enough for a social
  leaderboard, trivially spoofable by a motivated liar. v0.3 should verify
  trades against Blockscout/chain logs before ranking. The function file
  already carries this note.
- **Burner wallet lives in localStorage.** Clear browsing data = gone. The UI
  screams this at every step, forces a double-confirm on destroy, and pushes
  key export. Keep pushing users to hold only active-sniping dust in it.
- **Rate limits.** GT free tier is ~30 calls/min. The refresh loop uses 3/30s
  and 30D is throttled + cached, so you're inside it. If traffic grows, proxy
  GT through a Netlify Function with a shared cache, or get a CoinGecko API
  key (paid tiers raise onchain limits ~25×).
- **X integration is handle-only.** Real OAuth ("Sign in with X") needs an X
  developer app + a serverless callback — scaffold exists in the profile
  model (`x` field), wire it when you want verified handles.

## Deploy

```bash
git add -A && git commit -m "feat: v0.2 — live data, charts, wallets, profiles, leaderboard, PnL cards"
git push
```

Netlify picks up `netlify/functions` automatically (now registered in
netlify.toml). First deploy after adding package.json will run npm install for
the functions — that's expected.

## Test order (10 minutes)

1. Open /app.html → board fills with real pools, SOURCES shows GECKOTERMINAL
   (+ DEXSCREENER if the slug probe hits)
2. Flip 5M → 1H → 24H → instant re-rank. Flip 30D → RANGING progress → fills in
3. Tap a token → live GT chart renders in the modal
4. Connect wallet → approve chain add → header shows your address
5. Wallets tab → create burner → export key → send $2 of ETH → Refresh balance
6. Fire a small snipe in link-out mode → trade appears in Profile with live PnL
7. Profile → set name + PFP → Sign & save → check Ranks tab
8. Share PnL → card downloads, X compose opens
