/**
 * The token layer, over Biscuit (ADR-0019).
 *
 * Rewritten from the compact-JWS suite this replaces. The PROPERTIES carried
 * over unchanged — round trip, wrong key, expiry, self-certification, an issuer
 * whose peerId carries no inline key, malformed input, a forged mesh — because
 * they are properties of the token layer, not of JWS. What is gone is anything
 * that asserted the JWS ENCODING (a `typ`/`alg` header, three dot-separated
 * segments); what is new is what only Biscuit can be asked: the binding as
 * Datalog, an appended block that cannot widen a token, the evaluation budget,
 * and Datalog injection.
 *
 * Every token here is serialised to base64 and re-parsed against a root key
 * recovered from a peerId string, so every assertion is made over real bytes
 * and a real signature — never an in-memory object handed around.
 */
import {
  Biscuit,
  BiscuitBuilder,
  BlockBuilder,
  KeyPair,
  PrivateKey,
  PublicKey,
  SignatureAlgorithm,
} from "@biscuit-auth/biscuit-wasm";
import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { base58btc } from "multiformats/bases/base58";
import { sha256 } from "multiformats/hashes/sha2";
import { beforeAll, describe, expect, it } from "vitest";
import { mintToken, TokenVerificationError, verifyToken } from "../src/tokens.js";
import { ANONYMOUS } from "../src/types.js";

const MEMBER = "12D3KooWMemberPeerIdForTests";

/** The same bridge `tokens.ts` uses, so hand-built tokens sign as the hub does. */
function biscuitKeyOf(key: Ed25519PrivateKey): PrivateKey {
  return PrivateKey.fromBytes(key.raw.slice(0, 32), SignatureAlgorithm.Ed25519);
}

function rootKeyOf(key: Ed25519PrivateKey): PublicKey {
  return PublicKey.fromBytes(key.publicKey.raw, SignatureAlgorithm.Ed25519);
}

