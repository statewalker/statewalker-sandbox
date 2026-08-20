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
 * WHAT LEG 1 CANNOT REACH, STATED HERE RATHER THAN IMPLIED. In the browser
 * the hop from one member peer to another is
 * `<relay>/p2p-circuit/webrtc/p2p/<peer>` — a relayed dial UPGRADED to
 * WebRTC (`src/browser/join.ts`'s `preDialPeer`). Under Node this harness
 * dials member-to-member over loopback TCP instead, for two reasons that are
 * findings, not conveniences, and are written up in the Task 14 report:
 *
 *   - a bare `/p2p-circuit` connection is a LIMITED connection, and libp2p
 *     refuses to open `/httpeers/1.0.0` on one: the call rejects with
 *     `LimitedConnectionError` ("Cannot open protocol stream on limited
 *     connection"), which `mapPeerCallError` surfaces as
 *     `UnknownPeerCallError`. `node-consumer.test.ts` pins that behaviour
 *     explicitly rather than leaving it as folklore — it is precisely why
 *     the browser path needs the WebRTC upgrade at all;
 *   - the WebRTC upgrade itself is unavailable to Node here:
 *     `@libp2p/webrtc` reaches for `node-datachannel`'s native binary, whose
 *     install script has not run in this workspace. Task 15's real browsers
 *     have WebRTC natively and are the right place for that leg.
 *
 * Separately: the hub, as `startHub` builds it, listens on TCP ONLY
 * (`httpeers.core`'s `createNode` configures `tcp()` and nothing else) and
 * therefore holds no reservation of its own — so its addresses are
 * undialable from a browser today. That is a real gap in the deployment,
 * reported rather than papered over; this harness dials the hub over its TCP
 * address because that is the only address the hub has.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { tcp } from "@libp2p/tcp";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import type { AccessTree, Libp2p, Mounts, PeerIdStr } from "@statewalker/httpeers.core";
import { createLibp2p } from "libp2p";
import { redeemInvitation } from "../../src/browser/join.js";
import { startHub } from "../../src/hub/main.js";
import type { MeshView } from "../../src/hub/mesh-view.js";
import { VOCABULARY } from "../../src/policy.js";
import { startRelay } from "../../src/relay/main.js";
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
   * itself: its keepalive re-dials over `/p2p-circuit/webrtc/...`, which
   * needs the WebRTC transport this harness cannot load (module comment), and
   * a suite that measures revocation latency wants to drive individual beats
   * itself rather than race a timer it does not control.
   */
  startBeating: (advertisements?: TestAdvertisement[]) => void;
  stopBeating: () => void;
  /** This peer's own relayed (`/p2p-circuit`) multiaddr, as granted by the relay. */
  circuitAddr: string;
  /**
   * A JSON snapshot of EVERYTHING this harness configured this peer with —
   * its roles, its own access tree, and every peer id and address it was
   * handed at construction. Exists so a test can assert mechanically that a
   * consumer never held a provider's peer id by any route other than the mesh
   * view (design record §5.4, acceptance criterion 4), rather than asserting
   * it by the absence of an argument a reader has to go looking for.
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
}

export interface Stack {
  relayPeerId: PeerIdStr;
  /** The relay's dialable `/ws` multiaddr on loopback, including its `/p2p/<relayPeerId>` suffix — `httpeers.json`'s `relayAddrs[0]` in a real deployment. */
  relayAddr: string;
  hubPeerId: PeerIdStr;
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

/** How often `awaitReservation` re-checks, and for how long — the same 250 ms x 40 schedule `src/browser/node-profile.ts` polls on. */
const RESERVATION_POLL_INTERVAL_MS = 250;
const RESERVATION_POLL_ATTEMPTS = 40;

/**
 * Poll `node.getMultiaddrs()` until the relay has actually granted a
 * reservation. `node.dial(relay)` resolving means only that the WebSocket
 * opened; the reservation lands asynchronously afterwards.
 *
 * DUPLICATED FROM `src/browser/node-profile.ts`'s `waitForCircuitReservation`
 * ON PURPOSE, AND THE DUPLICATION IS A FINDING. That function is
 * transport-agnostic and would fit here unchanged, but it lives in a module
 * whose top-level imports include `@libp2p/webrtc` — importing it from Node
 * pulls in `node-datachannel`'s native binary and crashes the test process
 * before a single assertion runs. Reported rather than fixed here: extracting
 * the poll would be a change to browser runtime code, which is not Task 14's
 * to make.
 */
async function awaitReservation(node: Libp2p): Promise<string> {
  for (let attempt = 0; attempt < RESERVATION_POLL_ATTEMPTS; attempt++) {
    const found = node
      .getMultiaddrs()
      .map((addr) => addr.toString())
      .find((addr) => addr.includes("p2p-circuit"));
    if (found != null) return found;
    await new Promise<void>((resolve) => setTimeout(resolve, RESERVATION_POLL_INTERVAL_MS));
  }
  throw new Error(
    `harness: no p2p-circuit reservation appeared within ${
      RESERVATION_POLL_ATTEMPTS * RESERVATION_POLL_INTERVAL_MS
    }ms of dialing the relay.`,
  );
}

/**
 * A member peer's libp2p node. `webSockets` + `circuitRelayTransport` are the
 * browser profile's own two (`src/browser/node-profile.ts`), so the relay dial
 * and the reservation are the real thing; `tcp` is the one addition Node
 * needs, because the hub `startHub` builds listens on TCP and nothing else
 * (see the module comment). `webRTC`, the browser's third transport, is
 * deliberately absent — see the module comment for what that costs and why it
 * is unavailable here anyway.
 */
async function createStackNode(): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0", "/p2p-circuit"] },
    transports: [webSockets(), circuitRelayTransport(), tcp()],
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

  const hub = await startHub({
    stateFilePath: join(dir, "hub-state.json"),
    keyPath: hubKeyPath,
    listen: ["/ip4/127.0.0.1/tcp/0"],
    presenceTtlMs: PRESENCE_TTL_MS,
  });
  const hubAddr = hub.peer.addrs()[0];
  if (hubAddr == null) throw new Error("harness: the hub reported no listen address");

  const peers: StackPeer[] = [];
  const nodes: Libp2p[] = [];
  let invitationCount = 0;

  const stack: Stack = {
    relayPeerId,
    relayAddr,
    hubPeerId,
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
      await node.dial(multiaddr(relayAddr));
      const circuitAddr = await awaitReservation(node);

      const peer = await buildTestPeer({
        node,
        mounts: init.mounts,
        accessTree: init.accessTree,
        vocabulary: VOCABULARY,
        hubPeerId,
      });
      // The hub's only address is a TCP one — see the module comment. This is
      // the deployment's analogue of `join.ts`'s `preDialPeer`: establish the
      // connection explicitly before any protocol call rides it.
      await node.dial(multiaddr(hubAddr));

      const redemption = await redeemInvitation(peer, hubPeerId, stack.invite(init.roles));

      let timer: ReturnType<typeof setInterval> | undefined;
      let beatInFlight = false;

      const stackPeer: StackPeer = Object.assign(peer, {
        token: redemption.token,
        circuitAddr,
        configuration: JSON.stringify({
          roles: init.roles,
          accessTree: init.accessTree,
          hubPeerId,
          relayAddr,
          hubAddr,
        }),
        async beat(advertisements?: TestAdvertisement[]) {
          stackPeer.token = await peer.heartbeat(hubPeerId, stackPeer.token, advertisements);
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
