/**
 * The hub process: an ordinary peer (note 03) whose `mounts` factory
 * happens to be this module's `.well-known` surface. Nothing here is a
 * special peer type — `createPeer` never learns it is building "a hub"; it
 * only hands the factory a `mintToken` closure over the signing key it
 * retains.
 *
 * IDENTITY IS NOT GENERATED HERE. The hub's peerId IS the mesh identity:
 * the `mesh` claim in every token this hub mints restates it, which is what
 * lets a provider verify a token offline with no key fetch. An ephemeral
 * key here would not merely change an address (as it would for the relay,
 * note 07's `../relay/main.ts`) — it would make this process silently a
 * DIFFERENT mesh on every restart, invalidating every previously issued
 * token and every `.access` policy naming the issuer, while `httpeers.json`
 * (Task 10's setup CLI) kept naming the OLD peerId as the identity every
 * daemon and browser page is told to trust. So, mirroring the relay's own
 * contract exactly: the key MUST come from `.httpeers/hub.key`, written
 * once by `pnpm setup`; if it is missing, this process fails loudly and
 * exits rather than papering over the gap with a fresh identity nobody
 * asked for. (This module's own comment previously deferred this to
 * "a later task" — Task 10 is that task; see its own PROVENANCE.md entry.)
 *
 * KEY FILE FORMAT: identical to the relay's — the protobuf encoding
 * `@libp2p/crypto/keys`'s own `privateKeyToProtobuf`/`privateKeyFromProtobuf`
 * round-trip through. Same loader shape as `../relay/main.ts`'s
 * `loadRelayKey`, deliberately not shared code: each process's "fail
 * loudly, name the missing file, tell the operator to run `pnpm setup`"
 * message is specific to which key is missing.
 *
 * THE TTL SWEEP IS THE HUB'S ONLY SCHEDULER (note 09 §6). "A peer went
 * down" is not an event anyone sends; it is a fact this timer produces by
 * noticing a presence entry has not been refreshed. 1 s granularity keeps
 * "leaves the view within one TTL" tight rather than adding a second timer
 * period on top of the 15 s TTL itself.
 */
import { readFileSync } from "node:fs";
import { privateKeyFromProtobuf } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import {
  createMemberStore,
  createMonotonicClock,
  createPeer,
  RevocationRegistry,
} from "@statewalker/httpeers.core";
import { HUB_ACCESS, VOCABULARY } from "../policy.js";
import { createHubEndpoints, DEFAULT_PRESENCE_TTL_MS, usesTransportIdentity } from "./endpoints.js";
import { createPersistentHub } from "./persist.js";

/** How often the hub checks for stale presence. See the module comment. */
export const SWEEP_INTERVAL_MS = 1_000;

/** The longest life of a token this hub mints — sets the revocation registry's pruning horizon. */
const MAX_TOKEN_TTL_MS = 5 * 60_000;

/** Where `pnpm setup` (Task 10) writes the hub's signing key, and where this process reads it back from. */
export const DEFAULT_HUB_KEY_PATH = "./.httpeers/hub.key";

export interface StartHubInit {
  /** Where members and spent invitation ids are snapshotted. Defaults to `./.httpeers/hub-state.json`. */
  stateFilePath?: string;
  /** Where the hub's signing key is read from. Defaults to `DEFAULT_HUB_KEY_PATH`. */
  keyPath?: string;
  listen?: string[];
  presenceTtlMs?: number;
  advertisementAccess?: Record<string, string>;
}

/**
 * Reads and decodes the hub's signing key from `keyPath`. Exits the process
 * (after printing guidance) if the file is absent -- mirrors
 * `../relay/main.ts`'s `loadRelayKey` exactly; see this module's own
 * comment ("IDENTITY IS NOT GENERATED HERE") for why a fresh key is not an
 * acceptable fallback here either.
 */
function loadHubKey(keyPath: string): Ed25519PrivateKey {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(keyPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`hub: no signing key found at "${keyPath}".`);
      console.error(
        'hub: run "pnpm setup" first -- it generates the relay and hub keys this process needs.',
      );
      console.error(
        "hub: refusing to start with a freshly generated key: this hub's peerId IS the mesh",
      );
      console.error(
        "hub: identity -- every token's `mesh` claim restates it -- so an ephemeral identity would",
      );
      console.error("hub: silently found a different mesh on every restart.");
      process.exit(1);
    }
    throw err;
  }
  const key = privateKeyFromProtobuf(bytes);
  if (key.type !== "Ed25519") {
    throw new Error(
      `hub: key at "${keyPath}" is a ${key.type} key -- only Ed25519 is supported (design note 05 §2).`,
    );
  }
  return key;
}

export async function startHub(init: StartHubInit = {}) {
  const stateFilePath = init.stateFilePath ?? "./.httpeers/hub-state.json";
  const keyPath = init.keyPath ?? DEFAULT_HUB_KEY_PATH;
  const privateKey = loadHubKey(keyPath);
  // This application's own vocabulary (`policy.ts`), not `httpeers.core`'s
  // generic library default -- `DEFAULT_VOCABULARY` has no `app:` capability
  // at all, so `/search` could never be granted under it. See `policy.ts`'s
  // module comment.
  const vocabulary = VOCABULARY;
  // ONE shared clock for this hub's minting AND its revocation registry —
  // see `revocation.ts`'s "ONE HUB-ISSUED CLOCK, NOT TWO". Two independent
  // `Date.now` defaults can tie (mint a token, then revoke that same peer,
  // both well within a millisecond); a `RevocationRegistry` and a
  // `mintToken` call drawing from the SAME monotonic instance cannot.
  const clock = createMonotonicClock();
  const revocations = new RevocationRegistry({ maxTokenTtlMs: MAX_TOKEN_TTL_MS, now: clock });

  const persistent = createPersistentHub({
    filePath: stateFilePath,
    vocabulary,
    createMemberStore,
  });

  let sweep: (() => void) | undefined;

  const peer = await createPeer({
    privateKey,
    listen: init.listen,
    accessTree: HUB_ACCESS,
    vocabulary,
    usesTransportIdentity: usesTransportIdentity(),
    now: clock,
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
