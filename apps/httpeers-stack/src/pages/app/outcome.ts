/**
 * How the main app page reads a `Response` that came back from the mesh.
 *
 * THE PAGE NEVER PARSES A MESSAGE STRING TO DECIDE ANYTHING. That is the
 * whole point of T-2 (`httpeers.core`'s `errors.ts`) and of Ruling 60's
 * mapping in `browser/edge-dispatch.ts`: a failed mesh call comes back as
 * an ordinary HTTP response whose body carries a stable `kind`
 * discriminant, so this module switches on `res.status` and on `body.kind`
 * -- never on wording. `body.error`/`reason` text is rendered VERBATIM to a
 * human and read by nothing.
 *
 * FOUR OUTCOMES, BECAUSE FOUR THINGS GENUINELY DIFFER:
 *  - `ok`: the provider answered.
 *  - `denied`: the provider answered, and refused. 403 (a capability the
 *    caller lacks, or a revoked membership) or 401 (no usable token at
 *    all). The `.access` tree's own `reason` travels in the JSON body's
 *    `error` field (`httpeers.core`'s `access-tree.ts`, which answers
 *    `json({ error: decision.reason }, status)`), and A-1's
 *    `{allowed, source, reason}` exists precisely so that reason is
 *    debuggable by someone who did not write the policy. It is rendered
 *    unaltered -- summarising it would throw away the only thing that makes
 *    a denial explicable.
 *  - `unreachable`: the provider never answered at all. This is the row
 *    `edge-dispatch.ts` synthesises from a thrown `PeerCallError`, and
 *    `kind` says which of T-2's conditions it was.
 *  - `failed`: anything else -- a 404, a 400, a genuine 500. Deliberately
 *    NOT folded into `unreachable`: a 500 from a provider's own handler is
 *    a bug in that provider, not a network condition, and telling a user to
 *    retry it would be wrong.
 *
 * NO PAGE-LOCAL TIMEOUT ANYWHERE IN THIS FILE OR ITS CALLERS (Step 5, as
 * amended). The transport owns that policy now (`DEFAULT_REQUEST_TIMEOUT_MS`,
 * `transport-duplex.ts`) and surfaces it as `kind: "request-timeout"`; a
 * second clock here would be a competing policy with a different number,
 * which is exactly the per-application reinvention moving T-2 ahead of the
 * product tasks was meant to prevent.
 */
import type { PeerErrorKind } from "@statewalker/httpeers.core";
import { PEER_ERROR_STATUS, type PeerErrorBody } from "../../browser/edge-dispatch.js";

export type CallOutcome =
  | { status: "ok"; body: unknown }
  | { status: "denied"; httpStatus: number; reason: string }
  | { status: "unreachable"; kind: PeerErrorKind; peerId: string; message: string }
  | { status: "failed"; httpStatus: number; message: string };

/** Every `kind` `edge-dispatch.ts` can report, as a runtime set -- derived from the status table so the two can never drift apart. */
const PEER_ERROR_KINDS = new Set<string>(Object.keys(PEER_ERROR_STATUS));

function isPeerErrorBody(body: unknown): body is PeerErrorBody {
  if (typeof body !== "object" || body == null) return false;
  const candidate = body as Record<string, unknown>;
  return typeof candidate.kind === "string" && PEER_ERROR_KINDS.has(candidate.kind);
}

/**
 * Reads a mesh response into exactly one `CallOutcome`. Consumes the body
 * once; the caller gets the parsed JSON back on the `ok` path.
 *
 * A NON-JSON BODY IS NOT A CRASH. A response can legitimately carry
 * anything (a 404 from the static server if the edge was missed entirely,
 * an HTML error page from something in between), and a page that threw on
 * `res.json()` would turn a diagnosable failure into an unhandled
 * rejection with no status in it at all.
 */
export async function readOutcome(res: Response): Promise<CallOutcome> {
  let body: unknown;
  let raw = "";
  try {
    raw = await res.text();
    body = raw === "" ? null : JSON.parse(raw);
  } catch {
    body = null;
  }

  if (res.ok) return { status: "ok", body };

  if (res.status === 401 || res.status === 403) {
    const reason =
      typeof (body as { error?: unknown } | null)?.error === "string"
        ? (body as { error: string }).error
        : raw || res.statusText;
    return { status: "denied", httpStatus: res.status, reason };
  }

  // The `kind` in the body decides this, NOT the status code: 502/504 are
  // what `edge-dispatch.ts` chose, but any intermediary can produce a 502
  // of its own, and only a body carrying one of T-2's kinds is actually
  // T-2 speaking.
  if (isPeerErrorBody(body)) {
    return {
      status: "unreachable",
      kind: body.kind,
      peerId: body.peerId,
      message: body.error,
    };
  }

  const message =
    typeof (body as { error?: unknown } | null)?.error === "string"
      ? (body as { error: string }).error
      : raw || res.statusText;
  return { status: "failed", httpStatus: res.status, message };
}

/**
 * What a user is told about each of T-2's kinds. One line per row of the
 * taxonomy, because the whole reason the taxonomy exists is that these are
 * DIFFERENT conditions with different remedies -- collapsing them back into
 * "request failed" here would undo it at the last step.
 */
export function describePeerError(kind: PeerErrorKind, peerId: string): string {
  switch (kind) {
    case "peer-unreachable":
      return `that peer is not reachable right now (${peerId}) — it may have closed its page`;
    case "request-timeout":
      return `the peer did not answer in time (${peerId}) — the transport gave up waiting`;
    case "protocol-unsupported":
      return `that peer does not speak this mesh's protocol (${peerId})`;
    case "stream-reset":
      return `the connection to that peer was reset mid-request (${peerId})`;
    case "relay-limit-exceeded":
      return `the relay's data limit for that connection was exceeded (${peerId})`;
    case "unknown":
      return `the call to that peer failed for an unrecognised reason (${peerId})`;
  }
}

/** One line of human-readable text for any non-`ok` outcome. `denied` renders the tree's own reason unaltered -- see the module comment. */
export function describeOutcome(outcome: CallOutcome): string {
  switch (outcome.status) {
    case "ok":
      return "ok";
    case "denied":
      return `refused (${outcome.httpStatus}): ${outcome.reason}`;
    case "unreachable":
      return describePeerError(outcome.kind, outcome.peerId);
    case "failed":
      return `failed (${outcome.httpStatus}): ${outcome.message}`;
  }
}
