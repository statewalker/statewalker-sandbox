/**
 * Real servers on real ports, so the rung measures HTTP rather than mocks.
 *
 * `startService` is the Sharer's local app (Dirk's `localhost:5173`).
 * `startBridgeStub` is a THROWAWAY stand-in for the Bridge: just enough to
 * relay, with none of the lock-down rung 02 is about. Only its wire contract
 * (`BRIDGE_TARGET_HEADER`, `BRIDGE_TOKEN_HEADER`) matters here.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { BRIDGE_MARKER, BRIDGE_TARGET_HEADER, BRIDGE_TOKEN_HEADER } from "./upstreams.js";

export interface Running {
  origin: string;
  close(): Promise<void>;
}

export function startService(): Promise<Running> {
  return listen(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname.startsWith("/echo")) {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[name] = value;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          service: "dirk",
          method: req.method,
          path: url.pathname,
          query: url.search,
          headers,
          body,
        }),
      );
      return;
    }

    if (url.pathname === "/stream") {
      // The second chunk is written only after the first was READ by the
      // test, so a relay that buffers deadlocks instead of passing by luck.
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      res.write("first\n");
      streamGate.wait().then(() => res.end("second\n"));
      return;
    }

    res.writeHead(404).end("not found");
  });
}

/** Lets a test release the second chunk of `/stream` once it holds the first. */
export const streamGate = (() => {
  let release: () => void = () => {};
  let gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    wait: () => gate,
    open() {
      release();
      gate = new Promise<void>((r) => {
        release = r;
      });
    },
  };
})();

export function startBridgeStub(token: string): Promise<Running> {
  return listen(async (req, res) => {
    if (req.headers[BRIDGE_TOKEN_HEADER] !== token) {
      res.writeHead(401, { [BRIDGE_MARKER]: "bad-token" }).end();
      return;
    }
    const target = req.headers[BRIDGE_TARGET_HEADER];
    if (typeof target !== "string") {
      res.writeHead(400, { [BRIDGE_MARKER]: "no-target" }).end();
      return;
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    // The Bridge's own headers are consumed by this hop.
    headers.delete(BRIDGE_TOKEN_HEADER);
    headers.delete(BRIDGE_TARGET_HEADER);
    headers.delete("host");
    // Hop-by-hop headers describe THIS connection, not the next one; undici
    // refuses a request that carries them (a streamed POST arrives with
    // `transfer-encoding: chunked`). Rung 02's Bridge must drop them too.
    for (const hop of ["connection", "keep-alive", "transfer-encoding", "content-length"]) {
      headers.delete(hop);
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    try {
      const upstream = await fetch(new URL(req.url ?? "/", target), {
        method: req.method,
        headers,
        ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" } : {}),
        redirect: "manual",
      });
      res.writeHead(upstream.status, {
        ...Object.fromEntries(upstream.headers),
        [BRIDGE_MARKER]: "relayed",
      });
      if (upstream.body == null) res.end();
      else Readable.fromWeb(upstream.body as never).pipe(res);
    } catch {
      res.writeHead(502, { [BRIDGE_MARKER]: "target-unreachable" }).end();
    }
  });
}

/** A port that was listening and is now closed: connecting to it is refused. */
export async function deadOrigin(): Promise<string> {
  const s = await startService();
  await s.close();
  return s.origin;
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<Running> {
  const server: Server = createServer((req, res) => {
    handler(req, res).catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
