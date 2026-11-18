import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

export type Server = { port: number; close: () => Promise<void> };

/** Serves a fetch-style handler over node:http, streaming both request and response bodies. */
export async function serve(
  handler: (request: Request) => Promise<Response>,
  options: { port?: number; host?: string } = {},
): Promise<Server> {
  const server = createServer((req, res) => void respond(handler, req, res));
  server.listen(options.port ?? 8080, options.host);
  await once(server, "listening");
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

async function respond(
  handler: (request: Request) => Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      for (const v of [value ?? []].flat()) headers.append(name, v);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, {
      method: req.method,
      headers,
      body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
      signal: abort.signal,
      // @ts-expect-error -- Node needs `duplex` for a streamed request body; not in the DOM typings
      duplex: "half",
    });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return void res.end();
    res.flushHeaders();
    const reader = response.body.getReader();
    abort.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}));
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!res.write(value)) await once(res, "drain");
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "internal", message: String(e) } }));
    } else {
      res.destroy();
    }
  }
}
