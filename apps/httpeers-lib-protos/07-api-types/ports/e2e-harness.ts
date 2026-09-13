/**
 * PORT 1 — `tests/e2e/harness.ts`, rewritten against the candidate API.
 *
 * This is the consumer a critic declared NOT BUILDABLE, and it is the one that
 * matters most: if a test harness cannot be written, the suite cannot be
 * ported, and the extraction's own final acceptance check is unreachable.
 *
 * Everything here is compile-only. Nothing runs; `tsc` is the judge. Each
 * numbered comment names the behaviour in the original that forced an API
 * feature to exist — so a later reader can tell a real requirement from a
 * convenience.
 *
 * Original: apps/httpeers-stack/tests/e2e/harness.ts (+ tests/support/mesh.ts)
 */

import {
  type Advertisement,
  connect,
  createNode,
  createRevocations,
  encodeInvitation,
  generateKey,
  type Handler,
  type Hub,
  type MeshRef,
  type Node,
  type PeerId,
  type PrivateKey,
  peerIdOf,
  type Session,
  type Storage,
  serveHub,
} from "../src/api.js";
import { biscuit, disk, libp2p, memory, memoryIdentity } from "../src/stubs.js";

/** The original's seeds. Identity must be reproducible across runs or the tests cannot assert peer ids. */
export const RELAY_SEED = "httpeers-stack/e2e/relay";
export const HUB_SEED = "httpeers-stack/e2e/hub";

/** 2 s, far below the member heartbeat — the reason `Membership.beat()` has to exist. */
export const PRESENCE_TTL_MS = 2_000;
export const BEAT_INTERVAL_MS = 600;

export interface Stack {
  relayAddr: string;
  hubPeerId: PeerId;
  hub: Hub;
  invite: (roles: readonly string[]) => Promise<string>;
  join: (init: { roles: readonly string[]; serve?: Record<string, Handler> }) => Promise<StackPeer>;
  stop: () => Promise<void>;
}

export interface StackPeer {
  peerId: PeerId;
  session: Session;
  /** The harness drives beats by hand; nothing waits on a 5 s timer. */
  beat: () => Promise<void>;
}

