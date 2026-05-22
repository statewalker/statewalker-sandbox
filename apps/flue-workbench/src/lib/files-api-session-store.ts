import type { SessionData, SessionStore } from "@flue/runtime";
import type { FilesApi } from "@statewalker/webrun-files";
import { readText, writeText } from "@statewalker/webrun-files";

export interface FilesApiSessionStoreOptions {
  /** Must be the system view (`buildFilesViews(...).systemFiles`). */
  files: FilesApi;
  /** Root directory inside `files`. Default `/.settings/sessions`. */
  root?: string;
}

/**
 * Flue `SessionStore` over a `FilesApi`. Persists each session as
 * `<root>/<hex-encoded-id>.json` so id slashes never create nested
 * directories.
 */
export class FilesApiSessionStore implements SessionStore {
  private readonly files: FilesApi;
  private readonly root: string;

  constructor(opts: FilesApiSessionStoreOptions) {
    this.files = opts.files;
    this.root = opts.root?.replace(/\/+$/, "") ?? "/.settings/sessions";
  }

  private pathOf(id: string): string {
    const safe = Array.from(new TextEncoder().encode(id))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `${this.root}/${safe}.json`;
  }

  async load(id: string): Promise<SessionData | null> {
    const p = this.pathOf(id);
    if (!(await this.files.exists(p))) return null;
    const text = await readText(this.files, p);
    try {
      return JSON.parse(text) as SessionData;
    } catch {
      // Corrupted session file (partial write, hand-edit, merge conflict).
      // Returning null forces a fresh session — better than crashing boot
      // with an opaque SyntaxError. The corrupt file is left in place so
      // the user can inspect/recover it; the next save overwrites it.
      return null;
    }
  }

  async save(id: string, data: SessionData): Promise<void> {
    await writeText(this.files, this.pathOf(id), JSON.stringify(data));
  }

  async delete(id: string): Promise<void> {
    await this.files.remove(this.pathOf(id));
  }
}
