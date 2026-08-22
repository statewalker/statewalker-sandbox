/**
 * The testability argument, made concrete.
 *
 * No libp2p, no transport, no JWT cryptography, no network. Every seam —
 * `getPeerId`, `usesTransportIdentity`, `getClaims`, `isRevoked` — is a
 * one-line stub. This is what the stopping rule asks for: one file, one
 * exported signature, behaviour assertable in isolation.
 *
 * The case this whole design exists for is the confused-deputy replay: a
 * hub-minted token is a bearer token, valid at every provider that trusts
 * the hub, so a malicious provider could otherwise replay a member's token
 * elsewhere. The handshake — `getPeerId`, which no caller can forge — is
 * what defeats it.
 */
import { describe, expect, it } from "vitest";
import { newPeerHandlers, PeerBindingLostError } from "../src/peer-handlers.js";
import { ANONYMOUS } from "../src/types.js";
import type { MeshClaims, ProvenPeer } from "../src/types.js";

const ALICE = "12D3KooWAlice";
const MALLORY = "12D3KooWMallory";

function claimsFor(sub: string): MeshClaims {
  // `audience: "unrestricted"` because this middleware does not look at the
  // audience at all -- the destination enforces that inside `verifyToken`,
  // before these claims exist (ADR-0020). The fixture states the field rather
  // than defaulting it because `MeshClaims` has no default: three states,
  // each explicit.
  return {
    sub,
    iss: "hub",
    mesh: "hub",
    roles: ["member"],
    iat: Date.now(),
    exp: Date.now() + 60_000,
    audience: "unrestricted",
  };
}

interface SubjectOpts {
  peer: ProvenPeer | undefined;
  claims?: MeshClaims | null;
  bootstrap?: boolean;
  isRevoked?: (claims: MeshClaims) => Promise<string | null>;
}

function subject(opts: SubjectOpts) {
  let reached = false;
  const handler = newPeerHandlers({
    getPeerId: async () => opts.peer as ProvenPeer,
    usesTransportIdentity: async () => opts.bootstrap ?? false,
    getClaims: async () => opts.claims ?? null,
    isRevoked: opts.isRevoked,
    handleEndpoints: async () => {
      reached = true;
      return new Response("ok");
    },
  });
  return { handler, reached: () => reached };
}

const req = (method = "GET") => new Request("http://peer/test/whoami", { method });

describe("newPeerHandlers", () => {
  it("admits a matching peer and token", async () => {
    const s = subject({ peer: ALICE, claims: claimsFor(ALICE) });
    expect((await s.handler(req())).status).toBe(200);
    expect(s.reached()).toBe(true);
  });

  it("rejects a token replayed over a different connection (the confused-deputy case)", async () => {
    // Mallory holds a valid token naming Alice as `sub`, but the transport
    // handshake on THIS connection proved Mallory, not Alice.
    const s = subject({ peer: MALLORY, claims: claimsFor(ALICE) });
    expect((await s.handler(req())).status).toBe(403);
    expect(s.reached()).toBe(false);
  });

  it("rejects a missing token on an ordinary path", async () => {
    const s = subject({ peer: ALICE, claims: null });
    const res = await s.handler(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "membership token required" });
  });

  it("admits a bootstrap request with no token, identity taken from the transport", async () => {
    const s = subject({ peer: ALICE, claims: null, bootstrap: true });
    expect((await s.handler(req())).status).toBe(200);
    expect(s.reached()).toBe(true);
  });

  it("rejects a bootstrap request from an ANONYMOUS caller", async () => {
    // Bootstrap needs no token, but it still needs a PROVEN peer.
    const s = subject({ peer: ANONYMOUS, claims: null, bootstrap: true });
    expect((await s.handler(req())).status).toBe(401);
  });

  it("rejects ANONYMOUS on an ordinary path — distinct from a lost binding", async () => {
    const s = subject({ peer: ANONYMOUS, claims: claimsFor(ALICE) });
    const res = await s.handler(req());
    expect(res.status).toBe(401);
    // A different reason than the missing-token case above: this caller DID
    // present a token, but the transport proved nobody. Pinning the body,
    // not just the status, keeps the two 401s from silently collapsing into
    // one generic "unauthorized" if a later refactor merges the branches.
    expect(await res.json()).toEqual({ error: "possession unproven" });
  });

  it("THROWS when the binding was lost, rather than denying", async () => {
    // This distinguishes a bug from a policy decision. If it denied
    // instead, a re-created Request would look exactly like an anonymous
    // caller, hiding the bug behind a plausible-looking response.
    const s = subject({ peer: undefined, claims: claimsFor(ALICE) });
    await expect(s.handler(req())).rejects.toThrow(PeerBindingLostError);
  });

  it("isRevoked returning a reason refuses the request and the reason reaches the response", async () => {
    const s = subject({
      peer: ALICE,
      claims: claimsFor(ALICE),
      isRevoked: async () => "member removed",
    });
    const res = await s.handler(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "member removed" });
    expect(s.reached()).toBe(false);
  });

  it("isRevoked absent — nothing is revoked (the seam is optional)", async () => {
    let reached = false;
    const handler = newPeerHandlers({
      getPeerId: async () => ALICE,
      usesTransportIdentity: async () => false,
      getClaims: async () => claimsFor(ALICE),
      // isRevoked intentionally omitted.
      handleEndpoints: async () => {
        reached = true;
        return new Response("ok");
      },
    });
    const res = await handler(req());
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it("discriminates bootstrap by method, not path — a presence write bootstraps, a presence read on the same path does not", async () => {
    let reached = false;
    const handler = newPeerHandlers({
      getPeerId: async () => ALICE,
      usesTransportIdentity: async (r) => r.method === "POST",
      getClaims: async () => null,
      handleEndpoints: async () => {
        reached = true;
        return new Response("ok");
      },
    });

    const postRes = await handler(req("POST"));
    expect(postRes.status).toBe(200);
    expect(reached).toBe(true);

    reached = false;
    const getRes = await handler(req("GET"));
    expect(getRes.status).toBe(401);
    expect(reached).toBe(false);
  });
});
