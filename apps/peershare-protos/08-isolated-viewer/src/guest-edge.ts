/**
 * A STAND-IN for the Guest's in-browser member, which this rung does not
 * run: httpeers-member's `createSession` in the Viewer page, proven in
 * httpeers-stack. The stand-in is a real Guest (Node) on the real mesh,
 * reachable over HTTP at `/{peerId}/{path}`.
 *
 * What it must imitate: the Viewer calls the mesh through the member's
 * JavaScript `fetch`, which returns a Service's redirect as an ordinary 302
 * Response. A browser `fetch` to this stand-in would make it opaque
 * (rung 02), so the stand-in restates redirects with the Bridge's headers
 * and the Viewer's `meshFetch` rebuilds them: the same Response the real
 * member gives.
 */

import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { MemberHandle } from "@statewalker/httpeers-member";
import {
  BRIDGE_REDIRECT_LOCATION_HEADER,
  BRIDGE_REDIRECT_STATUS_HEADER,
} from "../../01-upstream-kinds/src/upstreams.js";
import { toSharer } from "../../05-tab-hub-invite/src/mesh.js";

export interface GuestEdge {
  origin: string;
  close(): Promise<void>;
}

export function startGuestEdge(guest: MemberHandle, viewerOrigin: string): Promise<GuestEdge> {
  const cors = {
    "access-control-allow-origin": viewerOrigin,
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, HEAD",
    "access-control-expose-headers": "*",
  };
  const handler = async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    const [, peerId, ...rest] = url.pathname.split("/");
    const body =
      request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    const headers = new Headers(request.headers);
    for (const h of ["host", "origin", "referer"]) headers.delete(h);
    const answer = await guest.fetch(
      toSharer(peerId ?? "", `/${rest.join("/")}${url.search}`, {
        method: request.method,
        headers,
        body,
      }),
    );
    const out = new Headers(answer.headers);
    for (const [k, v] of Object.entries(cors)) out.set(k, v);
    const location = answer.headers.get("location");
    if (answer.status >= 300 && answer.status < 400 && location != null) {
      out.delete("location");
      out.set(BRIDGE_REDIRECT_STATUS_HEADER, String(answer.status));
      out.set(BRIDGE_REDIRECT_LOCATION_HEADER, location);
      return new Response(null, { status: 200, headers: out });
    }
    return new Response(answer.body, { status: answer.status, headers: out });
  };
  return new Promise((done) => {
    const server = serve({ fetch: handler, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) =>
      done({
        origin: `http://127.0.0.1:${info.port}`,
        close: () =>
          new Promise<void>((r) => {
            if ("closeAllConnections" in server) server.closeAllConnections();
            server.close(() => r());
          }),
      }),
    );
  });
}
