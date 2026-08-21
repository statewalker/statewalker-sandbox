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
 * once by `pnpm bootstrap`; if it is missing, this process fails loudly and
 * exits rather than papering over the gap with a fresh identity nobody
 * asked for. (This module's own comment previously deferred this to
 * "a later task" — Task 10 is that task; see its own PROVENANCE.md entry.)
 *
 * KEY FILE FORMAT: identical to the relay's — the protobuf encoding
 * `@libp2p/crypto/keys`'s own `privateKeyToProtobuf`/`privateKeyFromProtobuf`
 * round-trip through. Same loader shape as `../relay/main.ts`'s
 * `loadRelayKey`, deliberately not shared code: each process's "fail
 * loudly, name the missing file, tell the operator to run `pnpm bootstrap`"
 * message is specific to which key is missing.
 *
 * THE TTL SWEEP IS THE HUB'S ONLY SCHEDULER (note 09 §6). "A peer went
 * down" is not an event anyone sends; it is a fact this timer produces by
 * noticing a presence entry has not been refreshed. 1 s granularity keeps
 * "leaves the view within one TTL" tight rather than adding a second timer
 * period on top of the 15 s TTL itself.
 *
 * THE HUB IS REACHED THROUGH THE RELAY, WHICH MEANS IT BUILDS ITS OWN NODE
 * (Task 20). `createPeer`'s default construction path calls
 * `httpeers.core`'s `createNode`, whose transports are `[tcp()]` and nothing
 * else -- so a hub built that way holds no reservation, has no
 * `/p2p-circuit` address, and is unreachable from any browser page. Task 14
 * measured exactly that. This module therefore builds the node itself from
 * `./node-profile.ts`, dials `relayAddr`, and WAITS for the reservation to
 * land before `startHub` resolves: a page that reads `httpeers.json` and
 * dials the instant the stack comes up must not race the hub's own
 * bootstrap. A hub that cannot reserve throws rather than coming up
 * silently unreachable -- the failure this whole arrangement exists to end.
 *
 * OWNERSHIP FOLLOWS `createPeer`'S RULE, NOT CONVENIENCE. A node handed to
 * `createPeer` is never `createPeer`'s to stop (`peer.ts`'s `ownsNode`), so
 * whoever supplied it must. When `startHub` builds the node it stops it in
 * its own teardown; when a CALLER supplies one through `StartHubInit.node`,
 * `startHub` leaves it alone and the caller stops it. Same split
 * `../browser/peer-runtime.ts` makes for the browser side.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { privateKeyFromProtobuf } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import type { Libp2p } from "@statewalker/httpeers.core";
import {
  createMemberStore,
  createMonotonicClock,
  createPeer,
  RevocationRegistry,
} from "@statewalker/httpeers.core";
import { HUB_ACCESS, VOCABULARY } from "../policy.js";
import { dialRelay, waitForCircuitReservation } from "../reservation.js";
import { APP_PORT, IMAGE_PEER_PORT } from "../static-server/main.js";
import { createHubEndpoints, DEFAULT_PRESENCE_TTL_MS, usesTransportIdentity } from "./endpoints.js";
import { createHubNode } from "./node-profile.js";
import { createPersistentHub } from "./persist.js";

/** How often the hub checks for stale presence. See the module comment. */
export const SWEEP_INTERVAL_MS = 1_000;

/** The longest life of a token this hub mints — sets the revocation registry's pruning horizon. */
const MAX_TOKEN_TTL_MS = 5 * 60_000;

/** Where `pnpm bootstrap` (Task 10) writes the hub's signing key, and where this process reads it back from. */
export const DEFAULT_HUB_KEY_PATH = "./.httpeers/hub.key";

/** Where `pnpm bootstrap` wrote the invitation payload this process reads `relayAddrs[0]` out of. Same file `../static-server/main.ts` serves to pages. */
export const DEFAULT_HTTPEERS_CONFIG_PATH = "./httpeers.json";

