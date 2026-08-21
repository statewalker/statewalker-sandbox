/**
 * The image peer page's entry point -- design record §5.5, "a provider
 * running in a browser." Loads the fixture set, builds this peer's own
 * mounts/`.access` (Task 12's `../../services/images.ts`), joins the mesh
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
import { createImagesEndpoint, IMAGES_ACCESS_TREE, imagePath } from "../../services/images.js";
import { loadFixtureImages } from "./fixtures.js";
import { pacedFiles, readStreamPacing } from "./pacing.js";

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
 * Loaded once, on page load, INDEPENDENT of whether/when this peer ever
 * joins the mesh -- see the module comment's "THE GALLERY RENDERS FROM
 * LOCAL BYTES" note. `buildMounts` below reuses this same load rather than
 * fetching the fixtures a second time, which also means a reconnect serves
 * the same bytes rather than a second copy of them.
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
  const { initialFiles, images } = await fixturesLoaded;
  const stored = new MemFilesApi({ initialFiles });
  const files = pacing.delayMs > 0 ? pacedFiles(stored, pacing.delayMs) : stored;
  const mounts = createMounts();
  mounts.provide("/images", createImagesEndpoint({ files, images, chunkSize: pacing.chunkSize }));
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
    accessTree: IMAGES_ACCESS_TREE,
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
