# Security Policy

## Reporting a vulnerability

Do **not** open a public issue for security bugs.

Report privately via GitHub's [Security Advisories](../../security/advisories/new)
or email the address listed on the site.

Please include: what you found, how to reproduce it, and what an attacker could
do with it. Expect an acknowledgement within 72 hours.

## Scope

In scope:
- Fee-routing logic (anything that could redirect or inflate the platform fee)
- Wallet-connection and transaction-construction flows
- The deposit-address factory contract (once deployed)
- XSS, CSP bypass, or supply-chain issues in the static site

Out of scope:
- The simulated data in the v0.1 prototype
- Third-party CDN availability
- Missing security headers on preview deploys

## Known accepted risk

`app.html` compiles JSX in-browser via `babel-standalone`, which requires
`'unsafe-eval'` in the Content-Security-Policy. This is accepted for the
prototype and is tracked for removal when the app moves to a compiled build.

## Design commitments

- The fee recipient is a frozen constant in the client and an immutable constant
  onchain. No admin key can redirect it.
- Deposit addresses are deterministic (CREATE2) and non-custodial. The platform
  never holds user keys and cannot redirect delivery.
- No inline event handlers anywhere. All interaction is `addEventListener` with
  `data-action` delegation, so a CSP tightening can never silently kill the UI.
