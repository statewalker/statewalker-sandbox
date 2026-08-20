/**
 * How fast this page hands its bytes to the mesh -- two query parameters and
 * the `FilesApi` wrapper one of them needs.
 *
 * WHY A PAGE HAS THIS AT ALL, AND WHY IT IS NOT A TEST FILE. The one
 * property the image peer exists to demonstrate is that a response STREAMS
 * from one browser to another -- design note 20's "4 chunks sent, 4 chunks
 * received", and the sentence `./main.ts`'s own module comment already
 * writes: "the mesh-served path ... arriving in multiple chunks ... proven
 * end to end through a real browser by Task 15's Playwright suite". Task 15
 * then found that the page AS SHIPPED cannot demonstrate it:
 *
 *  - Every fixture is ~370 bytes and `createImagesEndpoint`'s default chunk
 *    size is 64 KiB, so each image is served in EXACTLY ONE chunk. "More
 *    than one chunk" is unobservable no matter how the consumer reads.
 *  - Even with several chunks, a provider that produces them instantly is
 *    indistinguishable from one that buffers the whole body and re-enqueues
 *    it in the same sizes -- the consumer sees the same count, the same
 *    sizes, and the same arrival burst. Leg 1 hit this and answered it the
 *    same way (`tests/e2e/node-consumer.test.ts`'s `instrumentedFiles`),
 *    but it could do so from the test process because IT built the
 *    provider. Nothing outside a page can reach into one.
 *
 * So the pacing is a knob on the page, read from the URL exactly as the
 * invitation already is. Absent, this module changes nothing: no delay, and
 * the endpoint's own default chunk size (`readStreamPacing("")` is
 * `{ delayMs: 0 }`). It is instrumentation for an observer, not a mode --
 * there is no "buffer everything" setting here and there must never be one,
 * because a falsification mutant that ships is a mutant that can be
 * switched on in production.
 *
 * `files` IS THE RIGHT SEAM for the delay, and `../../services/images.ts`
 * says so itself ("THE SEAM"): stalling there leaves the handler under test
 * completely unmodified -- same `ReadableStream`, same windowed reads, same
 * backpressure -- and changes only when the bytes show up.
 */
import type { FilesApi, ListOptions, ReadOptions } from "@statewalker/webrun-files";

export interface StreamPacing {
  /** Bytes per `files.read` call, or `undefined` for `createImagesEndpoint`'s own `DEFAULT_CHUNK_SIZE`. */
  chunkSize?: number;
  /** Milliseconds stalled before each chunk is yielded. `0` -- the default -- installs no wrapper at all. */
  delayMs: number;
}

/**
 * Reads `?chunk=<bytes>&delay=<ms>` out of a query string.
 *
 * A MALFORMED VALUE IS IGNORED, NOT AN ERROR. These parameters exist for an
 * observer driving the page from outside; a typo in one must not stop the
 * page from joining the mesh, which is what a throw here would do (this
 * runs before `startBrowserPeer`). Anything not a finite positive number is
 * treated as "not given", which is also what a missing parameter means.
 */
export function readStreamPacing(search: string): StreamPacing {
  const params = new URLSearchParams(search);
  const positive = (raw: string | null): number | undefined => {
    if (raw == null) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  return { chunkSize: positive(params.get("chunk")), delayMs: positive(params.get("delay")) ?? 0 };
}

/**
 * `inner`, with every chunk it yields stalled by `delayMs` first.
 *
 * Only `read` is wrapped; every other `FilesApi` method is forwarded
 * unchanged, because only `read` is on the path this page serves from.
 */
export function pacedFiles(inner: FilesApi, delayMs: number): FilesApi {
  return {
    async *read(path: string, options?: ReadOptions) {
      for await (const part of inner.read(path, options)) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        yield part;
      }
    },
    write: (path, content) => inner.write(path, content),
    mkdir: (path: string) => inner.mkdir(path),
    list: (path: string, options?: ListOptions) => inner.list(path, options),
    stats: (path: string) => inner.stats(path),
    exists: (path: string) => inner.exists(path),
    remove: (path: string) => inner.remove(path),
    move: (source: string, target: string) => inner.move(source, target),
    copy: (source: string, target: string) => inner.copy(source, target),
  };
}
