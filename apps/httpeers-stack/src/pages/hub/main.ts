/**
 * The hub page -- Task 24. A third browser peer that RUNS the mesh's hub:
 * it holds the membership list, mints every token, serves search, and hands
 * an operator one copyable join link per page.
 *
 * A SECOND IMPLEMENTATION, NOT A REPLACEMENT. `../../hub/main.ts` -- the
 * Node hub, `scripts/start.sh`, `pnpm bootstrap` -- is untouched and stays
 * the default way this stack comes up. What this page proves is that the
 * hub's whole HTTP surface (`../../hub/endpoints.ts`) is genuinely
 * transport-neutral: the same `createHubEndpoints`, the same
 * `../../policy.ts` vocabulary and `.access` tree, the same
 * `createHubState` over the same `SnapshotStore` seam, running in a tab.
 * The only things that differ are where the key is kept, where the snapshot
 * is kept, and how a joining page is told the mesh's name.
 *
 * THAT LAST ONE IS THE WHOLE REASON THE PANEL BELOW EXISTS. Every other
 * page learns the mesh from `httpeers.json`, which `pnpm bootstrap` writes
 * from a key file -- so the Node hub's peerId is knowable before anything
 * runs. This hub's is not: it is generated (or reloaded) in IndexedDB, in
 * this tab, long after bootstrap. Nothing on disk can name it, so it hands
 * itself out at runtime, as a join blob (`../../browser/join-blob.ts`)
 * carrying `relayAddrs`, `hubPeerId` and one single-use invitation id.
 *
 * ONE INVITATION PER PAGE, NEVER ONE PER MESH. Invitations are single-use
 * by construction (`../../hub/hub-state.ts`'s `redeem` moves the id to
 * `spentInvitationIds`, spent check first, unconditionally), so a link
 * shared between two pages lets exactly one in and fails the rest with
 * `already-redeemed`. Every button below mints a fresh one.
 *
 * IDENTITY PERSISTS, AND THAT IS NOT OPTIONAL. `claims.mesh ===
 * claims.iss`: the mesh IS this hub's peerId. A fresh key per reload would
 * silently invalidate every token ever issued and every link handed out,
 * with nothing to say so -- the failure would present as "my page suddenly
 * cannot join" one reload later. So the key lives in this origin's
 * IndexedDB (`../../browser/identity.ts`) and is reused. And because a
 * stuck key with no way out is worse than no persistence at all, the reset
 * control below exists -- and says, in the terms above, what it destroys.
 *
 * WHY MEMBERSHIP AND PRESENCE ARE READ IN-PROCESS. This page is inside the
 * hub; `HubEndpoints.presence` and `MemberStore.list` are two references
 * away. Rendering them by dispatching HTTP requests to itself would add a
 * token, a router hop and a JSON round trip to read a `Map` it is holding.
 * The HTTP endpoints remain the only way any OTHER peer sees this.
 */
import type { BrowserHubHandle, BrowserHubState } from "../../browser/hub-runtime.js";
import { startBrowserHub } from "../../browser/hub-runtime.js";
import { clearIdentity, loadOrCreateIdentity, peerIdOf } from "../../browser/identity.js";
import type { JoinBlob } from "../../browser/join-blob.js";
import { joinUrl } from "../../browser/join-blob.js";
import type { BrowserSnapshotStore } from "../../browser/snapshot-store.js";
import { createIdbSnapshotStore } from "../../browser/snapshot-store.js";
// `../../ports.js`, NOT `../../static-server/main.js`: that module's
// run-as-a-process guard evaluates `process.argv` at top level, which is a
// ReferenceError in a tab before any page code runs. See `ports.ts`.
import { APP_PORT, HUB_PAGE_PORT, IMAGE_PEER_PORT } from "../../ports.js";

/**
 * This peer's ServiceWorker adapter key, and therefore the first segment of
 * its edge's URLs. Matches `vite.hub.config.ts`'s `dist/hub` output and the
 * origin `../../static-server/main.ts` serves it from. NOT a peer id -- a
 * local channel name, meaningful only inside this browser.
 */
const EDGE_KEY = "hub";

/** How often the members/presence table catches up with the hub's own state. Presence itself is TTL'd on a 15 s window and swept every second. */
const VIEW_POLL_INTERVAL_MS = 1_000;

/** How long a minted join link stays usable -- `../../hub/main.ts`'s `JOIN_INVITATION_TTL_MS`, and for the same reason: long enough to open a browser and paste, short enough that a link left open from this morning is not a standing way in. */
const INVITATION_TTL_MS = 30 * 60_000;

