/**
 * Dirk's app: a small SPA written the way real ones are, with absolute asset
 * paths, an API call, and a redirect written absolutely to itself. Its script
 * also reports what it can see of the page around it.
 */

import { createServer } from "node:http";
import type { Running } from "../../01-upstream-kinds/src/fixtures.js";

const INDEX = `<!doctype html><html><head><meta charset="utf-8"><title>Dirk's app</title>
<link rel="stylesheet" href="/assets/app.css"></head>
<body><div id="out">loading</div><script src="/assets/app.js"></script></body></html>`;

const APP_JS = `
const out = document.getElementById("out");
out.dataset.origin = location.origin;
out.dataset.identity = String(localStorage.getItem("peershare-identity"));
out.dataset.mine = String(localStorage.getItem("app-note"));
try { void window.parent.document.title; out.dataset.parent = "readable"; }
catch { out.dataset.parent = "blocked"; }
localStorage.setItem("app-note", "written by " + location.pathname);
fetch("/api/hello").then((r) => r.json()).then((j) => { out.textContent = j.message; });
`;

export async function startSpa(): Promise<Running> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/" || path === "/landed") {
      return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(INDEX);
    }
    if (path === "/assets/app.css") {
      return void res
        .writeHead(200, { "content-type": "text/css" })
        .end("#out { color: rgb(1, 2, 3); }");
    }
    if (path === "/assets/app.js") {
      return void res.writeHead(200, { "content-type": "text/javascript" }).end(APP_JS);
    }
    if (path === "/api/hello") {
      return void res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ message: "hello from Dirk's app" }));
    }
    if (path === "/login") {
      // Absolute, to itself: what most frameworks write.
      return void res.writeHead(302, { location: `http://${req.headers.host}/landed` }).end();
    }
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
