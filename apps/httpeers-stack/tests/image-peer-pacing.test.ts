/**
 * `src/pages/image-peer/pacing.ts` -- the `?chunk=`/`?delay=` knob the
 * provider page reads, and the `FilesApi` wrapper one of them installs.
 *
 * Pure logic, so it is proven here rather than only through the browser
 * suite that motivated it. What it exists FOR is Task 15's streaming
 * assertion (`tests/e2e/browser.test.ts`): the shipped fixture set is ~370
 * bytes against a 64 KiB default chunk size, so without a knob every image
 * is served in exactly one chunk and "streams in more than one chunk" is
 * unobservable -- and with instantaneous chunks, streaming and buffering are
 * indistinguishable at the consumer.
 *
 * THE DEFAULT IS "CHANGES NOTHING", and that is the property most worth
 * pinning: a page opened without either parameter must behave exactly as it
 * did before this module existed.
 */
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { pacedFiles, readStreamPacing } from "../src/pages/image-peer/pacing.js";

async function drain(files: ReturnType<typeof pacedFiles>, path: string): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  for await (const part of files.read(path)) parts.push(part);
  return parts;
}

describe("readStreamPacing", () => {
  it("an ordinary page URL asks for nothing and changes nothing", () => {
    expect(readStreamPacing("")).toEqual({ chunkSize: undefined, delayMs: 0 });
    expect(readStreamPacing("?invite=E2E-INVITE-1")).toEqual({
      chunkSize: undefined,
      delayMs: 0,
    });
  });

  it("reads both parameters", () => {
    expect(readStreamPacing("?invite=X&chunk=64&delay=40")).toEqual({
      chunkSize: 64,
      delayMs: 40,
    });
  });

  it("reads either one alone", () => {
    expect(readStreamPacing("?chunk=1024")).toEqual({ chunkSize: 1024, delayMs: 0 });
    expect(readStreamPacing("?delay=5")).toEqual({ chunkSize: undefined, delayMs: 5 });
  });

  it("ignores a value that is not a positive number, rather than throwing", () => {
    // This runs before `startBrowserPeer`; a throw here would stop a page
    // joining the mesh over a typo in an instrumentation parameter.
    expect(readStreamPacing("?chunk=abc&delay=-5")).toEqual({
      chunkSize: undefined,
      delayMs: 0,
    });
    expect(readStreamPacing("?chunk=0&delay=")).toEqual({ chunkSize: undefined, delayMs: 0 });
  });
});

describe("pacedFiles", () => {
  const files = new MemFilesApi({ initialFiles: { "/a": new Uint8Array([1, 2, 3, 4]) } });

  it("yields exactly the bytes the wrapped store yields", async () => {
    const paced = pacedFiles(files, 1);
    expect(await drain(paced, "/a")).toEqual(await drain(files, "/a"));
  });

  it("stalls before each chunk", async () => {
    const delayMs = 30;
    const paced = pacedFiles(files, delayMs);
    const startedAt = performance.now();
    const parts = await drain(paced, "/a");
    // One chunk here (an unwindowed read of a 4-byte file), so one stall --
    // the point is that the stall happens at all, and per chunk rather than
    // once per call. The browser suite is where several chunks are observed.
    expect(parts).toHaveLength(1);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(delayMs * 0.9);
  });

  it("forwards every other FilesApi method to the wrapped store", async () => {
    const paced = pacedFiles(files, 1);
    expect(await paced.exists("/a")).toBe(true);
    expect(await paced.exists("/nope")).toBe(false);
    // `stats()` returns a union discriminated on `kind` (webrun-files 0.9); only a file has a size.
    expect(await paced.stats("/a")).toMatchObject({ kind: "file", size: 4 });
  });
});
