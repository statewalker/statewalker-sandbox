/**
 * The Viewer's page code: one isolated origin per Service, every request in
 * it answered over the mesh. Bundled into the page as `window.Rung08`.
 */

import {
  BRIDGE_REDIRECT_LOCATION_HEADER,
  BRIDGE_REDIRECT_STATUS_HEADER,
} from "../../01-upstream-kinds/src/upstreams.js";
import { APP_SERVICE_KEY, openSession } from "../vendor/session-shell/client.js";

export interface ViewerInit {
  /** Where the Guest's member is reached (the stand-in; in production, the member itself). */
  edge: string;
  sharerPeerId: string;
  serviceId: string;
  /** `openSession`'s origin function, as a template with `{name}`. */
  sessionOrigin: string;
  /** Rung 15 (spike): put `/_shell/ws-shim.js` first in every HTML page the Service returns. */
  injectWsShim?: boolean;
}

/** The member's `fetch`, as the Viewer calls it: a redirect comes back as a real 3xx Response. */
async function meshFetch(edge: string, path: string, request: Request): Promise<Response> {
  const body =
    request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
  const res = await fetch(`${edge}${path}`, {
    method: request.method,
    headers: request.headers,
    body,
  });
  const status = res.headers.get(BRIDGE_REDIRECT_STATUS_HEADER);
  if (status == null) return res;
  return new Response(null, {
    status: Number(status),
    headers: { location: res.headers.get(BRIDGE_REDIRECT_LOCATION_HEADER) ?? "/" },
  });
}

export async function openViewer(init: ViewerInit): Promise<{ origin: string }> {
  const session = await openSession({
    origin: (name) => init.sessionOrigin.replace("{name}", name),
    services: [
      {
        key: APP_SERVICE_KEY,
        path: "/",
        handler: async (request: Request) => {
          const url = new URL(request.url);
          const path = `/${init.sharerPeerId}/s/${init.serviceId}${url.pathname}${url.search}`;
          const response = await meshFetch(init.edge, path, request);
          return init.injectWsShim === true ? withWsShim(response) : response;
        },
      },
    ],
  });
  const frame = document.createElement("iframe");
  frame.id = `viewer-${init.serviceId}`;
  frame.src = session.url("/");
  document.body.append(frame);
  return { origin: session.origin };
}

async function withWsShim(response: Response): Promise<Response> {
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) return response;
  const html = await response.text();
  const shim = '<script src="/_shell/ws-shim.js"></script>';
  const at = html.search(/<head[^>]*>/i);
  const patched = at < 0 ? shim + html : html.replace(/<head[^>]*>/i, (head) => head + shim);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(patched, { status: response.status, headers });
}
