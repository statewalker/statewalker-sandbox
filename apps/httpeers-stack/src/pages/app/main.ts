/**
 * The main app page -- design record §5.4, "the consumer", and the page the
 * whole stack exists to demonstrate. Joins the mesh, discovers its two
 * providers at runtime, and calls them with an ordinary `fetch()`.
 *
 * THE ONE THING TO CHECK IN THIS FILE: there is no peer id in it. Not a
 * constant, not a fallback, not a query parameter. `searchState.peerId` and
 * `imagesState.peerId` come out of `../../hub/mesh-view.ts`'s
 * `advertisements`, filtered by `kind` (`./discovery.ts`); the hub's own id
 * comes from `httpeers.json` at runtime, via `BrowserPeerHandle.hubPeerId`.
 * Two things enter this page from outside: that config file, which
 * `startBrowserPeer` fetches itself, and the invitation id below. That is
 * acceptance criterion 4, and it is the only thing that makes discovery a
 * proof rather than a decoration.
 *
 * AND THE SECOND THING: every mesh call below is a bare `fetch()`. No SDK,
 * no client object, no bearer header assembled by hand, no timeout, no
 * retry, no error class imported to catch. A URL and `fetch`. Everything
 * that makes that work -- the mount prefix, the rotating membership token,
 * and turning a thrown `PeerCallError` into a readable response -- lives in
 * `../../browser/edge-dispatch.ts`, one module, in the runtime, where a
 * page never has to see it. That transparency is the project's central bet
 * (note 01 §5); a page that had to do any of it would have an SDK, just an
 * undocumented one.
 *
 * WHY THE URLS ARE COMPOSED FROM `handle.baseUrl` AND NOT ROOT-RELATIVE.
 * The design record's own sketch writes `fetch('/${searchPeer}/search')`.
 * That would miss the mesh entirely: the ServiceWorker keys its channel
 * lookup on the URL's first path segment, so this peer's edge is
 * necessarily mounted at `/${key}/` and can never be at `/`
 * (`../../browser/edge-guard.ts`). A root-relative path falls through to
 * the static server and 404s, silently, with nothing to say the request
 * never left the page. `baseUrl` is the runtime's answer to that
 * (`BrowserPeerHandle.baseUrl`) and the shape -- one plain `fetch`, no
 * library -- is exactly what the record asked for.
 *
 * THIS PAGE HAS AN IDENTITY, AND IT RESUMES (Task 28). The libp2p key lives
 * in this origin's IndexedDB and is reused on every visit, so the peer id
 * below is stable across reloads. That makes joining two different acts:
 * a first join REDEEMS an invitation, and every later visit RESUMES the
 * membership that redemption produced -- with no invitation, because an
 * invitation is single-use and there is not a second one to spend. All of that, and the three
 * controls beside it (join, disconnect, reset identity), live in
 * `../../browser/session.ts`; this file renders what that module decides
 * and holds no session state of its own.
 *
 * WHERE AN INVITATION COMES FROM WHEN ONE IS NEEDED: identical to
 * `../image-peer/main.ts`'s -- a `?invite=` query parameter, a `?join=`
 * blob, or the paste-in form. See that page's own module comment for the
 * full reasoning, including why the blob form exists at all (a mesh whose
 * hub is a browser page has no entry in `httpeers.json` and cannot).
 *
 * A `?join=` BLOB IS NOT A CONFIGURED PEER ID, and the check above still
 * holds. The blob carries the MESH identity in the same breath as the
 * invitation that admits this page -- from the hub that minted both -- and
 * `handle.hubPeerId` is where it lands, exactly as `httpeers.json`'s value
 * did. No service peer id enters this file by any route.
 *
 * NO PAGE-LOCAL TIMEOUT, ANYWHERE (Step 5 as amended). The transport owns
 * that policy and reports it as a typed `kind`; see `./outcome.ts`.
 */
