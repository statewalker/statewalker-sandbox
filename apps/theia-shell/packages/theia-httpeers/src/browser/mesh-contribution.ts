import {
  createHubAdminClient,
  hubAdminBase,
  INVITE_EXPIRIES,
  INVITE_ROLES,
  LEAVE_CONFIRMATION,
} from "@statewalker/httpeers-join";
import { ClipboardService } from "@theia/core/lib/browser/clipboard-service";
import { CommonMenus } from "@theia/core/lib/browser/common-menus";
import { ConfirmDialog } from "@theia/core/lib/browser/dialogs";
import type { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { QuickInputService } from "@theia/core/lib/browser/quick-input";
import { AbstractViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { StatusBar, StatusBarAlignment } from "@theia/core/lib/browser/status-bar/status-bar";
import type { Command, CommandRegistry } from "@theia/core/lib/common/command";
import type { MenuModelRegistry } from "@theia/core/lib/common/menu";
import { MessageService } from "@theia/core/lib/common/message-service";
import { inject, injectable } from "@theia/core/shared/inversify";
import { statusBarText } from "../common/mesh-model";
import { MeshService } from "./mesh-service";
import { MeshWidget } from "./mesh-widget";

export namespace MeshCommands {
  const category = "Mesh";
  export const JOIN: Command = { id: "httpeers.mesh.join", category, label: "Join a Mesh…" };
  export const INVITE: Command = {
    id: "httpeers.mesh.invite",
    category,
    label: "Invite to the Mesh…",
  };
  export const DISCONNECT: Command = {
    id: "httpeers.mesh.disconnect",
    category,
    label: "Disconnect",
  };
  export const RECONNECT: Command = { id: "httpeers.mesh.reconnect", category, label: "Reconnect" };
  export const LEAVE: Command = {
    id: "httpeers.mesh.leave",
    category,
    label: "Leave the Mesh (Reset Identity)…",
  };
  export const COPY_PEER_ID: Command = {
    id: "httpeers.mesh.copyPeerId",
    category,
    label: "Copy This Browser's Peer Id",
  };
}

const STATUS_ID = "httpeers-mesh-status";

/** The Mesh view in the left side bar, its commands and menus, and the status-bar item. */
@injectable()
export class MeshContributionImpl
  extends AbstractViewContribution<MeshWidget>
  implements FrontendApplicationContribution
{
  @inject(MeshService) protected readonly mesh!: MeshService;
  @inject(StatusBar) protected readonly statusBar!: StatusBar;
  @inject(QuickInputService) protected readonly quickInput!: QuickInputService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(ClipboardService) protected readonly clipboard!: ClipboardService;

  constructor() {
    super({
      widgetId: MeshWidget.ID,
      widgetName: MeshWidget.LABEL,
      defaultWidgetOptions: { area: "left", rank: 400 },
      toggleCommandId: "httpeers.mesh.toggleView",
    });
  }

  onStart(): void {
    this.mesh.onDidChange(() => this.updateStatus());
    this.updateStatus();
    // Started with the app, not with the view: a `?join=` link must work on first load.
    this.mesh.start().catch((error: unknown) => {
      this.messages.error(`Mesh: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async initializeLayout(): Promise<void> {
    await this.openView({ activate: false });
  }

  protected updateStatus(): void {
    const state = this.mesh.state;
    void this.statusBar.setElement(STATUS_ID, {
      text: `$(broadcast) ${statusBarText(state)}`,
      tooltip:
        state?.identity == null
          ? "httpeers mesh"
          : `httpeers mesh — this browser is ${state.identity}`,
      alignment: StatusBarAlignment.LEFT,
      priority: 50,
      command: "httpeers.mesh.toggleView",
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    const controls = () => this.mesh.state?.controls;
    commands.registerCommand(MeshCommands.JOIN, {
      execute: () => this.joinFromInput(),
      isEnabled: () => controls()?.join ?? false,
    });
    commands.registerCommand(MeshCommands.INVITE, {
      execute: () => this.invite(),
      isEnabled: () => this.mesh.handle != null,
    });
    commands.registerCommand(MeshCommands.DISCONNECT, {
      execute: () => this.mesh.peerSession?.disconnect(),
      isEnabled: () => controls()?.disconnect ?? false,
    });
    commands.registerCommand(MeshCommands.RECONNECT, {
      execute: () => this.mesh.peerSession?.reconnect(),
      isEnabled: () => controls()?.reconnect ?? false,
    });
    commands.registerCommand(MeshCommands.LEAVE, {
      execute: () => this.leave(),
      isEnabled: () => controls()?.reset ?? false,
    });
    commands.registerCommand(MeshCommands.COPY_PEER_ID, {
      execute: () => this.clipboard.writeText(this.mesh.state?.identity ?? ""),
      isEnabled: () => this.mesh.state?.identity != null,
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    const mesh = [...CommonMenus.FILE, "4_httpeers"];
    menus.registerSubmenu(mesh, "Mesh");
    menus.registerMenuAction(mesh, { commandId: MeshCommands.JOIN.id, order: "a" });
    menus.registerMenuAction(mesh, { commandId: MeshCommands.INVITE.id, order: "b" });
    menus.registerMenuAction(mesh, { commandId: MeshCommands.DISCONNECT.id, order: "c" });
    menus.registerMenuAction(mesh, { commandId: MeshCommands.RECONNECT.id, order: "d" });
    menus.registerMenuAction(mesh, { commandId: MeshCommands.LEAVE.id, order: "e" });
  }

  protected async joinFromInput(): Promise<void> {
    const text = await this.quickInput.input({
      title: "Join a mesh",
      prompt: "Paste an invitation link or blob",
      ignoreFocusLost: true,
    });
    if (text == null || text.trim() === "") return;
    await this.mesh.peerSession?.join(text.trim());
  }

  protected async leave(): Promise<void> {
    const ok = await new ConfirmDialog({
      title: "Leave the mesh",
      msg: LEAVE_CONFIRMATION,
      ok: "Leave",
    }).open();
    if (ok === true) await this.mesh.peerSession?.resetIdentity();
  }

  /**
   * Mint an invitation through the hub's admin API (`<hub>/hub/api/`), the same
   * call the join widget's Invite panel makes. The hub decides: a member that
   * is not an admin, or a hub without the admin API, is refused.
   */
  protected async invite(): Promise<void> {
    const handle = this.mesh.handle;
    const base = hubAdminBase(handle);
    if (handle == null || base == null) return;
    const role = await this.quickInput.pick(
      INVITE_ROLES.map((id) => ({
        id,
        label: id,
        description: id === "admin" ? "can invite others" : "",
      })),
      { title: "Invite as" },
    );
    if (role == null) return;
    const expiry = await this.quickInput.pick(
      INVITE_EXPIRIES.map((e) => ({ id: e.id, label: e.label, ttlMs: e.ttlMs })),
      { title: "The invitation expires in" },
    );
    if (expiry == null) return;
    try {
      const created = await createHubAdminClient(fetch.bind(globalThis), base).create(
        role.id as (typeof INVITE_ROLES)[number],
        expiry.ttlMs,
      );
      await this.clipboard.writeText(created.link);
      this.messages.info(`Invitation (${role.id}) copied to the clipboard: ${created.link}`);
    } catch (error) {
      this.messages.error(
        `Mesh: could not create an invitation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
