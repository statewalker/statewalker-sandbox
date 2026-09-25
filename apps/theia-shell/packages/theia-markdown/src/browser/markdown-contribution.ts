import { CommonMenus } from "@theia/core/lib/browser/common-menus";
import type { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import type { KeybindingRegistry } from "@theia/core/lib/browser/keybinding";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { AbstractViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import type { CommandRegistry } from "@theia/core/lib/common/command";
import type { MenuModelRegistry } from "@theia/core/lib/common/menu";
import { SelectionService } from "@theia/core/lib/common/selection-service";
import type URI from "@theia/core/lib/common/uri";
import { UriAwareCommandHandler } from "@theia/core/lib/common/uri-command-handler";
import { inject, injectable } from "@theia/core/shared/inversify";
import { EditorManager } from "@theia/editor/lib/browser/editor-manager";
import { EDITOR_CONTEXT_MENU } from "@theia/editor/lib/browser/editor-menu";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import { MonacoEditor } from "@theia/monaco/lib/browser/monaco-editor";
import * as monaco from "@theia/monaco-editor-core";
import { NavigatorContextMenu } from "@theia/navigator/lib/browser/navigator-contribution";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";
import {
  isMarkdownPath,
  nextUntitledName,
  toggleHeading,
  toggleWrap,
} from "../common/markdown-edits";
import { MarkdownCommands } from "./markdown-commands";
import { registerMarkdownLanguage } from "./markdown-language";
import { MarkdownOutlineWidget } from "./markdown-outline-widget";
import { MarkdownPreviewWidget } from "./markdown-preview-widget";

export const MARKDOWN_EDITOR_MENU = [...EDITOR_CONTEXT_MENU, "z_markdown"];
const NEW_FILE_CONTENT = "# Untitled\n\n";

/**
 * The Markdown extension: commands, menus, keybindings, the preview and the
 * outline view. Loading and saving is Theia's own editor flow, which goes
 * through the FilesApi provider — nothing here touches storage except
 * *New Markdown File*, which creates the file through Theia's FileService.
 */
@injectable()
export class MarkdownContribution
  extends AbstractViewContribution<MarkdownOutlineWidget>
  implements FrontendApplicationContribution
{
  @inject(EditorManager) protected readonly editors!: EditorManager;
  @inject(FileService) protected readonly files!: FileService;
  @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
  @inject(SelectionService) protected readonly selection!: SelectionService;
  @inject(WidgetManager) protected readonly widgets!: WidgetManager;
  @inject(ApplicationShell) protected readonly appShell!: ApplicationShell;

  constructor() {
    super({
      widgetId: MarkdownOutlineWidget.ID,
      widgetName: MarkdownOutlineWidget.LABEL,
      defaultWidgetOptions: { area: "right", rank: 100 },
      toggleCommandId: "markdown.toggleOutline",
    });
  }

  onStart(): void {
    registerMarkdownLanguage();
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);

    commands.registerCommand(MarkdownCommands.NEW_FILE, {
      execute: () => this.newFile(),
    });

    // From the explorer the URI is the selected file; from the palette or a
    // keybinding it is the active editor's.
    const previewFromSelection = UriAwareCommandHandler.MonoSelect(this.selection, {
      execute: (uri) => this.openPreview(uri),
      isEnabled: (uri) => isMarkdownPath(uri.path.toString()),
      isVisible: (uri) => isMarkdownPath(uri.path.toString()),
    });
    commands.registerCommand(MarkdownCommands.OPEN_PREVIEW, {
      execute: (...args: unknown[]) => {
        const editor = this.currentMarkdownEditor();
        if (args.length === 0 && editor) return this.openPreview(editor.editor.uri);
        return previewFromSelection.execute(...args);
      },
      isEnabled: (...args: unknown[]) =>
        !!this.currentMarkdownEditor() || !!previewFromSelection.isEnabled?.(...args),
      isVisible: (...args: unknown[]) =>
        !!this.currentMarkdownEditor() || !!previewFromSelection.isVisible?.(...args),
    });

    commands.registerCommand(MarkdownCommands.SHOW_OUTLINE, {
      execute: () => this.openView({ reveal: true, activate: false }),
    });

    const inMarkdownEditor = {
      isEnabled: () => !!this.currentMarkdownEditor(),
      isVisible: () => !!this.currentMarkdownEditor(),
    };
    commands.registerCommand(MarkdownCommands.TOGGLE_BOLD, {
      ...inMarkdownEditor,
      execute: () => this.wrapSelection("**"),
    });
    commands.registerCommand(MarkdownCommands.TOGGLE_ITALIC, {
      ...inMarkdownEditor,
      execute: () => this.wrapSelection("_"),
    });
    commands.registerCommand(MarkdownCommands.TOGGLE_HEADING, {
      ...inMarkdownEditor,
      execute: () => this.cycleHeading(),
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    menus.registerMenuAction(CommonMenus.FILE_NEW_TEXT, {
      commandId: MarkdownCommands.NEW_FILE.id,
      label: "New Markdown File",
      order: "b",
    });
    menus.registerMenuAction(NavigatorContextMenu.NAVIGATION, {
      commandId: MarkdownCommands.OPEN_PREVIEW.id,
      label: "Open Markdown Preview",
      order: "z",
    });
    menus.registerSubmenu(MARKDOWN_EDITOR_MENU, "Markdown");
    const items = [
      MarkdownCommands.TOGGLE_BOLD,
      MarkdownCommands.TOGGLE_ITALIC,
      MarkdownCommands.TOGGLE_HEADING,
      MarkdownCommands.OPEN_PREVIEW,
    ];
    items.forEach((command, i) => {
      menus.registerMenuAction(MARKDOWN_EDITOR_MENU, {
        commandId: command.id,
        label: command.label,
        order: String(i),
      });
    });
  }

  override registerKeybindings(keybindings: KeybindingRegistry): void {
    super.registerKeybindings(keybindings);
    const bindings: [string, string][] = [
      [MarkdownCommands.OPEN_PREVIEW.id, "ctrlcmd+shift+v"],
      [MarkdownCommands.TOGGLE_BOLD.id, "ctrlcmd+alt+b"],
      [MarkdownCommands.TOGGLE_ITALIC.id, "ctrlcmd+alt+i"],
      [MarkdownCommands.TOGGLE_HEADING.id, "ctrlcmd+alt+h"],
    ];
    for (const [command, keybinding] of bindings) {
      keybindings.registerKeybinding({ command, keybinding, when: "editorTextFocus" });
    }
  }

  protected currentMarkdownEditor() {
    const widget = this.editors.currentEditor;
    return widget && isMarkdownPath(widget.editor.uri.path.toString()) ? widget : undefined;
  }

  async openPreview(uri: URI): Promise<MarkdownPreviewWidget> {
    const widget = await this.widgets.getOrCreateWidget<MarkdownPreviewWidget>(
      MarkdownPreviewWidget.FACTORY_ID,
      { uri: uri.toString() },
    );
    if (!widget.isAttached) {
      const ref = this.editors.all.find((e) => e.editor.uri.toString() === uri.toString());
      await this.appShell.addWidget(widget, { area: "main", mode: "split-right", ref });
    }
    await this.appShell.revealWidget(widget.id);
    return widget;
  }

  async newFile(): Promise<URI | undefined> {
    const root = (await this.workspace.roots)[0]?.resource;
    if (!root) return undefined;
    const folder = await this.files.resolve(root);
    const name = nextUntitledName((folder.children ?? []).map((c) => c.name));
    const uri = root.resolve(name);
    await this.files.create(uri, NEW_FILE_CONTENT);
    await this.editors.open(uri, { mode: "activate" });
    return uri;
  }

  protected codeEditor(): monaco.editor.ICodeEditor | undefined {
    const widget = this.currentMarkdownEditor();
    return widget ? MonacoEditor.get(widget)?.getControl() : undefined;
  }

  protected wrapSelection(marker: string): void {
    const control = this.codeEditor();
    const model = control?.getModel();
    const selection = control?.getSelection();
    if (!control || !model || !selection) return;
    const text = toggleWrap(model.getValueInRange(selection), marker);
    control.executeEdits("markdown", [{ range: selection, text, forceMoveMarkers: true }]);
    control.focus();
  }

  protected cycleHeading(): void {
    const control = this.codeEditor();
    const model = control?.getModel();
    const position = control?.getPosition();
    if (!control || !model || !position) return;
    const line = position.lineNumber;
    const range = new monaco.Range(line, 1, line, model.getLineMaxColumn(line));
    control.executeEdits("markdown", [{ range, text: toggleHeading(model.getLineContent(line)) }]);
    control.focus();
  }
}
