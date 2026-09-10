import type { FilesApi } from "@statewalker/webrun-files";
import type { StorageConfig } from "@fm/core";

export const CONFIG_VERSION = 1;

export interface StoragesFile {
  version: number;
  storages: StorageConfig[];
}

export interface SessionPanel {
  id: string;
  storage: string;
  path: string;
  name: string;
  slot?: string;
  sortColumn?: "name" | "size" | "date";
}

export interface SessionFile {
  version: number;
  panels: SessionPanel[];
  activeId?: string;
}

const encode = (value: unknown) => [new TextEncoder().encode(JSON.stringify(value, null, 2))];

async function readJson<T>(api: FilesApi, path: string): Promise<T | undefined> {
  if (!(await api.exists(path))) return undefined;
  let text = "";
  for await (const chunk of api.read(path)) text += new TextDecoder().decode(chunk);
  return text ? (JSON.parse(text) as T) : undefined;
}

/**
 * D3 — two files with deliberately different write policies.
 *
 * `storages.json` is HAND-EDITABLE and written only on an explicit user
 * action, so a scroll, a navigation or a resize can never clobber a file the
 * user maintains by hand. `session.json` is app-authored and written debounced,
 * because it changes constantly and nobody edits it.
 *
 * Confusing the two is the failure this separation exists to prevent.
 */
export class ConfigStore {
  private _timer?: ReturnType<typeof setTimeout>;
  private _pending?: SessionFile;
  /** Counted for tests and for anyone auditing write amplification. */
  storagesWrites = 0;
  sessionWrites = 0;

  constructor(
    private readonly _api: FilesApi,
    private readonly _root = "/config",
    private readonly _debounceMs = 250,
  ) {}

  private _storagesPath() { return `${this._root}/storages.json`; }
  private _sessionPath() { return `${this._root}/session.json`; }

  async loadStorages(): Promise<StoragesFile> {
    const file = await readJson<StoragesFile>(this._api, this._storagesPath());
    if (!file) return { version: CONFIG_VERSION, storages: [] };
    if (file.version > CONFIG_VERSION) {
      // Refuse, do not "best effort". Writing a v1 file over a v2 one destroys
      // configuration the user may have written by hand in a newer build.
      throw new Error(
        `storages.json is version ${file.version}; this build understands ${CONFIG_VERSION}`,
      );
    }
    return file;
  }

  /** Only ever called from an explicit user action. */
  async saveStorages(storages: StorageConfig[]): Promise<void> {
    this.storagesWrites++;
    await this._api.write(this._storagesPath(), encode({ version: CONFIG_VERSION, storages }));
  }

  async loadSession(): Promise<SessionFile | undefined> {
    const file = await readJson<SessionFile>(this._api, this._sessionPath());
    if (!file) return undefined;
    // A session is disposable: an unreadable one is discarded, never fatal.
    return file.version === CONFIG_VERSION ? file : undefined;
  }

  /** Debounced: a hundred cursor moves cost one write. */
  scheduleSession(session: SessionFile): void {
    this._pending = session;
    if (this._timer) return;
    this._timer = setTimeout(() => void this.flushSession(), this._debounceMs);
  }

  async flushSession(): Promise<void> {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    const session = this._pending;
    if (!session) return;
    this._pending = undefined;
    this.sessionWrites++;
    await this._api.write(this._sessionPath(), encode(session));
  }

  dispose(): void {
    if (this._timer) clearTimeout(this._timer);
    this._timer = undefined;
  }
}

/**
 * A session panel whose storage is gone becomes a NAMED error panel rather
 * than failing activation. The user opened `Photos` yesterday; today the drive
 * is unplugged, and they should see `Photos — unavailable`, not an empty app.
 */
export function degradedPanel(panel: SessionPanel, known: Set<string>): SessionPanel & { error?: string } {
  if (known.has(panel.storage)) return panel;
  return { ...panel, error: `storage ${panel.storage} is not configured` };
}
