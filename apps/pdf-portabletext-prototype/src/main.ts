import type { ImageFormat } from "./assets.ts";
import { createBundle, download } from "./bundle.ts";
import { type ConvertResult, convertPdf } from "./convert.ts";
import { createOcrClient, type OcrClient } from "./ocr-client.ts";
import { renderPreview } from "./preview.ts";

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

let file: File | null = null;
let result: ConvertResult | null = null;
let objectUrls: string[] = [];
let ocr: OcrClient | null = null;
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
  ocr ??= createOcrClient(new URLSearchParams(location.search).get("models") ?? undefined);
  const started = performance.now();
  try {
    result = await convertPdf(file, ocr, {
      language: $<HTMLSelectElement>("language").value,
      imageFormat: $<HTMLSelectElement>("format").value as ImageFormat,
      ocrImages: $<HTMLInputElement>("ocr-images").checked,
      ocrEmptyPages: $<HTMLInputElement>("ocr-pages").checked,
      minImageSize: Number($<HTMLInputElement>("min-size").value) || 1,
      minConfidence: Number($<HTMLInputElement>("min-conf").value) || 0,
      onLog: log,
      onProgress: (p) => {
        convertBtn.textContent = p >= 100 ? "Convert" : `OCR ${p}%`;
      },
      signal: abort.signal,
    });
    log(
      `done in ${((performance.now() - started) / 1000).toFixed(1)}s: ` +
        `${result.document.blocks.length} blocks, ${Object.keys(result.document.assets).length} assets`,
    );
    show(result);
  } catch (err) {
    if (abort.signal.aborted) {
      log("cancelled");
      // The worker may be busy with a long recognition: drop it.
      ocr.terminate();
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

function show({ document: doc, blobs }: ConvertResult) {
  const urls = new Map<string, string>();
  for (const [id, blob] of blobs) {
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    urls.set(id, url);
  }
  previewEl.innerHTML = renderPreview(doc, urls);
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