import { createMounts } from "@statewalker/httpeers.core";
import type { BrowserPeerHandle } from "../../browser/peer-runtime.js";
import type { PeerSession, SessionState } from "../../browser/session.js";
import { createPeerSession } from "../../browser/session.js";
import type { MeshView } from "../../hub/mesh-view.js";
import type { ImageInfo } from "../../services/images.js";
// TYPE-ONLY, AND IT HAS TO STAY THAT WAY. `services/search.ts` reads its
// fixture set with `node:fs` at module scope -- fine on the hub, fatal in a
// browser bundle. `import type` under `verbatimModuleSyntax` is erased
// entirely, so nothing from that module reaches this page's bundle; a
// future edit that turned this into a value import would drag `node:fs` in
// with it. (`services/images.ts`, imported the same way above, is pure and
// has no such constraint.)
import type { SearchResult } from "../../services/search.js";
import type { ProviderState } from "./discovery.js";
import { createProviderResolver, describeProvider, IMAGES_KIND, SEARCH_KIND } from "./discovery.js";
import type { CallOutcome } from "./outcome.js";
import { describeOutcome, readOutcome } from "./outcome.js";

/**
 * This peer's ServiceWorker adapter key, and therefore the first segment of
 * its edge's URLs. Matches `vite.app.config.ts`'s `dist/app` output and the
 * origin `../../static-server/main.ts` serves it from. NOT a peer id -- a
 * local channel name, meaningful only inside this browser.
 */
const EDGE_KEY = "app";

/** How often the page re-reads the mesh view. The view itself is refreshed by the heartbeat (5 s); this only decides how quickly the DOM catches up with it. */
const VIEW_POLL_INTERVAL_MS = 1_000;

const el = <T extends HTMLElement>(id: string): T => document.querySelector<T>(`#${id}`)!;

const peerIdEl = el("peer-id");
const stateEl = el("state");
const baseUrlEl = el("base-url");
const joinForm = el<HTMLFormElement>("join-form");
const inviteInput = el<HTMLInputElement>("invite");
const sessionStatusEl = el("session-status");
const disconnectButton = el<HTMLButtonElement>("disconnect");
const reconnectButton = el<HTMLButtonElement>("reconnect");
const resetButton = el<HTMLButtonElement>("reset-identity");
const searchProviderEl = el("search-provider");
const imagesProviderEl = el("images-provider");
const searchForm = el<HTMLFormElement>("search-form");
const queryInput = el<HTMLInputElement>("q");
const searchStatusEl = el("search-status");
const searchResultsEl = el("search-results");
const loadImagesButton = el<HTMLButtonElement>("load-images");
const imagesStatusEl = el("images-status");
const galleryEl = el("gallery");
const adminStatusEl = el("admin-status");
const membersEl = el<HTMLUListElement>("members");

let handle: BrowserPeerHandle | null = null;
let lastQuery: string | null = null;
let renderedMeshVersion: number | null = null;

const resolveSearch = createProviderResolver(SEARCH_KIND);
const resolveImages = createProviderResolver(IMAGES_KIND);
let searchState: ProviderState = { status: "unknown" };
let imagesState: ProviderState = { status: "unknown" };

// --- rendering ------------------------------------------------------------

function setStatus(target: HTMLElement, tone: string, text: string): void {
  target.dataset.tone = tone;
  target.textContent = text;
}

function clearStatus(target: HTMLElement): void {
  target.removeAttribute("data-tone");
  target.textContent = "";
}

function renderProvider(target: HTMLElement, label: string, state: ProviderState): void {
  target.dataset.status = state.status;
  target.textContent = describeProvider(label, state);
}

function renderProviders(view: MeshView | null): void {
  const previousImages = imagesState;
  searchState = resolveSearch(view);
  imagesState = resolveImages(view);

  renderProvider(searchProviderEl, "search", searchState);
  renderProvider(imagesProviderEl, "images", imagesState);

  // Step 5: SAY SO, at the moment it happens, rather than waiting for the
  // user to click something and get a failure. The advertisement leaving
  // the view is the hub's TTL sweep noticing the provider stopped
  // heartbeating -- a fact the page already has in hand, and one it can
  // state without making a doomed call to find out.
  if (imagesState.status === "departed" && previousImages.status !== "departed") {
    setStatus(
      imagesStatusEl,
      "unreachable",
      `the image provider left the mesh (${imagesState.peerId}) — its page was closed, ` +
        "so the images it was serving are gone. Nothing else here is affected.",
    );
  }
}

