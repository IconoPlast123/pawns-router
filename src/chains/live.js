import bs58 from "bs58";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { inspect, simulate, tokenAmount, PROGRAMS } from "./guard.js";
import { makePump } from "./pump.js";
import { log } from "../log.js";
import { sleep, toLamports, toSol } from "../util.js";

// The real world: Solana mainnet through RPC_URL. Every transaction is built here with pump.fun's official
// SDK, checked (inspect), simulated on the real chain, and only then signed with the router key.
const SIG_FEE = 5000;
const CU_LIMIT = 400_000;
const NO_BLOCKHASH = "11111111111111111111111111111111";

function parseSecret(s) {
  try {
    const bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s);
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error("ROUTER_SECRET_KEY illisible : colle la clé privée exportée de Phantom (base58) ou le tableau [..] d'un fichier keypair.");
  }
}

export function openLive(cfg) {
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  // Without the secret key (paused mode, rehearsal) the router can read and simulate, never sign.
  const signer = cfg.routerSecret ? parseSecret(cfg.routerSecret) : null;
  const router = { publicKey: signer ? signer.publicKey : new PublicKey(cfg.routerAddress) };
  const mint = new PublicKey(cfg.mint);
  const priorityLamports = toLamports(cfg.priorityFeeSol);
  const txFee = SIG_FEE + priorityLamports;
  let tokenProgram, decimals = 6, supplyRaw = 0, rent = 0, pump;

  const compile = (instructions) => new VersionedTransaction(new TransactionMessage({
    payerKey: router.publicKey, recentBlockhash: NO_BLOCKHASH,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(priorityLamports * 1e6 / CU_LIMIT) }),
      ...instructions
    ]
  }).compileToV0Message());

  // Fresh blockhash, then sign. The signature is known before anything is sent.
  async function sign(tx) {
    if (!signer) throw new Error("Pas de ROUTER_SECRET_KEY : ce mode ne peut rien signer.");
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.message.recentBlockhash = blockhash;
    tx.sign([signer]);
    return { signature: bs58.encode(tx.signatures[0]), blockhash, lastValidBlockHeight };
  }

  async function sendAndConfirm(tx, s) {
    await connection.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
    const res = await connection.confirmTransaction({ signature: s.signature, blockhash: s.blockhash, lastValidBlockHeight: s.lastValidBlockHeight }, "confirmed");
    const confirmed = await fetchTx(s.signature);
    if (res.value.err) {
      const e = new Error(`Transaction ${s.signature} en échec : ${JSON.stringify(res.value.err)}`);
      e.feeLamports = confirmed?.meta.fee ?? txFee;
      throw e;
    }
    return confirmed;
  }

  async function fetchTx(signature) {
    for (let i = 0; i < 10; i++) {
      const t = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (t) return t;
      await sleep(1500);
    }
    throw new Error(`Transaction ${signature} introuvable pour l'instant.`);
  }

  // Lamports an account gained (negative = lost) in a confirmed transaction, fees included.
  function deltaOf(confirmed, address) {
    const keys = confirmed.transaction.message.getAccountKeys({ accountKeysFromLookups: confirmed.meta.loadedAddresses });
    const i = keys.keySegments().flat().findIndex((k) => k.equals(address));
    return i < 0 ? 0 : confirmed.meta.postBalances[i] - confirmed.meta.preBalances[i];
  }

  // A confirmed pawn transaction, turned into the ledger's numbers. The pawn's token account rent, the
  // router's own token account rent (first pawn only) and the fee are network costs; the rest is the buy.
  function pawnResult(confirmed, p) {
    const fee = confirmed.meta.fee;
    const rentPaid = deltaOf(confirmed, new PublicKey(p.holderAta)) + deltaOf(confirmed, new PublicKey(p.routerAta));
    const spent = -deltaOf(confirmed, router.publicKey);
    return {
      wallet: p.holder, tokenAccount: p.holderAta, tokensRaw: Number(p.tokens),
      buyLamports: spent - fee - rentPaid, networkLamports: fee + rentPaid,
      at: (confirmed.blockTime ?? Date.now() / 1000) * 1000, tx: p.signature
    };
  }

  return {
    kind: "live",
    get decimals() { return decimals; },
    get supplyRaw() { return supplyRaw; },

    async init() {
      const info = await connection.getAccountInfo(mint);
      if (!info) throw new Error(`MINT ${cfg.mint} introuvable sur Solana.`);
      tokenProgram = info.owner;
      if (![PROGRAMS.token, PROGRAMS.token2022].includes(tokenProgram.toBase58())) throw new Error(`MINT ${cfg.mint} n'est pas un token.`);
      const supply = await connection.getTokenSupply(mint);
      decimals = supply.value.decimals;
      supplyRaw = Number(supply.value.amount);
      rent = await connection.getMinimumBalanceForRentExemption(tokenProgram.toBase58() === PROGRAMS.token2022 ? 170 : 165);
      pump = makePump(connection, mint, tokenProgram);
      const bc = await pump.curve();
      if (!bc.creator.equals(router.publicKey)) {
        log.warn(`Le créateur du coin est ${bc.creator.toBase58()}, pas le router : les creator fees n'arriveront pas au router.`);
      }
      if (bc.isMayhemMode) log.warn("Ce coin est en « mayhem mode » : non testé avec le router.");
      return { routerAddress: router.publicKey.toBase58() };
    },

    async routerLamports() { return connection.getBalance(router.publicKey, "confirmed"); },

    // Build, check and simulate the claim: sweep + collect every pump.fun creator fee owed to the router.
    async previewClaim() {
      const tx = compile(await pump.claim(router.publicKey));
      inspect(tx, router);
      const [r] = await simulate(connection, tx, [router.publicKey]);
      return { tx, gainLamports: r.delta };
    },

    async claim() {
      const { tx, gainLamports } = await this.previewClaim();
      // Nothing to claim, or not worth a transaction yet: a claim must pay for itself 10 times.
      if (gainLamports < 10 * txFee) return null;
      const s = await sign(tx);
      const confirmed = await sendAndConfirm(tx, s);
      const fee = confirmed.meta.fee;
      return { receivedLamports: deltaOf(confirmed, router.publicKey) + fee, feeLamports: fee, tx: s.signature };
    },

    // One pawn = one transaction: the token account rent and one transaction fee.
    costEstimate() { return { rentLamports: rent, networkLamports: txFee }; },
    // A buy can cost up to SLIPPAGE_PCT more than planned: keep that much in hand before starting one.
    reserveLamports(buyLamports) { return Math.ceil(buyLamports * cfg.slippagePct / 100); },

    // Build, check and simulate pawn #n (option C): buy, open the keyless pawn's token account, move the
    // tokens in, all in one transaction. The simulation runs on the real chain: the pawn must end up with
    // exactly the tokens bought, and the router can't lose more than the buy (+ slippage), the rents and the fee.
    async previewPawn(n, buyLamports) {
      const p = await pump.pawn(router.publicKey, n, buyLamports, cfg.slippagePct, decimals);
      const tx = compile(p.ixs);
      if (tx.serialize().length > 1232) throw new Error("Transaction de pawn trop grosse pour Solana.");
      inspect(tx, router);
      const [r, h] = await simulate(connection, tx, [router.publicKey, p.holderAta]);
      const got = tokenAmount(h.data);
      if (got.toString() !== p.tokens.toString()) throw new Error(`Simulation : le pawn recevrait ${got} tokens au lieu de ${p.tokens}.`);
      const owner = new PublicKey(h.data.subarray(32, 64));
      if (!owner.equals(p.holder) || PublicKey.isOnCurve(p.holder.toBytes())) throw new Error("Simulation : le compte du pawn n'appartient pas à une adresse sans clé. Refusé.");
      const ceiling = buyLamports * (1 + cfg.slippagePct / 100) + 3 * rent + txFee + 2_000_000;
      if (-r.delta > ceiling) throw new Error(`Simulation : le pawn coûterait ${toSol(-r.delta)} SOL, plafond ${toSol(ceiling)} SOL. Refusé.`);
      return { tx, p, costLamports: -r.delta };
    },

    async spawnPawn({ n, buyLamports, onPending }) {
      const { tx, p } = await this.previewPawn(n, buyLamports);
      const s = await sign(tx);
      const pending = {
        n, signature: s.signature, lastValidBlockHeight: s.lastValidBlockHeight, at: Date.now(),
        holder: p.holder.toBase58(), holderAta: p.holderAta.toBase58(), routerAta: p.routerAta.toBase58(), tokens: p.tokens.toString()
      };
      onPending(pending);
      const confirmed = await sendAndConfirm(tx, s);
      log.info(`Pawn #${n} acheté sur ${p.venue}.`);
      return pawnResult(confirmed, pending);
    },

    // After a crash or a timeout: did the pawn transaction land? Waits until its blockhash expires to be sure.
    // Returns { pawn } if it landed, { feeLamports } if it landed but failed, null if it never landed.
    async recoverPending(pending) {
      for (let i = 0; i < 60; i++) {
        const { value: [st] } = await connection.getSignatureStatuses([pending.signature], { searchTransactionHistory: true });
        if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
          const confirmed = await fetchTx(pending.signature);
          if (st.err) return { feeLamports: confirmed.meta.fee };
          return { pawn: pawnResult(confirmed, pending) };
        }
        if (!st && (await connection.getBlockHeight("confirmed")) > pending.lastValidBlockHeight) return null;
        await sleep(3000);
      }
      throw new Error(`statut de ${pending.signature} toujours inconnu`);
    },

    // Raw token balance of each pawn's token account (0 if the account is gone).
    async pawnBalances(pawns) {
      const out = [];
      for (let i = 0; i < pawns.length; i += 100) {
        const chunk = pawns.slice(i, i + 100).map((p) => new PublicKey(p.tokenAccount));
        const infos = await connection.getMultipleAccountsInfo(chunk, "confirmed");
        infos.forEach((a) => out.push(Number(tokenAmount(a?.data))));
      }
      return out;
    },

    async payDev(lamports) {
      const tx = compile([SystemProgram.transfer({ fromPubkey: router.publicKey, toPubkey: new PublicKey(cfg.devWallet), lamports })]);
      inspect(tx, router);
      const s = await sign(tx);
      const confirmed = await sendAndConfirm(tx, s);
      return { feeLamports: confirmed.meta.fee, tx: s.signature };
    }
  };
}
