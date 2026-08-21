/**
 * Blocks T, E, M, X and C.
 *
 * Most of these need something this harness deliberately does not stand up: a live
 * libp2p transport, a running hub, a browser edge, or a peer whose configuration can
 * be swapped under in-flight traffic. Each carries the reason rather than a silent
 * omission — a criterion with no outcome is how a suite quietly stops testing.
 */
import { NotImplemented, type Check, type Implementation } from "../types.js";

const HOP_BY_HOP = ["connection", "keep-alive", "te", "transfer-encoding", "upgrade", "proxy-authorization"];
const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};
const inter = (impl: Implementation) => {
  if (!impl.intermediary) throw new NotImplemented("no `intermediary` capability");
  return impl.intermediary;
};

const NEEDS_TRANSPORT = (what: string) => ({
  skip: `needs a live libp2p transport; ${what}. Established over real nodes by the httpeers-protos prototypes.`,
});

export const OTHER_CHECKS: Record<string, Check | { skip: string }> = {
  // ---------------------------------------------------------------- block T
  "T-01": NEEDS_TRANSPORT("proven identity reaching a handler is a transport property"),
  "T-02": NEEDS_TRANSPORT("a forged claim must lose to a handshake"),
  "T-03": NEEDS_TRANSPORT("per-stream handler construction is observable only with real streams"),
  "T-04": NEEDS_TRANSPORT("query-string survival is a wire-format property"),
  "T-05": NEEDS_TRANSPORT("streamed request bodies need a real duplex"),
  "T-06": NEEDS_TRANSPORT("backpressure needs a real producer and consumer"),
  "T-07": NEEDS_TRANSPORT("the repeated-drain defect only appears against libp2p's MessageStream"),
  "T-08": NEEDS_TRANSPORT("one stream failing without taking the process down needs real streams"),
  "T-09": NEEDS_TRANSPORT("the inbound size cap is enforced during a real read"),
  "T-10": NEEDS_TRANSPORT("RFC 9110 message equivalence is a wire round-trip claim"),
  "T-11": {
    skip: "needs two browsers and a relay; established by the p2p-demo Playwright e2e in Chromium and Firefox",
  },

  // ---------------------------------------------------------------- block E
  "E-01": { skip: "block E is DESIGNED — no edge adapter exists to register against" },
  "E-02": { skip: "block E is DESIGNED — the isomorphism criterion needs all three edges to exist" },
  "E-03": { skip: "block E is DESIGNED — needs a ServiceWorker edge and a third-party client" },
  "E-04": { skip: "block E is DESIGNED — needs an edge to perform the error-to-status mapping" },
  "E-05": { skip: "block E is DESIGNED — needs an edge and a live remote handler" },
  "E-06": { skip: "block E is DESIGNED — needs a ServiceWorker edge" },
  "E-07": { skip: "block E is DESIGNED — relay-mode interception needs a browser" },

  // ---------------------------------------------------------------- block M
  "M-01": { skip: "block M is DESIGNED — no hub runs as a process" },
  "M-02": { skip: "block M is DESIGNED — invitation redemption is unimplemented" },
  "M-03": { skip: "block M is DESIGNED — minting on redemption is unimplemented" },
  "M-04": { skip: "block M is DESIGNED — presence needs the hub's TTL sweep timer" },
  "M-05": { skip: "block M is DESIGNED — needs a presence store with compare-and-set" },
  "M-06": { skip: "block M is DESIGNED — needs a durable store implementation (M-2)" },
  "M-07": { skip: "block M is DESIGNED — needs a hub serving /.well-known/capabilities" },
  "M-08": { skip: "block M is DESIGNED — removeMember has no endpoint yet" },
  "M-09": { skip: "block M is DESIGNED — needs a hub to kill and peers to keep talking" },

  // ------------------------------------------------- block X: peer & intermediary
  "X-01": { skip: "needs a live peer built from a transport; this harness models capabilities, not peers" },
  "X-02": { skip: "a compile-time claim about the init type; asserted by typecheck, not at runtime" },
  "X-03": { skip: "needs a live peer whose configuration can be swapped under in-flight requests" },
  "X-04": { skip: "needs a live peer to observe that a rejected configuration left the previous one in force" },

  "X-05": (impl) => {
    const req = new Request("http://upstream.local/x", {
      headers: {
        connection: "keep-alive, x-custom-hop",
        "keep-alive": "timeout=5",
        te: "trailers",
        upgrade: "websocket",
        "proxy-authorization": "Basic abc",
        "x-custom-hop": "should also go, because Connection named it",
        "x-app": "must survive",
      },
    });
    const out = inter(impl).asIntermediary(req, { via: "httpeers/1.0" });
    for (const h of HOP_BY_HOP) {
      assert(!out.headers.has(h), `hop-by-hop header \`${h}\` was forwarded to an upstream`);
    }
    assert(!out.headers.has("x-custom-hop"),
      "a header named by `Connection` survived — RFC 9110 requires those to be dropped too");
  },

  "X-06": (impl) => {
    const req = new Request("http://upstream.local/x", {
      headers: { authorization: "Bearer MESH-MEMBERSHIP-TOKEN" },
    });
    const out = inter(impl).asIntermediary(req, { via: "httpeers/1.0" });
    const got = out.headers.get("authorization") ?? "";
    assert(!got.includes("MESH-MEMBERSHIP-TOKEN"),
      "the caller's mesh membership token was delivered to the upstream service");
  },

  "X-07": (impl) => {
    const req = new Request("http://upstream.local/x", {
      headers: { "x-app": "keep me", accept: "application/json", "x-trace": "abc123" },
    });
    const out = inter(impl).asIntermediary(req, { via: "httpeers/1.0" });
    for (const [k, v] of [["x-app", "keep me"], ["accept", "application/json"], ["x-trace", "abc123"]] as const) {
      assert(out.headers.get(k) === v, `application header \`${k}\` was dropped or rewritten (P2)`);
    }
  },

  "X-08": {
    skip: "detecting a peer that re-issues WITHOUT the transform needs a conformance hook on the peer itself; the transform's own behaviour is covered by X-05..X-07",
  },

  "X-09": (impl) => {
    const i = inter(impl);
    const creds = { "upstream.local": "Bearer UPSTREAM-KEY" };
    const registered = i.asIntermediary(new Request("http://upstream.local/x"), { via: "v", credentials: creds });
    assert(registered.headers.get("authorization") === "Bearer UPSTREAM-KEY",
      "the credential registered for this host was not injected");
    const other = i.asIntermediary(new Request("http://elsewhere.local/x"), { via: "v", credentials: creds });
    assert(!(other.headers.get("authorization") ?? "").includes("UPSTREAM-KEY"),
      "a credential registered for one host was sent to another");
  },

  "X-10": {
    skip: "needs a live peer to prove no upstream credential is observable from the mesh side, including in errors and logs",
  },

  // ---------------------------------------------------- block C: cross-cutting
  "C-01": { skip: "needs a live transport to produce the failures the taxonomy classifies" },
  "C-02": { skip: "needs a live transport failure to check `cause` was retained" },
  "C-03": { skip: "needs an edge performing the status mapping (block E is DESIGNED)" },
  "C-04": { skip: "needs an edge and a real peer response to distinguish synthesized from origin" },
  "C-05": { skip: "needs a live outbound call to exhaust a request timeout" },
  "C-06": { skip: "needs a live admission queue to prove queueing shares the deadline" },
  "C-07": { skip: "needs a live remote handler to observe its Request.signal firing" },
  "C-08": { skip: "needs a live outbound path to saturate the admission semaphore" },
};
