import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import {
  OnlinePumpSdk, PUMP_SDK, bondingCurvePda, canonicalPumpPoolPda, isSolLikeQuoteMint,
  getBuyV3TokenAmountFromQuoteAmount, getBuyV3QuoteAmountFromTokenAmount
} from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk, PUMP_AMM_SDK, buyQuoteInput } from "@pump-fun/pump-swap-sdk";
import { PROGRAMS } from "./guard.js";
import { ATA_PROGRAM, ataOf, pawnAddress } from "./pawn.js";

// pump.fun through its official SDKs (github.com/pump-fun/pump-sdk): only pump.fun's own programs
// ever see the router's signature. No third-party program, no third-party fee.

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

export function transferChecked(source, mint, destination, owner, amount, decimals, tokenProgram) {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(BigInt(amount.toString()), 1);
  data[9] = decimals;
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false }
    ],
    data
  });
}

export function makePump(connection, mint, tokenProgram) {
  const online = new OnlinePumpSdk(connection);
  const onlineAmm = new OnlinePumpAmmSdk(connection);
  let cache = { at: 0 };
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

  return {
    curve,

    // Instructions that buy exactly `tokens` for about `lamports` (at most + slippage), into the user's token account.
    // On the bonding curve while it runs, in the canonical PumpSwap pool once the coin has graduated.
    async buy(user, lamports, slippagePct) {
      const quote = new BN(lamports);
      const st = await online.fetchBuyState(mint, user, tokenProgram);
      const bc = st.bondingCurve;
      if (!isSolLikeQuoteMint(bc.quoteMint)) throw new Error("Ce coin n'est pas coté en SOL : non pris en charge.");
      if (!bc.complete) {
        const { global, feeConfig } = await config();
        const q = { global, feeConfig, mintSupply: bc.tokenTotalSupply, bondingCurve: bc, curveBaseTokenBalance: st.curveBaseTokenBalance };
        const amount = getBuyV3TokenAmountFromQuoteAmount({ ...q, amount: quote });
        if (amount.lten(0)) throw new Error("La bonding curve ne vend plus de tokens (migration en cours ?).");
        const ixs = await PUMP_SDK.buyV3Instructions({
          bondingCurve: bc, associatedUserAccountInfo: st.associatedUserAccountInfo, mint, user, amount,
          quoteAmount: getBuyV3QuoteAmountFromTokenAmount({ ...q, amount }), slippage: slippagePct,
          tokenProgram, quoteTokenProgram: st.quoteTokenProgram
        });
        return { ixs, tokens: amount, venue: "bonding curve", userAtaExisted: !!st.associatedUserAccountInfo };
      }
      const poolKey = canonicalPumpPoolPda(mint);
      const s = await onlineAmm.swapSolanaState(poolKey, user);
      const { base } = buyQuoteInput({
        quote, slippage: slippagePct, baseReserve: s.poolBaseAmount, quoteReserve: s.poolQuoteAmount,
        virtualQuoteReserves: s.pool.virtualQuoteReserves, globalConfig: s.globalConfig, baseMintAccount: s.baseMintAccount,
        baseMint: s.baseMint, coinCreator: s.pool.coinCreator, creator: s.pool.creator, feeConfig: s.feeConfig,
        quoteMint: s.pool.quoteMint, isMayhemMode: s.pool.isMayhemMode, creatorFeeBps: s.pool.creatorFeeBps
      });
      const ixs = await PUMP_AMM_SDK.buyBaseInput(s, base, slippagePct);
      return { ixs, tokens: base, venue: "PumpSwap", userAtaExisted: !!s.userBaseAccountInfo };
    },

    // Pawn #n in one all-or-nothing transaction: the router buys exactly `tokens`, opens the pawn's token
    // account (rent paid by the router) and moves those tokens into it. If any step fails, nothing happens.
    async pawn(router, n, lamports, slippagePct, decimals) {
      const holder = pawnAddress(mint, n);
      const holderAta = ataOf(holder, mint, tokenProgram);
      const routerAta = ataOf(router, mint, tokenProgram);
      const b = await this.buy(router, lamports, slippagePct);
      return {
        ixs: [
          ...b.ixs,
          createAtaIdempotent(router, holderAta, holder, mint, tokenProgram),
          transferChecked(routerAta, mint, holderAta, router, b.tokens, decimals, tokenProgram)
        ],
        holder, holderAta, routerAta, tokens: b.tokens, venue: b.venue
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
