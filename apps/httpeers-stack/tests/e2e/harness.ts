/**
 * Task 14, leg 1: the DEPLOYMENT-shaped harness — a real relay process and a
 * real hub process, both booted in-process from their own `main.ts` entry
 * points with identities derived from fixed seeds, plus ordinary member peers
 * that hold real circuit-relay reservations on that relay.
 *
 * WHY THIS EXISTS ALONGSIDE `tests/support/mesh.ts`, WHICH IS NOT DEAD CODE.
 * `mesh.ts` (Task 7b) assembles a hub by hand — `createPeer` with
 * `createHubEndpoints` mounted — over direct loopback TCP, with no relay, no
 * seeded identity, and no TTL sweep timer running. That is exactly right for
 * what its three suites test (`chain`, `integration`, `revocation-e2e`): the
 * protocol surface, over real dials, with nothing scheduled behind the test's
 * back. This harness tests something `mesh.ts` deliberately does not reach:
 * the assembly a real deployment actually runs. Concretely, four differences,
 * each of which is a thing under test rather than a preference:
 *
 *   1. `startRelay`/`startHub` are called, not re-implemented — so the key
 *      loaders, the `.access` tree from `../../src/policy.ts` (NOT
 *      `httpeers.core`'s `DEFAULT_ACCESS_TREE`, which has no `app:`
 *      capability at all), the persistent hub state file and the search mount
 *      are all the production ones.
 *   2. Identities come from `RELAY_SEED`/`HUB_SEED` through
 *      `setup/keys.ts`'s `loadOrGenerateKey`, the same path `pnpm setup`
 *      takes (`setup/main.ts:138-139` reads those two env vars).
 *   3. The hub's TTL SWEEP TIMER IS RUNNING (`SWEEP_INTERVAL_MS`, 1 s, set up
 *      by `startHub` itself). `buildTestHub` never starts it; "a provider
 *      that stops heartbeating leaves the view within one TTL" cannot be
 *      observed without it.
 *   4. Every member peer holds a genuine circuit-relay reservation on the
 *      relay and reports its RELAYED multiaddrs on each heartbeat, so the
 *      mesh view carries the same shape of address a browser peer's would.
 *
 * `buildTestPeer` from `mesh.ts` is reused as-is for the peer construction
 * itself (revocation cache wiring, the monotonic-`seq` heartbeat) — this file
 * adds the relay/hub/deployment envelope around it, and clones nothing.
 *
 * THE HUB HOLDS A REAL CIRCUIT RESERVATION HERE (Task 20). `startStack`
 * hands `startHub` the relay's address, so the hub dials the relay and waits
 * for a `/p2p-circuit` reservation before it reports ready — the deployment
 * shape a browser page actually needs, and the one Task 14 found missing.
 * `hubCircuitAddr` below is that address, and `node-consumer.test.ts`
 * asserts it rather than inferring it from the absence of an error.
 *
 * TWO WAYS TO REACH THE HUB, BOTH EXERCISED, AND THE DEFAULT IS THE CHEAP
 * ONE. `JoinInit.hubDial` picks:
 *
 *   - `"tcp"` (default) — dial the hub's loopback TCP address directly. What
 *     a Node peer on the same host does, and what the eight tests that are
 *     about mesh BEHAVIOUR rather than about reachability use, because it
 *     adds no ICE negotiation to a suite that is already timing-sensitive.
 *   - `"webrtc"` — `src/browser/join.ts`'s own `preDialPeer`, dialing
 *     `<relay>/p2p-circuit/webrtc/p2p/<hub>`: byte for byte the address a
 *     page dials, through the production function, over the real relay. One
 *     test uses it, and it is the acceptance signal for Task 20.
 *
 * A bare `/p2p-circuit` connection remains a LIMITED connection on which
 * libp2p refuses to open `/httpeers/1.0.0` — that is exactly WHY the
 * `/webrtc` suffix above is mandatory rather than decorative, and
 * `node-consumer.test.ts` still pins the refusal.
 *
 * WHAT LEG 1 STILL CANNOT REACH. Member-to-member hops here stay on loopback
 * TCP: a page reaching another page over WebRTC involves a real browser's
 * ICE stack and its ServiceWorker edge, which is Task 15's, and nothing in
 * this file claims it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { tcp } from "@libp2p/tcp";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import type { AccessTree, Libp2p, Mounts, PeerIdStr } from "@statewalker/httpeers.core";
import { createLibp2p } from "libp2p";
import { preDialPeer, redeemInvitation } from "../../src/browser/join.js";
import { startHub } from "../../src/hub/main.js";
import type { MeshView } from "../../src/hub/mesh-view.js";
import { VOCABULARY } from "../../src/policy.js";
import { startRelay } from "../../src/relay/main.js";
import { dialRelay, waitForCircuitReservation } from "../../src/reservation.js";
import { loadOrGenerateKey, peerIdOf } from "../../src/setup/keys.js";
import { buildTestPeer, type TestAdvertisement, type TestPeer } from "../support/mesh.js";

/**
 * The two seeds this harness derives its relay and hub identities from — the
 * `RELAY_SEED`/`HUB_SEED` values `setup/main.ts` reads out of the environment
 * in a real deployment. Exported so a test can assert the running processes'
 * peerIds really are what these seeds derive to, rather than merely differing
 * from run to run.
 */
