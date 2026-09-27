// The app's own frontend module: it provides the FilesApi the shell shows.
// Plain CommonJS so the prototype needs no compile step of its own. The
// __esModule marker (which tsc emits) makes `import()` hand Theia's loader
// `exports.default` rather than the whole exports object.
Object.defineProperty(exports, "__esModule", { value: true });
const { ContainerModule } = require("@theia/core/shared/inversify");
const { MemFilesApi } = require("@statewalker/webrun-files-mem");
const { FilesApiSource } = require("@theia-shell/theia-files-api/lib/common/files-api-source");

const filesApi = new MemFilesApi({
  initialFiles: {
    "/README.md": "# P3\n\nServed from a FilesApi.\n",
    "/docs/guide.md": "## Guide\n",
  },
});
// Exposed for the e2e test, which checks what the editor wrote.
window.filesApi = filesApi;

exports.default = new ContainerModule((_bind, _unbind, _isBound, rebind) => {
  rebind(FilesApiSource).toConstantValue(() => filesApi);
});
