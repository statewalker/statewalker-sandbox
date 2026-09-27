import { ClipboardService } from "@theia/core/lib/browser/clipboard-service";
import { QuickInputService } from "@theia/core/lib/browser/quick-input";
import { AbstractViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import type { Command, CommandRegistry } from "@theia/core/lib/common/command";
import { MessageService } from "@theia/core/lib/common/message-service";
import { inject, injectable } from "@theia/core/shared/inversify";
import { keyShareText, mintKey } from "../common/mesh/discover";
import { ChatService } from "./chat-service";
import { ChatWidget } from "./chat-widget";

export namespace ChatCommands {
  const category = "LLM Chat";
  export const NEW_CHAT: Command = { id: "llm-chat.new", category, label: "New Chat" };
  export const USE_MESH: Command = {
    id: "llm-chat.useMesh",
    category,
    label: "Use the Mesh's LLM",
  };
  export const USE_CUSTOM: Command = {
    id: "llm-chat.useCustom",
    category,
    label: "Use a Custom Endpoint…",
  };
  export const MEMBER_KEY: Command = {
    id: "llm-chat.memberKey",
    category,
    label: "Create a Key for a Member…",
  };
}

/** *View → LLM Chat*, and the chat's commands. */
@injectable()
export class ChatContribution extends AbstractViewContribution<ChatWidget> {
  @inject(ChatService) protected readonly chat!: ChatService;
  @inject(QuickInputService) protected readonly quickInput!: QuickInputService;
  @inject(ClipboardService) protected readonly clipboard!: ClipboardService;
  @inject(MessageService) protected readonly messages!: MessageService;

  constructor() {
    super({
      widgetId: ChatWidget.ID,
      widgetName: ChatWidget.LABEL,
      defaultWidgetOptions: { area: "main" },
      toggleCommandId: "llm-chat.toggleView",
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(ChatCommands.NEW_CHAT, {
      execute: async () => {
        await this.openView({ activate: true });
        await this.chat.newChat();
      },
    });
    commands.registerCommand(ChatCommands.USE_MESH, {
      execute: async () => {
        await this.openView({ activate: true });
        await this.chat.setSource("mesh");
      },
    });
    commands.registerCommand(ChatCommands.USE_CUSTOM, {
      execute: async () => {
        await this.openView({ activate: true });
        await this.chat.setSource("custom");
        this.chat.setup.reconfigure();
      },
    });
    commands.registerCommand(ChatCommands.MEMBER_KEY, {
      execute: () => this.memberKey(),
      isEnabled: () => {
        const { source, stage } = this.chat.setup.state();
        return source === "mesh" && stage.kind === "ready" && stage.admin && stage.canRequest;
      },
    });
  }

  /**
   * An admin mints a key for someone else (llm-chat's "Key for a member"): the
   * key is copied with a note on where to paste it. It is shown once, never stored.
   */
  protected async memberKey(): Promise<void> {
    const stage = this.chat.setup.state().stage;
    const serviceBase = stage.kind === "ready" ? stage.config.baseUrl.replace(/v1$/, "") : null;
    if (serviceBase == null) return;
    const name = await this.quickInput.input({
      title: "Key for a member",
      prompt: "Who is it for? (a label for the key)",
    });
    if (name == null) return;
    try {
      const key = await mintKey(
        (i, init) => globalThis.fetch(i, init),
        serviceBase,
        new Date(),
        name,
      );
      await this.clipboard.writeText(keyShareText(key, location.href));
      this.messages.info(
        "A key for the member was copied to the clipboard, with where to paste it.",
      );
    } catch (error) {
      this.messages.error(error instanceof Error ? error.message : String(error));
    }
  }
}
