/**
 * Task 13, Rulings 59 and 60: `src/browser/edge-dispatch.ts` -- the one
 * module standing between a page's plain `fetch()` and `peer.dispatch`.
 *
 * NODE, NOT A BROWSER, AND DELIBERATELY SO. Everything this module does is
 * `Request` in / `Response` out over `httpeers.core`'s pure surface; it
 * imports neither libp2p nor `@statewalker/webrun-http-browser`. So every
 * rule it enforces is provable here rather than deferred to Task 15's
 * Playwright run -- which is the point of factoring it out of the page in
 * the first place. What genuinely still needs a browser is only the
 * ServiceWorker plumbing on either side of it (`edge.ts`, `node-profile.ts`);
 * see this task's report.
 *
 * The suite is in two halves. The first drives the wrapper with a spy
 * handler, so each rule is asserted against exactly what `dispatch`
 * received. The second drives it through a REAL `createPeer`
 * (`tests/search.test.ts`'s own construction) whose mount echoes back the
 * headers it was given -- because "an inbound request is never given our
 * token" is the rule that matters most here, and proving it against a real
 * router closes the gap between "the wrapper's own logic is right" and "the
 * request that reaches a handler really is untouched".
 */
import {
  createMounts,
  createPeer,
  json,
  type Peer,
  PeerCallError,
  type PeerErrorKind,
  PeerProtocolUnsupportedError,
  PeerRelayLimitExceededError,
  PeerRequestTimeoutError,
  PeerStreamResetError,
  PeerUnreachableError,
  registerAnonymous,
  registerPeer,
  UnknownPeerCallError,
} from "@statewalker/httpeers.core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEdgeDispatch,
  PEER_ERROR_STATUS,
  type PeerErrorBody,
  stripEdgePrefix,
} from "../src/browser/edge-dispatch.js";
import { VOCABULARY } from "../src/policy.js";

const KEY = "app";
const TOKEN = "TOKEN-CURRENT";

/** A `dispatch` that records exactly what it was handed and answers 200. */
function spyDispatch(): { seen: Request[]; handler: (req: Request) => Promise<Response> } {
  const seen: Request[] = [];
  return {
    seen,
    handler: async (req) => {
      seen.push(req);
      return json({ ok: true }, 200);
    },
  };
}

describe("stripEdgePrefix", () => {
  it("removes the key's own leading segment", () => {
    expect(stripEdgePrefix("/app/12D3Koo/search", "app")).toBe("/12D3Koo/search");
  });

  it("maps the bare prefix to the root path", () => {
    expect(stripEdgePrefix("/app", "app")).toBe("/");
  });

  it("respects segment boundaries -- /application is NOT the /app prefix", () => {
    expect(stripEdgePrefix("/application/x", "app")).toBe("/application/x");
  });

  it("leaves a path that does not carry the prefix alone", () => {
    expect(stripEdgePrefix("/12D3Koo/search", "app")).toBe("/12D3Koo/search");
  });
});

