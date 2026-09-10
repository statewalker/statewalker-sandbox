/**
 * The two roles, and the one thing they exchange.
 *
 * A HUB IS AN ORDINARY PEER. It runs the same `startPeer` as everyone else
 * and differs only in the routes it serves. Nothing here is privileged by
 * the transport: a browser tab is a hub because it says it is and because
 * others were handed a join blob naming it. That is the property the test
 * exists to demonstrate — "server" is a role a tab can hold, not a machine
 * you have to own.
 *
 * MEMBERSHIP IS RECORDED AGAINST THE PROVEN PEER ID, never against anything
 * in the request body. `serveConnections` hands the handler the peer id
 * libp2p's Noise handshake established for that connection, so a guest
 * cannot claim to be another guest by writing a different id into its
 * JSON. Every check below reads `callerPeerId`, which is that value.
 *
 * INVITATIONS ARE SINGLE-USE, and the spent check runs first and
 * unconditionally. A blob shared between two guests admits exactly one and
 * fails the other with `already-redeemed`. That is not a limitation to work
 * around by reusing ids — it is the property that makes a blob safe to send
 * over a channel you do not fully trust, because a redeemed one is inert.
 *
 * WHAT THIS IS NOT. There are no tokens, no capabilities and no policy
 * evaluation here. `httpeers.core` has all three and this test deliberately
 * does not reimplement them: the claim under test is that two tabs can
 * reach each other through a public relay and exchange resources, and
 * mixing an authorization model into that would mean a failure could be
 * either thing. Membership is a set of proven peer ids, and that is enough
 * to answer "may this caller use this resource".
 */

import { type Peer, type PeerHandler, json } from "./mesh.js";

/** Everything a guest needs to reach a hub, in one copyable string. */
export interface JoinBlob {
  /**
   * The relay both peers meet on, in the same form the hub was given: a URL
   * (`https://relay.httpeers.net`) or a multiaddr.
   *
   * The URL is carried rather than the resolved multiaddr on purpose. A relay
   * that is redeployed keeps its URL and may change nothing else, but a blob
   * holding a resolved address would pin whatever the document said at the
   * moment it was minted. Carrying the source means the guest resolves for
   * itself and cannot inherit a stale answer.
   */
  relay: string;
  /** The hub's full dialable address, `/p2p/<hubPeerId>` included. */
  hubAddress: string;
  /** Single-use. */
  invitationId: string;
}

/**
 * base64url of JSON, carried in a `?join=` query parameter.
 *
 * Two properties matter and no others: it survives a copy-paste through a
 * terminal, a chat window and an address bar without quoting (base64url's
 * alphabet is URL-safe and none of it is shell-special), and it is one
 * token, so nobody can paste half of it. It is not encryption — anyone
 * holding the blob can redeem the invitation inside it, which is precisely
 * what an invitation is.
 */
export function encodeJoinBlob(blob: JoinBlob): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(blob)));
}

export function decodeJoinBlob(encoded: string): JoinBlob {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded))) as JoinBlob;
}

export interface Advertisement {
  /** The advertising peer's full dialable address. */
  address: string;
  /** What it offers, e.g. "echo". */
  kind: string;
  /** The path that offer is served at. */
  path: string;
}

export interface HubState {
  /** Proven peer ids admitted so far. */
  members: Set<string>;
  /** Invitation ids not yet redeemed. */
  openInvitations: Set<string>;
  /** Invitation ids already redeemed — checked first, always. */
  spentInvitations: Set<string>;
  /** What members have said they offer, keyed by proven peer id. */
  advertisements: Map<string, Advertisement>;
}

export function newHubState(): HubState {
  return {
    members: new Set(),
    openInvitations: new Set(),
    spentInvitations: new Set(),
    advertisements: new Map(),
  };
}

/** Mints an invitation. Each guest needs its own — see the module comment. */
export function mintInvitation(state: HubState): string {
  const id = randomId();
  state.openInvitations.add(id);
  return id;
}

/**
 * The hub's routes.
 *
 *   POST /.well-known/invite     redeem an invitation, become a member
 *   POST /.well-known/advertise  members only: say what you offer
 *   GET  /.well-known/mesh       members only: who is here, and what they offer
 *   GET  /hello                  members only: a resource the hub itself serves
 */
export function hubHandler(state: HubState, hubName: string): PeerHandler {
  return async (request, callerPeerId) => {
    const url = new URL(request.url);

    if (url.pathname === "/.well-known/invite" && request.method === "POST") {
      const body = (await request.json()) as { invitationId?: string; address?: string };
      const id = body.invitationId ?? "";

      // Spent first, unconditionally: a redeemed id must fail the same way
      // forever, whether or not it was ever valid.
      if (state.spentInvitations.has(id)) return json({ error: "already-redeemed" }, 403);
      if (!state.openInvitations.has(id)) return json({ error: "unknown-invitation" }, 403);

      state.openInvitations.delete(id);
      state.spentInvitations.add(id);
      state.members.add(callerPeerId);

      return json({ ok: true, member: callerPeerId, hub: hubName });
    }

    if (!state.members.has(callerPeerId)) {
      return json({ error: "not-a-member", caller: callerPeerId }, 403);
    }

    if (url.pathname === "/.well-known/advertise" && request.method === "POST") {
      const ad = (await request.json()) as Advertisement;
      state.advertisements.set(callerPeerId, ad);
      return json({ ok: true });
    }

    if (url.pathname === "/.well-known/mesh") {
      return json({
        hub: hubName,
        members: [...state.members],
        advertisements: [...state.advertisements.entries()].map(([peerId, ad]) => ({
          peerId,
          ...ad,
        })),
      });
    }

    if (url.pathname === "/hello") {
      return json({ from: hubName, greeting: `hello, ${callerPeerId}` });
    }

    return json({ error: "not-found", path: url.pathname }, 404);
  };
}

/**
 * A guest's routes: one resource it offers back to the mesh.
 *
 * The point of `/echo` is symmetry. A guest that only consumed would prove
 * a client/server split the architecture explicitly does not have — every
 * peer serves and calls through the same code, so the hub calling the guest
 * must work exactly as well as the guest calling the hub.
 */
export function guestHandler(guestName: string): PeerHandler {
  return async (request, callerPeerId) => {
    const url = new URL(request.url);
    if (url.pathname === "/echo" && request.method === "POST") {
      const body = (await request.json()) as { message?: string };
      return json({ from: guestName, echoed: body.message ?? "", caller: callerPeerId });
    }
    return json({ error: "not-found", path: url.pathname }, 404);
  };
}

/** Redeem an invitation and advertise what this peer offers. */
export async function joinMesh(
  peer: Peer,
  blob: JoinBlob,
  advertisement: Omit<Advertisement, "address">,
): Promise<{ hub: string }> {
  const redeemed = await peer.fetch(
    blob.hubAddress,
    new Request("http://hub/.well-known/invite", {
      method: "POST",
      body: JSON.stringify({ invitationId: blob.invitationId, address: peer.address }),
    }),
  );
  const result = (await redeemed.json()) as { ok?: boolean; error?: string; hub?: string };
  if (redeemed.status !== 200 || result.ok !== true) {
    throw new Error(`join refused: ${result.error ?? redeemed.status}`);
  }

  await peer.fetch(
    blob.hubAddress,
    new Request("http://hub/.well-known/advertise", {
      method: "POST",
      body: JSON.stringify({ ...advertisement, address: peer.address }),
    }),
  );

  return { hub: result.hub ?? "hub" };
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(encoded: string): Uint8Array {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
