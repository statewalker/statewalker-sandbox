import type { Command, CommandListener, Commands } from "@statewalker/shared-commands";

/**
 * What a fallback listener actually receives. `claimed` is set by the bus
 * on the dispatched command but declared only on its internal type, so it
 * is spelled out here rather than silently relied upon.
 */
type Claimable<P, R> = Command<P, R> & { readonly claimed: boolean };
import {
  FILE_COMMANDS,
  filesCopy,
  filesDelete,
  filesMkdir,
  filesMove,
  filesRename,
  filesResolveActions,
} from "./declarations.js";
import type { JobQueue } from "./job-queue.js";

export interface FileCommandsOptions {
  queue: JobQueue;
  resolve(storage: string): { mkdir(path: string): Promise<unknown>; move(a: string, b: string): Promise<unknown> };
}

/**
 * C5 — the core registers EVERY file operation at negative priority.
 *
 * That is the package's documented fallback convention, and it is what makes
 * the app overridable without a plugin system: a host listening at priority 0
 * simply wins — route delete to a trash mount, add an approval step, block
 * writes on a read-only storage. Nothing here knows that hosts exist.
 */
export function registerFileCommands(commands: Commands, options: FileCommandsOptions): () => void {
  const { queue, resolve } = options;
  const disposers: (() => void)[] = [];
  const at = { priority: -1 };

  /**
   * Negative priority orders the listeners; it does NOT stop them.
   *
   * Dispatch runs every listener in one pass and only breaks on `cmd.settled`,
   * which cannot happen synchronously because a claim resolves through async
   * output validation. So a host claiming at priority 0 does not prevent this
   * listener from running — and a fallback that acts anyway would perform the
   * operation twice, or race the host's answer and sometimes win.
   *
   * A fallback must therefore decline explicitly when the command is already
   * claimed. Returning nothing is observe-only, which is exactly right: it
   * leaves the host's claim untouched.
   */
  const fallback =
    <P, R>(handler: (cmd: Claimable<P, R>) => Promise<R>): CommandListener<P, R> =>
    (cmd) => {
      const c = cmd as Claimable<P, R>;
      return c.claimed ? undefined : handler(c);
    };

  const transfer = (operation: "copy" | "move") =>
    fallback<{ files: { storage: string; path: string; kind: "file" | "directory" }[]; target: { storage: string; path: string } }, { jobId: string }>((cmd) => {
    const job = queue.enqueue({
      operation,
      sourceUri: cmd.payload.files[0].storage,
      targetUri: cmd.payload.target.storage,
      roots: cmd.payload.files.map((f) => f.path),
      targetPath: cmd.payload.target.path,
    });
    return Promise.resolve({ jobId: job.id });
  });

  disposers.push(
    commands.listen(filesCopy, transfer("copy"), at),
    commands.listen(filesMove, transfer("move"), at),
    commands.listen(
      filesDelete,
      fallback((cmd) => {
        const job = queue.enqueue({
          operation: "delete",
          sourceUri: cmd.payload.files[0].storage,
          targetUri: cmd.payload.files[0].storage,
          roots: cmd.payload.files.map((f) => f.path),
          targetPath: "/",
        });
        return Promise.resolve({ jobId: job.id });
      }),
      at,
    ),
    commands.listen(
      filesMkdir,
      fallback(async (cmd) => {
        const path = `${cmd.payload.target.path}/${cmd.payload.name}`;
        await resolve(cmd.payload.target.storage).mkdir(path);
        return { path };
      }),
      at,
    ),
    commands.listen(
      filesRename,
      fallback(async (cmd) => {
        const file = cmd.payload.files[0];
        const path = `${file.path.slice(0, file.path.lastIndexOf("/"))}/${cmd.payload.name}`;
        await resolve(file.storage).move(file.path, path);
        return { path };
      }),
      at,
    ),
    // Unclaimed applicability means "everything applies": the app owns no MIME
    // table and invents no extension rules.
    // A listener claims by returning `true` or a THENABLE. Returning a plain
    // object is observe-only, so the fallback must return a promise.
    commands.listen(
      filesResolveActions,
      fallback(async () => ({ keys: FILE_COMMANDS.map((c) => c.key) })),
      at,
    ),
  );

  return () => {
    for (const off of disposers) off();
  };
}
