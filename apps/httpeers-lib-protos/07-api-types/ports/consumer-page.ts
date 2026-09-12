/**
 * PORT 2 — `src/pages/app/main.ts` + `src/browser/session.ts`, against the API.
 *
 * The other consumer a critic declared NOT BUILDABLE. It is the hardest of the
 * pages because almost none of it is the happy path: first visit, reload with
 * no query string, a spent invitation still in the URL, identity drift, a
 * second tab, revocation while live, and two buttons that must work twice.
 *
 * Compile-only. Every numbered comment names the prototype behaviour that
 * forced an API feature; every FINDING names something the API still lacks.
 */

import {
  type Advertisement,
  Busy,
  connect,
  createGateway,
  JoinFailed,
  type JoinInput,
  type MeshRef,
  type PeerId,
  readJoinInput,
  type Session,
} from "../src/api.js";
import { biscuit, idbIdentity, idbMesh, libp2p, mountSameOrigin } from "../src/stubs.js";

/** What the page renders. Derived from the session's phase, never tracked in parallel. */
export type Screen =
  | { kind: "checking" }
  | { kind: "needs-invitation"; myPeerId: PeerId }
  | { kind: "joining"; step: string }
  | { kind: "ready"; providers: readonly ProviderRow[]; baseUrl: string }
  | { kind: "kicked"; why: string }
  | { kind: "error"; message: string; canRetry: boolean };

export interface ProviderRow {
  peerId: PeerId;
  title: string;
  kind: string;
}

export interface Page {
  screen(): Screen;
  /** The join form and the QR scanner both land here. Pressable twice. */
  submit(text: string): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  resetIdentity(): Promise<void>;
  /** Fetch a provider's resource the ordinary way — no peer id typed by hand. */
  open(kind: string, path: string): Promise<Response>;
}

