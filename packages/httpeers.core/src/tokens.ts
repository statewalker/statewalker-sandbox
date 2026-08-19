/**
 * Membership tokens: minting and verification.
 *
 * A token is a compact JWS — `base64url(header).base64url(payload)
 * .base64url(signature)` — signed EdDSA over Ed25519, carrying a
 * `MeshClaims` payload. No `jose` dependency: the encoder/decoder below is
 * the whole spec this package needs, and `@libp2p/crypto` / `@libp2p/peer-id`
 * already own the Ed25519 primitives and peerId↔public-key recovery.
 *
 * The verification chain, in order:
 *   0. assert `claims.mesh === claims.iss` — a token may only self-certify
 *      membership in the mesh it was itself issued by;
 *   1. recover the issuer's public key from `claims.mesh` (the peerId) —
 *      Ed25519 only, so this is a local computation, never a fetch;
 *   2. verify the signature, then check expiry;
 *   3. assert `claims.mesh === policy.issuer` — the token belongs to the
 *      mesh this verifier actually expects.
 * `claims.sub === provenPeer` (did the transport handshake prove the caller
 * is the subject) is left to the binding middleware — a later task.
 */
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { peerIdFromPrivateKey, peerIdFromString } from "@libp2p/peer-id";
import type { MeshClaims } from "./types.js";

/** The only algorithm and token type this package will mint or accept. */
const ALG = "EdDSA" as const;
const TYP = "httpeers-membership+jwt" as const;

interface Header {
  alg: typeof ALG;
  typ: typeof TYP;
}

/** Raised for any reason a token fails to verify. `reason` is stable and matchable. */
export class TokenVerificationError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`httpeers token rejected: ${reason}`);
    this.name = "TokenVerificationError";
    this.reason = reason;
  }
}

export interface MintTokenOptions {
  /** The hub's own signing key. `iss` and `mesh` are both set to this key's peerId. */
  privateKey: Ed25519PrivateKey;
  /** peerId of the member the token is minted for. */
  sub: string;
  roles: string[];
  /** Time-to-live from mint time, in milliseconds. */
  ttlMs: number;
  /** Injected clock, for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Mint a signed membership token. `mesh` (and `iss`) are always derived from
 * `privateKey`'s own peerId — a hub can only ever mint tokens that
 * self-certify as its own, never forge membership in some other mesh.
 */
export async function mintToken(options: MintTokenOptions): Promise<string> {
  const now = options.now ?? Date.now;
  const iat = now();
  const hubPeerId = peerIdFromPrivateKey(options.privateKey).toString();

  const claims: MeshClaims = {
    sub: options.sub,
    iss: hubPeerId,
    mesh: hubPeerId,
    roles: options.roles,
    iat,
    exp: iat + options.ttlMs,
  };

  return signCompact(claims, options.privateKey);
}

async function signCompact(claims: MeshClaims, privateKey: Ed25519PrivateKey): Promise<string> {
  const header: Header = { alg: ALG, typ: TYP };
  const encodedHeader = encodeSegment(header);
  const encodedPayload = encodeSegment(claims);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await privateKey.sign(new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64urlEncode(signature)}`;
}

export interface VerifyTokenOptions {
  /** The mesh (hub peerId) this verifier expects the token to belong to. */
  issuer: string;
  /** Injected clock, for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Verify a compact-JWS membership token, per the chain documented above. */
export async function verifyToken(token: string, options: VerifyTokenOptions): Promise<MeshClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new TokenVerificationError("malformed token");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  const header = decodeSegment<Partial<Header>>(encodedHeader, "malformed header");
  if (header.typ !== TYP || header.alg !== ALG) {
    throw new TokenVerificationError("wrong token type or algorithm");
  }

  const claims = decodeSegment<MeshClaims>(encodedPayload, "malformed payload");

  // Self-certification: the token's issuer and its mesh must be the same
  // peerId. `mintToken` always sets them equal; this rejects any validly
  // signed token whose issuer claims membership in a mesh other than its
  // own — nothing else checks `claims.iss` against `claims.mesh`.
  if (claims.mesh !== claims.iss) {
    throw new TokenVerificationError("mesh does not match issuer");
  }

  // Step 1: recover the issuer's key from the peerId. Ed25519 only — the
  // public key must be inlined in the peerId's identity multihash, so this
  // never requires a fetch. Any other key type (or an RSA-style sha2-256
  // peerId that carries no embedded key) is rejected here.
  let issuerPeerId: ReturnType<typeof peerIdFromString>;
  try {
    issuerPeerId = peerIdFromString(claims.mesh);
  } catch {
    throw new TokenVerificationError("issuer peerId is not parseable");
  }
  if (issuerPeerId.type !== "Ed25519") {
    throw new TokenVerificationError("issuer peerId does not carry an inline Ed25519 public key");
  }

  // Step 2: signature, then expiry.
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  let signature: Uint8Array;
  try {
    signature = base64urlDecode(encodedSignature);
  } catch {
    throw new TokenVerificationError("malformed signature");
  }
  const valid = await issuerPeerId.publicKey.verify(signingInput, signature);
  if (!valid) {
    throw new TokenVerificationError("invalid signature");
  }

  const now = options.now ?? Date.now;
  if (now() >= claims.exp) {
    throw new TokenVerificationError("token expired");
  }

  // Step 3: self-certification — the claimed mesh must be the mesh the
  // caller actually expects to be talking to.
  if (claims.mesh !== options.issuer) {
    throw new TokenVerificationError("token was not minted for this mesh");
  }

  return claims;
}

function encodeSegment(value: unknown): string {
  return base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeSegment<T>(segment: string, onError: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64urlDecode(segment))) as T;
  } catch {
    throw new TokenVerificationError(onError);
  }
}

// Web-standard base64url (RFC 4648 §5), built on `btoa`/`atob` rather than
// Node's `Buffer` — this package targets any JS runtime a peer can run in,
// not just Node.
function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
