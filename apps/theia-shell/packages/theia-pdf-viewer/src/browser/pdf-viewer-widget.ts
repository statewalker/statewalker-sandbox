import EmbedPDF from "@embedpdf/snippet";
import pdfiumWasm from "@embedpdf/snippet/dist/pdfium.wasm";
import type {
  Navigatable,
  NavigatableWidgetOptions,
} from "@theia/core/lib/browser/navigatable-types";
import { ThemeService } from "@theia/core/lib/browser/theming";
import { BaseWidget, type Message } from "@theia/core/lib/browser/widgets/widget";
import { Disposable } from "@theia/core/lib/common/disposable";
import URI from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileService } from "@theia/filesystem/lib/browser/file-service";

export const PdfViewerOptions = Symbol("PdfViewerOptions");
/** Navigatable options, so Theia can re-open the viewer when its file is moved or renamed. */
export type PdfViewerOptions = NavigatableWidgetOptions;

type EmbedPdfElement = ReturnType<typeof EmbedPDF.init>;

/**
 * Shows a PDF with EmbedPDF: PDFium compiled to WebAssembly, in a Web Worker,
 * with EmbedPDF's own toolbar (pages, zoom, search, thumbnails, print).
 *
 * The bytes come from Theia's FileService — i.e. the FilesApi — and reach the
 * viewer as a blob: URL. PDFium's wasm is embedded in the bundle (Theia's
 * esbuild loads `.wasm` as a data: URL), and EmbedPDF's CDN fonts, Google
 * Fonts and stamp library are switched off, so the viewer makes no request outside the app.
 * Reloads when the file changes, and says so when it can no longer be read.
 */
@injectable()
export class PdfViewerWidget extends BaseWidget implements Navigatable {
  static readonly FACTORY_ID = "pdf-viewer";

  @inject(PdfViewerOptions) protected readonly options!: PdfViewerOptions;
  @inject(FileService) protected readonly files!: FileService;
  @inject(ThemeService) protected readonly themes!: ThemeService;

  protected viewer: EmbedPdfElement | undefined;
  /** The current viewer's container and blob: URL; removing the container destroys the engine. */
  protected shown: Disposable | undefined;
  /** Bumped by every load, so a slower, older read never overwrites a newer one. */
  protected loads = 0;

  get uri(): URI {
    return new URI(this.options.uri);
  }

  // Navigatable: Open Editors lists the viewer, the explorer reveals its file,
  // and a move or rename re-opens it at the new URI.
  getResourceUri(): URI {
    return this.uri;
  }

  createMoveToUri(resourceUri: URI): URI {
    return this.uri.withPath(resourceUri.path);
  }

  async initialize(): Promise<void> {
    const uri = this.uri;
    this.id = `${PdfViewerWidget.FACTORY_ID}:${this.options.uri}`;
    this.title.label = uri.path.base;
    this.title.caption = uri.path.toString();
    this.title.iconClass = "codicon codicon-file-pdf";
    this.title.closable = true;
    this.node.classList.add("pdf-viewer-widget", "flex", "overflow-hidden");
    this.node.tabIndex = 0;

    this.toDispose.push(Disposable.create(() => this.clear()));
    this.toDispose.push(
      this.themes.onDidColorThemeChange(() => this.viewer?.setTheme(this.themePreference())),
    );
    this.toDispose.push(
      this.files.onDidFilesChange((event) => {
        if (event.contains(uri)) void this.load();
      }),
    );
    await this.load();
  }

  protected async load(): Promise<void> {
    const ticket = ++this.loads;
    let bytes: Uint8Array;
    try {
      bytes = (await this.files.readFile(this.uri)).value.buffer;
    } catch {
      if (ticket !== this.loads || this.isDisposed) return;
      this.clear();
      const message = document.createElement("div");
      message.className = "pdf-viewer-message text-muted-foreground m-auto text-sm";
      message.textContent = `${this.uri.path.base} cannot be read (deleted or moved?)`;
      this.node.appendChild(message);
      this.shown = Disposable.create(() => message.remove());
      return;
    }
    if (ticket !== this.loads || this.isDisposed) return;
    this.clear();

    const src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
    const target = document.createElement("div");
    target.className = "pdf-viewer h-full min-w-0 flex-1";
    this.node.appendChild(target);
    this.viewer = EmbedPDF.init({
      type: "container",
      target,
      src,
      wasmUrl: pdfiumWasm,
      fontFallback: null,
      fonts: { ui: null, signature: null },
      // The stamp plugin's default manifest lives on jsDelivr.
      stamp: { manifests: [] },
      // A viewer: editing features stay off until saving back is designed.
      disabledCategories: ["annotation", "redaction"],
      theme: { preference: this.themePreference() },
    });
    this.shown = Disposable.create(() => {
      target.remove();
      URL.revokeObjectURL(src);
    });
  }

  protected clear(): void {
    this.shown?.dispose();
    this.shown = undefined;
    this.viewer = undefined;
  }

  protected themePreference(): "light" | "dark" {
    const type = this.themes.getCurrentTheme().type;
    return type === "dark" || type === "hc" ? "dark" : "light";
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.node.focus();
  }
}
