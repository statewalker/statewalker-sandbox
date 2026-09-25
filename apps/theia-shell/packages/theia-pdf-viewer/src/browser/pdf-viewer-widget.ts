import EmbedPDF from "@embedpdf/snippet";
import pdfiumWasm from "@embedpdf/snippet/dist/pdfium.wasm";
import { ThemeService } from "@theia/core/lib/browser/theming";
import { BaseWidget, type Message } from "@theia/core/lib/browser/widgets/widget";
import { Disposable } from "@theia/core/lib/common/disposable";
import URI from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileService } from "@theia/filesystem/lib/browser/file-service";

export const PdfViewerOptions = Symbol("PdfViewerOptions");
export interface PdfViewerOptions {
  uri: string;
}

type EmbedPdfElement = ReturnType<typeof EmbedPDF.init>;

/**
 * Shows a PDF with EmbedPDF: PDFium compiled to WebAssembly, in a Web Worker,
 * with EmbedPDF's own toolbar (pages, zoom, search, thumbnails, print).
 *
 * The bytes come from Theia's FileService — i.e. the FilesApi — and reach the
 * viewer as a blob: URL. PDFium's wasm is embedded in the bundle (Theia's
 * esbuild loads `.wasm` as a data: URL), and EmbedPDF's CDN fonts, Google
 * Fonts and stamp library are switched off, so the viewer makes no request outside the app.
 */
@injectable()
export class PdfViewerWidget extends BaseWidget {
  static readonly FACTORY_ID = "pdf-viewer";

  @inject(PdfViewerOptions) protected readonly options!: PdfViewerOptions;
  @inject(FileService) protected readonly files!: FileService;
  @inject(ThemeService) protected readonly themes!: ThemeService;

  protected viewer: EmbedPdfElement;

  get uri(): URI {
    return new URI(this.options.uri);
  }

  async initialize(): Promise<void> {
    const uri = this.uri;
    this.id = `${PdfViewerWidget.FACTORY_ID}:${this.options.uri}`;
    this.title.label = uri.path.base;
    this.title.caption = uri.path.toString();
    this.title.iconClass = "codicon codicon-file-pdf";
    this.title.closable = true;
    this.addClass("pdf-viewer-widget");
    this.node.tabIndex = 0;

    const content = await this.files.readFile(uri);
    const blob = new Blob([content.value.buffer as BlobPart], { type: "application/pdf" });
    const src = URL.createObjectURL(blob);
    this.toDispose.push(Disposable.create(() => URL.revokeObjectURL(src)));

    const target = document.createElement("div");
    target.className = "pdf-viewer";
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
    this.toDispose.push(
      this.themes.onDidColorThemeChange(() => this.viewer?.setTheme(this.themePreference())),
    );
    this.toDispose.push(Disposable.create(() => target.remove()));
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
