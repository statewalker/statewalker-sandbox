/**
 * The image peer page's entry point -- design record §5.5, "a provider
 * running in a browser." Loads the fixture set, builds this peer's own
 * mounts and policies (Task 12's `../../services/images.ts`), joins the mesh
 * via `../../browser/peer-runtime.ts`'s `startBrowserPeer` (Task 11's
 * runtime, reached through `../../browser/session.ts` -- used unchanged,
 * nothing here reimplements it), and renders just enough UI to see it
 * working: peer id, connection state, the fixture gallery, and a "serving"
 * indicator.
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
 * THIS PAGE HAS AN IDENTITY, AND IT RESUMES (Task 28). Its libp2p key lives
 * in this origin's IndexedDB and is reused on every visit, so the peer id
 * that serves these images is the same one across reloads -- which matters
 * more here than on the consumer page: a provider whose peer id changed on
 * every reload would look to the rest of the mesh like a different provider
 * arriving each time, and would accumulate a stale membership record per
 * visit. A first join REDEEMS an invitation; every later visit RESUMES,
 * with none, because an invitation is single-use. The whole of that -- and
 * the disconnect and reset-identity controls beside it -- is
 * `../../browser/session.ts`, shared verbatim with the app page; this file
 * renders what it decides and keeps no session state of its own.
 *
 * DISCONNECT STOPS SERVING, AND SAYS SO. This page's advertisement rides on
 * its presence heartbeat, so a disconnected provider leaves the bulletin
 * board within one presence TTL and the app page renders its images as
 * departed -- the same thing closing the tab does, except that this one is
 * undoable by pressing reconnect, because membership was never surrendered.
 *
 * WHERE THE INVITATION COMES FROM. `httpeers.json` (fetched by
 * `startBrowserPeer` itself) carries only `{ relayAddrs, hubPeerId }` --
 * design note 07 §4's "one generated file that is the invitation" describes
 * how the DAEMONS bootstrap, not how a browser page redeems membership.
 * `StartBrowserPeerInit.invitationId` is optional since Task 28 (a resuming
 * page needs none), but a FIRST join still needs one and an admin still has
 * to create it. There is no HTTP endpoint for that today -- `GET /admin/invitations`
 * (`../../hub/endpoints.ts`) only reports `{ok, issuedBy, caller}`, not a
 * mint -- so this happens by calling `InvitationStore.create` directly
 * against the hub's own process (`../../hub/hub-state.ts`), and handing the
 * resulting id to whoever opens this page. This page accepts it two ways: a
 * `?invite=` query parameter (for a shared link, e.g. from Task 15's own
 * harness) or a plain paste-in form when the query parameter is absent.
 *
 * AND, SINCE TASK 24, A THIRD FORM THAT IS NOT A THIRD SOURCE. A `?join=`
 * blob (`../../browser/join-blob.ts`) carries an invitation id AND the mesh
 * it belongs to -- `relayAddrs` + `hubPeerId` -- because a mesh whose hub is
 * a BROWSER PAGE (`../hub/`) has no entry in `httpeers.json` and cannot:
 * that file is written by `pnpm bootstrap` from a key file, and the hub
 * page's identity is generated in a tab long afterwards. A bare `?invite=`
 * still means "the mesh `httpeers.json` names", i.e. the Node hub; a
 * `?join=` blob means "the mesh this blob names". Both are supported
 * deliberately -- the Node hub is not going anywhere -- and the paste-in
 * form accepts either, or a whole join link pasted verbatim.
 */
import { createMounts } from "@statewalker/httpeers.core";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { AdvertisementInput } from "../../browser/join.js";
import type { PeerSession, SessionState } from "../../browser/session.js";
import { createPeerSession } from "../../browser/session.js";
import type { ImageInfo } from "../../services/images.js";
import { createImagesEndpoint, IMAGES_POLICIES, imagePath } from "../../services/images.js";
import { loadFixtureImages } from "./fixtures.js";
import { fileToImage } from "./local-image.js";
import { loadStockImages } from "./stock.js";
import { pacedFiles, readStreamPacing } from "./pacing.js";
import { wireQrJoin } from "../../browser/qr-join.js";

const el = <T extends HTMLElement>(id: string): T => document.querySelector<T>(`#${id}`)!;

const peerIdEl = el("peer-id");
const stateEl = el("state");
const servingEl = el("serving");
const galleryEl = el("gallery");
const joinForm = el<HTMLFormElement>("join-form");
const inviteInput = el<HTMLInputElement>("invite");
const sessionStatusEl = el("session-status");
const disconnectButton = el<HTMLButtonElement>("disconnect");
const reconnectButton = el<HTMLButtonElement>("reconnect");
const resetButton = el<HTMLButtonElement>("reset-identity");

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
 * ONE LIBRARY, SHARED BY THE GALLERY AND THE MESH.
 *
 * Everything this peer serves lives in these three, for the life of the page:
 * the bytes in `galleryFiles`, the catalogue in `catalogue`, and a copy of the
 * bytes in `bytesById` so the gallery can render without fetching itself.
 *
 * They are created ONCE at module scope rather than per connection, because
 * pictures arrive at three different times -- from an image stock when the
 * page loads, from a file the person picks, from a photo they take -- and every
 * one of them must be servable the moment it exists, whether or not this peer
 * has joined a mesh yet, and without disturbing an existing connection.
 *
 * `createImagesEndpoint` resolves ids against `catalogue` per request precisely
 * so this can grow after the endpoint was built.
 */
