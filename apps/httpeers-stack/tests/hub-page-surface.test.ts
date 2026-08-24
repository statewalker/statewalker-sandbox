/**
 * The parts of Task 24's hub page that are testable without a browser: the
 * hub's own state running over the BROWSER snapshot store, the in-process
 * mesh-view accessor the page renders members from, and the third static origin the
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
  DEFAULT_RULES,
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
      rules: DEFAULT_RULES,
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
      rules: DEFAULT_RULES,
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
    const hub = createHubState({ store, rules: DEFAULT_RULES, createMemberStore });
    hub.memberStore.add("12D3KooWMember", ["member"]);
    await store.flushed();

    await store.clear();

    const after = await createIdbSnapshotStore({ backend: shared.backend, storageKey: "k" });
    const refounded = createHubState({
      store: after,
      rules: DEFAULT_RULES,
      createMemberStore,
    });
    // Members carried into a new mesh would be peers that never joined it.
    expect(refounded.memberStore.list()).toEqual([]);
  });
});

// --- the in-process mesh view, and removal -------------------------------------

interface TestHub {
  peer: Peer;
  endpoints: HubEndpoints;
  revocations: RevocationRegistry;
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
    rules: DEFAULT_RULES,
    createMemberStore,
  });

  let endpoints: HubEndpoints | undefined;
  const peer = await createPeer({
    listen: ["/ip4/127.0.0.1/tcp/0"],
    rules: DEFAULT_RULES,
    usesTransportIdentity: usesTransportIdentity(),
    now: clock,
    mounts: (ctx) => {
      endpoints = createHubEndpoints({
        selfPeerId: ctx.peerId,
        mintToken: ctx.mintToken,
        memberStore: state.memberStore,
        invitations: state.invitations,
        rules: DEFAULT_RULES,
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
    revocations,
    invite(roles) {
      counter += 1;
      const id = `inv-${counter}`;
      state.invitations.create(id, roles, 60_000);
      return id;
    },
    stop: () => peer.stop(),
  };
}

interface MeshResponse {
  version: number;
  self: PeerIdStr;
  members: Array<{ peerId: PeerIdStr; roles: string[]; online: boolean; addrs: string[] }>;
  advertisements: Array<{ peerId: PeerIdStr; id: string; kind: string; title: string }>;
}

describe("HubEndpoints.meshView -- what the hub page renders members from", () => {
  let dir: string;
  let hub: TestHub;
  let member: Awaited<ReturnType<typeof buildTestPeer>>;

  /** Join the mesh and send one heartbeat. Returns the freshest token. */
  async function joinAndBeat(roles = ["member"]): Promise<string> {
    const id = hub.invite(roles);
    const res = await member.call(hub.peer.peerId, "/.well-known/invite", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    const { token } = (await res.json()) as { token: string };
    return await member.heartbeat(hub.peer.peerId, token);
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "httpeers-hub-page-"));
    hub = await buildHubHoldingEndpoints(dir);
    // Listening, so it has real addresses of its own to report on a
    // heartbeat -- the view carries them, and "the addrs came through" is
    // part of what the first test asserts.
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

  it("agrees with GET /.well-known/mesh, member for member", async () => {
    const token = await joinAndBeat(["admin"]);

    const overHttp = await member.call(hub.peer.peerId, "/.well-known/mesh", { token });
    const httpBody = (await overHttp.json()) as MeshResponse;
    const inProcess = hub.endpoints.meshView();

    // The point of the accessor: an in-process UI must not be able to show a
    // different membership -- or a different `online` -- from the one every
    // remote peer reads. `self` differs by construction (the hub's own view
    // is the hub's), and nothing else may.
    expect(inProcess.members).toEqual(httpBody.members);
    expect(inProcess.version).toBe(httpBody.version);
    expect(inProcess.self).toBe(hub.peer.peerId);
    expect(httpBody.self).toBe(member.peerId);

    expect(inProcess.members).toHaveLength(1);
    expect(inProcess.members[0]!.peerId).toBe(member.peerId);
    expect(inProcess.members[0]!.addrs.length).toBeGreaterThan(0);
  });

  it("distinguishes saved from active -- a swept peer stays a member but goes offline", async () => {
    await joinAndBeat();
    expect(hub.endpoints.meshView().members[0]!.online).toBe(true);

    // Past the 1 s TTL this hub was built with, then sweep.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    hub.endpoints.sweep();

    const after = hub.endpoints.meshView().members;
    // STILL SAVED. Presence is liveness, not membership: a peer that closed
    // its tab is offline and is still someone who joined. The hub page
    // renders these as one cell precisely so they cannot be confused.
    expect(after).toHaveLength(1);
    expect(after[0]!.peerId).toBe(member.peerId);
    expect(after[0]!.online).toBe(false);
  });

  it("the hub's own view is unfiltered -- it sees a `hidden` member", async () => {
    await joinAndBeat(["hidden"]);

    // `buildMeshView` omits `hidden` members from anyone without
    // `std:mesh.admin`. The hub is the machine holding the list; an operator
    // shown a filtered version of their own mesh would be misled about what
    // they are administering.
    const members = hub.endpoints.meshView().members;
    expect(members).toHaveLength(1);
    expect(members[0]!.roles).toContain("hidden");
  });

  it("removing a member drops it from the view AND bumps the policy version", async () => {
    await joinAndBeat();
    expect(hub.endpoints.meshView().members).toHaveLength(1);
    const before = hub.revocations.policyVersion();

    // Exactly the path the hub page uses: the mounted handler, reached
    // through the mount table -- NOT the ServiceWorker edge and NOT
    // `peer.dispatch`, either of which would hit `httpeers.core`'s binding
    // middleware and throw `PeerBindingLostError` on a request with no
    // remote peer to prove. See `src/browser/hub-runtime.ts`'s
    // `removeMember`.
    const path = `/admin/members/${member.peerId}`;
    const handler = hub.endpoints.mounts.match(path)!;
    expect(handler).not.toBeNull();
    const res = await handler(new Request(`http://hub.invalid${path}`, { method: "DELETE" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; removed: string; policyVersion: number };
    expect(body).toMatchObject({ ok: true, removed: member.peerId });

    // Both halves. Dropping membership alone would leave the peer's live,
    // unexpired token working until it expired; the bumped policy version is
    // what every peer notices on its next heartbeat, and it is what the hub
    // page reports back to the operator.
    expect(hub.endpoints.meshView().members).toEqual([]);
    expect(body.policyVersion).toBeGreaterThan(before);

    // The token the peer is HOLDING -- minted before the removal -- now
    // fails, which is the half that "removed from a list" would not give
    // you. A token minted after the change would still be fine, and that
    // asymmetry is `RevocationRegistry.check`'s whole contract, so both
    // directions are asserted rather than just the one that reads well.
    const revokedAt = hub.revocations.list().find((e) => e.peerId === member.peerId)!.changedAt;
    expect(hub.revocations.check({ sub: member.peerId, iat: revokedAt - 1 })).toBe(
      "membership revoked",
    );
    expect(hub.revocations.check({ sub: member.peerId, iat: revokedAt })).toBeNull();
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
      JSON.stringify({ relayAddrs: [{ addr: "/x", subnetwork: "n" }], hubPeerId: "h" }),
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
    expect(await res.json()).toEqual({
      relayAddrs: [{ addr: "/x", subnetwork: "n" }],
      hubPeerId: "h",
    });
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
