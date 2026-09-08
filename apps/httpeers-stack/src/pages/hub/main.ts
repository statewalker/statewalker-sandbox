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
 * `../../policy.ts` rules and policies, the same
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
 * SAVED IS NOT ACTIVE, AND THE TABLE BELOW KEEPS THEM APART. "Saved" is
 * membership: a `MemberRecord` in the persisted snapshot, which survives a
 * reload. "Active" is presence: a heartbeat inside the TTL window. A member
 * that is saved but not active has closed its tab; an active one is live
 * right now. Both come from ONE source -- `HubEndpoints.meshView`, which is
 * `mesh-view.ts`'s `buildMeshView`, the same projection `GET
 * /.well-known/mesh` serves every remote peer. This page deliberately does
 * NOT re-derive `online` by joining a member list against a presence list:
 * that would be a second notion of the same fact, free to disagree with the
 * one everybody else reads.
 *
 * THIS PAGE CALLS ITS OWN ENDPOINTS, AND NOT THROUGH THE EDGE. It is the
 * hub, so `meshView()` and `removeMember()` are local calls. Reading is a
 * plain in-process accessor; removal goes through the hub's own mounted
 * `DELETE /admin/members/{peerId}` handler via the mount table. Neither
 * goes through the ServiceWorker edge or `peer.dispatch`: a self-call along
 * either path hits `httpeers.core`'s binding middleware, which throws
 * `PeerBindingLostError` on a request that has no remote peer to prove.
 * See `../../browser/hub-runtime.ts`'s `removeMember` for the full note,
 * including what the direct call bypasses and why that is not a privilege
 * escalation.
 */

import { describeError } from "../../browser/describe-error.js";
import type { BrowserHubHandle, BrowserHubState } from "../../browser/hub-runtime.js";
import { startBrowserHub } from "../../browser/hub-runtime.js";
import { clearIdentity, loadOrCreateIdentity, peerIdOf } from "../../browser/identity.js";
import type { JoinBlob } from "../../browser/join-blob.js";
import { encodeJoinBlob } from "../../browser/join-blob.js";
import type { BrowserSnapshotStore } from "../../browser/snapshot-store.js";
import { createIdbSnapshotStore } from "../../browser/snapshot-store.js";
// `../../ports.js`, NOT `../../static-server/main.js`: that module's
// run-as-a-process guard evaluates `process.argv` at top level, which is a
// ReferenceError in a tab before any page code runs. See `ports.ts`.
import { HUB_PAGE_PORT } from "../../ports.js";
import { qrSvg } from "../../browser/qr-encode.js";

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
const adminStatusEl = el("admin-status");
const resetButton = el<HTMLButtonElement>("reset");
const mintRolesEl = el<HTMLSelectElement>("mint-roles");
const mintButtons = {
  mint: el<HTMLButtonElement>("mint"),
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

/**
 * AN INVITATION IS NOT TIED TO A PAGE. Any page can redeem any code: the hub
 * validates the code and the roles it grants, and never learns which origin
 * asked. The UI offered one button per page for a while, which invented a
 * distinction the protocol does not have -- three buttons for one concept,
 * and an operator reasonably asking why an "image peer" code could not be
 * pasted into the app. The only real variable is the roles granted.
 */
interface MintTarget {
  roles: string[];
}

/** One minted invitation, and everything the panel needs to keep rendering it. */
interface MintedInvitation {
  id: string;
  target: MintTarget;
  roles: string[];
  expiresAt: number;
  blob: string;
  /** The row's own `<dd>` for the status, re-read on every refresh. */
  statusEl: HTMLElement;
  box: HTMLElement;
}

const minted: MintedInvitation[] = [];

/**
 * One copy button plus the value it copies, rendered as selectable text
 * either way.
 *
 * `navigator.clipboard` is unavailable on an insecure origin that is not
 * loopback, and can be refused even where it exists. Saying so beats a
 * button that silently does nothing -- and the value beside it is
 * `user-select: all`, so a failed copy costs one manual selection.
 */
function appendCopyRow(dl: HTMLElement, label: string, value: string, href?: string): void {
  const dt = document.createElement("dt");
  dt.textContent = label;

  const dd = document.createElement("dd");
  dd.className = "value";
  if (href != null) {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = value;
    dd.append(a);
  } else {
    dd.textContent = value;
  }

  const actions = document.createElement("dd");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Copy";
  const copied = document.createElement("span");
  copied.className = "copied";
  button.addEventListener("click", () => {
    navigator.clipboard?.writeText(value).then(
      () => {
        copied.textContent = " copied";
      },
      () => {
        copied.textContent = " could not copy — select it";
      },
    );
  });
  actions.append(button, copied);

  dl.append(dt, dd, actions);
}

function renderInvitation(target: MintTarget, blob: JoinBlob, expiresAt: number): void {
  const encoded = encodeJoinBlob(blob);

  const box = document.createElement("div");
  box.className = "invite";

  const header = document.createElement("header");
  const title = document.createElement("h3");
  title.textContent = `invitation \u00b7 ${target.roles.join(", ")}`;
  const roles = document.createElement("span");
  roles.className = "roles";
  roles.textContent = `single use · valid ${INVITATION_TTL_MS / 60_000} min`;
  header.append(title, roles);

  const dl = document.createElement("dl");

  const statusDt = document.createElement("dt");
  statusDt.textContent = "status";
  const statusEl = document.createElement("dd");
  const statusPad = document.createElement("dd");
  dl.append(statusDt, statusEl, statusPad);

  const rolesDt = document.createElement("dt");
  rolesDt.textContent = "roles";
  const rolesDd = document.createElement("dd");
  rolesDd.textContent = target.roles.join(", ");
  const rolesPad = document.createElement("dd");
  dl.append(rolesDt, rolesDd, rolesPad);

  // THE CODE IS THE ARTEFACT. It is what a page's own join prompt consumes,
  // and the only thing carrying this mesh's identity; the bare id alone is
  // not enough, because this hub's peer id is generated at runtime and is
  // therefore absent from `httpeers.json`. The id is shown beneath it only so
  // a row can be matched against the hub's own records.
  appendCopyRow(dl, "code", encoded);
  appendCopyRow(dl, "id", blob.invitationId);

  // THE SAME CODE, AS A PICTURE. A guest with a phone photographs this and
  // feeds the photo to their page's scanner; the alternative is retyping 315
  // base64 characters from someone else's screen.
  //
  // It carries the BARE CODE, not a link to a particular page -- see this
  // module's "AN INVITATION IS NOT TIED TO A PAGE": any page redeems any code,
  // and a deep link would quietly undo that and teach the hub its guests' URLs.
  const qr = document.createElement("div");
  qr.className = "qr";
  qr.innerHTML = qrSvg(encoded);
  const qrHint = document.createElement("p");
  qrHint.className = "qr-hint";
  qrHint.textContent = "photograph this, then use \u201cscan image\u201d on the joining page";
  qr.append(qrHint);

  box.append(header, dl, qr);

  minted.push({
    id: blob.invitationId,
    target,
    roles: target.roles,
    expiresAt,
    blob: encoded,
    statusEl,
    box,
  });

  // Newest first: the operator's attention is on the one they just minted.
  if (invitationsEl.firstElementChild?.classList.contains("empty")) {
    invitationsEl.replaceChildren(box);
  } else {
    invitationsEl.prepend(box);
  }
}

/**
 * Refresh each minted invitation's status from the hub's own state.
 *
 * "Unspent" is asked of `spentInvitationIds` -- the very set `redeem`
 * consults, and the one that survives a reload -- rather than tracked
 * locally, so this panel cannot claim a code is still usable when the hub
 * would refuse it.
 */
function refreshInvitationStatuses(hub: BrowserHubHandle): void {
  const spent = hub.spentInvitationIds();
  const now = Date.now();
  for (const inv of minted) {
    const isSpent = spent.has(inv.id);
    // Spent is checked FIRST, matching `redeem`'s own order: a code that was
    // redeemed and has since passed its expiry is "redeemed", not "expired".
    const status = isSpent ? "redeemed" : inv.expiresAt <= now ? "expired" : "unspent";
    inv.statusEl.textContent = status;
    inv.statusEl.className = `status-${status}`;
    inv.box.dataset.spent = String(status !== "unspent");
  }
}

function renderMembers(hub: BrowserHubHandle): void {
  // ONE source for both facts -- see the module comment. `online` is
  // `buildMeshView`'s, not this page's.
  const { members } = hub.meshView();

  if (members.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.className = "empty";
    cell.colSpan = 5;
    cell.textContent = "no members yet — mint an invitation above and open its link";
    row.append(cell);
    membersEl.replaceChildren(row);
    return;
  }

  membersEl.replaceChildren(
    ...members.map((member) => {
      const row = document.createElement("tr");

      const peer = document.createElement("td");
      peer.className = "peer";
      peer.textContent = member.peerId;

      // ROLES ARE EDITABLE AFTER JOINING, not only at invitation time. The
      // hub owns the member record, so changing them here is the same act
      // the invitation performs -- and `setMemberRoles` also records the
      // change in the revocation registry, without which the peer would keep
      // its OLD roles until its current token expired.
      const roles = document.createElement("td");
      const rolePicker = document.createElement("select");
      rolePicker.className = "role-picker";
      for (const name of hub.roleNames()) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        opt.selected = member.roles.includes(name);
        rolePicker.append(opt);
      }
      rolePicker.addEventListener("change", () => {
        const next = [rolePicker.value];
        try {
          const { policyVersion } = hub.setMemberRoles(member.peerId, next);
          adminStatusEl.dataset.tone = "done";
          adminStatusEl.textContent =
            `${member.peerId} is now ${next.join(", ")} — policy version is now ` +
            `${policyVersion}. Its current token stated the old roles and no longer verifies; ` +
            "it picks the change up on its next heartbeat.";
          renderMembers(hub);
        } catch (err) {
          adminStatusEl.dataset.tone = "error";
          adminStatusEl.textContent = `Could not change roles for ${member.peerId}: ${String(err)}`;
          rolePicker.value = member.roles[0] ?? "";
        }
      });
      roles.append(rolePicker);

      const state = document.createElement("td");
      state.dataset.online = String(member.online);
      // Both words, always: "saved" alone would read as a downgrade rather
      // than as the other half of a pair, and an operator needs to see that
      // a peer is still a member even while its tab is closed.
      state.textContent = member.online ? "saved + active" : "saved, not active";

      const addrs = document.createElement("td");
      addrs.textContent = String(member.addrs.length);

      const actions = document.createElement("td");
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "revoke";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", () => void revokeMember(hub, member.peerId, revoke));
      actions.append(revoke);

      row.append(peer, roles, state, addrs, actions);
      return row;
    }),
  );
}

/**
 * Remove a member, and SHOW WHAT THAT DID.
 *
 * Removal is two things, not one (`../../hub/admin.ts`):
 * `MemberStore.remove` drops membership, and `revocations.revoke` records
 * the change and bumps the policy version. The second is why a removed
 * peer's *live, unexpired* token stops working instead of lingering until
 * it expires — every peer notices the moved version on its next heartbeat
 * and pulls the new deny-list. Reporting the new policy version is how this
 * panel shows that the revocation half actually happened, rather than
 * implying the row simply vanished from a list.
 */
async function revokeMember(
  hub: BrowserHubHandle,
  peerId: string,
  button: HTMLButtonElement,
): Promise<void> {
  const confirmed = confirm(
    `Revoke ${peerId}?\n\n` +
      "This removes it from the mesh AND revokes its tokens: the token it is holding right " +
      "now stops working on its next call, rather than lasting until it expires.\n\n" +
      "It can rejoin only with a new invitation.",
  );
  if (!confirmed) return;

  button.disabled = true;
  try {
    const result = await hub.removeMember(peerId);
    adminStatusEl.dataset.tone = "done";
    adminStatusEl.textContent =
      `Removed ${result.removed} and revoked its tokens — policy version is now ` +
      `${result.policyVersion}. Its current token no longer verifies; peers pick the change ` +
      "up on their next heartbeat.";
    // IMMEDIATELY, not on the next poll tick. An operator who pressed
    // revoke and saw the row sit there for a second would reasonably
    // conclude it had failed.
    renderMembers(hub);
  } catch (err) {
    button.disabled = false;
    adminStatusEl.dataset.tone = "error";
    adminStatusEl.textContent = `Could not revoke ${peerId}: ${String(err)}`;
    console.error("hub page: revoke failed:", err);
  }
}

// --- startup --------------------------------------------------------------

/** `admin` implies `member` (`../../policy.ts`), so an admin code grants both. */
/**
 * Fallback only. The real list comes from `hub.roleNames()` at startup --
 * this exists so a press before the hub is ready cannot mint an unvalidated
 * role, and so the guard below has something to check against if the select
 * is ever tampered with. `assertValid` in the store is the real gate.
 */
const MINT_ROLE_FALLBACK = "member";

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

  // The invitation role options come from the mesh's vocabulary, not a
  // literal: a role added to `../../policy.ts` shows up here with no second
  // list to remember. The markup ships `member`/`admin` so the control is not
  // empty before the hub is up; this replaces them with the real set.
  mintRolesEl.replaceChildren(
    ...hub.roleNames().map((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      opt.selected = name === "member";
      return opt;
    }),
  );

  mintButtons.mint.disabled = false;
  mintButtons.mint.addEventListener("click", () => {
    // A NEW id on every press. Invitations are single-use, so an operator
    // pressing this twice must get two distinct codes -- reusing one would
    // hand out a code that is already dead.
    const selected = mintRolesEl.value;
    const roles = [hub.roleNames().includes(selected) ? selected : MINT_ROLE_FALLBACK];
    const id = newInvitationId();
    const record = hub.invitations.create(id, roles, INVITATION_TTL_MS);
    renderInvitation(
      { roles },
      { relayAddrs: [hub.relayAddr], hubPeerId: hub.peerId, invitationId: id },
      record.expiresAt,
    );
    // Immediately, for the same reason revoking re-renders immediately.
    refreshInvitationStatuses(hub);
  });

  renderMembers(hub);
  setInterval(() => {
    renderMembers(hub);
    refreshInvitationStatuses(hub);
  }, VIEW_POLL_INTERVAL_MS);
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
  // The old hint said "served from port 5177, run pnpm bootstrap" wherever the
  // page came from. Shown to someone on https://hub.httpeers.net it sends them
  // to inspect a local development setup they do not have -- which is exactly
  // what it did the first time a phone failed to reach the relay.
  const localRun =
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.port === String(HUB_PAGE_PORT);
  showError(
    localRun
      ? `${describeError(err)}\n\nThis page is served from port ${HUB_PAGE_PORT}; it still ` +
          'needs the relay that "pnpm bootstrap" wrote into httpeers.json to be running.'
      : `${describeError(err)}\n\nThis page is served from ${location.origin}. The relay it ` +
          "dials is named in httpeers.json. If that relay is reachable from other networks, " +
          "the remaining causes are local to this one: a network that blocks the WebSocket, " +
          "or DNS for the relay's hostname failing here.",
  );
  console.error("hub page: failed to start the hub:", err);
});