const galleryFiles = new MemFilesApi({ initialFiles: {} });
const catalogue: ImageInfo[] = [];
const bytesById = new Map<string, Uint8Array>();

const gallerySourceEl = el<HTMLParagraphElement>("gallery-source");
const addStatusEl = el<HTMLParagraphElement>("add-status");

/** Put one picture into the library and show it. Safe at any time, joined or not. */
async function addImage(info: ImageInfo, bytes: Uint8Array): Promise<void> {
  await galleryFiles.write(imagePath(info.id), [bytes]);
  catalogue.push(info);
  bytesById.set(info.id, bytes);
  renderGallery(catalogue, bytesById);
}

/**
 * Fill the library on load: pictures fetched from a public image stock, so this
 * peer serves bytes it went and got rather than only what was bundled with it.
 *
 * FIXTURES ARE THE FALLBACK, NOT THE DEFAULT. If the stock cannot be reached --
 * offline, a blocked domain, a VPN, a rate limit -- the bundled set is used
 * instead. A peer advertising an image service with an empty catalogue is a
 * worse demonstration than one serving four familiar pictures, and the
 * difference is invisible to every other peer.
 */
const initialLoad = (async (): Promise<void> => {
  const stock = await loadStockImages();
  if (stock.images.length > 0) {
    for (const info of stock.images) {
      await addImage(info, stock.initialFiles[imagePath(info.id)] as Uint8Array);
    }
    gallerySourceEl.textContent =
      `${stock.images.length} picture(s) fetched from an image stock when this page loaded. ` +
      "Reload for a different set.";
    return;
  }
  try {
    const fixtures = await loadFixtureImages();
    for (const info of fixtures.images) {
      await addImage(info, fixtures.initialFiles[imagePath(info.id)] as Uint8Array);
    }
    gallerySourceEl.textContent =
      "The image stock could not be reached, so these are the pictures bundled with this page.";
  } catch (err) {
    gallerySourceEl.textContent =
      "No pictures could be loaded. This peer will advertise an image service with nothing in it.";
    console.error("image-peer: neither the stock nor the fixtures loaded:", err);
  }
})();

/**
 * The two pickers. `accept="image/*"` alone lets a phone offer the camera OR
 * the photo library; the second control adds `capture="environment"`, which
 * goes straight to the rear camera. Both exist because `capture` on the only
 * control would REMOVE the ability to choose an existing picture, which is half
 * the feature.
 */
function wirePicker(id: string): void {
  const input = el<HTMLInputElement>(id);
  input.addEventListener("change", () => {
    void (async () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) return;
      let added = 0;
      for (const file of files) {
        try {
          const { info, bytes } = await fileToImage(file);
          await addImage(info, bytes);
          added += 1;
        } catch (err) {
          // One bad file must not silently swallow the rest of a multi-select.
          addStatusEl.textContent = `${file.name}: ${err instanceof Error ? err.message : String(err)}`;
          console.warn("image-peer: could not add a picture:", err);
        }
      }
      if (added > 0) {
        addStatusEl.textContent =
          `Added ${added} picture(s). They are being served to the mesh now.`;
      }
      // Reset, so choosing the same file again fires `change` a second time.
      input.value = "";
    })();
  });
}
wirePicker("pick-file");
wirePicker("take-photo");

/**
 * `?chunk=` / `?delay=` -- absent (the normal case) this is `{ delayMs: 0 }`
 * and the two lines below are the ones that were always here. See
 * `./pacing.ts` for why a page carries this knob at all. Read once, at
 * module scope, because it configures what this peer SERVES and must be the
 * same on a reconnect as it was on the first join.
 */
const pacing = readStreamPacing(location.search);
// Rendered into the DOM rather than only obeyed, so an observer can see
// that the page ACTUALLY applied what the URL asked for -- a knob that
// silently did nothing would make every measurement taken against it a
// measurement of the default.
document.body.dataset.pacing = JSON.stringify(pacing);

/**
 * This peer's mounts, built once from the fixtures.
 *
 * BUILT BEFORE THE SESSION RATHER THAN INSIDE THE JOIN, because a session
 * can now start more than once (join, disconnect, reconnect) and rebuilding
 * a `MemFilesApi` per attempt would hand each attempt a different copy of
 * the same bytes for no reason. The fixtures are loaded exactly once either
 * way -- see `fixturesLoaded` above.
 */
