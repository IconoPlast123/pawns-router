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

try {
  const c = await chain.previewClaim();
  console.log(c.gainLamports > 0
    ? `CLAIM  OK · le router gagnerait ${toSol(c.gainLamports)} SOL (frais déduits).`
    : "CLAIM  OK · rien à réclamer pour l'instant (normal tant que personne n'a tradé).");
} catch (e) { ok = false; console.log(`CLAIM  ÉCHEC · ${e.message}`); }

const live = readJson(cfg.ledgerFile, null);
chain.attach({ lut: () => live?.lut ?? null });
const n = (live?.pawns?.length ?? 0) + 1;

// Pawns #1-#30 are bought by the voices: their keys file must open the published addresses.
if (n <= 30) {
  try { chain.checkVoices(); console.log("VOIX   OK · les 30 clés ouvrent les adresses publiées des voix (aucune clé affichée)."); }
  catch (e) { ok = false; console.log(`VOIX   ÉCHEC · ${e.message}`); }
}

// The next pawn, and while voices are still buying, also a pawn bought by a fresh wallet (#31 and after).
const buyLamports = toLamports(cfg.pawnUsd / price.usd);
const est = chain.costEstimate();
const need = buyLamports + chain.reserveLamports(buyLamports) + 2 * est.rentLamports + 2 * est.networkLamports;
const ui = (raw) => (Number(raw) / 10 ** chain.decimals).toLocaleString("fr-FR");
for (const k of n <= 30 ? [n, 31] : [n]) {
  if (balance < need) {
    console.log(`PAWN   #${k} pas testable pour l'instant · le router a ${toSol(balance)} SOL, un pawn en demande environ ${toSol(need)}.`);
    console.log("         Relance « npm run rehearse » quand les premières creator fees sont réclamées.");
    break;
  }
  try {
    const r = await chain.previewPawn(k, buyLamports);
    const size = r.tx.serialize().length, lut = r.tx.message.addressTableLookups.length ? ", avec la table d'adresses" : "";
    console.log(`PAWN   OK · pawn #${k} = ${r.plan.holder.toBase58()} (adresse sans clé, recalculée : ${pawnAddress(cfg.mint, k).equals(r.plan.holder)})`);
    console.log(`         acheteur : ${r.buyer.voice ? `la voix #${k}` : "un wallet neuf"} ${r.buyer.publicKey.toBase58()}`);
    console.log(`         achat sur ${r.plan.venue} : ${ui(r.pawnTokens)} $PAWNS dans le pawn${r.buyer.voice ? `, ${ui(r.kept)} gardés par la voix` : ", acheteur vidé à 0"}`);
    console.log(`         coût pour le router ${toSol(r.costLamports)} SOL · transaction de ${size} octets, 2 signatures${lut}`);
  } catch (e) {
    if (e.needsTable) {
      console.log(`PAWN   #${k} pas simulable ici · ${e.message}`);
      console.log("         Chaque pawn reste simulé sur la vraie chaîne juste avant son envoi.");
    } else { ok = false; console.log(`PAWN   #${k} ÉCHEC · ${e.message}`); }
  }
}

console.log(ok ? "\nRépétition réussie : rien n'a été envoyé." : "\nRépétition avec erreurs : rien n'a été envoyé.");
process.exit(ok ? 0 : 1);
