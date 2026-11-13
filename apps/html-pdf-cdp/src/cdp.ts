/**
 * A minimal Chrome DevTools Protocol client over one WebSocket: commands with ids, events by
 * name, flat sessions (`sessionId` on every message, as Target.attachToTarget with
 * `flatten: true` gives). No Puppeteer: what is sent is plain CDP, so the same code talks to
 * Chromium and to engines that implement a subset of CDP (Cloudflare's Kitesurf).
 */

export type CdpEndpoint = {
  /** The browser-level WebSocket URL (`ws://…/devtools/browser/…`, or Browser Run's). */
  url: string;
  /** Headers for the upgrade request, e.g. `Authorization: Bearer …` for Browser Run. */
  headers?: Record<string, string>;
};

/** A CDP error answer: `code` and `message` as the browser sent them. */
export class CdpError extends Error {
  readonly method: string;
  readonly code: number;
  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message} (${code})`);
    this.method = method;
    this.code = code;
  }

  /** The browser does not implement the method (JSON-RPC "method not found"). */
  get notImplemented(): boolean {
    return this.code === -32601 || /not found|not implemented|unknown method/i.test(this.message);
  }
}

type Pending = {
  method: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};
type Listener = (params: Record<string, unknown>, sessionId?: string) => void;

export class CdpConnection {
  #next = 1;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Map<string, Set<Listener>>();
  #closed: Error | null = null;

  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (e) => this.#onMessage(String(e.data)));
    ws.addEventListener("close", (e) =>
      this.#fail(new Error(`ECONNRESET: CDP socket closed (${e.code} ${e.reason})`.trim())),
    );
    ws.addEventListener("error", () => this.#fail(new Error("ECONNRESET: CDP socket error")));
  }

  /** Opens the socket. Headers need a WebSocket that takes them (Node's undici does). */
  static async connect(endpoint: CdpEndpoint, timeoutMs = 30_000): Promise<CdpConnection> {
    const Ws = WebSocket as unknown as new (
      url: string,
      options?: { headers?: Record<string, string> },
    ) => WebSocket;
    const ws = new Ws(endpoint.url, endpoint.headers ? { headers: endpoint.headers } : undefined);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`ETIMEDOUT: no CDP connection to ${redact(endpoint.url)}`));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`ECONNREFUSED: CDP connection to ${redact(endpoint.url)} failed`));
      });
    });
    return new CdpConnection(ws);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 60_000,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#next++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`ETIMEDOUT: ${method} got no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  /** Calls `listener` on each `method` event; returns the unsubscribe function. */
  on(method: string, listener: Listener): () => void {
    const set = this.#listeners.get(method) ?? new Set<Listener>();
    this.#listeners.set(method, set);
    set.add(listener);
    return () => set.delete(listener);
  }

  /** The next `method` event of `sessionId`, or a timeout error. */
  waitFor(method: string, sessionId: string | undefined, timeoutMs: number) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`ETIMEDOUT: no ${method} in ${timeoutMs} ms`));
      }, timeoutMs);
      const off = this.on(method, (params, sid) => {
        if (sessionId && sid !== sessionId) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  close(): void {
    this.#fail(new Error("ECONNRESET: CDP connection closed"));
    this.ws.close();
  }

  #onMessage(text: string): void {
    const msg = JSON.parse(text) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { code: number; message: string };
      sessionId?: string;
    };
    if (msg.id !== undefined) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error)
        pending.reject(new CdpError(pending.method, msg.error.code, msg.error.message));
      else pending.resolve(msg.result ?? {});
      return;
    }
    if (msg.method)
      for (const listener of this.#listeners.get(msg.method) ?? [])
        listener(msg.params ?? {}, msg.sessionId);
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;
    for (const p of this.#pending.values()) p.reject(error);
    this.#pending.clear();
  }
}

/** The URL without its query string (account ids, tokens never belong in logs). */
export const redact = (url: string) => url.replace(/\?.*$/, "?…");