/**
 * The TCP port the hub's direct (same-host, Node-peer) address binds to when
 * this module is run as a process.
 *
 * A FIXED DEFAULT, NOT PORT 0. `/ip4/0.0.0.0/tcp/0` -- what this block used
 * before Task 20 -- produced an ephemeral port printed to a log and written
 * nowhere, so nothing could ever dial it; it was an address in name only.
 * Browsers do not use this address at all (they take the `/p2p-circuit`
 * one), so its only job is to be knowable to a Node peer on the same host,
 * and a knowable port is the whole of that job. 9091 sits next to the
 * relay's own 9090 (`../relay/main.ts`'s `DEFAULT_RELAY_PORT`). Override
 * with `HUB_PORT`.
 */
export const DEFAULT_HUB_PORT = 9091;

/**
 * Where the run-as-a-process block records that the hub has finished
 * bootstrapping -- key loaded, node up, reservation HELD. `scripts/start.sh`
 * waits for this file rather than sleeping.
 *
 * A FILE, NOT A PARSED LOG LINE. `scripts/start.sh`'s own module comment
 * refuses to scrape a child's stdout, and rightly: this stack's durable
 * facts travel through files (`httpeers.json`), not through log formats
 * nobody has pinned. A TCP probe would not do either -- libp2p opens its
 * listeners during `node.start()`, which is BEFORE the relay has granted a
 * reservation, so an open hub port proves the process is running and says
 * nothing about whether it is reachable. This file is written after the
 * reservation and only after it.
 */
export const DEFAULT_HUB_READY_PATH = "./.httpeers/hub-ready";

export interface StartHubInit {
  /** Where members and spent invitation ids are snapshotted. Defaults to `./.httpeers/hub-state.json`. */
  stateFilePath?: string;
  /** Where the hub's signing key is read from. Defaults to `DEFAULT_HUB_KEY_PATH`. */
  keyPath?: string;
  /**
   * Direct addresses the hub's node listens on, in addition to the
   * `/p2p-circuit` and `/webrtc` its profile always adds. Ignored when
   * `node` is supplied -- that node's addresses are the caller's business.
   */
  listen?: string[];
  presenceTtlMs?: number;
  advertisementAccess?: Record<string, string>;
  /**
   * The relay this hub reserves a slot through -- `httpeers.json`'s
   * `relayAddrs[0]`, the same string every page dials.
   *
   * REQUIRED IN ANY REACHABLE DEPLOYMENT, and omitting it is a deliberate
   * choice rather than a default: a hub started without it holds no
   * reservation and is reachable only over whatever `listen` addresses it
   * was given, which is the pre-Task-20 arrangement no browser could use.
   * `tests/support/mesh.ts`'s hand-assembled hub is the legitimate case for
   * omitting it -- those suites test the protocol surface over direct
   * loopback and have no relay at all.
   */
  relayAddr?: string;
  /**
   * A libp2p node to use INSTEAD of building one from `./node-profile.ts`.
   * The seam `../browser/peer-runtime.ts` already uses on the browser side;
   * see this module's "OWNERSHIP FOLLOWS `createPeer`'S RULE" note for who
   * stops it. A supplied node is dialled at `relayAddr` and waited on for a
   * reservation exactly as a self-built one is -- the seam replaces the
   * node, not the bootstrap.
   */
  node?: Libp2p;
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
        'hub: run "pnpm bootstrap" first -- it generates the relay and hub keys this process needs.',
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

/**
 * Read `relayAddrs[0]` out of `httpeers.json`. Fails the same way
 * `loadHubKey` does -- named file, named remedy, non-zero exit -- because
 * the consequence is the same class of thing: without a relay address this
 * process can come up, print a peerId, and be reachable by nobody.
 */
function readRelayAddr(configPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`hub: no invitation payload found at "${configPath}".`);
      console.error('hub: run "pnpm bootstrap" first -- it writes httpeers.json.');
      console.error(
        "hub: without the relay's address this hub would hold no circuit reservation, and no",
      );
      console.error("hub: browser page could reach it. Set RELAY_ADDR to override the file.");
      process.exit(1);
    }
    throw err;
  }
  const relayAddr = (JSON.parse(raw) as { relayAddrs?: string[] }).relayAddrs?.[0];
  if (relayAddr == null) {
    throw new Error(
      `hub: "${configPath}" has an empty relayAddrs -- nothing to reserve a circuit slot through.`,
    );
  }
  return relayAddr;
}

