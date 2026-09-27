// P7's app module: a FilesApi holding one generated PDF.
// __esModule: see P3 — without it Theia's loader gets the exports object.
Object.defineProperty(exports, "__esModule", { value: true });
const { ContainerModule } = require("@theia/core/shared/inversify");
const { MemFilesApi } = require("@statewalker/webrun-files-mem");
const { FilesApiSource } = require("@theia-shell/theia-files-api/lib/common/files-api-source");
const { createTextPdf } = require("@theia-shell/theia-pdf-viewer/lib/common/text-pdf");

const filesApi = new MemFilesApi({
  initialFiles: {
    "/hello.pdf": createTextPdf(["Hello from P7", "Rendered by PDFium in WebAssembly"]),
  },
});
window.filesApi = filesApi;

exports.default = new ContainerModule((_bind, _unbind, _isBound, rebind) => {
  rebind(FilesApiSource).toConstantValue(() => filesApi);
});
