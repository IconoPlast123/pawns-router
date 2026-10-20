// Sends state.json to the Gist once, prints the raw URL for the site's CONFIG.STATE_URL, then reads it back.
//   npm run publish-test
import fs from "node:fs";
import { loadConfig, loadGist } from "./config.js";
import { openLedger } from "./ledger.js";
import { buildState } from "./state.js";
import { rawUrl, sendToGist } from "./publish.js";

let cfg, gist;
try {
  cfg = loadConfig();
  gist = loadGist();
} catch (e) { console.error("ERREUR " + e.message); process.exit(1); }
if (!gist) {
  console.error("ERREUR STATE_GIST_ID est vide dans .env. Suis l'étape « Publier le state.json en ligne » du README.");
  process.exit(1);
}
if (gist.warning) console.log("ATTENTION " + gist.warning + "\n");

// The router's latest state.json if it exists, else the current ledger's state (empty before the first run).
let state, source;
try {
  state = JSON.parse(fs.readFileSync(cfg.stateFile, "utf8"));
  source = cfg.stateFile;
} catch {
  const ledger = openLedger(cfg.ledgerFile, cfg.real ? "live" : "dry_run");
  state = buildState({ mode: cfg.mode, ledger, routerLamports: 0, solUsd: cfg.solUsdFallback, pawnUsd: cfg.pawnUsd, nextPawnLamports: 0 });
  source = "état vide (le router n'a pas encore tourné dans ce mode)";
}

console.log(`Envoi de : ${source}`);
let r;
try { r = await sendToGist(gist, state); }
catch (e) { console.error(`ÉCHEC : ${e.message}`); process.exit(1); }

const url = rawUrl(r.owner, gist.id);
console.log("\nENVOYÉ. Adresse à mettre dans le site (CONFIG.STATE_URL) :\n");
console.log("  " + url + "\n");
if (!r.public) console.log("ATTENTION ce Gist est secret. Le site le lira quand même, mais un Gist public est plus transparent.\n");

// Read it back the way the site does (a unique query parameter skips GitHub's 5-minute cache).
try {
  const back = await (await fetch(`${url}?t=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(15000) })).json();
  console.log(back.updatedAt === state.updatedAt
    ? `Vérifié : la copie en ligne est à jour (mode ${back.mode}, ${back.pawns?.count ?? 0} pawns).`
    : "Envoyé, mais GitHub sert encore l'ancienne version : réessaie dans une minute.");
} catch { console.log("Envoyé, mais la relecture a échoué : ouvre l'adresse ci-dessus dans ton navigateur pour vérifier."); }
