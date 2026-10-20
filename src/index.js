import fs from "node:fs";
import { loadConfig, loadGist } from "./config.js";
import { log, logTo } from "./log.js";
import { openLedger } from "./ledger.js";
import { makePrice } from "./price.js";
import { makePublisher } from "./publish.js";
import { buildState, writeState } from "./state.js";
import { startPreview } from "./server.js";
import { round, sleep, toLamports, toSol } from "./util.js";

let cfg;
try { cfg = loadConfig(); }
catch (e) { console.error("ERREUR " + e.message); process.exit(1); }
logTo(cfg.logFile);

const BANNER = {
  dry_run: "Mode DRY RUN : simulation. Aucune transaction n'est envoyée, les chiffres sont faux.",
  live: "Mode LIVE : vrais claims, vrais achats.",
  paused: "Mode PAUSED : lecture seule. Le router publie l'état et revérifie les pawns, il n'envoie rien."
};
log.info(BANNER[cfg.mode] + (cfg.fast ? " Horloges accélérées (--fast)." : ""));
if (cfg.keyWarning) log.warn(cfg.keyWarning);

// Public copy of state.json on a GitHub Gist (optional). A problem here never stops the router.
let publisher = null;
try {
  const gist = loadGist();
  if (gist) {
    if (gist.warning) log.warn(gist.warning);
    publisher = makePublisher(gist);
    log.info(`Publication en ligne activée : Gist ${gist.id}, au plus une fois toutes les ${gist.everyMs / 1000} s.`);
  }
} catch (e) { log.error(`Publication en ligne désactivée : ${e.message}`); }

// Startup problems (bad key, RPC down, unknown mint...) end with one clear line, not a stack trace.
async function must(step) {
  try { return await step(); }
  catch (e) { log.error(e.message); process.exit(1); }
}

const price = makePrice(cfg.solUsdFallback);
await price.refresh();

const chain = await must(async () => cfg.real
  ? (await import("./chains/live.js")).openLive(cfg, price)
  : (await import("./chains/sim.js")).openSim(cfg, price));
const ledger = await must(() => openLedger(cfg.ledgerFile, cfg.real ? "live" : "dry_run"));
const L = ledger.data;

const { routerAddress } = await must(() => chain.init());
if (!L.router) {
  L.router = routerAddress;
  L.decimals = chain.decimals;
  L.supplyRaw = chain.supplyRaw;
  ledger.pushHistory(Date.now());
  ledger.save();
} else if (L.router !== routerAddress) {
  log.error(`Le ledger (${cfg.ledgerFile}) appartient au router ${L.router}, pas à ${routerAddress}.` +
    (cfg.real ? " Vérifie ROUTER_SECRET_KEY." : " Lance « npm run reset-dry-run » pour repartir de zéro."));
  process.exit(1);
}
function recordPawn(r) {
  const pawn = ledger.addPawn({
    wallet: r.wallet, tokenAccount: r.tokenAccount, buyer: r.buyer, tokensRaw: r.tokensRaw, keptRaw: r.keptRaw ?? 0,
    buyLamports: r.buyLamports, networkLamports: r.networkLamports,
    usd: round(toSol(r.buyLamports) * price.usd, 4), at: r.at ?? Date.now(), tx: r.tx
  });
  const ui = (raw) => Math.round(raw / 10 ** L.decimals).toLocaleString("fr-FR");
  const kept = pawn.keptRaw ? ` (la voix en garde ${ui(pawn.keptRaw)})` : "";
  log.info(`Pawn #${pawn.n} : ${ui(r.tokensRaw)} $PAWNS pour ${toSol(r.buyLamports).toFixed(4)} SOL${kept} · pawn ${r.wallet} · acheteur ${r.buyer}${solscan(r.tx)}`);
}
function solscan(tx) { return tx ? ` · https://solscan.io/tx/${tx}` : ""; }

// Live only: where the router keeps its address lookup table, and how its upkeep is booked (network costs).
chain.attach?.({
  lut: () => L.lut ?? null,
  saveLut: (address) => { L.lut = address; ledger.save(); },
  onCost: ({ lamports, tx, why }) => {
    ledger.addNetworkCost({ at: Date.now(), lamports, tx, why });
    ledger.save();
    log.info(`Coût réseau : ${toSol(lamports)} SOL (${why}).${solscan(tx)}`);
  }
});