const el = <T extends HTMLElement>(id: string): T => document.querySelector<T>(`#${id}`)!;

const meshIdEl = el("mesh-id");
const stateEl = el("state");
const relayEl = el("relay");
const circuitEl = el("circuit");
const baseUrlEl = el("base-url");
const errorEl = el("error");
const invitationsEl = el("invitations");
const membersEl = el<HTMLTableSectionElement>("members");
const resetButton = el<HTMLButtonElement>("reset");
const mintButtons = {
  app: el<HTMLButtonElement>("mint-app"),
  appAdmin: el<HTMLButtonElement>("mint-app-admin"),
  imagePeer: el<HTMLButtonElement>("mint-image-peer"),
};

let handle: BrowserHubHandle | null = null;
let snapshotStore: BrowserSnapshotStore | null = null;

// --- rendering ------------------------------------------------------------

function setState(state: BrowserHubState | "error"): void {
  stateEl.textContent = state;
  stateEl.dataset.tone = state === "error" ? "error" : "";
}

function showError(message: string): void {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

/**
 * `crypto.randomUUID` -- the browser's own, the same generator
 * `../../hub/main.ts` reaches for as `node:crypto`'s `randomUUID`. An
 * invitation id only has to be unguessable and unique; it carries no
 * structure anything reads.
 */
function newInvitationId(): string {
  return crypto.randomUUID();
}

interface MintTarget {
  label: string;
  roles: string[];
  /** The page this link opens. Composed from this origin's hostname and the sibling port `../../static-server/main.ts` reserves for that page. */
  port: number;
}

/**
 * The link's HOSTNAME comes from this page's own location, not a literal.
 * A hub page opened at `127.0.0.1` must hand out `127.0.0.1` links and one
 * opened at `localhost` must hand out `localhost` links: the two are
 * different origins to a browser, so a link that swapped them would send
 * the joining page to a DIFFERENT IndexedDB (a different identity) than the
 * operator was looking at, and -- on the app page -- to a different
 * ServiceWorker registration. The port is the one this deployment reserves
 * for that page; only the port ever changes between these links.
 */
function pageUrl(port: number): string {
  return `${location.protocol}//${location.hostname}:${port}/`;
}

function renderInvitation(target: MintTarget, blob: JoinBlob): void {
  const link = joinUrl(pageUrl(target.port), blob);

  const box = document.createElement("div");
  box.className = "invite";

  const header = document.createElement("header");
  const title = document.createElement("h3");
  title.textContent = target.label;
  const roles = document.createElement("span");
  roles.className = "roles";
  roles.textContent = `roles: ${target.roles.join(", ")} · single use · ${INVITATION_TTL_MS / 60_000} min`;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy link";
  const copied = document.createElement("span");
  copied.className = "copied";
  copy.addEventListener("click", () => {
    // `navigator.clipboard` is unavailable on an insecure origin that is not
    // loopback, and can be refused even where it exists. The link itself is
    // rendered as selectable text below either way, so a failed copy costs
    // the operator a manual selection and nothing else -- said out loud
    // rather than leaving a button that silently does nothing.
    navigator.clipboard?.writeText(link).then(
      () => {
        copied.textContent = "copied";
      },
      () => {
        copied.textContent = "could not copy -- select the link below";
      },
    );
  });
  header.append(title, roles, copy, copied);

  const linkEl = document.createElement("div");
  linkEl.className = "link";
  linkEl.textContent = link;

  box.append(header, linkEl);
  // Newest first: the operator's attention is on the one they just minted.
  invitationsEl.prepend(box);
}

function renderMembersAndPresence(hub: BrowserHubHandle): void {
  const members = hub.members();
  const presenceByPeer = new Map(hub.presence().map((p) => [p.peerId, p]));

  if (members.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.className = "empty";
    cell.colSpan = 5;
    cell.textContent = "no members yet -- mint a link above and open it";
    row.append(cell);
    membersEl.replaceChildren(row);
    return;
  }

  membersEl.replaceChildren(
    ...members.map((member) => {
      const presence = presenceByPeer.get(member.peerId);
      const online = presence != null;

      const row = document.createElement("tr");

      const peer = document.createElement("td");
      peer.className = "peer";
      peer.textContent = member.peerId;

      const roles = document.createElement("td");
      roles.textContent = member.roles.join(", ");

      const onlineCell = document.createElement("td");
      onlineCell.dataset.online = String(online);
      onlineCell.textContent = online ? "yes" : "no";

      const seq = document.createElement("td");
      seq.textContent = presence != null ? String(presence.seq) : "—";

      const addrs = document.createElement("td");
      addrs.textContent = presence != null ? String(presence.addrs.length) : "—";

      row.append(peer, roles, onlineCell, seq, addrs);
      return row;
    }),
  );
}

// --- startup --------------------------------------------------------------

const MINT_TARGETS: Record<keyof typeof mintButtons, MintTarget> = {
  app: { label: "App page", roles: ["member"], port: APP_PORT },
  // `admin` implies `member` (`../../policy.ts`), so this link is the
  // member one plus `std:mesh.admin` -- the app page's revoke control is
  // only exercisable by an admin, and opened as a member it renders the 403
  // instead, which is also worth seeing.
  appAdmin: { label: "App page (admin)", roles: ["admin"], port: APP_PORT },
  imagePeer: { label: "Image peer", roles: ["member"], port: IMAGE_PEER_PORT },
};

async function main(): Promise<void> {
  // Loaded BEFORE the hub starts, and shown immediately: this is the mesh's
  // name, and an operator should be able to read it (and reach the reset
  // control below) even if the relay is down and the hub never comes up.
  const privateKey = await loadOrCreateIdentity();
  meshIdEl.textContent = peerIdOf(privateKey);

  snapshotStore = await createIdbSnapshotStore();

  // Local-loopback dev only -- see `../../browser/node-profile.ts`'s
  // `CreateBrowserNodeInit.dev`. `httpeers.json`'s relay address is what
  // actually determines whether this matters; the hostname check is just
  // how this page decides whether it is plausibly talking to that kind of
  // relay.
  const dev = location.hostname === "localhost" || location.hostname === "127.0.0.1";

  const hub = await startBrowserHub({
    key: EDGE_KEY,
    privateKey,
    snapshotStore,
    dev,
    onState: setState,
  });
  handle = hub;

  // The peerId the node actually came up with, not the one derived above.
  // They must be equal -- the same key produced both -- and rendering the
  // authoritative one means a mismatch would be visible rather than
  // theoretical.
  meshIdEl.textContent = hub.peerId;
  relayEl.textContent = hub.relayAddr;
  circuitEl.textContent = hub.circuitAddr;
  baseUrlEl.textContent = hub.baseUrl;

  for (const [name, button] of Object.entries(mintButtons)) {
    const target = MINT_TARGETS[name as keyof typeof mintButtons];
    button.disabled = false;
    button.addEventListener("click", () => {
      const id = newInvitationId();
      hub.invitations.create(id, target.roles, INVITATION_TTL_MS);
      renderInvitation(target, {
        relayAddrs: [hub.relayAddr],
        hubPeerId: hub.peerId,
        invitationId: id,
      });
    });
  }

  renderMembersAndPresence(hub);
  setInterval(() => renderMembersAndPresence(hub), VIEW_POLL_INTERVAL_MS);
}

// Wired up BEFORE `main()` runs and independently of whether it succeeds --
// see the "stuck key with no way out" note in the module comment. A hub
// that cannot start is exactly when an operator most needs this.
resetButton.addEventListener("click", () => {
  const confirmed = confirm(
    "Reset this hub's identity?\n\n" +
      "This does not rotate a credential -- it founds a DIFFERENT mesh:\n" +
      "  * a new hub peer id, so every token this hub ever issued stops verifying\n" +
      "  * every join link handed out so far stops working\n" +
      "  * the member list and the record of which invitations were already spent\n" +
      "    are both erased\n\n" +
      "Peers already joined will not be able to rejoin without a new link.\n" +
      "There is no undo.",
  );
  if (!confirmed) return;

  void (async () => {
    resetButton.disabled = true;
    try {
      // Stopped first, so the hub is not still minting tokens against a key
      // that is about to disappear.
      await handle?.stop();
      await snapshotStore?.clear();
      await clearIdentity();
      location.reload();
    } catch (err) {
      resetButton.disabled = false;
      showError(`Could not reset this hub's identity: ${String(err)}`);
      console.error("hub page: reset failed:", err);
    }
  })();
});

main().catch((err: unknown) => {
  setState("error");
  showError(
    `${String(err)}\n\nThis page is served from port ${HUB_PAGE_PORT}; it still needs the relay ` +
      'that "pnpm bootstrap" wrote into httpeers.json to be running.',
  );
  console.error("hub page: failed to start the hub:", err);
});
