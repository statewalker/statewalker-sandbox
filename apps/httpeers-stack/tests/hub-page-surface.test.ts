/**
 * The parts of Task 24's hub page that are testable without a browser: the
 * hub's own state running over the BROWSER snapshot store, the in-process
 * presence accessor the page renders from, and the third static origin the
 * page is served on.
 *
 * WHAT NEEDS A BROWSER AND IS THEREFORE NOT HERE (named, never skipped --
 * see this task's report for the full list): `startBrowserHub` itself,
 * which needs WebRTC/WebSockets, a live relay and a ServiceWorker
 * registration; `idb-keyval`, which needs a real IndexedDB; and the page's
 * own DOM. `tests/browser-snapshot-store.test.ts` and
 * `tests/browser-identity.test.ts` cover everything underneath those that
 * is pure logic.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { multiaddr } from "@multiformats/multiaddr";
import type { PeerIdStr } from "@statewalker/httpeers.core";
import {
  createMemberStore,
  createMonotonicClock,
  createPeer,
  DEFAULT_ACCESS_TREE,
  DEFAULT_VOCABULARY,
  type Peer,
  RevocationRegistry,
} from "@statewalker/httpeers.core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdbSnapshotStore } from "../src/browser/snapshot-store.js";
import type { HubEndpoints } from "../src/hub/endpoints.js";
import { createHubEndpoints, usesTransportIdentity } from "../src/hub/endpoints.js";
import { createHubState } from "../src/hub/hub-state.js";
import {
  DEFAULT_HUB_PAGE_DIST_DIR,
  HUB_PAGE_PORT,
  startStaticServer,
} from "../src/static-server/main.js";
import { buildTestPeer } from "./support/mesh.js";

// --- the hub's state over the browser store ------------------------------

/** An in-memory stand-in for IndexedDB -- see `tests/browser-snapshot-store.test.ts` for why the seam exists. */
function memoryBackend(values = new Map<string, string>()) {
  return {
    values,
    backend: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: string) => {
        values.set(key, value);
      },
      del: async (key: string) => {
        values.delete(key);
      },
    },
  };
}

describe("the hub's state over the browser snapshot store", () => {
  it("survives a page reload -- members and spent ids come back", async () => {
    const shared = memoryBackend();

    const first = await createIdbSnapshotStore({ backend: shared.backend, storageKey: "k" });
    const hub = createHubState({
      store: first,
      vocabulary: DEFAULT_VOCABULARY,
      createMemberStore,
    });
    hub.invitations.create("inv-1", ["member"], 60_000);
    expect(hub.invitations.redeem("inv-1")).toEqual({ ok: true, roles: ["member"] });
    hub.memberStore.add("12D3KooWMember", ["member"]);
    await first.flushed();

    // A reload: a brand-new store over the same storage, and a brand-new hub
    // state over that.
    const second = await createIdbSnapshotStore({ backend: shared.backend, storageKey: "k" });
    const reloaded = createHubState({
      store: second,
      vocabulary: DEFAULT_VOCABULARY,
      createMemberStore,
    });

    expect(reloaded.memberStore.list().map((m) => m.peerId)).toEqual(["12D3KooWMember"]);
    // The invitation RECORD was never persisted -- only the fact that this id
    // was spent. That is what makes double redemption impossible across a
    // reload; see `hub-state.ts`'s module comment.
    expect(reloaded.invitations.redeem("inv-1")).toEqual({
      ok: false,
      reason: "already-redeemed",
    });
  });

  it("a reset clears both, so a newly-founded mesh starts genuinely empty", async () => {
    const shared = memoryBackend();

    const store = await createIdbSnapshotStore({ backend: shared.backend, storageKey: "k" });
    const hub = createHubState({ store, vocabulary: DEFAULT_VOCABULARY, createMemberStore });
    hub.memberStore.add("12D3KooWMember", ["member"]);
    await store.flushed();

    await store.clear();

    const after = await createIdbSnapshotStore({ backend: shared.backend, storageKey: "k" });
    const refounded = createHubState({
      store: after,
      vocabulary: DEFAULT_VOCABULARY,
      createMemberStore,
    });
    // Members carried into a new mesh would be peers that never joined it.
    expect(refounded.memberStore.list()).toEqual([]);
  });
});

