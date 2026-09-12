/**
 * 12 — the hub, as nothing but HTTP.
 *
 * THE DIRECTIVE, VERBATIM: "All hub functionalities including invitations,
 * revocations, presence, tokens renewals etc should be implemented as HTTP
 * handlers and the corresponding client calls (with fetch) without implication
 * of libp2p layers. It is up to the adapter to provide access to the
 * underlying peerIds."
 *
 * So this file has no transport import of any kind, and the caller's identity
 * arrives through ONE injected function. The prototype's own hub
 * (`hub/endpoints.ts`) is the same protocol reached through `lookupPeer`, a
 * module-level WeakMap the transport writes — which works, and which makes the
 * hub untestable without a network. Here the same seam is a parameter:
 *
 *     callerOf: (request) => string | undefined
 *
 * On libp2p an adapter fills it from the Noise-proven peer. On a MessagePort
 * or a direct call there is nothing to prove anything with, so it is a claim —
 * and the hub's code does not change either way. What changes is how much the
 * claim is worth, which is a property of the transport and not of the hub.
 *
 * WHAT IS REUSED RATHER THAN REWRITTEN: `hub/hub-state.ts`'s invitation and
 * member logic (single-use ids over a snapshot), and `httpeers.core`'s
 * presence and advertisement stores. Those are proven; the HTTP surface around
 * them is what this rung is for.
 */

import type { Ed25519PrivateKey, RuleSet } from "@statewalker/httpeers.core";
import {
  createAdvertisementStore,
  createPresenceStore,
  roleNames,
} from "@statewalker/httpeers.core";
import { mintToken } from "@statewalker/httpeers.core/tokens";
import type { PersistentHub } from "@statewalker/httpeers-stack/src/hub/hub-state.js";

/** The membership token's lifetime. Short, because the heartbeat renews it. */
const TOKEN_TTL_MS = 60_000;

export interface HubSiteInit {
  /** The mesh id — this hub's own peerId. */
  mesh: string;
  /** The key that mints for this mesh. */
  meshKey: Ed25519PrivateKey;
  state: PersistentHub;
  rules: RuleSet;
  presenceTtlMs?: number;
  clock?: () => number;
  /** THE ADAPTER SEAM. Proof on libp2p, claim elsewhere; the hub cannot tell. */
  callerOf: (request: Request) => string | undefined;
}

export interface MeshViewBody {
  version: number;
  members: { peerId: string; roles: string[]; online: boolean }[];
  advertisements: { peerId: string; id: string; kind: string; title: string }[];
}

export interface HubSite {
  /** The whole protocol. Mount it anywhere a `FetchHandler` goes. */
  handler: (request: Request) => Promise<Response>;
  /** Operator side, in process — not an HTTP route, because nothing remote may mint. */
  invite(init: { roles: string[]; ttlMs?: number; id?: string }): { id: string; expiresAt: number };
  setRoles(peerId: string, roles: string[]): { policyVersion: number };
  remove(peerId: string): { policyVersion: number };
  sweep(): void;
}

