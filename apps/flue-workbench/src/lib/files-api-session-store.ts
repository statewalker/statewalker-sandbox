import {
  assertSupportedFlueFormatVersion,
  FLUE_FORMAT_VERSION,
  PersistedFormatVersionError,
  type PersistenceAdapter,
  type PersistenceStores,
  parseSessionStorageKey,
} from "@flue/runtime/adapter";
import type { FilesApi } from "@statewalker/webrun-files";
import { FilesApiAttachmentStore } from "./files-api-attachment-store.js";
import {
  FilesApiConversationStreamStore,
  type StreamHeader,
} from "./files-api-conversation-stream-store.js";
import { listNames, readJson, writeJson } from "./files-api-json.js";
import {
  FilesApiSubmissionStore,
  loadSubmissionFiles,
  submissionFileName,
} from "./files-api-submission-store.js";

export interface FilesApiSessionStoreOptions {
  /** Must be the system view (`buildFilesViews(...).systemFiles`). */
  files: FilesApi;
  /** Root directory inside `files`. Default `/.settings/sessions`. */
  root?: string;
}

/** Stamp keys in `<root>/meta.json`, named like Flue's SQL `flue_meta` rows. */
const FORMAT_VERSION_KEY = "format_version";
/** Pre-1.0 stamp; version 8 is adopted in place, like the SQL adapters do. */
const LEGACY_SCHEMA_KEY = "schema_version";
const ADOPTABLE_LEGACY_SCHEMA = "8";

/** Connected stores, with the concrete types so callers can reach `flush()`. */
export interface FilesApiPersistenceStores extends PersistenceStores {
  readonly submissionStore: FilesApiSubmissionStore;
  readonly conversationStreamStore: FilesApiConversationStreamStore;
  readonly attachmentStore: FilesApiAttachmentStore;
}

/**
 * Flue 2 `PersistenceAdapter` over a `FilesApi` — where the workbench keeps
 * its agent conversations so they survive a tab reload.
 *
 * Flue 0.7 persisted one `SessionData` blob per session through a
 * `SessionStore { load, save, delete }`. Flue 2 replaced that with a
 * durable-execution store triple; this class keeps the old name and the
 * old location (`/.settings/sessions`, hidden from the model by the system
 * view) and implements the new contract:
 *
 *     <root>/meta.json         format-version stamp
 *     <root>/submissions/      AgentSubmissionStore rows (durable queue)
 *     <root>/streams/          ConversationStreamStore (the transcripts)
 *     <root>/attachments/      AttachmentStore (prompt images)
 *
 * Pass it to `start({ db })`. The three stores pass Flue's contract suites
 * from `@flue/runtime/test-utils` (see tests/lib/files-api-session-store.test.ts).
 */
export class FilesApiSessionStore implements PersistenceAdapter {
  readonly files: FilesApi;
  readonly root: string;

  constructor(opts: FilesApiSessionStoreOptions) {
    this.files = opts.files;
    this.root = opts.root?.replace(/\/+$/, "") ?? "/.settings/sessions";
  }

  private get metaPath(): string {
    return `${this.root}/meta.json`;
  }
  private get submissionsDir(): string {
    return `${this.root}/submissions`;
  }
  private get streamsDir(): string {
    return `${this.root}/streams`;
  }
  private get attachmentsDir(): string {
    return `${this.root}/attachments`;
  }

