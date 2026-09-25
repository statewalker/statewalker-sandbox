import { WidgetOpenHandler } from "@theia/core/lib/browser/widget-open-handler";
import type URI from "@theia/core/lib/common/uri";
import { injectable } from "@theia/core/shared/inversify";
import { isPdfPath } from "../common/pdf-files";
import { PdfViewerWidget } from "./pdf-viewer-widget";

/** Opens .pdf files in the PDF viewer instead of the text editor (priority 500; the text editor has 100). */
@injectable()
export class PdfViewerOpenHandler extends WidgetOpenHandler<PdfViewerWidget> {
  readonly id = PdfViewerWidget.FACTORY_ID;
  readonly label = "PDF Viewer";

  canHandle(uri: URI): number {
    return isPdfPath(uri.path.toString()) ? 500 : 0;
  }

  protected createWidgetOptions(uri: URI): object {
    return { uri: uri.withoutFragment().toString() };
  }
}
