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

export const DENY_ADDRESSES = new Set([
  // "0xabc…": exact token contracts to hide
].map(a => String(a).toLowerCase()));

// Exact normalised symbols to hide chain-wide.
export const DENY_SYMBOLS = new Set([
  "truth",
  "truthcoin",
  "mow",
  "bunny",
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
