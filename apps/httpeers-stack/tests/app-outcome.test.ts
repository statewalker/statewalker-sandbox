/**
 * Task 13, Steps 3 and 5: how the main app page reads a mesh response
 * (`src/pages/app/outcome.ts`).
 *
 * The two things under test are the two the brief is specific about:
 *  - a 403 yields the access tree's own `reason`, VERBATIM. A-1's
 *    `{allowed, source, reason}` exists so a denial is debuggable by
 *    someone who did not write the policy; a page that paraphrased it would
 *    throw that away at the last step.
 *  - a failed call yields T-2's `kind` as a discriminant, and the page
 *    renders a DIFFERENT line for each row of the taxonomy. Collapsing them
 *    back into "request failed" would undo the reason T-2 was moved ahead
 *    of the product tasks.
 *
 * The 403 bodies below are not invented for this test: they are the exact
 * shape `httpeers.core`'s `access-tree.ts` produces (`json({ error:
 * decision.reason }, status)`), with reasons taken verbatim from
 * `resolveAccess`'s own branches. `tests/admin.test.ts` asserts the hub
 * really does answer with them.
 */
import type { PeerErrorKind } from "@statewalker/httpeers.core";
import { describe, expect, it } from "vitest";
import { PEER_ERROR_STATUS } from "../src/browser/edge-dispatch.js";
import { describeOutcome, describePeerError, readOutcome } from "../src/pages/app/outcome.js";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Step 3: a denial renders the access tree's reason verbatim", () => {
  it("a 403 naming the missing capability comes through unaltered", async () => {
    // `resolveAccess`'s own wording for a caller whose roles expand to none
    // of the required capabilities.
    const reason = "requires one of: std:mesh.admin";
    const outcome = await readOutcome(jsonResponse({ error: reason }, 403));

    expect(outcome).toEqual({ status: "denied", httpStatus: 403, reason });
    // VERBATIM: the exact string the policy produced appears in what the
    // user is shown, uninterpreted.
    expect(describeOutcome(outcome)).toContain(reason);
  });

  it("a 403 naming a revoked membership comes through unaltered too", async () => {
    const reason = "membership revoked";
    const outcome = await readOutcome(jsonResponse({ error: reason }, 403));
    expect(outcome).toEqual({ status: "denied", httpStatus: 403, reason });
    expect(describeOutcome(outcome)).toContain(reason);
  });

  it("a 401 is a denial too, and keeps its own reason", async () => {
    const outcome = await readOutcome(jsonResponse({ error: "membership token required" }, 401));
    expect(outcome).toEqual({
      status: "denied",
      httpStatus: 401,
      reason: "membership token required",
    });
  });
});

describe("Step 5: T-2's taxonomy survives to the page", () => {
  const kinds = Object.keys(PEER_ERROR_STATUS) as PeerErrorKind[];

  for (const kind of kinds) {
    it(`a ${kind} response is read as unreachable, carrying that kind`, async () => {
      const res = jsonResponse(
        { error: `something about ${kind}`, kind, peerId: "12D3KooTarget" },
        PEER_ERROR_STATUS[kind],
      );
      const outcome = await readOutcome(res);

      expect(outcome.status).toBe("unreachable");
      expect(outcome).toMatchObject({ kind, peerId: "12D3KooTarget" });
    });
  }

  it("every kind gets its OWN line -- the taxonomy is not collapsed at the last step", () => {
    const lines = kinds.map((kind) => describePeerError(kind, "12D3KooTarget"));
    expect(new Set(lines).size).toBe(kinds.length);
  });

  it("a 502 that is NOT one of T-2's is a plain failure, not a fabricated peer error", async () => {
    // Any intermediary can produce a 502. Only a body carrying one of T-2's
    // kinds is actually T-2 speaking -- reading the status alone would let
    // the page report a network condition nobody diagnosed.
    const outcome = await readOutcome(jsonResponse({ error: "bad gateway" }, 502));
    expect(outcome).toEqual({ status: "failed", httpStatus: 502, message: "bad gateway" });
  });

  it("a body claiming an unrecognised kind is not trusted", async () => {
    const outcome = await readOutcome(
      jsonResponse({ error: "nope", kind: "made-up-kind", peerId: "x" }, 502),
    );
    expect(outcome.status).toBe("failed");
  });
});

describe("everything else", () => {
  it("a 2xx is `ok` and hands back the parsed body", async () => {
    const outcome = await readOutcome(jsonResponse({ results: [{ id: "a" }] }, 200));
    expect(outcome).toEqual({ status: "ok", body: { results: [{ id: "a" }] } });
  });

  it("a 404 from the router is a plain failure carrying its own error text", async () => {
    // `createPeerRouter`'s own shape for a path no mount claims.
    const outcome = await readOutcome(jsonResponse({ error: "not found", path: "/nope" }, 404));
    expect(outcome).toEqual({ status: "failed", httpStatus: 404, message: "not found" });
  });

  it("a 400 from a service keeps the service's reason", async () => {
    const outcome = await readOutcome(
      jsonResponse({ error: "q is required and must not be empty" }, 400),
    );
    expect(outcome).toMatchObject({ status: "failed", httpStatus: 400 });
  });

  it("a NON-JSON error body does not throw -- it degrades to the raw text", async () => {
    // Exactly what the static server answers if the edge was missed
    // entirely and the request fell through to it: `text/plain`, "not
    // found". A page that threw on `res.json()` here would turn a
    // diagnosable routing mistake into an unhandled rejection with no
    // status in it at all.
    const outcome = await readOutcome(
      new Response("not found", { status: 404, headers: { "content-type": "text/plain" } }),
    );
    expect(outcome).toEqual({ status: "failed", httpStatus: 404, message: "not found" });
  });

  it("an empty body falls back to the status text", async () => {
    const outcome = await readOutcome(new Response(null, { status: 500, statusText: "Boom" }));
    expect(outcome).toMatchObject({ status: "failed", httpStatus: 500 });
  });

  it("a bare 500 is NOT reported as a peer being unreachable", async () => {
    // The failure Ruling 60 exists to prevent, asserted from the page's
    // side: before the mapping existed, EVERY transport failure arrived
    // like this. If this ever reads `unreachable` again, the mapping has
    // been lost somewhere upstream.
    const outcome = await readOutcome(new Response(null, { status: 500 }));
    expect(outcome.status).toBe("failed");
  });
});
