import type { FilesApi } from "@statewalker/webrun-files";
import type { Disposable } from "@theia/core/lib/common/disposable";
import { Emitter, Event } from "@theia/core/lib/common/event";
import URI from "@theia/core/lib/common/uri";
import {
  createFileSystemProviderError,
  type FileChange,
  type FileChangeType,
  type FileDeleteOptions,
  type FileOverwriteOptions,
  type FileSystemProviderCapabilities,
  FileSystemProviderErrorCode,
  type FileSystemProviderWithFileFolderCopyCapability,
  type FileSystemProviderWithFileReadWriteCapability,
  FileType,
  type FileWriteOptions,
  type Stat,
} from "@theia/filesystem/lib/common/files";
import { Capabilities, ChangeType } from "./const-enums";
import type { FilesApiChange } from "./files-api-source";

/** A FilesApi, or something that resolves to one the first time it is needed. */
export type FilesApiSourceLike = FilesApi | (() => FilesApi | Promise<FilesApi>);

/**
 * Theia's `FileSystemProvider` contract implemented over a `FilesApi` and
 * nothing else. Every URI's path is used as the FilesApi path, so the scheme
 * and authority are ignored: register it for one scheme (`file` in the app).
 *
 * `FilesApi` has no watch API, so change events are reported for mutations
 * made *through this provider*; other writers to the same FilesApi are seen
 * the next time Theia reads.
 */
