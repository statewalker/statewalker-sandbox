import type { FilesApi } from "@statewalker/webrun-files";
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { mountApp } from "./app.js";
import { makeStore } from "./store.js";
// The Tailwind entry (/~/styles.js <style> injector). Its `@import "./tokens.css"`
// is INLINED by the Tailwind transform (D1 source-honoring), and the inlined
// `url("./logo.svg")` (F3) resolves against the document base — see <base href="/~/">.
import "./styles.css";
// A PLAIN CSS @import chain (theme.css → @import "./palette.css"). A plain @import
// is KEPT in the injector, so this is the case that exercises F2 at RUNTIME: the
// injected `@import "./palette.css"` resolves against the document base to the real
// /~/palette.css the build emits.
import "./theme.css";

const KEY = "notes-demo/snapshot";

/**
 * Pick the store's FilesApi from the URL:
 *   default → a MemFilesApi hydrated from (and snapshotted back to) localStorage —
 *             a real, swappable persistent store using only the mem impl.
 *   ?mem    → a fresh in-memory MemFilesApi (no persistence) so the app is
 *             auto-testable from a clean slate.
 * Any other FilesApi (BrowserFilesApi/OPFS, NodeFilesApi) drops in unchanged.
 */
async function pickFiles(): Promise<{ files: FilesApi; onChange?: () => void }> {
  if (new URLSearchParams(location.search).has("mem")) return { files: new MemFilesApi() };
  const files = new MemFilesApi();
  await hydrate(files);
  return { files, onChange: () => void snapshot(files) };
}

/** Load every persisted note file back into `files`. */
async function hydrate(files: FilesApi): Promise<void> {
  const raw = localStorage.getItem(KEY);
  if (!raw) return;
  for (const [path, text] of Object.entries(JSON.parse(raw) as Record<string, string>)) {
    await writeText(files, path, text);
  }
}

/** Snapshot every note file out of `files` into localStorage. */
async function snapshot(files: FilesApi): Promise<void> {
  const out: Record<string, string> = {};
  for await (const entry of files.list("/notes")) {
    if (entry.kind === "file") out[entry.path] = await readText(files, entry.path);
  }
  localStorage.setItem(KEY, JSON.stringify(out));
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
const { files, onChange } = await pickFiles();
mountApp(root, makeStore(files), onChange);
