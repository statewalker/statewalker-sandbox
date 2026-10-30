/**
 * The Guest: a member of the Sharer's mesh that serves nothing of its own.
 * Join redeems the Invite once; after that the saved identity resumes the
 * membership (rung 10); Close session forgets it.
 */

import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { createMounts } from "@statewalker/httpeers-core";
import { type MemberHandle, startMember } from "@statewalker/httpeers-member";
import {
  type CatalogEntry,
  decodeInvite,
  isSharerOffline,
  joinOutcome,
} from "@statewalker/httpeers-share";
import type { GuestState } from "../public/commands.js";
import type { GuestIdentity, MeshInit } from "../public/mesh.js";
import { PEERSHARE_RULES } from "./rules.js";

export class GuestManager {
  private member: MemberHandle | undefined;
  private current: GuestState = { stage: "no-link" };

  constructor(private readonly mesh: MeshInit) {}

  state(): GuestState {
    return { ...this.current };
  }

  async join(link: string): Promise<GuestState> {
    const invite = decodeInvite(link);
    const privateKey = await generateKeyPair("Ed25519");
    const identity: GuestIdentity = {
      privateKey,
      sharerPeerId: invite.sharerPeerId,
      sharerName: invite.sharerName,
      relayAddrs: invite.relayAddrs,
    };
    return this.enter(identity, invite.invitationId);
  }

  /** Back in with the saved identity, without an Invite. */
  async resume(): Promise<GuestState> {
    const identity = await this.mesh.guestStore.load();
    if (identity == null) return this.state();
    return this.enter(identity);
  }

  async catalog(): Promise<CatalogEntry[]> {
    const res = await this.fetch("/s/");
    return res.ok ? res.json() : [];
  }

  /** The Viewer's route to a Service: `/peers/<sharer>/s/<id><path>` through the member's JS fetch. */
  async fetchService(serviceId: string, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body =
      request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    return this.fetch(`/s/${serviceId}${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body,
    });
  }

  async closeSession(): Promise<GuestState> {
    await this.leave();
    await this.mesh.guestStore.clear();
    this.current = { stage: "no-link" };
    return this.state();
  }

  async leave(): Promise<void> {
    const member = this.member;
    this.member = undefined;
    await member?.stop().catch(() => {});
  }

  private async enter(identity: GuestIdentity, invitationId?: string): Promise<GuestState> {
    await this.leave();
    try {
      this.member = await this.start(identity.privateKey, identity, invitationId);
    } catch (error) {
      const stage = joinOutcome(error);
      // A refused Invite leaves the Guest where it was; an offline Sharer
      // keeps the identity, so the Guest can come back (rung 10).
      return { stage, sharerName: identity.sharerName, sharerPeerId: identity.sharerPeerId };
    }
    await this.mesh.guestStore.save(identity);
    this.current = {
      stage: "joined",
      sharerName: identity.sharerName,
      sharerPeerId: identity.sharerPeerId,
    };
    return this.state();
  }

  private start(privateKey: Ed25519PrivateKey, identity: GuestIdentity, invitationId?: string) {
    return startMember({
      key: "peers",
      mounts: createMounts(),
      rules: PEERSHARE_RULES,
      config: { relayAddrs: identity.relayAddrs, hubPeerId: identity.sharerPeerId },
      platform: this.mesh.platform.member,
      privateKey,
      ...(invitationId != null ? { invitationId } : {}),
    });
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const member = this.member;
    const sharer = this.current.sharerPeerId;
    if (member == null || sharer == null) {
      return new Response("not joined", { status: 409 });
    }
    const res = await member.fetch(new Request(`http://local/peers/${sharer}${path}`, init));
    if (await isSharerOffline(res)) this.current = { ...this.current, stage: "machine-offline" };
    else if (this.current.stage === "machine-offline")
      this.current = { ...this.current, stage: "joined" };
    return res;
  }
}
