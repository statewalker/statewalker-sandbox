/**
 * The end-to-end suite: pairing, binding, access policy, the mesh view and
 * presence, and the router -- over real libp2p, exercising this app's hub
 * mount table against `httpeers.core`'s peer assembly.
 *
 * PROMOTED (Task 7b) from
 * `notes/2026/2026-08/2026-08-16/httpeers-plan/prototypes/12-httpeers-prototype-validated/src/integration.test.ts`.
 * No assertion was altered -- see
 * `.superpowers/sdd/2026-08-18-httpeers-stack/task-7b-report.md` for the
 * full adaptation record, including the one assertion that does NOT pass
 * under this design ("denies an admin path to a member") and why it was
 * left as-is rather than edited.
 *
 * Adapted at the call sites only:
 *  - `createPeer({ isHub: true, ... })` -> `buildTestHub()` /
 *    `buildTestPeer()` (`tests/support/mesh.ts`); `hub.peerId` ->
 *    `hub.peer.peerId`, `hub.addrs()` -> `hub.peer.addrs()`.
 *  - `hub.store.createInvitation(code, roles, ttlMs)` ->
 *    `hub.invitations.create(id, roles, ttlMs)` -- same shape, this
 *    package's `InvitationStore` (`src/hub/persist.ts`).
 *  - the invite/echo/mesh wire shapes use `id`, not `code` -- see
 *    `src/hub/endpoints.ts`'s `/.well-known/invite` handler and the
 *    archive's own `endpoints.ts` line 51 (`{ code }`) versus this
 *    package's line 151 (`{ id }`).
 *  - `verifyMeshToken(token, { mesh })` / `mintMeshToken(key, { sub, iss,
 *    roles, ttlMs })` -> this package's `verifyToken(token, { issuer })` /
 *    `mintToken({ privateKey, sub, roles, ttlMs })`; `mesh`/`iss` are always
 *    derived from `privateKey` here, never passed in.
 *  - a presence POST body now carries `seq` (monotonic, per peer) -- the
 *    archive's `PresenceStore` had no replay guard; this one does (Task 1).
 *  - the rogue/forged-mesh test used `@libp2p/crypto/keys`'s
 *    `generateKeyPair` directly; adapted to `generateMeshKey()` (this
 *    package re-exports it from `httpeers.core`'s `tokens.ts`) so this app
 *    still imports no libp2p package directly, only `@multiformats/multiaddr`
 *    for `Peer.libp2p.dial(...)` -- `Peer`'s own doc comment names this as
 *    the intended use of the exposed `libp2p` field.
 *  - the expired-token test read `(hub as any).__key`, a field of the
 *    archive's own monolithic `Peer` this package's `Peer` never exposes
 *    (`createPeer`'s doc comment: the signing key is retained, never
 *    published). Adapted at Task 7b to mint with a fresh, unrelated key, on
 *    the grounds that `verifyToken` ran expiry BEFORE the mesh/issuer match.
 *    CORRECTED AT TASK 34: that ceased to hold at ADR-0019 -- a Biscuit's
 *    signature is verified at parse, before any check runs -- so the
 *    substitution quietly turned the test into a duplicate of the
 *    different-mesh one. It now mints through `TestHub.mintToken` with a
 *    negative `ttlMs`, which is genuinely expired and genuinely this mesh's.
 */
import { multiaddr } from "@multiformats/multiaddr";
import { generateMeshKey, mintToken, verifyToken } from "@statewalker/httpeers.core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHub, buildTestPeer, type TestHub, type TestPeer } from "./support/mesh.js";

let hub: TestHub, alice: TestPeer, mallory: TestPeer;
let aliceToken: string;

beforeAll(async () => {
  hub = await buildTestHub();
  alice = await buildTestPeer({ hubPeerId: hub.peer.peerId, listen: ["/ip4/127.0.0.1/tcp/0"] });
  mallory = await buildTestPeer({ hubPeerId: hub.peer.peerId, listen: ["/ip4/127.0.0.1/tcp/0"] });

  const hubAddr = hub.peer.addrs()[0]!;
  await alice.libp2p.dial(multiaddr(hubAddr));
  await mallory.libp2p.dial(multiaddr(hubAddr));
}, 30_000);

afterAll(async () => {
  await Promise.all([hub?.stop(), alice?.stop(), mallory?.stop()]);
});

