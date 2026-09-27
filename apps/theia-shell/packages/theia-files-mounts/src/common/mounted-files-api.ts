import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";

/** A stable FilesApi whose target can be swapped (the mount pipeline is rebuilt behind it). */
export class MountedFilesApi implements FilesApi {
  constructor(protected target: FilesApi) {}

  setTarget(target: FilesApi): void {
    this.target = target;
  }

  read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array> {
    return this.target.read(path, options);
  }
  write(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void> {
    return this.target.write(path, content);
  }
  mkdir(path: string): Promise<void> {
    return this.target.mkdir(path);
  }
  list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    return this.target.list(path, options);
  }
  stats(path: string): Promise<FileStats | undefined> {
    return this.target.stats(path);
  }
  exists(path: string): Promise<boolean> {
    return this.target.exists(path);
  }
  remove(path: string): Promise<boolean> {
    return this.target.remove(path);
  }
  move(source: string, target: string): Promise<boolean> {
    return this.target.move(source, target);
  }
  copy(source: string, target: string): Promise<boolean> {
    return this.target.copy(source, target);
  }
}
