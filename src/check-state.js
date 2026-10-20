// Checks a state.json against the contract in docs/decisions.md.
//   npm run check                         -> the file in STATE_FILE (out/state.json by default)
//   npm run check -- https://.../state.json  -> a published copy
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

const SHAPE = {
  top: ["mode", "updatedAt", "solUsd", "supply", "pawnUsd", "router", "fees", "pawns", "nextPawnSol", "history", "latest"],
  router: ["address", "sol"],
  fees: ["receivedSol", "buysSol", "networkSol", "devSol"],
  pawns: ["count", "tokens", "usd", "sold", "kept"],
  history: ["t", "receivedSol", "sentSol", "pawns"],
  latest: ["n", "wallet", "tokens", "usd", "sol", "at", "tx", "buyer", "kept"]
};
const MODES = ["preview", "dry_run", "live", "paused"];

const src = process.argv[2] || path.resolve(ROOT, (process.env.STATE_FILE || "").trim() || "out/state.json");
let raw;
try {
  raw = /^https?:/.test(src) ? await (await fetch(src, { cache: "no-store" })).text() : fs.readFileSync(src, "utf8");
} catch (e) {
  console.error(`ERREUR Impossible de lire ${src} : ${e.message}`);
  process.exit(1);
}

const errors = [], notes = [];
const fail = (m) => errors.push(m);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const keys = (obj, want, where) => {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return fail(`${where} doit être un objet.`);
  const have = Object.keys(obj);
  for (const k of want) if (!have.includes(k)) fail(`${where}.${k} manque.`);
  for (const k of have) if (!want.includes(k)) fail(`${where}.${k} n'est pas dans le format de decisions.md.`);
};
const nums = (obj, list, where, min = 0) => list.forEach((k) => { if (!isNum(obj?.[k]) || obj[k] < min) fail(`${where}.${k} doit être un nombre ≥ ${min}.`); });

let S;
try { S = JSON.parse(raw); } catch (e) { console.error(`ERREUR JSON invalide : ${e.message}`); process.exit(1); }

keys(S, SHAPE.top, "state");
if (!MODES.includes(S.mode)) fail(`mode "${S.mode}" inconnu (${MODES.join(", ")}).`);
if (typeof S.updatedAt !== "string" || Number.isNaN(Date.parse(S.updatedAt))) fail("updatedAt doit être une date ISO-8601.");
nums(S, ["solUsd", "supply", "pawnUsd", "nextPawnSol"], "state", 0);
keys(S.router, SHAPE.router, "router");
if (typeof S.router?.address !== "string") fail("router.address doit être un texte.");
nums(S.router, ["sol"], "router");
keys(S.fees, SHAPE.fees, "fees");
nums(S.fees, SHAPE.fees, "fees");
keys(S.pawns, SHAPE.pawns, "pawns");
nums(S.pawns, SHAPE.pawns, "pawns");
if (!Number.isInteger(S.pawns?.count) || !Number.isInteger(S.pawns?.sold)) fail("pawns.count et pawns.sold doivent être des entiers.");
if (S.pawns?.sold > S.pawns?.count) fail("pawns.sold ne peut pas dépasser pawns.count.");

if (!Array.isArray(S.history)) fail("history doit être une liste.");
else S.history.forEach((p, i) => {
  keys(p, SHAPE.history, `history[${i}]`);
  nums(p, SHAPE.history, `history[${i}]`);
  const prev = S.history[i - 1];
  if (prev && p.t <= prev.t) fail(`history[${i}] : les points doivent aller du plus ancien au plus récent.`);
  if (prev && (p.receivedSol < prev.receivedSol || p.sentSol < prev.sentSol || p.pawns < prev.pawns)) fail(`history[${i}] : les valeurs doivent être cumulées (jamais en baisse).`);
});
if (!Array.isArray(S.latest)) fail("latest doit être une liste.");
else {
  if (S.latest.length > 10) notes.push(`latest contient ${S.latest.length} pawns (decisions.md en prévoit ~10).`);
  S.latest.forEach((p, i) => {
    keys(p, SHAPE.latest, `latest[${i}]`);
    nums(p, ["n", "tokens", "usd", "sol", "at", "kept"], `latest[${i}]`);
    if (typeof p.wallet !== "string" || typeof p.tx !== "string" || typeof p.buyer !== "string") fail(`latest[${i}].wallet, .tx et .buyer doivent être des textes.`);
    if (p.buyer && p.buyer === p.wallet) fail(`latest[${i}] : l'acheteur ne peut pas être le pawn lui-même.`);
    if (p.n > 30 && p.kept > 0) fail(`latest[${i}] : seules les voix (pawns #1 à #30) gardent des tokens.`);
    const prev = S.latest[i - 1];
    if (prev && (p.n >= prev.n || p.at > prev.at)) fail(`latest[${i}] : du plus récent au plus ancien.`);
  });
}

// The books must add up: received = buys + network + dev + waiting, and waiting sits in the router.
if (!errors.length) {
  const F = S.fees, waiting = F.receivedSol - F.buysSol - F.networkSol - F.devSol;
  if (waiting < -1e-6) fail(`Les fees dépensées (${(F.buysSol + F.networkSol + F.devSol).toFixed(9)}) dépassent les fees reçues (${F.receivedSol}).`);
  const extra = S.router.sol - waiting;
  if (extra < -1e-6) fail(`Le router (${S.router.sol} SOL) contient moins que les fees en attente (${waiting.toFixed(9)} SOL).`);
  else notes.push(`En attente : ${waiting.toFixed(6)} SOL · router : ${S.router.sol} SOL · écart (buffer gas déposé) : ${extra.toFixed(6)} SOL.`);
  const lastH = S.history.at(-1);
  if (lastH && lastH.pawns !== S.pawns.count) fail(`Le dernier point de history (${lastH.pawns} pawns) ne correspond pas à pawns.count (${S.pawns.count}).`);
  if (S.latest.length && S.latest[0].n !== S.pawns.count) fail(`latest[0].n (${S.latest[0].n}) devrait être le dernier pawn (${S.pawns.count}).`);
  if (S.fees.devSol === 0) notes.push("Part dev : 0 SOL (100 % des fees vont aux pawns).");
}

// Nothing secret: a Solana private key is 64 bytes, i.e. ~88 base58 characters, or a list of 64 numbers.
// Transaction signatures (the "tx" fields) are 64 bytes too, and public: they are skipped.
(function scan(v, key) {
  if (typeof v === "string" && key !== "tx" && /^[1-9A-HJ-NP-Za-km-z]{80,}$/.test(v)) fail(`« ${key} » ressemble à une clé privée !`);
  else if (Array.isArray(v) && v.length === 64 && v.every((x) => Number.isInteger(x) && x >= 0 && x < 256)) fail(`« ${key} » ressemble à une clé privée (64 octets) !`);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) scan(x, Array.isArray(v) ? key : k);
})(S, "state");

console.log(`Fichier : ${src}`);
console.log(`Mode : ${S.mode} · mis à jour : ${S.updatedAt} · ${S.pawns?.count} pawns · ${S.history?.length} points de courbe`);
notes.forEach((n) => console.log("  " + n));
if (errors.length) {
  console.error(`\nNON VALIDE (${errors.length} problème${errors.length > 1 ? "s" : ""}) :`);
  errors.forEach((e) => console.error("  - " + e));
  process.exit(1);
}
console.log("\nVALIDE : le state.json respecte le format de docs/decisions.md.");