// --- the in-process presence accessor -------------------------------------

interface TestHub {
  peer: Peer;
  endpoints: HubEndpoints;
  members: () => Array<{ peerId: string; roles: string[] }>;
  invite: (roles: string[]) => string;
  stop: () => Promise<void>;
}

/**
 * A real listening hub, built so this suite can hold the `HubEndpoints`
 * object itself -- `tests/support/mesh.ts`'s `buildTestHub` returns only
 * the peer, and `presence()` is what is under test here.
 */
async function buildHubHoldingEndpoints(dir: string): Promise<TestHub> {
  const clock = createMonotonicClock();
  const revocations = new RevocationRegistry({ maxTokenTtlMs: 5 * 60_000, now: clock });
  const state = createHubState({
    store: await createIdbSnapshotStore({ backend: memoryBackend().backend, storageKey: dir }),
    vocabulary: DEFAULT_VOCABULARY,
    createMemberStore,
  });

  let endpoints: HubEndpoints | undefined;
  const peer = await createPeer({
    listen: ["/ip4/127.0.0.1/tcp/0"],
    accessTree: DEFAULT_ACCESS_TREE,
    vocabulary: DEFAULT_VOCABULARY,
    usesTransportIdentity: usesTransportIdentity(),
    now: clock,
    mounts: (ctx) => {
      endpoints = createHubEndpoints({
        selfPeerId: ctx.peerId,
        mintToken: ctx.mintToken,
        memberStore: state.memberStore,
        invitations: state.invitations,
        vocabulary: DEFAULT_VOCABULARY,
        revocations,
        // Short enough that one `sweep()` after a nudged clock expires it.
        presenceTtlMs: 1_000,
        now: clock,
      });
      return endpoints.mounts;
    },
  });

  let counter = 0;
  return {
    peer,
    endpoints: endpoints!,
    members: () => state.memberStore.list(),
    invite(roles) {
      counter += 1;
      const id = `inv-${counter}`;
      state.invitations.create(id, roles, 60_000);
      return id;
    },
    stop: () => peer.stop(),
  };
}

interface PresenceResponse {
  presence: Array<{ peerId: PeerIdStr; seq: number; expiresAt: number; addrs: string[] }>;
}

describe("HubEndpoints.presence -- what the hub page renders from", () => {
  let dir: string;
  let hub: TestHub;
  let member: Awaited<ReturnType<typeof buildTestPeer>>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "httpeers-hub-page-"));
    hub = await buildHubHoldingEndpoints(dir);
    // Listening, so it has real addresses of its own to report on a
    // heartbeat -- `presence()` carries them, and "the addrs came through"
    // is half of what the first test asserts.
    member = await buildTestPeer({ hubPeerId: hub.peer.peerId, listen: ["/ip4/127.0.0.1/tcp/0"] });
    // Dialled explicitly: these are two loopback nodes with no relay and no
    // discovery between them, so nothing else would give the member the
    // hub's address. `tests/integration.test.ts` does the same.
    await member.libp2p.dial(multiaddr(hub.peer.addrs()[0]!));
  });

  afterEach(async () => {
    await member.stop();
    await hub.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports exactly what GET /.well-known/presence reports, addrs included", async () => {
    const id = hub.invite(["member"]);
    const res = await member.call(hub.peer.peerId, "/.well-known/invite", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    const { token } = (await res.json()) as { token: string };
    const fresh = await member.heartbeat(hub.peer.peerId, token);

    const overHttp = await member.call(hub.peer.peerId, "/.well-known/presence", { token: fresh });
    const httpBody = (await overHttp.json()) as PresenceResponse;

    // The point of the accessor: an in-process UI must not be able to show a
    // different "who is online" from the one every remote peer reads.
    expect(hub.endpoints.presence()).toEqual(httpBody.presence);
    expect(httpBody.presence).toHaveLength(1);
    expect(httpBody.presence[0]!.peerId).toBe(member.peerId);
    expect(httpBody.presence[0]!.addrs.length).toBeGreaterThan(0);
  });

  it("is live, not a snapshot -- a swept peer is gone from the next call", async () => {
    const id = hub.invite(["member"]);
    const res = await member.call(hub.peer.peerId, "/.well-known/invite", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    const { token } = (await res.json()) as { token: string };
    await member.heartbeat(hub.peer.peerId, token);

    expect(hub.endpoints.presence()).toHaveLength(1);

    // Past the 1 s TTL this hub was built with, then sweep.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    hub.endpoints.sweep();

    expect(hub.endpoints.presence()).toEqual([]);
    // ...and the member is still a MEMBER. Presence is liveness, not
    // membership, and the hub page renders them as two separate columns
    // precisely because a peer that went away is still someone who joined.
    expect(hub.members().map((m) => m.peerId)).toEqual([member.peerId]);
  });
});

