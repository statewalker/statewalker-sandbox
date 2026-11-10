/**
 * Node only. NodeFilesApi whose `write` streams each chunk to the file. The published
 * webrun-files-node (0.10.3) collects every chunk and joins them before `fs.writeFile`, so a
 * 500 MB object costs 500 MB+ of memory; this is the fix to upstream.
 */
import { mkdir, open } from "node:fs/promises";
import { dirname, posix, resolve, sep } from "node:path";
import { NodeFilesApi } from "@statewalker/webrun-files-node";

export class StreamingNodeFilesApi extends NodeFilesApi {
  readonly #root: string;
  constructor(rootDir: string) {
    super({ rootDir });
    this.#root = resolve(rootDir);
  }
  #real(path: string): string {
    const real = resolve(this.#root, `.${posix.normalize(`/${path}`)}`);
    if (real !== this.#root && !real.startsWith(this.#root + sep))
      throw new Error(`path escapes root: ${path}`);
    return real;
  }
  override async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const real = this.#real(path);
    await mkdir(dirname(real), { recursive: true });
    const fh = await open(real, "w");
    try {
      for await (const chunk of content) {
        let off = 0;
        while (off < chunk.length) {
          const { bytesWritten } = await fh.write(chunk, off, chunk.length - off);
          off += bytesWritten;
        }
      }
    } finally {
      await fh.close();
    }
  }
}
