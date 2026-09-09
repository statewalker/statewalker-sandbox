import { ANONYMOUS, type ProvenPeer, type PeerIdStr, type MeshClaims } from './types.js'

const peers = new WeakMap<Request, ProvenPeer>()
const claims = new WeakMap<Request, MeshClaims | null>()

export function registerPeer (req: Request, peerId: PeerIdStr): void {
  peers.set(req, peerId)
}

export function registerAnonymous (req: Request): void {
  peers.set(req, ANONYMOUS)
}

export function lookupPeer (req: Request): ProvenPeer | undefined {
  return peers.get(req)
}

/** Carry the binding across a deliberate re-creation of the Request. */
export function copyPeerBinding (from: Request, to: Request): void {
  const peer = peers.get(from)
  if (peer !== undefined) peers.set(to, peer)
  if (claims.has(from)) claims.set(to, claims.get(from) ?? null)
}

export function cacheClaims (req: Request, value: MeshClaims | null): void {
  claims.set(req, value)
}

export function lookupClaims (req: Request): MeshClaims | null | undefined {
  return claims.get(req)
}
