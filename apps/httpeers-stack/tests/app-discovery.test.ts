/**
 * Task 13, Step 1: the main app page discovers both providers at runtime,
 * by `kind`, with no peer id configured anywhere -- acceptance criterion 4.
 *
 * TWO HALVES, AND THE SECOND IS THE ONE THAT PROVES ANYTHING. The first
 * exercises `src/pages/app/discovery.ts` against hand-built views, which is
 * how the `departed` transition (Step 5) is pinned down precisely. The
 * second runs a REAL hub in process -- `admin.test.ts`'s and
 * `search.test.ts`'s own construction, this app's own `HUB_ACCESS`/
 * `VOCABULARY` -- has a peer heartbeat the image advertisement in, reads
 * the actual `/.well-known/mesh` response, and feeds THAT to the page's own
 * resolvers. That is what closes the gap between "the filter works" and
 * "the kinds the providers really post are the kinds this page really looks
 * for", which no amount of hand-built fixtures can.
 *
 * It is also what caught the gap this task had to close first: nothing in
 * this app ever advertised search. The hub mounted `/search` and gated it
 * (Task 8) but never posted the third piece the design record §5.2 names --
 * "a handler plus its `.access` entry plus its advertisement" -- and the
 * hub is the one peer that never sends a heartbeat, which is the only other
 * way anything reaches the bulletin board. A consumer filtering by `kind`
 * therefore found the image peer and nothing else. See
 * `src/hub/endpoints.ts` and `src/services/search.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemberStore,
  createPeer,
  type Peer,
  RevocationRegistry,
  registerPeer,
} from "@statewalker/httpeers.core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHubEndpoints, usesTransportIdentity } from "../src/hub/endpoints.js";
import type { MeshView } from "../src/hub/mesh-view.js";
import { createPersistentHub, type InvitationStore } from "../src/hub/persist.js";
import {
  createProviderResolver,
  describeProvider,
  findAdvertisement,
  IMAGES_KIND,
  SEARCH_KIND,
} from "../src/pages/app/discovery.js";
import { HUB_RULES } from "../src/policy.js";
import { SEARCH_ADVERTISEMENT } from "../src/services/search.js";

// --- half one: the resolver's own states ----------------------------------

function viewWith(
  ...ads: Array<{ peerId: string; id: string; kind: string; title: string }>
): MeshView {
  return { version: 1, self: "me", members: [], advertisements: ads };
}

const IMAGE_AD = {
  peerId: "12D3KooWImagePeer",
  id: "images",
  kind: IMAGES_KIND,
  title: "Images",
};

describe("Step 1: provider resolution by kind", () => {
  it("finds an advertisement by its kind, never by a peer id", () => {
    const view = viewWith(IMAGE_AD);
    expect(findAdvertisement(view, IMAGES_KIND)).toEqual(IMAGE_AD);
    expect(findAdvertisement(view, SEARCH_KIND)).toBeUndefined();
  });

  it("before the first heartbeat the state is `unknown`, not `absent` -- a wait, not a failure", () => {
    const resolve = createProviderResolver(IMAGES_KIND);
    expect(resolve(null)).toEqual({ status: "unknown" });
    expect(describeProvider("images", resolve(null))).toMatch(/waiting/);
  });

  it("a view with nothing of this kind is `absent` -- 'no page, no service', working as designed", () => {
    const resolve = createProviderResolver(IMAGES_KIND);
    expect(resolve(viewWith())).toEqual({ status: "absent" });
  });

  it("a view carrying the kind is `present`, and reports the peer id it discovered", () => {
    const resolve = createProviderResolver(IMAGES_KIND);
    expect(resolve(viewWith(IMAGE_AD))).toEqual({
      status: "present",
      peerId: IMAGE_AD.peerId,
      id: "images",
      title: "Images",
    });
  });

  it("Step 5: present, then gone, is `departed` -- and names who left", () => {
    const resolve = createProviderResolver(IMAGES_KIND);
    expect(resolve(viewWith(IMAGE_AD)).status).toBe("present");

    const departed = resolve(viewWith());
    expect(departed).toEqual({ status: "departed", peerId: IMAGE_AD.peerId });
    // The distinction that makes this worth remembering state for: an
    // absence that was never there reads completely differently to a user
    // than a provider that just closed its tab.
    expect(describeProvider("images", departed)).toMatch(/gone from the mesh/);
  });

  it("a provider that comes back is `present` again -- `departed` is not terminal", () => {
    const resolve = createProviderResolver(IMAGES_KIND);
    resolve(viewWith(IMAGE_AD));
    expect(resolve(viewWith()).status).toBe("departed");
    expect(resolve(viewWith(IMAGE_AD)).status).toBe("present");
  });

  it("two resolvers of different kinds do not interfere", () => {
    const images = createProviderResolver(IMAGES_KIND);
    const search = createProviderResolver(SEARCH_KIND);
    const view = viewWith(IMAGE_AD);
    expect(images(view).status).toBe("present");
    // Search absent from THIS view must not be reported as departed just
    // because a different kind was seen.
    expect(search(view).status).toBe("absent");
  });
});

// --- half two: against a real hub -----------------------------------------

const PRESENCE_TTL_MS = 15_000;
const MAX_TOKEN_TTL_MS = 5 * 60_000;

interface TestHub {
  peer: Peer;
  invitations: InvitationStore;
  sweep: () => void;
}

/** Same construction as `admin.test.ts`'s `buildHub`, plus a controlled clock so presence can be expired without waiting. */
async function buildHub(stateFilePath: string, clock: { now: number }): Promise<TestHub> {
  const now = (): number => clock.now;
  const revocations = new RevocationRegistry({ maxTokenTtlMs: MAX_TOKEN_TTL_MS, now });
  const persistent = createPersistentHub({
    filePath: stateFilePath,
    rules: HUB_RULES,
    now,
    createMemberStore,
  });

  let sweep: (() => void) | undefined;
  const peer = await createPeer({
    rules: HUB_RULES,
    usesTransportIdentity: usesTransportIdentity(),
    now,
    revocationCache: revocations,
    mounts: (ctx) => {
      const hub = createHubEndpoints({
        selfPeerId: ctx.peerId,
        mintToken: ctx.mintToken,
        memberStore: persistent.memberStore,
        invitations: persistent.invitations,
        rules: HUB_RULES,
        revocations,
        now,
        presenceTtlMs: PRESENCE_TTL_MS,
      });
      sweep = hub.sweep;
      return hub.mounts;
    },
  });

  if (sweep == null) throw new Error("mounts factory did not run");
  return { peer, invitations: persistent.invitations, sweep };
}

