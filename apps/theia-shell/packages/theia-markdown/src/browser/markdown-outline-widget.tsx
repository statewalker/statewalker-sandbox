import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { DisposableCollection } from "@theia/core/lib/common/disposable";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import { EditorManager } from "@theia/editor/lib/browser/editor-manager";
import type { EditorWidget } from "@theia/editor/lib/browser/editor-widget";
import { isMarkdownPath } from "../common/markdown-edits";
import { type OutlineItem, parseOutline } from "../common/markdown-outline";

/** The headings of the active Markdown editor; clicking one reveals it. */
@injectable()
export class MarkdownOutlineWidget extends ReactWidget {
  static readonly ID = "markdown-outline";
  static readonly LABEL = "Markdown Outline";

  @inject(EditorManager) protected readonly editors!: EditorManager;

  protected editor: EditorWidget | undefined;
  protected items: OutlineItem[] = [];
  protected readonly toDisposeOnEditor = new DisposableCollection();

  @postConstruct()
  protected init(): void {
    this.id = MarkdownOutlineWidget.ID;
    this.title.label = MarkdownOutlineWidget.LABEL;
    this.title.caption = MarkdownOutlineWidget.LABEL;
    this.title.iconClass = "codicon codicon-list-tree";
    this.title.closable = true;
    this.addClass("markdown-outline-widget");
    this.toDispose.push(this.toDisposeOnEditor);
    this.toDispose.push(this.editors.onCurrentEditorChanged((e) => this.track(e)));
    this.track(this.editors.currentEditor);
  }

  protected track(widget: EditorWidget | undefined): void {
    if (widget && !isMarkdownPath(widget.editor.uri.path.toString())) return;
    this.toDisposeOnEditor.dispose();
    this.editor = widget;
    if (widget) {
      const refresh = () => {
        this.items = parseOutline(widget.editor.document.getText());
        this.update();
      };
      this.toDisposeOnEditor.push(widget.editor.onDocumentContentChanged(refresh));
      this.toDisposeOnEditor.push(widget.onDidDispose(() => this.track(undefined)));
      refresh();
    } else {
      this.items = [];
      this.update();
    }
  }

  protected reveal(item: OutlineItem): void {
    const editor = this.editor?.editor;
    if (!editor) return;
    const position = { line: item.line, character: 0 };
    editor.cursor = position;
    editor.revealPosition(position, { vertical: "center" });
    editor.focus();
  }

  protected render(): React.ReactNode {
    if (!this.editor) {
      return (
        <div className="markdown-outline theia-widget-noInfo">No Markdown editor is active.</div>
      );
    }
    if (this.items.length === 0) {
      return <div className="markdown-outline theia-widget-noInfo">No headings.</div>;
    }
    return (
      <ul className="markdown-outline">
        {this.items.map((item) => (
          <li
            key={`${item.line}:${item.text}`}
            className={`markdown-outline-item level-${item.level}`}
            style={{ paddingLeft: `${(item.level - 1) * 12 + 8}px` }}
            title={`Line ${item.line + 1}`}
            onClick={() => this.reveal(item)}
            onKeyDown={(e) => e.key === "Enter" && this.reveal(item)}
          >
            {item.text}
          </li>
        ))}
      </ul>
    );
  }
}
