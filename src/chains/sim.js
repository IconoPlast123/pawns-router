import crypto from "node:crypto";
import { base58, readJson, writeJsonAtomic, toLamports } from "../util.js";
import { ataOf, pawnAddress } from "./pawn.js";

// dry_run world: a fake chain with fake creator fees and fake buys.
// Same interface as the live chain, so the router logic runs unchanged. Nothing here touches Solana.
// Pawns are computed exactly like in live (option C: keyless addresses), from a made-up mint.
const SIG_FEE = 5000;
const RENT_TOKEN_ACCOUNT = 1_513_840; // Token-2022 token account (170 bytes), mainnet rent in October 2026
const DECIMALS = 6;
const SUPPLY_RAW = 1e9 * 10 ** DECIMALS;
const PUMP_FEE = 0.0125; // pump.fun fee taken from each buy, roughly

const freshAddress = () => base58(crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32));
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

export function openSim(cfg, price) {
  const txFee = SIG_FEE + toLamports(cfg.priorityFeeSol);
  let S = readJson(cfg.simFile, null);
  let created = false;
  if (!S) {
    created = true;
    S = {
      router: freshAddress(),
      mint: freshAddress(),
      routerLamports: toLamports(cfg.sim.fundingSol),
      vaultLamports: 0,
      mcapUsd: cfg.sim.startMcapUsd,
      lastAccrualAt: Date.now(),
      balances: {}
    };
  }
  const save = () => writeJsonAtomic(cfg.simFile, S);

  // Creator fees pile up in the pump.fun vault as people trade. Volume is noisy, market cap wanders.
  function accrue() {
    const now = Date.now(), hours = (now - S.lastAccrualAt) / 3_600_000;
    S.lastAccrualAt = now;
    if (hours <= 0) return;
    const volumeUsd = cfg.sim.volumeUsdPerHour * hours * (0.3 + Math.random() * 1.4);
    S.vaultLamports += toLamports(volumeUsd * cfg.sim.creatorFeePct / 100 / price.usd);
    S.mcapUsd = Math.max(4000, S.mcapUsd * Math.exp(gauss() * 0.03 * Math.sqrt(hours * 12)));
  }

  return {
    kind: "dry_run",
    decimals: DECIMALS,
    supplyRaw: SUPPLY_RAW,

    async init() {
      if (created) save();
      return { routerAddress: S.router };
    },

    async routerLamports() { return S.routerLamports; },

    // Simulated dev bag: a made-up address holding 2 % of the supply (the dev buy), so the site can show it.
    async routerTokens() { return 0; },
    async readDevBag() {
      S.devBag ??= freshAddress();
      return { address: S.devBag, tokensRaw: Math.round(SUPPLY_RAW * 0.02) };
    },

    // Same shape as live: what waits in the (fake) pump.fun vault, and whether a claim pays for itself 10 times.
    async previewClaim() {
      accrue();
      save();
      return { pendingLamports: S.vaultLamports, gainLamports: S.vaultLamports - txFee, worthIt: S.vaultLamports >= 11 * txFee };
    },

    async claim() {
      const receivedLamports = S.vaultLamports;
      S.vaultLamports = 0;
      S.routerLamports += receivedLamports - txFee;
      save();
      return { receivedLamports, feeLamports: txFee, tx: "" };
    },

    // Per pawn, like live: the pawn's token account rent and one transaction with two signatures
    // (router + buyer).
    costEstimate() { return { rentLamports: RENT_TOKEN_ACCOUNT, networkLamports: txFee + SIG_FEE }; },

    // Like live: every pawn bought by a fresh wallet. Buyers here are made-up addresses, so the site can show them.
    async spawnPawn({ n, buyLamports }) {
      const { rentLamports, networkLamports } = this.costEstimate();
      const cost = buyLamports + rentLamports + networkLamports;
      if (S.routerLamports < cost) throw new Error("Router simulé à court de SOL.");
      const usdIn = buyLamports / 1e9 * price.usd * (1 - PUMP_FEE);
      const tokensRaw = Math.floor(usdIn / (S.mcapUsd / SUPPLY_RAW));
      const wallet = pawnAddress(S.mint, n).toBase58();
      const tokenAccount = ataOf(wallet, S.mint).toBase58();
      S.routerLamports -= cost;
      S.balances[tokenAccount] = tokensRaw;
      S.mcapUsd += usdIn;
      save();
      return { wallet, tokenAccount, buyer: freshAddress(), tokensRaw, buyLamports, networkLamports: rentLamports + networkLamports, tx: "" };
    },

    async pawnBalances(pawns) { return pawns.map((p) => S.balances[p.tokenAccount] ?? 0); },

    async payDev(lamports) {
      S.routerLamports -= lamports + txFee;
      save();
      return { feeLamports: txFee, tx: "" };
    }
  };
}