export const RELAY_SEED = "httpeers-stack/e2e/relay";
export const HUB_SEED = "httpeers-stack/e2e/hub";

/**
 * The presence TTL these tests run the hub at. `startHub`'s own knob
 * (`StartHubInit.presenceTtlMs`), not a test-only shortcut: production's
 * 15 s (`DEFAULT_PRESENCE_TTL_MS`) would make "leaves the view within one
 * TTL" a 16-second test for no extra confidence, since the sweep interval it
 * races against (`SWEEP_INTERVAL_MS`, 1 s) is left at production's value and
 * is the thing actually under test.
 */
export const PRESENCE_TTL_MS = 2_000;

/**
 * How often a peer with `startBeating()` running sends its presence
 * heartbeat. Held at the same ratio to `PRESENCE_TTL_MS` that the deployment
 * holds (`HEARTBEAT_INTERVAL_MS` 5 s against `DEFAULT_PRESENCE_TTL_MS` 15 s,
 * roughly 1:3), so "the hub sweeps a peer that stopped beating, and only
 * then" is tested under the same margin production runs at rather than a
 * more forgiving one.
 */
export const BEAT_INTERVAL_MS = 600;

/** How long a token minted through this harness's invitations lives. Well past any single test's runtime; token expiry is `integration.test.ts`'s subject, not this file's. */
const INVITATION_TTL_MS = 5 * 60_000;

/** A member peer of the deployment-shaped mesh: a `mesh.ts` `TestPeer` that also carries its own rotating membership token and knows which hub to beat at. */
export interface StackPeer extends TestPeer {
  /** This peer's CURRENT membership token — rotated by every `beat()`, exactly as the hub mints a fresh one on each presence response. */
  token: string;
  /** One presence heartbeat against this stack's hub, carrying `advertisements` if given. Rotates `token`. */
  beat: (advertisements?: TestAdvertisement[]) => Promise<void>;
  /**
   * Start beating on a timer, the deterministic stand-in for what
   * `src/browser/join.ts`'s `startJoin` does in a page. Not `startJoin`
   * itself, and no longer for the reason this comment used to give (its
   * keepalive re-dials over `/p2p-circuit/webrtc/...`, which this harness
   * now CAN do — Task 20). The remaining reason stands on its own: a suite
   * that measures revocation latency and TTL sweeps to the millisecond wants
   * to drive individual beats itself rather than race a 5-second timer it
   * does not control.
   */
  startBeating: (advertisements?: TestAdvertisement[]) => void;
  stopBeating: () => void;
  /** This peer's own relayed (`/p2p-circuit`) multiaddr, as granted by the relay. */
  circuitAddr: string;
  /** `performance.now()` at this peer's most recent SUCCESSFUL heartbeat — the instant its presence TTL last restarted. */
  lastBeatAt: number;
  /**
   * A JSON snapshot of EVERYTHING this harness configured this peer with.
   * Exists so a test can assert mechanically that a consumer never held a
   * provider's peer id by any route other than the mesh view (design record
   * §5.4, acceptance criterion 4), rather than asserting it by the absence of
   * an argument a reader has to go looking for.
   *
   * DERIVED FROM `JoinInit` BY SPREAD, NEVER HAND-LISTED. A hand-maintained
   * copy would silently stop covering any field a later task adds to
   * `JoinInit`, and the assertion it feeds is acceptance criterion 4 in its
   * Node form — exactly the place where a quietly narrowed check is
   * expensive. (A field holding a FUNCTION would still be dropped by
   * `JSON.stringify`; nothing in `JoinInit` carries a peer id that way today,
   * and `mounts` — the only function-bearing field — serialises to `{}`.)
   */
  configuration: string;
}

