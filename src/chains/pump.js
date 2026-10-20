import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";
import {
  OnlinePumpSdk, PUMP_SDK, bondingCurvePda, canonicalPumpPoolPda, isSolLikeQuoteMint,
  getBuyV3TokenAmountFromQuoteAmount, userVolumeAccumulatorPda as pumpUvaPda
} from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk, PUMP_AMM_SDK, buyQuoteInput, poolV2Pda, userVolumeAccumulatorPda as ammUvaPda } from "@pump-fun/pump-swap-sdk";
import { PROGRAMS } from "./guard.js";
import { ATA_PROGRAM, ataOf, pawnAddress } from "./pawn.js";

// pump.fun through its official SDKs (github.com/pump-fun/pump-sdk): only pump.fun's own programs
// ever see a signature. No third-party program, no third-party fee.

const TOKEN = new PublicKey(PROGRAMS.token);
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

export function createAtaIdempotent(payer, ata, owner, mint, tokenProgram) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false }
    ],
    data: Buffer.from([1])
  });
}

const syncNative = (account) => new TransactionInstruction({
  programId: TOKEN, keys: [{ pubkey: account, isSigner: false, isWritable: true }], data: Buffer.from([17])
});

// Close a token account: everything it holds in lamports (rent + wrapped SOL) goes to `destination`.
const closeAccount = (account, destination, owner) => new TransactionInstruction({
  programId: TOKEN,
  keys: [
    { pubkey: account, isSigner: false, isWritable: true },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: false }
  ],
  data: Buffer.from([9])
});

const lessSlippage = (bn, pct) => bn.muln(Math.round((100 - pct) * 100)).divn(10000);