export function createHubSite(init: HubSiteInit): HubSite {
  const now = init.clock ?? Date.now;
  const presenceTtlMs = init.presenceTtlMs ?? 15_000;
  const presence = createPresenceStore(now);
  const advertisements = createAdvertisementStore(now);
  const known = new Set(roleNames(init.rules));

  let meshVersion = 1;
  let policyVersion = 1;
  const revoked = new Map<string, number>();

  const bump = (): void => {
    meshVersion += 1;
  };

  const tokenFor = async (peerId: string, roles: readonly string[]): Promise<string> =>
    await mintToken({
      privateKey: init.meshKey,
      sub: peerId,
      roles: [...roles],
      ttlMs: TOKEN_TTL_MS,
      now,
    });

  const refuse = (reason: string, status: number): Response =>
    Response.json({ error: reason }, { status });

  /** Every route needs to know who is calling; none of them may take it from the body. */
  const callerOrRefusal = (request: Request): string | Response => {
    const caller = init.callerOf(request);
    if (caller == null || caller === "") {
      return refuse("anonymous: the transport proved nobody", 401);
    }
    return caller;
  };

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---------------------------------------------------------------- invite
    if (path === "/.well-known/invite" && request.method === "POST") {
      const caller = callerOrRefusal(request);
      if (caller instanceof Response) return caller;

      let body: { id?: string };
      try {
        body = (await request.json()) as { id?: string };
      } catch {
        return refuse("malformed body", 400);
      }
      if (typeof body.id !== "string") return refuse("missing invitation id", 400);

      // The invitation is a bearer secret; the MEMBERSHIP it creates is bound
      // to whoever the transport says is calling, which is why `caller` comes
      // from the seam and never from the body.
      const redemption = init.state.invitations.redeem(body.id);
      if (!redemption.ok) return refuse(`invitation ${redemption.reason}`, 403);

      init.state.memberStore.add(caller, redemption.roles);
      revoked.delete(caller);
      bump();

      return Response.json({
        token: await tokenFor(caller, redemption.roles),
        mesh: init.mesh,
        roles: redemption.roles,
      });
    }

    // -------------------------------------------------------------- presence
    if (path === "/.well-known/presence" && request.method === "POST") {
      const caller = callerOrRefusal(request);
      if (caller instanceof Response) return caller;

      const member = init.state.memberStore.get(caller);
      if (member == null) return refuse("presence not-a-member", 403);

      let body: {
        seq?: number;
        addrs?: string[];
        advertisements?: { id: string; kind: string; title: string }[];
      };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return refuse("malformed body", 400);
      }
      if (typeof body.seq !== "number") return refuse("missing seq", 400);

      const written = presence.heartbeat(caller, body.seq, presenceTtlMs);
      if (!written.accepted) return refuse(`presence ${written.reason}`, 409);

      // Advertisements are re-read from every beat: `[]` withdraws, omission
      // leaves them alone. The prototype's rule, kept.
      if (body.advertisements != null) {
        for (const existing of advertisements.list(caller)) {
          advertisements.withdraw(caller, existing.key);
        }
        for (const ad of body.advertisements) {
          advertisements.post(caller, ad.id, { kind: ad.kind, title: ad.title });
        }
        bump();
      }

      return Response.json({
        token: await tokenFor(caller, member.roles),
        roles: member.roles,
        versions: { mesh: meshVersion, policy: policyVersion },
        ttl: presenceTtlMs,
      });
    }

    // ------------------------------------------------------------------ mesh
    if (path === "/.well-known/mesh" && request.method === "GET") {
      const caller = callerOrRefusal(request);
      if (caller instanceof Response) return caller;
      if (init.state.memberStore.get(caller) == null) return refuse("not-a-member", 403);

      const at = now();
      const body: MeshViewBody = {
        version: meshVersion,
        members: init.state.memberStore.list().map((m) => ({
          peerId: m.peerId,
          roles: [...m.roles],
          online: (presence.get(m.peerId)?.expiresAt ?? 0) > at,
        })),
        advertisements: init.state.memberStore.list().flatMap((m) =>
          advertisements.list(m.peerId).map((ad) => {
            // `Advertisement.payload` is `unknown` in core, deliberately: the
            // store does not care what a peer advertises. The hub is the layer
            // that gives it a shape, so the narrowing belongs here.
            const payload = (ad.payload ?? {}) as { kind?: string; title?: string };
            return {
              peerId: ad.peerId,
              id: ad.key,
              kind: payload.kind ?? "",
              title: payload.title ?? "",
            };
          }),
        ),
      };
      return Response.json(body, { headers: { etag: `"v${meshVersion}"` } });
    }

    // ----------------------------------------------------------- revocations
    if (path === "/.well-known/revocations" && request.method === "GET") {
      const caller = callerOrRefusal(request);
      if (caller instanceof Response) return caller;

      return Response.json(
        {
          version: policyVersion,
          entries: [...revoked.entries()].map(([peerId, changedAt]) => ({ peerId, changedAt })),
        },
        { headers: { etag: `"p${policyVersion}"` } },
      );
    }

    return refuse("no such hub route", 404);
  };

  return {
    handler,

    invite({ roles, ttlMs, id }) {
      // Refused HERE rather than at redemption: an operator who mistypes a
      // role should learn immediately, not when a guest cannot get in.
      for (const role of roles) {
        if (!known.has(role)) throw new Error(`unknown role: ${role}`);
      }
      const invitationId = id ?? globalThis.crypto.randomUUID();
      init.state.invitations.create(invitationId, roles, ttlMs ?? 1_800_000);
      return { id: invitationId, expiresAt: now() + (ttlMs ?? 1_800_000) };
    },

    setRoles(peerId, roles) {
      for (const role of roles) {
        if (!known.has(role)) throw new Error(`unknown role: ${role}`);
      }
      init.state.memberStore.setRoles(peerId, roles);
      // A role change is a revocation of every token already issued: they
      // carry the OLD roles and nothing can recall them.
      revoked.set(peerId, now());
      policyVersion += 1;
      bump();
      return { policyVersion };
    },

    remove(peerId) {
      init.state.memberStore.remove(peerId);
      revoked.set(peerId, now());
      policyVersion += 1;
      bump();
      return { policyVersion };
    },

    sweep() {
      // The store owns expiry; it returns whose records went, which is the
      // only thing that decides whether the mesh view actually changed.
      const gone = presence.sweep();
      if (gone.length > 0) bump();
    },
  };
}