export interface JoinInit {
  /** Roles the invitation this peer redeems carries. `[]` is legal and means "a member with no capabilities at all". */
  roles: string[];
  /** This peer's own `.access` tree, evaluated against `../../src/policy.ts`'s `VOCABULARY`. */
  accessTree: AccessTree;
  /** This peer's own mount table. Omit for a pure consumer that serves nothing. */
  mounts?: Mounts;
  /**
   * How this peer reaches the hub before redeeming its invitation. Defaults
   * to `"tcp"`; see the module comment's "TWO WAYS TO REACH THE HUB" note
   * for why the browser-shaped `"webrtc"` path is opt-in rather than the
   * default.
   */
  hubDial?: "tcp" | "webrtc";
}

export interface Stack {
  relayPeerId: PeerIdStr;
  /** The relay's dialable `/ws` multiaddr on loopback, including its `/p2p/<relayPeerId>` suffix — `httpeers.json`'s `relayAddrs[0]` in a real deployment. */
  relayAddr: string;
  hubPeerId: PeerIdStr;
  /**
   * The hub's own relayed address — the one `startHub` waited for before
   * reporting ready, and the one a browser page dials (after appending
   * nothing: `preDialPeer` composes `<relayAddr>/p2p-circuit/webrtc/p2p/<hub>`
   * from the relay address instead, and this is the same hop libp2p resolves
   * it to). `undefined` is impossible here — `startStack` always passes a
   * `relayAddr` — and the assertion that it is present is
   * `node-consumer.test.ts`'s, not this file's.
   */
  hubCircuitAddr: string | undefined;
  /** The hub's own registries, for the admin-side operations a test drives directly (creating invitations). */
  hub: Awaited<ReturnType<typeof startHub>>;
  /** Create a fresh invitation carrying `roles` and return its id. */
  invite: (roles: string[]) => string;
  /** Build a member peer, give it a circuit reservation, connect it to the hub and redeem an invitation for it. */
  join: (init: JoinInit) => Promise<StackPeer>;
  /** Read the mesh view as `peer` sees it. Returns `null` for any non-200 (e.g. a revoked member's 403). */
  meshView: (peer: StackPeer) => Promise<MeshView | null>;
  stop: () => Promise<void>;
}

/**
 * A member peer's libp2p node. `webSockets` + `circuitRelayTransport` +
 * `webRTC` are the browser profile's own three
 * (`src/browser/node-profile.ts`), so the relay dial, the reservation and the
 * WebRTC upgrade to the hub are all the real thing; `tcp` is the one addition
 * Node needs, for the direct member-to-member hop a page would make over
 * WebRTC instead (see the module comment).
 *
 * `/webrtc` IS IN `listen` FOR THE SAME REASON THE HUB HAS IT: without it,
 * `webRTC()` never negotiates, and a `.../p2p-circuit/webrtc/p2p/<hub>` dial
 * has no local end to build. It costs a peer that never uses it nothing.
 */
