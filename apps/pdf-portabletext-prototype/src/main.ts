import {
  type ConvertResult,
  convertPdfStream,
  createBundle,
  createOcrPool,
  DEFAULT_LANGUAGE,
  download,
  type ImageFormat,
  LANGUAGES,
  type OcrEngine,
  type OcrPool,
  type PdfPortableTextDocument,
} from "@statewalker/pdf-portabletext";
import { renderPreview } from "@statewalker/pdf-portabletext/preview";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fileInput = $<HTMLInputElement>("file");
const fileLabel = $("file-label");
const drop = $("drop");
const form = $<HTMLFormElement>("controls");
const convertBtn = $<HTMLButtonElement>("convert");
const cancelBtn = $<HTMLButtonElement>("cancel");
const jsonBtn = $<HTMLButtonElement>("dl-json");
const zipBtn = $<HTMLButtonElement>("dl-zip");
const logEl = $("log");
const previewEl = $("preview");
const jsonEl = $("json").querySelector("pre") as HTMLPreElement;

const option = (value: string, label: string, selected = false) =>
  Object.assign(document.createElement("option"), { value, textContent: label, selected });
$("language").append(
  option("auto", "Auto-detect", true),
  ...LANGUAGES.map((l) => option(l.tesseract, `${l.name} (${l.tesseract})`)),
);
$("fallback").append(...LANGUAGES.map((l) => option(l.tesseract, l.name, l === DEFAULT_LANGUAGE)));
$<HTMLSelectElement>("language").addEventListener("change", (e) => {
  $<HTMLSelectElement>("fallback").disabled = (e.target as HTMLSelectElement).value !== "auto";
});

let file: File | null = null;
let result: ConvertResult | null = null;
let objectUrls: string[] = [];
let ocr: OcrPool | null = null;
let abort: AbortController | null = null;

