import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { base58btc } from "multiformats/bases/base58";
import { sha256 } from "multiformats/hashes/sha2";
import { beforeAll, describe, expect, it } from "vitest";
import { mintToken, TokenVerificationError, verifyToken } from "../src/tokens.js";

const TYP = "httpeers-membership+jwt";
const ALG = "EdDSA";

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Build a raw compact-JWS by hand, so tests can forge fields mintToken never lets you set. */
async function buildRawToken(
  header: unknown,
  payload: unknown,
  signer: Ed25519PrivateKey,
): Promise<string> {
  const encodedHeader = b64url(new TextEncoder().encode(JSON.stringify(header)));
  const encodedPayload = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = await signer.sign(signingInput);
  return `${encodedHeader}.${encodedPayload}.${b64url(signature)}`;
}

describe("tokens", () => {
  let hubKey: Ed25519PrivateKey;
  let hubPeerId: string;
  let otherKey: Ed25519PrivateKey;
  let otherPeerId: string;

  beforeAll(async () => {
    hubKey = await generateKeyPair("Ed25519");
    hubPeerId = peerIdFromPrivateKey(hubKey).toString();
    otherKey = await generateKeyPair("Ed25519");
    otherPeerId = peerIdFromPrivateKey(otherKey).toString();
  });

  it("mints and verifies a round trip", async () => {
    const now = () => 1_000_000;
    const token = await mintToken({
      privateKey: hubKey,
      sub: "member-peer-id",
      roles: ["read", "write"],
      ttlMs: 60_000,
      now,
    });

    const claims = await verifyToken(token, { issuer: hubPeerId, now });

    expect(claims.sub).toBe("member-peer-id");
    expect(claims.iss).toBe(hubPeerId);
    expect(claims.mesh).toBe(hubPeerId);
    expect(claims.roles).toEqual(["read", "write"]);
    expect(claims.iat).toBe(1_000_000);
    expect(claims.exp).toBe(1_060_000);
  });

  it("every minted token carries iat", async () => {
    const now = () => 42;
    const token = await mintToken({
      privateKey: hubKey,
      sub: "member-peer-id",
      roles: [],
      ttlMs: 1_000,
      now,
    });

    const claims = await verifyToken(token, { issuer: hubPeerId, now });

    expect(claims.iat).toBe(42);
  });

  it("rejects a token signed by a different key", async () => {
    const now = () => 1_000_000;
    const payload = {
      sub: "member-peer-id",
      iss: hubPeerId,
      mesh: hubPeerId,
      roles: ["read"],
      iat: now(),
      exp: now() + 60_000,
    };
    // Claims say "signed by the hub", but the signature is actually
    // produced by a different key.
    const forged = await buildRawToken({ alg: ALG, typ: TYP }, payload, otherKey);

    await expect(verifyToken(forged, { issuer: hubPeerId, now })).rejects.toThrow(
      /invalid signature/,
    );
  });

  it("rejects an expired token", async () => {
    let time = 1_000_000;
    const clock = () => time;
    const token = await mintToken({
      privateKey: hubKey,
      sub: "member-peer-id",
      roles: [],
      ttlMs: 1_000,
      now: clock,
    });

    time = 1_002_000; // past exp
    await expect(verifyToken(token, { issuer: hubPeerId, now: clock })).rejects.toThrow(
      /expired/,
    );
  });

  it("rejects claims.mesh !== issuer (the self-certification check)", async () => {
    const now = () => 1_000_000;
    const token = await mintToken({
      privateKey: hubKey,
      sub: "member-peer-id",
      roles: [],
      ttlMs: 60_000,
      now,
    });

    // The token is validly signed by the hub for the hub's own mesh, but
    // the verifier expects a *different* mesh.
    await expect(verifyToken(token, { issuer: otherPeerId, now })).rejects.toThrow(
      /not minted for this mesh/,
    );
  });

  it("rejects an RSA-derived peerId as issuer", async () => {
    // A real RSA peerId is a base58btc-encoded sha2-256 multihash of the
    // public key (too large to inline, unlike Ed25519). We don't need a
    // real RSA key to prove the rejection: any sha2-256 multihash produces
    // a peerId with no embedded public key, which is exactly what
    // verifyToken must refuse.
    const digest = await sha256.digest(new TextEncoder().encode("not-an-ed25519-key"));
    const rsaLikePeerId = base58btc.encode(digest.bytes).slice(1); // drop the multibase 'z' prefix

    const now = () => 1_000_000;
    const payload = {
      sub: "member-peer-id",
      iss: rsaLikePeerId,
      mesh: rsaLikePeerId,
      roles: ["read"],
      iat: now(),
      exp: now() + 60_000,
    };
    const token = await buildRawToken({ alg: ALG, typ: TYP }, payload, hubKey);

    await expect(verifyToken(token, { issuer: rsaLikePeerId, now })).rejects.toThrow(
      /Ed25519/,
    );
  });

  it("rejects a token whose typ header does not match", async () => {
    const now = () => 1_000_000;
    const payload = {
      sub: "member-peer-id",
      iss: hubPeerId,
      mesh: hubPeerId,
      roles: [],
      iat: now(),
      exp: now() + 60_000,
    };
    const token = await buildRawToken({ alg: ALG, typ: "some-other-jwt" }, payload, hubKey);

    await expect(verifyToken(token, { issuer: hubPeerId, now })).rejects.toThrow(
      /type or algorithm/,
    );
  });

  it("rejects a token whose signature segment is malformed base64url, without leaking a raw exception", async () => {
    const now = () => 1_000_000;
    const payload = {
      sub: "member-peer-id",
      iss: hubPeerId,
      mesh: hubPeerId,
      roles: [],
      iat: now(),
      exp: now() + 60_000,
    };
    const encodedHeader = b64url(new TextEncoder().encode(JSON.stringify({ alg: ALG, typ: TYP })));
    const encodedPayload = b64url(new TextEncoder().encode(JSON.stringify(payload)));
    // "!!!" is not valid base64url — atob() throws a raw DOMException/SyntaxError
    // on input like this if it isn't caught.
    const malformed = `${encodedHeader}.${encodedPayload}.!!!not-base64!!!`;

    await expect(verifyToken(malformed, { issuer: hubPeerId, now })).rejects.toBeInstanceOf(
      TokenVerificationError,
    );
    await expect(verifyToken(malformed, { issuer: hubPeerId, now })).rejects.toThrow(
      /malformed signature/,
    );
  });

  it("rejects a token whose iss does not match its mesh", async () => {
    const now = () => 1_000_000;
    const payload = {
      sub: "member-peer-id",
      iss: otherPeerId, // the signer claims to be otherPeerId...
      mesh: hubPeerId, // ...but claims membership in the hub's mesh
      roles: [],
      iat: now(),
      exp: now() + 60_000,
    };
    // Signed with the hub's own key, so the signature itself would verify
    // fine against `mesh` (hubPeerId) — only the mesh === iss invariant
    // should catch this.
    const token = await buildRawToken({ alg: ALG, typ: TYP }, payload, hubKey);

    await expect(verifyToken(token, { issuer: hubPeerId, now })).rejects.toThrow(
      /mesh does not match issuer/,
    );
  });
});
