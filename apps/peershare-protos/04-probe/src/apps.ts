/**
 * Local apps with the traits the Probe looks for, on real ports.
 */

import { createServer } from "node:http";
import type { Running } from "../../01-upstream-kinds/src/fixtures.js";

export interface AppTraits {
  /** HTML served at `/`. */
  html?: string;
  /** Delay before answering, in ms. */
  delayMs?: number;
  /** A `Set-Cookie` the app sends, as a login would. */
  setCookie?: string;
  /** Send `Access-Control-Allow-Origin: <origin>` (Direct needs it). */
  cors?: boolean;
  status?: number;
}

export async function startApp(traits: AppTraits = {}): Promise<Running> {
  const server = createServer((req, res) => {
    setTimeout(() => {
      const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
      if (traits.setCookie != null) headers["set-cookie"] = traits.setCookie;
      if (traits.cors === true) headers["access-control-allow-origin"] = req.headers.origin ?? "*";
      res.writeHead(traits.status ?? 200, headers);
      res.end(traits.html ?? "<!doctype html><title>app</title><p>hello</p>");
    }, traits.delayMs ?? 0);
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

/** What Vite's dev server serves at `/`: its client opens a WebSocket for hot reload. */
export const VITE_INDEX = `<!doctype html><html><head>
<script type="module" src="/@vite/client"></script>
</head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>`;