// Pawns #1 to #30 are bought by the 30 voices: check their keys file before anything else.
if (cfg.real && L.pawns.length < 30 && chain.checkVoices) {
  try { chain.checkVoices(); log.info("Clés des voix vérifiées : chaque clé ouvre l'adresse publiée de sa voix."); }
  catch (e) {
    if (cfg.mode === "live") { log.error(`${e.message} Les pawns #1 à #30 ne peuvent être achetés que par leurs voix : le router s'arrête.`); process.exit(1); }
    log.warn(e.message);
  }
}

// A pawn whose transaction was sent but not confirmed when something went wrong:
// ask the chain whether it landed, and book it if it did. If we can't tell, stay stopped.
async function settlePending() {
  if (!L.pending) return true;
  if (!chain.recoverPending) { L.pending = null; ledger.save(); return true; }
  try {
    const r = await chain.recoverPending(L.pending);
    if (r?.pawn) recordPawn(r.pawn);
    else if (r?.feeLamports) {
      ledger.addNetworkCost({ at: Date.now(), lamports: r.feeLamports, tx: L.pending.signature, why: "pawn transaction failed on-chain" });
      log.warn(`Le pawn #${L.pending.n} a échoué on-chain : seuls les frais (${toSol(r.feeLamports)} SOL) sont partis.`);
    } else log.info(`Le pawn #${L.pending.n} n'est jamais passé : rien n'a été dépensé.`);
    L.pending = null;
    ledger.save();
    return true;
  } catch (e) {
    log.error(`Impossible de savoir si le dernier pawn est passé (${e.message}). Relance le router plus tard : il revérifiera.`);
    return false;
  }
}

if (L.pending) {
  log.warn("Un pawn était en cours au dernier arrêt : je vérifie où il en est.");
  if (!(await settlePending())) process.exit(1);
}
log.info(`Router : ${routerAddress} · ${L.pawns.length} pawns au compteur.`);

const t = {
  routerLamports: 0, lastBalanceAt: 0, lastPriceAt: Date.now(), lastClaimAt: 0, lastPawnAt: 0,
  lastCheckAt: L.check.at || 0, lastWriteAt: 0, failures: 0, halted: false, stopping: false, warned: {},
  claim: { pendingLamports: 0, checkedAt: null },
  dev: { address: cfg.devBagWallet, tokensRaw: 0, checkedAt: null }
};
const uiTokens = (raw) => Math.round(raw / 10 ** L.decimals).toLocaleString("fr-FR");

// The dev's bag (DEV_BAG_WALLET), shown on the site. Read-only, at startup and with every hourly check.
async function refreshDevBag() {
  try {
    const d = await chain.readDevBag();
    t.dev = { address: d.address, tokensRaw: d.tokensRaw, checkedAt: Date.now() };
  } catch (e) { log.warn(`Sac du dev illisible pour l'instant : ${e.message}`); }
}

// The router keeps no $PAWNS (thesis 08): the dev buy belongs in DEV_BAG_WALLET. Pawns never touch the router's
// token account and the ledger only counts SOL, so a balance there is harmless, but it must not stay.
async function checkRouterTokens(atStart) {
  if (!cfg.real) return;
  const held = await chain.routerTokens();
  if (!held) { clearWarn("routerTokens"); return; }
  const msg = `Le router détient ${uiTokens(held)} $PAWNS, sans doute le dev buy : transfère-les vers DEV_BAG_WALLET${cfg.devBagWallet ? ` (${cfg.devBagWallet})` : ""} avant de démarrer ; les pawns n'en ont pas besoin.`;
  if (atStart && cfg.mode === "live") { log.error(msg + " Le mode live refuse de démarrer tant que c'est le cas."); process.exit(1); }
  warnOnce("routerTokens", msg);
}
const spacingMs = 60_000 / cfg.maxPawnsPerMin;
const bufferLamports = toLamports(cfg.gasBufferSol);
const isPaused = () => cfg.mode === "paused" || t.halted || fs.existsSync(cfg.pauseFile);
const warnOnce = (key, msg) => { if (!t.warned[key]) log.warn(msg); t.warned[key] = true; };
const clearWarn = (key) => { t.warned[key] = false; };

try { await checkRouterTokens(true); }
catch (e) { if (cfg.mode === "live") { log.error(`Solde $PAWNS du router illisible (${e.message}) : le mode live ne démarre pas sans cette vérification.`); process.exit(1); } log.warn(`Solde $PAWNS du router illisible : ${e.message}`); }
await refreshDevBag();
t.lastDevAt = Date.now();