/** Append a plain block to a token — what any peer holding the bytes can do. */
function appendBlock(token: string, hubKey: Ed25519PrivateKey, code: string): string {
  const block = new BlockBuilder();
  block.addCode(code);
  return Biscuit.fromBase64(token, rootKeyOf(hubKey)).appendBlock(block).toBase64();
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

  // -------------------------------------------------------------------------
  // The key bridge — why verification needs no fetch
  // -------------------------------------------------------------------------

  describe("mesh identity", () => {
    it("the key Biscuit signs with derives to the peerId's own public key", () => {
      // This is what makes `mesh === iss === the hub's peerId` hold, and with
      // it the whole offline-verification property: the root key a verifier
      // needs is recoverable from the mesh id alone. If libp2p's Ed25519 `raw`
      // layout ever stops being seed-then-public-key, this fails here rather
      // than as an inexplicable signature error somewhere downstream.
      const derived = new Uint8Array(32);
      KeyPair.fromPrivateKey(biscuitKeyOf(hubKey)).getPublicKey().toBytes(derived);
      expect([...derived]).toEqual([...hubKey.publicKey.raw]);
    });

    it("a token self-certifies against the mesh it was minted by", async () => {
      const token = await mintToken({
        privateKey: hubKey,
        sub: MEMBER,
        roles: [],
        ttlMs: 60_000,
        now: () => 1_000_000,
      });
      // Parsing with a key recovered from the hub's peerId string — no fetch,
      // no JWKS, no directory.
      expect(() => Biscuit.fromBase64(token, rootKeyOf(hubKey))).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Round trip
  // -------------------------------------------------------------------------

  describe("mint and verify", () => {
    it("mints and verifies a round trip", async () => {
      const now = () => 1_000_000;
      const token = await mintToken({
        privateKey: hubKey,
        sub: MEMBER,
        roles: ["read", "write"],
        ttlMs: 60_000,
        now,
      });

      const claims = await verifyToken(token, {
        issuer: hubPeerId,
        connectionPeer: MEMBER,
        now,
      });

      expect(claims.sub).toBe(MEMBER);
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
        sub: MEMBER,
        roles: [],
        ttlMs: 1_000,
        now,
      });

      const claims = await verifyToken(token, {
        issuer: hubPeerId,
        connectionPeer: MEMBER,
        now,
      });

      expect(claims.iat).toBe(42);
    });

    it("iat and exp survive at MILLISECOND resolution", async () => {
      // `revocation.ts` orders `claims.iat` against a hub-issued `changedAt`,
      // and `clock.ts`'s `createMonotonicClock` exists because a tie there was
      // a real bypass. Two tokens minted a single millisecond apart must come
      // back a single millisecond apart: routing time through Biscuit's
      // second-resolution date terms would silently collapse them.
      const first = await mintToken({
        privateKey: hubKey,
        sub: MEMBER,
        roles: [],
        ttlMs: 60_000,
        now: () => 1_755_772_800_123,
      });
      const second = await mintToken({
        privateKey: hubKey,
        sub: MEMBER,
        roles: [],
        ttlMs: 60_000,
        now: () => 1_755_772_800_124,
      });

      const verify = (token: string) =>
        verifyToken(token, {
          issuer: hubPeerId,
          connectionPeer: MEMBER,
          now: () => 1_755_772_800_500,
        });

      expect((await verify(first)).iat).toBe(1_755_772_800_123);
      expect((await verify(second)).iat).toBe(1_755_772_800_124);
      expect((await verify(second)).iat - (await verify(first)).iat).toBe(1);
    });

    it("roles come back as a deterministic set, not in mint order", async () => {
      // Datalog facts ARE a set: `role("a"); role("a")` is one fact and mint
      // order is not recoverable. Documented here rather than discovered later,
      // because it is a real difference from the JSON array JWS carried.
      const now = () => 1_000_000;
      const token = await mintToken({
        privateKey: hubKey,
        sub: MEMBER,
        roles: ["write", "read", "write"],
        ttlMs: 60_000,
        now,
      });

      const claims = await verifyToken(token, {
        issuer: hubPeerId,
        connectionPeer: MEMBER,
        now,
      });

      expect(claims.roles).toEqual(["read", "write"]);
    });

    it("a role or subject containing Datalog syntax is inert", async () => {
      // Every value reaches the Datalog as a bound parameter, never as source
      // text. Interpolation here would let a hub that admits an attacker-chosen
      // name write arbitrary facts into its own authority block.
      const now = () => 1_000_000;
      const injected = '"); role("admin"); x("';
      const token = await mintToken({
        privateKey: hubKey,
        sub: MEMBER,
        roles: [injected],
        ttlMs: 60_000,
        now,
      });

      const claims = await verifyToken(token, {
        issuer: hubPeerId,
        connectionPeer: MEMBER,
        now,
      });

      expect(claims.roles).toEqual([injected]);
      expect(claims.roles).not.toContain("admin");
    });
  });

  // -------------------------------------------------------------------------
  // The binding (ADR-0009) — now a check inside the token
  // -------------------------------------------------------------------------

  describe("binding", () => {
    it("refuses a token presented over a connection that proved a DIFFERENT peer", async () => {
      const now = () => 1_000_000;
      const token = await mintToken({
        privateKey: hubKey,
        sub: MEMBER,
        roles: ["read"],
        ttlMs: 60_000,
        now,
      });

      // Mallory holds Alice's genuine, unexpired, correctly-signed token. The
      // confused-deputy replay: without the binding, every provider Alice calls
      // could act as Alice elsewhere.
      const rejected = await verifyToken(token, {
        issuer: hubPeerId,
        connectionPeer: "12D3KooWMalloryPeerId",
        now,
      }).catch((error: unknown) => error);

      expect(rejected).toBeInstanceOf(TokenVerificationError);
      expect((rejected as TokenVerificationError).reason).toBe("peer-binding");
    });

    it("refuses a token presented over an ANONYMOUS connection", async () => {
      const now = () => 1_000_000;
      const token = await mintToken({
        privateKey: hubKey,
        sub: MEMBER,
        roles: [],
        ttlMs: 60_000,
        now,
      });

      // No `connection_peer` is asserted at all, so the binding check has
      // nothing to match: deny by default, expressed in the format.
      await expect(
        verifyToken(token, { issuer: hubPeerId, connectionPeer: ANONYMOUS, now }),
      ).rejects.toMatchObject({ reason: "peer-binding" });
    });

    it("names the failing check, with its block and rule text (P8)", async () => {
      const now = () => 1_000_000;
      const token = await mintToken({
        privateKey: hubKey,
        sub: MEMBER,
        roles: [],
        ttlMs: 60_000,
        now,
      });

      const rejected = (await verifyToken(token, {
        issuer: hubPeerId,
        connectionPeer: "12D3KooWSomebodyElse",
        now,
      }).catch((error: unknown) => error)) as TokenVerificationError;

      expect(rejected.failedChecks).toEqual([
        "block 0 check 0: check if bound($k), connection_peer($k)",
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Attenuation cannot widen (A-23)
  // -------------------------------------------------------------------------

  describe("appended blocks", () => {
    it("an appended block cannot grant a role the hub did not", async () => {
      const now = () => 1_000_000;
      const token = await mintToken({
        privateKey: hubKey,
        sub: MEMBER,
        roles: ["read"],
        ttlMs: 60_000,
        now,
      });

      const forged = appendBlock(token, hubKey, 'role("admin");');
      const claims = await verifyToken(forged, {
        issuer: hubPeerId,
        connectionPeer: MEMBER,
        now,
      });

      // Biscuit scopes facts: the authorizer, and therefore `readClaims`, sees
      // the authority block only. The appended `role("admin")` is invisible.
      expect(claims.roles).toEqual(["read"]);
    });

    it("... and the control: the same role IS present when the hub granted it", async () => {
      // Without this pair, the assertion above is also what "a query that can
      // never return anything" looks like. Prototype 10's T10-12b, kept.
      const now = () => 1_000_000;
      const token = await mintToken({
        privateKey: hubKey,
        sub: MEMBER,
        roles: ["read", "admin"],
        ttlMs: 60_000,
        now,
      });

      const claims = await verifyToken(token, {
        issuer: hubPeerId,
        connectionPeer: MEMBER,
        now,
      });

      expect(claims.roles).toEqual(["admin", "read"]);
    });

    it("a thief cannot re-bind a stolen token to itself", async () => {
      // The attack a plain appended block makes available: Biscuit signs
      // appended blocks with a next-key that travels WITH the token, so anyone
      // holding the bytes can append. What defeats it is that the binding check
      // lives in the AUTHORITY block, which cannot see a later block's facts.
      const now = () => 1_000_000;
      const token = await mintToken({
        privateKey: hubKey,
        sub: MEMBER,
        roles: ["read"],
        ttlMs: 60_000,
        now,
      });

      const forged = appendBlock(
        token,
        hubKey,
        'bound("12D3KooWThief"); subject("12D3KooWThief");',
      );

      await expect(
        verifyToken(forged, { issuer: hubPeerId, connectionPeer: "12D3KooWThief", now }),
      ).rejects.toMatchObject({ reason: "peer-binding" });
    });

    it("an appended constraint the verifier cannot satisfy DENIES (A-20)", async () => {
      // Fail closed on the unknown: a check naming a predicate this verifier
      // has never heard of must refuse, not be ignored.
      const now = () => 1_000_000;
      const token = await mintToken({
        privateKey: hubKey,
        sub: MEMBER,
        roles: [],
        ttlMs: 60_000,
        now,
      });

      const narrowed = appendBlock(token, hubKey, "check if quantum_safe(true);");

      await expect(
        verifyToken(narrowed, { issuer: hubPeerId, connectionPeer: MEMBER, now }),
      ).rejects.toMatchObject({ reason: "unsatisfied-constraint" });
    });
  });

  // -------------------------------------------------------------------------
  // The evaluation budget (P9, A-25)
  // -------------------------------------------------------------------------

  it("a token carrying an exploding rule set denies rather than hanging", async () => {
    const now = () => 1_000_000;
    const token = await mintToken({
      privateKey: hubKey,
      sub: MEMBER,
      roles: [],
      ttlMs: 60_000,
      now,
    });

    let explosion = "";
    for (let i = 0; i < 60; i++) explosion += `s(${i});`;
    explosion += "p($x, $y) <- s($x), s($y);";
    explosion += "q($x, $y) <- p($x, $z), p($z, $y);";
    explosion += "r($x, $y) <- q($x, $z), q($z, $y);";
    const hostile = appendBlock(token, hubKey, explosion);

    const started = Date.now();
    await expect(
      verifyToken(hostile, { issuer: hubPeerId, connectionPeer: MEMBER, now }),
    ).rejects.toMatchObject({ reason: "evaluation-budget" });
    // Not a benchmark — the claim is only that it terminates on the budget
    // rather than running until something else gives up.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  // -------------------------------------------------------------------------
  // Refusals carried over from the JWS suite
  // -------------------------------------------------------------------------

  describe("refusals", () => {
    it("rejects a token signed by a different key", async () => {
      const now = () => 1_000_000;
      // Claims the hub's mesh, signed by somebody else's key.
      const builder = new BiscuitBuilder();
      builder.addCodeWithParameters(
        "mesh({mesh}); subject({sub}); bound({sub}); issued_at(1000000); expires_at(1060000);",
        { mesh: hubPeerId, sub: MEMBER },
        {},
      );
      const forged = builder.build(biscuitKeyOf(otherKey)).toBase64();

      await expect(
        verifyToken(forged, { issuer: hubPeerId, connectionPeer: MEMBER, now }),
      ).rejects.toMatchObject({ reason: "signature" });
    });

    it("rejects an expired token", async () => {
      let time = 1_000_000;
      const clock = () => time;
      const token = await mintToken({
        privateKey: hubKey,
        sub: MEMBER,
        roles: [],
        ttlMs: 1_000,
        now: clock,
      });

      time = 1_002_000; // past exp
      await expect(
        verifyToken(token, { issuer: hubPeerId, connectionPeer: MEMBER, now: clock }),
      ).rejects.toMatchObject({ reason: "expired" });
    });

    it("accepts the same token one millisecond before it expires", async () => {
      let time = 1_000_000;
      const clock = () => time;
      const token = await mintToken({
        privateKey: hubKey,
        sub: MEMBER,
        roles: [],
        ttlMs: 1_000,
        now: clock,
      });

      time = 1_000_999;
      await expect(
        verifyToken(token, { issuer: hubPeerId, connectionPeer: MEMBER, now: clock }),
      ).resolves.toMatchObject({ iat: 1_000_000, exp: 1_001_000 });
    });

    it("rejects a token minted for a different mesh", async () => {
      const now = () => 1_000_000;
      const token = await mintToken({
        privateKey: hubKey,
        sub: MEMBER,
        roles: [],
        ttlMs: 60_000,
        now,
      });

      // The verifier expects a different mesh, so the token is verified against
      // that mesh's key and simply does not verify. The JWS version reported
      // this separately from a corrupt signature only because it verified
      // against the mesh the TOKEN declared; there is nothing left to tell the
      // two apart once the verifier's own expectation is what supplies the key.
      await expect(
        verifyToken(token, { issuer: otherPeerId, connectionPeer: MEMBER, now }),
      ).rejects.toMatchObject({ reason: "signature" });
    });

    it("rejects a token whose mesh fact does not match the key that signed it", async () => {
      const now = () => 1_000_000;
      // Validly signed by the hub, but naming somebody else's mesh — the
      // self-certification check, `check if mesh($m), root_mesh($m)`.
      const builder = new BiscuitBuilder();
      builder.addCodeWithParameters(
        "mesh({mesh}); subject({sub}); bound({sub}); issued_at(1000000); expires_at(1060000);",
        { mesh: otherPeerId, sub: MEMBER },
        {},
      );
      builder.addCode("check if bound($k), connection_peer($k);");
      builder.addCode("check if mesh($m), root_mesh($m);");
      const token = builder.build(biscuitKeyOf(hubKey)).toBase64();

      await expect(
        verifyToken(token, { issuer: hubPeerId, connectionPeer: MEMBER, now }),
      ).rejects.toMatchObject({ reason: "mesh-mismatch" });
    });

    it("rejects an RSA-derived peerId as issuer", async () => {
      // A real RSA peerId is a base58btc-encoded sha2-256 multihash of the
      // public key (too large to inline, unlike Ed25519). We don't need a real
      // RSA key to prove the rejection: any sha2-256 multihash produces a
      // peerId with no embedded public key, so no root key can be recovered
      // from it — which is exactly what makes offline verification possible
      // for Ed25519 and impossible here.
      const digest = await sha256.digest(new TextEncoder().encode("not-an-ed25519-key"));
      const rsaLikePeerId = base58btc.encode(digest.bytes).slice(1); // drop the multibase 'z'

      await expect(
        verifyToken("anything", {
          issuer: rsaLikePeerId,
          connectionPeer: MEMBER,
          now: () => 1_000_000,
        }),
      ).rejects.toMatchObject({ reason: "issuer-not-ed25519" });
    });

    it("rejects an unparseable issuer", async () => {
      await expect(
        verifyToken("anything", {
          issuer: "not-a-peer-id",
          connectionPeer: MEMBER,
          now: () => 1_000_000,
        }),
      ).rejects.toMatchObject({ reason: "unparseable-issuer" });
    });

    it("rejects malformed input without leaking a raw exception", async () => {
      // The wasm boundary throws plain objects, not Errors; every one of them
      // must arrive as a TokenVerificationError.
      for (const malformed of ["", "!!!not-base64!!!", "aGVsbG8=", "a.b.c"]) {
        const rejected = await verifyToken(malformed, {
          issuer: hubPeerId,
          connectionPeer: MEMBER,
          now: () => 1_000_000,
        }).catch((error: unknown) => error);

        expect(rejected, `input ${JSON.stringify(malformed)}`).toBeInstanceOf(
          TokenVerificationError,
        );
        expect((rejected as TokenVerificationError).reason).toBe("malformed-token");
      }
    });

    it("refuses to mint with a non-integer clock", async () => {
      // Silent i64 truncation would corrupt `iat`, which revocation orders
      // against `changedAt`. A hub calling us wrongly is a bug, not a refusal.
      await expect(
        mintToken({
          privateKey: hubKey,
          sub: MEMBER,
          roles: [],
          ttlMs: 1_000,
          now: () => 1_000_000.5,
        }),
      ).rejects.toThrow(/safe integer milliseconds/);
    });
  });
});