function renderMembers(view: MeshView): void {
  membersEl.replaceChildren(
    ...view.members.map((member) => {
      const li = document.createElement("li");

      const id = document.createElement("span");
      id.textContent = member.peerId;

      const roles = document.createElement("span");
      roles.className = "roles";
      roles.textContent = `[${member.roles.join(", ") || "no roles"}]${member.online ? "" : " offline"}`;

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = member.peerId === view.self ? "revoke myself" : "revoke";
      button.addEventListener("click", () => void revokeMember(member.peerId));

      li.append(id, roles, button);
      if (member.peerId === view.self) {
        const self = document.createElement("span");
        self.className = "self";
        self.textContent = "(this page)";
        li.append(self);
      }
      return li;
    }),
  );
}

function renderSearchResults(results: SearchResult[]): void {
  searchResultsEl.replaceChildren(
    ...results.map((result) => {
      const li = document.createElement("li");
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = result.title;
      const snippet = document.createElement("div");
      snippet.textContent = result.snippet;
      const url = document.createElement("div");
      url.className = "url";
      url.textContent = result.url;
      li.append(title, snippet, url);
      return li;
    }),
  );
}

/**
 * Renders the provider's catalogue, each image fetched from the provider by
 * the browser's own image loader.
 *
 * `<img src>` IS THE POINT HERE, not a shortcut. These URLs go through the
 * same ServiceWorker edge as every `fetch` on this page, which means the
 * browser's built-in image loading -- code that has never heard of libp2p,
 * WebRTC or this project -- streams bytes out of another browser tab over
 * the mesh. Fetching the bytes by hand and building object URLs would work
 * and would demonstrate less. A per-image failure is caught by `onerror`
 * and marked, since an `<img>` that fails is otherwise silent.
 */
function renderGallery(baseUrl: string, peerId: string, images: ImageInfo[]): void {
  galleryEl.replaceChildren(
    ...images.map((image) => {
      const figure = document.createElement("figure");
      const img = document.createElement("img");
      img.src = `${baseUrl}${peerId}/images/${encodeURIComponent(image.id)}`;
      img.alt = image.title;
      img.addEventListener("error", () => {
        figure.dataset.failed = "true";
        caption.textContent = `${image.title} — could not be loaded from the provider`;
      });
      const caption = document.createElement("figcaption");
      caption.textContent = image.title;
      figure.append(img, caption);
      return figure;
    }),
  );
}

// --- the three calls ------------------------------------------------------

/**
 * Every mesh call this page makes goes through here: compose the URL from
 * `baseUrl`, `fetch` it, read the outcome. The `try`/`catch` is for a fetch
 * that never produces a Response at all (the ServiceWorker not yet
 * controlling this client, the page offline) -- NOT a timeout and NOT a
 * retry: see this module's own comment and `./outcome.ts`.
 */
async function callMesh(url: string, init?: RequestInit): Promise<CallOutcome> {
  try {
    return await readOutcome(await fetch(url, init));
  } catch (err) {
    return {
      status: "failed",
      httpStatus: 0,
      message: `the request never reached the mesh: ${String(err)}`,
    };
  }
}

async function runSearch(query: string): Promise<void> {
  if (handle == null) {
    setStatus(searchStatusEl, "failed", "join the mesh first.");
    return;
  }
  if (searchState.status !== "present") {
    setStatus(searchStatusEl, "failed", describeProvider("search", searchState));
    return;
  }

  lastQuery = query;
  setStatus(searchStatusEl, "ok", `searching ${searchState.peerId}…`);

  // Step 2, exactly as the design record writes it -- one plain fetch.
  const outcome = await callMesh(
    `${handle.baseUrl}${searchState.peerId}/search?q=${encodeURIComponent(query)}`,
  );

  if (outcome.status !== "ok") {
    searchResultsEl.replaceChildren();
    // Steps 3 and 5: a denial renders the access tree's own `reason`
    // verbatim; a transport failure renders which of T-2's conditions it
    // was. `describeOutcome` switches on the discriminant, never on wording.
    setStatus(searchStatusEl, outcome.status, describeOutcome(outcome));
    return;
  }

  const results = (outcome.body as { results?: SearchResult[] } | null)?.results ?? [];
  renderSearchResults(results);
  setStatus(
    searchStatusEl,
    "ok",
    results.length === 0
      ? `no results for "${query}".`
      : `${results.length} result(s) from ${searchState.peerId}.`,
  );
}