  /**
   * Stamp a fresh store with the current format version, or verify the
   * existing stamp. Flue's persisted format is reset-only: an unknown or
   * newer stamp — or Flue data with no stamp at all — fails loudly before
   * anything is read or written.
   */
  async migrate(): Promise<void> {
    const meta = await this.readMeta();
    const stored = meta[FORMAT_VERSION_KEY];
    if (stored !== undefined) {
      assertSupportedFlueFormatVersion(stored);
      return;
    }
    const legacy = meta[LEGACY_SCHEMA_KEY];
    if (legacy !== undefined) {
      if (legacy !== ADOPTABLE_LEGACY_SCHEMA) {
        throw new PersistedFormatVersionError({
          storedVersion: legacy,
          supportedVersion: FLUE_FORMAT_VERSION,
        });
      }
      delete meta[LEGACY_SCHEMA_KEY];
    } else if (
      (await this.files.exists(this.submissionsDir)) ||
      (await this.files.exists(this.streamsDir))
    ) {
      throw new PersistedFormatVersionError({
        storedVersion: "unversioned",
        supportedVersion: FLUE_FORMAT_VERSION,
      });
    }
    meta[FORMAT_VERSION_KEY] = String(FLUE_FORMAT_VERSION);
    await writeJson(this.files, this.metaPath, meta);
  }

  async connect(): Promise<FilesApiPersistenceStores> {
    const submissionStore = await FilesApiSubmissionStore.open(this.files, this.submissionsDir);
    return {
      submissionStore,
      conversationStreamStore: new FilesApiConversationStreamStore({
        files: this.files,
        dir: this.streamsDir,
        submissionStore,
      }),
      attachmentStore: new FilesApiAttachmentStore({ files: this.files, dir: this.attachmentsDir }),
    };
  }

  /**
   * Nothing to release: every store awaits its own writes before resolving,
   * so once Flue's shutdown drain finishes the files are current.
   */
  async close(): Promise<void> {}

  /**
   * Wipe everything persisted for one agent instance id: its conversation
   * streams (under every agent name), their attachments, and its submission
   * ledger rows. Backs the human-only `session reset` command.
   *
   * Flue 2's store contract deliberately has no per-session deletion
   * ("sessions are append-only for the life of the agent instance"), so this
   * works on the files directly and MUST only run while no runtime is
   * connected to this store — `createWorkbench` stops the runtime first and
   * restarts it afterwards, so the next `connect()` reloads from disk.
   */
  async delete(instanceId: string): Promise<void> {
    for (const name of await listNames(this.files, this.streamsDir, "directory")) {
      const header = await readJson<StreamHeader>(
        this.files,
        `${this.streamsDir}/${name}/stream.json`,
      );
      if (header.kind !== "ok" || header.value.identity?.instanceId !== instanceId) continue;
      await this.files.remove(`${this.streamsDir}/${name}`);
      // Attachments are keyed by the same hex-encoded stream path.
      await this.files.remove(`${this.attachmentsDir}/${name}`);
    }
    for (const { row } of await loadSubmissionFiles(this.files, this.submissionsDir)) {
      if (parseSessionStorageKey(row.sessionKey)?.instanceId !== instanceId) continue;
      await this.files.remove(`${this.submissionsDir}/${submissionFileName(row.sequence)}`);
    }
  }

  /** Whether anything is persisted for `instanceId` (any agent name). */
  async has(instanceId: string): Promise<boolean> {
    for (const name of await listNames(this.files, this.streamsDir, "directory")) {
      const header = await readJson<StreamHeader>(
        this.files,
        `${this.streamsDir}/${name}/stream.json`,
      );
      if (header.kind === "ok" && header.value.identity?.instanceId === instanceId) return true;
    }
    return false;
  }

  // Raw stamp access, for the format-version contract tests.

  async readStamp(key: string): Promise<string | undefined> {
    return (await this.readMeta())[key];
  }

  async writeStamp(key: string, value: string): Promise<void> {
    await writeJson(this.files, this.metaPath, { ...(await this.readMeta()), [key]: value });
  }

  async deleteStamp(key: string): Promise<void> {
    const meta = await this.readMeta();
    delete meta[key];
    await writeJson(this.files, this.metaPath, meta);
  }

  private async readMeta(): Promise<Record<string, string>> {
    const result = await readJson<Record<string, string>>(this.files, this.metaPath);
    if (result.kind === "corrupt") {
      throw new PersistedFormatVersionError({
        storedVersion: "unreadable",
        supportedVersion: FLUE_FORMAT_VERSION,
      });
    }
    return result.kind === "ok" ? { ...result.value } : {};
  }
}
