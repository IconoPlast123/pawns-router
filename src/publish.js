import { log } from "./log.js";

const HEARTBEAT_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

export const rawUrl = (owner, id) => `https://gist.githubusercontent.com/${owner}/${id}/raw/state.json`;

// One PATCH of the gist's state.json. Returns the gist owner's login (for the raw URL) and whether it is public.
export async function sendToGist(gist, state) {
  let r;
  try {
    r = await fetch(`${gist.api}/gists/${gist.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${gist.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "pawns-router",
        "content-type": "application/json"
      },
      body: JSON.stringify({ files: { "state.json": { content: JSON.stringify(state) } } }),
      signal: AbortSignal.timeout(20_000)
    });
  } catch (e) {
    throw new Error(`GitHub injoignable (${e.name === "TimeoutError" ? "délai dépassé" : e.message})`);
  }
  if (r.ok) {
    const j = await r.json().catch(() => ({}));
    return { owner: j.owner?.login || "", public: j.public !== false };
  }
  const why = {
    401: "token refusé (faux, expiré ou révoqué)",
    403: "accès refusé ou limite GitHub atteinte (le token a-t-il le droit « gist » ?)",
    404: "Gist introuvable (mauvais STATE_GIST_ID, ou Gist d'un autre compte que le token)",
    422: "GitHub a refusé le contenu",
    429: "trop de requêtes, GitHub demande de ralentir"
  }[r.status] || `erreur GitHub ${r.status}`;
  throw new Error(why);
}

// Keeps the public copy of state.json up to date without ever slowing the router down:
// at most one send per `everyMs`, only when something changed (the clock and the SOL price alone don't count),
// plus a heartbeat every 10 minutes so the site can tell the router is alive.
// A failed send is logged and retried later, waiting longer each time (up to 30 min).
export function makePublisher(gist) {
  let lastKey = "", lastSentAt = 0, nextTryAt = 0, backoffMs = 0, inFlight = null, announced = false, failing = false;

  // What counts as a change: everything but the timestamps and what the SOL price alone moves.
  function keyOf(state) {
    const { updatedAt, solUsd, nextPawnSol, history, ...rest } = state;
    return JSON.stringify({ ...rest, history: history.map((p, i) => (i === history.length - 1 ? { ...p, t: 0 } : p)) });
  }

  async function send(state, key) {
    const now = Date.now();
    try {
      const r = await sendToGist(gist, state);
      lastKey = key; lastSentAt = now; backoffMs = 0; nextTryAt = 0;
      if (!announced) {
        announced = true;
        log.info(`state.json publié en ligne : ${r.owner ? rawUrl(r.owner, gist.id) : `Gist ${gist.id}`}`);
        if (!r.public) log.warn("Ce Gist est secret : le site le lira quand même, mais un Gist public est plus transparent.");
      } else if (failing) log.info("Publication en ligne rétablie.");
      failing = false;
    } catch (e) {
      failing = true;
      backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs ? backoffMs * 2 : Math.max(30_000, gist.everyMs));
      nextTryAt = now + backoffMs;
      const wait = backoffMs < 60_000 ? `${Math.round(backoffMs / 1000)} s` : `${Math.round(backoffMs / 60_000)} min`;
      log.warn(`Publication du state.json en ligne ratée : ${e.message}. Le router continue ; nouvel essai dans ${wait}.`);
    }
  }

  return {
    // Called after every local write of state.json. Never waits for GitHub.
    offer(state) {
      if (inFlight) return;
      const now = Date.now();
      if (now < nextTryAt || now - lastSentAt < gist.everyMs) return;
      const key = keyOf(state);
      if (key === lastKey && now - lastSentAt < HEARTBEAT_MS) return;
      inFlight = send(state, key).finally(() => { inFlight = null; });
    },

    // On shutdown: one last send if something changed, without waiting more than a few seconds.
    async flush(state) {
      if (inFlight) await inFlight;
      if (keyOf(state) === lastKey) return;
      await Promise.race([send(state, keyOf(state)), new Promise((r) => setTimeout(r, 8000))]);
    }
  };
}
