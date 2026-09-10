import type { FileRef } from "@fm/core";
import type { Commands } from "@statewalker/shared-commands";
import type { FilesApi } from "@statewalker/webrun-files";
import type { Invalidation } from "./change-notifier.js";
import { CORE_PRIORITY, overridden } from "./commands.js";
import { filesDelete, filesMkdir, filesRename } from "./declarations.js";

/**
 * C5 — the core's own handlers for the operations that are not jobs.
 *
 * Copy and move are long-running and go through `JobsController`. Delete, mkdir
 * and rename settle immediately, so they answer directly. All three register at
 * NEGATIVE priority, which is the only thing that makes a host override work:
 * listening at 0 beats them without touching app code.
 *
 * Every one of them publishes an invalidation through the same producer-agnostic
 * entry point a copy uses, so the panels showing the directory update themselves.
 */
export class FilesController {
  private readonly _disposers: (() => void)[] = [];

  constructor(
    private readonly _commands: Commands,
    private readonly _resolve: (storage: string) => FilesApi,
    private readonly _onChange: (change: Invalidation) => void,
  ) {}

  activate(): void {
    this._disposers.push(
      this._commands.listen(
        filesDelete,
        (cmd) => this._run(cmd, () => this._delete(cmd.payload.files)),
        { priority: CORE_PRIORITY },
      ),
      this._commands.listen(
        filesMkdir,
        (cmd) => this._run(cmd, () => this._mkdir(cmd.payload.storage, cmd.payload.path)),
        { priority: CORE_PRIORITY },
      ),
      this._commands.listen(
        filesRename,
        (cmd) => this._run(cmd, () => this._rename(cmd.payload.files, cmd.payload.name)),
        { priority: CORE_PRIORITY },
      ),
    );
  }

  /**
   * Stands down if a host already claimed, then does the work. Without the yield
   * inside `overridden`, rerouting `files:delete` to a trash mount would delete
   * the file as well as trashing it.
   */
  private async _run<R>(cmd: { settled: boolean }, work: () => Promise<R>): Promise<R> {
    if (await overridden(cmd)) return undefined as never;
    return work();
  }

  /** `remove` is always recursive in `FilesApi`; there is no "only if empty". */
  private async _delete(files: FileRef[]): Promise<{ removed: number }> {
    let removed = 0;
    for (const ref of files) {
      const api = this._resolve(ref.storage);
      // A delete that removed nothing is reported, not swallowed: the user
      // selected something, and silence would look like success.
      if (!(await api.remove(ref.path))) {
        throw new Error(`nothing to delete at ${ref.path}`);
      }
      removed++;
      this._onChange({ storage: ref.storage, path: ref.path, kind: "removed" });
    }
    return { removed };
  }

  private async _mkdir(storage: string, path: string): Promise<{ path: string }> {
    await this._resolve(storage).mkdir(path);
    this._onChange({ storage, path, kind: "created" });
    return { path };
  }

  /**
   * Renaming is a move within one directory. It takes the uniform
   * `{ files: FileRef[] }` payload so the panel does not branch, but more than
   * one file has no meaning — one new name cannot serve two files — so it is
   * refused rather than half-applied to the first.
   */
  private async _rename(files: FileRef[], name: string): Promise<{ path: string }> {
    if (files.length !== 1) {
      throw new Error(`rename takes exactly one file, got ${files.length}`);
    }
    const [ref] = files;
    if (name.includes("/")) throw new Error(`a name may not contain "/": ${name}`);
    const api = this._resolve(ref.storage);
    const parent = ref.path.slice(0, ref.path.lastIndexOf("/"));
    const to = `${parent}/${name}`;
    if (!(await api.move(ref.path, to))) throw new Error(`nothing to rename at ${ref.path}`);
    // Both ends, because a rename is a removal and a creation to every observer.
    this._onChange({ storage: ref.storage, path: ref.path, kind: "removed" });
    this._onChange({ storage: ref.storage, path: to, kind: "created" });
    return { path: to };
  }

  dispose(): void {
    for (const off of this._disposers) off();
    this._disposers.length = 0;
  }
}
