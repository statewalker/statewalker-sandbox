/**
 * The proxy page's entry point -- the operator's half of the mesh proxy.
 * Joins the mesh via `../../browser/session.ts` exactly as the image peer
 * does, mounts `../../services/proxy.ts` at `/proxy`, and renders the two
 * things that are this page's own: the route table, and a console that
 * exercises it.
 *
 * THE SERVICE KNOWS NOTHING ABOUT SECRETS, AND THAT IS THE WHOLE DESIGN.
 * `createProxyEndpoint` takes plain headers; the split between what is
 * written down (a route, and the NAME of its auth header) and what is not (the
 * value) lives in `./routes-store.ts`. This file is where the two halves meet:
 * `withSecrets` merges the session's in-memory tokens into the stored routes
 * on every request, because `routes` is a FUNCTION -- editing a route or
 * typing a key takes effect immediately, with no reconnect and no rebuild of
 * the endpoint.
 *
 * A RELOAD DELIBERATELY LOSES THE KEYS. Routes come back; the token fields
 * come back empty, and every route that needs one says so until it is
 * refilled. A bearer key in `localStorage` would outlive the session, the tab
 * and the operator's attention, on a page every member of the mesh can reach.
 *
 * THE CONSOLE CALLS THIS PAGE'S OWN EDGE, with this page's own peer id, so it
 * works before any other peer has joined -- the request still crosses the
 * ServiceWorker edge and the mounted endpoint, which is exactly what needs
 * proving. It renders the response body AS IT ARRIVES: buffering it into a
 * single `.text()` would hide whether streaming survives the round trip, and
 * streaming is the point of the feature.
 */
import { createMounts } from "@statewalker/httpeers.core";
import type { AdvertisementInput } from "../../browser/join.js";
import { wireQrJoin } from "../../browser/qr-join.js";
import { createQrJoinUi } from "../../browser/qr-join-ui.js";
import {
  DEFAULT_EXAMPLES,
  describeStatus,
  parseHeaders,
  renderExamples,
  streamInto,
} from "../../browser/request-console.js";
import type { PeerSession, SessionState } from "../../browser/session.js";
import { createPeerSession } from "../../browser/session.js";
import { createProxyEndpoint, PROXY_POLICIES } from "../../services/proxy.js";
import type { ProxyRoute } from "../../services/proxy-routes.js";
import type { StoredRoute } from "./routes-store.js";
import { DEFAULT_ROUTES, loadRoutesOrSeed, saveRoutes, withSecrets } from "./routes-store.js";

const el = <T extends HTMLElement>(id: string): T => document.querySelector<T>(`#${id}`)!;

const peerIdEl = el("peer-id");
const stateEl = el("state");
const joinForm = el<HTMLFormElement>("join-form");
const inviteInput = el<HTMLInputElement>("invite");
const sessionStatusEl = el("session-status");
const disconnectButton = el<HTMLButtonElement>("disconnect");
const reconnectButton = el<HTMLButtonElement>("reconnect");
const resetButton = el<HTMLButtonElement>("reset-identity");

const routesEl = el<HTMLUListElement>("routes");
const addRouteForm = el<HTMLFormElement>("add-route-form");
const routePrefixEl = el<HTMLInputElement>("route-prefix");
const routeUpstreamEl = el<HTMLInputElement>("route-upstream");
const routeHeadersEl = el<HTMLTextAreaElement>("route-headers");
const routeSecretNameEl = el<HTMLInputElement>("route-secret-name");
const routeSecretValueEl = el<HTMLInputElement>("route-secret-value");
const routeStatusEl = el("route-status");

const consoleForm = el<HTMLFormElement>("console-form");
const consoleMethodEl = el<HTMLSelectElement>("console-method");
const consolePathEl = el<HTMLInputElement>("console-path");
const consoleHeadersEl = el<HTMLTextAreaElement>("console-headers");
const consoleBodyEl = el<HTMLTextAreaElement>("console-body");
const consoleSendButton = el<HTMLButtonElement>("console-send");
const consoleStatusEl = el("console-status");
const consoleOutputEl = el("console-output");