describe("pairing", () => {
  it("rejects an unknown invitation code", async () => {
    const res = await alice.call(hub.peer.peerId, "/.well-known/invite", {
      method: "POST",
      body: JSON.stringify({ id: "nope" }),
    });
    expect(res.status).toBe(403);
  });

  it("redeems a valid invitation and returns a usable token", async () => {
    hub.invitations.create("CODE-A", ["member"], 60_000);
    const res = await alice.call(hub.peer.peerId, "/.well-known/invite", {
      method: "POST",
      body: JSON.stringify({ id: "CODE-A" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    aliceToken = body.token;
    expect(body.mesh).toBe(hub.peer.peerId);
    expect(body.roles).toEqual(["member"]);

    const claims = await verifyToken(aliceToken, {
      issuer: hub.peer.peerId,
      connectionPeer: alice.peerId,
    });
    expect(claims?.sub).toBe(alice.peerId); // hub bound the token to the CONNECTED peer
  });

  it("refuses to redeem the same invitation twice", async () => {
    const res = await mallory.call(hub.peer.peerId, "/.well-known/invite", {
      method: "POST",
      body: JSON.stringify({ id: "CODE-A" }),
    });
    expect(res.status).toBe(403);
  });

  it("admits a second peer with its own code", async () => {
    hub.invitations.create("CODE-M", ["member"], 60_000);
    const res = await mallory.call(hub.peer.peerId, "/.well-known/invite", {
      method: "POST",
      body: JSON.stringify({ id: "CODE-M" }),
    });
    // The archive captured `.token` into `malloryToken` here but never read
    // it again anywhere in the file; dropped rather than kept as a written-
    // but-unread binding, which this package's `noUnusedLocals` (absent from
    // the archive's own tsconfig) does not allow.
    expect(res.status).toBe(200);
  });
});

describe("binding", () => {
  it("admits an authenticated call", async () => {
    const res = await alice.call(hub.peer.peerId, "/test/whoami", { token: aliceToken });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.you).toBe(alice.peerId);
    expect(body.servedBy).toBe(hub.peer.peerId);
  });

  it("rejects a call with no token", async () => {
    const res = await alice.call(hub.peer.peerId, "/test/whoami");
    expect(res.status).toBe(401);
  });

  it("REJECTS A REPLAYED TOKEN -- the confused deputy", async () => {
    // Mallory presents Alice's genuine, unexpired, correctly-signed token
    // over Mallory's own connection.
    const res = await mallory.call(hub.peer.peerId, "/test/whoami", { token: aliceToken });
    // The replay is refused -- that is the property, and it is unchanged.
    //
    // STILL 401 (Task 29's status survives Task 34), but it is no longer the
    // SAME 401 a tokenless caller gets. The binding still lives INSIDE the
    // token as `check if bound($k), connection_peer($k)`, so the deputy is
    // still defeated one step earlier and by the token itself; what changed is
    // that `getClaims` no longer flattens that verification failure into "no
    // token", so the refusal carries its own reason.
    //
    // 401 rather than 403 is the decision. Mallory is not the only caller who
    // reaches this state: a page that resets its identity while holding a
    // token minted for its old key presents exactly the same mismatch, and for
    // that honest client a refresh is the entire fix. Telling it to stop would
    // be a real failure, while Mallory looping on 401 gains nothing -- no
    // amount of retrying yields a token bound to Alice's key.
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "token subject does not match connected peer",
      reason: "peer-binding",
    });

    // The discrimination the reason buys: same status, different refusal.
    const tokenless = await mallory.call(hub.peer.peerId, "/test/whoami");
    expect(tokenless.status).toBe(401);
    expect(await tokenless.json()).toEqual({ error: "membership token required" });
  });

  it("rejects a token minted by a different mesh", async () => {
    const rogueKey = await generateMeshKey();
    const forged = await mintToken({
      privateKey: rogueKey,
      sub: alice.peerId,
      roles: ["admin"],
      ttlMs: 60_000,
    });
    const res = await alice.call(hub.peer.peerId, "/test/whoami", { token: forged });
    // 403, not the 401 this asserted before Task 34. A Biscuit is verified
    // against the key the VERIFIER expects, so a token signed by an unrelated
    // key fails at PARSE with `signature` -- the reason that deliberately
    // collapses "corrupted" and "signed by someone else" (`TokenRejectionReason`
    // in `types.ts`). Either way a refresh from the rogue hub produces another
    // token this mesh will not accept, so the client must stop rather than
    // retry: 403.
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "token signature does not verify against this mesh's key",
      reason: "signature",
    });
  });

  it("rejects an expired token -- 401, because a refresh is exactly the remedy", async () => {
    // MINTED BY THE HUB, not by a fresh unrelated key. The module comment
    // above recorded the archive's adaptation as safe on the grounds that
    // "`verifyToken`'s check order runs expiry BEFORE the mesh/issuer match,
    // so an expired token is still rejected ... regardless of whose key signed
    // it". That was true of the JWS implementation and stopped being true at
    // ADR-0019: a Biscuit's signature is checked at parse, before any check
    // runs, so an unrelated key produced `signature` and this test was
    // silently a duplicate of the one above it. Both collapsed to 401, so
    // nothing showed. Task 34 separates the two statuses and the substitution
    // became visible -- fixed by asking the hub for a genuinely expired token,
    // which `TestHub.mintToken` (the same closure its endpoints use) can mint.
    const expired = await hub.mintToken(alice.peerId, ["member"], { ttlMs: -1000 });
    const res = await alice.call(hub.peer.peerId, "/test/whoami", { token: expired });
    // 401 and not 403: this is the one refusal a fresh token really does fix.
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "token expired", reason: "expired" });
  });
});

