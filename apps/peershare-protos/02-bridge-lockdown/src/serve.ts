/**
 * The Bridge on a port, under Node. Under Bun, `main.ts` hands the same
 * handler to `Bun.serve`.
 */

import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { FetchHandler } from "@statewalker/webrun-http-proxy";

export interface Listening {
  origin: string;
  /** The interface actually bound. */
  address: string;
  close(): Promise<void>;
}

/** Binds 127.0.0.1 only: the Bridge is never reachable from the network. */
export function listenLoopback(handler: FetchHandler, port = 0): Promise<Listening> {
  return new Promise((resolve) => {
    const server = serve({ fetch: handler, port, hostname: "127.0.0.1" }, (info: AddressInfo) => {
      resolve({
        origin: `http://127.0.0.1:${info.port}`,
        address: info.address,
        close: () =>
          new Promise<void>((done) => {
            if ("closeAllConnections" in server) server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