/**
 * The tokens this session holds, keyed by route prefix, and never written
 * anywhere -- see `./routes-store.ts` for why the split is by ownership.
 */
const secrets = new Map<string, string>();
let stored: StoredRoute[] = loadRoutesOrSeed(localStorage, DEFAULT_ROUTES);

/**
 * Read per request by the endpoint, so editing a route or typing a key takes
 * effect immediately and without a reconnect.
 */
const currentRoutes = (): ProxyRoute[] => withSecrets(stored, secrets);

function say(tone: string, text: string): void {
  routeStatusEl.dataset.tone = tone;
  routeStatusEl.textContent = text;
}

/** Persist and re-render, in that order -- the list on screen is the list that survives a reload. */
function commitRoutes(): void {
  saveRoutes(localStorage, stored);
  renderRoutes();
}

/**
 * The route table, with one token field per route that declares a secret
 * header.
 *
 * THE FIELD IS HERE AND NOT ONLY IN THE ADD FORM because a reload brings the
 * routes back without their keys: without a place to retype one, the only way
 * to re-arm a route would be to delete and re-add it. An empty field on a
 * route that needs a value is also the page saying, without a separate status
 * line, which routes are currently unarmed.
 */
function renderRoutes(): void {
  routesEl.replaceChildren(
    ...stored.map((route) => {
      const item = document.createElement("li");

      const head = document.createElement("p");
      head.className = "route-head";
      const prefix = document.createElement("span");
      prefix.className = "route-prefix";
      prefix.textContent = route.prefix;
      const arrow = document.createElement("span");
      arrow.textContent = "→";
      const upstream = document.createElement("span");
      upstream.className = "route-upstream";
      upstream.textContent = route.upstream;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "route-remove";
      remove.textContent = "remove";
      remove.addEventListener("click", () => {
        stored = stored.filter((r) => r.prefix !== route.prefix);
        // The token goes with the route it belonged to; leaving it in the map
        // would silently re-arm a prefix that was later re-added.
        secrets.delete(route.prefix);
        commitRoutes();
        say("neutral", `${route.prefix} removed.`);
      });
      head.append(prefix, arrow, upstream, remove);
      item.append(head);

      const names = Object.keys(route.headers);
      if (names.length > 0) {
        const headers = document.createElement("p");
        headers.className = "route-headers";
        headers.textContent = names
          .map((name) => `${name}: ${route.headers[name] ?? ""}`)
          .join(" · ");
        item.append(headers);
      }

      if (route.secretHeader != null) {
        const secretHeader = route.secretHeader;
        const label = document.createElement("label");
        label.className = "route-secret";
        label.dataset.held = String((secrets.get(route.prefix) ?? "") !== "");
        const caption = document.createElement("span");
        caption.textContent = `${secretHeader} (memory only)`;
        const input = document.createElement("input");
        input.type = "password";
        input.autocomplete = "off";
        input.placeholder = "not set — this route is sent without it";
        input.value = secrets.get(route.prefix) ?? "";
        // No re-render on input: this element is the one being typed into.
        input.addEventListener("input", () => {
          if (input.value === "") secrets.delete(route.prefix);
          else secrets.set(route.prefix, input.value);
          label.dataset.held = String(input.value !== "");
        });
        label.append(caption, input);
        item.append(label);
      }

      return item;
    }),
  );
}

/**
 * Add a route from the form, refusing the one prefix that would fail mutely.
 *
 * A PREFIX OF `/` CANNOT EVER MATCH. `matchRoute` requires the remainder to be
 * empty or to start with a slash, and `/`'s remainder for `/openai/models` is
 * `openai/models` -- so a route added as `/` would sit in the table looking
 * configured while every request through it returned a bare 404. Rejected here
 * rather than discovered there.
 */
