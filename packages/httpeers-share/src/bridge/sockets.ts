/**
 * The Bridge's WebSockets (M9): `/.peershare/socket?target=<url>&protocols=a,b`.
 *
 * Guarded exactly like HTTP (rung 02): the PeerShare origin only, the
 * Pairing token (as the subprotocol `peershare.<token>`, because a browser
 * cannot set headers on a WebSocket), and the same target rules. Then one
 * socket to the app is relayed message for message, both ways.
 */

import type { BridgeInit } from "./bridge.js";
import { reachable, sameSecret } from "./bridge.js";

export const SOCKET_PATH = "/.peershare/socket";
export const TOKEN_PROTOCOL_PREFIX = "peershare.";

export interface SocketPlan {
  /** The app's WebSocket URL. */
  target: string;
  /** The subprotocols to offer the app. */
  protocols: string[];
  /** The one the Bridge accepts from the page (its token protocol). */
  accept: string;
}

export type SocketGate = (
  url: URL,
  headers: Headers,
) => Promise<{ ok: true; plan: SocketPlan } | { ok: false; status: 400 | 401 | 403 | 502 }>;

export function socketGate(
  init: Pick<BridgeInit, "token" | "allowedOrigin">,
  resolveHost: (name: string) => Promise<string[]>,
): SocketGate {
  return async (url, headers) => {
    if (url.pathname !== SOCKET_PATH) return { ok: false, status: 400 };
    const origin = headers.get("origin");
    if (origin != null && origin !== init.allowedOrigin) return { ok: false, status: 403 };

    const offered = (headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim());
    const accept = offered.find(
      (p) =>
        p.startsWith(TOKEN_PROTOCOL_PREFIX) &&
        sameSecret(p.slice(TOKEN_PROTOCOL_PREFIX.length), init.token),
    );
    if (accept == null) return { ok: false, status: 401 };

    const target = url.searchParams.get("target") ?? "";
    let http: URL;
    try {
      http = new URL(target);
    } catch {
      return { ok: false, status: 400 };
    }
    const reach = await reachable(http.href.replace(/^ws/, "http"), resolveHost);
    if (reach !== "ok") return { ok: false, status: reach === "forbidden" ? 403 : 502 };

    const ws = new URL(http);
    ws.protocol = http.protocol === "https:" || http.protocol === "wss:" ? "wss:" : "ws:";
    const protocols = (url.searchParams.get("protocols") ?? "").split(",").filter(Boolean);
    return { ok: true, plan: { target: ws.href, protocols, accept } };
  };
}

/** The page's side of a relayed socket, whatever server accepted it. */
export interface InboundSocket {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

/**
 * Open the app's socket and relay. Returns the inbound side's event sinks;
 * messages that arrive before the app's socket opens are held, in order.
 */
export function relaySocket(
  inbound: InboundSocket,
  plan: SocketPlan,
): { message(data: string | ArrayBuffer): void; close(code?: number, reason?: string): void } {
  const outbound = new WebSocket(plan.target, plan.protocols);
  outbound.binaryType = "arraybuffer";
  const held: Array<string | ArrayBuffer> = [];
  outbound.onopen = () => {
    for (const data of held.splice(0)) outbound.send(data);
  };
  outbound.onmessage = (e) => inbound.send(e.data as string | ArrayBuffer);
  outbound.onclose = (e) => inbound.close(closable(e.code), e.reason);
  outbound.onerror = () => inbound.close(1011, "the app's socket failed");
  return {
    message(data) {
      if (outbound.readyState === WebSocket.OPEN) outbound.send(data);
      else held.push(data);
    },
    close(code, reason) {
      if (outbound.readyState <= WebSocket.OPEN) outbound.close(closable(code), reason);
    },
  };
}

/** A code `close()` may be called with (1000, or 3000–4999); anything else becomes 1000. */
function closable(code?: number): number {
  return code === 1000 || (code != null && code >= 3000 && code <= 4999) ? code : 1000;
}
