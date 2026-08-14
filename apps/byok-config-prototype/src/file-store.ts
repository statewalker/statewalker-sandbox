/**
 * Picking, reading and writing the config file on the user's disk.
 *
 * Primary path is the File System Access API (Chromium), which is the only way
 * a browser can write back to the *same* file the user picked. Where it is
 * missing (Firefox, Safari) the app degrades to `<input type="file">` for
 * reading and a download for writing — same flow, one extra click at the end.
 */

export interface ConfigFile {
  name: string;
  /** False when writing means "download a copy" rather than overwrite in place. */
  canWriteInPlace: boolean;
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

export const DEFAULT_FILE_NAME = "llm-connections.json";

const PICKER_OPTIONS = {
  types: [{ description: "JSON config", accept: { "application/json": [".json"] } }],
  excludeAcceptAllOption: false,
};

// Minimal structural typing for the File System Access API — TS's DOM lib does
// not ship it, and pulling a types package into a throwaway app is not worth it.
interface FileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
type PickerWindow = typeof window & {
  showOpenFilePicker?: (options: unknown) => Promise<FileHandle[]>;
  showSaveFilePicker?: (options: unknown) => Promise<FileHandle>;
};

export function supportsFileSystemAccess(): boolean {
  return typeof (window as PickerWindow).showOpenFilePicker === "function";
}

/** Open an existing config file. Resolves to `null` when the user cancels. */
export async function openConfigFile(): Promise<ConfigFile | null> {
  const picker = (window as PickerWindow).showOpenFilePicker;
  if (picker) {
    const handles = await cancelable(picker({ ...PICKER_OPTIONS, multiple: false }));
    return handles?.[0] ? fromHandle(handles[0]) : null;
  }
  const file = await pickViaInput();
  return file ? fromBlob(file) : null;
}

/** Create a new config file. Resolves to `null` when the user cancels. */
export async function createConfigFile(): Promise<ConfigFile | null> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (picker) {
    const handle = await cancelable(
      picker({ ...PICKER_OPTIONS, suggestedName: DEFAULT_FILE_NAME }),
    );
    return handle ? fromHandle(handle) : null;
  }
  return downloadOnly(DEFAULT_FILE_NAME);
}

/** "Save a copy" — always produces a *new* file (or a download). */
export async function saveAsConfigFile(suggestedName: string): Promise<ConfigFile | null> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (picker) {
    const handle = await cancelable(picker({ ...PICKER_OPTIONS, suggestedName }));
    return handle ? fromHandle(handle) : null;
  }
  return downloadOnly(suggestedName);
}

// ── implementations ──────────────────────────────────────────────────────

function fromHandle(handle: FileHandle): ConfigFile {
  return {
    name: handle.name,
    canWriteInPlace: true,
    async read() {
      return (await handle.getFile()).text();
    },
    async write(text) {
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
    },
  };
}

/** Read-only handle from an `<input type="file">` pick; writes download a copy. */
function fromBlob(file: File): ConfigFile {
  return {
    name: file.name,
    canWriteInPlace: false,
    read: () => file.text(),
    write: async (text) => download(file.name, text),
  };
}

function downloadOnly(name: string): ConfigFile {
  return {
    name,
    canWriteInPlace: false,
    read: async () => "",
    write: async (text) => download(name, text),
  };
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  // Firefox (the main reason this fallback exists) only honours a click on an
  // anchor that is in the document, and needs the blob URL to outlive the click.
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function pickViaInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

/** The pickers reject with `AbortError` when the user dismisses the dialog. */
async function cancelable<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch (err) {
    if ((err as DOMException)?.name === "AbortError") return undefined;
    throw err;
  }
}
