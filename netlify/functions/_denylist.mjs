// MANUAL DENYLIST
//
// Automated scoring will always lag a human who can see a scam plainly. This is
// the override: anything listed here never reaches the board, regardless of what
// the volume says. Add an address (preferred — exact and unspoofable) or a
// symbol pattern, and redeploy.
//
// Symbol rules are matched after normalisation (lowercased, punctuation and the
// words "coin"/"token" stripped), so "$TRUTH coin", "TRUTHCOIN" and "Truth"
// collapse to the same key.

// PREFERRED: exact contract addresses. Unspoofable, and they can never hit an
// innocent token that happens to share a ticker.
//   "0x1234…abcd",   // $SCAM — force-send exploit, reported 2026-08-22
export const DENY_ADDRESSES = new Set([
].map(a => String(a).toLowerCase()));

// Symbol bans are BLUNT — a legitimate token can share a ticker with a scam,
// and symbols are the easiest thing in the world to spoof. Prefer addresses.
// Anything listed here is hidden chain-wide regardless of its metrics, so keep
// the list short and deliberate.
export const DENY_SYMBOLS = new Set([
  // reported exploiting the force-send pattern:
  "truth",
  "truthcoin",
  "www"
]);

// Regex patterns for families of impersonation.
export const DENY_PATTERNS = [
  /^test\d*$/i,
  /^(scam|rug|honeypot)/i
];

export function normSym(sym) {
  return String(sym || "")
    .toLowerCase()
    .replace(/^\$+/, "")
    .replace(/[^a-z0-9]/g, "")
    .replace(/(coin|token)$/, "");
}

export function isDenied(token, symbol) {
  const a = String(token || "").toLowerCase();
  if (DENY_ADDRESSES.has(a)) return "address";
  const n = normSym(symbol);
  if (!n) return null;
  if (DENY_SYMBOLS.has(n)) return "symbol";
  for (const re of DENY_PATTERNS) if (re.test(n)) return "pattern";
  return null;
}