/** The deployment's own mesh, from `httpeers.json`. An invitation id alone names no mesh. */
export async function startPage(deployment: MeshRef): Promise<Page> {
  const identity = idbIdentity();
  const memory = idbMesh();

  let session: Session | null = null;
  let screen: Screen = { kind: "checking" };
  let baseUrl = "";

  // (1) THE PEER ID BEFORE ANY NODE EXISTS. "This browser is X and that hub
  //     does not know X" is the distinction users could not otherwise make,
  //     and it needs the key read without joining anything.
  const existing = await identity.read();
  const myPeerId: PeerId | null = existing == null ? null : peerIdOfLocal(existing);

  // (2) RESUME WITH NO QUERY STRING. The remembered mesh is separate from the
  //     deployment's: a page that joined a browser-hub mesh must come back to
  //     THAT one, not to the one httpeers.json names.
  const remembered = await memory.read();

  const attempt = async (input: JoinInput): Promise<void> => {
    try {
      session = await connect({
        transport: libp2p,
        access: biscuit,
        identity,
        memory,
        join: input,
        // (3) The page serves nothing, but it still must be able to.
        publish: (): readonly Advertisement[] => [],
      });

      // (4) The edge. A page needs a URL before it can fetch anything, and the
      //     gateway is what produces one. `basePath` is forced to "/{key}"
      //     because a ServiceWorker cannot mount at "/".
      const gateway = createGateway({
        node: session.node,
        basePath: "/peers",
        token: () => session!.membership.token(),
        view: () => session!.membership.view(),
      });
      const mounted = await mountSameOrigin({ key: "peers", handler: gateway });
      baseUrl = mounted.baseUrl;

      // (5) PHASE IS READ FROM THE SESSION, never mirrored. The prototype's
      //     bug class was a page whose own state drifted from the library's.
      session.events.on((phase) => {
        if (phase.kind === "refused") {
          // (6) A refusal AFTER the join resolved — a membership revoked under
          //     a live page. It has to be a typed channel: string-matching a
          //     log line is what the prose design left the page doing.
          screen = { kind: "kicked", why: phase.refusal.message };
          return;
        }
        if (phase.kind === "live") screen = renderReady();
        if (phase.kind === "joining") screen = { kind: "joining", step: phase.step };
      });

      screen = renderReady();
    } catch (error) {
      screen = describe(error);
    }
  };

  const renderReady = (): Screen => {
    const view = session?.membership.view();
    // (7) "NO VIEW YET" IS A REAL STATE, distinct from "nobody is here".
    if (view == null) return { kind: "joining", step: "waiting for the first heartbeat" };
    // (8) Discovery by KIND, never by peer id — and the offers list is flat,
    //     because the hub advertises under its own id and is in no peer list.
    const providers = view.offers.map((offer) => ({
      peerId: offer.peerId,
      title: offer.title,
      kind: offer.kind,
    }));
    return { kind: "ready", providers, baseUrl };
  };

  const describe = (error: unknown): Screen => {
    // (9) TYPED FAILURES, switched on — not string-matched.
    if (error instanceof JoinFailed) {
      switch (error.reason) {
        case "not-a-member":
          return { kind: "needs-invitation", myPeerId: error.peerId };
        case "invitation-refused":
          // A spent invitation still in the URL on reload: the commonest case.
          return { kind: "needs-invitation", myPeerId: error.peerId };
        case "duplicate-identity":
          return { kind: "error", message: "another tab holds this identity", canRetry: false };
        case "no-mesh":
          return { kind: "needs-invitation", myPeerId: error.peerId };
        default:
          return { kind: "error", message: error.message, canRetry: true };
      }
    }
    // (10) A SECOND CLICK while an attempt runs. Without this the page builds
    //      two libp2p nodes on one identity and manufactures the duplicate it
    //      then reports.
    if (error instanceof Busy) return screen;
    return { kind: "error", message: String(error), canRetry: true };
  };

  // (11) First paint: resume if we can, otherwise ask for an invitation.
  if (remembered != null) {
    await attempt({ kind: "resume", mesh: remembered });
  } else if (myPeerId != null) {
    screen = { kind: "needs-invitation", myPeerId };
  } else {
    screen = { kind: "needs-invitation", myPeerId: await freshPeerId(identity) };
  }

  return {
    screen: () => screen,

    submit: async (text: string) => {
      // (12) One parser for a scanned code, a pasted URL and a `?join=` query,
      //      with the deployment as the fallback mesh for a bare id.
      const input = readJoinInput(text, deployment);
      if (input == null) {
        screen = {
          kind: "error",
          message: "that does not look like an invitation",
          canRetry: true,
        };
        return;
      }
      await attempt(input);
    },

    // (13) Stop presence but STAY CALLABLE. The prototype's disconnect button
    //      does exactly this, and a full stop would force a re-`connect`.
    disconnect: async () => {
      await session?.pause();
    },
    reconnect: async () => {
      await session?.resume();
    },

    // (14) A fresh identity is the way back in when a hub no longer knows this
    //      browser — the "reset" control.
    resetIdentity: async () => {
      await session?.stop();
      session = null;
      await identity.clear();
      await memory.clear();
      screen = { kind: "needs-invitation", myPeerId: await freshPeerId(identity) };
    },

    // (15) THE POINT OF THE GATEWAY: an ordinary fetch, by kind, with no
    //      knowledge that libp2p exists anywhere in this function.
    open: async (kind: string, path: string) => {
      const view = session?.membership.view();
      const offer = view?.offers.find((o) => o.kind === kind);
      if (offer == null) throw new Error(`no provider offers ${kind}`);
      return await fetch(`${baseUrl}${offer.peerId}${path}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Findings — what this port could not do with the API as declared
// ---------------------------------------------------------------------------

/**
 * FINDING P-1. `peerIdOf` takes a `PrivateKey`, and the page has one, so this
 * works — but the page must import a key-shaped function to render a string.
 * A `IdentityStore.peerId(): Promise<PeerId | null>` would keep key bytes out
 * of page code entirely. Minor, and a real ergonomic wart.
 */
declare function peerIdOfLocal(
  key: Awaited<ReturnType<ReturnType<typeof idbIdentity>["read"]>> & object,
): PeerId;

/**
 * FINDING P-2. There is no way to obtain "the peer id I would have" without
 * creating the key. `loadOrCreate` then `peerIdOf` mints one as a side effect
 * of rendering a screen, which is why this helper exists rather than being
 * inline. The API should offer `identity.peerId()` that creates on demand and
 * says so.
 */
declare function freshPeerId(store: ReturnType<typeof idbIdentity>): Promise<PeerId>;