// What one pawn costs right now: $PAWN_USD in SOL, plus the token account rent and the network fees.
function pawnCost() {
  const est = chain.costEstimate();
  const buyLamports = toLamports(cfg.pawnUsd / price.usd);
  return { buyLamports, nextLamports: buyLamports + est.rentLamports + est.networkLamports };
}

// Router balance vs the books. SOL that showed up without a claim (the gas buffer you send by hand)
// is booked as a deposit, never as creator fees. SOL missing from the router is flagged.
async function refreshBalance() {
  t.routerLamports = await chain.routerLamports();
  t.lastBalanceAt = Date.now();
  const diff = t.routerLamports - ledger.expectedRouterLamports();
  if (diff > 5000) {
    ledger.addDeposit(diff);
    ledger.save();
    log.info(`Dépôt dans le router : ${toSol(diff)} SOL (compté comme dépôt, pas comme creator fees).`);
  } else if (diff < -5000) {
    warnOnce("missing", `Il manque ${toSol(-diff)} SOL dans le router par rapport au ledger. À vérifier sur Solscan.`);
  } else clearWarn("missing");
}

// Every CLAIM_EVERY_MIN: simulate the claim (nothing sent), then claim only if the fees waiting in pump.fun are
// worth CLAIM_MIN_USD, or if the last claim is CLAIM_MAX_WAIT_H old and the fees pay for at least one pawn.
// Either way the claim must pay for its own fee 10 times.
// Paused: the simulation still runs (read-only), so the site shows what is waiting, but nothing is claimed.
async function doClaim(previewOnly) {
  // An empty router can't even pay a simulated fee: say it once, rather than an error every few minutes.
  if (cfg.real && t.routerLamports === 0) { warnOnce("emptyRouter", "Le router n'a pas de SOL : pas de simulation de claim tant qu'il n'a pas reçu son buffer gas."); return; }
  clearWarn("emptyRouter");
  const p = await chain.previewClaim();
  const now = Date.now();
  t.claim = { pendingLamports: p.pendingLamports, checkedAt: now };
  if (previewOnly) return;
  const pendingUsd = toSol(p.pendingLamports) * price.usd;
  const lastAt = L.claims.at(-1)?.at ?? L.startedAt;
  let why = "";
  if (p.worthIt && pendingUsd >= cfg.claimMinUsd) why = `${round(pendingUsd, 2)} $ en attente, seuil ${cfg.claimMinUsd} $`;
  else if (p.worthIt && now - lastAt >= cfg.claimMaxWaitMs && p.pendingLamports >= pawnCost().nextLamports) {
    why = `dernier claim il y a plus de ${round(cfg.claimMaxWaitMs / 3_600_000, 2)} h`;
  }
  if (!why) {
    log.info(`Claim : ${toSol(p.pendingLamports).toFixed(6)} SOL en attente dans pump.fun (≈ ${round(pendingUsd, 2)} $), on attend ${cfg.claimMinUsd} $.`);
    return;
  }
  const r = await chain.claim(p);
  ledger.addClaim({ at: Date.now(), receivedLamports: r.receivedLamports, feeLamports: r.feeLamports, tx: r.tx });
  ledger.save();
  t.claim = { pendingLamports: 0, checkedAt: Date.now() };
  log.info(`Claim (${why}) : +${toSol(r.receivedLamports)} SOL de creator fees (frais réseau ${toSol(r.feeLamports)} SOL).${solscan(r.tx)}`);
  if (cfg.devSharePct > 0) {
    const lamports = Math.floor(r.receivedLamports * cfg.devSharePct / 100);
    const p = await chain.payDev(lamports);
    ledger.addDevPayment({ at: Date.now(), lamports, feeLamports: p.feeLamports, tx: p.tx });
    ledger.save();
    log.info(`Part dev : ${toSol(lamports)} SOL (${cfg.devSharePct} %).`);
  }
  await refreshBalance();
}