function requestAs(peerId: string, path: string, init: RequestInit = {}): Request {
  const req = new Request(`http://peer${path}`, init);
  registerPeer(req, peerId);
  return req;
}

describe("Step 1, against a real hub's real mesh view", () => {
  let dir: string;
  let clock: { now: number };
  let hub: TestHub;
  let consumerToken: string;

  const CONSUMER = "12D3KooWConsumerPage";
  const IMAGE_PEER = "12D3KooWImagePeerPage";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "httpeers-app-discovery-"));
    clock = { now: 1_000 };
    hub = await buildHub(join(dir, "hub-state.json"), clock);

    hub.invitations.create("CONSUMER-CODE", ["member"], 60_000);
    const invited = await hub.peer.dispatch(
      requestAs(CONSUMER, "/.well-known/invite", {
        method: "POST",
        body: JSON.stringify({ id: "CONSUMER-CODE" }),
      }),
    );
    consumerToken = ((await invited.json()) as { token: string }).token;

    hub.invitations.create("IMAGE-PEER-CODE", ["member"], 60_000);
    await hub.peer.dispatch(
      requestAs(IMAGE_PEER, "/.well-known/invite", {
        method: "POST",
        body: JSON.stringify({ id: "IMAGE-PEER-CODE" }),
      }),
    );
  });

  afterEach(async () => {
    await hub.peer.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The image peer page's own heartbeat, carrying exactly the advertisement `src/pages/image-peer/main.ts` posts. */
  async function imagePeerHeartbeat(seq: number): Promise<void> {
    const res = await hub.peer.dispatch(
      requestAs(IMAGE_PEER, "/.well-known/presence", {
        method: "POST",
        body: JSON.stringify({
          seq,
          addrs: ["/ip4/127.0.0.1/tcp/5000"],
          advertisements: [{ id: "images", kind: "images", title: "Images" }],
        }),
      }),
    );
    expect(res.status).toBe(200);
  }

  async function meshView(): Promise<MeshView> {
    const res = await hub.peer.dispatch(
      requestAs(CONSUMER, "/.well-known/mesh", {
        headers: { authorization: `Bearer ${consumerToken}` },
      }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as MeshView;
  }

  it("the hub advertises its own search mount, so search is discoverable by kind", async () => {
    const view = await meshView();
    const ad = findAdvertisement(view, SEARCH_KIND);

    expect(ad).toBeDefined();
    expect(ad!.kind).toBe(SEARCH_ADVERTISEMENT.kind);
    expect(ad!.id).toBe(SEARCH_ADVERTISEMENT.id);
    expect(ad!.title).toBe(SEARCH_ADVERTISEMENT.title);
    // And it is the hub's own peer id -- discovered off the board, not
    // configured. `self` here is the CONSUMER, so this also shows the two
    // are different peers.
    expect(ad!.peerId).toBe(hub.peer.peerId);
    expect(ad!.peerId).not.toBe(view.self);
  });

  it("both providers resolve from one real mesh view, by kind alone", async () => {
    await imagePeerHeartbeat(1);
    const view = await meshView();

    const search = createProviderResolver(SEARCH_KIND)(view);
    const images = createProviderResolver(IMAGES_KIND)(view);

    expect(search.status).toBe("present");
    expect(images.status).toBe("present");
    // The two peer ids the page ends up calling. Neither appears in
    // `src/pages/app/` or `vite.app.config.ts` -- they exist only here, in
    // the hub's response, which is the whole of acceptance criterion 4.
    expect(search.status === "present" && search.peerId).toBe(hub.peer.peerId);
    expect(images.status === "present" && images.peerId).toBe(IMAGE_PEER);
  });

  it("Step 5 end to end: the image peer stops heartbeating, the hub sweeps it, and the page says it departed", async () => {
    const resolveImages = createProviderResolver(IMAGES_KIND);
    const resolveSearch = createProviderResolver(SEARCH_KIND);

    await imagePeerHeartbeat(1);
    expect(resolveImages(await meshView()).status).toBe("present");

    // The page closed. No heartbeat arrives, presence expires, and the hub's
    // sweep withdraws every advertisement that rode along with it.
    clock.now += PRESENCE_TTL_MS + 1;
    hub.sweep();

    const after = await meshView();
    expect(resolveImages(after)).toEqual({ status: "departed", peerId: IMAGE_PEER });
    // Search is unaffected: the hub's own advertisement has no presence
    // record behind it, so a sweep can never take it down with a member.
    expect(resolveSearch(after).status).toBe("present");
  });
});