async function loadImages(): Promise<void> {
  if (handle == null) {
    setStatus(imagesStatusEl, "failed", "join the mesh first.");
    return;
  }
  if (imagesState.status !== "present") {
    // Includes the departed case -- Step 5. No call is made to a provider
    // the view already says is gone, and no timeout is needed to find out.
    //
    // ONLY `departed` IS UNREACHABILITY. "Waiting for the first mesh view"
    // and "nobody is advertising this service" are neither failures nor
    // absences of a thing that was there -- rendering them in the same tone
    // as a provider that vanished would blur exactly the distinction
    // `discovery.ts` keeps four separate states in order to make. The
    // neutral tone matches no rule in the stylesheet, which is what renders
    // it plainly.
    galleryEl.replaceChildren();
    setStatus(
      imagesStatusEl,
      imagesState.status === "departed" ? "unreachable" : "neutral",
      describeProvider("images", imagesState),
    );
    return;
  }

  const peerId = imagesState.peerId;
  setStatus(imagesStatusEl, "ok", `loading the catalogue from ${peerId}…`);

  const outcome = await callMesh(`${handle.baseUrl}${peerId}/images`);
  if (outcome.status !== "ok") {
    galleryEl.replaceChildren();
    setStatus(imagesStatusEl, outcome.status, describeOutcome(outcome));
    return;
  }

  const images = (outcome.body as { images?: ImageInfo[] } | null)?.images ?? [];
  renderGallery(handle.baseUrl, peerId, images);
  setStatus(imagesStatusEl, "ok", `${images.length} image(s) served by ${peerId}.`);
}

/**
 * Step 4: the admin action, and its refusal.
 *
 * `hubPeerId` -- not a discovered advertisement -- because `/admin/*` is
 * not a service on the bulletin board: it is the mesh's own governance
 * surface, addressed at the mesh identity itself. It still enters this page
 * only at runtime, out of `httpeers.json`.
 *
 * As an ADMIN this removes the member and revokes their token, and the next
 * search that member makes is refused within one heartbeat. As an ORDINARY
 * MEMBER the very same click is refused 403 by `policy.ts`'s `/admin/`
 * entry, and the reason -- naming the capability that was missing -- is
 * rendered verbatim, exactly like any other denial.
 */
async function revokeMember(peerId: string): Promise<void> {
  if (handle == null) return;
  setStatus(adminStatusEl, "ok", `revoking ${peerId}…`);

  const outcome = await callMesh(`${handle.baseUrl}${handle.hubPeerId}/admin/members/${peerId}`, {
    method: "DELETE",
  });

  if (outcome.status !== "ok") {
    setStatus(adminStatusEl, outcome.status, describeOutcome(outcome));
    return;
  }

  setStatus(
    adminStatusEl,
    "ok",
    `${peerId} was removed and their token revoked.` +
      (peerId === handle.peerId ? " That was this page — search should now be refused." : ""),
  );

  // "A visible indication when a subsequent search starts failing" -- made
  // visible by actually making that subsequent search, rather than by
  // asking the operator to remember to.
  if (lastQuery != null) await runSearch(lastQuery);
}

// --- lifecycle ------------------------------------------------------------

function refresh(): void {
  if (handle == null) return;
  const view = handle.meshView();
  renderProviders(view);
  if (view != null && view.version !== renderedMeshVersion) {
    renderedMeshVersion = view.version;
    renderMembers(view);
  }
}

/**
 * Render whatever `../../browser/session.ts` has decided. EVERY state this
 * page can be in comes through here -- there is no second place that
 * enables a button or writes a status line, which is what keeps "the join
 * form is open" and "this page is not joined" from ever disagreeing.
 */
