export type FetchHandler = (req: Request) => Promise<Response>
export type PeerIdStr = string

export const ANONYMOUS = Symbol.for('httpeers.anonymous')
export type Anonymous = typeof ANONYMOUS
export type ProvenPeer = PeerIdStr | Anonymous

export interface MeshClaims {
  sub: PeerIdStr
  iss: PeerIdStr
  mesh: PeerIdStr
  roles: string[]
  exp: number
}

export type GetPeerId = (req: Request) => Promise<ProvenPeer>
export type IsTrustedPath = (req: Request) => Promise<boolean>
export type GetClaims = (req: Request) => Promise<MeshClaims | null>

/** Injected by the transport. Never imported by the core. */
export type Remote = (peerId: PeerIdStr, req: Request) => Promise<Response>

export interface Mounts {
  match: (path: string) => FetchHandler | null
}

export function json (body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' }
  })
}
