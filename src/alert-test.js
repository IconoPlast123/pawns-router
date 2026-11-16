// Sends a test alert to your phone through healthchecks.io (README §12), without starting the router:
//   npm run alert-test
import { loadAlert } from "./config.js";
import { ping } from "./alert.js";

let a;
try { a = loadAlert(); } catch (e) { console.error("ERREUR " + e.message); process.exit(1); }
if (!a) {
  console.error("ERREUR Pas d'adresse d'alerte : remplis ALERT_URL_FILE dans .env et colle l'adresse de ton check dans ce fichier (README, section 12).");
  process.exit(1);
}
if (a.warning) console.log("ATTENTION " + a.warning + "\n");

try {
  // A sign of life first, so the check is "up": the alert right after is a real change, which healthchecks.io notifies.
  await ping(a, "", "Test de l'alerte : signe de vie.");
  console.log("1/2 Signe de vie envoyé : healthchecks.io voit le router « up ».");
  await new Promise((r) => setTimeout(r, 3000));
  await ping(a, "/fail", "TEST de l'alerte du router $PAWNS : si ce message arrive sur ton téléphone, l'alerte marche. Rien n'est cassé.");
  console.log("2/2 Alerte de test envoyée.\n");
  console.log("Regarde ton téléphone : un message Telegram « DOWN » doit arriver d'ici une minute.");
  console.log("Le check reste « down » tant que le router ne tourne pas : c'est normal. Au prochain démarrage du router");
  console.log("(paused ou live), un message « UP » arrivera.");
} catch (e) {
  console.error(`ÉCHEC : ${e.message}`);
  process.exit(1);
}
