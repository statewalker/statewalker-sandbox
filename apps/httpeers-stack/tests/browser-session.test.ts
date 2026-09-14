/**
 * `src/browser/session.ts` -- the decisions both consumer pages make before
 * anything is dialled: which mesh to try, whether to resume or redeem, and
 * what an operator is told when neither works.
 *
 * NO BROWSER IS NEEDED FOR ANY OF IT, which is the whole reason that module
 * has no DOM in it. `startBrowserPeer`, the identity store, the mesh memory,
 * the deployment config and `location.reload` are all injected seams with
 * real defaults, so every branch below runs under plain Node against fakes
 * that record what they were asked for. What is NOT covered here is what
 * genuinely needs a browser -- the libp2p transport, the ServiceWorker edge,
 * IndexedDB and the pages' own DOM -- and none of it makes a decision.
 * `tests/browser-resume.test.ts` proves the same resume/redeem question
 * against a real hub over real libp2p.
 *
 * THE ONE ASSERTION MOST WORTH KEEPING: a BARE invitation id must still
 * mean "the mesh `httpeers.json` names", even when this page remembers a
 * different one. That is the contract `src/browser/join-blob.ts` states and
 * the reason the Node-hub deployment keeps working alongside the hub-page
 * one; a session that quietly preferred its own memory would break the
 * first without failing anywhere visible.
 */
import type { Ed25519PrivateKey } from "@statewalker/httpeers.core";
import { generateMeshKey } from "@statewalker/httpeers.core";
import { beforeEach, describe, expect, it } from "vitest";
import { peerIdOf } from "../src/browser/identity.js";
import type { PresenceRefusal } from "../src/browser/join.js";
import { encodeJoinBlob } from "../src/browser/join-blob.js";
import type { MeshMemory } from "../src/browser/mesh-memory.js";
import type {
  BrowserPeerHandle,
  HttpeersConfig,
  JoinMethod,
  StartBrowserPeerInit,
} from "../src/browser/peer-runtime.js";
import { JoinFailedError } from "../src/browser/peer-runtime.js";
import type { IdentityStore, SessionState } from "../src/browser/session.js";
import { createPeerSession, describeMeshDrift } from "../src/browser/session.js";

const HUB = "12D3KooWHubHubHubHubHubHubHubHubHubHubHubHubHubHubHu";
const OTHER_HUB = "12D3KooWOtherOtherOtherOtherOtherOtherOtherOtherOthe";
const RELAY = "/ip4/127.0.0.1/tcp/9090/ws";

let key: Ed25519PrivateKey;

beforeEach(async () => {
  key = await generateMeshKey();
});

/** An identity store over one in-memory slot -- `src/browser/identity.ts`'s seam, without the IndexedDB. */
function fakeIdentity(initial: Ed25519PrivateKey | null): IdentityStore & { cleared: number } {
  let current = initial;
  const store = {
    cleared: 0,
    read: async () => current,
    loadOrCreate: async () => {
      current ??= key;
      return current;
    },
    clear: async () => {
      current = null;
      store.cleared++;
    },
  };
  return store;
}

function fakeMeshMemory(
  initial: HttpeersConfig | null,
): MeshMemory & { written: HttpeersConfig[] } {
  let current = initial;
  const written: HttpeersConfig[] = [];
  return {
    written,
    read: async () => current,
    write: async (config) => {
      current = config;
      written.push(config);
    },
    clear: async () => {
      current = null;
    },
  };
}

interface FakeHandle extends BrowserPeerHandle {
  stopped: number;
}

function fakeHandle(joinedBy: JoinMethod, hubPeerId = HUB): FakeHandle {
  const handle: FakeHandle = {
    stopped: 0,
    peerId: peerIdOf(key),
    baseUrl: "/app/",
    hubPeerId,
    relayAddr: RELAY,
    joinedBy,
    meshView: () => null,
    // A fake session holds no connections, so it reaches no peer.
    connectionKind: () => "none",
    stop: async () => {
      handle.stopped++;
    },
  };
  return handle;
}

