/** Test helpers: a fetch handler on 127.0.0.1 with streamed bodies both ways (no keep-alive). */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * node:http's request as a web stream that tolerates an early cancel (Readable.toWeb throws
 * "Controller is already closed" then).
 */
function requestBody(req: IncomingMessage): ReadableStream<Uint8Array> {
  let done = false;
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      req.on("data", (c: Buffer) => {
        if (done) return;
        ctrl.enqueue(new Uint8Array(c));
        if ((ctrl.desiredSize ?? 1) <= 0) req.pause();
      });
      req.on("end", () => {
        if (!done) {
          done = true;
          ctrl.close();
        }
      });
      req.on("error", (e) => {
        if (!done) {
          done = true;
          ctrl.error(e);
        }
      });
    },
    pull() {
      req.resume();
    },
    cancel() {
      done = true;
      req.resume();
    },
  });
}

export async function serve(
  handler: (req: Request) => Promise<Response>,
  closers: (() => Promise<void>)[],
): Promise<string> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : requestBody(req);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (typeof v === "string") headers.set(k, v);
      const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = await handler(
        new Request(`http://${host}${req.url}`, {
          method: req.method,
          headers,
          body,
          // @ts-expect-error node's fetch needs duplex for a streamed body
          duplex: "half",
        }),
      );
      res.writeHead(response.status, {
        ...Object.fromEntries(response.headers),
        connection: "close",
      });
      if (response.body) {
        const reader = response.body.getReader();
        res.on("close", () => void reader.cancel().catch(() => {}));
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) await new Promise((r) => res.once("drain", r));
        }
      }
      res.end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  closers.push(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`;
}
