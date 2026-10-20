import { round, toSol, writeJsonAtomic } from "./util.js";

const DAY = 86_400_000;
const sol = (lamports) => round(toSol(lamports), 9);

// Older than a week: one point every 6 hours is plenty, and keeps state.json light for visitors polling it.
function thin(points, now) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || p.t >= now - 7 * DAY || p.t - last.t >= 6 * 3_600_000) out.push(p);
  }
  return out;
}

// The public state.json, exactly in the shape of docs/decisions.md. No secret ever goes in here.
export function buildState({ mode, ledger, routerLamports, solUsd, pawnUsd, nextPawnLamports, now = Date.now() }) {
  const L = ledger.data, T = L.totals, unit = 10 ** L.decimals;
  const pawns = L.pawns;
  const sent = T.buysLamports + T.networkLamports;
  const points = thin(L.history, now);
  const tail = points[points.length - 1];
  if (!tail || tail.t < now) points.push({ t: now, receivedLamports: T.receivedLamports, sentLamports: sent, pawns: pawns.length });

  return {
    mode,
    updatedAt: new Date(now).toISOString(),
    solUsd: round(solUsd, 2),
    supply: L.supplyRaw ? round(L.supplyRaw / unit, 2) : 1e9,
    pawnUsd,
    router: { address: L.router, sol: sol(routerLamports) },
    fees: { receivedSol: sol(T.receivedLamports), buysSol: sol(T.buysLamports), networkSol: sol(T.networkLamports), devSol: sol(T.devLamports) },
    pawns: {
      count: pawns.length,
      tokens: round(pawns.reduce((s, p) => s + p.lastRaw, 0) / unit, 2),
      usd: round(pawns.reduce((s, p) => s + p.usd, 0), 2),
      sold: L.check.sold,
      kept: round(pawns.reduce((s, p) => s + (p.keptRaw ?? 0), 0) / unit, 2)
    },
    nextPawnSol: sol(nextPawnLamports),
    history: points.map((p) => ({ t: p.t, receivedSol: sol(p.receivedLamports), sentSol: sol(p.sentLamports), pawns: p.pawns })),
    // buyer: the wallet that bought this pawn (a Season 1 voice for #1-#30, then a fresh wallet);
    // kept: what that buyer kept (only voices, VOICE_KEEP_PCT, so they can comment on pump.fun).
    latest: pawns.slice(-10).reverse().map((p) => ({
      n: p.n, wallet: p.wallet, tokens: round(p.tokensRaw / unit, 2), usd: round(p.usd, 2), sol: sol(p.buyLamports), at: p.at, tx: p.tx,
      buyer: p.buyer ?? "", kept: round((p.keptRaw ?? 0) / unit, 2)
    }))
  };
}

export const writeState = (file, state) => writeJsonAtomic(file, state);
