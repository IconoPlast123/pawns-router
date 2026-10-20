import { readJson, writeJsonAtomic } from "./util.js";

// The router's books. Everything in lamports and raw token units (integers), so totals never drift.
// One file per world (data/ledger-live.json, data/ledger-dry_run.json): this is the proof behind the site.
function blank(kind) {
  return {
    version: 1,
    kind,
    startedAt: Date.now(),
    router: "",
    decimals: 6,
    supplyRaw: 0,
    totals: { receivedLamports: 0, buysLamports: 0, networkLamports: 0, devLamports: 0, depositsLamports: 0 },
    claims: [],
    pawns: [],
    pending: null,
    history: [],
    check: { at: 0, sold: 0 }
  };
}

export function openLedger(file, kind) {
  const data = readJson(file, null) ?? blank(kind);
  if (data.kind !== kind) throw new Error(`${file} appartient au mode ${data.kind}, pas ${kind}.`);
  const T = data.totals;

  return {
    data,
    save: () => writeJsonAtomic(file, data),

    // SOL put into the router by hand (the gas buffer). Not creator fees, so not in "received".
    addDeposit(lamports) { T.depositsLamports += lamports; },

    // received = creator fees that landed in the router; fee = what the claim transaction cost.
    addClaim({ at, receivedLamports, feeLamports, tx = "" }) {
      T.receivedLamports += receivedLamports;
      T.networkLamports += feeLamports;
      data.claims.push({ at, lamports: receivedLamports, fee: feeLamports, tx });
    },

    // Only if DEV_SHARE_PCT > 0. Shows up as fees.devSol on the site.
    addDevPayment({ at, lamports, feeLamports, tx = "" }) {
      T.devLamports += lamports;
      T.networkLamports += feeLamports;
      (data.devPayments ??= []).push({ at, lamports, fee: feeLamports, tx });
    },

    // buyLamports = the swap itself (fees included); networkLamports = token account rent + transaction fees.
    addPawn(p) {
      const pawn = { n: data.pawns.length + 1, ...p, lastRaw: p.tokensRaw, sold: false };
      T.buysLamports += p.buyLamports;
      T.networkLamports += p.networkLamports;
      data.pawns.push(pawn);
      return pawn;
    },

    // A network cost outside a pawn: a transaction that landed but failed, or the address lookup table's upkeep.
    addNetworkCost({ at, lamports, tx = "", why = "" }) {
      T.networkLamports += lamports;
      (data.costs ??= []).push({ at, lamports, tx, why });
    },

    // Mark pawns whose token balance went down since their buy.
    applyCheck(at, balances) {
      let sold = 0;
      data.pawns.forEach((p, i) => {
        const raw = balances[i];
        if (raw == null) return;
        p.lastRaw = raw;
        p.sold = raw < p.tokensRaw;
        if (p.sold) sold++;
      });
      data.check = { at, sold };
      return sold;
    },

    pushHistory(t) {
      data.history.push({ t, receivedLamports: T.receivedLamports, sentLamports: T.buysLamports + T.networkLamports, pawns: data.pawns.length });
    },

    // What the books say the router should hold.
    expectedRouterLamports() {
      return T.depositsLamports + T.receivedLamports - T.buysLamports - T.networkLamports - T.devLamports;
    }
  };
}
