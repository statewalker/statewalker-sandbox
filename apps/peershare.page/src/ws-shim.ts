/**
 * Served by the session zone as `/_shell/ws-shim.js` and put first in every
 * HTML page a Service returns (M9). A ServiceWorker cannot answer WebSockets
 * (rung 15), so a socket to the session's own host would reach the session
 * host and nothing else; this one hands it to the Viewer over a
 * MessageChannel, and the Viewer carries it over the mesh. Sockets to any
 * other host stay native.
 */

type Events = "open" | "message" | "close" | "error";

const Native = window.WebSocket;

class PeerShareSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readyState = 0;
  protocol = "";
  extensions = "";
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private readonly port: MessagePort;

  constructor(url: string | URL, protocols?: string | string[]) {
    super();
    this.url = new URL(url, location.href).href;
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (e) => this.receive(e.data);
    const list = protocols == null ? [] : Array.isArray(protocols) ? protocols : [protocols];
    const target = new URL(this.url);
    window.parent.postMessage(
      { peershare: "socket", path: `${target.pathname}${target.search}`, protocols: list },
      "*",
      [channel.port2],
    );
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== 1)
      throw new DOMException("the socket is not open", "InvalidStateError");
    if (data instanceof Blob) {
      void data.arrayBuffer().then((b) => this.port.postMessage({ send: b }, [b]));
    } else if (typeof data === "string") this.port.postMessage({ send: data });
    else {
      const bytes = ArrayBuffer.isView(data)
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data.slice(0);
      this.port.postMessage({ send: bytes }, [bytes as ArrayBuffer]);
    }
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.port.postMessage({ close: { code: code ?? 1000, reason: reason ?? "" } });
  }

  private receive(m: {
    event: Events;
    protocol?: string;
    data?: string | ArrayBuffer;
    code?: number;
    reason?: string;
  }) {
    if (m.event === "open") {
      this.readyState = 1;
      this.protocol = m.protocol ?? "";
      this.fire("open", new Event("open"));
    } else if (m.event === "message") {
      const data =
        typeof m.data === "string" || this.binaryType === "arraybuffer"
          ? m.data
          : new Blob([m.data as ArrayBuffer]);
      this.fire("message", new MessageEvent("message", { data }));
    } else if (m.event === "error") this.fire("error", new Event("error"));
    else {
      this.readyState = 3;
      this.fire(
        "close",
        new CloseEvent("close", {
          code: m.code ?? 1006,
          reason: m.reason ?? "",
          wasClean: m.code === 1000,
        }),
      );
      this.port.close();
    }
  }

  private fire(type: Events, event: Event): void {
    const handler = this[`on${type}` as const] as ((e: Event) => void) | null;
    handler?.call(this, event);
    this.dispatchEvent(event);
  }
}

function PeerShareWebSocket(url: string | URL, protocols?: string | string[]) {
  const target = new URL(url, location.href);
  // Only the session's own host is the Service; anything else stays native.
  if (target.host !== location.host) return new Native(target, protocols);
  return new PeerShareSocket(target, protocols);
}
PeerShareWebSocket.prototype = PeerShareSocket.prototype;
Object.assign(PeerShareWebSocket, {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
  peershare: true,
});
(window as unknown as { WebSocket: unknown }).WebSocket = PeerShareWebSocket;
