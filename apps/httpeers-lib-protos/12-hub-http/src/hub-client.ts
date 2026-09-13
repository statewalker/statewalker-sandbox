/**
 * The member half: the hub protocol as ordinary fetch calls.
 *
 * The directive asks for "the corresponding client calls (with fetch) without
 * implication of libp2p layers", and that is literally all this is — a
 * `fetch`-shaped function in, four methods out. Whatever produced that
 * function (a direct handler reference, a MessagePort duplex, a libp2p stream)
 * is none of this file's business, which is why the same client drives all
 * three rungs of the ladder.
 */

export interface Joined {
  token: string;
  mesh: string;
  roles: string[];
}

export interface Beat {
  token: string;
  roles: string[];
  versions: { mesh: number; policy: number };
  ttl: number;
}

export interface MeshView {
  version: number;
  members: { peerId: string; roles: string[]; online: boolean }[];
  advertisements: { peerId: string; id: string; kind: string; title: string }[];
}

export interface DenyList {
  version: number;
  entries: { peerId: string; changedAt: number }[];
}

export interface HubClientInit {
  /** Anything fetch-shaped. The transport is the caller's problem, not ours. */
  fetch: (request: Request) => Promise<Response>;
  /** This member's own id, for its own logging and for the caller's convenience. */
  peerId: string;
  /** Where the hub is, as a URL base. Any origin will do; only the path matters. */
  base?: string;
}

export interface HubClient {
  readonly peerId: string;
  redeem(invitationId: string): Promise<Joined>;
  heartbeat(init: {
    seq: number;
    addrs: string[];
    advertisements?: { id: string; kind: string; title: string }[];
    /** Sent as a bearer token where the caller holds one. */
    token?: string;
  }): Promise<Beat>;
  meshView(init?: { token?: string }): Promise<MeshView>;
  revocations(init?: { token?: string }): Promise<DenyList>;
}

export function createHubClient(init: HubClientInit): HubClient {
  const base = init.base ?? "http://hub.local";

  const call = async (
    path: string,
    options: { method?: string; body?: unknown; token?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers();
    if (options.body != null) headers.set("content-type", "application/json");
    if (options.token != null) headers.set("authorization", `Bearer ${options.token}`);
    return await init.fetch(
      new Request(`${base}${path}`, {
        method: options.method ?? "GET",
        headers,
        ...(options.body == null ? {} : { body: JSON.stringify(options.body) }),
      }),
    );
  };

  /** A refusal carries the hub's own reason; throwing it unchanged is what makes the tests legible. */
  const orThrow = async <T>(response: Response, what: string): Promise<T> => {
    if (response.ok) return (await response.json()) as T;
    let reason = `${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error != null) reason = body.error;
    } catch {
      // A non-JSON refusal is still a refusal; the status is the message.
    }
    throw new Error(`${what} refused: ${reason}`);
  };

  return {
    peerId: init.peerId,

    async redeem(invitationId) {
      const response = await call("/.well-known/invite", {
        method: "POST",
        body: { id: invitationId },
      });
      return await orThrow<Joined>(response, "redeem");
    },

    async heartbeat({ seq, addrs, advertisements, token }) {
      const response = await call("/.well-known/presence", {
        method: "POST",
        body: { seq, addrs, ...(advertisements == null ? {} : { advertisements }) },
        ...(token == null ? {} : { token }),
      });
      return await orThrow<Beat>(response, "heartbeat");
    },

    async meshView(options = {}) {
      const response = await call("/.well-known/mesh", options);
      return await orThrow<MeshView>(response, "mesh view");
    },

    async revocations(options = {}) {
      const response = await call("/.well-known/revocations", options);
      return await orThrow<DenyList>(response, "revocations");
    },
  };
}
