/**
 * HTML → PDF with plain CDP: a new page target, the HTML loaded into it, `Page.printToPDF`.
 *
 * Only widely implemented methods are used, and each step has a fallback, because engines such
 * as Kitesurf implement a subset of CDP:
 *   - the HTML goes in with `Page.setDocumentContent`; if the engine lacks it, the page navigates
 *     to a `data:` URL of the HTML instead;
 *   - before printing, the page's fonts and images are awaited (`Runtime.evaluate`), best effort;
 *   - the PDF comes back base64 (`ReturnAsBase64`), or as an IO stream read in parts when asked.
 */
import { type CdpConnection, CdpError } from "./cdp.ts";

/** Page.printToPDF's parameters (sizes in inches, as CDP takes them). */
export type PrintOptions = {
  landscape?: boolean;
  displayHeaderFooter?: boolean;
  printBackground?: boolean;
  scale?: number;
  paperWidth?: number;
  paperHeight?: number;
  marginTop?: number;
  marginBottom?: number;
  marginLeft?: number;
  marginRight?: number;
  pageRanges?: string;
  headerTemplate?: string;
  footerTemplate?: string;
  /** Use the page's CSS `@page` size instead of paperWidth/paperHeight. */
  preferCSSPageSize?: boolean;
  /** Tagged (accessible) PDF; Chromium's default is true. */
  generateTaggedPDF?: boolean;
  generateDocumentOutline?: boolean;
};

export type PrintRequest = {
  html: string;
  pdf?: PrintOptions;
  /** How the HTML is loaded: `auto` tries setDocumentContent, then a data: URL. */
  load?: "auto" | "setDocumentContent" | "dataUrl";
  /** Read the PDF as an IO stream (large documents) instead of one base64 string. */
  stream?: boolean;
  /** Time allowed for the page to load and for each command (ms). */
  timeoutMs?: number;
};

export type PrintResult = {
  pdf: Uint8Array;
  /** How the HTML was loaded. */
  loadedWith: "setDocumentContent" | "dataUrl";
  /** Whether fonts and images were awaited (false: the engine refused, printed as is). */
  awaitedResources: boolean;
  timings: { loadMs: number; printMs: number; totalMs: number };
};

const A4 = { paperWidth: 8.27, paperHeight: 11.69 };

const fromBase64 = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

/** Prints `html` to PDF in a new page target of the connected browser, then closes the target. */
export async function printHtmlToPdf(cdp: CdpConnection, req: PrintRequest): Promise<PrintResult> {
  const timeoutMs = req.timeoutMs ?? 30_000;
  const started = performance.now();
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
  });
  try {
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const send = <T = Record<string, unknown>>(method: string, params?: Record<string, unknown>) =>
      cdp.send<T>(method, params, sessionId, timeoutMs);
    await send("Page.enable");

    const loadedWith = await loadHtml(cdp, send, sessionId, req, timeoutMs);
    const awaitedResources = await awaitResources(send);
    const loaded = performance.now();

    const params = {
      ...A4,
      printBackground: true,
      ...req.pdf,
      transferMode: req.stream ? "ReturnAsStream" : "ReturnAsBase64",
    };
    const printed = await send<{ data?: string; stream?: string }>("Page.printToPDF", params);
    const pdf =
      req.stream && printed.stream
        ? await readStream(send, printed.stream)
        : fromBase64(printed.data ?? "");
    if (pdf.byteLength < 5 || Buffer.from(pdf.subarray(0, 5)).toString() !== "%PDF-")
      throw new Error("EIO: Page.printToPDF did not return a PDF");
    const done = performance.now();
    return {
      pdf,
      loadedWith,
      awaitedResources,
      timings: {
        loadMs: Math.round(loaded - started),
        printMs: Math.round(done - loaded),
        totalMs: Math.round(done - started),
      },
    };
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: Record<string, unknown>,
) => Promise<T>;

async function loadHtml(
  cdp: CdpConnection,
  send: Send,
  sessionId: string,
  req: PrintRequest,
  timeoutMs: number,
): Promise<PrintResult["loadedWith"]> {
  const mode = req.load ?? "auto";
  if (mode !== "dataUrl") {
    try {
      const { frameTree } = await send<{ frameTree: { frame: { id: string } } }>(
        "Page.getFrameTree",
      );
      const loaded = cdp.waitFor("Page.loadEventFired", sessionId, timeoutMs).catch(() => null);
      await send("Page.setDocumentContent", { frameId: frameTree.frame.id, html: req.html });
      // setDocumentContent replaces the document synchronously; the load event (subresources)
      // follows when there are any. Not every engine sends it: resources are awaited below.
      await Promise.race([loaded, new Promise((r) => setTimeout(r, 2000))]);
      return "setDocumentContent";
    } catch (e) {
      if (mode === "setDocumentContent" || !(e instanceof CdpError && e.notImplemented)) throw e;
    }
  }
  const loaded = cdp.waitFor("Page.loadEventFired", sessionId, timeoutMs);
  const url = `data:text/html;charset=utf-8;base64,${Buffer.from(req.html, "utf8").toString("base64")}`;
  const nav = await send<{ errorText?: string }>("Page.navigate", { url });
  if (nav.errorText) throw new Error(`EIO: Page.navigate: ${nav.errorText}`);
  await loaded;
  return "dataUrl";
}

/** Waits for web fonts and images, so the PDF does not print fallback glyphs or empty boxes. */
async function awaitResources(send: Send): Promise<boolean> {
  const script = `Promise.all([
    document.fonts ? document.fonts.ready : null,
    ...Array.from(document.images, (img) => img.complete ? null : img.decode().catch(() => null)),
  ]).then(() => true)`;
  try {
    const r = await send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression: script, awaitPromise: true, returnByValue: true },
    );
    return !r.exceptionDetails && r.result?.value === true;
  } catch (e) {
    if (e instanceof CdpError) return false;
    throw e;
  }
}

/** Reads a CDP IO stream to its end, then closes it. */
async function readStream(send: Send, handle: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const r = await send<{ data: string; eof: boolean; base64Encoded?: boolean }>("IO.read", {
        handle,
        size: 1 << 20,
      });
      parts.push(r.base64Encoded ? fromBase64(r.data) : new TextEncoder().encode(r.data));
      if (r.eof) break;
    }
  } finally {
    await send("IO.close", { handle }).catch(() => {});
  }
  return new Uint8Array(Buffer.concat(parts));
}
