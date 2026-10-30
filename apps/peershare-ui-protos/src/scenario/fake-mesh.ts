/**
 * A FAKE of everything below the screens: the Sharer's tab (hub, router,
 * Bridge) and the Guest's member, in one object, in memory. It implements the
 * commands of `apps/peershare-protos/docs/PLAN.md` §2.2 with the behaviour the
 * rungs settled — one-time 24 h invites, pause vs stop vs revoke, close
 * session forgets — so the whole scenario can be clicked through. No network,
 * no persistence, no real probe.
 */

import {
  type BridgeDiagnosis,
  type Guest,
  INVITE_TTL_MS,
  type Invite,
  type Service,
  type ServiceDraft,
  type UpstreamKind,
} from "../model.js";
import type { JoinStage } from "../peershare/guest-join.js";
import type { ViewerService } from "../peershare/viewer-frame.js";
import type { LinkState } from "../vendor/group-status/group-status.js";

export interface SharerState {
  name: string;
  serverOn: boolean;
  services: Service[];
  guests: Guest[];
  /** The latest invite, while its modal is open or until it is used. */
  invite?: Invite;
  inviteOpen: boolean;
  bridge: BridgeDiagnosis;
}

export interface GuestState {
  name: string;
  peerId: string;
  /** "no-link": nothing opened yet, or the session was closed. */
  stage: "no-link" | JoinStage | "viewing";
  /** The link the Guest holds (sent by the Sharer). */
  link?: string;
  selected?: string;
  revoked: boolean;
}

export interface MeshState {
  sharer: SharerState;
  guest: GuestState;
}

export type Command =
  | { id: "peershare:set-name"; name: string }
  | { id: "peershare:add-service"; draft: ServiceDraft; kind: UpstreamKind }
  | { id: "peershare:edit-service"; serviceId: string; draft: ServiceDraft; kind: UpstreamKind }
  | { id: "peershare:toggle-service"; serviceId: string }
  | { id: "peershare:probe"; serviceId: string }
  | { id: "peershare:invite" }
  | { id: "peershare:close-invite" }
  | { id: "peershare:revoke-guest"; peerId: string }
  | { id: "peershare:start" }
  | { id: "peershare:stop" }
  | { id: "peershare:join" }
  | { id: "peershare:decline" }
  | { id: "peershare:open"; serviceId: string }
  | { id: "peershare:close-session" }
  /** Not a PeerShare command: the link travelling from Dirk to Claudia (chat, camera). */
  | { id: "scenario:deliver-link" };

export interface FakeMeshInit {
  now?: () => Date;
  /** How long a probe or a join takes, in ms. */
  latencyMs?: number;
}

export class FakeMesh {
  private state: MeshState;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => Date;
  private readonly latencyMs: number;
  private nextId = 1;

  constructor(init: FakeMeshInit = {}) {
    this.now = init.now ?? (() => new Date());
    this.latencyMs = init.latencyMs ?? 10;
    this.state = {
      sharer: {
        name: "Dirk",
        serverOn: true,
        services: [],
        guests: [],
        inviteOpen: false,
        bridge: "ok",
      },
      guest: { name: "Claudia", peerId: "12D3KooWClaudia", stage: "no-link", revoked: false },
    };
  }

