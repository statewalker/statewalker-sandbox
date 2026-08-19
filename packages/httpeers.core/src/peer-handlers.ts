/**
 * The binding middleware: asserts the token's subject is the peer the
 * transport handshake actually proved.
 *
 * A hub-minted token is a bearer token, valid at every provider that trusts
 * the hub — so without this check, a malicious provider could replay a
 * member's token against a different provider and act as that member
 * there. Binding `claims.sub` to what the transport itself proved
 * (`getPeerId`, fed by the handshake, never by anything the caller claims)
 * is what defeats that confused-deputy replay.
 *
 * Every seam is injected, so this file has no crypto, no transport and no
 * libp2p import — testable with one-line stubs. It also does no policy:
 * whether a *particular path* is permitted for a given role is
 * `access-tree.ts`'s job, not this one. This middleware only answers "is
 * the caller who they say they are, and is their token still good" — the
 * same class of question as the signature and expiry checks inside
 * `verifyToken`, which is why `isRevoked` lives here rather than with
 * policy.
 */
import { ANONYMOUS, json } from "./types.js";
import type { FetchHandler, GetClaims, GetPeerId, MeshClaims, ProvenPeer, UsesTransportIdentity } from "./types.js";

/**
 * Thrown, not returned as a 401/403, because a missing binding is a bug —
 * something re-created the `Request` above this middleware without calling
 * `copyPeerBinding` — not a legitimate "nobody proven" outcome. Treating it
 * as a denial would make a re-created `Request` look exactly like an
 * anonymous caller, hiding the bug behind a plausible-looking response.
 */
export class PeerBindingLostError extends Error {
  constructor(url: string) {
    super(
      `no peer context registered for ${url} -- a gateway did not register, or the request was re-created above the binding middleware`,
    );
    this.name = "PeerBindingLostError";
  }
}

export interface PeerHandlersInit {
  getPeerId: GetPeerId;
  usesTransportIdentity: UsesTransportIdentity;
  getClaims: GetClaims;
  /**
   * Is this token still good? A reason string refuses the request (and is
   * surfaced in the response, so a refusal explains itself); `null` means
   * fine. Optional — when not supplied, nothing is ever revoked.
   *
   * This asks whether the *token* is still valid, the same class of
   * question as signature and expiry, not whether this path is permitted
   * for it — which is why it is a seam on the binding rather than on
   * policy.
   */
  isRevoked?: (claims: MeshClaims) => Promise<string | null>;
  handleEndpoints: FetchHandler;
}

/**
 * Binding only: the transport-proven peer must equal the token subject,
 * except on a bootstrap request where no token exists yet. Does NOT do
 * policy — see the module comment.
 */
export function newPeerHandlers(init: PeerHandlersInit): FetchHandler {
  const { getPeerId, usesTransportIdentity, getClaims, handleEndpoints } = init;
  const isRevoked = init.isRevoked ?? (async () => null);

  return async function handle(req: Request): Promise<Response> {
    // Widened to `| undefined` on purpose: `GetPeerId` promises `ProvenPeer`
    // and never `undefined`, but that promise is a contract on the caller,
    // not something the type system can enforce for us. A real
    // implementation that breaks it is a bug, and this is the check that
    // catches it rather than silently treating the violation as ANONYMOUS.
    const peer: ProvenPeer | undefined = await getPeerId(req);
    if (peer === undefined) throw new PeerBindingLostError(req.url);

    if (await usesTransportIdentity(req)) {
      if (peer === ANONYMOUS) return json({ error: "proven peer identity required" }, 401);
      return handleEndpoints(req);
    }

    const claims = await getClaims(req);
    if (claims == null) return json({ error: "membership token required" }, 401);
    if (peer === ANONYMOUS) return json({ error: "possession unproven" }, 401);
    if (claims.sub !== peer) return json({ error: "token subject does not match connected peer" }, 403);

    const revoked = await isRevoked(claims);
    if (revoked != null) return json({ error: revoked }, 403);

    return handleEndpoints(req);
  };
}
