# GitHub setup sheet

Everything to paste into GitHub's fields. Delete this file after setup if you
don't want it public.

---

## 1. Repository name

```
hoodsnipr
```

Alternates if taken: `hoodsnipr-app` · `hoodsnipr-dapp` · `quivr-protocol`

---

## 2. About → Description

GitHub's About box truncates around 350 characters. Pick one.

**Primary (recommended):**

```
Every trending token. One arrow away. A zero-build sniping terminal for Robinhood Chain — tokens ranked by real volume across 5M/1H/24H/30D, wallet or send-ETH flows, 0.25% fee. Powered by $QUIVR.
```

**Short:**

```
Snipe trending tokens on Robinhood Chain. Volume-ranked across 5M/1H/24H/30D. 0.25% fee. $QUIVR powered.
```

**Very short (for the repo list view):**

```
The sniping terminal for Robinhood Chain. 0.25% fee, $QUIVR powered.
```

---

## 3. About → Website

```
https://hoodsnipr.netlify.app
```

Swap in your custom domain once it's pointed.

---

## 4. About → Topics

Paste these one at a time (GitHub caps at 20):

```
robinhood-chain
defi
dapp
web3
evm
ethereum
layer2
memecoin
token-sniper
trading-bot
crypto
javascript
react
static-site
netlify
no-build
quivr
hoodsnipr
```

---

## 5. Social preview image

Settings → General → Social preview → Upload

```
og.png
```

(It's already in the repo root, 1200×630, correct spec.)

---

## 6. Repo settings checklist

- **Visibility:** Public
- **Add a README:** No — this repo already has one
- **Add .gitignore:** No — already included
- **Add a license:** No — MIT already included
- ✅ Issues
- ❌ Wiki (the whitepaper covers it)
- ❌ Projects
- ✅ Discussions — useful once there's a community
- **Default branch:** `main`

---

## 7. First commit message

```
feat: HoodSnipr v0.1 — trending-token sniping terminal for Robinhood Chain

Landing page with interactive scope UI and live fee calculator, prototype
dapp with volume-ranked board across 5M/1H/24H/30D, wallet and send-ETH
snipe flows, 0.25% fee model with $QUIVR tiers, full logo pack, and
The Quivr Paper v0.1.

Zero build step — static HTML with React via CDN.
Data is simulated; no transaction is signed.
```

Short version if you're on mobile:

```
feat: HoodSnipr v0.1 — landing, prototype dapp, logo pack, Quivr Paper
```

---

## 8. Release description (tag `v0.1.0`)

**Title:** `v0.1.0 — The Scope`

**Body:**

```markdown
First public build. The scope is calibrated; nothing is loaded yet.

### What works
- Landing page with cursor-tracking reticle, target-lock headings, and a live 0.25% fee calculator
- Trending board ranked by volume across 5M / 1H / 24H / 30D — flip the window, the board re-sorts
- Snipe flow with full fee breakdown, wallet mode and send-ETH mode
- $QUIVR tier logic: Free Range 0.25% → Archer 0.20% → Marksman 0.15% → Deadeye 0.10%
- Complete logo pack (SVG + PNG, all sizes) and The Quivr Paper v0.1

### What doesn't
Token list, prices, volume, and swap execution are **simulated**. Wallet connect
will talk to a real MetaMask if one is installed, but no transaction is ever
constructed or signed. This is a prototype.

### Next
v0.2 wires live Robinhood Chain RPC and indexer feeds, real swaps through
native DEX liquidity, and honeypot badges on the board.

**Not affiliated with Robinhood Markets, Inc.** Not investment advice.
```

---

## 9. Deploy after pushing

### Netlify (recommended — config is already in the repo)

1. app.netlify.com → **Add new site** → **Import an existing project**
2. **Deploy with GitHub** → authorize → pick `hoodsnipr`
3. Build command: **leave empty**. Publish directory: `.`
4. **Deploy site**
5. Site configuration → Change site name → `hoodsnipr`

Every push to `main` now redeploys automatically. `netlify.toml` applies the
security headers and `_redirects` enables `/app` and `/paper`.

### GitHub Pages (free, no second account)

Settings → Pages → Source: **Deploy from a branch** → `main` / `/ (root)` → Save.

Live at `https://USERNAME.github.io/hoodsnipr/` in about a minute. `.nojekyll` is
already present. Trade-off: Pages ignores `netlify.toml`, so you lose the CSP
and security headers plus the `/app` and `/paper` shortcuts.

---

## 10. Uploading from your phone

The GitHub mobile app can't create files, so use the browser:

1. github.com → **+** → **New repository** → name it, Public, **don't** add any
   starter files
2. On the empty repo page tap **uploading an existing file**
3. Select all files from the unzipped folder. Do this in two passes if the
   picker struggles: root files first, then `assets/` and `docs/`
4. Paste the commit message from §7 → **Commit changes**

Dotfiles (`.gitignore`, `.nojekyll`) may be hidden in your file picker. If they
don't upload, create them manually: **Add file → Create new file**, type the
filename, paste the contents, commit. `.nojekyll` can be completely empty.

---

## 11. Before you make it public

- [ ] Replace `USERNAME` in the README clone URL with your GitHub handle
- [ ] Point the README badge URLs at your repo if you want live build badges
- [ ] Confirm `FEE_WALLET` and `DEPOSIT_ADDR` in `app.html` are still obvious
      placeholders — never commit a real private key or seed phrase, and note
      that `.gitignore` already blocks `.env`, `*.key`, and `wallet.json`
- [ ] Update the security contact in `SECURITY.md`
- [ ] Delete this file if you'd rather it not be public

---

## 12. One honest note

Publishing under this name and this shade of green makes the project easy to
find — including by Robinhood's brand-protection team. The disclaimer in the
README and the paper helps, but it isn't a shield, and a public repo is a
permanent, timestamped record. Worth a short consult with an IP attorney before
you buy a domain or put real hours into content. Having a fallback name ready
costs nothing. (I'm not a lawyer — this is a flag, not advice.)
