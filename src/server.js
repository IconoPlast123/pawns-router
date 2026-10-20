import fs from "node:fs";
import http from "node:http";
import { log } from "./log.js";

// Local preview only (127.0.0.1, never reachable from outside):
//   /state.json  the file the router writes, with CORS so a site opened from disk can read it too
//   /            the site, served with CONFIG.STATE_URL pointed at /state.json. index.html itself is not modified.
export function startPreview({ port, stateFile, siteFile }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/state.json") {
      fs.readFile(stateFile, (err, body) => {
        res.writeHead(err ? 404 : 200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
        res.end(err ? '{"error":"state.json pas encore écrit"}' : body);
      });
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      fs.readFile(siteFile, "utf8", (err, html) => {
        if (err) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("index.html introuvable"); return; }
        const wired = html.replace(/STATE_URL:\s*"[^"]*"/, 'STATE_URL: "/state.json"');
        if (wired === html) log.warn("Aperçu : CONFIG.STATE_URL introuvable dans index.html, le site affichera ses données d'exemple.");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(wired);
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Introuvable");
  });
  server.on("error", (e) => log.warn(`Aperçu local impossible sur le port ${port} (${e.code}). Change PREVIEW_PORT dans .env ou mets 0.`));
  server.listen(port, "127.0.0.1", () => log.info(`Aperçu du site avec ces données : http://127.0.0.1:${port}`));
  return server;
}