export class FilesApiFileSystemProvider
  implements
    FileSystemProviderWithFileReadWriteCapability,
    FileSystemProviderWithFileFolderCopyCapability
{
  readonly capabilities: FileSystemProviderCapabilities =
    Capabilities.FileReadWrite | Capabilities.FileFolderCopy | Capabilities.PathCaseSensitive;

  readonly onDidChangeCapabilities: Event<void> = Event.None;
  readonly onFileWatchError: Event<void> = Event.None;

  private readonly changes = new Emitter<readonly FileChange[]>();
  readonly onDidChangeFile: Event<readonly FileChange[]> = this.changes.event;

  private filesPromise?: Promise<FilesApi>;

  constructor(private readonly source: FilesApiSourceLike) {}

  /** The FilesApi this provider serves (resolved once, then cached). */
  files(): Promise<FilesApi> {
    if (!this.filesPromise) {
      const source = this.source;
      this.filesPromise =
        typeof source === "function" ? Promise.resolve(source()) : Promise.resolve(source);
    }
    return this.filesPromise;
  }

  watch(): Disposable {
    // Changes are pushed from the mutating methods below; nothing to set up.
    return { dispose: () => {} };
  }

  /** Reports changes made to the FilesApi outside this provider (see `FilesApiChanges`). */
  notifyChanges(changes: readonly FileChange[]): void {
    if (changes.length > 0) this.changes.fire(changes);
  }

  async stat(resource: URI): Promise<Stat> {
    const path = pathOf(resource);
    if (path === "/") return { type: FileType.Directory, mtime: 0, ctime: 0, size: 0 };
    const stats = await (await this.files()).stats(path);
    if (!stats) throw notFound(path);
    if (stats.kind === "directory") {
      return { type: FileType.Directory, mtime: 0, ctime: 0, size: 0 };
    }
    return {
      type: FileType.File,
      mtime: stats.lastModified,
      ctime: stats.lastModified,
      size: stats.size,
    };
  }

  async readdir(resource: URI): Promise<[string, FileType][]> {
    const path = pathOf(resource);
    await this.expectDirectory(path);
    const result: [string, FileType][] = [];
    for await (const entry of (await this.files()).list(path)) {
      result.push([entry.name, entry.kind === "directory" ? FileType.Directory : FileType.File]);
    }
    return result;
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    const path = pathOf(resource);
    const files = await this.files();
    const stats = await files.stats(path);
    if (!stats) throw notFound(path);
    if (stats.kind === "directory") throw isADirectory(path);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of files.read(path)) {
      chunks.push(chunk);
      size += chunk.length;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  async writeFile(resource: URI, content: Uint8Array, opts: FileWriteOptions): Promise<void> {
    const path = pathOf(resource);
    const files = await this.files();
    const stats = await files.stats(path);
    if (stats?.kind === "directory") throw isADirectory(path);
    if (!stats) {
      if (!opts.create) throw notFound(path);
      await this.expectDirectory(parentOf(path));
    } else if (!opts.overwrite) {
      throw exists(path);
    }
    await files.write(path, [content]);
    this.fire(stats ? ChangeType.UPDATED : ChangeType.ADDED, resource);
  }

  async mkdir(resource: URI): Promise<void> {
    const path = pathOf(resource);
    const files = await this.files();
    if (path === "/" || (await files.exists(path))) throw exists(path);
    await this.expectDirectory(parentOf(path));
    await files.mkdir(path);
    this.fire(ChangeType.ADDED, resource);
  }

  async delete(resource: URI, opts: FileDeleteOptions): Promise<void> {
    const path = pathOf(resource);
    const files = await this.files();
    const stats = await files.stats(path);
    if (!stats) throw notFound(path);
    if (stats.kind === "directory" && !opts.recursive) {
      for await (const _ of files.list(path)) {
        throw createFileSystemProviderError(
          `Folder is not empty: ${path}`,
          FileSystemProviderErrorCode.NoPermissions,
        );
      }
    }
    await files.remove(path);
    this.fire(ChangeType.DELETED, resource);
  }

  async rename(from: URI, to: URI, opts: FileOverwriteOptions): Promise<void> {
    await this.transfer(from, to, opts, "move");
    this.fire(ChangeType.DELETED, from);
    this.fire(ChangeType.ADDED, to);
  }

  async copy(from: URI, to: URI, opts: FileOverwriteOptions): Promise<void> {
    await this.transfer(from, to, opts, "copy");
    this.fire(ChangeType.ADDED, to);
  }

  private async transfer(
    from: URI,
    to: URI,
    opts: FileOverwriteOptions,
    op: "move" | "copy",
  ): Promise<void> {
    const source = pathOf(from);
    const target = pathOf(to);
    const files = await this.files();
    if (!(await files.exists(source))) throw notFound(source);
    if (await files.exists(target)) {
      if (!opts.overwrite) throw exists(target);
      await files.remove(target);
    }
    await this.expectDirectory(parentOf(target));
    await files[op](source, target);
  }

  private async expectDirectory(path: string): Promise<void> {
    if (path === "/") return;
    const stats = await (await this.files()).stats(path);
    if (!stats) throw notFound(path);
    if (stats.kind !== "directory") {
      throw createFileSystemProviderError(
        `Not a folder: ${path}`,
        FileSystemProviderErrorCode.FileNotADirectory,
      );
    }
  }

  private fire(type: FileChangeType, resource: URI): void {
    this.changes.fire([{ type, resource }]);
  }
}

const CHANGE_TYPES = {
  added: ChangeType.ADDED,
  updated: ChangeType.UPDATED,
  deleted: ChangeType.DELETED,
} as const;

/** FilesApi paths → Theia file changes under `root` (e.g. `file:///`). */
export function toFileChanges(root: string, changes: readonly FilesApiChange[]): FileChange[] {
  const base = new URI(root);
  return changes.map((change) => ({
    type: CHANGE_TYPES[change.type],
    resource: base.withPath(change.path),
  }));
}

function pathOf(resource: URI): string {
  const path = resource.path.toString();
  if (path === "" || path === "/") return "/";
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function notFound(path: string) {
  return createFileSystemProviderError(
    `Not found: ${path}`,
    FileSystemProviderErrorCode.FileNotFound,
  );
}

function exists(path: string) {
  return createFileSystemProviderError(
    `Already exists: ${path}`,
    FileSystemProviderErrorCode.FileExists,
  );
}

function isADirectory(path: string) {
  return createFileSystemProviderError(
    `Is a folder: ${path}`,
    FileSystemProviderErrorCode.FileIsADirectory,
  );
}
