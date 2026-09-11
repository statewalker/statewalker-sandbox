/**
 * Provider discovery for the main app page -- design record §5.4, and
 * acceptance criterion 4: NEITHER PROVIDER'S PEER ID APPEARS ANYWHERE IN
 * THIS PAGE OR ITS BUILD CONFIG. A provider is found by the `kind` it
 * advertises on the hub's bulletin board and by nothing else.
 *
 * WHY THIS IS A MODULE AND NOT TEN LINES INSIDE `main.ts`. Discovery is the
 * one thing this page exists to prove, and a proof that lives inside DOM
 * wiring cannot be tested without a browser. Everything here is
 * `MeshView -> state`, pure, so `tests/app-discovery.test.ts` exercises it
 * under plain Node -- including against a REAL hub's real
 * `/.well-known/mesh` response, which is what actually proves the two
 * `kind` strings below match what the providers post.
 *
 * THREE STATES THAT ARE NOT "NOT FOUND", AND WHY EACH IS ITS OWN. A page
 * that collapsed them would either hang or lie:
 *  - `unknown`: no mesh view has arrived yet. `BrowserPeerHandle.meshView()`
 *    is `null` until the first heartbeat lands (`join.ts`), which is a
 *    normal second or two after `ready`, not an error and not an absence.
 *  - `absent`: the view HAS arrived and nothing of this kind is on it. For
 *    images this is the ordinary "nobody has opened the image peer page
 *    yet" case -- "no page, no service" (design record §5.5) is the
 *    system working, not failing.
 *  - `departed`: something of this kind WAS on the view and is no longer.
 *    This is the state Step 5 asks the page to say out loud, and it is
 *    distinguishable from `absent` only by remembering -- which is why this
 *    module keeps a closure rather than exposing a bare filter.
 */
import type { MeshView, MeshViewAdvertisement } from "../../hub/mesh-view.js";

/**
 * The kind the hub advertises its search mount under
 * (`services/search.ts`'s `SEARCH_ADVERTISEMENT`).
 *
 * A KIND IS NOT AN ADDRESS. This string names a class of service, not a
 * peer -- which is exactly why holding it here does not configure a peer
 * id: move search onto a standalone peer tomorrow and this page finds it
 * there with no change, because the new peer posts the same `kind`.
 */
export const SEARCH_KIND = "search";

/** The kind the image peer page advertises (`pages/image-peer/main.ts`). Same reasoning as `SEARCH_KIND`. */
export const IMAGES_KIND = "images";

/** What a proxy page advertises -- see `../proxy/main.ts`. */
export const PROXY_KIND = "proxy";

export type ProviderState =
  /** No mesh view yet -- before the first heartbeat. Not an absence. */
  | { status: "unknown" }
  /** The view arrived and carries nothing of this kind. */
  | { status: "absent" }
  | { status: "present"; peerId: string; id: string; title: string }
  /** Was present on an earlier view, is not on this one. */
  | { status: "departed"; peerId: string };

/**
 * The first advertisement of `kind` on this view, or `undefined`.
 *
 * FIRST, NOT "THE ONE" -- two peers may legitimately advertise the same
 * kind (a second image peer page opened in another tab is the obvious
 * case), and the mesh view is a bulletin board, not a registry of unique
 * services. Taking the first is this page's own choice, stated here rather
 * than implied: it is a demonstration consumer, not a load balancer.
 */
export function findAdvertisement(view: MeshView, kind: string): MeshViewAdvertisement | undefined {
  return view.advertisements.find((ad) => ad.kind === kind);
}

/**
 * A stateful resolver for one `kind`: feed it every mesh view as it
 * arrives, get back the current `ProviderState`. The state it keeps is
 * exactly one peer id -- the last one seen advertising this kind -- which
 * is the minimum needed to tell `departed` from `absent`.
 *
 * A provider that comes BACK (the image peer page reopened) returns to
 * `present`; `departed` is sticky only until that happens.
 */
export function createProviderResolver(kind: string): (view: MeshView | null) => ProviderState {
  let lastSeenPeerId: string | null = null;

  return (view) => {
    if (view == null) return { status: "unknown" };

    const ad = findAdvertisement(view, kind);
    if (ad != null) {
      lastSeenPeerId = ad.peerId;
      return { status: "present", peerId: ad.peerId, id: ad.id, title: ad.title };
    }

    if (lastSeenPeerId != null) return { status: "departed", peerId: lastSeenPeerId };
    return { status: "absent" };
  };
}

/**
 * One line of human-readable status for a provider of `label` kind. Kept
 * here beside the states themselves so the page renders every one of them
 * -- the point of Step 1's "visible states, not a hang".
 */
export function describeProvider(label: string, state: ProviderState): string {
  switch (state.status) {
    case "unknown":
      return `${label}: waiting for the first mesh view…`;
    case "absent":
      return `${label}: nobody is advertising this service`;
    case "present":
      return `${label}: ${state.title} — ${state.peerId}`;
    case "departed":
      return `${label}: gone from the mesh (was ${state.peerId})`;
  }
}
