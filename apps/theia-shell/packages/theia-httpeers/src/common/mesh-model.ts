/**
 * What the Mesh view shows, derived from the member's own state. Pure, so the
 * decisions are unit-tested under Node; the widgets only render the result.
 */

import { type RuleSet, ruleSet } from "@statewalker/httpeers-access";
import type { MeshView } from "@statewalker/httpeers-core";
import type { SessionState } from "@statewalker/httpeers-member";

/** One service a peer advertises on its heartbeat. */
export interface PeerService {
  id: string;
  kind: string;
  title: string;
}

/** One row of the peers list. */
export interface PeerRow {
  peerId: string;
  roles: string[];
  online: boolean;
  isSelf: boolean;
  isHub: boolean;
  services: PeerService[];
}

/**
 * The mesh view as rows: this peer first, the hub second, then online peers
 * before offline ones, by peer id within each group.
 *
 * The hub is not itself a member, so the view does not list it; it gets a row
 * anyway, since it is what this member is connected to and it advertises the
 * mesh's own services. Any other advertiser that is not a member is dropped:
 * nobody vouches for it.
 */
export function peerRows(view: MeshView | null, hubPeerId: string | null): PeerRow[] {
  if (view == null) return [];
  const rank = (row: PeerRow) => (row.isSelf ? 0 : row.isHub ? 1 : row.online ? 2 : 3);
  const members =
    hubPeerId == null || view.members.some((m) => m.peerId === hubPeerId)
      ? view.members
      : [...view.members, { peerId: hubPeerId, roles: [], online: true, addrs: [] }];
  return members
    .map((member) => ({
      peerId: member.peerId,
      roles: [...member.roles],
      online: member.online,
      isSelf: member.peerId === view.self,
      isHub: member.peerId === hubPeerId,
      services: view.advertisements
        .filter((ad) => ad.peerId === member.peerId)
        .map(({ id, kind, title }) => ({ id, kind, title })),
    }))
    .sort((a, b) => rank(a) - rank(b) || a.peerId.localeCompare(b.peerId));
}

/** The status-bar text for a session state; `null` before the session exists. */
export function statusBarText(state: Pick<SessionState, "phase" | "hubLink"> | null): string {
  if (state == null) return "Mesh: off";
  const { phase } = state;
  switch (phase.kind) {
    case "starting":
      return `Mesh: ${phase.peerState.replace(/-/g, " ")}`;
    case "live":
      return state.hubLink == null ? "Mesh: live" : `Mesh: live (${state.hubLink})`;
    case "needs-invitation":
      return "Mesh: not joined";
    default:
      return `Mesh: ${phase.kind}`;
  }
}

/**
 * Whether the app is served from this machine. A local mesh (a relay on
 * loopback, as in development and the e2e tests) needs libp2p's permissive
 * dial gater, which is only ever switched on for a loopback app.
 */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

let rules: RuleSet | undefined;

/**
 * This member's rules: who may call what it serves. The mesh protocol's own
 * capabilities, plus `app:proxy.use` for the proxy an operator may configure
 * (the same grant as `httpeers/apps/demos/src/shared/policy.ts`). Other
 * services a contribution mounts need their own capability added here.
 */
export function shellRules(): RuleSet {
  rules ??= ruleSet({
    version: 1,
    rules: [
      'capability("std:mesh.read")      <- role("member");',
      'capability("std:presence.write") <- role("member");',
      'capability("app:proxy.use")      <- role("member");',
      'capability("std:mesh.admin")     <- role("admin");',
      'role("member")                   <- role("admin");',
    ],
    policies: [
      'allow if capability("std:mesh.read"), resource("/.well-known")' +
        ' or capability("std:mesh.read"), resource($r), $r.starts_with("/.well-known/");',
      'allow if capability("app:proxy.use"), resource("/proxy")' +
        ' or capability("app:proxy.use"), resource($r), $r.starts_with("/proxy/");',
    ],
  });
  return rules;
}