/**
 * Of the `/p2p-circuit` addresses a reservation produces, return the one a
 * browser should actually dial -- the `/webrtc`-suffixed one.
 *
 * WHY THIS IS NOT COSMETIC. A reservation yields BOTH variants:
 * `.../p2p-circuit/p2p/<hub>` and `.../p2p-circuit/webrtc/p2p/<hub>`.
 * `waitForCircuitReservation` returns whichever it happens to see first,
 * which is the right answer to the question IT asks ("has a reservation
 * landed?") and the wrong one to publish, because this value is printed as
 * the hub's relayed address and written into `.httpeers/hub-ready`. Someone
 * copy-pasting the bare variant gets a LIMITED connection that refuses
 * `/httpeers/1.0.0` -- the exact failure `tests/e2e/node-consumer.test.ts`
 * pins, and a genuinely confusing five minutes for the person who hits it.
 *
 * Falls back to `reserved` if no `/webrtc` variant is present, rather than
 * throwing or waiting: a node built through `StartHubInit.node` need not
 * listen on `/webrtc` at all, and the reservation is real either way. The
 * run-as-a-process block warns when it sees that fall-back rather than
 * printing a bare circuit address as if it were dialable.
 */
function preferWebRtcCircuitAddr(node: Libp2p, reserved: string): string {
  const upgraded = node
    .getMultiaddrs()
    .map((addr) => addr.toString())
    .find((addr) => addr.includes("p2p-circuit") && addr.includes("/webrtc"));
  return upgraded ?? reserved;
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

  // The node is built HERE, not by `createPeer` -- see the module comment's
  // "THE HUB IS REACHED THROUGH THE RELAY" note. `ownsNode` mirrors
  // `httpeers.core`'s own rule for the same word: whoever built it stops it.
  const suppliedNode = init.node;
  const node = suppliedNode ?? (await createHubNode({ privateKey, listen: init.listen ?? [] }));
  const ownsNode = suppliedNode == null;

  /** Stop the node if and only if this function built it. Used by both `startFailed` and `stop()`. */
  const releaseNode = async (): Promise<void> => {
    if (ownsNode) await node.stop();
  };

  // EVERY RESOURCE THIS FUNCTION ACQUIRES IS UNWOUND IF A LATER STEP THROWS,
  // and that is not symmetry for its own sake. `node` is started and holding
  // a relay connection and a reservation the moment it exists; a `startHub`
  // that threw afterwards used to leave it running. Under vitest that
  // presents as a HANG rather than a failure -- the suite reports nothing
  // wrong and simply never exits -- which is the worst shape a bug can take
  // in a test run. `../browser/peer-runtime.ts`'s `startBrowserPeer` carries
  // the same stack for the same reason; the two are deliberately alike.
  const unwind: Array<() => Promise<void>> = [];
  if (ownsNode) unwind.push(releaseNode);
  const startFailed = async (): Promise<void> => {
    // A COPY, so `startFailed` is idempotent in order. `reverse()` mutates in
    // place, so unwinding twice off the same array would run the steps
    // forwards the second time -- harmless today (every catch below rethrows,
    // so this runs at most once) and silently wrong the moment someone adds a
    // path that does not.
    for (const step of [...unwind].reverse()) await step().catch(() => {});
  };

  // THE RESERVATION IS PART OF STARTING, NOT A BACKGROUND ERRAND. `startHub`
  // resolving is what `scripts/start.sh` and `tests/e2e/harness.ts` both
  // treat as "the hub is up"; if the reservation were still in flight at
  // that point, a page that dialled immediately would race it and fail with
  // an error pointing nowhere near the cause.
  let circuitAddr: string | undefined;
  if (init.relayAddr != null) {
    try {
      await dialRelay(node, init.relayAddr);
      const reserved = await waitForCircuitReservation(node);
      circuitAddr = preferWebRtcCircuitAddr(node, reserved);
    } catch (err) {
      // Loudly, and with the node closed. A hub that came up anyway would be
      // a hub no browser can reach, reporting success -- exactly the failure
      // Task 20 exists to end.
      await startFailed();
      throw new Error(
        `hub: could not reserve a circuit slot through the relay at "${init.relayAddr}" -- ` +
          "no browser can reach this hub without one. Is the relay running, and is this the " +
          `address "pnpm bootstrap" wrote into httpeers.json? Cause: ${String(err)}`,
        { cause: err },
      );
    }
  }

  // WRAPPED, because `createPeer` and the `mounts` factory below both run
  // real code that can throw -- `createHubEndpoints` validates its access
  // tree against the vocabulary, for one -- and by this point `node` is up
  // and holding a reservation. See `unwind` above for what an unstopped node
  // does to a test run.
  let peer: Awaited<ReturnType<typeof createPeer>>;
  try {
    peer = await createPeer({
      node,
      // STILL REQUIRED ALONGSIDE `node`, despite `CreatePeerInit.privateKey`'s
      // doc comment saying it is "ignored when `node` is supplied". That
      // sentence is about node CONSTRUCTION only: `peer.ts` skips generating a
      // key for a supplied node, but the `mintToken` closure it hands the
      // `mounts` factory still closes over whatever `privateKey` it was given,
      // and throws lazily when there was none. Dropping it here would leave the
      // hub unable to mint a single token -- and only at the first redemption,
      // not at startup. (Reported as a doc defect in `httpeers.core`, which
      // Task 20 may not modify.)
      privateKey,
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
  } catch (err) {
    await startFailed();
    throw err;
  }
  unwind.push(async () => await peer.stop());

  const timer = setInterval(() => sweep?.(), SWEEP_INTERVAL_MS);
  timer.unref?.();

  return {
    peer,
    node,
    /**
     * The relayed address a browser dials this hub at -- the
     * `/webrtc`-suffixed variant where one exists (`preferWebRtcCircuitAddr`),
     * because the bare `/p2p-circuit` sibling is a limited connection that
     * refuses `/httpeers/1.0.0`. `undefined` when no `relayAddr` was given.
     *
     * Its PRESENCE, not its exact value, is what `startHub` waited for, and
     * that is the ordering guarantee worth having: a caller holding this
     * knows the reservation landed before `startHub` resolved, so a page
     * that reads `httpeers.json` and dials immediately cannot race the
     * bootstrap.
     */
    circuitAddr,
    revocations,
    memberStore: persistent.memberStore,
    invitations: persistent.invitations,
    async stop() {
      clearInterval(timer);
      try {
        await peer.stop();
      } finally {
        // `peer.stop()` does NOT stop `node` -- it was supplied, and
        // `httpeers.core` never stops a node it did not build. See the
        // module comment's ownership note; `../browser/peer-runtime.ts`
        // makes the same call in the same `finally` shape, so a failure in
        // `peer.stop()` still leaves the relay connection closed rather than
        // leaking it (and, in a test run, keeping vitest alive).
        await releaseNode();
      }
    },
  };
}

/**
 * How long a printed join URL stays usable. Long enough to open a browser and
 * paste, short enough that a URL left in a terminal from this morning is not a
 * standing way in.
 */
export const JOIN_INVITATION_TTL_MS = 30 * 60_000;

/**
 * ONE INVITATION PER PAGE, NOT ONE PER MESH. Invitations are single-use by
 * construction (`persist.ts`'s `redeem` moves the id to `spentInvitationIds`
 * and the spent check runs first, unconditionally), so a shared code would let
 * exactly ONE page in and fail every other with `already-redeemed`.
 *
 * MINTED IN-PROCESS, which is the whole reason this lives here rather than in
 * a `pnpm invite` CLI. Pending invitations are never persisted -- they sit in
 * an in-memory `Map` and only SPENT ids reach the snapshot -- and
 * `createPersistentHub` reads that snapshot exactly once, at construction,
 * with no watcher. So a second process cannot mint an invitation this hub will
 * honour: it would write a file the hub never reads and the join would fail
 * `not-found`. Anything that mints has to be the hub itself.
 */
function printJoinUrls(hub: {
  invitations: { create: (id: string, roles: string[], ttlMs: number) => unknown };
}): void {
  const mint = (roles: string[]): string => {
    const id = randomUUID();
    hub.invitations.create(id, roles, JOIN_INVITATION_TTL_MS);
    return id;
  };

  // `member` carries `app:search.query` and `app:images.read` (`policy.ts`),
  // which is everything both pages need to work. The extra admin URL exists
  // because the app page's revoke control is only exercisable by an admin --
  // opened as a member it renders the 403 instead, which is also worth seeing.
  const appMember = mint(["member"]);
  const appAdmin = mint(["admin"]);
  const imagePeer = mint(["member"]);

  console.log("");
  console.log(
    `join URLs (one invitation each, single-use, valid ${JOIN_INVITATION_TTL_MS / 60_000} min):`,
  );
  console.log(`  app page          http://127.0.0.1:${APP_PORT}/?invite=${appMember}`);
  console.log(`  app page as admin http://127.0.0.1:${APP_PORT}/?invite=${appAdmin}`);
  console.log(`  image peer        http://127.0.0.1:${IMAGE_PEER_PORT}/?invite=${imagePeer}`);
  console.log("");
  console.log("  Open the image peer FIRST -- the app page discovers it through the hub,");
  console.log("  so a provider that has not joined yet shows as absent rather than broken.");
  console.log("");
}

// Run directly (e.g. `tsx src/hub/main.ts`) rather than only as a library import.
if (import.meta.url === `file://${process.argv[1]}`) {
  const configPath = process.env.HTTPEERS_CONFIG ?? DEFAULT_HTTPEERS_CONFIG_PATH;
  const port = process.env.HUB_PORT != null ? Number(process.env.HUB_PORT) : DEFAULT_HUB_PORT;
  const readyPath = process.env.HUB_READY_FILE ?? DEFAULT_HUB_READY_PATH;

  // `RELAY_ADDR` overrides, but the FILE is the normal path: `pnpm bootstrap`
  // wrote `httpeers.json` precisely so no process has to be told the relay's
  // address twice, and `scripts/start.sh` already refuses to run without it.
  const relayAddr = process.env.RELAY_ADDR ?? readRelayAddr(configPath);

  const hub = await startHub({
    listen: [`/ip4/0.0.0.0/tcp/${port}`],
    relayAddr,
  });

  // Written only now -- after `startHub` resolved, which means after the
  // reservation landed. `scripts/start.sh` waits for this file; see
  // `DEFAULT_HUB_READY_PATH`. The `mkdir` is for a `HUB_READY_FILE` pointed
  // somewhere other than `.httpeers/`, which `loadHubKey` has already proven
  // exists by the time we get here.
  mkdirSync(dirname(readyPath), { recursive: true });
  writeFileSync(readyPath, `${hub.peer.peerId}\n${hub.circuitAddr ?? ""}\n`);

  console.log(`hub peerId: ${hub.peer.peerId}`);
  // LABELLED FOR WHAT IT IS, because `hub addrs:` below prints the bare
  // `/p2p-circuit` sibling too and the two differ by one path segment. That
  // sibling is a limited connection on which libp2p refuses
  // `/httpeers/1.0.0`, so dialing it looks like a mesh bug rather than a
  // wrong address.
  console.log(`hub relayed addr (dial this -- the /webrtc suffix is required): ${hub.circuitAddr}`);
  if (hub.circuitAddr != null && !hub.circuitAddr.includes("/webrtc")) {
    console.warn(
      "hub: warning -- the reservation produced no /webrtc address, so the address above is a " +
        "BARE circuit address. libp2p refuses /httpeers/1.0.0 over one, so no browser can use " +
        "it. Does this hub's node listen on /webrtc and carry the WebRTC transport?",
    );
  }
  console.log("hub addrs:");
  for (const addr of hub.peer.addrs()) console.log(`  ${addr}`);

  printJoinUrls(hub);

  // The relay has had these since Task 7; the hub never did, so a Ctrl-C
  // left its reservation and its state file to be reclaimed by process
  // death. It also left `hub-ready` on disk claiming a hub that is gone.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nhub: received ${signal}, stopping...`);
    try {
      rmSync(readyPath, { force: true });
      await hub.stop();
    } catch (err) {
      console.error("hub: error during stop:", err);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