function addRoute(): void {
  const prefix = routePrefixEl.value.trim();
  const upstream = routeUpstreamEl.value.trim();

  if (!prefix.startsWith("/") || prefix.length < 2) {
    say("failed", "a prefix needs a name after the slash, like /openai");
    return;
  }
  if (upstream === "") {
    say(
      "failed",
      "an upstream base URL is required — the upstream is never taken from the request",
    );
    return;
  }
  if (stored.some((route) => route.prefix === prefix)) {
    say("failed", `${prefix} is already configured; remove it first`);
    return;
  }

  const secretHeader = routeSecretNameEl.value.trim();
  stored = [
    ...stored,
    {
      prefix,
      upstream,
      headers: parseHeaders(routeHeadersEl.value),
      secretHeader: secretHeader === "" ? null : secretHeader,
    },
  ];
  if (secretHeader !== "" && routeSecretValueEl.value !== "") {
    secrets.set(prefix, routeSecretValueEl.value);
  }

  commitRoutes();
  addRouteForm.reset();
  say("neutral", `${prefix} → ${upstream} is being served to the mesh now.`);
}

/**
 * Send one request through this page's own edge and stream what comes back.
 *
 * NO `await res.text()` ANYWHERE. The reader loop is the only way this page
 * can show that a `text/event-stream` arrives in pieces; collecting the body
 * first would make a streaming upstream and a buffering one look identical,
 * which is the exact failure this console exists to rule out.
 */
async function runConsole(): Promise<void> {
  const typed = consolePathEl.value.trim();
  const prefix = typed.startsWith("/") ? typed : `/${typed}`;
  const body = consoleBodyEl.value;

  consoleStatusEl.textContent = `${consoleMethodEl.value} ${prefix}…`;
  consoleOutputEl.textContent = "";
  consoleSendButton.disabled = true;
  try {
    // Straight to the endpoint -- see `proxyEndpoint`'s comment for why not
    // through this page's own edge. The origin is arbitrary and never used:
    // the endpoint reads the path and strips its own `/proxy` mount.
    const res = await proxyEndpoint(
      new Request(`http://proxy.local/proxy${prefix}`, {
        method: consoleMethodEl.value,
        headers: parseHeaders(consoleHeadersEl.value),
        ...(body !== "" ? { body } : {}),
      }),
    );
    consoleStatusEl.textContent = describeStatus(res);
    const stats = await streamInto(res, (text) => {
      consoleOutputEl.textContent += text;
    });
    // The timing IS the streaming evidence: a buffered response would put the
    // first chunk at the same moment as the last.
    if (stats.firstChunkMs !== null) {
      consoleStatusEl.textContent += ` · ${stats.chunks} chunk(s), first at ${Math.round(stats.firstChunkMs)} ms of ${Math.round(stats.totalMs)} ms`;
    }
  } catch (err) {
    // A fetch that never reached the edge at all -- the ServiceWorker gone,
    // the peer stopped mid-request -- looks nothing like an upstream failure
    // and must not be reported as one.
    consoleStatusEl.textContent = `the request never completed: ${err instanceof Error ? err.message : String(err)}`;
    console.error("proxy: console request failed:", err);
  } finally {
    consoleSendButton.disabled = false;
  }
}

/**
 * This peer's mounts. The endpoint is built ONCE and reads `currentRoutes()`
 * per request, so a session that starts more than once (join, disconnect,
 * reconnect) serves the same live route table rather than a snapshot of
 * whatever was configured at the moment it last connected.
 */
/**
 * ONE endpoint, mounted for the mesh AND called directly by the console.
 *
 * The console used to go out through this page's own edge --
 * `${baseUrl}${peerId}/proxy/...` -- on the reasoning that a peer can address
 * itself. It cannot: that request hangs indefinitely, with no error and no
 * timeout, while the identical call from a SECOND peer answers in under a
 * second. Verified both ways before changing anything.
 *
 * Calling the handler directly is also the better tool. It answers before this
 * page has joined any mesh, so routes can be tried while they are being
 * configured, and it isolates what the console is for -- did MY route, MY
 * headers and MY upstream behave -- from whether the mesh is currently
 * healthy. The mesh path has its own proof: another peer fetching
 * `/proxy/openai/models` and getting the upstream's own answer.
 */
const proxyEndpoint = createProxyEndpoint({ routes: currentRoutes });

