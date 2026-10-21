import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
// "~\key.txt" = the key.txt file in the user's home folder.
const expandHome = (p) => (/^~(?=$|[\\/])/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);
// Inside a folder a cloud service copies? Windows gives OneDrive's root in %OneDrive%; others by folder name.
const syncRoots = [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial]
  .filter(Boolean).map((p) => path.resolve(p).toLowerCase() + path.sep);
const synced = (p) => {
  const full = path.resolve(p).toLowerCase();
  return syncRoots.some((root) => (full + path.sep).startsWith(root)) ||
    full.split(/[\\/]/).some((seg) => /^(onedrive|dropbox|google drive|icloud ?drive)( - .*)?$/.test(seg));
};

// A secret: from <NAME>_FILE (a file kept outside any synced folder), else <NAME> written in .env.
// Returns a warning when the secret sits in a folder that a cloud service copies.
function readSecret(name, fileName, label) {
  const keyFile = expandHome((process.env[fileName] ?? "").trim());
  if (keyFile) {
    let secret;
    try { secret = fs.readFileSync(keyFile, "utf8").trim(); }
    catch { throw new Error(`${fileName} : fichier introuvable (${keyFile}).`); }
    return { secret, warning: synced(keyFile) ? `${label} est dans ${keyFile}, un dossier synchronisé dans le cloud, qui en garde une copie. Range ce fichier ailleurs.` : "" };
  }
  const secret = (process.env[name] ?? "").trim();
  return { secret, warning: secret && synced(ROOT) ? `${label} est écrit dans .env, dans un dossier synchronisé dans le cloud, qui en garde une copie. Utilise plutôt ${fileName} (voir README).` : "" };
}

// Where the router publishes state.json for the public site (optional). The token can only edit gists.
export function loadGist() {
  const id = (process.env.STATE_GIST_ID ?? "").trim();
  if (!id) return null;
  const t = readSecret("STATE_GIST_TOKEN", "STATE_GIST_TOKEN_FILE", "Le token GitHub");
  if (!t.secret) throw new Error("STATE_GIST_ID est rempli mais il manque le token : remplis STATE_GIST_TOKEN_FILE (ou STATE_GIST_TOKEN) dans .env.");
  if (!/^[0-9a-f]{5,40}$/i.test(id)) throw new Error(`STATE_GIST_ID="${id}" ne ressemble pas à un identifiant de Gist (la suite de chiffres et de lettres à la fin de l'adresse du Gist).`);
  return {
    id, token: t.secret, warning: t.warning,
    everyMs: num("PUBLISH_EVERY_SEC", 60, { min: 10, max: 3600 }) * 1000,
    api: (process.env.GIST_API_URL ?? "").trim() || "https://api.github.com"
  };
}
const MODES = ["dry_run", "live", "paused"];

function num(name, def, { min = 0, max = Infinity } = {}) {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return def;
  const n = Number(raw.replace(",", "."));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name}="${raw}" n'est pas valide (attendu : un nombre entre ${min} et ${max}).`);
  return n;
}
const str = (name) => (process.env[name] ?? "").trim();
const file = (name, def) => path.resolve(ROOT, str(name) || def);

// What reading the real chain needs (live, paused, rehearsal).
export function checkReal(c) {
  if (!c.rpcUrl) throw new Error("RPC_URL est vide dans .env.");
  if (!c.mint) throw new Error("MINT est vide dans .env : mets l'adresse du coin $PAWNS.");
  if (!c.routerSecret && !c.routerAddress) throw new Error("Mets ROUTER_KEY_FILE (ou au moins ROUTER_ADDRESS, l'adresse publique du router) dans .env.");
}

