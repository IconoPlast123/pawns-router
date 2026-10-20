import fs from "node:fs";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

// The 30 Season 1 voices buy pawns #1 to #30, one each.
// Public addresses: docs/voices-wallets.md (VOICES_ADDRESSES_FILE). Private keys: a CSV kept outside any synced
// folder (VOICES_KEYS_FILE, columns voix,adresse,cle_privee), read only when needed. A key is never logged,
// copied or written anywhere: errors name the voice, never the key.
export const VOICE_COUNT = 30;

// "Pawn #07 | `address`" rows of the public list.
export function voiceAddresses(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { throw new Error(`Liste publique des voix introuvable (${file}).`); }
  const out = new Map();
  for (const m of text.matchAll(/Pawn #0*(\d+)\s*\|\s*`([1-9A-HJ-NP-Za-km-z]{32,44})`/g)) out.set(Number(m[1]), m[2]);
  for (let n = 1; n <= VOICE_COUNT; n++) if (!out.has(n)) throw new Error(`La liste publique des voix n'a pas d'adresse pour Pawn #${String(n).padStart(2, "0")}.`);
  return out;
}

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === "," || ch === ";") { cells.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

function keypairFrom(secret) {
  const bytes = secret.startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : bs58.decode(secret);
  return Keypair.fromSecretKey(bytes);
}

// Reads the keys file and checks every voice: its key must open the address written next to it, and that
// address must be the one published in docs. Returns the keypairs asked for (`only`), nothing else.
export function loadVoiceKeys({ keysFile, addressesFile }, only = []) {
  const published = voiceAddresses(addressesFile);
  let text;
  try { text = fs.readFileSync(keysFile, "utf8"); }
  catch { throw new Error(`Fichier des clés des voix introuvable (${keysFile}). Les pawns #1 à #${VOICE_COUNT} ne peuvent être achetés que par leurs voix : je m'arrête.`); }
  const rows = parseCsv(text);
  const head = rows[0].map((h) => h.toLowerCase());
  const col = { voix: head.indexOf("voix"), adresse: head.indexOf("adresse"), cle: head.indexOf("cle_privee") };
  if (Object.values(col).some((i) => i < 0)) throw new Error("Fichier des clés des voix : il faut les colonnes voix, adresse, cle_privee sur la première ligne.");
  const found = new Map();
  for (const r of rows.slice(1)) {
    const n = Number((r[col.voix] || "").match(/\d+/)?.[0]);
    if (!(n >= 1 && n <= VOICE_COUNT)) continue;
    let kp;
    try { kp = keypairFrom(r[col.cle] || ""); }
    catch { throw new Error(`Voix #${n} : clé privée illisible dans le fichier des clés.`); }
    const address = kp.publicKey.toBase58();
    if (address !== r[col.adresse]) throw new Error(`Voix #${n} : la clé privée n'ouvre pas l'adresse écrite à côté (${r[col.adresse]}).`);
    if (address !== published.get(n)) throw new Error(`Voix #${n} : l'adresse ${address} n'est pas celle publiée dans la liste des voix (${published.get(n)}).`);
    found.set(n, kp);
  }
  for (let n = 1; n <= VOICE_COUNT; n++) if (!found.has(n)) throw new Error(`Voix #${n} absente du fichier des clés.`);
  const out = new Map(only.map((n) => [n, found.get(n)]));
  for (const [n, kp] of found) if (!out.has(n)) forget(kp);
  return out;
}

// Overwrite a key in memory once it has done its job (web3.js keeps it in _keypair).
export function forget(kp) {
  try { kp?._keypair?.secretKey?.fill(0); } catch { /* best effort */ }
}