function log(message: string) {
  logEl.textContent += `${new Date().toLocaleTimeString()}  ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setFile(f: File | undefined) {
  if (!f) return;
  file = f;
  fileLabel.textContent = `${f.name} (${(f.size / 1024).toFixed(0)} KB)`;
  convertBtn.disabled = false;
}

fileInput.addEventListener("change", () => setFile(fileInput.files?.[0]));
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  setFile(e.dataTransfer?.files[0]);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!file) return;
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  result = null;
  previewEl.innerHTML = "";
  jsonEl.textContent = "";
  logEl.textContent = "";
  convertBtn.disabled = true;
  cancelBtn.disabled = false;
  jsonBtn.disabled = zipBtn.disabled = true;
  abort = new AbortController();
  const engine = $<HTMLSelectElement>("engine").value as OcrEngine;
  if (ocr && ocr.engine !== engine) {
    ocr.terminate();
    ocr = null;
  }
  ocr ??= createOcrPool({
    engine,
    modelBaseUrl: new URLSearchParams(location.search).get("models") ?? undefined,
  });
  const started = performance.now();
  try {
    const options = {
      language: $<HTMLSelectElement>("language").value,
      fallbackLanguage: $<HTMLSelectElement>("fallback").value,
      maxPages: Number($<HTMLInputElement>("max-pages").value) || undefined,
      detectOrientation: $<HTMLInputElement>("orientation").checked,
      invisibleText: $<HTMLSelectElement>("invisible").value as "replace" | "reuse" | "keep",
      imageFormat: $<HTMLSelectElement>("format").value as ImageFormat,
      ocrImages: $<HTMLInputElement>("ocr-images").checked,
      ocrEmptyPages: $<HTMLInputElement>("ocr-pages").checked,
      minImageSize: Number($<HTMLInputElement>("min-size").value) || 1,
      minConfidence: Number($<HTMLInputElement>("min-conf").value) || 0,
      onLog: log,
      onProgress: (p: number) => {
        convertBtn.textContent = p >= 100 ? "Convert" : `OCR ${p}%`;
      },
      signal: abort.signal,
    };
    // Pages are shown as they are converted; the document is assembled alongside.
    const doc: PdfPortableTextDocument = {
      _type: "pdfDocument",
      version: 1,
      title: file.name.replace(/\.pdf$/i, ""),
      source: { fileName: file.name, size: file.size, pageCount: 0 },
      createdAt: new Date().toISOString(),
      pages: [],
      blocks: [],
      assets: {},
    };
    const blobs = new Map<string, Blob>();
    const urls = new Map<string, string>();
    let pageCount = 0;
    for await (const event of convertPdfStream(file, ocr, options)) {
      if (event.type === "start") {
        pageCount = event.pageCount;
        doc.source = event.source;
      } else if (event.type === "page") {
        doc.pages.push(event.page);
        doc.blocks.push(...event.blocks);
        for (const a of event.assets) {
          doc.assets[a.meta._id] = a.meta;
          blobs.set(a.meta._id, a.blob);
          const url = URL.createObjectURL(a.blob);
          objectUrls.push(url);
          urls.set(a.meta._id, url);
        }
        previewEl.insertAdjacentHTML("beforeend", renderPreview({ blocks: event.blocks }, urls));
        const n = event.page.number;
        if (n === pageCount || n % 10 === 0) log(`page ${n}/${pageCount} done${heap()}`);
      } else if (event.language) {
        doc.language = event.language;
      }
    }
    result = { document: doc, blobs };
    log(
      `done in ${((performance.now() - started) / 1000).toFixed(1)}s: ` +
        `${doc.blocks.length} blocks, ${Object.keys(doc.assets).length} assets${heap()}`,
    );
    show(result);
  } catch (err) {
    if (abort.signal.aborted) {
      log("cancelled");
      // The worker may be busy with a long recognition: drop it.
      ocr?.terminate();
      ocr = null;
    } else {
      log(`error: ${err instanceof Error ? err.message : String(err)}`);
      console.error(err);
    }
  } finally {
    convertBtn.disabled = false;
    convertBtn.textContent = "Convert";
    cancelBtn.disabled = true;
    abort = null;
  }
});

cancelBtn.addEventListener("click", () => abort?.abort());

/** JS heap in use (Chromium only), for watching memory on long documents. */
function heap(): string {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? `, JS heap ${(memory.usedJSHeapSize / 2 ** 20).toFixed(0)} MB` : "";
}

function show({ document: doc }: ConvertResult) {
  // Exposed for scripts/corpus.ts and debugging from the console.
  (window as unknown as { __lastResult?: ConvertResult }).__lastResult = result ?? undefined;
  jsonEl.textContent = JSON.stringify(doc, null, 2);
  jsonBtn.disabled = zipBtn.disabled = false;
}

const baseName = () => (result?.document.title || "document").replace(/[^\w.-]+/g, "_");

jsonBtn.addEventListener("click", () => {
  if (!result) return;
  const json = JSON.stringify(result.document, null, 2);
  download(new Blob([json], { type: "application/json" }), `${baseName()}.portabletext.json`);
});

zipBtn.addEventListener("click", async () => {
  if (!result) return;
  download(await createBundle(result.document, result.blobs), `${baseName()}.portabletext.zip`);
});

// Hovering an OCR word highlights its bbox in the source image, and vice versa.
function highlight(markKey: string | null) {
  for (const el of previewEl.querySelectorAll(".active")) el.classList.remove("active");
  if (!markKey) return;
  for (const el of previewEl.querySelectorAll(`[data-mark="${CSS.escape(markKey)}"]`)) {
    el.classList.add("active");
  }
}
previewEl.addEventListener("mouseover", (e) => {
  const target = (e.target as Element).closest("[data-mark]");
  highlight(target?.getAttribute("data-mark") ?? null);
});
previewEl.addEventListener("mouseleave", () => highlight(null));

for (const tab of document.querySelectorAll<HTMLButtonElement>("[role=tab]")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll<HTMLButtonElement>("[role=tab]")) {
      const selected = t === tab;
      t.setAttribute("aria-selected", String(selected));
      $(t.dataset.tab as string).hidden = !selected;
    }
  });
}