/** Records every `startBrowserPeer` call and answers with whatever the test queued. */
function fakeStartPeer(answers: Array<FakeHandle | Error>) {
  const calls: StartBrowserPeerInit[] = [];
  const queue = [...answers];
  return {
    calls,
    /** Kept so a test can fire a mid-life presence refusal at the session. */
    lastRefusalHook: (): ((refusal: PresenceRefusal) => void) | undefined =>
      calls.at(-1)?.onPresenceRefused,
    startPeer: async (init: StartBrowserPeerInit): Promise<BrowserPeerHandle> => {
      calls.push(init);
      const answer = queue.shift();
      if (answer == null) throw new Error("fakeStartPeer: no answer queued");
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

interface Harness {
  states: SessionState[];
  last: () => SessionState;
}

function sessionOf(
  overrides: Partial<Parameters<typeof createPeerSession>[0]> & {
    search?: string;
  } = {},
): ReturnType<typeof createPeerSession> & Harness {
  const states: SessionState[] = [];
  const session = createPeerSession({
    key: "app",
    // `createMounts()` is not needed: nothing under test reads these.
    mounts: { provide: () => {}, match: () => undefined } as never,
    policies: [],
    dev: true,
    search: "",
    onChange: (state) => states.push(state),
    reload: () => {},
    readDeploymentConfig: async () => null,
    // Defaulted here, not left to `createPeerSession`: its real defaults
    // reach IndexedDB, which Node does not have -- so a test that forgot one
    // would fail on `indexedDB is not defined` rather than on what it meant
    // to assert.
    identity: fakeIdentity(null),
    meshMemory: fakeMeshMemory(null),
    ...overrides,
  });
  return Object.assign(session, { states, last: () => states.at(-1)! });
}

describe("a first run", () => {
  it("says it has no saved identity, offers the field, and dials nothing", async () => {
    const start = fakeStartPeer([]);
    const session = sessionOf({ identity: fakeIdentity(null), startPeer: start.startPeer });

    await session.start();

    const state = session.last();
    expect(state.phase.kind).toBe("needs-invitation");
    if (state.phase.kind !== "needs-invitation") return;
    expect(state.phase.reason).toBe("no-identity");
    expect(state.phase.message).toMatch(/no saved identity yet/i);
    expect(state.identity).toBeNull();
    expect(state.controls.join).toBe(true);
    expect(state.controls.disconnect).toBe(false);
    // Nothing was created, either: a key minted here would make every later
    // load claim an identity this browser has never used.
    expect(start.calls).toHaveLength(0);
  });

  it("creates and uses an identity the moment someone actually joins", async () => {
    const identity = fakeIdentity(null);
    const start = fakeStartPeer([fakeHandle("redeemed")]);
    const memory = fakeMeshMemory(null);
    const session = sessionOf({ identity, startPeer: start.startPeer, meshMemory: memory });

    await session.start();
    await session.join("an-invitation-id");

    expect(start.calls).toHaveLength(1);
    expect(start.calls[0]?.privateKey).toBe(key);
    expect(start.calls[0]?.invitationId).toBe("an-invitation-id");
    expect(session.last().phase.kind).toBe("live");
    // Remembered only after the join succeeded.
    expect(memory.written).toEqual([{ relayAddrs: [RELAY], hubPeerId: HUB }]);
  });
});

describe("which mesh a session tries", () => {
  it("resumes against the remembered mesh when nobody supplied an invitation", async () => {
    const start = fakeStartPeer([fakeHandle("resumed")]);
    const session = sessionOf({
      identity: fakeIdentity(key),
      meshMemory: fakeMeshMemory({ relayAddrs: [RELAY], hubPeerId: HUB }),
      startPeer: start.startPeer,
    });

    await session.start();

    expect(start.calls[0]?.config).toEqual({ relayAddrs: [RELAY], hubPeerId: HUB });
    expect(start.calls[0]?.invitationId).toBeUndefined();
    const phase = session.last().phase;
    expect(phase.kind).toBe("live");
    if (phase.kind !== "live") return;
    expect(phase.joinedBy).toBe("resumed");
  });

  it("leaves the config unset when nothing is remembered, so httpeers.json decides", async () => {
    const start = fakeStartPeer([fakeHandle("resumed")]);
    const session = sessionOf({
      identity: fakeIdentity(key),
      meshMemory: fakeMeshMemory(null),
      startPeer: start.startPeer,
    });

    await session.start();

    expect(start.calls[0]?.config).toBeUndefined();
  });

  it("a BARE invitation id still means the deployment's mesh, even when another one is remembered", async () => {
    const start = fakeStartPeer([fakeHandle("redeemed")]);
    const session = sessionOf({
      identity: fakeIdentity(key),
      meshMemory: fakeMeshMemory({ relayAddrs: [RELAY], hubPeerId: OTHER_HUB }),
      startPeer: start.startPeer,
      search: "?invite=deployment-invite",
    });

    await session.start();

    // If this ever becomes `{ hubPeerId: OTHER_HUB }`, the Node-hub
    // deployment has been silently pointed at whatever mesh the page last
    // saw -- see this suite's module comment.
    expect(start.calls[0]?.config).toBeUndefined();
    expect(start.calls[0]?.invitationId).toBe("deployment-invite");
  });

  it("a join blob names its own mesh and overrides the remembered one", async () => {
    const blob = encodeJoinBlob({
      relayAddrs: ["/ip4/10.0.0.1/tcp/1/ws"],
      hubPeerId: OTHER_HUB,
      invitationId: "blob-invite",
    });
    const start = fakeStartPeer([fakeHandle("redeemed", OTHER_HUB)]);
    const session = sessionOf({
      identity: fakeIdentity(key),
      meshMemory: fakeMeshMemory({ relayAddrs: [RELAY], hubPeerId: HUB }),
      startPeer: start.startPeer,
      search: `?join=${blob}`,
    });

    await session.start();

    expect(start.calls[0]?.config).toEqual({
      relayAddrs: ["/ip4/10.0.0.1/tcp/1/ws"],
      hubPeerId: OTHER_HUB,
    });
    expect(start.calls[0]?.invitationId).toBe("blob-invite");
  });

  it("a half-pasted join link is a legible complaint with the field still open", async () => {
    const start = fakeStartPeer([]);
    const session = sessionOf({
      identity: fakeIdentity(key),
      startPeer: start.startPeer,
      search: "?join=not-a-blob",
    });

    await session.start();

    const state = session.last();
    expect(state.phase.kind).toBe("needs-invitation");
    expect(state.controls.join).toBe(true);
    expect(start.calls).toHaveLength(0);
  });
});

describe("a reload that carries its join link", () => {
  it("resumes rather than burning the invitation, and says the invitation went unused", async () => {
    const blob = encodeJoinBlob({
      relayAddrs: [RELAY],
      hubPeerId: HUB,
      invitationId: "already-spent",
    });
    // The page IS a member, so `startBrowserPeer` resumes and never reaches
    // redemption -- exactly the case that used to fail `already-redeemed`.
    const start = fakeStartPeer([fakeHandle("resumed")]);
    const session = sessionOf({
      identity: fakeIdentity(key),
      startPeer: start.startPeer,
      search: `?join=${blob}`,
    });

    await session.start();

    const phase = session.last().phase;
    expect(phase.kind).toBe("live");
    if (phase.kind !== "live") return;
    expect(phase.joinedBy).toBe("resumed");
    expect(phase.note).toMatch(/was not used and is still unspent/i);
  });
});

describe("when the hub does not know this identity", () => {
  it("distinguishes it from a first run and keeps the saved identity on screen", async () => {
    const failure = new JoinFailedError(
      "not-a-member",
      `the hub (${HUB}) does not list this peer as a member.`,
      { hubPeerId: HUB },
    );
    const session = sessionOf({
      identity: fakeIdentity(key),
      meshMemory: fakeMeshMemory({ relayAddrs: [RELAY], hubPeerId: HUB }),
      startPeer: fakeStartPeer([failure]).startPeer,
    });

    await session.start();

    const state = session.last();
    expect(state.phase.kind).toBe("needs-invitation");
    if (state.phase.kind !== "needs-invitation") return;
    expect(state.phase.reason).toBe("unknown-identity");
    // The saved identity is intact and still shown -- the whole difference
    // between this and `no-identity`.
    expect(state.identity).toBe(peerIdOf(key));
    expect(state.controls.join).toBe(true);
  });

  it("adds the deployment-drift sentence when httpeers.json now names a different hub", async () => {
    const failure = new JoinFailedError("not-a-member", "does not list this peer", {
      hubPeerId: HUB,
    });
    const session = sessionOf({
      identity: fakeIdentity(key),
      meshMemory: fakeMeshMemory({ relayAddrs: [RELAY], hubPeerId: HUB }),
      startPeer: fakeStartPeer([failure]).startPeer,
      readDeploymentConfig: async () => ({ relayAddrs: [RELAY], hubPeerId: OTHER_HUB }),
    });

    await session.start();

    const phase = session.last().phase;
    if (phase.kind !== "needs-invitation") throw new Error(`unexpected phase ${phase.kind}`);
    expect(phase.message).toMatch(/names a different hub/i);
    expect(phase.message).toContain(OTHER_HUB);
  });

  it("does not add it when the invitation itself named the mesh", async () => {
    const failure = new JoinFailedError("not-a-member", "does not list this peer", {
      hubPeerId: OTHER_HUB,
    });
    const session = sessionOf({
      identity: fakeIdentity(key),
      startPeer: fakeStartPeer([failure]).startPeer,
      readDeploymentConfig: async () => ({ relayAddrs: [RELAY], hubPeerId: HUB }),
      search: "?invite=some-invite",
    });

    await session.start();

    const phase = session.last().phase;
    if (phase.kind !== "needs-invitation") throw new Error(`unexpected phase ${phase.kind}`);
    expect(phase.message).not.toMatch(/names a different hub/i);
  });

  it("a refused invitation asks again rather than reporting a generic failure", async () => {
    const failure = new JoinFailedError("invitation-refused", "invitation already-redeemed", {
      hubPeerId: HUB,
    });
    const session = sessionOf({
      identity: fakeIdentity(key),
      startPeer: fakeStartPeer([failure]).startPeer,
    });

    await session.join("spent-invite");

    const phase = session.last().phase;
    expect(phase.kind).toBe("needs-invitation");
    if (phase.kind !== "needs-invitation") return;
    expect(phase.reason).toBe("invitation-refused");
  });
});

describe("a duplicate identity", () => {
  it("blocks rather than proceeding, and does not offer the invitation field as a fix", async () => {
    const failure = new JoinFailedError(
      "duplicate-identity",
      "another live peer is already using this identity",
      { hubPeerId: HUB },
    );
    const session = sessionOf({
      identity: fakeIdentity(key),
      startPeer: fakeStartPeer([failure]).startPeer,
    });

    await session.start();

    const state = session.last();
    expect(state.phase.kind).toBe("blocked");
    expect(state.controls.join).toBe(false);
    // A fresh identity IS the offered way out.
    expect(state.controls.reset).toBe(true);
  });

  it("stops a live page when the duplicate shows up mid-run", async () => {
    const handle = fakeHandle("resumed");
    const start = fakeStartPeer([handle]);
    const session = sessionOf({ identity: fakeIdentity(key), startPeer: start.startPeer });

    await session.start();
    expect(session.last().phase.kind).toBe("live");

    start.lastRefusalHook()?.({
      kind: "duplicate-identity",
      status: 409,
      message: "stale-sequence",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(session.last().phase.kind).toBe("blocked");
    expect(handle.stopped).toBe(1);
    expect(session.state().handle).toBeNull();
  });

  it("stops a live page whose membership is revoked underneath it, and asks for an invitation", async () => {
    const handle = fakeHandle("resumed");
    const start = fakeStartPeer([handle]);
    const session = sessionOf({ identity: fakeIdentity(key), startPeer: start.startPeer });

    await session.start();
    start.lastRefusalHook()?.({ kind: "not-a-member", status: 403, message: "not a member" });
    await Promise.resolve();
    await Promise.resolve();

    const phase = session.last().phase;
    expect(phase.kind).toBe("needs-invitation");
    if (phase.kind !== "needs-invitation") return;
    expect(phase.reason).toBe("unknown-identity");
    expect(handle.stopped).toBe(1);
  });
});

describe("disconnect, reconnect and reset", () => {
  it("disconnect stops the peer, keeps membership, and says so", async () => {
    const handle = fakeHandle("redeemed");
    const session = sessionOf({
      identity: fakeIdentity(key),
      startPeer: fakeStartPeer([handle]).startPeer,
    });

    await session.start();
    await session.disconnect();

    const state = session.last();
    expect(handle.stopped).toBe(1);
    expect(state.phase.kind).toBe("disconnected");
    if (state.phase.kind !== "disconnected") return;
    expect(state.phase.message).toMatch(/still IS a member/i);
    expect(state.phase.message).toMatch(/needs no new invitation/i);
    expect(state.controls.reconnect).toBe(true);
    expect(state.controls.join).toBe(false);
    // The identity is still on screen -- nothing was surrendered.
    expect(state.identity).toBe(peerIdOf(key));
  });

  it("reconnect resumes with no invitation", async () => {
    const start = fakeStartPeer([fakeHandle("redeemed"), fakeHandle("resumed")]);
    const session = sessionOf({
      identity: fakeIdentity(key),
      startPeer: start.startPeer,
      search: "?invite=first-join",
    });

    await session.start();
    await session.disconnect();
    await session.reconnect();

    expect(start.calls).toHaveLength(2);
    expect(start.calls[0]?.invitationId).toBe("first-join");
    expect(start.calls[1]?.invitationId).toBeUndefined();
    expect(session.last().phase.kind).toBe("live");
  });

  it("reset stops the peer, clears the key and reloads -- and is not disconnect", async () => {
    const handle = fakeHandle("redeemed");
    const identity = fakeIdentity(key);
    let reloads = 0;
    const session = sessionOf({
      identity,
      startPeer: fakeStartPeer([handle]).startPeer,
      reload: () => {
        reloads++;
      },
    });

    await session.start();
    await session.resetIdentity();

    expect(handle.stopped).toBe(1);
    expect(identity.cleared).toBe(1);
    expect(reloads).toBe(1);
    expect(await identity.read()).toBeNull();
  });
});

describe("describeMeshDrift", () => {
  it("says nothing when the deployment names the same hub, or names none", () => {
    expect(describeMeshDrift(HUB, null)).toBeNull();
    expect(describeMeshDrift(HUB, { relayAddrs: [RELAY], hubPeerId: HUB })).toBeNull();
  });

  it("names the hub that replaced it", () => {
    const said = describeMeshDrift(HUB, { relayAddrs: [RELAY], hubPeerId: OTHER_HUB });
    expect(said).toContain(OTHER_HUB);
    expect(said).toMatch(/different mesh/i);
  });
});