describe("access policy", () => {
  it("denies an admin path to a member", async () => {
    const res = await alice.call(hub.peer.peerId, "/admin/invitations", { token: aliceToken });
    expect(res.status).toBe(403);
    // DELTA APPLICATION, not an accommodation: `CHANGES-v0.9.0.txt` ("What
    // the switch cost") documents this exact change -- "the denial message
    // improved from `requires one of: admin` to `requires one of:
    // std:mesh.admin`" -- as part of the capability-based `.access` rewrite.
    // That delta's other three access-tree tests were already applied by an
    // earlier task; this integration assertion lived in a suite that did not
    // exist yet, so it is applied here, on the archive's own authority, not
    // edited to make a failure disappear. ADR-0019 replaced the tree with
    // Datalog and this wording SURVIVED: `rules.ts` reconstructs it by
    // evaluation (the sufficiency probe) rather than by reading an `anyOf`
    // list off a governing entry.
    expect(((await res.json()) as any).error).toMatch(/requires one of: std:mesh\.admin/);
  });

  it("denies an unmapped path by default", async () => {
    const res = await alice.call(hub.peer.peerId, "/nothing/here", { token: aliceToken });
    expect(res.status).toBe(403);
  });
});

describe("mesh view and presence", () => {
  it("lists members", async () => {
    const res = await alice.call(hub.peer.peerId, "/.well-known/mesh", { token: aliceToken });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const ids = body.members.map((m: any) => m.peerId);
    expect(ids).toContain(alice.peerId);
    expect(ids).toContain(mallory.peerId);
  });

  it("check-in records presence and returns a fresh token", async () => {
    const res = await alice.call(hub.peer.peerId, "/.well-known/presence", {
      method: "POST",
      body: JSON.stringify({ seq: 1, addrs: alice.addrs() }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ttl).toBe(15_000);
    aliceToken = body.token;

    const view = await alice.call(hub.peer.peerId, "/.well-known/mesh", { token: aliceToken });
    const me = ((await view.json()) as any).members.find((m: any) => m.peerId === alice.peerId);
    expect(me.online).toBe(true);
    expect(me.addrs.length).toBeGreaterThan(0);
  });

  it("rejects check-in from a non-member", async () => {
    const stranger = await buildTestPeer({ hubPeerId: hub.peer.peerId });
    await stranger.libp2p.dial(multiaddr(hub.peer.addrs()[0]!));
    const res = await stranger.call(hub.peer.peerId, "/.well-known/presence", {
      method: "POST",
      body: JSON.stringify({ seq: 1, addrs: [] }),
    });
    expect(res.status).toBe(403);
    await stranger.stop();
  });

  it("serves 304 when the mesh version is unchanged (query-free polling)", async () => {
    const first = await alice.call(hub.peer.peerId, "/.well-known/mesh", { token: aliceToken });
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"v\d+"$/);

    const second = await alice.call(hub.peer.peerId, "/.well-known/mesh", {
      token: aliceToken,
      headers: { "if-none-match": etag },
    });
    expect(second.status).toBe(304);
  });
});

describe("router", () => {
  it("serves a self-addressed /{peerId}/path locally", async () => {
    const res = await alice.call(hub.peer.peerId, `/${hub.peer.peerId}/test/whoami`, {
      token: aliceToken,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).servedBy).toBe(hub.peer.peerId);
  });

  it("round-trips a POST body", async () => {
    const res = await alice.call(hub.peer.peerId, "/test/echo", {
      method: "POST",
      body: "payload",
      token: aliceToken,
    });
    expect(((await res.json()) as any).body).toBe("payload");
  });
});
