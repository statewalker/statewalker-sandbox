/**
 * HTTP surface of the OCR prototype.
 *
 *   POST /api/ocr?lang=eng[&cell=name][&band=rows][&engine=cell|isolate]
 *        body: a PNG or JPEG image → OCR result (JSON)
 *   GET  /api/cells/:name                the cell's engines and stored models
 *   GET  /api/runtime                    what this runtime allows (wasm compilation, loader, …)
 *
 * Without `cell`, the image goes to the cell of its language (`ocr-<lang>`). `band` sets the
 * rows read at a time (0: the whole image at once; default: about 3 megapixels per band).
 * `engine=isolate` runs recognition in a Worker Loader isolate instead of the cell's own (needs
 * WASM_URL).
 */
import { type CellOcrResult, type Env, OcrCell } from "./ocr-cell.ts";

export { OcrCell };

/** Request bodies above this are refused (Workers accept 100 MB; images this large do not fit in memory). */
const MAX_BODY = 20 * 1024 * 1024;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const errorStatus = (message: string) =>
  /^EINVAL|^E2BIG/.test(message) ? 400 : /^EIO/.test(message) ? 502 : 500;

/**
 * Whether this runtime compiles WebAssembly from bytes: workerd refuses, Node (cellb) allows,
 * and on celld 0.6 the promise never settles, hence the timeout.
 */
async function canCompileWasmBytes(): Promise<boolean | "hangs"> {
  // Not in the Workers types on purpose: workerd disallows it.
  const wasm = WebAssembly as unknown as { compile(bytes: Uint8Array): Promise<unknown> };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      wasm.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(() => true as const),
      new Promise<"hangs">((resolve) => {
        timer = setTimeout(() => resolve("hangs"), 1000);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/runtime") {
        return json({
          userAgent:
            (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? null,
          compileWasmFromBytes: await canCompileWasmBytes(),
          workerLoader: !!env.LOADER,
          isolateEngine: !!env.LOADER && !!env.WASM_URL,
          imageApis: Object.fromEntries(
            ["OffscreenCanvas", "ImageData", "createImageBitmap"].map((name) => [
              name,
              typeof (globalThis as Record<string, unknown>)[name],
            ]),
          ),
          sharedArrayBuffer: typeof SharedArrayBuffer,
        });
      }

      const cellMatch = url.pathname.match(/^\/api\/cells\/([\w.-]+)$/);
      if (cellMatch && request.method === "GET") {
        const stub = env.OCR.get(env.OCR.idFromName(cellMatch[1]));
        return json(await stub.stats());
      }

      if (url.pathname === "/api/ocr" && request.method === "POST") {
        const lang = url.searchParams.get("lang") ?? "eng";
        const cell = url.searchParams.get("cell") ?? `ocr-${lang}`;
        const length = Number(request.headers.get("content-length") ?? 0);
        if (length > MAX_BODY) return json({ error: "E2BIG: image too large" }, 413);
        const image = await request.arrayBuffer();
        if (image.byteLength === 0 || image.byteLength > MAX_BODY)
          return json({ error: "EINVAL: send a PNG or JPEG image (at most 20 MB)" }, 400);
        const stub = env.OCR.get(env.OCR.idFromName(cell));
        const band = url.searchParams.get("band");
        const engine = url.searchParams.get("engine") === "isolate" ? "isolate" : "cell";
        const options = {
          engine: engine as "cell" | "isolate",
          ...(band === null ? {} : { bandHeight: Math.max(0, Number(band) || 0) }),
        };
        const result: CellOcrResult = await stub.ocr(image, lang, options);
        return json({ ...result, cellName: cell });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      return json({ error: message }, errorStatus(message));
    }
  },
};
