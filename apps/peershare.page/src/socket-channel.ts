/**
 * The Viewer's side of the WebSocket shim (src/ws-shim.ts): a session frame
 * asks for a socket with a MessagePort; the Viewer opens it over the mesh
 * (`peershare:guest-socket`) and relays events both ways.
 *
 * Only ports from the Viewer's own session frames, from their own origins,
 * are accepted: `frames` maps each frame's window to its Service.
 */

import type { GuestSocket } from "@statewalker/peershare";

export interface SessionFrame {
  serviceId: string;
  origin: string;
}

export function listenForSockets(
  frames: () => Map<MessageEventSource, SessionFrame>,
  open: () => GuestSocket,
): () => void {
  const onMessage = (event: MessageEvent) => {
    if (event.data?.peershare !== "socket") return;
    const frame = event.source == null ? undefined : frames().get(event.source);
    const port = event.ports[0];
    if (frame == null || frame.origin !== event.origin || port == null) return;

    const socket = open()(
      frame.serviceId,
      String(event.data.path),
      (event.data.protocols ?? []).map(String),
    );
    socket.onopen = () => port.postMessage({ event: "open", protocol: socket.protocol });
    socket.onmessage = (e) =>
      typeof e.data === "string"
        ? port.postMessage({ event: "message", data: e.data })
        : port.postMessage({ event: "message", data: e.data }, [e.data]);
    socket.onerror = () => port.postMessage({ event: "error" });
    socket.onclose = (e) => {
      port.postMessage({ event: "close", code: e.code, reason: e.reason });
      port.close();
    };
    port.onmessage = (e) => {
      if (e.data?.close != null) socket.close(e.data.close.code, e.data.close.reason);
      else if (e.data?.send != null) socket.send(e.data.send);
    };
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

/** Put the shim first in an HTML page, so it is in place before the page's own scripts. */
export async function withSocketShim(response: Response): Promise<Response> {
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) return response;
  const html = await response.text();
  const shim = '<script src="/_shell/ws-shim.js"></script>';
  const patched = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (head) => head + shim)
    : shim + html;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(patched, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