// One-click requests against the pre-configured routes, placed directly above
// the console they fill.
consoleForm.before(
  renderExamples(DEFAULT_EXAMPLES, (example) => {
    consoleMethodEl.value = example.method;
    consolePathEl.value = example.path;
  }),
);

async function buildMounts(): Promise<ReturnType<typeof createMounts>> {
  const mounts = createMounts();
  mounts.provide("/proxy", proxyEndpoint);
  return mounts;
}

/**
 * Render whatever `../../browser/session.ts` has decided -- the one place on
 * this page that writes a status line or enables a control.
 */
function renderSession(state: SessionState): void {
  peerIdEl.textContent = state.identity ?? "none saved yet";

  joinForm.hidden = !state.controls.join;
  disconnectButton.hidden = !state.controls.disconnect;
  reconnectButton.hidden = !state.controls.reconnect;
  resetButton.hidden = !state.controls.reset;

  const phase = state.phase;
  const tell = (tone: string, text: string): void => {
    sessionStatusEl.dataset.tone = tone;
    sessionStatusEl.textContent = text;
  };

  switch (phase.kind) {
    case "checking":
      stateEl.textContent = "reading the saved identity";
      tell("neutral", "");
      break;
    case "starting":
      stateEl.textContent = phase.peerState;
      tell("neutral", "");
      break;
    case "live":
      stateEl.textContent = "ready";
      tell(
        "ok",
        phase.note ??
          (phase.joinedBy === "resumed"
            ? "Resumed the membership saved in this browser -- no invitation was needed."
            : "Joined by redeeming an invitation."),
      );
      break;
    case "needs-invitation":
      stateEl.textContent = "not joined";
      tell(phase.reason === "no-identity" ? "neutral" : "unreachable", phase.message);
      break;
    case "disconnected":
      stateEl.textContent = "disconnected";
      tell("neutral", phase.message);
      break;
    case "blocked":
      stateEl.textContent = "blocked";
      tell("failed", phase.message);
      break;
    case "failed":
      stateEl.textContent = "error";
      tell("failed", phase.message);
      console.error("proxy: session failed:", phase.message);
      break;
  }
}

const advertisements = (): AdvertisementInput[] => [{ id: "proxy", kind: "proxy", title: "Proxy" }];

async function main(): Promise<void> {
  const session: PeerSession = createPeerSession({
    key: "proxy",
    mounts: await buildMounts(),
    policies: PROXY_POLICIES,
    advertisements,
    // Local-loopback dev only -- see `../../browser/node-profile.ts`'s
    // `CreateBrowserNodeInit.dev` doc comment.
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
   * never seen and these upstreams come back under a different provider id.
   */
  resetButton.addEventListener("click", () => {
    const confirmed = confirm(
      "Reset this page's identity?\n\n" +
        "This is NOT the same as disconnecting:\n" +
        "  * a new peer id, so these upstreams come back as a provider the hub has never seen\n" +
        "  * the membership this page holds now is left behind on the hub as a stale record\n" +
        "  * rejoining needs a NEW invitation -- the old one is already spent\n\n" +
        "Use disconnect instead if you only want to stop proxying for now.",
    );
    if (!confirmed) return;
    void session.resetIdentity();
  });

  await session.start();
}

renderRoutes();

addRouteForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  addRoute();
});

consoleForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  void runConsole();
});

main().catch((err: unknown) => {
  stateEl.textContent = "error";
  sessionStatusEl.dataset.tone = "failed";
  sessionStatusEl.textContent = String(err);
  console.error("proxy: failed to start:", err);
});

// Scanning a picture is a second way to fill the same field the join form
// already reads -- see `../../browser/qr-join.ts` for why there are two inputs
// and why the code is shown rather than used silently.
const qrUi = createQrJoinUi(joinForm);
wireQrJoin({
  fileInputs: [qrUi.fileInput],
  cameraButton: qrUi.cameraButton,
  cameraHost: qrUi.cameraHost,
  field: inviteInput,
  onCode: () => joinForm.requestSubmit(),
  status: (message) => {
    qrUi.status.textContent = message;
  },
});
