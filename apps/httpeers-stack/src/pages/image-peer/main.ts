/**
 * The image peer page's entry point -- design record §5.5, "a provider
 * running in a browser." Loads the fixture set, builds this peer's own
 * mounts/`.access` (Task 12's `../../services/images.ts`), joins the mesh
 * via `../../browser/peer-runtime.ts`'s `startBrowserPeer` (Task 11's
 * runtime -- used unchanged, nothing here reimplements it), and renders
 * just enough UI to see it working: peer id, connection state, the fixture
 * gallery, and a "serving" indicator.
 *
 * THE GALLERY RENDERS FROM LOCAL BYTES, NOT A FETCH. Every fixture's bytes
 * are already in hand (`fixtures.ts`'s `loadFixtureImages`, needed anyway to
 * build the `FilesApi` this page serves FROM) -- rendering `<img>` tags
 * against `URL.createObjectURL(new Blob([bytes], { type: contentType }))`
 * shows the operator exactly what this peer is offering without depending
 * on the mesh, the ServiceWorker edge, or even a successful join. The
 * mesh-served path (`GET /images/{id}` over WebRTC, arriving in multiple
 * chunks) is what a REMOTE peer exercises -- proven in
 * `tests/images.test.ts` under Node and, end to end through a real browser,
 * by Task 15's Playwright suite. This page's own gallery is a local
 * mirror, not that proof.
 *
 * WHERE THE INVITATION COMES FROM. `httpeers.json` (fetched by
 * `startBrowserPeer` itself) carries only `{ relayAddrs, hubPeerId }` --
 * design note 07 §4's "one generated file that is the invitation" describes
 * how the DAEMONS bootstrap, not how a browser page redeems membership.
 * `StartBrowserPeerInit.invitationId` is a required string with no default
 * (Task 11's own module comment); an admin still has to create one (`POST
 * /admin/invitations`) and hand the resulting id to whoever opens this
 * page. This page accepts it two ways: a `?invite=` query parameter (for a
 * shared link, e.g. from Task 15's own harness) or a plain paste-in form
 * when the query parameter is absent -- there is no third source anywhere
 * in this codebase to read one from.
 */
import { createMounts } from "@statewalker/httpeers.core";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { AdvertisementInput } from "../../browser/join.js";
import type { BrowserPeerState } from "../../browser/peer-runtime.js";
import { startBrowserPeer } from "../../browser/peer-runtime.js";
import type { ImageInfo } from "../../services/images.js";
import { createImagesEndpoint, IMAGES_ACCESS_TREE, imagePath } from "../../services/images.js";
import { loadFixtureImages } from "./fixtures.js";

const peerIdEl = document.querySelector<HTMLElement>("#peer-id")!;
const stateEl = document.querySelector<HTMLElement>("#state")!;
const servingEl = document.querySelector<HTMLElement>("#serving")!;
const galleryEl = document.querySelector<HTMLElement>("#gallery")!;
const joinForm = document.querySelector<HTMLFormElement>("#join-form")!;
const inviteInput = document.querySelector<HTMLInputElement>("#invite")!;

function setState(state: BrowserPeerState | "error"): void {
  stateEl.textContent = state;
}

function setServing(serving: boolean): void {
  servingEl.textContent = serving ? "yes" : "no";
  servingEl.dataset.serving = String(serving);
}

/** Renders the fixture gallery from already-loaded bytes -- see the module comment. */
function renderGallery(images: ImageInfo[], bytesById: Map<string, Uint8Array>): void {
  galleryEl.replaceChildren(
    ...images.map((img) => {
      const bytes = bytesById.get(img.id);
      const figure = document.createElement("figure");
      const image = document.createElement("img");
      if (bytes != null) {
        const blobPart = new Uint8Array(bytes); // a fresh copy: BlobPart must not alias a buffer this page later mutates
        image.src = URL.createObjectURL(new Blob([blobPart], { type: img.contentType }));
      }
      image.alt = img.title;
      const caption = document.createElement("figcaption");
      caption.textContent = img.title;
      figure.append(image, caption);
      return figure;
    }),
  );
}

/**
 * Loaded once, on page load, INDEPENDENT of whether/when this peer ever
 * joins the mesh -- see the module comment's "THE GALLERY RENDERS FROM
 * LOCAL BYTES" note. `joinWithInvitation` reuses this same load rather than
 * fetching the fixtures a second time.
 */
const fixturesLoaded = loadFixtureImages();
fixturesLoaded
  .then(({ images, initialFiles }) => {
    const bytesById = new Map(images.map((img) => [img.id, initialFiles[imagePath(img.id)]!]));
    renderGallery(images, bytesById);
  })
  .catch((err: unknown) => {
    // The gallery staying empty is a visible, honest failure on its own;
    // this is only so the cause shows up somewhere.
    console.error("image-peer: failed to load fixtures:", err);
  });

async function joinWithInvitation(invitationId: string): Promise<void> {
  joinForm.remove();
  setState("loading-config");

  const { initialFiles, images } = await fixturesLoaded;

  const files = new MemFilesApi({ initialFiles });
  const mounts = createMounts();
  mounts.provide("/images", createImagesEndpoint({ files, images }));

  const advertisements = (): AdvertisementInput[] => [
    { id: "images", kind: "images", title: "Images" },
  ];

  // Local-loopback dev only -- see `node-profile.ts`'s `CreateBrowserNodeInit.dev`
  // doc comment. `httpeers.json`'s relay address is what actually determines
  // whether this matters; the hostname check is just how this page decides
  // whether it is plausibly talking to that kind of relay.
  const dev = location.hostname === "localhost" || location.hostname === "127.0.0.1";

  try {
    const peer = await startBrowserPeer({
      key: "images",
      mounts,
      accessTree: IMAGES_ACCESS_TREE,
      invitationId,
      advertisements,
      dev,
      onState: setState,
    });
    peerIdEl.textContent = peer.peerId;
    setServing(true);
  } catch (err) {
    setState("error");
    console.error("image-peer: failed to join the mesh:", err);
  }
}

const invitationFromQuery = new URLSearchParams(location.search).get("invite");
if (invitationFromQuery != null && invitationFromQuery.trim() !== "") {
  void joinWithInvitation(invitationFromQuery.trim());
} else {
  joinForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const id = inviteInput.value.trim();
    if (id === "") return;
    void joinWithInvitation(id);
  });
}
