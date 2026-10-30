/** An app with a cookie login: `/login?user=x` sets `session=x`; `/whoami` says who the cookie says. */

import { createServer } from "node:http";
import type { Running } from "../../01-upstream-kinds/src/fixtures.js";

export async function startLoginApp(): Promise<Running> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/login") {
      const user = url.searchParams.get("user") ?? "nobody";
      return void res
        .writeHead(200, { "set-cookie": `session=${user}; Path=/; HttpOnly` })
        .end("logged in");
    }
    if (url.pathname === "/whoami") {
      const session = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
      return void res.writeHead(200, { "content-type": "text/plain" }).end(session ?? "anonymous");
    }
    res.writeHead(404).end();
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
