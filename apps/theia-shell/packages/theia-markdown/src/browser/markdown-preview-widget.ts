import { BaseWidget, type Message } from "@theia/core/lib/browser/widgets/widget";
import { DisposableCollection } from "@theia/core/lib/common/disposable";
import URI from "@theia/core/lib/common/uri";
import DOMPurify from "@theia/core/shared/dompurify";
import { inject, injectable } from "@theia/core/shared/inversify";
import { MonacoTextModelService } from "@theia/monaco/lib/browser/monaco-text-model-service";
import { renderMarkdown } from "../common/markdown-render";

export const MarkdownPreviewOptions = Symbol("MarkdownPreviewOptions");
export interface MarkdownPreviewOptions {
  uri: string;
}

/** Tailwind Typography, coloured by the shadcn tokens. */
const PREVIEW_CLASSES = [
  "markdown-preview prose prose-sm prose-shadcn mx-auto max-w-[860px] px-6 pt-4 pb-12",
  "prose-code:bg-muted prose-code:rounded-sm prose-code:px-1 prose-code:py-0.5 prose-code:font-normal",
  "prose-code:before:content-none prose-code:after:content-none",
  "prose-pre:border prose-pre:border-border",
].join(" ");

/**
 * Renders a Markdown document. It reads the shared text model — the same one
 * the editor edits — so unsaved changes show up live, and a preview opened
 * from the explorer (with no editor) loads the file through the FilesApi.
 */
@injectable()
export class MarkdownPreviewWidget extends BaseWidget {
  static readonly FACTORY_ID = "markdown-preview";

  @inject(MarkdownPreviewOptions) protected readonly options!: MarkdownPreviewOptions;
  @inject(MonacoTextModelService) protected readonly models!: MonacoTextModelService;

  protected readonly content = document.createElement("div");
  protected readonly toDisposeOnClose = new DisposableCollection();
  protected renderScheduled = false;

  static idFor(uri: string): string {
    return `${MarkdownPreviewWidget.FACTORY_ID}:${uri}`;
  }

  async initialize(): Promise<void> {
    const uri = new URI(this.options.uri);
    this.id = MarkdownPreviewWidget.idFor(this.options.uri);
    this.title.label = `Preview ${uri.path.base}`;
    this.title.caption = `Preview of ${uri.path.toString()}`;
    this.title.iconClass = "codicon codicon-open-preview";
    this.title.closable = true;
    this.node.classList.add("markdown-preview-widget", "overflow-auto", "bg-background");
    this.content.className = PREVIEW_CLASSES;
    this.node.appendChild(this.content);
    this.node.tabIndex = 0;

    const reference = await this.models.createModelReference(uri);
    this.toDispose.push(reference);
    const model = reference.object.textEditorModel;
    this.toDispose.push(
      model.onDidChangeContent(() => this.scheduleRender(() => model.getValue())),
    );
    this.renderNow(model.getValue());
  }

  protected scheduleRender(text: () => string): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.renderNow(text());
    });
  }

  protected renderNow(text: string): void {
    // markdown-it already escapes raw HTML; DOMPurify is the second fence.
    this.content.innerHTML = DOMPurify.sanitize(renderMarkdown(text));
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.node.focus();
  }
}