async function buildMounts(): Promise<ReturnType<typeof createMounts>> {
  // Wait for the first load so a peer that joins immediately does not advertise
  // an empty catalogue -- but serve the SHARED library, not a snapshot of it,
  // so pictures added later are servable over a connection opened before them.
  await initialLoad;
  const files = pacing.delayMs > 0 ? pacedFiles(galleryFiles, pacing.delayMs) : galleryFiles;
  const mounts = createMounts();
  mounts.provide(
    "/images",
    createImagesEndpoint({ files, images: catalogue, chunkSize: pacing.chunkSize }),
  );
  return mounts;
}

/**
 * Render whatever `../../browser/session.ts` has decided -- the one place
 * that writes a status line or enables a control on this page.
 *
 * `serving` TRACKS THE SESSION AND NOTHING ELSE. It used to be set once, on
 * a successful join, and never cleared; a page that had disconnected still
 * read "serving: yes" while answering nothing. It is now exactly "is this
 * peer live in the mesh right now".
 */
function renderSession(state: SessionState): void {
  peerIdEl.textContent = state.identity ?? "none saved yet";
  servingEl.textContent = state.phase.kind === "live" ? "yes" : "no";
  servingEl.dataset.serving = String(state.phase.kind === "live");

  joinForm.hidden = !state.controls.join;
  disconnectButton.hidden = !state.controls.disconnect;
  reconnectButton.hidden = !state.controls.reconnect;
  resetButton.hidden = !state.controls.reset;

  const phase = state.phase;
  const say = (tone: string, text: string): void => {
    sessionStatusEl.dataset.tone = tone;
    sessionStatusEl.textContent = text;
  };

  switch (phase.kind) {
    case "checking":
      stateEl.textContent = "reading the saved identity";
      say("neutral", "");
      break;
    case "starting":
      stateEl.textContent = phase.peerState;
      say("neutral", "");
      break;
    case "live":
      stateEl.textContent = "ready";
      say(
        "ok",
        phase.note ??
          (phase.joinedBy === "resumed"
            ? "Resumed the membership saved in this browser -- no invitation was needed."
            : "Joined by redeeming an invitation."),
      );
      break;
    case "needs-invitation":
      stateEl.textContent = "not joined";
      say(phase.reason === "no-identity" ? "neutral" : "unreachable", phase.message);
      break;
    case "disconnected":
      stateEl.textContent = "disconnected";
      say("neutral", phase.message);
      break;
    case "blocked":
      stateEl.textContent = "blocked";
      say("failed", phase.message);
      break;
    case "failed":
      stateEl.textContent = "error";
      say("failed", phase.message);
      console.error("image-peer: session failed:", phase.message);
      break;
  }
}

const advertisements = (): AdvertisementInput[] => [
  { id: "images", kind: "images", title: "Images" },
];

async function main(): Promise<void> {
  const session: PeerSession = createPeerSession({
    key: "images",
    mounts: await buildMounts(),
    policies: IMAGES_POLICIES,
    advertisements,
    // Local-loopback dev only -- see `../../browser/node-profile.ts`'s
    // `CreateBrowserNodeInit.dev` doc comment. `httpeers.json`'s relay
    // address is what actually determines whether this matters; the hostname
    // check is just how this page decides whether it is plausibly talking to
    // that kind of relay.
    dev: location.hostname === "localhost" || location.hostname === "127.0.0.1",
    search: location.search,
    onChange: renderSession,
  });

  joinForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void session.join(inviteInput.value);
  });
  disconnectButton.addEventListener("click", () => void session.disconnect());
  reconnectButton.addEventListener("click", () => void session.reconnect());

  /**
   * SEPARATELY NAMED AND SEPARATELY WARNED, because it is not disconnecting.
   * Disconnect keeps this page's membership and reconnect undoes it exactly;
   * this throws the saved key away, so the next run is a peer the hub has
   * never seen and the images come back under a different provider id.
   */
  resetButton.addEventListener("click", () => {
    const confirmed = confirm(
      "Reset this page's identity?\n\n" +
        "This is NOT the same as disconnecting:\n" +
        "  * a new peer id, so these images come back as a provider the hub has never seen\n" +
        "  * the membership this page holds now is left behind on the hub as a stale record\n" +
        "  * rejoining needs a NEW invitation -- the old one is already spent\n\n" +
        "Use disconnect instead if you only want to stop serving for now.",
    );
    if (!confirmed) return;
    void session.resetIdentity();
  });

  await session.start();
}

main().catch((err: unknown) => {
  stateEl.textContent = "error";
  sessionStatusEl.dataset.tone = "failed";
  sessionStatusEl.textContent = String(err);
  console.error("image-peer: failed to start:", err);
});

// Scanning a picture is a second way to fill the same field the join form
// already reads -- see `../../browser/qr-join.ts` for why there are two inputs
// and why the code is shown rather than used silently.
wireQrJoin({
  inputs: [el<HTMLInputElement>("scan-file"), el<HTMLInputElement>("scan-photo")],
  field: el<HTMLInputElement>("invite"),
  onCode: () => joinForm.requestSubmit(),
  status: (message) => {
    el<HTMLParagraphElement>("scan-status").textContent = message;
  },
});
