// Rehearsal: with the real settings (.env), build, check and simulate on mainnet the next claim and the
// next pawn, exactly as live would. Nothing is signed, nothing is sent.
//   npm run rehearse
process.env.MODE = "paused"; // read-only settings: no LIVE_CONFIRMED needed, nothing can be signed here
const { loadConfig } = await import("./config.js");
const { readJson, toLamports, toSol } = await import("./util.js");
const { makePrice } = await import("./price.js");
const { pawnAddress } = await import("./chains/pawn.js");

let cfg;
try { cfg = loadConfig(); } catch (e) { console.error("ERREUR " + e.message); process.exit(1); }
if (cfg.testRun) console.log("TEST · coin d'essai, ledger à part.\n");
if (cfg.keyWarning) console.log("ATTENTION " + cfg.keyWarning + "\n");
if (!cfg.routerAddress) {
  const { Keypair } = await import("@solana/web3.js");
  const bs58 = (await import("bs58")).default;
  const s = cfg.routerSecret;
  try { cfg.routerAddress = Keypair.fromSecretKey(s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s)).publicKey.toBase58(); }
  catch { console.error("ERREUR clé du router illisible : colle la clé privée exportée de Phantom (base58)."); process.exit(1); }
}
cfg.routerSecret = ""; // the rehearsal never needs the key: only the public address goes further

const { openLive } = await import("./chains/live.js");
const price = makePrice(cfg.solUsdFallback);
await price.refresh();
const chain = openLive(cfg);
let ok = true;
try {
  await chain.init();
} catch (e) { console.error("ERREUR " + e.message); process.exit(1); }

const balance = await chain.routerLamports();
console.log(`Router : ${cfg.routerAddress} · ${toSol(balance)} SOL`);
if (balance === 0) {
  console.error("ERREUR Le router est vide : envoie-lui du SOL (le buffer gas) avant la répétition.");
  process.exit(1);
}
console.log(`Coin : ${cfg.mint} · SOL à ${price.usd} $${price.fresh ? "" : " (prix de secours !)"}\n`);

const live = readJson(cfg.ledgerFile, null);
try {
  const c = await chain.previewClaim();
  const usd = toSol(c.pendingLamports) * price.usd;
  if (c.gainLamports <= 0) console.log("CLAIM  OK · rien à réclamer pour l'instant (normal tant que personne n'a tradé).");
  else {
    console.log(`CLAIM  OK · ${toSol(c.pendingLamports)} SOL en attente dans pump.fun (≈ ${usd.toFixed(2)} $).`);
    console.log(usd >= cfg.claimMinUsd && c.worthIt
      ? `         Le router réclamerait maintenant (seuil ${cfg.claimMinUsd} $ atteint).`
      : `         Le router attend ${cfg.claimMinUsd} $, ou ${cfg.claimMaxWaitMs / 3_600_000} h après le dernier claim si ça paie au moins un pawn.`);
  }
} catch (e) { ok = false; console.log(`CLAIM  ÉCHEC · ${e.message}`); }

// The router keeps no $PAWNS (the dev buy goes to DEV_BAG_WALLET); the dev's bag is only read.
try {
  const held = await chain.routerTokens();
  const ui = (raw) => (raw / 10 ** chain.decimals).toLocaleString("fr-FR");
  if (held) { ok = false; console.log(`ROUTER ATTENTION · il détient ${ui(held)} $PAWNS : transfère-les vers DEV_BAG_WALLET. Le mode live refusera de démarrer.`); }
  else console.log("ROUTER OK · aucun $PAWNS dans le router.");
  const d = await chain.readDevBag();
  console.log(d.address ? `DEV    OK · sac du dev ${d.address} : ${ui(d.tokensRaw)} $PAWNS (lecture seule).` : "DEV    · DEV_BAG_WALLET vide : le site n'affichera pas de sac du dev.");
} catch (e) { ok = false; console.log(`ROUTER ÉCHEC · lecture des soldes $PAWNS impossible : ${e.message}`); }

chain.attach({ lut: () => live?.lut ?? null });
const n = (live?.pawns?.length ?? 0) + 1;

// The next pawn, bought by a brand-new wallet like every pawn.
const buyLamports = toLamports(cfg.pawnUsd / price.usd);
const est = chain.costEstimate();
const need = buyLamports + est.rentLamports + est.networkLamports;
const ui = (raw) => (Number(raw) / 10 ** chain.decimals).toLocaleString("fr-FR");
if (balance < need) {
  console.log(`PAWN   #${n} pas testable pour l'instant · le router a ${toSol(balance)} SOL, un pawn en demande environ ${toSol(need)}.`);
  console.log("         Relance « npm run rehearse » quand les premières creator fees sont réclamées.");
} else {
  try {
    const r = await chain.previewPawn(n, buyLamports);
    const size = r.tx.serialize().length, lut = r.tx.message.addressTableLookups.length ? ", avec la table d'adresses" : "";
    console.log(`PAWN   OK · pawn #${n} = ${r.plan.holder.toBase58()} (adresse sans clé, recalculée : ${pawnAddress(cfg.mint, n).equals(r.plan.holder)})`);
    console.log(`         acheteur : un wallet neuf ${r.buyer.publicKey.toBase58()}`);
    console.log(`         achat sur ${r.plan.venue} : ${ui(r.pawnTokens)} $PAWNS dans le pawn, acheteur vidé à 0`);
    console.log(`         coût pour le router ${toSol(r.costLamports)} SOL · transaction de ${size} octets, 2 signatures${lut}`);
  } catch (e) {
    if (e.needsTable) {
      console.log(`PAWN   #${n} pas simulable ici · ${e.message}`);
      console.log("         Chaque pawn reste simulé sur la vraie chaîne juste avant son envoi.");
    } else { ok = false; console.log(`PAWN   #${n} ÉCHEC · ${e.message}`); }
  }
}

console.log(ok ? "\nRépétition réussie : rien n'a été envoyé." : "\nRépétition avec erreurs : rien n'a été envoyé.");
process.exit(ok ? 0 : 1);