async function maybeSpawn() {
  if (cfg.real && !price.fresh) { warnOnce("price", "Prix du SOL trop ancien : pas de nouveau pawn tant qu'il n'est pas à jour."); return; }
  clearWarn("price");
  const { buyLamports, nextLamports } = pawnCost();
  // Pawns are paid from creator fees only (what's waiting on the books), never from the SOL you
  // deposited, and the router always keeps its gas buffer.
  const T = L.totals, waiting = T.receivedLamports - T.buysLamports - T.networkLamports - T.devLamports;
  const need = nextLamports + (chain.reserveLamports?.(buyLamports) ?? 0);
  if (waiting < need || t.routerLamports - bufferLamports < need) return;
  t.lastPawnAt = Date.now();
  try {
    const r = await chain.spawnPawn({
      n: L.pawns.length + 1,
      buyLamports,
      onPending: (info) => { L.pending = info; ledger.save(); }
    });
    L.pending = null;
    recordPawn(r);
    ledger.save();
    t.failures = 0;
  } catch (e) {
    if (e.fatal) {
      // e.g. a voice's key missing or not matching: never buy that pawn with another wallet.
      t.halted = true;
      log.error(`${e.message} Plus de pawns tant que ce n'est pas réglé : corrige, puis relance le router.`);
    } else if (!L.pending) {
      // Refused before anything was sent (simulation, checks, RPC): nothing spent. Try again in a minute.
      log.warn(`Pawn pas créé, rien n'a été envoyé : ${e.message} Nouvel essai dans 1 min.`);
      t.lastPawnAt = Date.now() + 60_000;
    } else {
      t.failures++;
      log.error(`Pawn envoyé mais raté (${t.failures}/5) : ${e.message}`);
      if (!(await settlePending())) t.halted = true;
      if (t.failures >= 5 && !t.halted) {
        t.halted = true;
        log.error("Disjoncteur : 5 pawns ratés d'affilée, je n'en crée plus. Lis les erreurs ci-dessus, puis relance le router.");
      }
    }
  }
  await refreshBalance();
}

async function doCheck() {
  const balances = await chain.pawnBalances(L.pawns);
  const sold = ledger.applyCheck(Date.now(), balances);
  ledger.save();
  if (sold) log.warn(`Vérification : ${sold} pawn(s) sur ${L.pawns.length} ont un solde en baisse !`);
  else log.info(`Vérification : ${L.pawns.length} pawn${L.pawns.length > 1 ? "s" : ""}, aucun n'a vendu.`);
}

function publish() {
  const { nextLamports } = pawnCost();
  const state = buildState({
    mode: isPaused() ? "paused" : cfg.mode,
    ledger, routerLamports: t.routerLamports, solUsd: price.usd, pawnUsd: cfg.pawnUsd, nextPawnLamports: nextLamports,
    claim: { ...t.claim, minUsd: cfg.claimMinUsd, maxWaitH: round(cfg.claimMaxWaitMs / 3_600_000, 4) },
    dev: t.dev
  });
  writeState(cfg.stateFile, state);
  publisher?.offer(state);
  t.lastState = state;
  t.lastWriteAt = Date.now();
}

async function tick() {
  const now = Date.now();
  if (now - t.lastPriceAt >= 60_000) { t.lastPriceAt = now; await price.refresh(); }
  if (now - t.lastBalanceAt >= (cfg.real ? 15_000 : 1000)) await refreshBalance();
  const paused = isPaused();
  if (now - t.lastClaimAt >= cfg.claimEveryMs) { t.lastClaimAt = now; await doClaim(paused); }
  if (!paused && now - t.lastPawnAt >= spacingMs) await maybeSpawn();
  if (L.pawns.length && now - t.lastCheckAt >= cfg.checkEveryMs) { t.lastCheckAt = now; await doCheck(); }
  if (now - t.lastDevAt >= cfg.checkEveryMs) {
    t.lastDevAt = now;
    await refreshDevBag();
    await checkRouterTokens(false).catch((e) => log.warn(`Solde $PAWNS du router illisible : ${e.message}`));
  }
  if (now - (L.history.at(-1)?.t ?? 0) >= cfg.historyEveryMs) { ledger.pushHistory(now); ledger.save(); }
  if (Date.now() - t.lastWriteAt >= 2000) publish();
}

const server = cfg.previewPort ? startPreview({ port: cfg.previewPort, stateFile: cfg.stateFile, siteFile: cfg.siteFile }) : null;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
  if (t.stopping) process.exit(1);
  t.stopping = true;
  log.info("Arrêt demandé : je termine l'étape en cours puis je sauvegarde.");
});
log.info(`state.json : ${cfg.stateFile}`);
log.info("Ctrl+C pour arrêter le router proprement.");

let wasPaused = null;
while (!t.stopping) {
  const p = isPaused();
  if (p !== wasPaused && wasPaused !== null) log.info(p ? "Router en pause : plus de claims ni de pawns." : "Pause levée : le router reprend.");
  wasPaused = p;
  try { await tick(); }
  catch (e) { log.error(e.message); }
  await sleep(1000);
}
ledger.save();
publish();
await publisher?.flush(t.lastState);
server?.close();
log.info("Router arrêté. Ledger et state.json sauvegardés.");
process.exit(0);
