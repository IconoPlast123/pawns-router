import os from "node:os";
import { log } from "./log.js";

// The phone alert (optional, README §12), with healthchecks.io.
// While the router works, it sends healthchecks.io a sign of life every ALERT_EVERY_SEC. When the signs stop
// (PC off, power or internet cut, Windows update, crash), healthchecks.io sends the alert (Telegram...), and
// another one when they come back. When the router runs but can't do its job (the same step failing
// ALERT_FAILS times in a row, a main loop that no longer completes, the circuit breaker...), it says so at once
// with healthchecks.io's /fail address, with the reason.
// Nothing here can stop or slow the router: the main loop never waits for healthchecks.io, every send gives up
// after 10 s, and a failure is only logged.

const TIMEOUT_MS = 10_000;
const LABELS = {
  claim: "La simulation du claim pump.fun",
  pawn: "La création des pawns (refusée avant envoi : simulation, contrôles ou RPC)",
  check: "La revérification des pawns"
};

// What leaves for healthchecks.io never carries a secret: links are cut down to their site (an RPC address
// holds its API key in its path or after « ? »), except Solscan links, which are public. The user folder
// (which holds the Windows user name) becomes « ~ ».
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const home = os.homedir();
const homeRe = home ? new RegExp(`${escape(home)}|${escape(home.replaceAll("\\", "/"))}`, "gi") : null;
export function scrub(text) {
  const rpc = (process.env.RPC_URL ?? "").trim();
  let s = String(text ?? "");
  if (rpc) s = s.split(rpc).join("[RPC]");
  if (homeRe) s = s.replace(homeRe, "~");
  return s
    .replace(/\bhttps?:\/\/[^\s"'<>()]+/gi, (u) => (/^https:\/\/solscan\.io\/tx\/[1-9A-HJ-NP-Za-km-z]+$/.test(u) ? u : u.replace(/^(https?:\/\/[^/?#\s]+).*$/i, "$1/…")))
    .replace(/(api[-_]?key[=:]\s*)[^\s&"'<>]+/gi, "$1…")
    .slice(0, 3000);
}

const sec = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

// One send to healthchecks.io: "" = sign of life, "/fail" = alert. Throws a French reason on failure.
export async function ping(a, suffix, body) {
  let r;
  try {
    r = await fetch(a.url + suffix, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8", "user-agent": "pawns-router" },
      body: scrub(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e) {
    throw new Error(`healthchecks.io injoignable (${e.name === "TimeoutError" ? "pas de réponse en 10 s" : e.cause?.code || e.message})`);
  }
  const text = await r.text().catch(() => "");
  if (r.status === 404 || /not found/i.test(text)) throw new Error("adresse inconnue de healthchecks.io (check supprimé, ou adresse mal copiée dans le fichier de ALERT_URL_FILE)");
  if (r.status === 429 || /rate limited/i.test(text)) throw new Error("trop d'envois, healthchecks.io demande de ralentir");
  if (!r.ok) throw new Error(`erreur healthchecks.io ${r.status}`);
}

// a: from loadAlert() in config.js. health(): { line, problem } from the router, read at every beat:
// `line` says in a few words what it is doing, `problem` (or "") what stops it from working right now.
export function makeAlert(a, health) {
  const bornAt = Date.now();
  const steps = new Map(); // step name -> { n: failures in a row, why: last error }
  let lastTurnOkAt = 0, lastTurnError = "", sentDown = "", inFlight = null, stopped = false;
  let announced = false, unreachable = ""; // unreachable: the last send's error, "" when it worked

  function read() {
    try { return health() ?? {}; }
    catch (e) { return { line: "", problem: "" }; }
  }

  // Why the router doesn't work right now, or null when it does.
  function trouble(h) {
    if (h.problem) return { key: "problem:" + h.problem, text: h.problem };
    for (const [name, s] of steps) {
      if (s.n >= a.fails) return { key: "step:" + name, text: `${LABELS[name] ?? name} a échoué ${s.n} fois de suite. Dernière erreur : ${s.why}` };
    }
    const since = lastTurnOkAt || bornAt;
    if (Date.now() - since >= a.stuckMs) {
      return {
        key: "stuck",
        text: `La boucle du router n'a plus fait un seul tour complet depuis ${sec(Date.now() - since)}.` +
          (lastTurnError ? ` Dernière erreur : ${lastTurnError}` : " Elle semble bloquée.")
      };
    }
    return null;
  }

  function send(suffix, body, onDone) {
    inFlight = ping(a, suffix, body)
      .then(() => {
        if (unreachable) log.info("Alerte téléphone : healthchecks.io joignable à nouveau.");
        unreachable = "";
        onDone?.();
      })
      .catch((e) => {
        // Said once per kind of failure, not at every try.
        if (unreachable !== e.message) log.warn(`Alerte téléphone : envoi à healthchecks.io raté (${e.message}). Le router continue ; nouvel essai dans ${sec(a.everyMs)}.`);
        unreachable = e.message;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  function beat() {
    if (stopped || inFlight) return;
    try {
      const h = read();
      const t = trouble(h);
      const line = h.line ? ` · ${h.line}` : "";
      if (!t) {
        // The first sign of life leaves after the router's first complete turn.
        if (!lastTurnOkAt) return;
        send("", `Router $PAWNS OK${line}`, () => {
          if (!announced) log.info(`Alerte téléphone active : healthchecks.io reçoit un signe de vie toutes les ${sec(a.everyMs)}.`);
          announced = true;
          if (sentDown) log.info("Alerte téléphone : le router retravaille, healthchecks.io le sait (message « up »).");
          sentDown = "";
        });
      } else if (t.key !== sentDown) {
        log.warn(`Alerte téléphone : le router ne travaille plus, j'envoie l'alerte. ${t.text}`);
        send("/fail", `ALERTE : le router $PAWNS tourne mais ne travaille plus. ${t.text}${line}`, () => { sentDown = t.key; });
      }
    } catch (e) { log.warn(`Alerte téléphone : ${e.message}`); }
  }

  const timer = setInterval(beat, a.everyMs);
  timer.unref();

  return {
    // The main loop finished a turn (true) or threw (false, with the error).
    turn(ok, why) {
      if (!ok) { lastTurnError = scrub(why); return; }
      const first = !lastTurnOkAt;
      lastTurnOkAt = Date.now();
      lastTurnError = "";
      if (first) beat();
    },
    // A step worked / failed. ALERT_FAILS failures in a row of the same step = alert.
    ok(step) { steps.delete(step); },
    fail(step, why) {
      const s = steps.get(step) ?? { n: 0, why: "" };
      steps.set(step, { n: s.n + 1, why: scrub(why) });
    },
    // The router stops (Ctrl+C) or refuses to start: alert right away, without waiting more than 5 s.
    async stop(text) {
      stopped = true;
      clearInterval(timer);
      log.info("Alerte téléphone : j'envoie « router arrêté » à healthchecks.io.");
      try { await Promise.race([send("/fail", `ALERTE : ${text}`), new Promise((r) => setTimeout(r, 5000))]); }
      catch { /* the router stops anyway */ }
    }
  };
}
