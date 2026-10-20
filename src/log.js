import fs from "node:fs";
import path from "node:path";

let file = "";
export function logTo(f) {
  file = f;
  fs.mkdirSync(path.dirname(f), { recursive: true });
}

function write(level, msg) {
  const d = new Date();
  const hh = d.toLocaleTimeString("fr-FR", { hour12: false });
  const line = `[${hh}] ${level === "warn" ? "ATTENTION " : level === "error" ? "ERREUR " : ""}${msg}`;
  (level === "error" ? console.error : console.log)(line);
  if (file) {
    try { fs.appendFileSync(file, d.toISOString() + " " + level.toUpperCase() + " " + msg + "\n"); } catch { /* the console line is enough */ }
  }
}

export const log = {
  info: (m) => write("info", m),
  warn: (m) => write("warn", m),
  error: (m) => write("error", m)
};