function renderSession(state: SessionState): void {
  handle = state.handle;

  peerIdEl.textContent = state.identity ?? "none saved yet";
  baseUrlEl.textContent = state.handle?.baseUrl ?? "–";

  joinForm.hidden = !state.controls.join;
  disconnectButton.hidden = !state.controls.disconnect;
  reconnectButton.hidden = !state.controls.reconnect;
  resetButton.hidden = !state.controls.reset;

  const phase = state.phase;
  switch (phase.kind) {
    case "checking":
      stateEl.textContent = "reading the saved identity";
      clearStatus(sessionStatusEl);
      break;
    case "starting":
      stateEl.textContent = phase.peerState;
      clearStatus(sessionStatusEl);
      break;
    case "live":
      stateEl.textContent = "ready";
      if (phase.note != null) setStatus(sessionStatusEl, "neutral", phase.note);
      else if (phase.joinedBy === "resumed")
        setStatus(
          sessionStatusEl,
          "ok",
          "Resumed the membership saved in this browser -- no invitation was needed.",
        );
      else setStatus(sessionStatusEl, "ok", "Joined by redeeming an invitation.");
      break;
    case "needs-invitation":
      stateEl.textContent = "not joined";
      setStatus(
        sessionStatusEl,
        phase.reason === "no-identity" ? "neutral" : "unreachable",
        phase.message,
      );
      break;
    case "disconnected":
      stateEl.textContent = "disconnected";
      // The gallery and the provider lines describe a mesh this page is no
      // longer in; leaving them up would be the page claiming a view it
      // cannot refresh. NOT `renderProviders(null)`: that renders "waiting
      // for the first mesh view", which is a page that is joining, not one
      // that has stopped.
      renderProvider(searchProviderEl, "search", { status: "unknown" });
      renderProvider(imagesProviderEl, "images", { status: "unknown" });
      searchProviderEl.textContent = "search: not connected";
      imagesProviderEl.textContent = "images: not connected";
      clearStatus(searchStatusEl);
      clearStatus(imagesStatusEl);
      clearStatus(adminStatusEl);
      galleryEl.replaceChildren();
      searchResultsEl.replaceChildren();
      membersEl.replaceChildren();
      renderedMeshVersion = null;
      setStatus(sessionStatusEl, "neutral", phase.message);
      break;
    case "blocked":
      stateEl.textContent = "blocked";
      setStatus(sessionStatusEl, "failed", phase.message);
      break;
    case "failed":
      stateEl.textContent = "error";
      setStatus(sessionStatusEl, "failed", phase.message);
      break;
  }
}

// --- the session ----------------------------------------------------------

// A CONSUMER SERVES NOTHING, AND SAYS SO. No mounts and no policies: this
// peer answers no path for any caller, because deny by default is what an
// empty policy set means -- there is no entry to write and none to get wrong.
const session: PeerSession = createPeerSession({
  key: EDGE_KEY,
  mounts: createMounts(),
  policies: [],
  // Local-loopback dev only -- see `../../browser/node-profile.ts`'s
  // `CreateBrowserNodeInit.dev` doc comment.
  dev: location.hostname === "localhost" || location.hostname === "127.0.0.1",
  search: location.search,
  onChange: renderSession,
});

searchForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const query = queryInput.value.trim();
  if (query === "") {
    clearStatus(searchStatusEl);
    return;
  }
  void runSearch(query);
});

loadImagesButton.addEventListener("click", () => void loadImages());

joinForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  void session.join(inviteInput.value);
});

disconnectButton.addEventListener("click", () => void session.disconnect());
reconnectButton.addEventListener("click", () => void session.reconnect());

/**
 * SEPARATELY NAMED AND SEPARATELY WARNED, because it is not disconnecting.
 * Disconnect keeps this page's membership and can be undone by pressing
 * reconnect; this throws the identity away, which makes the next run a
 * DIFFERENT peer that the hub has never heard of. A control that quietly
 * did the second under the name of the first would be a nasty surprise.
 */
resetButton.addEventListener("click", () => {
  const confirmed = confirm(
    "Reset this page's identity?\n\n" +
      "This is NOT the same as disconnecting:\n" +
      "  * a new peer id, so this page becomes a peer the hub has never seen\n" +
      "  * the membership it holds now is left behind on the hub as a stale record\n" +
      "  * rejoining needs a NEW invitation -- the old one is already spent\n\n" +
      "Use disconnect instead if you only want to stop this page for now.",
  );
  if (!confirmed) return;
  void session.resetIdentity();
});

// The view poll runs for the life of the page and no-ops while nothing is
// joined -- started once here rather than inside a join, so a disconnect and
// a reconnect cannot leave two of them running.
setInterval(refresh, VIEW_POLL_INTERVAL_MS);

void session.start();
