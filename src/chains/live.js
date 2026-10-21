import bs58 from "bs58";
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  TransactionMessage, VersionedTransaction
} from "@solana/web3.js";
import { inspect, simulate, tokenAmount, PROGRAMS } from "./guard.js";
import { makePump } from "./pump.js";
import { VOICE_COUNT, forget, loadVoiceKeys, voiceAddresses } from "../voices.js";
import { log } from "../log.js";
import { sleep, toLamports, toSol } from "../util.js";

// The real world: Solana mainnet through RPC_URL. Every transaction is built here with pump.fun's official
// SDK, checked (inspect), simulated on the real chain, and only then signed.
const SIG_FEE = 5000;
const CU_LIMIT = 400_000;
const MAX_TX = 1232;
const NO_BLOCKHASH = "11111111111111111111111111111111";

function parseSecret(s) {
  try {
    const bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s);
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error("Clé du router illisible : colle la clé privée exportée de Phantom (base58) ou le tableau [..] d'un fichier keypair.");
  }
}

const fatal = (msg) => Object.assign(new Error(msg), { fatal: true });

export function openLive(cfg) {
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  // Without the secret key (paused mode, rehearsal) the router can read and simulate, never sign.
  const signer = cfg.routerSecret ? parseSecret(cfg.routerSecret) : null;
  const router = { publicKey: signer ? signer.publicKey : new PublicKey(cfg.routerAddress) };
  const mint = new PublicKey(cfg.mint);
  const priorityLamports = toLamports(cfg.priorityFeeSol);
  const txFee = SIG_FEE + priorityLamports;
  let tokenProgram, decimals = 6, supplyRaw = 0, rent = 0, pump;
  // Set by the router loop: where the lookup table's address is kept, and how extra costs are booked.
  let hooks = { lut: () => null, saveLut: () => {}, onCost: () => {} };

  const compile = (instructions, tables = []) => new VersionedTransaction(new TransactionMessage({
    payerKey: router.publicKey, recentBlockhash: NO_BLOCKHASH,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(priorityLamports * 1e6 / CU_LIMIT) }),
      ...instructions
    ]
  }).compileToV0Message(tables));

  // Fresh blockhash, then sign (router first: it pays the fee). The signature is known before anything is sent.
  async function sign(tx, others = []) {
    if (!signer) throw new Error("Pas de clé du router : ce mode ne peut rien signer.");
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.message.recentBlockhash = blockhash;
    tx.sign([signer, ...others]);
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

  const keysOf = (confirmed) => confirmed.transaction.message.getAccountKeys({ accountKeysFromLookups: confirmed.meta.loadedAddresses }).keySegments().flat();

  // Lamports an account gained (negative = lost) in a confirmed transaction, fees included.
  function deltaOf(confirmed, address) {
    const i = keysOf(confirmed).findIndex((k) => k.equals(new PublicKey(address)));
    return i < 0 ? 0 : confirmed.meta.postBalances[i] - confirmed.meta.preBalances[i];
  }
  // Raw tokens a token account gained in a confirmed transaction.
  function tokensGained(confirmed, address) {
    const i = keysOf(confirmed).findIndex((k) => k.equals(new PublicKey(address)));
    const amount = (list) => BigInt(list?.find((b) => b.accountIndex === i)?.uiTokenAmount.amount ?? 0);
    return i < 0 ? 0n : amount(confirmed.meta.postTokenBalances) - amount(confirmed.meta.preTokenBalances);
  }

  // A confirmed pawn transaction, turned into the ledger's numbers. Token account rents (the pawn's, and a
  // voice's the first time) and the fee are network costs; everything else the router paid is the buy.
  function pawnResult(confirmed, p) {
    const fee = confirmed.meta.fee;
    const rentPaid = deltaOf(confirmed, p.holderAta) + (p.keepAta ? deltaOf(confirmed, p.keepAta) : 0);
    const spent = -deltaOf(confirmed, router.publicKey);
    return {
      wallet: p.holder, tokenAccount: p.holderAta, buyer: p.buyer,
      tokensRaw: Number(tokensGained(confirmed, p.holderAta)), keptRaw: p.keepAta ? Number(tokensGained(confirmed, p.keepAta)) : 0,
      buyLamports: spent - fee - rentPaid, networkLamports: fee + rentPaid,
      at: (confirmed.blockTime ?? Date.now() / 1000) * 1000, tx: p.signature
    };
  }

  // A router-only transaction (lookup table upkeep): checked, simulated, signed, sent, its cost booked.
  async function routerTx(instructions, why) {
    const tx = compile(instructions);
    inspect(tx, router);
    await simulate(connection, tx, [router.publicKey]);
    const s = await sign(tx);
    const confirmed = await sendAndConfirm(tx, s);
    hooks.onCost({ lamports: -deltaOf(confirmed, router.publicKey), tx: s.signature, why });
    return confirmed;
  }

  async function lookupTable() {
    const address = hooks.lut();
    return address ? (await connection.getAddressLookupTable(new PublicKey(address))).value : null;
  }

  // The router's own address lookup table: created and extended only when a transaction is too big without
  // it (PumpSwap). It only lists public addresses, so a transaction fits in Solana's 1232 bytes.
  async function ensureTable(addresses) {
    let table = await lookupTable();
    const have = new Set(table?.state.addresses.map(String) ?? []);
    const missing = [...new Set(addresses.map(String))].filter((a) => !have.has(a)).map((a) => new PublicKey(a));
    if (!missing.length && table) return table;
    let address = table?.key;
    const chunks = [];
    for (let i = 0; i < missing.length; i += 20) chunks.push(missing.slice(i, i + 20));
    if (!address) {
      const [create, key] = AddressLookupTableProgram.createLookupTable({ authority: router.publicKey, payer: router.publicKey, recentSlot: await connection.getSlot("finalized") });
      const first = chunks.shift() ?? [];
      await routerTx([create, ...(first.length ? [AddressLookupTableProgram.extendLookupTable({ lookupTable: key, authority: router.publicKey, payer: router.publicKey, addresses: first })] : [])], "address lookup table created");
      address = key;
      hooks.saveLut(key.toBase58());
      log.info(`Table d'adresses créée : ${key.toBase58()}`);
    }
    for (const chunk of chunks) {
      await routerTx([AddressLookupTableProgram.extendLookupTable({ lookupTable: address, authority: router.publicKey, payer: router.publicKey, addresses: chunk })], "address lookup table extended");
    }
    // New addresses become usable one slot after they were added.
    for (let i = 0; i < 30; i++) {
      table = (await connection.getAddressLookupTable(address)).value;
      const now = await connection.getSlot("confirmed");
      if (table && missing.every((a) => table.state.addresses.some((b) => b.equals(a))) && now > table.state.lastExtendedSlot) return table;
      await sleep(1000);
    }
    throw new Error("La table d'adresses n'est pas encore active, nouvel essai plus tard.");
  }

  // Serialized size; web3.js refuses to serialize past the limit, so anything it refuses is "too big".
  function sizeOf(tx) {
    try { return tx.serialize().length; } catch { return Infinity; }
  }

  // Compile a pawn transaction. Without a table if it fits; else with the router's table, created or extended
  // when allowed (live), refused otherwise (rehearsal).
  async function compilePawn(plan, buyer, canExtend) {
    const plain = compile(plan.ixs);
    let table = await lookupTable();
    if (!table && sizeOf(plain) <= MAX_TX) return plain;
    let tx = table ? compile(plan.ixs, [table]) : plain;
    if (sizeOf(tx) <= MAX_TX) return tx;
    if (!canExtend) throw Object.assign(new Error("transaction trop grosse sans la table d'adresses du router (LUT), qu'il crée lui-même au premier pawn en live."), { needsTable: true });
    const msg = plain.message, skip = new Set([router.publicKey, buyer, ...plan.perPawn].map(String));
    const invoked = new Set(msg.compiledInstructions.map((ix) => msg.staticAccountKeys[ix.programIdIndex].toBase58()));
    table = await ensureTable(msg.staticAccountKeys.filter((k) => !skip.has(k.toBase58()) && !invoked.has(k.toBase58())));
    tx = compile(plan.ixs, [table]);
    if (sizeOf(tx) > MAX_TX) throw new Error("Transaction de pawn trop grosse même avec la table d'adresses.");
    return tx;
  }

  // Who buys pawn #n: voice #n for the first 30 (its key from VOICES_KEYS_FILE, checked against the public list),
  // then a brand-new wallet, made in memory, never written anywhere, forgotten after the transaction.
  // In a test run (voices off) every pawn gets a brand-new wallet.
  function buyerFor(n, needKey) {
    if (cfg.voices.enabled && n <= VOICE_COUNT) {
      if (!needKey) return { publicKey: new PublicKey(voiceAddresses(cfg.voices.addressesFile).get(n)), voice: true };
      let kp;
      try { kp = loadVoiceKeys(cfg.voices, [n]).get(n); }
      catch (e) { throw fatal(e.message); }
      return { keypair: kp, publicKey: kp.publicKey, voice: true };
    }
    const kp = Keypair.generate();
    return { keypair: kp, publicKey: kp.publicKey, voice: false };
  }

  return {
    kind: "live",
    get decimals() { return decimals; },
    get supplyRaw() { return supplyRaw; },
    attach(h) { hooks = { ...hooks, ...h }; },

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

    // Checks the voices' keys file against the public list. Throws with a clear message, never shows a key.
    checkVoices() { loadVoiceKeys(cfg.voices, []); },

    async routerLamports() { return connection.getBalance(router.publicKey, "confirmed"); },

    // Raw $PAWNS held by any wallet, across all its token accounts for the coin. Read-only.
    async tokensOf(owner) {
      const { value } = await connection.getTokenAccountsByOwner(new PublicKey(owner), { mint }, "confirmed");
      return value.reduce((sum, a) => sum + Number(tokenAmount(a.account.data)), 0);
    },
    // The router should hold no $PAWNS at all (the dev buy goes to DEV_BAG_WALLET). Pawns never use them.
    async routerTokens() { return this.tokensOf(router.publicKey); },
    // The dev's bag, shown on the site. Read-only: the router never signs anything for this wallet.
    async readDevBag() {
      if (!cfg.devBagWallet) return { address: "", tokensRaw: 0 };
      return { address: cfg.devBagWallet, tokensRaw: await this.tokensOf(cfg.devBagWallet) };
    },

    // Build, check and simulate the claim (sweep + collect every pump.fun creator fee owed to the router).
    // pendingLamports: what is waiting in pump.fun; worthIt: the claim pays for itself 10 times.
    async previewClaim() {
      const tx = compile(await pump.claim(router.publicKey));
      inspect(tx, router);
      const [r] = await simulate(connection, tx, [router.publicKey]);
      return { tx, gainLamports: r.delta, pendingLamports: Math.max(0, r.delta + txFee), worthIt: r.delta >= 10 * txFee };
    },

    // Sends a claim the router decided on (previewClaim, then the CLAIM_MIN_USD / CLAIM_MAX_WAIT_H rule).
    async claim({ tx }) {
      const s = await sign(tx);
      const confirmed = await sendAndConfirm(tx, s);
      const fee = confirmed.meta.fee;
      return { receivedLamports: deltaOf(confirmed, router.publicKey) + fee, feeLamports: fee, tx: s.signature };
    },

    // One pawn = one transaction with two signatures, plus the pawn's token account rent.
    costEstimate() { return { rentLamports: rent, networkLamports: 2 * SIG_FEE + priorityLamports }; },
    // Kept in hand before a pawn: a voice's own token account, opened by the router the first time.
    reserveLamports() { return rent; },

    // Build, check and simulate pawn #n on the real chain (nothing is sent). Refused unless the simulation shows:
    // the pawn's keyless account receiving the tokens; a fresh buyer left with 0 lamport and no account;
    // a voice keeping at most VOICE_KEEP_PCT of the tokens and no SOL; the router paying no more than planned.
    async previewPawn(n, buyLamports, buyer = buyerFor(n, false), canExtend = false) {
      const keepPct = buyer.voice ? cfg.voices.keepPct : 0;
      const plan = await pump.pawnPlan({ router: router.publicKey, buyer: buyer.publicKey, n, lamports: buyLamports, slippagePct: cfg.slippagePct, keepPct });
      const tx = await compilePawn(plan, buyer.publicKey, canExtend);
      inspect(tx, router, buyer.publicKey);
      const watch = [router.publicKey, buyer.publicKey, plan.holderAta, plan.buyerAta];
      const wsolAt = plan.buyerWsol ? watch.push(plan.buyerWsol) - 1 : -1;
      const uvaAt = plan.uvas.map((u) => watch.push(u) - 1);
      const res = await simulate(connection, tx, watch);
      const [r, b, h, k] = res;
      const refuse = (why) => { throw new Error(`Simulation : ${why}. Refusé.`); };

      const pawnTokens = tokenAmount(h.data);
      if (pawnTokens === 0n || pawnTokens < BigInt(plan.minPawnTokens.toString())) refuse(`le pawn recevrait ${pawnTokens} tokens (minimum ${plan.minPawnTokens})`);
      if (!new PublicKey(h.data.subarray(32, 64)).equals(plan.holder) || PublicKey.isOnCurve(plan.holder.toBytes())) refuse("le compte du pawn n'appartient pas à une adresse sans clé");
      if (b.delta !== 0) refuse(`l'acheteur finirait avec ${b.delta} lamports de plus ou de moins`);
      if (uvaAt.some((i) => res[i].after !== 0)) refuse("le compte « volume accumulator » de l'acheteur ne serait pas refermé");
      if (wsolAt >= 0 && (plan.wsolExists ? res[wsolAt].delta !== 0 : res[wsolAt].after !== 0)) refuse("il resterait du SOL dans le compte WSOL de l'acheteur");
      let kept = 0n;
      if (buyer.voice) {
        kept = tokenAmount(k.data) - tokenAmount(k.beforeData);
        // kept / (kept + pawn) must stay within VOICE_KEEP_PCT (plus one token unit of rounding)
        if (kept * 10000n > (kept + pawnTokens) * BigInt(Math.round(cfg.voices.keepPct * 100)) + 10000n) refuse(`la voix garderait ${kept} tokens, plus que ${cfg.voices.keepPct} %`);
      } else {
        if (b.after !== 0) refuse(`l'acheteur garderait ${b.after} lamports`);
        if (k.after !== 0) refuse("l'acheteur garderait un compte token");
      }
      const ceiling = buyLamports + 2 * rent + 2 * txFee + 2_000_000;
      if (-r.delta > ceiling) refuse(`le pawn coûterait ${toSol(-r.delta)} SOL au router, plafond ${toSol(ceiling)} SOL`);
      return { tx, plan, buyer, pawnTokens, kept, costLamports: -r.delta };
    },

    async spawnPawn({ n, buyLamports, onPending }) {
      const buyer = buyerFor(n, true);
      try {
        const { tx, plan } = await this.previewPawn(n, buyLamports, buyer, true);
        const s = await sign(tx, [buyer.keypair]);
        const pending = {
          n, signature: s.signature, lastValidBlockHeight: s.lastValidBlockHeight, at: Date.now(), buyer: buyer.publicKey.toBase58(),
          holder: plan.holder.toBase58(), holderAta: plan.holderAta.toBase58(), keepAta: plan.keepAta?.toBase58() ?? null
        };
        onPending(pending);
        const confirmed = await sendAndConfirm(tx, s);
        log.info(`Pawn #${n} acheté sur ${plan.venue} par ${buyer.voice ? `la voix #${n}` : "un wallet neuf"} (${buyer.publicKey.toBase58()}).`);
        return pawnResult(confirmed, pending);
      } finally {
        forget(buyer.keypair);
      }
    },

    // After a crash or a timeout: did the pawn transaction land? Waits until its blockhash expires to be sure.
    // Returns { pawn } if it landed, { feeLamports } if it landed but failed, null if it never landed.
    // A fresh buyer's key is not needed for this: a confirmed transaction leaves nothing in it.
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
