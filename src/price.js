import { log } from "./log.js";

const WSOL = "So11111111111111111111111111111111111111112";
const SOURCES = [
  { name: "Jupiter", url: `https://lite-api.jup.ag/price/v3?ids=${WSOL}`, read: (j) => j?.[WSOL]?.usdPrice },
  { name: "CoinGecko", url: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", read: (j) => j?.solana?.usd }
];

// SOL/USD from public price APIs. Keeps the last good price if they all fail.
// `fresh` tells the live router whether the price is recent enough to size a buy.
export function makePrice(fallback) {
  let last = 0, lastAt = 0, warned = false;
  async function refresh() {
    for (const s of SOURCES) {
      try {
        const r = await fetch(s.url, { signal: AbortSignal.timeout(8000) });
        const p = Number(s.read(await r.json()));
        if (r.ok && p > 1 && p < 100000) { last = p; lastAt = Date.now(); warned = false; return; }
      } catch { /* try the next source */ }
    }
    if (!warned) log.warn(`Prix du SOL indisponible, j'utilise ${last ? "le dernier connu" : "SOL_USD_FALLBACK"} : ${last || fallback} $.`);
    warned = true;
  }
  return {
    refresh,
    get usd() { return last || fallback; },
    get fresh() { return last > 0 && Date.now() - lastAt < 10 * 60_000; }
  };
}
