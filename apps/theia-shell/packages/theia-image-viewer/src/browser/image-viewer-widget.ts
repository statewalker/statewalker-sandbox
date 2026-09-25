import { BaseWidget, type Message } from "@theia/core/lib/browser/widgets/widget";
import { Disposable } from "@theia/core/lib/common/disposable";
import { Emitter } from "@theia/core/lib/common/event";
import URI from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import { fitScale, formatZoom, imageMimeType, stepZoom } from "../common/image-view";

export const ImageViewerOptions = Symbol("ImageViewerOptions");
export interface ImageViewerOptions {
  uri: string;
}

/** "fit" follows the widget's size; a number is a fixed scale. */
export type ImageZoom = "fit" | number;

/**
 * Shows an image file read through Theia's FileService (so: the FilesApi) as a
 * blob: URL in an <img>. SVG is shown the same way, so scripts in it never run.
 * Reloads when the file changes.
 */
@injectable()
export class ImageViewerWidget extends BaseWidget {
  static readonly FACTORY_ID = "image-viewer";

  @inject(ImageViewerOptions) protected readonly options!: ImageViewerOptions;
  @inject(FileService) protected readonly files!: FileService;

  protected readonly canvas = document.createElement("div");
  protected readonly image = document.createElement("img");
  protected readonly status = document.createElement("div");
  protected objectUrl: string | undefined;
  protected byteSize = 0;
  protected zoomMode: ImageZoom = "fit";

  protected readonly onDidChangeZoomEmitter = new Emitter<void>();
  readonly onDidChangeZoom = this.onDidChangeZoomEmitter.event;

  get uri(): URI {
    return new URI(this.options.uri);
  }

  /** The scale the image is shown at right now. */
  get scale(): number {
    return this.zoomMode === "fit" ? this.fitScale() : this.zoomMode;
  }

  get zoom(): ImageZoom {
    return this.zoomMode;
  }

  async initialize(): Promise<void> {
    const uri = this.uri;
    this.id = `${ImageViewerWidget.FACTORY_ID}:${this.options.uri}`;
    this.title.label = uri.path.base;
    this.title.caption = uri.path.toString();
    this.title.iconClass = "codicon codicon-file-media";
    this.title.closable = true;
    this.addClass("image-viewer-widget");
    this.node.tabIndex = 0;

    this.canvas.className = "image-viewer-canvas";
    this.image.className = "image-viewer-image";
    this.image.alt = uri.path.base;
    this.image.draggable = false;
    this.status.className = "image-viewer-status";
    this.canvas.appendChild(this.image);
    this.node.append(this.canvas, this.status);

    this.image.addEventListener("load", () => this.applyZoom());
    // A click toggles between fitting the view and actual size.
    this.image.addEventListener("click", () => this.setZoom(this.zoomMode === "fit" ? 1 : "fit"));

    this.toDispose.push(this.onDidChangeZoomEmitter);
    this.toDispose.push(Disposable.create(() => this.revoke()));
    this.toDispose.push(
      this.files.onDidFilesChange((event) => {
        if (event.contains(uri)) this.load();
      }),
    );
    await this.load();
  }

  async load(): Promise<void> {
    const content = await this.files.readFile(this.uri);
    const bytes = content.value.buffer;
    this.byteSize = bytes.byteLength;
    const type = imageMimeType(this.uri.path.toString()) ?? "application/octet-stream";
    this.revoke();
    this.objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    this.image.src = this.objectUrl;
    await this.image.decode().catch(() => undefined);
    this.applyZoom();
  }

  setZoom(zoom: ImageZoom): void {
    this.zoomMode = zoom;
    this.applyZoom();
    this.onDidChangeZoomEmitter.fire();
  }

  zoomIn(): void {
    this.setZoom(stepZoom(this.scale, 1));
  }

  zoomOut(): void {
    this.setZoom(stepZoom(this.scale, -1));
  }

  protected fitScale(): number {
    const padding = 32;
    return fitScale(
      { width: this.image.naturalWidth, height: this.image.naturalHeight },
      {
        width: this.canvas.clientWidth - padding,
        height: this.canvas.clientHeight - padding,
      },
    );
  }

  protected applyZoom(): void {
    const { naturalWidth: width, naturalHeight: height } = this.image;
    if (!width || !height) {
      this.status.textContent = "";
      return;
    }
    const scale = this.scale;
    this.image.style.width = `${Math.round(width * scale)}px`;
    this.image.style.height = `${Math.round(height * scale)}px`;
    this.image.classList.toggle("fit", this.zoomMode === "fit");
    this.image.title = this.zoomMode === "fit" ? "Click for actual size" : "Click to fit";
    const zoom = `${formatZoom(scale)}${this.zoomMode === "fit" ? " (fit)" : ""}`;
    this.status.textContent = `${width} × ${height} · ${zoom} · ${formatBytes(this.byteSize)}`;
  }

  protected revoke(): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
  }

  protected override onResize(msg: Parameters<BaseWidget["onResize"]>[0]): void {
    super.onResize(msg);
    if (this.zoomMode === "fit") this.applyZoom();
  }

  protected override onAfterShow(msg: Message): void {
    super.onAfterShow(msg);
    this.applyZoom();
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.node.focus();
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
