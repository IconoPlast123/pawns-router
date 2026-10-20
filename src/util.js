import fs from "node:fs";
import path from "node:path";

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const toSol = (lamports) => Math.round(lamports) / LAMPORTS_PER_SOL;
export const toLamports = (sol) => Math.round(sol * LAMPORTS_PER_SOL);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return fallback; throw new Error(`Fichier illisible : ${file} (${e.message})`); }
}

// Write to a temp file, then rename over the target, so a reader never sees half a file.
// Synced folders (OneDrive) sometimes lock the target for a moment: retry, then fall back to a plain write.
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(data);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, body);
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1));
    }
  }
  fs.writeFileSync(file, body);
  fs.rmSync(tmp, { force: true });
}
