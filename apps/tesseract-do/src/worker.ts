/**
 * HTTP surface of the OCR prototype.
 *
 *   POST /api/ocr?lang=eng[&cell=name][&band=rows][&engine=cell|isolate]
 *        body: a PNG or JPEG image → OCR result (JSON)
 *   POST /api/pdf?lang=auto|eng[&engine=cell|isolate][&maxPages=n][&stream=1][&assets=inline]
 *        body: a PDF → PortableText document (JSON), or page events (NDJSON) with stream=1
 *   POST /api/pdf/jobs?lang=…[&engine=…][&maxPages=n][&throttleMs=ms][&name=…]
 *        body: a PDF → 202 { id, … }: a PdfJob Durable Object converts it, one page per alarm
 *   GET  /api/pdf/jobs/:id               the job's status and progress
 *   GET  /api/pdf/jobs/:id/document[?assets=inline]   the pages done so far as one document
 *   GET  /api/pdf/jobs/:id/pages/:n      one converted page (blocks, asset ids)
 *   GET  /api/pdf/jobs/:id/assets/:asset an image asset (PNG)
 *   POST /api/pdf/jobs/:id/cancel        stops the job (keeps what is done)
 *   DELETE /api/pdf/jobs/:id             stops the job and removes everything it stored
 *   GET  /api/cells/:name                the cell's engines and stored models
 *   GET  /api/runtime                    what this runtime allows (wasm compilation, loader, …)
 *
 * Without `cell`, the image goes to the cell of its language (`ocr-<lang>`). `band` sets the
 * rows read at a time (0: the whole image at once; default: about 3 megapixels per band).
 * `engine=isolate` runs recognition in a Worker Loader isolate instead of the cell's own (needs
 * WASM_URL).
 */
import type { RawImage } from "./decode.ts";
import { type CellOcrResult, type Env, OcrCell } from "./ocr-cell.ts";
import { convertPdfInWorker, type PageResult } from "./pdf/convert.ts";
import { PdfJob } from "./pdf/pdf-job.ts";

export { OcrCell, PdfJob };

/** Request bodies above this are refused (Workers accept 100 MB; images this large do not fit in memory). */
const MAX_BODY = 20 * 1024 * 1024;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const errorStatus = (message: string) =>
  /^(Error: )?(EINVAL|E2BIG)/.test(message)
    ? 400
    : /^(Error: )?EEXIST/.test(message)
      ? 409
      : /^(Error: )?EIO/.test(message)
        ? 502
        : 500;

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

      if (url.pathname === "/api/pdf" && request.method === "POST") {
        return await convertPdfRequest(request, url, env);
      }

      if (url.pathname.startsWith("/api/pdf/jobs")) {
        return await jobRequest(request, url, env);
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      return json({ error: message }, errorStatus(message));
    }
  },
};

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * PDF → PortableText. Pages are converted in this request (pdf.js in-thread, no canvas); each
 * image is OCR'd by the cell of the document's language. With `stream=1` every page is sent as
 * soon as it is done (NDJSON: `page` events, then `end` with the document's metadata).
 */
async function convertPdfRequest(request: Request, url: URL, env: Env): Promise<Response> {
  const bytes = await readPdf(request);
  if (bytes instanceof Response) return bytes;
  const lang = url.searchParams.get("lang") ?? "auto";
  const engine = url.searchParams.get("engine") === "isolate" ? "isolate" : "cell";
  const inline = url.searchParams.get("assets") === "inline";
  const maxPages = Number(url.searchParams.get("maxPages")) || undefined;
  const name = url.searchParams.get("name") ?? "document.pdf";
  const ocr = (image: RawImage, language: string) =>
    env.OCR.get(env.OCR.idFromName(`ocr-${language}`)).ocr(image, language, { engine });
  const pageEvent = (p: PageResult) => ({
    type: "page",
    page: p.page,
    blocks: p.blocks,
    assets: p.assets.map((a) => ({ meta: a.meta, ...(inline ? { png: base64(a.png) } : {}) })),
  });

  if (url.searchParams.get("stream") === "1") {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const send = (event: unknown) => writer.write(encoder.encode(`${JSON.stringify(event)}\n`));
    const done = (async () => {
      try {
        const doc = await convertPdfInWorker(bytes, name, {
          lang,
          maxPages,
          ocr,
          onPage: (p) => send(pageEvent(p)),
        });
        const { blocks: _blocks, assets: _assets, ...meta } = doc;
        await send({ type: "end", document: meta });
      } catch (e) {
        await send({ type: "error", error: String((e as Error)?.message ?? e) });
      } finally {
        await writer.close();
      }
    })();
    void done;
    return new Response(readable, { headers: { "content-type": "application/x-ndjson" } });
  }

  const pngs: Record<string, string> = {};
  const document = await convertPdfInWorker(bytes, name, {
    lang,
    maxPages,
    ocr,
    onPage: (p) => {
      if (inline) for (const a of p.assets) pngs[a.meta._id] = base64(a.png);
    },
  });
  return json(inline ? { document, assets: pngs } : { document });
}

/** Reads a PDF request body: at most MAX_BODY bytes, starting with `%PDF-`. */
async function readPdf(request: Request): Promise<Uint8Array | Response> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY) return json({ error: "E2BIG: PDF too large" }, 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BODY)
    return json({ error: "EINVAL: send a PDF (at most 20 MB)" }, 400);
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-")
    return json({ error: "EINVAL: not a PDF" }, 400);
  return bytes;
}

