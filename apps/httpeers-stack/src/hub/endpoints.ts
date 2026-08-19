/**
 * The hub's `.well-known` surface: registries, invitations, presence and the
 * mesh view. The hub is an ordinary peer (note 03) — nothing here imports
 * libp2p; it is handed a `mintToken` capability already scoped to this
 * peer's own signing key (see `createPeer`'s `mounts` factory in
 * `@statewalker/httpeers.core`), never the key itself.
 *
 * Built on Hono. `app.fetch` is already `(Request) => Promise<Response>`, so
 * it drops straight into the `FetchHandler` contract with no adapter — and
 * `c.req.raw` is the very `Request` the transport (or, in a test, the
 * caller) registered a peer binding on, which is what makes `lookupPeer`
 * and `lookupClaims` work at all from inside a handler.
 *
 * NO QUERY PARAMETERS. Conditional reads use `ETag` / `If-None-Match`, not
 * `?since=`: some transports drop `url.search` before the wire, and ETag is
 * better HTTP regardless.
 */

import type {
  Advertisement,
  AdvertisementStore,
  FetchHandler,
  MemberStore,
  Mounts,
  PeerIdStr,
  PresenceStore,
  RevocationRegistry,
  UsesTransportIdentity,
  Vocabulary,
} from "@statewalker/httpeers.core";
import {
  ANONYMOUS,
  createAdvertisementStore,
  createMounts,
  createPresenceStore,
  expandRoles,
  json,
  lookupClaims,
  lookupPeer,
} from "@statewalker/httpeers.core";
import { Hono } from "hono";
import type { AdvertisementPayload } from "./mesh-view.js";
import { buildMeshView } from "./mesh-view.js";
import type { InvitationStore } from "./persist.js";

/** The capability that grants admin visibility — sees `hidden` members and, in a later task, `/admin/*`. */
export const ADMIN_CAPABILITY = "std:mesh.admin";

/** Presence TTL: an entry not refreshed within this window is swept. */
export const DEFAULT_PRESENCE_TTL_MS = 15_000;

/** Exactly two handlers, method-aware: a presence WRITE is bootstrap, a read is not. */
export function usesTransportIdentity(): UsesTransportIdentity {
  return async (req: Request) => {
    if (req.method !== "POST") return false;
    const { pathname } = new URL(req.url);
    return pathname === "/.well-known/invite" || pathname === "/.well-known/presence";
  };
}

export interface HubEndpointsInit {
  selfPeerId: PeerIdStr;
  mintToken: (sub: string, roles: string[], ttlMs?: number) => Promise<string>;
  memberStore: MemberStore;
  invitations: InvitationStore;
  vocabulary: Vocabulary;
  revocations: RevocationRegistry;
  /** `kind` -> capability required to see advertisements of that kind. Defaults to `{}` (no kind gated). */
  advertisementAccess?: Record<string, string>;
  presenceTtlMs?: number;
  now?: () => number;
}

export interface HubEndpoints {
  mounts: Mounts;
  /** Expire stale presence and the advertisements that rode along with it; bumps the mesh version only if something actually left. Call on a timer (production) or directly with a controlled clock (tests). */
  sweep: () => void;
}

interface PresenceBody {
  seq: number;
  addrs: string[];
  advertisements?: Array<{ id: string; kind: string; title: string }>;
}