// --- the third origin ------------------------------------------------------

describe("the hub page's origin", () => {
  let dir: string;
  let servers: Awaited<ReturnType<typeof startStaticServer>>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "httpeers-hub-origin-"));
    mkdirSync(join(dir, "hub"), { recursive: true });
    writeFileSync(join(dir, "hub", "index.html"), "<!doctype html><title>httpeers hub</title>");
    writeFileSync(join(dir, "hub", "sw.js"), "// the hub page's service worker\n");
    writeFileSync(
      join(dir, "httpeers.json"),
      JSON.stringify({ relayAddrs: ["/x"], hubPeerId: "h" }),
    );

    // Every port ephemeral, this suite's own included: it must never depend
    // on the fixed production ports being free.
    servers = await startStaticServer({
      appDistDir: join(dir, "hub"),
      imagePeerDistDir: join(dir, "hub"),
      hubPageDistDir: join(dir, "hub"),
      httpeersConfigPath: join(dir, "httpeers.json"),
      appPort: 0,
      imagePeerPort: 0,
      hubPagePort: 0,
    });
  });

  afterEach(async () => {
    await servers.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a THIRD, distinct origin -- not the app's and not the image peer's", () => {
    // One origin per page is a correctness requirement, not a convenience:
    // each page needs its own ServiceWorker scope AND, for the hub, its own
    // IndexedDB -- the hub's identity is the mesh, and must not be the same
    // stored key as one of its own members'. See `static-server/main.ts`.
    const ports = new Set([servers.appPort, servers.imagePeerPort, servers.hubPagePort]);
    expect(ports.size).toBe(3);
  });

  it("serves the hub page at /", async () => {
    const res = await fetch(`http://127.0.0.1:${servers.hubPagePort}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("httpeers hub");
  });

  it("serves its ServiceWorker with the no-cache headers that scope it to /", async () => {
    const res = await fetch(`http://127.0.0.1:${servers.hubPagePort}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("service-worker-allowed")).toBe("/");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("serves httpeers.json -- the hub page reads relayAddrs out of it, and nothing else", async () => {
    const res = await fetch(`http://127.0.0.1:${servers.hubPagePort}/httpeers.json`);
    expect(res.status).toBe(200);
    // `hubPeerId` is in there too and the hub page deliberately ignores it:
    // it IS a hub, and its own peerId is generated in the tab.
    expect(await res.json()).toEqual({ relayAddrs: ["/x"], hubPeerId: "h" });
  });

  it("defaults to dist/hub on port 5177 when nothing overrides it", () => {
    // Pinned as constants rather than through a bound listener: these two are
    // a contract between `vite.hub.config.ts` (which builds there) and
    // `scripts/start.sh` (which serves it), and a silent drift between them
    // is a page that 404s with nothing to say why.
    expect(DEFAULT_HUB_PAGE_DIST_DIR).toBe("dist/hub");
    expect(HUB_PAGE_PORT).toBe(5177);
  });
});