/**
 * PDF conversion jobs. Each job is a PdfJob Durable Object of its own (a unique id), which keeps
 * the PDF and the results in its SQLite and converts one page per alarm: the request that
 * creates it returns at once, and the job is not bound by any request's CPU time.
 */
async function jobRequest(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === "/api/pdf/jobs" && request.method === "POST") {
    const bytes = await readPdf(request);
    if (bytes instanceof Response) return bytes;
    const id = env.PDF_JOB.newUniqueId();
    const job = env.PDF_JOB.get(id);
    const view = await job.start(bytes, url.searchParams.get("name") ?? "document.pdf", {
      lang: url.searchParams.get("lang") ?? "auto",
      engine: url.searchParams.get("engine") === "isolate" ? "isolate" : "cell",
      maxPages: Number(url.searchParams.get("maxPages")) || undefined,
      throttleMs: Math.max(0, Number(url.searchParams.get("throttleMs")) || 0),
    });
    return json({ id: id.toString(), ...view }, 202);
  }

  const m = url.pathname.match(/^\/api\/pdf\/jobs\/([0-9a-f]{64})(?:\/(.*))?$/);
  if (!m) return json({ error: "not found" }, 404);
  const [, id, rest = ""] = m;
  const notFound = () => json({ error: "ENOENT: no such job" }, 404);
  let jobId: DurableObjectId;
  try {
    // An id this namespace did not make is refused here (ids carry a checksum).
    jobId = env.PDF_JOB.idFromString(id);
  } catch {
    return notFound();
  }
  const job = env.PDF_JOB.get(jobId);

  if (rest === "" && request.method === "GET") {
    const view = await job.status();
    return view ? json({ id, ...view }) : notFound();
  }
  if (rest === "" && request.method === "DELETE") {
    const view = await job.status();
    if (!view) return notFound();
    await job.destroy();
    return json({ id, deleted: true });
  }
  if (rest === "cancel" && request.method === "POST") {
    const view = await job.cancel();
    return view ? json({ id, ...view }) : notFound();
  }
  if (rest === "document" && request.method === "GET") {
    const result = await job.document();
    if (!result) return notFound();
    if (url.searchParams.get("assets") !== "inline") return json(result);
    const pngs: Record<string, string> = {};
    for (const assetId of Object.keys(result.document.assets)) {
      const png = await job.asset(assetId);
      if (png) pngs[assetId] = base64(png);
    }
    return json({ ...result, assets: pngs });
  }
  const page = rest.match(/^pages\/(\d+)$/);
  if (page && request.method === "GET") {
    const stored = await job.page(Number(page[1]));
    return stored ? json(stored) : json({ error: "ENOENT: page not converted (yet)" }, 404);
  }
  const asset = rest.match(/^assets\/(image-[0-9a-f]{40}-\d+x\d+-png)$/);
  if (asset && request.method === "GET") {
    const png = await job.asset(asset[1]);
    return png
      ? new Response(png, { headers: { "content-type": "image/png" } })
      : json({ error: "ENOENT: no such asset" }, 404);
  }
  return json({ error: "not found" }, 404);
}
