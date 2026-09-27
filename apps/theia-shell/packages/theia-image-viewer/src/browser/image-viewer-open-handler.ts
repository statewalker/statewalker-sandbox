import { WidgetOpenHandler } from "@theia/core/lib/browser/widget-open-handler";
import type URI from "@theia/core/lib/common/uri";
import { injectable } from "@theia/core/shared/inversify";
import { imageMimeType } from "../common/image-view";
import { type ImageViewerOptions, ImageViewerWidget } from "./image-viewer-widget";

/** Opens image files in the viewer instead of the text editor (priority 500; the text editor has 100). */
@injectable()
export class ImageViewerOpenHandler extends WidgetOpenHandler<ImageViewerWidget> {
  readonly id = ImageViewerWidget.FACTORY_ID;
  readonly label = "Image Viewer";

  canHandle(uri: URI): number {
    return imageMimeType(uri.path.toString()) ? 500 : 0;
  }

  protected createWidgetOptions(uri: URI): ImageViewerOptions {
    return { kind: "navigatable", uri: uri.withoutFragment().toString() };
  }
}