describe("Ruling 59: the runtime attaches the membership token, not the page", () => {
  it("a page-originated request reaches dispatch with the current token attached", async () => {
    const spy = spyDispatch();
    const dispatch = createEdgeDispatch({
      dispatch: spy.handler,
      key: KEY,
      token: () => TOKEN,
    });

    const res = await dispatch(new Request(`http://localhost:5175/${KEY}/12D3Koo/search?q=relay`));

    expect(res.status).toBe(200);
    expect(spy.seen).toHaveLength(1);
    expect(spy.seen[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("the mount prefix is stripped, so the router sees the shape it documents", async () => {
    const spy = spyDispatch();
    const dispatch = createEdgeDispatch({ dispatch: spy.handler, key: KEY, token: () => TOKEN });

    await dispatch(new Request(`http://localhost:5175/${KEY}/12D3Koo/search?q=relay`));

    // `SwHttpAdapter` hands the handler the FULL url, prefix included
    // (verified against the package -- see the module comment). Without the
    // strip, `httpeers.core`'s router would read "app" as the first segment,
    // decide it is not a peer id, and serve locally: a 404 three layers
    // from the mistake.
    const url = new URL(spy.seen[0]!.url);
    expect(url.pathname).toBe("/12D3Koo/search");
    expect(url.search).toBe("?q=relay"); // the query survives the re-creation
  });

  it("the token is read PER REQUEST, so heartbeat rotation is never stale", async () => {
    const spy = spyDispatch();
    let current = "TOKEN-1";
    const dispatch = createEdgeDispatch({ dispatch: spy.handler, key: KEY, token: () => current });

    await dispatch(new Request(`http://localhost:5175/${KEY}/12D3Koo/a`));
    current = "TOKEN-2"; // the hub minted a fresh one on the next heartbeat
    await dispatch(new Request(`http://localhost:5175/${KEY}/12D3Koo/b`));

    expect(spy.seen.map((r) => r.headers.get("authorization"))).toEqual([
      "Bearer TOKEN-1",
      "Bearer TOKEN-2",
    ]);
  });

  it("never overwrites an authorization header the caller set deliberately", async () => {
    const spy = spyDispatch();
    const dispatch = createEdgeDispatch({ dispatch: spy.handler, key: KEY, token: () => TOKEN });

    await dispatch(
      new Request(`http://localhost:5175/${KEY}/12D3Koo/search`, {
        headers: { authorization: "Bearer SOMEONE-ELSES-TOKEN" },
      }),
    );

    expect(spy.seen[0]!.headers.get("authorization")).toBe("Bearer SOMEONE-ELSES-TOKEN");
  });

  it("a request body and method survive the re-creation intact", async () => {
    const spy = spyDispatch();
    const dispatch = createEdgeDispatch({ dispatch: spy.handler, key: KEY, token: () => TOKEN });

    await dispatch(
      new Request(`http://localhost:5175/${KEY}/12D3Koo/test/echo`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "payload",
      }),
    );

    expect(spy.seen[0]!.method).toBe("POST");
    expect(spy.seen[0]!.headers.get("content-type")).toBe("text/plain");
    expect(await spy.seen[0]!.text()).toBe("payload");
  });

  // --- constraint (iii): the one that matters -------------------------------

  it("an INBOUND request -- one a peer binding proves arrived from the network -- is never given our token", async () => {
    const spy = spyDispatch();
    const dispatch = createEdgeDispatch({ dispatch: spy.handler, key: KEY, token: () => TOKEN });

    const inbound = new Request("http://peer/search?q=relay");
    registerPeer(inbound, "12D3KooSomeOtherPeer");
    await dispatch(inbound);

    expect(spy.seen[0]!.headers.has("authorization")).toBe(false);
  });

  it("an inbound request reaches dispatch as the SAME object -- no strip, no header, nothing", async () => {
    const spy = spyDispatch();
    const dispatch = createEdgeDispatch({ dispatch: spy.handler, key: KEY, token: () => TOKEN });

    // Deliberately shaped like a page request (it carries the mount prefix)
    // so the ONLY thing separating it from one is the peer binding.
    const inbound = new Request(`http://localhost:5175/${KEY}/12D3Koo/search`);
    registerPeer(inbound, "12D3KooSomeOtherPeer");
    await dispatch(inbound);

    // Identity, not equality: passing the very same `Request` through is
    // what guarantees the peer binding (a WeakMap keyed on the instance)
    // survives, and that nothing was rewritten behind the router's back.
    expect(spy.seen[0]).toBe(inbound);
    expect(new URL(spy.seen[0]!.url).pathname).toBe(`/${KEY}/12D3Koo/search`);
  });

  it("an ANONYMOUS binding is a binding too: proven to be nobody is still not 'ours'", async () => {
    const spy = spyDispatch();
    const dispatch = createEdgeDispatch({ dispatch: spy.handler, key: KEY, token: () => TOKEN });

    const inbound = new Request("http://peer/search");
    registerAnonymous(inbound);
    await dispatch(inbound);

    expect(spy.seen[0]).toBe(inbound);
    expect(spy.seen[0]!.headers.has("authorization")).toBe(false);
  });
});

describe("Ruling 60: a thrown PeerCallError becomes a Response carrying its kind", () => {
  const cases: Array<{ kind: PeerErrorKind; error: PeerCallError; status: number }> = [
    {
      kind: "request-timeout",
      error: new PeerRequestTimeoutError("12D3KooTarget", 30_000),
      status: 504,
    },
    { kind: "peer-unreachable", error: new PeerUnreachableError("12D3KooTarget"), status: 502 },
    {
      kind: "protocol-unsupported",
      error: new PeerProtocolUnsupportedError("12D3KooTarget", "/httpeers/1.0.0"),
      status: 502,
    },
    { kind: "stream-reset", error: new PeerStreamResetError("12D3KooTarget"), status: 502 },
    {
      kind: "relay-limit-exceeded",
      error: new PeerRelayLimitExceededError("12D3KooTarget"),
      status: 502,
    },
    {
      kind: "unknown",
      error: new UnknownPeerCallError("12D3KooTarget", { cause: new Error("something new") }),
      status: 502,
    },
  ];

  // EVERY kind in the union, not a representative sample: the table in
  // `edge-dispatch.ts` is exhaustive by type, and this is what keeps it
  // exhaustive in behaviour too if a seventh kind is ever added.
  for (const { kind, error, status } of cases) {
    it(`${kind} -> ${status}, with kind and peerId in the body`, async () => {
      const dispatch = createEdgeDispatch({
        dispatch: async () => {
          throw error;
        },
        key: KEY,
        token: () => TOKEN,
      });

      const res = await dispatch(new Request(`http://localhost:5175/${KEY}/12D3KooTarget/images`));

      expect(res.status).toBe(status);
      expect(res.status).toBe(PEER_ERROR_STATUS[kind]);
      const body = (await res.json()) as PeerErrorBody;
      expect(body.kind).toBe(kind);
      expect(body.peerId).toBe("12D3KooTarget");
      expect(body.error).toBe(error.message);
    });
  }

  it("only the timeout is a 504 -- everything else is a 502", () => {
    const timeouts = Object.entries(PEER_ERROR_STATUS).filter(([, s]) => s === 504);
    expect(timeouts).toEqual([["request-timeout", 504]]);
  });

  it("a genuine bug is RETHROWN, never dressed up as a network condition", async () => {
    const bug = new TypeError("cannot read properties of undefined");
    const dispatch = createEdgeDispatch({
      dispatch: async () => {
        throw bug;
      },
      key: KEY,
      token: () => TOKEN,
    });

    // Left to escape, `SwHttpDispatcher`'s own catch turns it into a bare
    // 500 -- which is exactly right for a bug, and exactly wrong for the
    // conditions above. Swallowing this into a 502 would tell the page to
    // retry a call that will never succeed.
    await expect(dispatch(new Request(`http://localhost:5175/${KEY}/12D3Koo/x`))).rejects.toBe(bug);
  });

  it("a PeerCallError thrown while serving an INBOUND request is not mapped either", async () => {
    const dispatch = createEdgeDispatch({
      dispatch: async () => {
        throw new PeerUnreachableError("12D3KooThird");
      },
      key: KEY,
      token: () => TOKEN,
    });

    const inbound = new Request("http://peer/search");
    registerPeer(inbound, "12D3KooSomeOtherPeer");

    // Inbound traffic is passed through byte-identical in BOTH directions:
    // this module must not change how this peer behaves as a server, and
    // the status a remote caller sees stays whatever the transport already
    // decided.
    await expect(dispatch(inbound)).rejects.toBeInstanceOf(PeerCallError);
  });
});

describe("against a real peer router (createPeer, not a spy)", () => {
  let peer: Peer;
  /** Everything the innermost handler actually received, per request. */
  let echoed: Array<{ path: string; authorization: string | null }>;

  /** This peer's own `mintToken`, captured out of the `mounts` factory -- the only way to get a token a real router will accept. */
  let mintToken: (sub: string, roles: string[], ttlMs?: number) => Promise<string>;

  /**
   * The token the wrapper under test attaches, standing in for what
   * `JoinHandle.token()` returns in production.
   *
   * A GENUINELY MINTED TOKEN FOR THIS PEER, NOT A LITERAL, AND THE
   * DIFFERENCE IS THE WHOLE POINT OF THE TOKENLESS-INBOUND TEST BELOW.
   * `getClaims` (`peer.ts`) swallows ANY verification failure into `claims =
   * null`, and `newPeerHandlers` then answers 401 "membership token
   * required" -- exactly the status a request with no header at all
   * produces. So with an unverifiable literal here, that test would pass
   * whether or not the wrapper wrongly attached it: both branches land on
   * 401 and the counterfactual is unreachable. Verified directly (an earlier
   * version of this suite used the literal and did not discriminate; the
   * review caught it). With a real self-token, a wrongly-attached header
   * yields claims whose `sub` is THIS peer against a binding naming another,
   * which is a 403 on a different code path -- so the 401 assertion below
   * genuinely rules the mutant out.
   */
  let selfToken: string;

  beforeEach(async () => {
    echoed = [];
    peer = await createPeer({
      // `public: true` throughout: this suite is about what the WRAPPER
      // does to a request on its way to a handler, not about who may call
      // it (that is `admin.test.ts`'s and `search.test.ts`'s job). Without
      // it the library default (`DEFAULT_ACCESS_TREE`) denies `/` and no
      // handler ever runs, so the assertions below would pass for the wrong
      // reason.
      accessTree: { "/": { public: true } },
      vocabulary: VOCABULARY,
      mounts: (ctx) => {
        mintToken = ctx.mintToken;
        const mounts = createMounts();
        mounts.provide("/", async (req) => {
          echoed.push({
            path: new URL(req.url).pathname,
            authorization: req.headers.get("authorization"),
          });
          return json({ ok: true });
        });
        return mounts;
      },
    });
    selfToken = await mintToken(peer.peerId, ["member"]);
  });

  afterEach(async () => {
    await peer.stop();
  });

  it("constraint (iii) through the real router: an inbound call carrying its OWN token reaches the handler with that token, never ours", async () => {
    const dispatch = createEdgeDispatch({
      dispatch: peer.dispatch,
      key: KEY,
      token: () => selfToken,
    });

    const callerToken = await mintToken("12D3KooSomeOtherPeer", ["member"]);
    const inbound = new Request(`http://peer/${peer.peerId}/test/whoami`, {
      headers: { authorization: `Bearer ${callerToken}` },
    });
    registerPeer(inbound, "12D3KooSomeOtherPeer");
    const res = await dispatch(inbound);

    expect(res.status).toBe(200);
    // Against the real chain rather than a spy: a peer that can reach us
    // cannot borrow our membership. The request traversed
    // `createPeerRouter`'s self-addressed branch (which re-creates the
    // `Request` and carries the binding over with `copyPeerBinding`) and the
    // whole binding/access middleware -- and arrived carrying the CALLER's
    // token, never ours.
    expect(echoed).toEqual([{ path: "/test/whoami", authorization: `Bearer ${callerToken}` }]);
    expect(echoed[0]!.authorization).not.toContain(selfToken);
  });

  it("an inbound call with NO token is refused for lacking one -- not for carrying a mismatched one", async () => {
    const dispatch = createEdgeDispatch({
      dispatch: peer.dispatch,
      key: KEY,
      token: () => selfToken,
    });

    const inbound = new Request(`http://peer/${peer.peerId}/test/whoami`);
    registerPeer(inbound, "12D3KooSomeOtherPeer");
    const res = await dispatch(inbound);

    // The real router discriminates the two failure modes, which is what
    // makes this test add something to the spy-level assertions above rather
    // than restate them. Had the wrapper attached OUR token to this inbound
    // request, `newPeerHandlers` would have found claims whose `sub` is this
    // peer against a binding naming a different one, and answered 403 "token
    // subject does not match connected peer". A 401 "membership token
    // required" is only reachable if no authorization header was added at
    // all. This holds ONLY because `selfToken` is genuinely minted -- see its
    // declaration above for what breaks if it is a literal.
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(/membership token required/);
    expect(echoed).toEqual([]);
  });

  it("Ruling 60 through the real router: an unreachable target really does throw, and really is mapped", async () => {
    const dispatch = createEdgeDispatch({
      dispatch: peer.dispatch,
      key: KEY,
      token: () => selfToken,
    });

    // A syntactically valid peer id this node has no address for -- the
    // shape `looksLikePeerId` accepts, so the router takes its FORWARD
    // branch: `allowForward` sees no binding (the discriminant this whole
    // module is built on), forwards, and `remote()` throws T-2's typed
    // error out of a real dial attempt. Nothing is stubbed on this path.
    const absent = "12D3KooWAbsentPeer0000000000000000000000000000000";
    const res = await dispatch(new Request(`http://localhost:5175/${KEY}/${absent}/images`));

    expect([502, 504]).toContain(res.status);
    const body = (await res.json()) as PeerErrorBody;
    expect(body.peerId).toBe(absent);
    expect(Object.keys(PEER_ERROR_STATUS)).toContain(body.kind);
    // Not a bare 500 with no body -- the failure mode Ruling 60 exists to
    // prevent. The page can `switch` on `kind` without parsing a message.
    expect(res.status).not.toBe(500);
  }, 30_000);

  it("KNOWN LIMIT, recorded rather than hidden: a page cannot call its OWN peer through the edge", async () => {
    const dispatch = createEdgeDispatch({
      dispatch: peer.dispatch,
      key: KEY,
      token: () => selfToken,
    });

    // `httpeers.core` has two rules that meet here and disagree:
    //  - a request with NO peer binding is how `allowForward` recognises
    //    "originated at our own edge" (`peer.ts`) -- so the edge must not
    //    register one, or every page-to-remote call would be refused as
    //    relaying for a stranger;
    //  - but a request that reaches LOCAL serving with no binding is a
    //    contract violation the binding middleware throws on outright
    //    (`peer-handlers.ts`, `PeerBindingLostError`: "a gateway did not
    //    register, or the request was re-created above the binding
    //    middleware").
    // So a page fetching its own peer id, or a bare local path, gets a
    // thrown error rather than a response. This is a core-level tension,
    // NOT something this wrapper can resolve (registering a binding here
    // would break every remote call), and Task 13 was told not to modify
    // `httpeers.core`. It does not affect the main app page, which is a
    // pure consumer and only ever calls OTHER peers -- but it is real, and
    // asserting it here is what stops it being rediscovered as a mystery.
    // It is also correctly NOT swallowed by Ruling 60's mapping: it is not
    // a `PeerCallError`, so it is rethrown.
    await expect(
      dispatch(new Request(`http://localhost:5175/${KEY}/${peer.peerId}/test/whoami`)),
    ).rejects.toThrow(/no peer context registered/);
    expect(echoed).toEqual([]);
  });
});
