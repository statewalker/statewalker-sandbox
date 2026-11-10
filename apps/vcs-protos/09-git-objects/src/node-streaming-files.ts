/**
 * Node only. NodeFilesApi whose `write` streams chunks to the file instead of collecting them
 * (the published webrun-files-node joins every chunk into one buffer first). Stub in the red phase.
 */
import { NodeFilesApi } from "@statewalker/webrun-files-node";

export class StreamingNodeFilesApi extends NodeFilesApi {
  constructor(rootDir: string) {
    super({ rootDir });
  }
}