export function loadConfig(argv = process.argv.slice(2)) {
  const fast = argv.includes("--fast");
  const mode = (str("MODE") || "dry_run").toLowerCase();
  if (!MODES.includes(mode)) throw new Error(`MODE="${mode}" inconnu. Choix possibles : ${MODES.join(", ")}.`);
  const real = mode !== "dry_run";
  let key = { secret: "", warning: "" };
  if (real) {
    // Only live signs: paused mode and the rehearsal can run on ROUTER_ADDRESS before the key file exists.
    try { key = readSecret("ROUTER_SECRET_KEY", "ROUTER_KEY_FILE", "La clé du router"); }
    catch (e) { if (mode === "live" || !str("ROUTER_ADDRESS")) throw e; }
  }
  // TEST_RUN=oui (from .env.test, see README): a side test on a throwaway coin. Fresh wallets buy every pawn,
  // so the 30 voices are never touched; its own ledger and log; nothing published online.
  const testRun = real && str("TEST_RUN").toLowerCase() === "oui";
  const world = real ? (testRun ? "test" : "live") : "dry_run";

  const c = {
    mode,
    real,
    fast,
    testRun,
    rpcUrl: str("RPC_URL"),
    routerSecret: key.secret,
    keyWarning: key.warning,
    routerAddress: str("ROUTER_ADDRESS"),
    mint: str("MINT"),
    liveConfirmed: str("LIVE_CONFIRMED").toLowerCase() === "oui",

    pawnUsd: num("PAWN_USD", 3, { min: 0.1, max: 1000 }),
    claimEveryMs: num("CLAIM_EVERY_MIN", 5, { min: 0.1 }) * 60_000,
    // Claim once the fees waiting in pump.fun are worth CLAIM_MIN_USD, or after CLAIM_MAX_WAIT_H anyway
    // (as long as they pay for at least one pawn).
    claimMinUsd: num("CLAIM_MIN_USD", 50, { min: 0 }),
    claimMaxWaitMs: num("CLAIM_MAX_WAIT_H", 24, { min: 0.1 }) * 3_600_000,
    // The dev's bag (public address only): shown on the site, read-only, the router never signs for it.
    devBagWallet: str("DEV_BAG_WALLET"),
    maxPawnsPerMin: num("MAX_PAWNS_PER_MIN", 30, { min: 1, max: 600 }),
    gasBufferSol: num("GAS_BUFFER_SOL", 0.01, { min: 0.002 }),
    checkEveryMs: num("CHECK_EVERY_MIN", 60, { min: 1 }) * 60_000,
    historyEveryMs: num("HISTORY_EVERY_MIN", 30, { min: 0.5 }) * 60_000,
    devSharePct: num("DEV_SHARE_PCT", 0, { min: 0, max: 100 }),
    devWallet: str("DEV_WALLET"),
    priorityFeeSol: num("PRIORITY_FEE_SOL", 0.00001, { min: 0, max: 0.01 }),
    slippagePct: num("SLIPPAGE_PCT", 10, { min: 0.5, max: 50 }),
    voices: {
      enabled: !testRun,
      keysFile: expandHome(str("VOICES_KEYS_FILE") || "~/pawns-voices-wallets.csv"),
      addressesFile: path.resolve(ROOT, expandHome(str("VOICES_ADDRESSES_FILE") || "../docs/voices-wallets.md")),
      keepPct: num("VOICE_KEEP_PCT", 1, { min: 0, max: 10 })
    },

    stateFile: file("STATE_FILE", "out/state.json"),
    previewPort: num("PREVIEW_PORT", 8787, { min: 0, max: 65535 }),
    siteFile: path.resolve(ROOT, "..", "index.html"),
    // Simulation, test and reality never share a ledger: their numbers can't leak into the live ledger.
    ledgerFile: path.resolve(ROOT, "data", `ledger-${world}.json`),
    simFile: path.resolve(ROOT, "data", "sim.json"),
    logFile: path.resolve(ROOT, "data", `router-${world}.log`),
    pauseFile: path.resolve(ROOT, "PAUSE"),

    sim: {
      volumeUsdPerHour: num("SIM_VOLUME_USD_PER_HOUR", 150000),
      creatorFeePct: num("SIM_CREATOR_FEE_PCT", 0.3, { max: 5 }),
      startMcapUsd: num("SIM_START_MCAP_USD", 8000, { min: 1000 }),
      fundingSol: num("SIM_FUNDING_SOL", 0.01, { min: 0 })
    },
    solUsdFallback: num("SOL_USD_FALLBACK", 190, { min: 1 })
  };

  // --fast: same router, shorter clocks, to watch a dry run move in a few minutes.
  if (fast) {
    if (real) throw new Error("--fast ne marche qu'en dry_run.");
    c.claimEveryMs = 20_000;
    c.claimMaxWaitMs = 120_000;
    c.historyEveryMs = 60_000;
    c.checkEveryMs = 120_000;
    c.sim.volumeUsdPerHour *= 8; // fees pile up faster, so the CLAIM_MIN_USD threshold is reached every minute or so
  }

  if (real && c.voices.enabled && synced(c.voices.keysFile)) c.keyWarning = [c.keyWarning, `Les clés des voix (${c.voices.keysFile}) sont dans un dossier synchronisé dans le cloud, qui en garde une copie. Range ce fichier ailleurs.`].filter(Boolean).join(" ");
  if (real) checkReal(c);
  if (mode === "live" && !c.routerSecret) throw new Error("Pas de clé du router : remplis ROUTER_KEY_FILE dans .env (obligatoire en live).");
  if (mode === "live" && !c.liveConfirmed) {
    throw new Error("Mode live bloqué : mets LIVE_CONFIRMED=oui dans .env, une fois le live validé.");
  }
  if (c.devSharePct > 0 && real && !c.devWallet) throw new Error("DEV_SHARE_PCT > 0 demande un DEV_WALLET.");
  if (c.devBagWallet && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c.devBagWallet)) throw new Error(`DEV_BAG_WALLET="${c.devBagWallet}" n'est pas une adresse Solana.`);
  return c;
}