  get snapshot(): MeshState {
    return this.state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** What Claudia's link to Dirk looks like. */
  get guestLink(): LinkState {
    return this.state.sharer.serverOn ? "connected" : "offline";
  }

  /** The Sharer's Services as the Guest sees them: on ones, and off ones as paused. */
  get guestServices(): ViewerService[] {
    return [...this.state.sharer.services]
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
      .map((s) => ({ id: s.id, name: s.name, paused: !s.enabled }));
  }

  call(command: Command): void {
    const { sharer, guest } = this.state;
    switch (command.id) {
      case "peershare:set-name":
        this.setSharer({ name: command.name });
        break;
      case "peershare:add-service": {
        const id = `svc-${this.nextId++}`;
        const services = sharer.services.map((s) =>
          command.draft.isDefault ? { ...s, isDefault: false } : s,
        );
        const isDefault = command.draft.isDefault || services.length === 0;
        this.setSharer({
          services: [
            ...services,
            {
              id,
              name: command.draft.name,
              kind: command.kind,
              target: command.draft.target,
              enabled: true,
              isDefault,
              health: "checking",
              warnings: [],
            },
          ],
        });
        this.probe(id);
        break;
      }
      case "peershare:edit-service":
        this.updateService(command.serviceId, {
          name: command.draft.name,
          target: command.draft.target,
          kind: command.kind,
        });
        this.probe(command.serviceId);
        break;
      case "peershare:toggle-service": {
        const service = sharer.services.find((s) => s.id === command.serviceId);
        if (service == null) break;
        if (service.enabled) {
          this.updateService(service.id, { enabled: false, health: "disabled" });
          break;
        }
        this.updateService(service.id, { enabled: true });
        this.probe(service.id);
        break;
      }
      case "peershare:probe":
        this.probe(command.serviceId);
        break;
      case "peershare:invite":
        this.setSharer({
          inviteOpen: true,
          invite: {
            url: `https://tools.sandclaw.ai/invite#k=${randomKey()}`,
            expiresAt: new Date(this.now().getTime() + INVITE_TTL_MS),
            used: false,
          },
        });
        break;
      case "peershare:close-invite":
        this.setSharer({ inviteOpen: false });
        break;
      case "peershare:revoke-guest": {
        this.setSharer({ guests: sharer.guests.filter((g) => g.peerId !== command.peerId) });
        if (command.peerId === guest.peerId && guest.stage === "viewing") {
          this.setGuest({ revoked: true });
        }
        break;
      }
      case "peershare:start":
        this.setSharer({ serverOn: true });
        break;
      case "peershare:stop":
        this.setSharer({ serverOn: false });
        break;
      case "scenario:deliver-link":
        if (sharer.invite == null) break;
        this.setGuest({ link: sharer.invite.url, stage: "invite", revoked: false });
        break;
      case "peershare:join":
        this.join();
        break;
      case "peershare:decline":
        this.setGuest({ stage: "declined" });
        break;
      case "peershare:open":
        this.setGuest({ selected: command.serviceId });
        break;
      case "peershare:close-session":
        // Leave and forget: Dirk's list loses Claudia, her browser loses the link.
        this.setSharer({ guests: sharer.guests.filter((g) => g.peerId !== guest.peerId) });
        this.setGuest({ stage: "no-link", selected: undefined });
        break;
    }
  }

  private join(): void {
    this.setGuest({ stage: "joining" });
    setTimeout(() => {
      const { sharer, guest } = this.state;
      const invite = sharer.invite;
      if (!sharer.serverOn) {
        this.setGuest({ stage: "machine-offline" });
        return;
      }
      if (invite == null || invite.url !== guest.link || invite.used) {
        this.setGuest({ stage: "invite-used" });
        return;
      }
      if (invite.expiresAt.getTime() <= this.now().getTime()) {
        this.setGuest({ stage: "invite-expired" });
        return;
      }
      this.setSharer({
        invite: { ...invite, used: true },
        guests: [
          ...sharer.guests,
          { peerId: guest.peerId, name: guest.name, joinedAt: this.now(), online: true },
        ],
      });
      this.setGuest({ stage: "viewing", selected: this.guestServices[0]?.id });
    }, this.latencyMs);
  }

  /** A pretend probe: every Service answers, Bridged ones only while the Bridge is ok. */
  private probe(serviceId: string): void {
    const service = this.state.sharer.services.find((s) => s.id === serviceId);
    if (service == null || !service.enabled) return;
    this.updateService(serviceId, { health: "checking" });
    setTimeout(() => {
      const reachable = service.kind === "direct" || this.state.sharer.bridge === "ok";
      this.updateService(serviceId, { health: reachable ? "ok" : "down" });
    }, this.latencyMs);
  }

  private updateService(id: string, change: Partial<Service>): void {
    this.setSharer({
      services: this.state.sharer.services.map((s) => (s.id === id ? { ...s, ...change } : s)),
    });
  }

  private setSharer(change: Partial<SharerState>): void {
    this.state = { ...this.state, sharer: { ...this.state.sharer, ...change } };
    this.emit();
  }

  private setGuest(change: Partial<GuestState>): void {
    this.state = { ...this.state, guest: { ...this.state.guest, ...change } };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function randomKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