export function makePump(connection, mint, tokenProgram) {
  const online = new OnlinePumpSdk(connection);
  const onlineAmm = new OnlinePumpAmmSdk(connection);
  let cache = { at: 0 };
  const uvaRent = {};

  async function config() {
    if (Date.now() - cache.at > 60_000) {
      const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
      cache = { at: Date.now(), global, feeConfig };
    }
    return cache;
  }

  async function curve() {
    const info = await connection.getAccountInfo(bondingCurvePda(mint), "confirmed");
    if (!info) throw new Error(`Pas de bonding curve pump.fun pour ${mint.toBase58()}.`);
    return PUMP_SDK.decodeBondingCurve(info);
  }

  // What a new "volume accumulator" account holds, measured once by simulation (nothing is sent).
  // pump.fun creates one per buyer; the router pays it, the buyer closes it and hands it back.
  async function measureUvaRent(kind, payer) {
    if (uvaRent[kind]) return uvaRent[kind];
    const probe = PublicKey.unique();
    const ix = kind === "pool"
      ? await PUMP_AMM_SDK.initUserVolumeAccumulator({ payer, user: probe })
      : await PUMP_SDK.initUserVolumeAccumulator({ payer, user: probe });
    const pda = kind === "pool" ? ammUvaPda(probe) : pumpUvaPda(probe);
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: [ix] }).compileToV0Message());
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { addresses: [pda.toBase58()], encoding: "base64" } });
    const lamports = sim.value.accounts?.[0]?.lamports;
    if (sim.value.err || !lamports) throw new Error(`Impossible de mesurer le compte « volume accumulator » (${JSON.stringify(sim.value.err)}).`);
    return (uvaRent[kind] = lamports);
  }

  return {
    curve,

    // Pawn #n in one all-or-nothing transaction, signed by the router (fee payer) and the buyer:
    //   the router hands the buyer exactly `lamports`, opens the pawn's token account (and, for a voice, the
    //   voice's own), pays the buyer's pump.fun volume accumulator;
    //   the buyer spends exactly that SOL ("exact SOL in" buys): the tokens land straight in the keyless pawn's
    //   token account, a voice's `keepPct` share in the voice's own account;
    //   the buyer closes its accumulator and its wrapped-SOL account, and everything goes back to the router.
    // A fresh buyer ends with 0 lamport and no token account. On the bonding curve while it runs, in the
    // canonical PumpSwap pool once the coin has graduated.
    async pawnPlan({ router, buyer, n, lamports, slippagePct, keepPct = 0 }) {
      const holder = pawnAddress(mint, n);
      const holderAta = ataOf(holder, mint, tokenProgram);
      const buyerAta = ataOf(buyer, mint, tokenProgram);
      const keep = keepPct > 0 ? Math.floor(lamports * keepPct / 100) : 0;
      const parts = keep > 0 ? [{ lamports: lamports - keep, dest: holderAta }, { lamports: keep, dest: buyerAta }] : [{ lamports, dest: holderAta }];
      const pre = [createAtaIdempotent(router, holderAta, holder, mint, tokenProgram)];
      if (keep > 0) pre.push(createAtaIdempotent(router, buyerAta, buyer, mint, tokenProgram));

      const st = await online.fetchBuyState(mint, buyer, tokenProgram);
      const bc = st.bondingCurve;
      if (!isSolLikeQuoteMint(bc.quoteMint)) throw new Error("Ce coin n'est pas coté en SOL : non pris en charge.");

      if (!bc.complete) {
        const uva = pumpUvaPda(buyer);
        const uvaExists = !!(await connection.getAccountInfo(uva, "confirmed"));
        const { global, feeConfig } = await config();
        const buys = [];
        for (const part of parts) {
          const expected = getBuyV3TokenAmountFromQuoteAmount({ global, feeConfig, mintSupply: bc.tokenTotalSupply, bondingCurve: bc, amount: new BN(part.lamports), curveBaseTokenBalance: st.curveBaseTokenBalance });
          if (expected.lten(0)) throw new Error("La bonding curve ne vend plus de tokens (migration en cours ?).");
          const ixs = await PUMP_SDK.buyExactQuoteInV3Instructions({
            bondingCurve: bc, associatedUserAccountInfo: {}, mint, user: buyer, amount: expected, quoteAmount: new BN(part.lamports),
            slippage: slippagePct, tokenProgram, quoteTokenProgram: st.quoteTokenProgram
          });
          if (ixs.length !== 1) throw new Error("Le SDK pump.fun a changé : achat inattendu, refusé.");
          const slot = ixs[0].keys.find((k) => k.pubkey.equals(buyerAta));
          if (!slot) throw new Error("Le SDK pump.fun a changé : compte de destination introuvable, refusé.");
          slot.pubkey = part.dest;
          buys.push({ ix: ixs[0], min: lessSlippage(expected, slippagePct) });
        }
        const rent = uvaExists ? 0 : await measureUvaRent("curve", router);
        return {
          venue: "bonding curve", holder, holderAta, buyerAta, keepAta: keep > 0 ? buyerAta : null,
          minPawnTokens: buys[0].min, buyerWsol: null, uvas: uvaExists ? [] : [uva],
          perPawn: [holder, holderAta, buyer, buyerAta, uva],
          ixs: [
            SystemProgram.transfer({ fromPubkey: router, toPubkey: buyer, lamports }),
            ...pre,
            ...(uvaExists ? [] : [await PUMP_SDK.initUserVolumeAccumulator({ payer: router, user: buyer })]),
            ...buys.map((b) => b.ix),
            ...(uvaExists ? [] : [await PUMP_SDK.closeUserVolumeAccumulator(buyer), SystemProgram.transfer({ fromPubkey: buyer, toPubkey: router, lamports: rent })])
          ]
        };
      }

      // Graduated: PumpSwap is quoted in wrapped SOL. The router wraps exactly `lamports` into the buyer's
      // WSOL account; closing that account afterwards sends whatever is left (and its rent) to the router.
      const s = await onlineAmm.swapSolanaState(canonicalPumpPoolPda(mint), buyer);
      if (s.pool.isCashbackCoin) throw new Error("Coin « cashback » : non pris en charge.");
      const buyerWsol = ataOf(buyer, WSOL, TOKEN);
      const wsolExists = !!s.userQuoteAccountInfo;
      const uva = ammUvaPda(buyer);
      const uvaExists = !!(await connection.getAccountInfo(uva, "confirmed"));
      const buys = [];
      for (const part of parts) {
        const { base } = buyQuoteInput({
          quote: new BN(part.lamports), slippage: slippagePct, baseReserve: s.poolBaseAmount, quoteReserve: s.poolQuoteAmount,
          virtualQuoteReserves: s.pool.virtualQuoteReserves, globalConfig: s.globalConfig, baseMintAccount: s.baseMintAccount,
          baseMint: s.baseMint, coinCreator: s.pool.coinCreator, creator: s.pool.creator, feeConfig: s.feeConfig,
          quoteMint: s.pool.quoteMint, isMayhemMode: s.pool.isMayhemMode, creatorFeeBps: s.pool.creatorFeeBps
        });
        const acc = PUMP_AMM_SDK.swapAccounts(s);
        acc.userBaseTokenAccount = part.dest;
        acc.userQuoteTokenAccount = buyerWsol;
        const rem = [];
        if (!s.pool.coinCreator.equals(PublicKey.default)) rem.push({ pubkey: poolV2Pda(s.pool.baseMint), isWritable: false, isSigner: false });
        rem.push({ pubkey: acc.buybackFeeRecipient, isWritable: false, isSigner: false }, { pubkey: acc.buybackFeeRecipientTokenAccount, isWritable: true, isSigner: false });
        const min = lessSlippage(base, slippagePct);
        const ix = await PUMP_AMM_SDK.offlineProgram.methods.buyExactQuoteIn(new BN(part.lamports), min, { 0: true }).accounts(acc).remainingAccounts(rem).instruction();
        buys.push({ ix, min });
      }
      const rent = uvaExists ? 0 : await measureUvaRent("pool", router);
      return {
        venue: "PumpSwap", holder, holderAta, buyerAta, keepAta: keep > 0 ? buyerAta : null,
        minPawnTokens: buys[0].min, buyerWsol, wsolExists, uvas: uvaExists ? [] : [uva],
        perPawn: [holder, holderAta, buyer, buyerAta, buyerWsol, uva],
        ixs: [
          createAtaIdempotent(router, buyerWsol, buyer, WSOL, TOKEN),
          SystemProgram.transfer({ fromPubkey: router, toPubkey: buyerWsol, lamports }),
          syncNative(buyerWsol),
          ...pre,
          ...(uvaExists ? [] : [await PUMP_AMM_SDK.initUserVolumeAccumulator({ payer: router, user: buyer })]),
          ...buys.map((b) => b.ix),
          ...(wsolExists ? [] : [closeAccount(buyerWsol, router, buyer)]),
          ...(uvaExists ? [] : [await PUMP_AMM_SDK.closeUserVolumeAccumulator(buyer), SystemProgram.transfer({ fromPubkey: buyer, toPubkey: router, lamports: rent })])
        ]
      };
    },

    // Instructions that pay every creator fee owed to `creator` into its wallet: first sweep the fees that
    // recent trades leave on the curve (and in the pool once graduated), then collect both vaults.
    async claim(creator) {
      const bc = await curve();
      const ixs = [];
      if (bc.creator.equals(creator) && bc.creatorFee.gtn(0)) {
        ixs.push(await PUMP_SDK.sweepCreatorFeeInstruction({ payer: creator, mint, creator, quoteMint: WSOL, quoteTokenProgram: TOKEN }));
      }
      if (bc.complete) {
        const pool = await onlineAmm.fetchPool(canonicalPumpPoolPda(mint)).catch(() => null);
        if (pool?.coinCreator.equals(creator)) {
          ixs.push(await PUMP_SDK.sweepPoolCreatorFeeInstruction({ payer: creator, mint, coinCreator: creator, quoteMint: WSOL, quoteTokenProgram: TOKEN }));
        }
      }
      ixs.push(...(await online.collectCoinCreatorFeeInstructions(creator, creator)));
      return ixs;
    }
  };
}
