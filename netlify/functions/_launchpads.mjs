// LAUNCHPAD ADAPTER REGISTRY
//
// Robinhood Chain's v4 pools are launchpad bonding-curve pools: each token
// deploys its own hook+router contract with its own ABI, so there's no single
// router to integrate. But those contracts are FACTORY-DEPLOYED — every token
// from the same launchpad shares identical bytecode and therefore identical
// selectors. So a launchpad is a "family", and one adapter serves every token
// in it.
//
// Adding a launchpad = adding one entry here. Nothing else changes.
//
// Each adapter needs:
//   id/name      — display
//   selectors    — buy/sell function selectors seen onchain (the family key)
//   codeHashes   — optional exact bytecode match, the strongest signal
//   encodeBuy    — build calldata for an ETH -> token buy
//   valueIsEth   — whether ETH rides as msg.value or as an ABI arg
//
// Everything is keyed off observed onchain behaviour, never assumption.

export const LAUNCHPADS = [
  // ---- Populate from /v4pools?families=1 output. Example shape: ----
  // {
  //   id: "coinbarrel",
  //   name: "Coinbarrel",
  //   selectors: { buy: "0x61461954", sell: "0x..." },
  //   codeHashes: [],
  //   valueIsEth: true,
  //   encodeBuy({ token, amountInWei, minOut, recipient, deadline }) {
  //     const abi = AbiCoder.defaultAbiCoder();
  //     return "0x61461954" + abi.encode(
  //       ["address","uint256","address"], [token, minOut, recipient]).slice(2);
  //   }
  // }
];

export function findAdapter({ selector, codeHash }) {
  for (const lp of LAUNCHPADS) {
    if (codeHash && (lp.codeHashes || []).includes(codeHash)) return lp;
    if (selector && Object.values(lp.selectors || {}).includes(selector)) return lp;
  }
  return null;
}

export function adapterSummary() {
  return LAUNCHPADS.map(l => ({
    id: l.id, name: l.name,
    selectors: Object.values(l.selectors || {}),
    codeHashes: (l.codeHashes || []).length
  }));
}