async function createStackNode(): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0", "/p2p-circuit", "/webrtc"] },
    transports: [webSockets(), circuitRelayTransport(), webRTC(), tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
}

/** Boot a relay and a hub, both from seeded on-disk keys, with state in a scratch temp dir. */
export async function startStack(): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), "httpeers-stack-e2e-"));
  const relayKeyPath = join(dir, "relay.key");
  const hubKeyPath = join(dir, "hub.key");

  // Both keys are DERIVED FROM THE SEEDS, then read back by the very loaders
  // `startRelay`/`startHub` use — the same two-step `pnpm setup` performs
  // (write once, every later process reads the file). `peerIdOf` here is what
  // lets a test assert the running processes' identities against the seeds.
  const relayPeerId = peerIdOf(
    await loadOrGenerateKey({ keyPath: relayKeyPath, seed: RELAY_SEED }),
  );
  const hubPeerId = peerIdOf(await loadOrGenerateKey({ keyPath: hubKeyPath, seed: HUB_SEED }));

  // Port 0, not `DEFAULT_RELAY_PORT` (9090): a suite that binds a fixed port
  // fails on any machine already running `pnpm start`, and this stack's own
  // invitation payload carries the relay's address explicitly, so nothing
  // downstream depends on the number.
  const relay = await startRelay({ port: 0, keyPath: relayKeyPath });
  const relayAddr = relay.node
    .getMultiaddrs()
    .map((addr) => addr.toString())
    .find((addr) => addr.startsWith("/ip4/127.0.0.1/"));
  if (relayAddr == null) {
    throw new Error(
      `harness: the relay reported no loopback address; got ${relay.node.getMultiaddrs().join(", ")}`,
    );
  }

  // `relayAddr` is what makes this the DEPLOYMENT shape rather than a
  // loopback approximation of it: the hub dials the relay and holds a
  // reservation before `startHub` resolves, so by the time any peer below
  // joins, the hub is reachable the way a page reaches it.
  const hub = await startHub({
    stateFilePath: join(dir, "hub-state.json"),
    keyPath: hubKeyPath,
    listen: ["/ip4/127.0.0.1/tcp/0"],
    presenceTtlMs: PRESENCE_TTL_MS,
    relayAddr,
  });
  // The hub's DIRECT address, for the `hubDial: "tcp"` path — picked by
  // shape, not by index: `addrs()` now carries the relayed entries too, and
  // `[0]` silently became a lottery the moment it did.
  const hubAddr = hub.peer.addrs().find((addr) => !addr.includes("p2p-circuit"));
  if (hubAddr == null) {
    throw new Error(
      `harness: the hub reported no direct listen address; got ${hub.peer.addrs().join(", ")}`,
    );
  }

  const peers: StackPeer[] = [];
  const nodes: Libp2p[] = [];
  let invitationCount = 0;

  const stack: Stack = {
    relayPeerId,
    relayAddr,
    hubPeerId,
    hubCircuitAddr: hub.circuitAddr,
    hub,

    invite(roles) {
      invitationCount += 1;
      const id = `E2E-INVITE-${invitationCount}`;
      hub.invitations.create(id, roles, INVITATION_TTL_MS);
      return id;
    },

    async join(init) {
      const node = await createStackNode();
      nodes.push(node);
      await dialRelay(node, relayAddr);
      const circuitAddr = await waitForCircuitReservation(node);

      const peer = await buildTestPeer({
        node,
        mounts: init.mounts,
        accessTree: init.accessTree,
        vocabulary: VOCABULARY,
        hubPeerId,
      });
      // Establish the connection to the hub explicitly before any protocol
      // call rides it. `"webrtc"` is `src/browser/join.ts`'s OWN
      // `preDialPeer`, unmodified, against the same address a page composes;
      // `"tcp"` is the direct same-host dial. See the module comment.
      if (init.hubDial === "webrtc") await preDialPeer(node, relayAddr, hubPeerId);
      else await node.dial(multiaddr(hubAddr));

      const redemption = await redeemInvitation(peer, hubPeerId, stack.invite(init.roles));

      let timer: ReturnType<typeof setInterval> | undefined;
      let beatInFlight = false;

      const stackPeer: StackPeer = Object.assign(peer, {
        token: redemption.token,
        circuitAddr,
        lastBeatAt: Number.NaN, // no heartbeat yet -- set by the first `beat()`
        configuration: JSON.stringify({ ...init, hubPeerId, relayAddr, hubAddr }),
        async beat(advertisements?: TestAdvertisement[]) {
          stackPeer.token = await peer.heartbeat(hubPeerId, stackPeer.token, advertisements);
          // AFTER the call resolves, not before: a beat the hub refused (a
          // revoked member's 403) throws out of `heartbeat` and must not look
          // like a presence refresh that restarted the TTL.
          stackPeer.lastBeatAt = performance.now();
        },
        startBeating(advertisements?: TestAdvertisement[]) {
          clearInterval(timer); // replacing an already-running timer, never stacking a second one
          timer = setInterval(() => {
            if (beatInFlight) return; // never overlap two beats -- `join.ts`'s own guard, for the same reason.
            beatInFlight = true;
            void stackPeer
              .beat(advertisements)
              .catch(() => {
                // A revoked member's 403, or a hub that has gone away: leave
                // the token exactly as it was and let the next tick retry.
                // `join.ts`'s `heartbeatOnce` swallows the same class of
                // failure for the same reason -- a fire-and-forget timer that
                // lets a rejection escape turns a normal, expected mesh state
                // into an unhandled rejection that fails an unrelated test.
              })
              .finally(() => {
                beatInFlight = false;
              });
          }, BEAT_INTERVAL_MS);
          timer.unref?.();
        },
        stopBeating() {
          clearInterval(timer);
          timer = undefined;
        },
      });
      peers.push(stackPeer);
      return stackPeer;
    },

    async meshView(peer) {
      const res = await peer.call(hubPeerId, "/.well-known/mesh", { token: peer.token });
      if (!res.ok) return null;
      return (await res.json()) as MeshView;
    },

    async stop() {
      // EVERY node this harness built is stopped here, and the peers first:
      // `createPeer` was handed an already-constructed node, and it never
      // stops a node it did not build (`peer.ts`'s `ownsNode`), so a peer's
      // own `stop()` unregisters the protocol handler and nothing more. A
      // node left running keeps vitest alive after the last assertion and
      // presents as a hang rather than as a leak. The heartbeat timers go
      // first, for the same reason: one still firing during teardown calls a
      // hub that is on its way down.
      for (const peer of peers) peer.stopBeating();
      await Promise.all(peers.map((peer) => peer.stop()));
      await Promise.all(nodes.map((node) => node.stop()));
      await hub.stop();
      await relay.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };

  return stack;
}

/**
 * The one address a member peer may be dialed at from Node. Picked out of the
 * `addrs` the mesh view reported for that peer — never out of libp2p's own
 * peerStore, per `src/browser/peer-runtime.ts`'s "A PEER'S ADDRS COME FROM
 * THE MESH VIEW" contract.
 *
 * A browser would pick the `/p2p-circuit` entry and upgrade it to WebRTC;
 * this picks the loopback TCP one, because an httpeers call over a bare
 * limited circuit connection is refused by libp2p itself. See the module
 * comment, and `node-consumer.test.ts`'s test that pins that refusal.
 */
export function dialableAddr(addrs: string[]): string {
  const found = addrs.find(
    (addr) => addr.startsWith("/ip4/127.0.0.1/tcp/") && !addr.includes("p2p-circuit"),
  );
  if (found == null) {
    throw new Error(`harness: no directly dialable address among: ${addrs.join(", ")}`);
  }
  return found;
}

/** Dial `addr` from `peer`'s own node — the explicit pre-dial every mesh call in this suite rides on. */
export async function dialAddr(peer: StackPeer, addr: string): Promise<void> {
  await peer.libp2p.dial(multiaddr(addr));
}
