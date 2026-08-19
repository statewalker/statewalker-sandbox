/**
 * The hub process: an ordinary peer (note 03) whose `mounts` factory
 * happens to be this module's `.well-known` surface. Nothing here is a
 * special peer type — `createPeer` never learns it is building "a hub"; it
 * only hands the factory a `mintToken` closure over the signing key it
 * retains.
 *
 * Key persistence (`./.httpeers/hub.key`) and the invitation payload
 * (`httpeers.json`) are the setup CLI's job (a later task) — this module
 * generates and holds an ephemeral key when run standalone, which is enough
 * to prove the wiring and is what the tests exercise. Wiring a real key
 * file in is additive, not a rewrite, when that task lands.
 *
 * THE TTL SWEEP IS THE HUB'S ONLY SCHEDULER (note 09 §6). "A peer went
 * down" is not an event anyone sends; it is a fact this timer produces by
 * noticing a presence entry has not been refreshed. 1 s granularity keeps
 * "leaves the view within one TTL" tight rather than adding a second timer
 * period on top of the 15 s TTL itself.
 */
import { createMemberStore, createPeer, RevocationRegistry } from "@statewalker/httpeers.core";
import { HUB_ACCESS, VOCABULARY } from "../policy.js";
import { createHubEndpoints, DEFAULT_PRESENCE_TTL_MS, usesTransportIdentity } from "./endpoints.js";
import { createPersistentHub } from "./persist.js";

/** How often the hub checks for stale presence. See the module comment. */
export const SWEEP_INTERVAL_MS = 1_000;

/** The longest life of a token this hub mints — sets the revocation registry's pruning horizon. */
const MAX_TOKEN_TTL_MS = 5 * 60_000;

export interface StartHubInit {
  /** Where members and spent invitation ids are snapshotted. Defaults to `./.httpeers/hub-state.json`. */
  stateFilePath?: string;
  listen?: string[];
  presenceTtlMs?: number;
  advertisementAccess?: Record<string, string>;
}

export async function startHub(init: StartHubInit = {}) {
  const stateFilePath = init.stateFilePath ?? "./.httpeers/hub-state.json";
  // This application's own vocabulary (`policy.ts`), not `httpeers.core`'s
  // generic library default -- `DEFAULT_VOCABULARY` has no `app:` capability
  // at all, so `/search` could never be granted under it. See `policy.ts`'s
  // module comment.
  const vocabulary = VOCABULARY;
  const revocations = new RevocationRegistry({ maxTokenTtlMs: MAX_TOKEN_TTL_MS });

  const persistent = createPersistentHub({
    filePath: stateFilePath,
    vocabulary,
    createMemberStore,
  });

  let sweep: (() => void) | undefined;

  const peer = await createPeer({
    listen: init.listen,
    accessTree: HUB_ACCESS,
    vocabulary,
    usesTransportIdentity: usesTransportIdentity(),
    // The hub enforces revocation on ITS OWN endpoints by consulting its own
    // live `RevocationRegistry` directly -- no cache, no pull: it already
    // holds the source of truth in this same process. This is the SAME
    // `revocations` instance `createHubEndpoints` below uses to bump the
    // policy version on `DELETE /admin/members/{peerId}`, so a revoked
    // token stops working on the very next request to ANY hub mount, not
    // just the one route someone remembered to check.
    revocationCache: revocations,
    mounts: (ctx) => {
      const hub = createHubEndpoints({
        selfPeerId: ctx.peerId,
        mintToken: ctx.mintToken,
        memberStore: persistent.memberStore,
        invitations: persistent.invitations,
        vocabulary,
        revocations,
        presenceTtlMs: init.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS,
        advertisementAccess: init.advertisementAccess,
      });
      sweep = hub.sweep;
      return hub.mounts;
    },
  });

  const timer = setInterval(() => sweep?.(), SWEEP_INTERVAL_MS);
  timer.unref?.();

  return {
    peer,
    revocations,
    memberStore: persistent.memberStore,
    invitations: persistent.invitations,
    async stop() {
      clearInterval(timer);
      await peer.stop();
    },
  };
}

// Run directly (e.g. `tsx src/hub/main.ts`) rather than only as a library import.
if (import.meta.url === `file://${process.argv[1]}`) {
  const hub = await startHub({ listen: ["/ip4/0.0.0.0/tcp/0"] });
  console.log(`hub peerId: ${hub.peer.peerId}`);
  console.log(`hub addrs: ${hub.peer.addrs().join(", ")}`);
}