export async function startStack(init: { presenceTtlMs?: number } = {}): Promise<Stack> {
  // (1) SEEDED KEYS, AND A WRITER FOR THEM. `setup/keys.ts` derives a key from
  //     a seed and writes it; a store with only {read, loadOrCreate} could not
  //     express this, which is why `IdentityStore.put` exists.
  const relayKey: PrivateKey = await generateKey({ seed: RELAY_SEED });
  const hubKey: PrivateKey = await generateKey({ seed: HUB_SEED });
  const hubPeerId = peerIdOf(hubKey);

  const hubIdentity = memoryIdentity();
  await hubIdentity.put(hubKey);

  // (2) THE RELAY PROCESS. A real deployment dials it; the harness boots one.
  const relay = await startRelay({ key: relayKey, port: 0 });

  // (3) CONSTRUCTION ORDER, which the prose design got wrong twice.
  //     revocations FIRST — the hub writes it and the access layer reads it,
  //     and there is no later moment at which it could be introduced.
  const revocations = createRevocations();

  //     Then the transport. `isMember` is a THUNK because the predicate does
  //     not exist yet: the hub that answers it is built three steps later.
  let hub: Hub | undefined;
  const transport = await libp2p({
    key: hubKey,
    relayAddrs: [relay.addr],
    isMember: () => (peerId: PeerId) => hub?.isMember(peerId) ?? false,
    relayService: true,
  });

  //     Then access, built BY the mesh, so the verifier knows its issuer.
  //     `signWith` is what makes `access.issuer` present at all.
  const access = await biscuit({ mesh: hubPeerId, revocations, signWith: hubKey });

  const node: Node = await createNode({ transport, access });

  //     Finally the hub, which installs its own mounts on the node.
  const storage: Storage = memory();
  hub = await serveHub(node, {
    storage,
    revocations,
    relayAddrs: [relay.addr],
    presenceTtlMs: init.presenceTtlMs ?? PRESENCE_TTL_MS,
    // (4) The sweep is driven by the harness in some tests and by the timer in
    //     others, so both must be available.
    sweepMs: 1_000,
  });

  // (5) The hub advertises its OWN service under its own id — and it appears
  //     in no peer list, which is why `MeshSnapshot.offers` is flat.
  hub.advertise((): readonly Advertisement[] => [
    { id: "search", kind: "search", title: "Search" },
  ]);

  const mesh: MeshRef = { relayAddrs: [relay.addr], hub: hubPeerId };

  return {
    relayAddr: relay.addr,
    hubPeerId,
    hub,

    // (6) Invitations minted directly by the operator, with a CHOSEN id in
    //     some tests (the original passes its own uuid).
    invite: async (roles) => {
      const invitation = await hub!.invite({ roles, ttlMs: 600_000 });
      return invitation.text;
    },

    // (7) A member peer, built the same way a real one is.
    join: async ({ roles, serve }) => {
      void roles;
      const key = await generateKey();
      const identity = memoryIdentity();
      await identity.put(key);

      const invitationText = await hub!.invite({ roles, ttlMs: 600_000 });
      const joinInput = readInvitation(invitationText.text, mesh);

      const session = await connect({
        transport: libp2p,
        access: biscuit,
        identity,
        revocations,
        join: joinInput,
        serve: serve == null ? undefined : mountsFor(node, serve),
        // (8) The member's own beat interval. Without a knob the 2 s TTL above
        //     sweeps every member between its own heartbeats.
        heartbeatMs: BEAT_INTERVAL_MS,
      });

      return {
        peerId: session.node.peerId,
        session,
        beat: () => session.membership.beat(),
      };
    },

    stop: async () => {
      await hub?.stop();
      await node.stop();
      await relay.stop();
    },
  };
}

/**
 * (9) A scanned/pasted invitation becomes a join input. The harness uses the
 *     `?invite=<id>` form the Node hub prints, which names no mesh — hence the
 *     fallback argument.
 */
function readInvitation(text: string, fallback: MeshRef) {
  const parsed = readJoinInputOrThrow(text, fallback);
  return parsed;
}

/** Every mount needs a policy; there is no unpoliced mount, so the harness states one. */
function mountsFor(node: Node, serve: Record<string, Handler>) {
  const out: Record<string, readonly [Handler, ReturnType<Node["access"]["policy"]>]> = {};
  for (const [prefix, handler] of Object.entries(serve)) {
    out[prefix] = [
      handler,
      node.access.policy(
        `allow if capability("app:test.use"), resource($r), $r.starts_with("${prefix}");`,
      ),
    ];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Things the harness needs that are NOT in the API under test.
// Each one is a finding: either the API must grow, or the harness owns it.
// ---------------------------------------------------------------------------

/**
 * FINDING H-1. The relay process has no home in the API. It is pure
 * infrastructure — a libp2p node with a circuit-relay service and no mesh
 * identity — so it belongs to the transport package, not the mesh API. Every
 * deployment and every e2e run needs one.
 */
declare function startRelay(init: {
  key: PrivateKey;
  port: number;
}): Promise<{ addr: string; stop(): Promise<void> }>;

/**
 * FINDING H-2. `readJoinInput` returns `JoinInput | null`; a harness wants the
 * throwing form, and so does every page that has just scanned a code. Either
 * the API ships both, or every caller writes this three-line wrapper.
 */
declare function readJoinInputOrThrow(
  text: string,
  fallback: MeshRef,
): ReturnType<typeof import("../src/api.js").readJoinInput> & object;

/** Unused-import guard: `encodeInvitation` and `disk` are part of the surface this port exercises elsewhere. */
export const _surfaceTouched = { encodeInvitation, disk };