function sameAddrs(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (a == null) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function sameAdvertisements(
  prev: Advertisement[],
  next: ReadonlyArray<{ id: string; kind: string; title: string }>,
): boolean {
  if (prev.length !== next.length) return false;
  const prevById = new Map(prev.map((a) => [a.key, a.payload as AdvertisementPayload]));
  return next.every((ad) => {
    const p = prevById.get(ad.id);
    return p != null && p.kind === ad.kind && p.title === ad.title;
  });
}

export function createHubEndpoints(init: HubEndpointsInit): HubEndpoints {
  const now = init.now ?? Date.now;
  const presenceTtlMs = init.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS;
  const advertisementAccess = init.advertisementAccess ?? {};

  const presenceStore: PresenceStore = createPresenceStore(now);
  const advertisementStore: AdvertisementStore = createAdvertisementStore(now);
  const addrsByPeer = new Map<PeerIdStr, string[]>();

  // Tracks the highest `seq` EVER accepted for a peer, independent of
  // `presenceStore` — which the TTL sweep clears. Without this, a delayed
  // duplicate of an old heartbeat arriving AFTER the peer has already been
  // swept would look like a brand-new write (no record exists to compare
  // against) and resurrect a peer that has genuinely departed. This map is
  // never cleared by sweep, only ever advanced.
  const lastSeqByPeer = new Map<PeerIdStr, number>();

  // The one counter this whole module exists to bump correctly: it moves
  // only when the OBSERVABLE mesh view could have changed (a member added,
  // a peer's online/addrs state changed, an advertisement changed, or the
  // sweep removed someone) — never on a heartbeat that repeats what the hub
  // already knew, which is what keeps `/.well-known/mesh`'s ETag stable
  // between identical heartbeats instead of churning every 5 s.
  let meshVersion = 1;
  const bumpMesh = (): void => {
    meshVersion++;
  };

  const claimsOf = (req: Request) => lookupClaims(req) ?? null;
  const provenPeer = (req: Request): PeerIdStr => {
    const peer = lookupPeer(req);
    if (peer === undefined || peer === ANONYMOUS) {
      throw new Error("hub bootstrap handler reached without a transport-proven peer");
    }
    return peer;
  };

  const withdrawAllFor = (peerId: PeerIdStr): void => {
    for (const ad of advertisementStore.list(peerId)) advertisementStore.withdraw(peerId, ad.key);
  };

  const app = new Hono();

  // --- BOOTSTRAP: no token exists yet ---------------------------------------

  app.post("/.well-known/invite", async (c) => {
    const peerId = provenPeer(c.req.raw);
    const { id } = await c.req.json<{ id: string }>();

    const redemption = init.invitations.redeem(id);
    if (!redemption.ok) {
      return json({ error: `invitation ${redemption.reason}` }, 403);
    }

    init.memberStore.add(peerId, redemption.roles);
    bumpMesh();

    return json({
      token: await init.mintToken(peerId, redemption.roles),
      mesh: init.selfPeerId,
      roles: redemption.roles,
    });
  });

  // --- BOOTSTRAP: mints the token, so cannot itself require one -------------

  app.post("/.well-known/presence", async (c) => {
    const peerId = provenPeer(c.req.raw);
    const member = init.memberStore.get(peerId);
    if (member == null) return json({ error: "not a member" }, 403);

    const body = await c.req.json<PresenceBody>();

    const lastSeq = lastSeqByPeer.get(peerId);
    if (lastSeq !== undefined && body.seq <= lastSeq) {
      return json({ error: "stale-sequence" }, 409);
    }
    lastSeqByPeer.set(peerId, body.seq);

    const wasPresent = presenceStore.isPresent(peerId);
    const prevAddrs = addrsByPeer.get(peerId);
    presenceStore.heartbeat(peerId, body.seq, presenceTtlMs);
    addrsByPeer.set(peerId, body.addrs);

    let changed = !wasPresent || !sameAddrs(prevAddrs, body.addrs);

    if (body.advertisements !== undefined) {
      const prevAds = advertisementStore.list(peerId);
      if (!sameAdvertisements(prevAds, body.advertisements)) {
        withdrawAllFor(peerId);
        for (const ad of body.advertisements) {
          const payload: AdvertisementPayload = { kind: ad.kind, title: ad.title };
          advertisementStore.post(peerId, ad.id, payload);
        }
        changed = true;
      }
    }

    if (changed) bumpMesh();

    return json({
      token: await init.mintToken(peerId, member.roles),
      versions: {
        mesh: meshVersion,
        policy: init.revocations.policyVersion(),
        vocabulary: init.vocabulary.version,
      },
    });
  });

  // --- ORDINARY: identity comes from the verified token ----------------------

  app.get("/.well-known/members", (_c) => json({ members: init.memberStore.list() }));

  app.get("/.well-known/presence", (_c) =>
    json({
      presence: presenceStore.list().map((p) => ({ ...p, addrs: addrsByPeer.get(p.peerId) ?? [] })),
    }),
  );

  app.get("/.well-known/advertisements", (_c) =>
    json({
      advertisements: advertisementStore.list().map((ad) => {
        const payload = ad.payload as AdvertisementPayload;
        return { peerId: ad.peerId, id: ad.key, kind: payload.kind, title: payload.title };
      }),
    }),
  );

  app.get("/.well-known/mesh", (c) => {
    const claims = claimsOf(c.req.raw);
    if (claims == null) return json({ error: "unauthenticated" }, 401);

    const etag = `"v${meshVersion}"`;
    if (c.req.header("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }

    const callerCapabilities = expandRoles(init.vocabulary, claims.roles);
    const view = buildMeshView({
      version: meshVersion,
      self: claims.sub,
      members: init.memberStore.list(),
      presence: presenceStore.list(),
      addrsByPeer,
      advertisements: advertisementStore.list(),
      callerCapabilities,
      advertisementAccess,
      adminCapability: ADMIN_CAPABILITY,
    });

    return new Response(JSON.stringify(view), {
      headers: { "content-type": "application/json", etag },
    });
  });

  app.get("/.well-known/vocabulary", (c) => {
    const etag = `"vocab${init.vocabulary.version}"`;
    if (c.req.header("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(JSON.stringify(init.vocabulary), {
      headers: { "content-type": "application/json", etag },
    });
  });

  app.get("/.well-known/revocations", (c) => {
    const version = init.revocations.policyVersion();
    const etag = `"policy${version}"`;
    if (c.req.header("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(JSON.stringify({ version, entries: init.revocations.list() }), {
      headers: { "content-type": "application/json", etag },
    });
  });

  app.all("*", (c) => json({ error: "not found", path: new URL(c.req.raw.url).pathname }, 404));

  const mounts = createMounts();
  mounts.provide("/.well-known", app.fetch as FetchHandler);

  return {
    mounts,
    sweep() {
      const expired = presenceStore.sweep();
      if (expired.length === 0) return;
      for (const peerId of expired) {
        addrsByPeer.delete(peerId);
        withdrawAllFor(peerId);
      }
      bumpMesh();
    },
  };
}
